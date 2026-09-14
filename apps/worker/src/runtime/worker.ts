/**
 * The runtime supervisor — what turns the worker from a library into a running service.
 *
 * Everything under `pipeline/` and `telegram/` was reachable only from tests until this
 * file existed. It owns three things and deliberately no logic of its own:
 *
 *   1. **Startup order.** Settings before loops, bot identity before the first poll.
 *   2. **The two loops**, running independently. Intake polls and persists; the tick
 *      derives, answers and asks. They share only the database.
 *   3. **Shutdown.** Stop polling, let the current tick finish, drain the outbound queue.
 *
 * **Why two loops rather than one.** Curation must never block polling. A single loop
 * would hold intake for the duration of a model call, and one slow Curator would stall
 * the live demo at exactly the wrong moment — a message sent on camera not appearing.
 * The split is also what makes the pipeline advisory lock sufficient: only the tick
 * derives, so only the tick needs serialising.
 *
 * **Why the loops are not `setInterval`.** An interval fires whether or not the previous
 * cycle finished, so a tick slower than its interval would overlap itself and every
 * overlap would find the lock held and do nothing except cost a model call's worth of
 * setup. Each loop instead sleeps *after* completing, so the period is a gap between
 * cycles rather than a schedule.
 */

import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import { coordinatorTelegramIds, telegramChatId, type WorkerConfig } from "../config.js";
import { TelegramClient } from "../telegram/client.js";
import { OutboundQueue } from "../telegram/outbound-queue.js";
import { IntakeLoop, type IntakeHandlers } from "../telegram/intake-loop.js";
import { seedAppSettings } from "../store/app-settings.js";
import { findReplyContext } from "../store/messages.js";
import { applyEditConsequences } from "../pipeline/edits.js";
import { applyMembershipEvent, handleBotMembershipEvent } from "../pipeline/lifecycle.js";
import { briefOnMembership } from "../pipeline/brief.js";
import { dispositionOfReply } from "../pipeline/approval.js";
import { runTick } from "./tick.js";
import { Backoff, type BackoffOptions } from "./backoff.js";

/** Gap between intake cycles. Short: `getUpdates` long-polls, so this is not a poll rate. */
const DEFAULT_INTAKE_IDLE_MS = 1_000;

/**
 * Gap between ticks.
 *
 * Fifteen seconds is affordable because the sweep short-circuits in SQL when the
 * candidate set is unchanged — an idle system calls no model at all, so a frequent tick
 * costs one cheap query. Without that short-circuit this would have to be minutes.
 */
const DEFAULT_TICK_IDLE_MS = 15_000;

export interface WorkerRuntimeDeps {
  db: Database;
  config: WorkerConfig;
  transport: AgentTransport;
  /** Injected so tests can supply a fake. Built from config when absent. */
  telegram?: TelegramClient;
  queue?: OutboundQueue;
  intakeIdleMs?: number;
  tickIdleMs?: number;
  backoff?: BackoffOptions;
  /** Injected for tests. Defaults to a real timer that a shutdown can interrupt. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

/** A sleep a shutdown can cut short, so SIGTERM is not stuck behind a five-minute backoff. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

/**
 * Builds the intake handlers.
 *
 * All four are wired here and none is optional in practice, though the loop's interface
 * makes them so. Each omission is a specific silent failure:
 *
 *   - no `onMembershipEvent`: `people.status` never changes **and no brief ever fires**,
 *     which is the first fifteen seconds of the demo video;
 *   - no `onBotMembershipEvent`: the bot joins a group and says nothing;
 *   - no `onEditedMessage`: an edit clears curation but the facts the old text produced
 *     stay active, so the register asserts something nobody said any more;
 *   - no `onQuestionToBot`: a reply answering an approval is treated as a new question,
 *     so the approval waits forever while the person who answered it is told something
 *     unrelated.
 */
export function buildIntakeHandlers(deps: {
  db: Database;
  transport: AgentTransport;
  queue: OutboundQueue;
  chatId: number;
  permittedTelegramIds: readonly number[];
  log: (line: string) => void;
}): IntakeHandlers {
  const { db, transport, queue, chatId, permittedTelegramIds, log } = deps;

  const brief = briefOnMembership({ db, transport, queue });

  return {
    onMembershipEvent: async (event) => {
      const outcome = await applyMembershipEvent(db, event);
      // The brief fires from the membership event itself, with no button pressed. That
      // seam *is* the feature.
      const result = await brief(outcome);
      log(
        `[intake] membership ${event.transition} for ${event.displayName}` +
          (result === null ? " (no brief owed)" : ` → brief ${result.briefId ?? "withheld"}`),
      );
    },

    onBotMembershipEvent: async (event) => {
      // `normaliseUpdate` filters *messages* by chat id but not `my_chat_member`, so the
      // guard belongs here. Without it, adding the bot to any other group would have it
      // introduce itself there — and with a separate development bot and group in play,
      // an introduction appearing in the wrong place is a confusing way to learn a token
      // was reused. The design is explicit that only the configured chat is processed.
      if (event.chatId !== chatId) {
        log(`[intake] ignoring bot membership change in foreign chat ${event.chatId}`);
        return;
      }

      // `claimIntroduction` makes this idempotent per chat, so repeated re-adds during
      // testing introduce Baton exactly once.
      const outcome = await handleBotMembershipEvent(db, event);
      if (!outcome.shouldSend) return;
      // Through the queue, like every other outbound message. A second send path would
      // be a second rate limit, which is how a bot gets restricted mid-demo.
      await queue.enqueue({ chatId: outcome.chatId, text: outcome.text });
      log(`[intake] introduced Baton in chat ${outcome.chatId}`);
    },

    onEditedMessage: async (messageId) => {
      const consequences = await applyEditConsequences(db, messageId);
      log(
        `[intake] edit ${messageId} superseded ${consequences.factsSuperseded} fact(s), ` +
          `retained ${consequences.factsRetained} with other support`,
      );
    },

    onQuestionToBot: async (messageId, detection) => {
      // Only a reply can be an answer. A bare @-mention is always a new question, and
      // the respond pass will find it from the flag intake already stored.
      if (detection.repliedToBotMessageId === null) return;

      const context = await findReplyContext(db, messageId);
      if (context === null) return;

      const disposition = await dispositionOfReply(
        { db, transport },
        {
          messageId: context.messageId,
          senderPersonId: context.senderPersonId,
          text: context.text,
          repliedToBotMessageId: detection.repliedToBotMessageId,
          at: context.sentAt,
        },
        permittedTelegramIds,
      );

      if (disposition.kind !== "new_question") {
        log(`[intake] reply ${messageId} resolved as ${disposition.kind}`);
      }
    },
  };
}

export interface WorkerRuntime {
  /** Resolves when both loops have stopped. */
  readonly stopped: Promise<void>;
  /** Signals both loops to finish their current cycle and drains the outbound queue. */
  stop: () => Promise<void>;
}

/**
 * Starts the worker's runtime.
 *
 * Returns immediately with a handle; the loops run in the background. Startup work that
 * must precede polling is awaited before returning, so a caller that gets a handle back
 * knows settings are seeded and the bot's identity is resolved.
 */
export async function startWorkerRuntime(deps: WorkerRuntimeDeps): Promise<WorkerRuntime> {
  const { db, config, transport } = deps;
  const log = deps.log ?? ((line: string) => console.log(line));
  const sleep = deps.sleep ?? interruptibleSleep;
  const chatId = telegramChatId(config);

  const telegram = deps.telegram ?? new TelegramClient({ token: config.TELEGRAM_BOT_TOKEN });
  const queue = deps.queue ?? new OutboundQueue({ telegram });

  // Before the loops. Every hydration path reads `app_settings` for the chat id, the org
  // name and the timezone, and a null timezone would resolve relative dates against UTC —
  // which at IST shifts them by a day and reads as a bug in provenance.
  await seedAppSettings(db, {
    chatId,
    timezone: config.ORG_TIMEZONE,
  });

  const handlers = buildIntakeHandlers({
    db,
    transport,
    queue,
    chatId,
    permittedTelegramIds: coordinatorTelegramIds(config),
    log,
  });

  const intake = new IntakeLoop({ db, telegram, chatId, handlers });

  // Must complete before the first poll: until the bot's own user id is known, nothing can
  // be recognised as Baton's own message, and a stale figure it repeated would come back as
  // a freshly confirmed fact.
  const botUserId = await intake.start();
  log(`[worker] bot identity ${botUserId} (@${intake.handle ?? "no-username"})`);

  // Not enforcement — this client cannot promote itself — but it turns the silent absence
  // of membership events into one line in the deploy log. A non-administrator bot never
  // receives `chat_member`, so the departure brief simply never fires.
  try {
    const membership = await telegram.getChatMember(chatId, botUserId);
    if (membership.status !== "administrator") {
      log(
        `[worker] WARNING Baton is '${membership.status}' in chat ${chatId}, not administrator. ` +
          "Telegram delivers chat_member updates only to administrators, so joins and " +
          "departures will not arrive and no brief will fire.",
      );
    }
  } catch (error) {
    log(
      `[worker] WARNING could not verify group membership: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const controller = new AbortController();
  const { signal } = controller;

  const intakeIdleMs = deps.intakeIdleMs ?? DEFAULT_INTAKE_IDLE_MS;
  const tickIdleMs = deps.tickIdleMs ?? DEFAULT_TICK_IDLE_MS;

  /** Runs one loop until aborted or until its backoff is exhausted. */
  async function loop(name: string, idleMs: number, cycle: () => Promise<void>): Promise<void> {
    const backoff = new Backoff(deps.backoff);

    while (!signal.aborted) {
      try {
        await cycle();
        backoff.recordSuccess();
        await sleep(idleMs, signal);
      } catch (error) {
        const delay = backoff.recordFailure();
        log(
          `[${name}] cycle failed (${backoff.failures} consecutive): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );

        if (backoff.exhausted) {
          // Stops the loop, does **not** exit the process. Coolify restarts a container
          // that exits, which would reset the counter and defeat the cap entirely — the
          // restart loop the health-check design exists to avoid. A stopped loop in a
          // live container keeps /health green and the failure legible.
          log(
            `[${name}] stopping after ${backoff.failures} consecutive failures. ` +
              "The container stays up so /health and the data API keep answering; " +
              "fix the cause and redeploy.",
          );
          return;
        }

        log(`[${name}] retrying in ${delay} ms`);
        await sleep(delay, signal);
      }
    }
  }

  const intakeDone = loop("intake", intakeIdleMs, async () => {
    const result = await intake.runOnce();
    if (result.updatesReceived > 0) {
      log(
        `[intake] ${result.updatesReceived} update(s): ${result.messagesStored} stored, ` +
          `${result.editsStored} edited, ${result.membershipEvents} membership, ` +
          `${result.questionsToBot} to Baton`,
      );
    }
  });

  const tickDone = loop("tick", tickIdleMs, async () => {
    const result = await runTick({ db, transport, queue });

    const didSomething =
      result.candidates > 0 ||
      result.findingsCreated > 0 ||
      result.findingsUpdated > 0 ||
      result.questionsAnswered > 0 ||
      result.questionsAsked > 0;

    if (didSomething) {
      log(
        `[tick] ${result.candidates} candidate(s), ${result.factsExtracted} fact(s), ` +
          `findings +${result.findingsCreated}/~${result.findingsUpdated}, ` +
          `${result.questionsAnswered} answered, ${result.questionsAsked} asked`,
      );
    }

    if (result.failures.length > 0) {
      for (const failure of result.failures) {
        log(`[tick] pass '${failure.pass}' failed: ${failure.error}`);
      }

      // **Any** failed pass makes the cycle a failure, even though the other passes still
      // ran and their work still counts. The tick deliberately does not abort on a failing
      // pass — see `runTick` — but the loop must still hear about it, because the case the
      // failure cap exists for is exactly this shape: one pass failing forever on a
      // revoked API key while the other three succeed at doing nothing. Counting only
      // total failure would leave that retrying until somebody noticed the bill.
      throw new Error(
        `${result.failures.length} pass(es) failed: ` +
          result.failures.map((failure) => failure.pass).join(", "),
      );
    }
  });

  const stopped = Promise.all([intakeDone, tickDone]).then(() => undefined);

  return {
    stopped,
    stop: async () => {
      controller.abort();
      await stopped;
      // After the loops, so nothing is still enqueueing. A queued outbound message lost on
      // redeploy is a question a volunteer was about to be asked, silently dropped.
      await queue.drain();
    },
  };
}
