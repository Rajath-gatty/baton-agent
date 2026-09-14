/**
 * The Telegram Bot API client.
 *
 * Long polling rather than webhooks: the VM is always on, so `getUpdates` removes the
 * need for a public HTTPS endpoint for the bot, works behind NAT, and needs no
 * re-registration after a restart.
 *
 * **Three settings here fail silently rather than loudly, which is why each is stated
 * in code rather than assumed:**
 *
 *   1. `allowed_updates` must be requested explicitly. Telegram does **not** deliver
 *      `chat_member` by default, and the departure brief fires from a membership
 *      event — the first fifteen seconds of the demo. Omit it and nothing errors; the
 *      brief simply never happens.
 *   2. The bot must be a group administrator, or `chat_member` is not delivered to it
 *      at all. Not something this client can enforce, so {@link TelegramClient.getChatMember}
 *      exists to let the worker check and say so at startup.
 *   3. Privacy mode must be disabled through BotFather, or the bot receives only
 *      messages that mention it and appears completely broken while being configured
 *      exactly as documented.
 *
 * The HTTP call is injectable so the intake loop can be tested without a bot, a
 * network, or a token. That seam is load-bearing rather than convenient: Telegram
 * setup is a Phase 0 gate that has not been proved yet, and nothing else in the
 * pipeline should have to wait for it.
 */

import { TELEGRAM_ALLOWED_UPDATES, type TelegramUpdate, type TelegramUser } from "@baton/core";

/** The subset of `fetch` this client needs, so a test can supply a function. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface TelegramClientOptions {
  token: string;
  /** Defaults to global `fetch`. Overridden in tests. */
  fetchImpl?: FetchLike;
  /**
   * How long Telegram holds a poll open with no updates. Telegram counts this
   * server-side, so the local timeout below must exceed it or every idle poll aborts.
   */
  longPollSeconds?: number;
  baseUrl?: string;
}

/** Telegram's envelope. `ok: false` carries a description worth surfacing. */
interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

/**
 * Thrown for an API-level failure, carrying `retry_after` when Telegram rate-limits.
 *
 * Distinguished from a transport failure because the responses differ: a 429 says
 * exactly how long to wait, and guessing instead is how a bot gets restricted.
 */
export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode: number | undefined,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

const DEFAULT_LONG_POLL_SECONDS = 25;

export interface SendMessageOptions {
  chatId: number;
  text: string;
  /** Makes the message a reply, which is how an answer is tied to its question. */
  replyToMessageId?: number;
  disableNotification?: boolean;
}

export interface SentMessage {
  messageId: number;
  chatId: number;
}

export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly longPollSeconds: number;
  private readonly baseUrl: string;

  constructor(options: TelegramClientOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.longPollSeconds = options.longPollSeconds ?? DEFAULT_LONG_POLL_SECONDS;
    this.baseUrl = options.baseUrl ?? "https://api.telegram.org";
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    // Comfortably longer than the server-side long poll, or an idle poll would abort
    // locally every time and look like a network fault.
    const timeout = setTimeout(() => controller.abort(), (this.longPollSeconds + 15) * 1000);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const body = (await response.json()) as TelegramResponse<T>;
      if (!response.ok || !body.ok || body.result === undefined) {
        throw new TelegramApiError(
          `Telegram ${method} failed: ${body.description ?? `HTTP ${response.status}`}`,
          body.error_code,
          body.parameters?.retry_after,
        );
      }
      return body.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The bot's own identity.
   *
   * Resolved before polling starts, never after: until the bot's user id is known,
   * nothing can be recognised as the bot's own message, and Baton learning a fact
   * from its own answer is a corruption loop with no visible symptom.
   */
  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>("getMe", {});
  }

  /**
   * One long poll.
   *
   * `allowed_updates` is sent on every call rather than once, because Telegram
   * remembers it per call and an omission silently narrows what arrives.
   */
  getUpdates(offset: number | null): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      ...(offset === null ? {} : { offset }),
      timeout: this.longPollSeconds,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    });
  }

  /** Every outbound message goes through the queue, which goes through here. */
  async sendMessage(options: SendMessageOptions): Promise<SentMessage> {
    const result = await this.call<{ message_id: number; chat: { id: number } }>("sendMessage", {
      chat_id: options.chatId,
      text: options.text,
      ...(options.replyToMessageId === undefined
        ? {}
        : { reply_parameters: { message_id: options.replyToMessageId } }),
      ...(options.disableNotification === undefined
        ? {}
        : { disable_notification: options.disableNotification }),
    });
    return { messageId: result.message_id, chatId: result.chat.id };
  }

  /**
   * Used at startup to check the bot is an administrator.
   *
   * Not enforcement — Telegram will not let this client promote itself — but it turns
   * a silent absence of membership events into a line in the deploy log.
   */
  getChatMember(chatId: number, userId: number): Promise<{ status: string }> {
    return this.call<{ status: string }>("getChatMember", { chat_id: chatId, user_id: userId });
  }
}
