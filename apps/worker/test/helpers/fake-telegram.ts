/**
 * A fake Telegram, shared by the tests that need one.
 *
 * Built on the same injected `FetchLike` seam the real client uses, so request shape —
 * including `allowed_updates`, whose absence is silent in production — is genuinely
 * exercised rather than bypassed by stubbing the client's methods.
 */

import type { TelegramUpdate } from "@baton/core";
import type { FetchLike } from "../../src/telegram/client.js";

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface TelegramFailure {
  description: string;
  errorCode?: number;
  retryAfter?: number;
}

export class FakeTelegram {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  /** Set to make the next call fail the way Telegram reports failures. */
  failWith: TelegramFailure | null = null;

  queue(method: string, result: unknown): void {
    const existing = this.queues.get(method) ?? [];
    existing.push(result);
    this.queues.set(method, existing);
  }

  /** Convenience for the common case. */
  queueUpdates(updates: TelegramUpdate[]): void {
    this.queue("getUpdates", updates);
  }

  readonly fetchImpl: FetchLike = (url, init) => {
    const method = url.split("/").pop() ?? "";
    this.calls.push({ method, payload: JSON.parse(init.body) as Record<string, unknown> });

    if (this.failWith !== null) {
      const failure = this.failWith;
      this.failWith = null;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: false,
            description: failure.description,
            error_code: failure.errorCode,
            parameters:
              failure.retryAfter === undefined ? undefined : { retry_after: failure.retryAfter },
          }),
        text: () => Promise.resolve(""),
      });
    }

    const queue = this.queues.get(method) ?? [];
    // An exhausted getUpdates queue means "no updates", which is what an idle group
    // looks like — not an error.
    const result = queue.shift() ?? (method === "getUpdates" ? [] : {});
    this.queues.set(method, queue);

    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, result }),
      text: () => Promise.resolve(""),
    });
  };

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }
}
