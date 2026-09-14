/**
 * The respond pass — against real Postgres and a fake agent.
 *
 * The four outcomes are not four degrees of success, and the tests are weighted accordingly:
 * `answer` is the easy one, and the three that matter are the stale warning, the ambiguous
 * holder that routes privately, and the plain unknown that becomes a question. A tool that
 * only speaks when certain is a tool nobody can calibrate.
 *
 * Two assertions are about things *not* happening, and both would be invisible in
 * production:
 *
 *   - **A withheld answer sends nothing.** Asserted on the Telegram call log, because
 *     "Restraint decided to withhold" and "Restraint withheld and the worker sent it anyway"
 *     look identical in the quiet-decisions strip.
 *   - **`question_answered_at` is stamped only after the reply is sent.** A crash before the
 *     send has to leave the question retryable; stamping first drops it silently, and the
 *     person who asked simply assumes Baton had nothing to say.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { STALE_FACT_THRESHOLD_DAYS, contentHash, type NormalisedMessage } from "@baton/core";
import { persistMessage, selectUnansweredQuestions } from "../src/store/messages.js";
import { countQueuedQuestions, selectWaitingOn } from "../src/store/questions.js";
import { countQuietDecisions } from "../src/store/quiet-decisions.js";
import { findRun } from "../src/store/runs.js";
import { hydrateRespondContext } from "../src/pipeline/hydrate.js";
import { resolveTarget, runRespondPass } from "../src/pipeline/respond.js";
import { OutboundQueue } from "../src/telegram/outbound-queue.js";
import { TelegramClient } from "../src/telegram/client.js";
import { FakeTelegram } from "./helpers/fake-telegram.js";
import { FakeRespondent, reply, type RespondResponder } from "./helpers/fake-agent.js";

const { appSettings, assets, facts, holdings, messages, people } = schema;
const CHAT_ID = -1001234567890;
const NOW = new Date("2026-06-01T10:00:00Z");

describe("responding to a question", () => {
  let harness: TestDatabase;
  let coordinator: string;
  let meera: string;
  let nextTelegramId = 1;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();
    nextTelegramId = 1;

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

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function storeMessage(
    text: string,
    options: { isQuestionToBot?: boolean; sentAt?: string } = {},
  ): Promise<{ id: string; telegramMessageId: number }> {
    const telegramMessageId = nextTelegramId++;
    const normalised: NormalisedMessage = {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId,
      senderTelegramUserId: 5001,
      senderDisplayName: "Priya Raghavan",
      sentAt: new Date(options.sentAt ?? "2026-06-01T09:00:00Z"),
      text,
      contentHash: contentHash(`${text}#${telegramMessageId}`),
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedAt: null,
      isUnprocessed: false,
      mediaKind: null,
    };
    const persisted = await persistMessage(harness.db, normalised, {
      isQuestionToBot: options.isQuestionToBot ?? true,
    });
    return { id: persisted.id, telegramMessageId };
  }

  /** An active fact with a holder, so the fact index has something in it. */
  async function heldFact(claim: string, lastConfirmedAt: string): Promise<string> {
    const assetRows = await harness.db
      .insert(assets)
      .values({ kind: "physical_item", name: "store room key", normalisedKey: "store room key" })
      .returning({ id: assets.id });
    const source = await storeMessage(claim, { isQuestionToBot: false });

    const factRows = await harness.db
      .insert(facts)
      .values({
        assetId: assetRows[0]?.id as string,
        claim,
        matchKey: `k:${claim}`,
        confidence: 0.9,
        status: "active",
        sourceMessageId: source.id,
        statedAt: new Date(lastConfirmedAt),
        lastConfirmedAt: new Date(lastConfirmedAt),
        evidenceMessageIds: [source.id],
      })
      .returning({ id: facts.id });

    await harness.db.insert(holdings).values({
      assetId: assetRows[0]?.id as string,
      holderPersonId: meera,
      status: "active",
      acquiredAt: new Date(lastConfirmedAt),
      evidenceFactId: factRows[0]?.id as string,
    });
    return factRows[0]?.id as string;
  }

  function harnessFor(responder: RespondResponder) {
    const telegram = new FakeTelegram();
    const queue = new OutboundQueue({
      telegram: new TelegramClient({ token: "test-token", fetchImpl: telegram.fetchImpl }),
      sleep: () => Promise.resolve(),
      now: () => NOW.getTime(),
    });
    const transport = new FakeRespondent(responder);
    return {
      telegram,
      queue,
      transport,
      run: () => runRespondPass({ db: harness.db, transport, queue, now: () => NOW }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe("selecting what to answer", () => {
    it("finds only messages flagged as questions to Baton", async () => {
      const question = await storeMessage("@batonbot who has the key?");
      await storeMessage("just chatting", { isQuestionToBot: false });

      const pending = await selectUnansweredQuestions(harness.db);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(question.id);
      expect(pending[0]?.telegramMessageId).toBe(question.telegramMessageId);
    });

    it("answers the oldest first", async () => {
      await storeMessage("second", { sentAt: "2026-06-01T09:30:00Z" });
      await storeMessage("first", { sentAt: "2026-06-01T08:00:00Z" });

      const pending = await selectUnansweredQuestions(harness.db);
      // Answering the newest first is how a backlog after a restart reads as though Baton
      // had ignored everyone but the last person to speak.
      expect(pending.map((entry) => entry.text)).toEqual(["first", "second"]);
    });

    it("skips a withdrawn question", async () => {
      await storeMessage("@batonbot something regrettable");
      await harness.db.update(messages).set({ isWithdrawn: true, withdrawnAt: NOW });

      // Withdrawal is the coordinator's only remedy; answering would quote it back.
      expect(await selectUnansweredQuestions(harness.db)).toHaveLength(0);
    });

    it("does nothing at all when nothing is waiting", async () => {
      const { transport, run } = harnessFor(() => reply("answer"));
      const result = await run();

      expect(result.pending).toBe(0);
      expect(transport.requests).toHaveLength(0);
      // No run row either: a pass that had nothing to do is not an event.
      expect(result.runId).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the four outcomes", () => {
    it("sends an answer to the group, threaded to the question", async () => {
      const question = await storeMessage("@batonbot who has the store room key?");
      const { telegram, run } = harnessFor(() => reply("answer"));
      telegram.queue("sendMessage", { message_id: 500, chat: { id: CHAT_ID } });

      const result = await run();

      expect(result.answered[0]).toMatchObject({
        outcome: "answer",
        replied: true,
        withheld: false,
        target: "group",
      });
      const sent = telegram.callsTo("sendMessage")[0];
      expect(sent?.payload.chat_id).toBe(CHAT_ID);
      // Threaded to the question itself, not to whatever the question replied to.
      expect(sent?.payload.reply_parameters).toEqual({ message_id: question.telegramMessageId });
    });

    it("sends a stale answer the same way, carrying its age", async () => {
      await storeMessage("@batonbot how much do we pay the clinic?");
      const { telegram, transport, run } = harnessFor(() =>
        reply("stale_answer", {
          answerText: "₹1,200, last confirmed five months ago.",
          ageDays: 150,
        }),
      );
      telegram.queue("sendMessage", { message_id: 501, chat: { id: CHAT_ID } });

      const result = await run();

      expect(result.answered[0]?.outcome).toBe("stale_answer");
      expect(telegram.callsTo("sendMessage")[0]?.payload.text).toContain("five months ago");
      // The threshold is the worker's, passed in rather than assumed by the prompt.
      expect(transport.requests[0]?.context.staleThresholdDays).toBe(STALE_FACT_THRESHOLD_DAYS);
    });

    it("routes an ambiguous holder privately even when the model said group", async () => {
      await storeMessage("@batonbot who has the bank login?");
      const { telegram, run } = harnessFor(() =>
        reply("ambiguous_holder", {
          answerText: "Two people are recorded as holding this and I cannot tell which.",
          // The model proposes the group; the worker overrides.
          target: "group",
          candidateHolderPersonIds: [meera, coordinator],
        }),
      );
      telegram.queue("sendMessage", { message_id: 502, chat: { id: 5001 } });

      const result = await run();

      expect(result.answered[0]?.target).toBe("coordinator");
      // Naming two people in front of twenty in connection with something neither may hold
      // is worse than silence, and no correction afterwards unsays it.
      expect(telegram.callsTo("sendMessage")[0]?.payload.chat_id).toBe(5001);
    });

    it("says nothing for an unknown but records it as handled", async () => {
      await storeMessage("@batonbot who runs the newsletter?");
      const { telegram, run } = harnessFor(() => reply("unknown"));

      const result = await run();

      expect(result.answered[0]?.outcome).toBe("unknown");
      expect(result.answered[0]?.replied).toBe(false);
      expect(telegram.callsTo("sendMessage")).toHaveLength(0);

      // Marked handled anyway, or every later pass would retry it forever.
      const rows = await harness.db
        .select({ answeredAt: messages.questionAnsweredAt })
        .from(messages);
      expect(rows[0]?.answeredAt).not.toBeNull();
    });

    it("turns an unknown's follow-up into a queued question", async () => {
      await storeMessage("@batonbot who runs the newsletter?");
      const { run } = harnessFor(() =>
        reply("unknown", { followUpQuestion: "Does anyone know who runs the newsletter?" }),
      );

      const result = await run();

      expect(result.answered[0]?.followUpQuestionId).not.toBeNull();
      // Queued, not sent: the budget decides when, and `runAskPass` is the one path that
      // sends, so the cap cannot be bypassed by a new caller.
      expect(await countQueuedQuestions(harness.db)).toBe(1);
      const waiting = await selectWaitingOn(harness.db);
      expect(waiting[0]?.askedText).toBe("Does anyone know who runs the newsletter?");
      expect(waiting[0]?.status).toBe("queued");
    });

    it("does not queue a follow-up when the ask budget is full", async () => {
      await storeMessage("@batonbot who runs the newsletter?");
      // Two open asks: the budget is exhausted.
      await harness.db.insert(schema.questions).values([
        { kind: "verification", target: "group", askedText: "A", status: "asked", askedAt: NOW },
        { kind: "verification", target: "group", askedText: "B", status: "asked", askedAt: NOW },
      ]);

      const { transport, run } = harnessFor(() => reply("unknown"));
      const result = await run();

      expect(transport.requests[0]?.context.askBudgetAvailable).toBe(false);
      expect(result.answered[0]?.followUpQuestionId).toBeNull();
      expect(await countQueuedQuestions(harness.db)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("Restraint withholding", () => {
    it("sends nothing and records the quiet decision", async () => {
      await storeMessage("@batonbot who has the store room key?");
      const { telegram, run } = harnessFor(() =>
        reply(
          "answer",
          {},
          {
            withheld: true,
            quietDecisions: [
              {
                scope: "answer",
                withheld: "An answer about the store room key",
                reason: "The group is already discussing it.",
                findingDedupeKey: null,
              },
            ],
          },
        ),
      );

      const result = await run();

      // The only falsifiable form of the claim: "withheld" and "withheld but sent anyway"
      // look identical in the strip.
      expect(telegram.callsTo("sendMessage")).toHaveLength(0);
      expect(result.answered[0]?.withheld).toBe(true);
      expect(result.answered[0]?.replied).toBe(false);
      expect(result.quietDecisions).toBe(1);
      // Recorded under the `answer` scope, which is how a test proves the veto has not
      // narrowed to findings.
      expect(await countQuietDecisions(harness.db, "answer")).toBe(1);
      expect(await countQuietDecisions(harness.db, "finding")).toBe(0);
    });

    it("marks a withheld question as handled, so it is not re-judged forever", async () => {
      await storeMessage("@batonbot who has the store room key?");
      const { run } = harnessFor(() => reply("answer", {}, { withheld: true }));
      await run();

      expect(await selectUnansweredQuestions(harness.db)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("idempotence and failure", () => {
    it("does not answer the same question twice", async () => {
      await storeMessage("@batonbot who has the store room key?");
      const first = harnessFor(() => reply("answer"));
      first.telegram.queue("sendMessage", { message_id: 600, chat: { id: CHAT_ID } });
      await first.run();

      const second = harnessFor(() => reply("answer"));
      const result = await second.run();

      expect(result.pending).toBe(0);
      expect(second.transport.requests).toHaveLength(0);
      expect(second.telegram.callsTo("sendMessage")).toHaveLength(0);
    });

    it("leaves the question unanswered when the send fails", async () => {
      await storeMessage("@batonbot who has the store room key?");
      const { telegram, run } = harnessFor(() => reply("answer"));
      telegram.failWith = { description: "Bad Request: chat not found", errorCode: 400 };

      const result = await run();

      expect(result.answered[0]?.replied).toBe(false);
      // Retryable. Stamping first would drop the question silently, and unlike a missed
      // curation nobody would ever find out.
      expect(await selectUnansweredQuestions(harness.db)).toHaveLength(1);
    });

    it("records a failed run and rethrows when the agent errors", async () => {
      await storeMessage("@batonbot who has the store room key?");
      const exploding = new FakeRespondent(() => {
        throw new Error("the model refused");
      });
      const telegram = new FakeTelegram();
      const queue = new OutboundQueue({
        telegram: new TelegramClient({ token: "t", fetchImpl: telegram.fetchImpl }),
        sleep: () => Promise.resolve(),
        now: () => NOW.getTime(),
      });

      await expect(
        runRespondPass({ db: harness.db, transport: exploding, queue, now: () => NOW }),
      ).rejects.toThrow(/the model refused/);

      const runs = await harness.db.select({ id: schema.runs.id }).from(schema.runs);
      const run = await findRun(harness.db, runs[0]?.id as string);
      expect(run?.kind).toBe("respond");
      expect(run?.status).toBe("failed");
      expect(run?.error).toMatch(/the model refused/);
      expect(await selectUnansweredQuestions(harness.db)).toHaveLength(1);
    });

    it("answers several questions in one pass, hydrating the context once", async () => {
      await storeMessage("@batonbot first?", { sentAt: "2026-06-01T08:00:00Z" });
      await storeMessage("@batonbot second?", { sentAt: "2026-06-01T08:30:00Z" });
      const { telegram, transport, run } = harnessFor(() => reply("answer"));
      telegram.queue("sendMessage", { message_id: 1, chat: { id: CHAT_ID } });
      telegram.queue("sendMessage", { message_id: 2, chat: { id: CHAT_ID } });

      const result = await run();

      expect(result.answered).toHaveLength(2);
      expect(transport.requests).toHaveLength(2);
      // Same context object both times: the fact index is identical for every question in
      // the pass, and re-reading it per question would be the dominant cost of a path whose
      // whole point is to be quick.
      expect(transport.requests[0]?.context).toBe(transport.requests[1]?.context);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the respond context", () => {
    it("carries the fact index with ages the worker computed", async () => {
      await heldFact("The store room key is with Meera", "2026-01-02T10:00:00Z");

      const context = await hydrateRespondContext(harness.db, NOW);

      expect(Object.keys(context).sort()).toEqual([
        "aliases",
        "askBudgetAvailable",
        "factIndex",
        "org",
        "staleThresholdDays",
      ]);
      expect(context.factIndex).toHaveLength(1);
      // 2026-01-02 to 2026-06-01 is 150 days. A number a model invented would be
      // unfalsifiable, and it is the load-bearing part of a stale answer.
      expect(context.factIndex[0]?.ageDays).toBe(150);
      expect(context.factIndex[0]?.holderPersonId).toBe(meera);
      expect(context.factIndex[0]?.holderDisplayName).toBe("Meera Sundaram");
      expect(context.factIndex[0]?.assetName).toBe("store room key");
    });

    it("keeps a pending claim out of the fact index", async () => {
      const factId = await heldFact("Meera has the bank login", "2026-05-01T10:00:00Z");
      await harness.db
        .update(facts)
        .set({ status: "pending_approval" })
        .where(eq(facts.id, factId));

      const context = await hydrateRespondContext(harness.db, NOW);
      // The same promise as findings, enforced by a different route — and one nobody would
      // think to check.
      expect(context.factIndex).toHaveLength(0);
    });

    it("keeps hearsay out of the fact index", async () => {
      const factId = await heldFact("Someone said Meera has the key", "2026-05-01T10:00:00Z");
      await harness.db.update(facts).set({ status: "unverified" }).where(eq(facts.id, factId));

      expect((await hydrateRespondContext(harness.db, NOW)).factIndex).toHaveLength(0);
    });

    it("reports the ask budget as a boolean the worker counted", async () => {
      expect((await hydrateRespondContext(harness.db, NOW)).askBudgetAvailable).toBe(true);

      await harness.db.insert(schema.questions).values([
        { kind: "verification", target: "group", askedText: "A", status: "asked", askedAt: NOW },
        { kind: "verification", target: "group", askedText: "B", status: "asked", askedAt: NOW },
      ]);
      // A prompt cannot remember what it already asked; a count can.
      expect((await hydrateRespondContext(harness.db, NOW)).askBudgetAvailable).toBe(false);
    });

    it("sends the asker's name as the group refers to them", async () => {
      await storeMessage("@batonbot who has the key?");
      const { telegram, transport, run } = harnessFor(() => reply("answer"));
      telegram.queue("sendMessage", { message_id: 1, chat: { id: CHAT_ID } });
      await run();

      expect(transport.requests[0]?.payload.askedByMention).toBe("Priya Raghavan");
      expect(transport.requests[0]?.payload.askedByPersonId).toBe(coordinator);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("resolveTarget", () => {
    it("always routes an ambiguous holder to the coordinator", () => {
      expect(resolveTarget(reply("ambiguous_holder", { target: "group" }))).toBe("coordinator");
    });

    it("honours the model's target otherwise", () => {
      expect(resolveTarget(reply("answer", { target: "group" }))).toBe("group");
      expect(resolveTarget(reply("answer", { target: "coordinator" }))).toBe("coordinator");
    });
  });
});
