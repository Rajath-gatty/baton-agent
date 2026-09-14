/**
 * The outbound queue.
 *
 * **Every** outbound message goes through here — answers, approval requests, the
 * introduction, brief deliveries. Telegram permits roughly twenty messages a minute to
 * one group, and exceeding it gets the bot restricted, which during a demo is
 * indistinguishable from the product being broken.
 *
 * **Independent of the ask budget, deliberately.** The two limits protect different
 * things and would be wrong sharing a number: this queue protects the Telegram API from
 * a burst, while the ask budget protects a reader's patience from being asked six
 * questions in an afternoon. A burst of thirty brief lines is fine for the budget and
 * fatal for the API; a fourth question in a day is fine for the API and not fine for
 * the reader.
 *
 * In memory rather than a table, and that is a considered trade. Nothing durable is
 * lost on a restart because everything that *matters* is already persisted before it is
 * enqueued: a question exists as a `questions` row with `status = 'queued'`, a brief as
 * `briefs` and `brief_lines`. What a restart drops is the transmission attempt, which
 * the owning row can retry, rather than the intent.
 *
 * Time is injected so the pacing can be tested in milliseconds instead of minutes.
 */

import { TelegramApiError, type SendMessageOptions, type TelegramClient } from "./client.js";

/** Telegram's practical ceiling for one group. */
const DEFAULT_MESSAGES_PER_MINUTE = 20;

/** How many times a rate-limited send is retried before giving up. */
const MAX_RATE_LIMIT_RETRIES = 2;

export interface OutboundMessage extends SendMessageOptions {
  /** For logs and traces. Never sent to Telegram. */
  purpose?: string;
}

/**
 * The result of one send.
 *
 * A failure is **returned, not thrown**. Callers are pipeline steps that have already
 * written the durable record — a `questions` row, a `briefs` row — and an exception
 * would unwind that work for something the owning row can retry. `forbidden` in
 * particular is an ordinary outcome: it is what Telegram says when the recipient has
 * never opened a chat with the bot.
 */
export type SendOutcome =
  | { ok: true; messageId: number; chatId: number }
  | { ok: false; reason: "forbidden" | "rate_limited" | "failed"; error: string };

export interface OutboundQueueOptions {
  telegram: TelegramClient;
  messagesPerMinute?: number;
  /** Injected for tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Defaults to `Date.now`. */
  now?: () => number;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OutboundQueue {
  private readonly telegram: TelegramClient;
  private readonly intervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  /**
   * The tail of the send chain. Each `enqueue` appends to it, which is what makes the
   * queue ordered: an answer must not overtake the approval request it was queued
   * behind.
   */
  private tail: Promise<void> = Promise.resolve();
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private pending = 0;

  constructor(options: OutboundQueueOptions) {
    this.telegram = options.telegram;
    const perMinute = options.messagesPerMinute ?? DEFAULT_MESSAGES_PER_MINUTE;
    this.intervalMs = Math.ceil(60_000 / perMinute);
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
  }

  /** How many messages are queued or in flight. Used by graceful shutdown. */
  get depth(): number {
    return this.pending;
  }

  /**
   * Queues a message and resolves when it has been sent or has failed.
   *
   * Nothing is dropped for being over the limit; it waits its turn. Dropping would be
   * the worst option available here — the caller has already recorded that the message
   * was going to be sent.
   */
  enqueue(message: OutboundMessage): Promise<SendOutcome> {
    this.pending += 1;

    const outcome = this.tail.then(() => this.sendPaced(message));

    // The chain must survive a failed send, or one error stalls every later message.
    this.tail = outcome.then(
      () => undefined,
      () => undefined,
    );

    return outcome.finally(() => {
      this.pending -= 1;
    });
  }

  /** Resolves once everything queued so far has been attempted. */
  async drain(): Promise<void> {
    await this.tail;
  }

  private async sendPaced(message: OutboundMessage): Promise<SendOutcome> {
    const waitFor = this.lastSentAt + this.intervalMs - this.now();
    if (waitFor > 0) await this.sleep(waitFor);

    return this.sendWithRetries(message, 0);
  }

  private async sendWithRetries(message: OutboundMessage, attempt: number): Promise<SendOutcome> {
    try {
      const sent = await this.telegram.sendMessage({
        chatId: message.chatId,
        text: message.text,
        ...(message.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: message.replyToMessageId }),
        ...(message.disableNotification === undefined
          ? {}
          : { disableNotification: message.disableNotification }),
      });
      this.lastSentAt = this.now();
      return { ok: true, messageId: sent.messageId, chatId: sent.chatId };
    } catch (error) {
      // Stamped even on failure: a rejected attempt still consumed a request, and
      // pacing off it is what stops a failing send from becoming a tight loop.
      this.lastSentAt = this.now();

      if (error instanceof TelegramApiError) {
        // 403 is the documented answer for "this user has never written to me". An
        // ordinary outcome, not an error to retry.
        if (error.errorCode === 403) {
          return { ok: false, reason: "forbidden", error: error.message };
        }

        if (error.retryAfterSeconds !== undefined && attempt < MAX_RATE_LIMIT_RETRIES) {
          // Telegram says exactly how long to wait. Guessing instead is how a bot
          // gets restricted for longer.
          await this.sleep(error.retryAfterSeconds * 1000);
          return this.sendWithRetries(message, attempt + 1);
        }

        if (error.retryAfterSeconds !== undefined) {
          return { ok: false, reason: "rate_limited", error: error.message };
        }
      }

      return {
        ok: false,
        reason: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
