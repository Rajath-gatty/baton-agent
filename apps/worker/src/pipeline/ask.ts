/**
 * Asking queued questions. `[F21]`
 *
 * The budget decides *whether*; this decides *how* and actually sends. Split from
 * `store/questions.ts` because the store must stay reachable from a test with no Telegram
 * client, and because the ordering here matters:
 *
 *   1. Ask the budget how many slots there are.
 *   2. Take that many queued questions, highest priority first.
 *   3. Send each one.
 *   4. Stamp `asked_at` **only after the send succeeded**.
 *
 * Step four is the whole reason asking is not part of the insert. `asked_at` is what the
 * rolling window counts, so stamping it before the send would spend the reader's budget on
 * a message they never received — and on a day when Telegram is rate-limiting, that
 * silently throttles Baton to nothing while the register fills with questions nobody was
 * asked.
 *
 * **A queued question's subject stays out of findings and briefs while it waits**, and that
 * falls out of the design rather than needing enforcement here: an approval's claim sits at
 * `pending_approval`, which every detection query filters out, and a clarification about an
 * unresolved mention never produced a fact in the first place. The cap therefore produces a
 * visible gap rather than an invented fact.
 */

import type { Database } from "@baton/core/db";
import { askBudgetStatus, markQuestionAsked, selectAskableQuestions } from "../store/questions.js";
import { sendPrivately, sendToCoordinator } from "../telegram/private-delivery.js";
import type { OutboundQueue } from "../telegram/outbound-queue.js";
import { getAppSettings } from "../store/app-settings.js";
import type { Executor } from "../store/types.js";

export interface AskDeps {
  db: Database;
  queue: OutboundQueue;
  /** The group chat. Read from settings when absent, which is the normal path. */
  chatId?: number;
  now?: () => Date;
}

export type AskOutcome = "sent" | "undeliverable" | "no_recipient";

export interface AskedQuestion {
  questionId: string;
  outcome: AskOutcome;
  botTelegramMessageId: number | null;
  /** Present when the ask could not be delivered, so the UI can offer it as copyable. */
  text?: string;
}

export interface AskPassResult {
  /** How many slots the budget offered. Zero means everything stays queued. */
  slots: number;
  asked: AskedQuestion[];
  /** Left queued because the budget was full. Not a failure. */
  stillQueued: number;
  reason: string;
}

/**
 * Sends as many queued questions as the budget allows.
 *
 * A question that cannot be delivered — the coordinator has never opened a chat with the
 * bot, say — is **left queued** rather than marked asked. It consumed no budget because
 * nobody read it, and leaving it queued means it goes out the moment delivery becomes
 * possible. The returned text lets the UI render it as something a coordinator can copy and
 * send themselves, which is the documented fallback rather than a degradation.
 */
export async function runAskPass(deps: AskDeps): Promise<AskPassResult> {
  const { db, queue } = deps;
  const now = deps.now?.() ?? new Date();

  const budget = await askBudgetStatus(db, now);
  const askable = await selectAskableQuestions(db, now);

  const asked: AskedQuestion[] = [];

  for (const question of askable) {
    if (question.target === "coordinator") {
      // Routed to the named person when the question has one, and to whoever holds the
      // coordinator role otherwise. A sensitive ask carries a target person precisely so
      // it does not go to the group.
      const delivery =
        question.targetPersonId === null
          ? await sendToCoordinator(db, queue, question.askedText, `${question.kind} question`)
          : await sendPrivately(
              db,
              queue,
              question.targetPersonId,
              question.askedText,
              `${question.kind} question`,
            );

      if (delivery.delivered) {
        await markQuestionAsked(db, question.id, {
          botTelegramMessageId: delivery.messageId,
          at: now,
        });
        asked.push({
          questionId: question.id,
          outcome: "sent",
          botTelegramMessageId: delivery.messageId,
        });
      } else {
        asked.push({
          questionId: question.id,
          outcome: delivery.reason === "no_coordinator" ? "no_recipient" : "undeliverable",
          botTelegramMessageId: null,
          text: delivery.text,
        });
      }
      continue;
    }

    const chatId = deps.chatId ?? (await resolveChatId(db));
    if (chatId === null) {
      asked.push({
        questionId: question.id,
        outcome: "no_recipient",
        botTelegramMessageId: null,
        text: question.askedText,
      });
      continue;
    }

    const outcome = await queue.enqueue({
      chatId,
      text: question.askedText,
      purpose: `${question.kind} question`,
    });

    if (outcome.ok) {
      // The bot's own message id, so a Telegram reply can be matched back to this exact
      // question rather than guessed at from timing.
      await markQuestionAsked(db, question.id, {
        botTelegramMessageId: outcome.messageId,
        at: now,
      });
      asked.push({
        questionId: question.id,
        outcome: "sent",
        botTelegramMessageId: outcome.messageId,
      });
    } else {
      asked.push({
        questionId: question.id,
        outcome: "undeliverable",
        botTelegramMessageId: null,
        text: question.askedText,
      });
    }
  }

  const sent = asked.filter((entry) => entry.outcome === "sent").length;

  return {
    slots: budget.slots,
    asked,
    stillQueued: askable.length - sent,
    reason: budget.reason,
  };
}

async function resolveChatId(db: Executor): Promise<number | null> {
  return (await getAppSettings(db)).chatId;
}
