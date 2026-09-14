/**
 * The ask budget — against real Postgres.
 *
 * Four assertions the design names explicitly, and they are the four this file is built
 * around:
 *
 *   1. A third simultaneous ask queues rather than sending.
 *   2. A fourth ask in twenty-four hours queues.
 *   3. An approval raised while the budget is full of verifications is asked before them.
 *   4. A queued ask is neither dropped nor duplicated.
 *
 * All four are deterministic SQL assertions, which is the point: a limit a model is merely
 * told about is a limit that holds until the week it matters. The counting is
 * `status = 'asked' and answer_text is null` and `asked_at > now() - 24 hours`, and neither
 * is a judgment.
 *
 * The fifth assertion is the subtle one and has no line in the design: **`asked_at` is
 * stamped only after the send succeeded.** A failed send that consumed budget throttles
 * Baton to nothing while the register fills with questions nobody was asked.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { ASK_BUDGET } from "@baton/core";
import {
  askBudgetStatus,
  countQueuedQuestions,
  findAskedQuestionByBotMessageId,
  findMostRecentAskedQuestion,
  markQuestionAsked,
  markQuestionObsolete,
  queueQuestion,
  resolveQuestion,
  selectAskableQuestions,
  selectWaitingOn,
  type QueueQuestionInput,
} from "../src/store/questions.js";
import { runAskPass } from "../src/pipeline/ask.js";
import { OutboundQueue } from "../src/telegram/outbound-queue.js";
import { TelegramClient } from "../src/telegram/client.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";

const { appSettings, people, questions } = schema;
const CHAT_ID = -1001234567890;
const NOW = new Date("2026-06-01T10:00:00Z");

describe("the ask budget", () => {
  let harness: TestDatabase;
  let coordinator: string;
  let meera: string;
  let nextMessageId = 900;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    nextMessageId = 900;

    const inserted = await harness.db
      .insert(people)
      .values([
        {
          displayName: "Priya Raghavan",
          status: "member",
          telegramUserId: 5001,
          privateChatId: 5001,
        },
        { displayName: "Meera Sundaram", status: "member" },
      ])
      .returning({ id: people.id, displayName: people.displayName });
    coordinator = inserted.find((row) => row.displayName === "Priya Raghavan")?.id ?? "";
    meera = inserted.find((row) => row.displayName === "Meera Sundaram")?.id ?? "";

    await harness.db.insert(appSettings).values({
      id: 1,
      chatId: CHAT_ID,
      orgName: "Kolam Collective",
      timezone: "Asia/Kolkata",
      coordinatorPersonId: coordinator,
    });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  function question(overrides: Partial<QueueQuestionInput> = {}): QueueQuestionInput {
    return {
      kind: "verification",
      target: "group",
      askedText: "Is the store room key still with the same person?",
      ...overrides,
    };
  }

  /** A queued question already stamped as asked, at a given instant. */
  async function alreadyAsked(overrides: Partial<QueueQuestionInput>, at: Date): Promise<string> {
    const { questionId } = await queueQuestion(harness.db, question(overrides));
    await markQuestionAsked(harness.db, questionId, {
      botTelegramMessageId: nextMessageId++,
      at,
    });
    return questionId;
  }

  /** A real queue over a fake Telegram, so the send seam is genuinely exercised. */
  function outbound() {
    const telegram = new FakeTelegram();
    const queue = new OutboundQueue({
      telegram: new TelegramClient({ token: "test-token", fetchImpl: telegram.fetchImpl }),
      sleep: () => Promise.resolve(),
      now: () => NOW.getTime(),
    });
    return { telegram, queue };
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe("counting", () => {
    it("offers the full budget on an empty register", async () => {
      const budget = await askBudgetStatus(harness.db, NOW);

      expect(budget.openCount).toBe(0);
      expect(budget.windowCount).toBe(0);
      expect(budget.slots).toBe(Math.min(ASK_BUDGET.maxOpen, ASK_BUDGET.maxPerRollingWindow));
      expect(budget.available).toBe(true);
    });

    it("does not count a queued question as open", async () => {
      await queueQuestion(harness.db, question());
      await queueQuestion(harness.db, question({ askedText: "And the projector?" }));

      const budget = await askBudgetStatus(harness.db, NOW);
      // A queued ask was never sent, so nobody is waiting on it. Counting it would let a
      // full queue block itself forever.
      expect(budget.openCount).toBe(0);
      expect(budget.windowCount).toBe(0);
      expect(budget.available).toBe(true);
    });

    it("counts an answered question against the window but not against open", async () => {
      const id = await alreadyAsked({}, new Date("2026-06-01T08:00:00Z"));
      await resolveQuestion(harness.db, id, {
        answerText: "Yes, still Meera.",
        answeredByPersonId: meera,
        resolution: "answered",
        at: new Date("2026-06-01T09:00:00Z"),
      });

      const budget = await askBudgetStatus(harness.db, NOW);
      // The window measures how much Baton has said in a day, not how much is outstanding.
      // A burst of quickly-answered questions must not reset the cap.
      expect(budget.openCount).toBe(0);
      expect(budget.windowCount).toBe(1);
    });

    it("lets a question asked outside the window fall out of it", async () => {
      const outside = new Date(NOW.getTime() - (ASK_BUDGET.rollingWindowHours + 1) * 3_600_000);
      await alreadyAsked({}, outside);

      const budget = await askBudgetStatus(harness.db, NOW);
      expect(budget.windowCount).toBe(0);
      // Still open, though: it was asked and never answered.
      expect(budget.openCount).toBe(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the two caps", () => {
    it("queues a third simultaneous ask rather than sending it", async () => {
      for (let index = 0; index < ASK_BUDGET.maxOpen; index += 1) {
        await alreadyAsked({ askedText: `Open question ${index}` }, NOW);
      }
      await queueQuestion(harness.db, question({ askedText: "The third one" }));

      const budget = await askBudgetStatus(harness.db, NOW);
      expect(budget.openCount).toBe(ASK_BUDGET.maxOpen);
      expect(budget.slots).toBe(0);
      expect(budget.reason).toMatch(/Already waiting on/);

      const { telegram, queue } = outbound();
      const result = await runAskPass({
        db: harness.db,
        queue,
        chatId: CHAT_ID,
        now: () => NOW,
      });

      expect(result.slots).toBe(0);
      expect(result.asked).toHaveLength(0);
      expect(telegram.callsTo("sendMessage")).toHaveLength(0);
      // Stored, not dropped.
      expect(await countQueuedQuestions(harness.db)).toBe(1);
    });

    it("queues a fourth ask within twenty-four hours", async () => {
      // Three asked and all answered, so the open cap is clear and only the window bites.
      for (let index = 0; index < ASK_BUDGET.maxPerRollingWindow; index += 1) {
        const id = await alreadyAsked(
          { askedText: `Window question ${index}` },
          new Date(NOW.getTime() - (index + 1) * 3_600_000),
        );
        await resolveQuestion(harness.db, id, {
          answerText: "Answered.",
          answeredByPersonId: meera,
          resolution: "answered",
          at: NOW,
        });
      }

      const budget = await askBudgetStatus(harness.db, NOW);
      expect(budget.openCount).toBe(0);
      expect(budget.windowCount).toBe(ASK_BUDGET.maxPerRollingWindow);
      expect(budget.slots).toBe(0);
      expect(budget.reason).toMatch(/in the last 24 hours/);

      await queueQuestion(harness.db, question({ askedText: "The fourth one" }));
      expect(await selectAskableQuestions(harness.db, NOW)).toHaveLength(0);
      expect(await countQueuedQuestions(harness.db)).toBe(1);
    });

    it("takes the tighter of the two caps", async () => {
      // One open, one already answered inside the window: open allows one more, the window
      // allows one more. Both agree here, which is the boring case worth pinning.
      await alreadyAsked({ askedText: "Still open" }, NOW);
      const answered = await alreadyAsked({ askedText: "Since answered" }, NOW);
      await resolveQuestion(harness.db, answered, {
        answerText: "Yes.",
        answeredByPersonId: meera,
        resolution: "answered",
        at: NOW,
      });

      const budget = await askBudgetStatus(harness.db, NOW);
      expect(budget.openCount).toBe(1);
      expect(budget.windowCount).toBe(2);
      expect(budget.slots).toBe(
        Math.min(ASK_BUDGET.maxOpen - 1, ASK_BUDGET.maxPerRollingWindow - 2),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("priority", () => {
    it("asks an approval before the verifications it arrived behind", async () => {
      await queueQuestion(harness.db, question({ kind: "verification", askedText: "Verify A" }));
      await queueQuestion(harness.db, question({ kind: "verification", askedText: "Verify B" }));
      await queueQuestion(
        harness.db,
        question({ kind: "clarification", askedText: "Which Priya?" }),
      );
      await queueQuestion(
        harness.db,
        question({ kind: "approval", askedText: "May I record this?" }),
      );

      const askable = await selectAskableQuestions(harness.db, NOW);

      // Priority derives from kind and is never stored. Without the ordering, the one ask
      // that must not be delayed is exactly the one a stale-figure check displaces.
      expect(askable[0]?.kind).toBe("approval");
      expect(askable[1]?.kind).toBe("clarification");
      expect(askable).toHaveLength(2);
    });

    it("orders equal priorities oldest first", async () => {
      await queueQuestion(harness.db, question({ askedText: "First asked for" }));
      await queueQuestion(harness.db, question({ askedText: "Second asked for" }));

      const askable = await selectAskableQuestions(harness.db, NOW);
      expect(askable.map((entry) => entry.askedText)).toEqual([
        "First asked for",
        "Second asked for",
      ]);
    });

    it("does not let an approval displace something already sent", async () => {
      const open = await alreadyAsked({ kind: "verification", askedText: "Verify A" }, NOW);
      await queueQuestion(
        harness.db,
        question({ kind: "approval", askedText: "May I record this?" }),
      );

      const askable = await selectAskableQuestions(harness.db, NOW);
      // One slot left, and the approval takes it. The sent verification stays sent — an
      // ask cannot be unasked.
      expect(askable).toHaveLength(1);
      expect(askable[0]?.kind).toBe("approval");

      const rows = await harness.db
        .select({ status: questions.status })
        .from(questions)
        .where(eq(questions.id, open));
      expect(rows[0]?.status).toBe("asked");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("nothing dropped, nothing asked twice", () => {
    it("returns the existing row for an identical unresolved ask", async () => {
      const first = await queueQuestion(harness.db, question());
      const second = await queueQuestion(harness.db, question());

      expect(second.created).toBe(false);
      expect(second.questionId).toBe(first.questionId);
      expect(await harness.db.select({ id: questions.id }).from(questions)).toHaveLength(1);
    });

    it("suppresses a duplicate of something already asked, not just of something queued", async () => {
      await alreadyAsked({}, NOW);
      const again = await queueQuestion(harness.db, question());

      expect(again.created).toBe(false);
      expect(await harness.db.select({ id: questions.id }).from(questions)).toHaveLength(1);
    });

    it("allows the same text again once the first was resolved", async () => {
      const id = await alreadyAsked({}, NOW);
      await resolveQuestion(harness.db, id, {
        answerText: "Yes.",
        answeredByPersonId: meera,
        resolution: "answered",
        at: NOW,
      });

      const again = await queueQuestion(harness.db, question());
      // A settled question is history. Asking again months later is a legitimate act, and
      // refusing forever would make the register unable to re-check anything.
      expect(again.created).toBe(true);
    });

    it("stamps asked_at exactly once", async () => {
      const { questionId } = await queueQuestion(harness.db, question());

      expect(
        await markQuestionAsked(harness.db, questionId, { botTelegramMessageId: 1, at: NOW }),
      ).toBe(true);
      // A retried send must not consume a second slot of budget for one sentence.
      expect(
        await markQuestionAsked(harness.db, questionId, { botTelegramMessageId: 2, at: NOW }),
      ).toBe(false);

      const budget = await askBudgetStatus(harness.db, NOW);
      expect(budget.windowCount).toBe(1);
    });

    it("refuses to answer a question that was never sent", async () => {
      const { questionId } = await queueQuestion(harness.db, question());

      const resolved = await resolveQuestion(harness.db, questionId, {
        answerText: "Sure.",
        answeredByPersonId: meera,
        resolution: "answered",
        at: NOW,
      });
      // An answer to a question nobody heard would let a reply about something else resolve
      // a pending ask by coincidence.
      expect(resolved).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("asking", () => {
    it("sends to the group and records the bot's own message id", async () => {
      await queueQuestion(harness.db, question({ askedText: "Who has the store room key?" }));
      const { telegram, queue } = outbound();
      telegram.queue("sendMessage", { message_id: 4242, chat: { id: CHAT_ID } });

      const result = await runAskPass({ db: harness.db, queue, chatId: CHAT_ID, now: () => NOW });

      expect(result.asked).toHaveLength(1);
      expect(result.asked[0]?.outcome).toBe("sent");

      const rows = await harness.db
        .select({
          status: questions.status,
          askedAt: questions.askedAt,
          botMessageId: questions.botTelegramMessageId,
        })
        .from(questions);
      expect(rows[0]?.status).toBe("asked");
      expect(rows[0]?.askedAt?.toISOString()).toBe(NOW.toISOString());
      // So a Telegram reply can be matched back to this exact question rather than guessed
      // at from timing.
      expect(rows[0]?.botMessageId).toBe(4242);
    });

    it("routes a coordinator-targeted question privately", async () => {
      await queueQuestion(
        harness.db,
        question({ target: "coordinator", askedText: "Who controls the bank account now?" }),
      );
      const { telegram, queue } = outbound();
      telegram.queue("sendMessage", { message_id: 77, chat: { id: 5001 } });

      const result = await runAskPass({ db: harness.db, queue, chatId: CHAT_ID, now: () => NOW });

      expect(result.asked[0]?.outcome).toBe("sent");
      const sent = telegram.callsTo("sendMessage")[0];
      // Not in front of twenty people.
      expect(sent?.payload.chat_id).toBe(5001);
    });

    it("leaves a question queued when it cannot be delivered", async () => {
      await queueQuestion(
        harness.db,
        question({ target: "coordinator", targetPersonId: meera, askedText: "A private ask" }),
      );
      const { telegram, queue } = outbound();

      const result = await runAskPass({ db: harness.db, queue, chatId: CHAT_ID, now: () => NOW });

      // Meera has never written to the bot, so there is no chat to write into.
      expect(telegram.callsTo("sendMessage")).toHaveLength(0);
      expect(result.asked[0]?.outcome).toBe("undeliverable");
      expect(result.asked[0]?.text).toBe("A private ask");

      const rows = await harness.db
        .select({ status: questions.status, askedAt: questions.askedAt })
        .from(questions);
      // Consumed no budget, because nobody read it — and it goes out the moment delivery
      // becomes possible.
      expect(rows[0]?.status).toBe("queued");
      expect(rows[0]?.askedAt).toBeNull();
      expect((await askBudgetStatus(harness.db, NOW)).windowCount).toBe(0);
    });

    it("does not spend budget on a send Telegram rejected", async () => {
      await queueQuestion(harness.db, question({ askedText: "Who has the store room key?" }));
      const { telegram, queue } = outbound();
      telegram.failWith = { description: "Bad Request: chat not found", errorCode: 400 };

      const result = await runAskPass({ db: harness.db, queue, chatId: CHAT_ID, now: () => NOW });

      expect(result.asked[0]?.outcome).toBe("undeliverable");
      const budget = await askBudgetStatus(harness.db, NOW);
      // The failure this ordering exists to prevent: on a day when sends are failing, a
      // pre-stamped asked_at would throttle Baton to nothing while the register filled with
      // questions nobody was asked.
      expect(budget.windowCount).toBe(0);
      expect(budget.slots).toBeGreaterThan(0);
    });

    it("sends only as many as the budget allows, best first", async () => {
      await alreadyAsked({ askedText: "Already open" }, NOW);
      await queueQuestion(
        harness.db,
        question({ kind: "verification", askedText: "Verify later" }),
      );
      await queueQuestion(harness.db, question({ kind: "approval", askedText: "Approve first" }));

      const { telegram, queue } = outbound();
      telegram.queue("sendMessage", { message_id: 1, chat: { id: CHAT_ID } });

      const result = await runAskPass({ db: harness.db, queue, chatId: CHAT_ID, now: () => NOW });

      expect(telegram.callsTo("sendMessage")).toHaveLength(1);
      expect(telegram.callsTo("sendMessage")[0]?.payload.text).toBe("Approve first");
      expect(result.stillQueued).toBe(0);
      expect(await countQueuedQuestions(harness.db)).toBe(1);
    });

    it("reads the chat id from settings when none is given", async () => {
      await queueQuestion(harness.db, question());
      const { telegram, queue } = outbound();
      telegram.queue("sendMessage", { message_id: 9, chat: { id: CHAT_ID } });

      await runAskPass({ db: harness.db, queue, now: () => NOW });

      expect(telegram.callsTo("sendMessage")[0]?.payload.chat_id).toBe(CHAT_ID);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("what the coordinator is waiting on", () => {
    it("renders queued and asked together", async () => {
      await alreadyAsked({ kind: "verification", askedText: "Sent already" }, NOW);
      await queueQuestion(
        harness.db,
        question({ kind: "approval", askedText: "Waiting for a slot" }),
      );

      const waiting = await selectWaitingOn(harness.db);

      // Both mean the same thing to a coordinator: Baton is holding something back pending
      // an answer. Splitting them would invite "why is that one different", whose answer is
      // an implementation detail.
      expect(waiting).toHaveLength(2);
      expect(waiting[0]?.status).toBe("queued");
      expect(waiting[0]?.kind).toBe("approval");
      expect(waiting[1]?.status).toBe("asked");
    });

    it("drops a resolved question out of the list", async () => {
      const id = await alreadyAsked({}, NOW);
      await resolveQuestion(harness.db, id, {
        answerText: "Yes.",
        answeredByPersonId: meera,
        resolution: "answered",
        at: NOW,
      });

      expect(await selectWaitingOn(harness.db)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("obsolete", () => {
    it("retires a question whose subject has moved on, without refunding budget", async () => {
      await alreadyAsked({ askedText: "Is the figure still 1200?" }, NOW);
      const rows = await harness.db.select({ id: questions.id }).from(questions);

      expect(
        await markQuestionObsolete(
          harness.db,
          rows[0]?.id as string,
          "The claim was superseded.",
          NOW,
        ),
      ).toBe(true);

      const budget = await askBudgetStatus(harness.db, NOW);
      // No longer open, but it still counts against the window: the reader did read it.
      expect(budget.openCount).toBe(0);
      expect(budget.windowCount).toBe(1);
      expect(await selectWaitingOn(harness.db)).toHaveLength(0);
    });

    it("can retire something that was never asked", async () => {
      const { questionId } = await queueQuestion(harness.db, question());
      expect(await markQuestionObsolete(harness.db, questionId, "No longer relevant.", NOW)).toBe(
        true,
      );
      expect(await countQueuedQuestions(harness.db)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("matching a reply back to its question", () => {
    it("matches on the bot's own message id", async () => {
      const { questionId } = await queueQuestion(harness.db, question());
      await markQuestionAsked(harness.db, questionId, { botTelegramMessageId: 555, at: NOW });

      const found = await findAskedQuestionByBotMessageId(harness.db, 555);
      expect(found?.id).toBe(questionId);
    });

    it("does not match an already-answered question", async () => {
      const { questionId } = await queueQuestion(harness.db, question());
      await markQuestionAsked(harness.db, questionId, { botTelegramMessageId: 555, at: NOW });
      await resolveQuestion(harness.db, questionId, {
        answerText: "Yes.",
        answeredByPersonId: meera,
        resolution: "answered",
        at: NOW,
      });

      expect(await findAskedQuestionByBotMessageId(harness.db, 555)).toBeNull();
    });

    it("falls back to the single open question inside a window", async () => {
      const id = await alreadyAsked({}, new Date(NOW.getTime() - 3_600_000));
      const found = await findMostRecentAskedQuestion(harness.db, NOW, 6);
      expect(found?.id).toBe(id);
    });

    it("refuses to guess when two questions are open", async () => {
      await alreadyAsked({ askedText: "Question one" }, new Date(NOW.getTime() - 7_200_000));
      await alreadyAsked({ askedText: "Question two" }, new Date(NOW.getTime() - 3_600_000));

      // Picking the newer one would be a coin flip dressed as a resolution, and for an
      // approval that means applying a change nobody approved.
      expect(await findMostRecentAskedQuestion(harness.db, NOW, 6)).toBeNull();
    });

    it("refuses a question asked before the window", async () => {
      await alreadyAsked({}, new Date(NOW.getTime() - 48 * 3_600_000));
      expect(await findMostRecentAskedQuestion(harness.db, NOW, 6)).toBeNull();
    });
  });
});
