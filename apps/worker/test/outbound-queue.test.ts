/**
 * The outbound queue and the private-delivery path.
 *
 * Pacing is tested against an injected clock rather than a real one, so "twenty a
 * minute" is asserted in milliseconds. The behaviours that matter: nothing is dropped
 * for being over the limit, order is preserved, a rate-limit response is obeyed for
 * exactly as long as Telegram asked, and an unreachable recipient is an outcome rather
 * than an exception.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { TelegramClient, type FetchLike } from "../src/telegram/client.js";
import { OutboundQueue } from "../src/telegram/outbound-queue.js";
import { sendPrivately, sendToCoordinator } from "../src/telegram/private-delivery.js";
import { recordPrivateChat, upsertPersonByTelegramId } from "../src/store/people.js";
import { setCoordinatorPerson } from "../src/store/app-settings.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";

const CHAT_ID = -1001234567890;

/**
 * A virtual clock. `sleep` advances it instead of waiting, so a burst that would take
 * two and a half minutes of wall time is asserted instantly — and the assertions are
 * about the pacing decision rather than about timer precision.
 */
function virtualClock() {
  let current = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    sleeps,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function queueWith(fake: FakeTelegram, clock: ReturnType<typeof virtualClock>, perMinute = 20) {
  return new OutboundQueue({
    telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
    messagesPerMinute: perMinute,
    sleep: clock.sleep,
    now: clock.now,
  });
}

/** Queues N successful sendMessage responses. */
function queueSends(fake: FakeTelegram, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fake.queue("sendMessage", { message_id: 9000 + index, chat: { id: CHAT_ID } });
  }
}

describe("the outbound queue", () => {
  it("sends a single message immediately", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 1);

    const outcome = await queueWith(fake, clock).enqueue({ chatId: CHAT_ID, text: "hello" });

    expect(outcome).toEqual({ ok: true, messageId: 9000, chatId: CHAT_ID });
    expect(clock.sleeps).toEqual([]);
  });

  it("paces a burst rather than dropping any of it", async () => {
    // Fifty messages at twenty a minute. Nothing is discarded — the caller has already
    // recorded that each of these was going to be sent.
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 50);
    const queue = queueWith(fake, clock);

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        queue.enqueue({ chatId: CHAT_ID, text: `message ${index}` }),
      ),
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(fake.callsTo("sendMessage")).toHaveLength(50);
    // One free send, then 49 spaced by 3000ms.
    expect(clock.sleeps).toHaveLength(49);
    expect(clock.sleeps.every((ms) => ms === 3000)).toBe(true);
  });

  it("spaces sends at the configured rate", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 3);
    const queue = queueWith(fake, clock, 60); // one per second

    await queue.enqueue({ chatId: CHAT_ID, text: "a" });
    await queue.enqueue({ chatId: CHAT_ID, text: "b" });
    await queue.enqueue({ chatId: CHAT_ID, text: "c" });

    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it("does not wait when enough time has already passed", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 2);
    const queue = queueWith(fake, clock);

    await queue.enqueue({ chatId: CHAT_ID, text: "a" });
    clock.advance(10_000);
    await queue.enqueue({ chatId: CHAT_ID, text: "b" });

    expect(clock.sleeps).toEqual([]);
  });

  it("preserves order, so an answer cannot overtake the approval ahead of it", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 5);
    const queue = queueWith(fake, clock);

    await Promise.all(
      ["first", "second", "third", "fourth", "fifth"].map((text) =>
        queue.enqueue({ chatId: CHAT_ID, text }),
      ),
    );

    expect(fake.callsTo("sendMessage").map((call) => call.payload["text"])).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
    ]);
  });

  it("waits exactly as long as Telegram asked, then retries", async () => {
    // Guessing the wait after a 429 is how a bot gets restricted for longer.
    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.failWith = { description: "Too Many Requests", errorCode: 429, retryAfter: 7 };
    queueSends(fake, 1);
    const queue = queueWith(fake, clock);

    const outcome = await queue.enqueue({ chatId: CHAT_ID, text: "hello" });

    expect(outcome.ok).toBe(true);
    expect(clock.sleeps).toContain(7000);
  });

  it("gives up after repeated rate limiting rather than looping", async () => {
    // The queue must not retry forever. An unattended worker retrying for days is the
    // cheapest way to spend real money on this project.
    const clock = virtualClock();
    let attempts = 0;
    const alwaysRateLimited: FetchLike = () => {
      attempts += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            ok: false,
            description: "Too Many Requests",
            error_code: 429,
            parameters: { retry_after: 5 },
          }),
        text: () => Promise.resolve(""),
      });
    };

    const queue = new OutboundQueue({
      telegram: new TelegramClient({ token: "t", fetchImpl: alwaysRateLimited }),
      sleep: clock.sleep,
      now: clock.now,
    });

    const outcome = await queue.enqueue({ chatId: CHAT_ID, text: "hello" });

    expect(outcome).toMatchObject({ ok: false, reason: "rate_limited" });
    // The first attempt plus two retries, and then it stops.
    expect(attempts).toBe(3);
  });

  it("reports a forbidden recipient without retrying", async () => {
    // 403 is what Telegram says when the person has never written to the bot. An
    // ordinary outcome, and retrying would never change it.
    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.failWith = { description: "Forbidden: bot can't initiate conversation", errorCode: 403 };
    const queue = queueWith(fake, clock);

    const outcome = await queue.enqueue({ chatId: 12345, text: "your brief" });

    expect(outcome).toMatchObject({ ok: false, reason: "forbidden" });
    expect(fake.callsTo("sendMessage")).toHaveLength(1);
  });

  it("keeps sending after one message fails", async () => {
    // A single failure must not stall the chain, or one unreachable recipient silences
    // every later message.
    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.failWith = { description: "Forbidden", errorCode: 403 };
    queueSends(fake, 1);
    const queue = queueWith(fake, clock);

    const first = queue.enqueue({ chatId: 1, text: "doomed" });
    const second = queue.enqueue({ chatId: CHAT_ID, text: "fine" });

    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
  });

  it("reports its depth, so shutdown can wait for it", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 3);
    const queue = queueWith(fake, clock);

    const inFlight = [
      queue.enqueue({ chatId: CHAT_ID, text: "a" }),
      queue.enqueue({ chatId: CHAT_ID, text: "b" }),
      queue.enqueue({ chatId: CHAT_ID, text: "c" }),
    ];
    expect(queue.depth).toBe(3);

    await Promise.all(inFlight);
    expect(queue.depth).toBe(0);
  });

  it("drains everything queued so far", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 4);
    const queue = queueWith(fake, clock);

    void queue.enqueue({ chatId: CHAT_ID, text: "a" });
    void queue.enqueue({ chatId: CHAT_ID, text: "b" });
    void queue.enqueue({ chatId: CHAT_ID, text: "c" });
    void queue.enqueue({ chatId: CHAT_ID, text: "d" });

    await queue.drain();

    expect(fake.callsTo("sendMessage")).toHaveLength(4);
  });

  it("passes a reply pointer through, which is how an answer is tied to its question", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    queueSends(fake, 1);

    await queueWith(fake, clock).enqueue({
      chatId: CHAT_ID,
      text: "47 a month, from 13 April",
      replyToMessageId: 4021,
    });

    expect(fake.callsTo("sendMessage")[0]?.payload["reply_parameters"]).toEqual({
      message_id: 4021,
    });
  });
});

describe("private delivery", () => {
  let harness: TestDatabase;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
  });

  it("delivers to someone who has written to the bot", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.queue("sendMessage", { message_id: 5001, chat: { id: 999 } });
    const queue = queueWith(fake, clock);

    const personId = await recordPrivateChat(harness.db, {
      telegramUserId: 588068795,
      displayName: "Priya Raghavan",
      privateChatId: 999,
    });

    const result = await sendPrivately(harness.db, queue, personId, "your brief");

    expect(result).toEqual({ delivered: true, messageId: 5001, chatId: 999 });
  });

  it("reports undeliverable, with the text, when Baton has never been written to", async () => {
    // The documented behaviour for most of a twenty-person roster: the admin UI renders
    // this text as copyable for the coordinator to pass on.
    const fake = new FakeTelegram();
    const clock = virtualClock();
    const queue = queueWith(fake, clock);

    const personId = await upsertPersonByTelegramId(harness.db, {
      telegramUserId: 424242,
      displayName: "Divya Nair",
    });

    const result = await sendPrivately(harness.db, queue, personId, "your brief");

    expect(result).toEqual({ delivered: false, reason: "no_private_chat", text: "your brief" });
    // Nothing was even attempted, so no request was spent on it.
    expect(fake.callsTo("sendMessage")).toHaveLength(0);
  });

  it("reports blocked when a chat existed but Telegram refused", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.failWith = { description: "Forbidden: bot was blocked by the user", errorCode: 403 };
    const queue = queueWith(fake, clock);

    const personId = await recordPrivateChat(harness.db, {
      telegramUserId: 1,
      displayName: "Someone",
      privateChatId: 111,
    });

    const result = await sendPrivately(harness.db, queue, personId, "your brief");

    expect(result).toMatchObject({ delivered: false, reason: "blocked", text: "your brief" });
  });

  it("routes a sensitive message to the coordinator", async () => {
    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.queue("sendMessage", { message_id: 7001, chat: { id: 222 } });
    const queue = queueWith(fake, clock);

    const coordinator = await recordPrivateChat(harness.db, {
      telegramUserId: 588068795,
      displayName: "Priya Raghavan",
      privateChatId: 222,
    });
    await setCoordinatorPerson(harness.db, coordinator);

    const result = await sendToCoordinator(harness.db, queue, "about the bank signatory");

    expect(result).toEqual({ delivered: true, messageId: 7001, chatId: 222 });
  });

  it("says so plainly when there is no coordinator to ask", async () => {
    // Reachable for real: if the coordinator is the person who left, it must be
    // reassigned before any approval can resolve. Asking the group instead would hand a
    // volunteer authority they must not have.
    const fake = new FakeTelegram();
    const clock = virtualClock();
    const queue = queueWith(fake, clock);

    const result = await sendToCoordinator(harness.db, queue, "about the bank signatory");

    expect(result).toMatchObject({ delivered: false, reason: "no_coordinator" });
    expect(fake.callsTo("sendMessage")).toHaveLength(0);
  });

  it("records the private chat when someone writes in, without ingesting what they said", async () => {
    // The only moment Baton learns it can reach a person directly.
    const personId = await recordPrivateChat(harness.db, {
      telegramUserId: 424242,
      displayName: "Divya Nair",
      privateChatId: 424242,
    });

    const fake = new FakeTelegram();
    const clock = virtualClock();
    fake.queue("sendMessage", { message_id: 1, chat: { id: 424242 } });

    const result = await sendPrivately(harness.db, queueWith(fake, clock), personId, "hello");
    expect(result.delivered).toBe(true);
  });
});
