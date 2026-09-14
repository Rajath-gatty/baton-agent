/**
 * The Telegram client and the intake loop, driven by a fake Telegram.
 *
 * No bot, no token, no network — the HTTP call is injected. That matters beyond
 * convenience: Telegram setup is an unproven Phase 0 gate, and the pipeline should not
 * have to wait on it.
 *
 * Two assertions here stand in for failures that are silent in production. The
 * `allowed_updates` check is one: omit `chat_member` and nothing errors, the departure
 * brief simply never fires. The offset-ordering check is the other: commit before
 * persisting and messages are lost with no record that they existed.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import type { MembershipEvent, TelegramUpdate } from "@baton/core";
import { TelegramApiError, TelegramClient } from "../src/telegram/client.js";
import { IntakeLoop } from "../src/telegram/intake-loop.js";
import { getTelegramOffset } from "../src/store/worker-state.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";

const { messages, people, workerState } = schema;

const CHAT_ID = -1001234567890;
const BOT_ID = 8871830879;

function messageUpdate(
  updateId: number,
  overrides: Partial<{ messageId: number; text: string; from: number; date: number }> = {},
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: overrides.messageId ?? updateId,
      from: {
        id: overrides.from ?? 588068795,
        first_name: "Priya",
        last_name: "Raghavan",
      },
      date: overrides.date ?? 1_776_000_000 + updateId,
      chat: { id: CHAT_ID, type: "supergroup" },
      text: overrides.text ?? "I have the shelter keys",
    },
  };
}

describe("the Telegram client", () => {
  it("requests every update type the product depends on", async () => {
    // The single most silent failure in the whole system: Telegram does not deliver
    // chat_member by default, and the departure brief fires from it. Nothing errors.
    const fake = new FakeTelegram();
    const client = new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl });

    await client.getUpdates(null);

    const payload = fake.callsTo("getUpdates")[0]?.payload;
    expect(payload?.["allowed_updates"]).toEqual([
      "message",
      "edited_message",
      "chat_member",
      "my_chat_member",
    ]);
  });

  it("sends the offset when it has one and omits it when it does not", async () => {
    const fake = new FakeTelegram();
    const client = new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl });

    await client.getUpdates(null);
    await client.getUpdates(42);

    expect(fake.callsTo("getUpdates")[0]?.payload).not.toHaveProperty("offset");
    expect(fake.callsTo("getUpdates")[1]?.payload["offset"]).toBe(42);
  });

  it("asks Telegram to hold the poll open", async () => {
    const fake = new FakeTelegram();
    const client = new TelegramClient({
      token: "t",
      fetchImpl: fake.fetchImpl,
      longPollSeconds: 30,
    });
    await client.getUpdates(null);
    expect(fake.callsTo("getUpdates")[0]?.payload["timeout"]).toBe(30);
  });

  it("reads the bot's identity", async () => {
    const fake = new FakeTelegram();
    fake.queue("getMe", { id: BOT_ID, is_bot: true, first_name: "Baton" });
    const client = new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl });
    await expect(client.getMe()).resolves.toMatchObject({ id: BOT_ID });
  });

  it("surfaces an API failure with its description", async () => {
    const fake = new FakeTelegram();
    fake.failWith = { description: "Unauthorized", errorCode: 401 };
    const client = new TelegramClient({ token: "bad", fetchImpl: fake.fetchImpl });

    await expect(client.getMe()).rejects.toThrow(/Unauthorized/);
  });

  it("carries retry_after through, rather than making the wait up", async () => {
    // Guessing how long to wait after a 429 is how a bot gets restricted.
    const fake = new FakeTelegram();
    fake.failWith = { description: "Too Many Requests", errorCode: 429, retryAfter: 17 };
    const client = new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl });

    await expect(client.getMe()).rejects.toBeInstanceOf(TelegramApiError);
    fake.failWith = { description: "Too Many Requests", errorCode: 429, retryAfter: 17 };
    const error = await client.getMe().catch((caught: unknown) => caught);
    expect((error as TelegramApiError).retryAfterSeconds).toBe(17);
  });

  it("sends a message and reports the id it was given", async () => {
    // The bot's own message id is what a later reply is matched back to.
    const fake = new FakeTelegram();
    fake.queue("sendMessage", { message_id: 9001, chat: { id: CHAT_ID } });
    const client = new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl });

    const sent = await client.sendMessage({ chatId: CHAT_ID, text: "hello", replyToMessageId: 12 });

    expect(sent).toEqual({ messageId: 9001, chatId: CHAT_ID });
    const payload = fake.callsTo("sendMessage")[0]?.payload;
    expect(payload?.["chat_id"]).toBe(CHAT_ID);
    expect(payload?.["reply_parameters"]).toEqual({ message_id: 12 });
  });
});

describe("the intake loop", () => {
  let harness: TestDatabase;
  let fake: FakeTelegram;
  let loop: IntakeLoop;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    fake = new FakeTelegram();
    fake.queue("getMe", { id: BOT_ID, is_bot: true, first_name: "Baton" });
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
    });
  });

  it("refuses to poll before it knows its own identity", async () => {
    // Until then it cannot recognise its own messages, and Baton learning a fact from
    // its own answer is a corruption loop with no visible symptom.
    await expect(loop.runOnce()).rejects.toThrow(/own messages/);
  });

  it("persists a polled message and pre-filters it in the same cycle", async () => {
    fake.queue("getUpdates", [messageUpdate(101)]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.updatesReceived).toBe(1);
    expect(result.messagesStored).toBe(1);

    const rows = await harness.db
      .select({
        text: messages.text,
        verdict: messages.prefilterVerdict,
        version: messages.prefilterVersion,
      })
      .from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("I have the shelter keys");
    // A candidate with no verdict is invisible to the processing loop.
    expect(rows[0]?.verdict).toBe("candidate");
    expect(rows[0]?.version).not.toBeNull();
  });

  it("commits the offset only after the batch is stored", async () => {
    fake.queue("getUpdates", [messageUpdate(101), messageUpdate(102), messageUpdate(103)]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.offsetCommitted).toBe(104);
    await expect(getTelegramOffset(harness.db)).resolves.toBe(104);
    await expect(harness.db.select().from(messages)).resolves.toHaveLength(3);
  });

  it("sends the committed offset on the next poll", async () => {
    fake.queue("getUpdates", [messageUpdate(101)]);
    fake.queue("getUpdates", []);
    await loop.start();

    await loop.runOnce();
    await loop.runOnce();

    expect(fake.callsTo("getUpdates")[1]?.payload["offset"]).toBe(102);
  });

  it("commits nothing when there is nothing to poll", async () => {
    fake.queue("getUpdates", []);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.offsetCommitted).toBeNull();
    await expect(getTelegramOffset(harness.db)).resolves.toBeNull();
  });

  it("replays a redelivered batch without duplicating it", async () => {
    // What the offset-last ordering costs, and why it is affordable: intake upserts,
    // so a crash between persisting and committing replays harmlessly.
    fake.queue("getUpdates", [messageUpdate(101), messageUpdate(102)]);
    fake.queue("getUpdates", [messageUpdate(101), messageUpdate(102)]);
    await loop.start();

    await loop.runOnce();
    await loop.runOnce();

    await expect(harness.db.select().from(messages)).resolves.toHaveLength(2);
  });

  it("processes a batch in update order, so replies resolve", async () => {
    const parent = messageUpdate(101, { messageId: 5000, text: "who has the keys?" });
    const child = messageUpdate(102, { messageId: 5001, text: "I have the shelter keys" });
    if (child.message !== undefined) child.message.reply_to_message = { message_id: 5000 };
    // Delivered out of order on purpose.
    fake.queue("getUpdates", [child, parent]);
    await loop.start();

    await loop.runOnce();

    const rows = await harness.db
      .select({ telegramId: messages.telegramMessageId, parent: messages.replyToMessageId })
      .from(messages)
      .orderBy(messages.telegramMessageId);
    const parentRow = rows.find((row) => row.telegramId === 5000);
    const childRow = rows.find((row) => row.telegramId === 5001);
    expect(childRow?.parent).not.toBeNull();
    expect(childRow?.parent).toBe(
      (
        await harness.db
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.telegramMessageId, 5000))
      )[0]?.id,
    );
    expect(parentRow).toBeDefined();
  });

  it("drops Baton's own messages and says why", async () => {
    fake.queue("getUpdates", [messageUpdate(101, { from: BOT_ID })]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.messagesStored).toBe(0);
    expect(result.ignored.own_message).toBe(1);
    await expect(harness.db.select().from(messages)).resolves.toHaveLength(0);
  });

  it("ignores another chat and still advances the offset", async () => {
    // The offset must advance or the loop re-polls a foreign update forever.
    const foreign = messageUpdate(101);
    if (foreign.message !== undefined) foreign.message.chat = { id: -1009999999999 };
    fake.queue("getUpdates", [foreign]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.ignored.foreign_chat).toBe(1);
    expect(result.offsetCommitted).toBe(102);
  });

  it("counts an update type it does not understand without stopping", async () => {
    fake.queue("getUpdates", [{ update_id: 101 }]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.ignored.unsupported_update).toBe(1);
    expect(result.offsetCommitted).toBe(102);
  });

  it("stores an edit on the same row and hands it to the handler", async () => {
    const stored: string[] = [];
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
      handlers: {
        onEditedMessage: (messageId) => {
          stored.push(messageId);
          return Promise.resolve();
        },
      },
    });

    const original = messageUpdate(101, { messageId: 7000, text: "clinic settles at month end" });
    const edit: TelegramUpdate = {
      update_id: 102,
      edited_message: {
        message_id: 7000,
        from: { id: 588068795, first_name: "Priya" },
        date: 1_776_000_000,
        edit_date: 1_776_003_600,
        chat: { id: CHAT_ID, type: "supergroup" },
        text: "clinic settles within 7 days now",
      },
    };
    fake.queue("getUpdates", [original, edit]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.editsStored).toBe(1);
    expect(stored).toHaveLength(1);

    const rows = await harness.db
      .select({
        text: messages.text,
        isEdited: messages.isEdited,
        curatedAt: messages.curatedAt,
      })
      .from(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe("clinic settles within 7 days now");
    expect(rows[0]?.isEdited).toBe(true);
  });

  it("hands a membership event to the handler rather than deciding itself", async () => {
    const events: MembershipEvent[] = [];
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
      handlers: {
        onMembershipEvent: (event) => {
          events.push(event);
          return Promise.resolve();
        },
      },
    });

    fake.queue("getUpdates", [
      {
        update_id: 101,
        chat_member: {
          chat: { id: CHAT_ID },
          from: { id: 1, first_name: "Priya" },
          date: 1_776_000_000,
          old_chat_member: { user: { id: 42, first_name: "Divya" }, status: "member" },
          new_chat_member: { user: { id: 42, first_name: "Divya" }, status: "left" },
        },
      },
    ]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.membershipEvents).toBe(1);
    expect(events[0]).toMatchObject({ telegramUserId: 42, transition: "left" });
  });

  it("creates a person for a sender it has not seen", async () => {
    fake.queue("getUpdates", [messageUpdate(101)]);
    await loop.start();
    await loop.runOnce();

    const rows = await harness.db.select().from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramUserId).toBe(588068795);
  });

  it("keeps one worker_state row however many cycles run", async () => {
    fake.queue("getUpdates", [messageUpdate(101)]);
    fake.queue("getUpdates", [messageUpdate(102)]);
    await loop.start();
    await loop.runOnce();
    await loop.runOnce();

    const rows = await harness.db.select().from(workerState);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
  });
});

describe("direct messages to the bot", () => {
  /**
   * A private message is the only moment Baton learns it can write to someone, and it
   * must never become group knowledge. Both halves are asserted: the chat id is
   * recorded, and no `messages` row appears.
   */
  let harness: TestDatabase;
  let fake: FakeTelegram;
  let loop: IntakeLoop;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    fake = new FakeTelegram();
    fake.queue("getMe", { id: BOT_ID, is_bot: true, first_name: "Baton" });
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
    });
  });

  function privateUpdate(updateId: number, userId = 588068795): TelegramUpdate {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: userId, first_name: "Priya", last_name: "Raghavan" },
        date: 1_776_000_000,
        // A private chat's id is the user's own id, and its type says so.
        chat: { id: userId, type: "private" },
        text: "yes, approve that",
      },
    };
  }

  it("records that Baton can now reach the sender", async () => {
    fake.queueUpdates([privateUpdate(801)]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.privateMessages).toBe(1);
    const rows = await harness.db
      .select({ privateChatId: people.privateChatId, telegramUserId: people.telegramUserId })
      .from(people);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.privateChatId).toBe(588068795);
  });

  it("does not store a private message as group knowledge", async () => {
    // The register holds what the organisation knows. A private remark reaching a brief
    // everyone can read would be a privacy failure, not a bug in ordering.
    fake.queueUpdates([privateUpdate(801)]);
    await loop.start();

    await loop.runOnce();

    await expect(harness.db.select().from(messages)).resolves.toHaveLength(0);
  });

  it("does not count a private message as an ignored foreign chat", async () => {
    fake.queueUpdates([privateUpdate(801)]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.ignored.foreign_chat).toBe(0);
    expect(result.messagesStored).toBe(0);
  });

  it("hands the private message to a handler with the resolved person", async () => {
    const seen: string[] = [];
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
      handlers: {
        onPrivateMessage: (personId) => {
          seen.push(personId);
          return Promise.resolve();
        },
      },
    });
    fake.queueUpdates([privateUpdate(801)]);
    await loop.start();

    await loop.runOnce();

    expect(seen).toHaveLength(1);
    const rows = await harness.db.select({ id: people.id }).from(people);
    expect(seen[0]).toBe(rows[0]?.id);
  });

  it("ignores the bot's own message echoed back in a private chat", async () => {
    fake.queueUpdates([privateUpdate(801, BOT_ID)]);
    await loop.start();

    const result = await loop.runOnce();

    expect(result.privateMessages).toBe(0);
    await expect(harness.db.select().from(people)).resolves.toHaveLength(0);
  });

  it("still advances the offset", async () => {
    fake.queueUpdates([privateUpdate(801)]);
    await loop.start();
    const result = await loop.runOnce();
    expect(result.offsetCommitted).toBe(802);
  });
});

describe("questions directed at Baton", () => {
  let harness: TestDatabase;
  let fake: FakeTelegram;
  let loop: IntakeLoop;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    fake = new FakeTelegram();
    // The username is what makes the @-mention signal available at all.
    fake.queue("getMe", {
      id: BOT_ID,
      is_bot: true,
      first_name: "Baton",
      username: "batonbot",
    });
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
    });
  });

  async function flagOf(text: string): Promise<boolean> {
    fake.queue("getUpdates", [messageUpdate(101, { text })]);
    await loop.start();
    await loop.runOnce();

    const rows = await harness.db
      .select({ isQuestionToBot: messages.isQuestionToBot })
      .from(messages);
    return rows[0]?.isQuestionToBot ?? false;
  }

  it("resolves the bot's handle at startup", async () => {
    await loop.start();
    expect(loop.handle).toBe("batonbot");
  });

  it("flags an @-mention", async () => {
    expect(await flagOf("@batonbot who has the store room key?")).toBe(true);
  });

  it("does not flag a plain question to the group", async () => {
    // The restraint is the design: a bot that answers anything ending in a question mark
    // joins every conversation it is not part of.
    expect(await flagOf("who has the store room key?")).toBe(false);
  });

  it("flags a reply to one of Baton's own messages", async () => {
    fake.queue("getUpdates", [
      {
        update_id: 101,
        message: {
          message_id: 7100,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_100,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "and the spare?",
          reply_to_message: { message_id: 7099, from: { id: BOT_ID, is_bot: true } },
        },
      },
    ]);
    await loop.start();
    const result = await loop.runOnce();

    expect(result.questionsToBot).toBe(1);
    const rows = await harness.db
      .select({ isQuestionToBot: messages.isQuestionToBot })
      .from(messages);
    expect(rows[0]?.isQuestionToBot).toBe(true);
  });

  it("does not flag a reply to another person", async () => {
    fake.queue("getUpdates", [
      {
        update_id: 101,
        message: {
          message_id: 7100,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_100,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "same here",
          reply_to_message: { message_id: 7099, from: { id: 999_111, first_name: "Anil" } },
        },
      },
    ]);
    await loop.start();
    const result = await loop.runOnce();

    expect(result.questionsToBot).toBe(0);
  });

  it("hands the detection to a handler, with the bot message id when it is a reply", async () => {
    const seen: { messageId: string; signal: string; repliedTo: number | null }[] = [];
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
      handlers: {
        onQuestionToBot: (messageId, detection) => {
          seen.push({
            messageId,
            signal: detection.signal,
            repliedTo: detection.repliedToBotMessageId,
          });
          return Promise.resolve();
        },
      },
    });

    fake.queue("getUpdates", [
      {
        update_id: 101,
        message: {
          message_id: 7100,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_100,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "yes go ahead",
          reply_to_message: { message_id: 7099, from: { id: BOT_ID } },
        },
      },
    ]);
    await loop.start();
    await loop.runOnce();

    // The handler exists for exactly this: a reply to an approval request is an *answer*,
    // not a new question, and only the store knows which bot messages were questions.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal).toBe("reply_to_bot");
    expect(seen[0]?.repliedTo).toBe(7099);
  });

  it("re-evaluates the flag when a message is edited", async () => {
    fake.queue("getUpdates", [
      messageUpdate(101, { messageId: 7200, text: "@batonbot who has it?" }),
    ]);
    await loop.start();
    await loop.runOnce();

    let rows = await harness.db
      .select({ isQuestionToBot: messages.isQuestionToBot })
      .from(messages);
    expect(rows[0]?.isQuestionToBot).toBe(true);

    fake.queue("getUpdates", [
      {
        update_id: 102,
        edited_message: {
          message_id: 7200,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_101,
          edit_date: 1_776_000_200,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "never mind, found it",
        },
      },
    ]);
    await loop.runOnce();

    rows = await harness.db.select({ isQuestionToBot: messages.isQuestionToBot }).from(messages);
    // An edit that removes the mention un-addresses the message. Leaving the flag set would
    // make Baton answer a question that no longer exists.
    expect(rows[0]?.isQuestionToBot).toBe(false);
  });

  it("clears a previous answer when the question text changes", async () => {
    fake.queue("getUpdates", [
      messageUpdate(101, { messageId: 7300, text: "@batonbot who has it?" }),
    ]);
    await loop.start();
    await loop.runOnce();
    await harness.db.update(messages).set({ questionAnsweredAt: new Date() });

    fake.queue("getUpdates", [
      {
        update_id: 102,
        edited_message: {
          message_id: 7300,
          from: { id: 588068795, first_name: "Priya" },
          date: 1_776_000_101,
          edit_date: 1_776_000_200,
          chat: { id: CHAT_ID, type: "supergroup" },
          text: "@batonbot who has the spare?",
        },
      },
    ]);
    await loop.runOnce();

    const rows = await harness.db
      .select({ answeredAt: messages.questionAnsweredAt })
      .from(messages);
    // A different question deserves a different answer.
    expect(rows[0]?.answeredAt).toBeNull();
  });

  it("does not flag anything when the bot has no username", async () => {
    fake = new FakeTelegram();
    fake.queue("getMe", { id: BOT_ID, is_bot: true, first_name: "Baton" });
    loop = new IntakeLoop({
      db: harness.db,
      telegram: new TelegramClient({ token: "t", fetchImpl: fake.fetchImpl }),
      chatId: CHAT_ID,
    });
    fake.queue("getUpdates", [messageUpdate(101, { text: "@batonbot who has it?" })]);
    await loop.start();
    const result = await loop.runOnce();

    // Not a silent degradation to guessing: with no handle there is no @-mention signal,
    // and the reply signal still works.
    expect(loop.handle).toBeNull();
    expect(result.questionsToBot).toBe(0);
  });
});
