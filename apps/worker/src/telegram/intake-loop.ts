/**
 * The intake loop. `[F1]`
 *
 * **Persists and nothing more.** Curation happens in a separate loop, because doing it
 * here would block intake for the duration of a model call and one slow Curator would
 * stall the live demo at exactly the wrong moment. This split is also what makes the
 * pipeline advisory lock sufficient: only one thing derives, so only that needs
 * serialising, while intake is free to keep up with the group.
 *
 * The order within a cycle is deliberate and the failure it prevents is asymmetric:
 *
 *   1. poll
 *   2. normalise and persist, oldest first
 *   3. pre-filter what was just stored
 *   4. **then** commit the offset
 *
 * Committing last means a crash replays the batch, which is harmless because intake
 * upserts. Committing first would lose those messages permanently, and a message
 * nobody knows was lost cannot be recovered.
 *
 * Membership and edit handling are dispatched to handlers supplied by the caller
 * rather than implemented here, so this file stays about polling.
 */

import type {
  BotMembershipEvent,
  IgnoreReason,
  MembershipEvent,
  NormalisedMessage,
  PrivateMessageEvent,
} from "@baton/core";
import { detectQuestionToBot, normaliseUpdate } from "@baton/core";
import type { QuestionDetection, TelegramMessage } from "@baton/core";
import type { Database } from "@baton/core/db";
import { persistMessage } from "../store/messages.js";
import { recordPrivateChat } from "../store/people.js";
import { getTelegramOffset, setTelegramOffset } from "../store/worker-state.js";
import { runPrefilterPass } from "../pipeline/prefilter.js";
import type { TelegramClient } from "./client.js";

/** Cap on messages pre-filtered per cycle, so a cycle never runs long. */
const PREFILTER_BATCH = 200;

export interface IntakeHandlers {
  /** A person joined or left. Drives `people.status` and the brief. */
  onMembershipEvent?: (event: MembershipEvent) => Promise<void>;
  /** The bot's own membership changed. Drives the one-time introduction. */
  onBotMembershipEvent?: (event: BotMembershipEvent) => Promise<void>;
  /**
   * A message was edited. Intake has already cleared its curation state, so this is
   * for the consequences — superseding the facts the old text produced.
   */
  onEditedMessage?: (messageId: string, message: NormalisedMessage) => Promise<void>;
  /**
   * Someone wrote to the bot directly. The loop has already recorded that Baton can
   * reach them; this is for anything else that follows, such as matching a private
   * reply to an approval it asked for.
   */
  onPrivateMessage?: (personId: string, event: PrivateMessageEvent) => Promise<void>;
  /**
   * A message addressed to Baton — an @-mention, or a reply to one of its messages.
   *
   * The message is already stored and flagged, so the respond pass will find it whether or
   * not this fires. The handler exists for the one case persistence cannot settle: a reply
   * to a bot message that was an *approval request* is an answer, not a new question, and
   * only the store knows which bot message ids were questions.
   */
  onQuestionToBot?: (messageId: string, detection: QuestionDetection) => Promise<void>;
}

export interface IntakeCycleResult {
  updatesReceived: number;
  messagesStored: number;
  editsStored: number;
  membershipEvents: number;
  /** Direct messages to the bot. Noted, never ingested as group knowledge. */
  privateMessages: number;
  /** Messages addressed to Baton: an @-mention or a reply to it, and nothing else. */
  questionsToBot: number;
  /** Counted by reason, because "dropped 400 updates" is only actionable with a why. */
  ignored: Record<IgnoreReason, number>;
  offsetCommitted: number | null;
}

function emptyIgnoredCounts(): Record<IgnoreReason, number> {
  return {
    foreign_chat: 0,
    own_message: 0,
    no_sender: 0,
    empty_message: 0,
    unsupported_update: 0,
  };
}

export interface IntakeLoopOptions {
  db: Database;
  telegram: TelegramClient;
  chatId: number;
  handlers?: IntakeHandlers;
}

export class IntakeLoop {
  private botUserId: number | null = null;
  private botUsername: string | null = null;
  private readonly handlers: IntakeHandlers;

  constructor(private readonly options: IntakeLoopOptions) {
    this.handlers = options.handlers ?? {};
  }

  /**
   * Resolves the bot's own identity. **Must complete before the first poll.**
   *
   * While `botUserId` is null, `normaliseUpdate` cannot recognise Baton's own
   * messages, so it would ingest its own answers and a figure it repeated once would
   * come back as a freshly confirmed fact.
   */
  async start(): Promise<number> {
    const me = await this.options.telegram.getMe();
    this.botUserId = me.id;
    // Needed for the other half of question detection. A null username is not fatal —
    // the reply signal still works — but it silently removes the @-mention signal, which
    // is how most questions arrive.
    this.botUsername = me.username ?? null;
    return me.id;
  }

  /** The bot's user id, once resolved. Exposed so a caller can log or assert on it. */
  get identity(): number | null {
    return this.botUserId;
  }

  /** The bot's @-handle, once resolved. Half of question detection depends on it. */
  get handle(): string | null {
    return this.botUsername;
  }

  /**
   * Question detection, against the raw message.
   *
   * Raw rather than normalised, because both signals need what normalisation drops: the
   * replied-to message's sender, and the text before media handling.
   */
  private detectQuestion(message: TelegramMessage | undefined): QuestionDetection {
    if (message === undefined) {
      return { isQuestion: false, signal: "none", repliedToBotMessageId: null };
    }
    return detectQuestionToBot(message, {
      botUserId: this.botUserId,
      botUsername: this.botUsername,
    });
  }

  /**
   * One poll-and-persist cycle.
   *
   * Returns counts rather than logging them, so the caller decides what is worth
   * saying and tests can assert on the numbers.
   */
  async runOnce(): Promise<IntakeCycleResult> {
    if (this.botUserId === null) {
      throw new Error(
        "IntakeLoop.start() must resolve the bot's identity before polling, or Baton " +
          "cannot recognise its own messages and will learn facts from its own answers.",
      );
    }

    const { db, telegram, chatId } = this.options;
    const offset = await getTelegramOffset(db);
    const updates = await telegram.getUpdates(offset);

    const result: IntakeCycleResult = {
      updatesReceived: updates.length,
      messagesStored: 0,
      editsStored: 0,
      membershipEvents: 0,
      privateMessages: 0,
      questionsToBot: 0,
      ignored: emptyIgnoredCounts(),
      offsetCommitted: null,
    };

    if (updates.length === 0) return result;

    // Ascending, so a reply resolves against a parent already stored and supersession
    // sees a contradiction in the order it was said.
    const ordered = [...updates].sort((a, b) => a.update_id - b.update_id);

    for (const update of ordered) {
      const outcome = normaliseUpdate(update, { chatId, botUserId: this.botUserId });

      switch (outcome.kind) {
        case "message": {
          const detection = this.detectQuestion(update.message);
          const stored = await persistMessage(db, outcome.message, {
            isQuestionToBot: detection.isQuestion,
          });
          result.messagesStored += 1;

          if (detection.isQuestion) {
            result.questionsToBot += 1;
            // A reply to one of Baton's own messages is ambiguous in one specific way: it
            // may be an *answer* to something Baton asked. The handler resolves that,
            // because only the store knows which bot messages were questions — and
            // answering "yes" as though it were a new question would leave the approval
            // it was replying to pending forever.
            await this.handlers.onQuestionToBot?.(stored.id, detection);
          }
          break;
        }
        case "edited_message": {
          // The upsert clears `curated_at` and the pre-filter verdict when the text
          // actually changed, so re-curation follows from persistence rather than from
          // anything this loop remembers.
          const detection = this.detectQuestion(update.edited_message);
          const stored = await persistMessage(db, outcome.message, {
            isQuestionToBot: detection.isQuestion,
          });
          result.editsStored += 1;
          await this.handlers.onEditedMessage?.(stored.id, outcome.message);
          break;
        }
        case "chat_member": {
          result.membershipEvents += 1;
          await this.handlers.onMembershipEvent?.(outcome.event);
          break;
        }
        case "my_chat_member": {
          await this.handlers.onBotMembershipEvent?.(outcome.event);
          break;
        }
        case "private_message": {
          // Recorded, not ingested. The register holds what the *group* knows; a
          // private remark must never reach a brief everyone can read. What this
          // earns is the ability to write back — see `recordPrivateChat`.
          result.privateMessages += 1;
          const personId = await recordPrivateChat(db, {
            telegramUserId: outcome.event.telegramUserId,
            displayName: outcome.event.displayName,
            privateChatId: outcome.event.privateChatId,
          });
          await this.handlers.onPrivateMessage?.(personId, outcome.event);
          break;
        }
        case "ignored": {
          result.ignored[outcome.reason] += 1;
          break;
        }
      }
    }

    // Classify what was just stored, still inside the cycle: a candidate that never
    // gets a verdict is invisible to the processing loop.
    await runPrefilterPass(db, { limit: PREFILTER_BATCH });

    // Last. See the note at the top of this file.
    const highest = ordered[ordered.length - 1]?.update_id;
    if (highest !== undefined) {
      const next = highest + 1;
      await setTelegramOffset(db, next);
      result.offsetCommitted = next;
    }

    return result;
  }
}
