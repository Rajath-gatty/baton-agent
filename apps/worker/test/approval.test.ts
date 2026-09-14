/**
 * The approval round trip — against real Postgres.
 *
 * This is the one flow with real mechanical complexity, and it has **two entrances**: the
 * worker's own consequence gate (a high-consequence claim on weak evidence, written
 * `pending_approval` with no interrupt and nothing to resume) and an agent interrupt (a
 * snapshot stored, resumed hours later). Both meet at `answerApproval`, and this file tests
 * both.
 *
 * The assertions that matter most are the refusals, because each of them is a way to apply a
 * change nobody agreed to:
 *
 *   - **A volunteer's "yes" is not an approval.** It leaves the question open — not rejected,
 *     because treating it as a rejection would let anyone veto.
 *   - **Two approvals about one asset are never asked in parallel.** Two answers could
 *     contradict, and the second would silently win.
 *   - **An answer arriving after the claim was superseded resolves `obsolete`.** Applying it
 *     would resurrect something the group has moved past.
 *   - **A session resumes exactly once.** Twice would apply the approved change twice.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, type CuratorRecord, type NormalisedMessage } from "@baton/core";
import { persistMessage } from "../src/store/messages.js";
import { applyFact, findFactStatus } from "../src/store/facts.js";
import { countOpenSessions, findSession, storeSession } from "../src/store/agent-sessions.js";
import {
  countPendingChanges,
  findPendingChange,
  selectPendingChanges,
} from "../src/store/pending-changes.js";
import { markQuestionAsked, selectWaitingOn } from "../src/store/questions.js";
import { upsertAsset } from "../src/store/assets.js";
import {
  answerApproval,
  approvalTarget,
  dispositionOfReply,
  isCoordinator,
  matchApprovalReply,
  readVerdict,
  recordInterrupts,
  requestFactApproval,
} from "../src/pipeline/approval.js";
import { runIngestPass } from "../src/pipeline/processing-loop.js";
import { coordinatorTelegramIds, loadConfig } from "../src/config.js";
import type { HolderResolution } from "../src/pipeline/entities.js";
import {
  FakeAgent,
  InterruptingAgent,
  curatorRecord,
  curatorResult,
  interrupt,
} from "./helpers/fake-agent.js";

const { appSettings, facts, messages, people, pendingChanges, questions } = schema;
const CHAT_ID = -1001234567890;
const NOW = new Date("2026-06-01T10:00:00Z");
const LATER = new Date("2026-06-02T10:00:00Z");

/** The env list in this project holds two operator ids; both must be able to approve. */
const OPERATOR_IDS = [5001, 5009];

describe("the approval round trip", () => {
  let harness: TestDatabase;
  let coordinator: string;
  let secondOperator: string;
  let volunteer: string;
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
        {
          displayName: "Ravi Menon",
          status: "member",
          telegramUserId: 5009,
          privateChatId: 5009,
        },
        { displayName: "Meera Sundaram", status: "member", telegramUserId: 5002 },
      ])
      .returning({ id: people.id, displayName: people.displayName });
    coordinator = inserted.find((row) => row.displayName === "Priya Raghavan")?.id ?? "";
    secondOperator = inserted.find((row) => row.displayName === "Ravi Menon")?.id ?? "";
    volunteer = inserted.find((row) => row.displayName === "Meera Sundaram")?.id ?? "";

    await harness.db.insert(appSettings).values({
      id: 1,
      chatId: CHAT_ID,
      orgName: "Kolam Collective",
      timezone: "Asia/Kolkata",
      coordinatorPersonId: coordinator,
    });
  });

  // ── fixtures ───────────────────────────────────────────────────────────────

  async function message(text: string): Promise<string> {
    const telegramMessageId = nextTelegramId++;
    const normalised: NormalisedMessage = {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId,
      senderTelegramUserId: 5002,
      senderDisplayName: "Meera Sundaram",
      sentAt: new Date("2026-05-01T10:00:00Z"),
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
    return (await persistMessage(harness.db, normalised)).id;
  }

  /** A high-consequence claim on weak evidence: exactly what the gate is for. */
  function weakFinancialRecord(overrides: Partial<CuratorRecord> = {}): CuratorRecord {
    return curatorRecord({
      claim: "Meera now controls the bank account",
      // Below WEAK_EVIDENCE_CONFIDENCE, and financial_control is always high consequence.
      confidence: 0.5,
      assetKind: "financial_control",
      assetName: "the bank account",
      sensitivity: "sensitive",
      holderMention: "Meera",
      ...overrides,
    });
  }

  const meeraHolds = (): HolderResolution => ({
    kind: "person",
    personId: volunteer,
    isPersonalResource: false,
    confidence: 1,
  });

  /** Writes a pending_approval fact and requests approval, as the loop does. */
  async function pendingApproval(
    overrides: Partial<CuratorRecord> = {},
  ): Promise<{ factId: string; pendingChangeId: string; questionId: string | null }> {
    const record = weakFinancialRecord(overrides);
    const messageId = await message(record.claim);
    const asset = await upsertAsset(harness.db, {
      kind: record.assetKind ?? "financial_control",
      name: record.assetName ?? "the bank account",
      sensitivity: record.sensitivity,
    });

    const fact = await applyFact(harness.db, {
      record,
      holder: meeraHolds(),
      assetId: asset.id,
      messageId,
      statedAt: new Date("2026-05-01T10:00:00Z"),
      statedByPersonId: volunteer,
      timezone: "Asia/Kolkata",
    });
    expect(fact.requiresApproval).toBe(true);
    expect(fact.status).toBe("pending_approval");

    const requested = await requestFactApproval(harness.db, {
      record,
      factId: fact.factId as string,
      assetId: asset.id,
      reason: fact.reason,
    });

    // Marked as sent, which is what `runAskPass` does. An answer can only arrive for a
    // question that actually went out, and `resolveQuestion` refuses to answer one that did
    // not — so a fixture leaving it `queued` would test a state the real flow never reaches.
    if (requested.questionId !== null) {
      await markQuestionAsked(harness.db, requested.questionId, {
        botTelegramMessageId: 4000 + nextTelegramId,
        at: NOW,
      });
    }

    return {
      factId: fact.factId as string,
      pendingChangeId: requested.pendingChangeId,
      questionId: requested.questionId,
    };
  }

  function deps(
    transport = new FakeAgent(() => ({
      curator: { results: [] },
      cartographer: { attributions: [] },
    })),
  ) {
    return { db: harness.db, transport };
  }

  /**
   * Marks a queued question as sent, which is what `runAskPass` does.
   *
   * An approval cannot be answered before it is asked, and `resolveQuestion` enforces that —
   * so any test that answers one has to send it first.
   */
  async function markAsked(questionId: string, botMessageId = 4242): Promise<void> {
    await markQuestionAsked(harness.db, questionId, {
      botTelegramMessageId: botMessageId,
      at: NOW,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe("the worker's own gate", () => {
    it("holds a high-consequence weak claim and asks about it", async () => {
      const { factId, questionId } = await pendingApproval();

      // The claim exists but is not believed.
      expect(await findFactStatus(harness.db, factId)).toBe("pending_approval");
      expect(await countPendingChanges(harness.db)).toBe(1);

      const waiting = await selectWaitingOn(harness.db);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.id).toBe(questionId);
      expect(waiting[0]?.kind).toBe("approval");
      // Financial control is always high consequence, so it goes privately.
      expect(waiting[0]?.target).toBe("coordinator");
      expect(waiting[0]?.askedText).toContain("Meera now controls the bank account");
    });

    it("records no session, because there is nothing to resume", async () => {
      const { pendingChangeId } = await pendingApproval();
      const change = await findPendingChange(harness.db, pendingChangeId);

      // The asymmetry that makes `agent_session_id` nullable.
      expect(change?.agentSessionId).toBeNull();
      expect(await countOpenSessions(harness.db)).toBe(0);
    });

    it("fires from the processing loop rather than needing a separate call", async () => {
      const messageId = await message("I think Meera has the bank account now");
      await harness.db
        .update(messages)
        .set({ prefilterVerdict: "candidate", prefilterVersion: 1 })
        .where(eq(messages.id, messageId));
      await harness.db.insert(schema.personAliases).values({
        personId: volunteer,
        alias: "Meera",
        normalisedAlias: "meera",
        kind: "first_name",
      });

      const agent = new FakeAgent((batch) => {
        const results = batch.map((entry) =>
          curatorResult(entry.messageId, [weakFinancialRecord()]),
        );
        return {
          curator: { results },
          cartographer: {
            attributions: results.map((_result, index) => ({
              recordIndex: index,
              mention: "Meera",
              resolution: "resolved" as const,
              personId: volunteer,
              candidatePersonIds: [volunteer],
              externalName: null,
              isPersonalResource: false,
              confidence: 1,
              reasoning: "Fake.",
            })),
          },
        };
      });

      const result = await runIngestPass({ db: harness.db, transport: agent, now: () => NOW });

      // Before this wiring, `applyFact` reported requiresApproval and nothing consumed it —
      // a claim held back that nobody was ever asked about.
      expect(result.approvalsRequested).toBe(1);
      expect(await countPendingChanges(harness.db)).toBe(1);
      expect((await selectWaitingOn(harness.db))[0]?.kind).toBe("approval");
    });

    it("routes a low-consequence approval to the group", () => {
      expect(approvalTarget("high")).toBe("coordinator");
      expect(approvalTarget("low")).toBe("group");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("who may answer", () => {
    it("accepts the coordinator named in app_settings", async () => {
      expect(await isCoordinator(harness.db, coordinator, [])).toBe(true);
    });

    it("accepts a second operator named in the environment", async () => {
      // The env var holds a comma-separated list because a demo has two operators, and a
      // column that holds one id would lock the second out.
      expect(await isCoordinator(harness.db, secondOperator, OPERATOR_IDS)).toBe(true);
      expect(await isCoordinator(harness.db, secondOperator, [])).toBe(false);
    });

    it("refuses a volunteer", async () => {
      expect(await isCoordinator(harness.db, volunteer, OPERATOR_IDS)).toBe(false);
    });

    it("leaves the question open when a volunteer says yes", async () => {
      const { pendingChangeId, questionId, factId } = await pendingApproval();

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: volunteer,
        answerText: "yes definitely",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("not_permitted");
      // Not rejected: treating a volunteer's reply as a rejection would let anyone veto.
      expect((await findPendingChange(harness.db, pendingChangeId))?.status).toBe("pending");
      expect(await findFactStatus(harness.db, factId)).toBe("pending_approval");
      expect(await selectWaitingOn(harness.db)).toHaveLength(1);
    });

    it("leaves the question open when nobody can be identified", async () => {
      const { pendingChangeId, questionId } = await pendingApproval();

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: null,
        answerText: "yes",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("not_permitted");
      expect(await selectWaitingOn(harness.db)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("reading the answer", () => {
    it("reads a yes and a no", () => {
      expect(readVerdict("yes")).toBe("approved");
      expect(readVerdict("Yep, that's right")).toBe("approved");
      expect(readVerdict("no")).toBe("rejected");
      expect(readVerdict("Nope, it's still Anil")).toBe("rejected");
    });

    it("takes the leading word when a reply contains both", () => {
      // "no, yes that's right" and "yes, no need to change it" both contain both words, and
      // only the leading one is the answer.
      expect(readVerdict("no, yes that was the old arrangement")).toBe("rejected");
      expect(readVerdict("yes, no need to change anything")).toBe("approved");
    });

    it("calls anything else unclear", () => {
      expect(readVerdict("maybe?")).toBe("unclear");
      expect(readVerdict("ask Anil")).toBe("unclear");
      expect(readVerdict("")).toBe("unclear");
    });

    it("leaves an unclear reply open rather than declining it", async () => {
      const { pendingChangeId, questionId, factId } = await pendingApproval();

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "let me check with Anil",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("unclear");
      // A declined approval looks identical to one nobody answered, so the coordinator would
      // never know their reply had been discarded.
      expect(await findFactStatus(harness.db, factId)).toBe("pending_approval");
      expect(await selectWaitingOn(harness.db)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("applying and discarding", () => {
    it("makes the claim believed on a yes, with a verified timestamp", async () => {
      const { pendingChangeId, questionId, factId } = await pendingApproval();

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "yes, that's right",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("applied");
      expect(await findFactStatus(harness.db, factId)).toBe("active");

      const rows = await harness.db
        .select({ verifiedAt: facts.verifiedAt })
        .from(facts)
        .where(eq(facts.id, factId));
      // "A human agreed to this, on this day" is the strongest provenance the register has.
      expect(rows[0]?.verifiedAt?.toISOString()).toBe(NOW.toISOString());
      expect((await findPendingChange(harness.db, pendingChangeId))?.status).toBe("applied");
      expect(await selectWaitingOn(harness.db)).toHaveLength(0);
    });

    it("marks the claim unverified on a no, rather than retiring it", async () => {
      const { pendingChangeId, questionId, factId } = await pendingApproval();

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "no, that's not right",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("rejected");
      // `retired` would mean an arrangement the register once held has ended — a lie about
      // something never recorded. `unverified` says plainly that Baton was told this and does
      // not believe it, and it stays invisible to every detection query.
      expect(await findFactStatus(harness.db, factId)).toBe("unverified");
      expect((await findPendingChange(harness.db, pendingChangeId))?.status).toBe("rejected");
    });

    it("records the answer against the question", async () => {
      const { pendingChangeId, questionId } = await pendingApproval();
      await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "yes",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      const rows = await harness.db
        .select({
          status: questions.status,
          resolution: questions.resolution,
          answeredBy: questions.answeredByPersonId,
        })
        .from(questions);
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.resolution).toBe("approved");
      expect(rows[0]?.answeredBy).toBe(coordinator);
    });

    it("does not settle the same proposal twice", async () => {
      const { pendingChangeId, questionId } = await pendingApproval();
      const answer = {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "yes",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      };

      expect((await answerApproval(deps(), answer)).outcome).toBe("applied");
      expect((await answerApproval(deps(), answer)).outcome).toBe("already_resolved");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("two approvals about one asset", () => {
    it("stores the second and asks about only the first", async () => {
      const first = await pendingApproval();
      const second = await pendingApproval({ claim: "Anil now controls the bank account" });

      expect(first.questionId).not.toBeNull();
      // Two answers could contradict, and the second would silently win.
      expect(second.questionId).toBeNull();
      expect(await countPendingChanges(harness.db)).toBe(2);
      expect(await selectWaitingOn(harness.db)).toHaveLength(1);
    });

    it("asks about the second once the first resolves", async () => {
      const first = await pendingApproval();
      const second = await pendingApproval({ claim: "Anil now controls the bank account" });

      await answerApproval(deps(), {
        questionId: first.questionId as string,
        pendingChangeId: first.pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "yes",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      });

      // Without this promotion the second would sit pending forever with no question
      // attached — a write held back that nobody is ever asked about.
      const waiting = await selectWaitingOn(harness.db);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.askedText).toContain("Anil now controls the bank account");
      expect((await findPendingChange(harness.db, second.pendingChangeId))?.status).toBe("pending");
    });

    it("asks about a proposal for a different asset straight away", async () => {
      await pendingApproval();
      // A different asset, still high consequence — `account_login` is always high, so this
      // one genuinely requires approval too rather than quietly becoming `unverified`.
      const other = await pendingApproval({
        claim: "Meera has the donation platform login",
        assetKind: "account_login",
        assetName: "the donation platform login",
      });

      // Different asset, no contradiction possible.
      expect(other.questionId).not.toBeNull();
      expect(await selectWaitingOn(harness.db)).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("an answer that arrives too late", () => {
    it("resolves as obsolete and applies nothing", async () => {
      const { pendingChangeId, questionId, factId } = await pendingApproval();

      // A later message settled the claim, so the fact moved on.
      await harness.db.update(facts).set({ status: "superseded" }).where(eq(facts.id, factId));

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "yes",
        at: LATER,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("obsolete");
      // Applying it would resurrect a claim the group has already moved past.
      expect(await findFactStatus(harness.db, factId)).toBe("superseded");
      expect((await findPendingChange(harness.db, pendingChangeId))?.status).toBe("obsolete");

      const rows = await harness.db.select({ status: questions.status }).from(questions);
      expect(rows[0]?.status).toBe("obsolete");
    });

    it("checks staleness before it checks who answered", async () => {
      const { pendingChangeId, questionId, factId } = await pendingApproval();
      await harness.db.update(facts).set({ status: "retired" }).where(eq(facts.id, factId));

      const result = await answerApproval(deps(), {
        questionId: questionId as string,
        pendingChangeId,
        // A volunteer's reply. The question was moot before authority even mattered.
        answeredByPersonId: volunteer,
        answerText: "yes",
        at: LATER,
        permittedTelegramIds: OPERATOR_IDS,
      });

      expect(result.outcome).toBe("obsolete");
    });

    it("promotes the next proposal for the asset", async () => {
      const first = await pendingApproval();
      const second = await pendingApproval({ claim: "Anil now controls the bank account" });
      await harness.db
        .update(facts)
        .set({ status: "superseded" })
        .where(eq(facts.id, first.factId));

      await answerApproval(deps(), {
        questionId: first.questionId as string,
        pendingChangeId: first.pendingChangeId,
        answeredByPersonId: coordinator,
        answerText: "yes",
        at: LATER,
        permittedTelegramIds: OPERATOR_IDS,
      });

      const waiting = await selectWaitingOn(harness.db);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]?.askedText).toContain("Anil");
      void second;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the agent-interrupt entrance", () => {
    it("stores one session for the response and a proposal per interrupt", async () => {
      const asset = await upsertAsset(harness.db, {
        kind: "financial_control",
        name: "the bank account",
        sensitivity: "sensitive",
      });
      const agent = new InterruptingAgent([
        interrupt({ interruptId: "i-1", reason: "Record that Meera controls the account?" }),
        interrupt({ interruptId: "i-2", reason: "And that Anil no longer does?" }),
      ]);
      const response = await agent.invoke({
        task: "assess",
        runId: "00000000-0000-0000-0000-000000000000",
        payload: {},
        context: {},
      });

      const recorded = await recordInterrupts(harness.db, {
        task: "assess",
        response,
        runId: null,
        assetId: asset.id,
      });

      expect(recorded).toHaveLength(2);
      // One snapshot for the whole graph, shared by both proposals, so a resume can carry
      // every answer at once.
      expect(new Set(recorded.map((entry) => entry.agentSessionId)).size).toBe(1);
      expect(await countOpenSessions(harness.db)).toBe(1);
      // Same asset, so only the first is asked.
      expect(recorded[0]?.asked).toBe(true);
      expect(recorded[1]?.asked).toBe(false);
      expect(await selectWaitingOn(harness.db)).toHaveLength(1);
    });

    it("resumes the graph with the answer and closes the session", async () => {
      const agent = new InterruptingAgent([interrupt()], {
        findings: [],
      });
      const response = await agent.invoke({
        task: "assess",
        runId: "00000000-0000-0000-0000-000000000000",
        payload: {},
        context: {},
      });
      const [recorded] = await recordInterrupts(harness.db, {
        task: "assess",
        response,
        runId: null,
      });
      await markAsked(recorded?.questionId as string);

      const result = await answerApproval(
        { db: harness.db, transport: agent },
        {
          questionId: recorded?.questionId as string,
          pendingChangeId: recorded?.pendingChangeId as string,
          answeredByPersonId: coordinator,
          answerText: "yes",
          at: NOW,
          permittedTelegramIds: OPERATOR_IDS,
        },
      );

      expect(result.outcome).toBe("applied");
      expect(agent.resumeRequests).toHaveLength(1);
      const resumeRequest = agent.resumeRequests[0];
      expect(resumeRequest?.payload).toEqual({ originalTask: "assess" });
      // The snapshot travels back, which is what makes the container stateless.
      expect(resumeRequest?.snapshot).toEqual({ node: "assessor", step: 3 });
      expect(resumeRequest?.interruptResponses?.[0]?.approved).toBe(true);
      // Validated against the Assessor's own schema, because `resume` returns the node's
      // output rather than the wrapped task result.
      expect(result.resumedResult).toEqual({ findings: [] });

      const session = await findSession(harness.db, recorded?.agentSessionId as string);
      expect(session?.status).toBe("closed");
      expect(await countOpenSessions(harness.db)).toBe(0);
    });

    it("resumes exactly once when the answer lands twice", async () => {
      const agent = new InterruptingAgent([interrupt()], { findings: [] });
      const response = await agent.invoke({
        task: "assess",
        runId: "00000000-0000-0000-0000-000000000000",
        payload: {},
        context: {},
      });
      const [recorded] = await recordInterrupts(harness.db, {
        task: "assess",
        response,
        runId: null,
      });
      await markAsked(recorded?.questionId as string);

      const answer = {
        questionId: recorded?.questionId as string,
        pendingChangeId: recorded?.pendingChangeId as string,
        answeredByPersonId: coordinator,
        answerText: "yes",
        at: NOW,
        permittedTelegramIds: OPERATOR_IDS,
      };
      await answerApproval({ db: harness.db, transport: agent }, answer);
      await answerApproval({ db: harness.db, transport: agent }, answer);

      // Twice would run the node again from the same interruption point — applying the
      // approved change twice, or saying the same thing to the group twice.
      expect(agent.resumeRequests).toHaveLength(1);
    });

    it("closes an abandoned session rather than leaving it open forever", async () => {
      const messageId = await message("Meera now controls the bank account");
      const factRows = await harness.db
        .insert(facts)
        .values({
          claim: "Meera now controls the bank account",
          matchKey: "k:bank",
          confidence: 0.5,
          status: "pending_approval",
          sourceMessageId: messageId,
          statedAt: NOW,
          lastConfirmedAt: NOW,
          evidenceMessageIds: [messageId],
        })
        .returning({ id: facts.id });
      const factId = factRows[0]?.id as string;

      const sessionId = await storeSession(harness.db, {
        task: "assess",
        snapshot: { node: "assessor" },
        runId: null,
      });
      const changeRows = await harness.db
        .insert(pendingChanges)
        .values({
          proposedChange: { kind: "fact", factId },
          consequence: "high",
          factId,
          agentSessionId: sessionId,
          status: "pending",
        })
        .returning({ id: pendingChanges.id });
      const questionRows = await harness.db
        .insert(questions)
        .values({
          kind: "approval",
          target: "coordinator",
          askedText: "Record it?",
          status: "asked",
          askedAt: NOW,
          pendingChangeId: changeRows[0]?.id as string,
          factId,
        })
        .returning({ id: questions.id });

      // The claim moved on, so nobody will ever resume this snapshot.
      await harness.db.update(facts).set({ status: "superseded" }).where(eq(facts.id, factId));

      const result = await answerApproval(
        { db: harness.db, transport: new InterruptingAgent([interrupt()]) },
        {
          questionId: questionRows[0]?.id as string,
          pendingChangeId: changeRows[0]?.id as string,
          answeredByPersonId: coordinator,
          answerText: "yes",
          at: LATER,
          permittedTelegramIds: OPERATOR_IDS,
        },
      );

      expect(result.outcome).toBe("obsolete");
      // Left open, the count of what Baton is waiting on stays wrong forever.
      expect((await findSession(harness.db, sessionId))?.status).toBe("closed");
      expect(await countOpenSessions(harness.db)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("matching a reply to what it answers", () => {
    it("matches an approval by the bot's own message id", async () => {
      const { pendingChangeId, questionId } = await pendingApproval();
      await harness.db
        .update(questions)
        .set({ status: "asked", askedAt: NOW, botTelegramMessageId: 4242 })
        .where(eq(questions.id, questionId as string));

      const match = await matchApprovalReply(harness.db, 4242);
      expect(match).toEqual({ questionId, pendingChangeId });
    });

    it("refuses to match a verification as an approval", async () => {
      await harness.db.insert(questions).values({
        kind: "verification",
        target: "group",
        askedText: "Is the figure still 1200?",
        status: "asked",
        askedAt: NOW,
        botTelegramMessageId: 5555,
      });

      // A wrong match here applies a change nobody approved, so this refuses rather than
      // widening to the looser fallbacks a verification can afford.
      expect(await matchApprovalReply(harness.db, 5555)).toBeNull();
    });

    it("treats a reply to an approval as an answer, not a new question", async () => {
      const { questionId } = await pendingApproval();
      await harness.db
        .update(questions)
        .set({ status: "asked", askedAt: NOW, botTelegramMessageId: 4242 })
        .where(eq(questions.id, questionId as string));

      const disposition = await dispositionOfReply(
        deps(),
        {
          messageId: await message("yes"),
          senderPersonId: coordinator,
          text: "yes",
          repliedToBotMessageId: 4242,
          at: NOW,
        },
        OPERATOR_IDS,
      );

      expect(disposition.kind).toBe("approval_answer");
      if (disposition.kind === "approval_answer") {
        expect(disposition.result.outcome).toBe("applied");
      }
    });

    it("lets anyone answer a verification", async () => {
      const inserted = await harness.db
        .insert(questions)
        .values({
          kind: "verification",
          target: "group",
          askedText: "Is the figure still 1200?",
          status: "asked",
          askedAt: NOW,
          botTelegramMessageId: 5555,
        })
        .returning({ id: questions.id });

      const disposition = await dispositionOfReply(
        deps(),
        {
          messageId: await message("still 1200"),
          // A volunteer. Verification and clarification are questions of fact, and the group
          // is the authority on its own facts — unlike an approval, a question of authority.
          senderPersonId: volunteer,
          text: "still 1200",
          repliedToBotMessageId: 5555,
          at: NOW,
        },
        OPERATOR_IDS,
      );

      expect(disposition).toEqual({ kind: "verification_answer", questionId: inserted[0]?.id });
      const rows = await harness.db.select({ status: questions.status }).from(questions);
      expect(rows[0]?.status).toBe("resolved");
    });

    it("treats a reply matching no open question as a new question", async () => {
      const disposition = await dispositionOfReply(
        deps(),
        {
          messageId: await message("and the spare?"),
          senderPersonId: volunteer,
          text: "and the spare?",
          repliedToBotMessageId: 9999,
          at: NOW,
        },
        OPERATOR_IDS,
      );

      // The ordinary case of someone following up on an answer Baton gave. The permissive
      // direction: the cost is a model call, whereas refusing ignores somebody talking to it.
      expect(disposition).toEqual({ kind: "new_question" });
    });

    it("treats a message with no reply pointer as a new question", async () => {
      const disposition = await dispositionOfReply(
        deps(),
        {
          messageId: await message("@batonbot who has the key?"),
          senderPersonId: volunteer,
          text: "@batonbot who has the key?",
          repliedToBotMessageId: null,
          at: NOW,
        },
        OPERATOR_IDS,
      );
      expect(disposition).toEqual({ kind: "new_question" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the operator list from the environment", () => {
    const BASE_ENV = {
      DATABASE_URL: "postgres://x",
      TELEGRAM_BOT_TOKEN: "t",
      TELEGRAM_CHAT_ID: "-100",
      DATA_API_TOKEN: "token",
      AGENT_TRANSPORT: "http",
      AGENT_HTTP_URL: "http://localhost:8080",
    };

    it("parses a comma-separated list", () => {
      const config = loadConfig({ ...BASE_ENV, COORDINATOR_TELEGRAM_ID: "588068795,489705226" });
      expect(coordinatorTelegramIds(config)).toEqual([588068795, 489705226]);
    });

    it("parses a single id", () => {
      const config = loadConfig({ ...BASE_ENV, COORDINATOR_TELEGRAM_ID: "588068795" });
      expect(coordinatorTelegramIds(config)).toEqual([588068795]);
    });

    it("tolerates spaces and trailing separators", () => {
      const config = loadConfig({ ...BASE_ENV, COORDINATOR_TELEGRAM_ID: " 1 , 2 , " });
      expect(coordinatorTelegramIds(config)).toEqual([1, 2]);
    });

    it("drops a non-numeric entry rather than producing NaN", () => {
      const config = loadConfig({ ...BASE_ENV, COORDINATOR_TELEGRAM_ID: "1,not-an-id,2" });
      // NaN would match nothing and read as "the coordinator cannot approve" with no
      // explanation anywhere.
      expect(coordinatorTelegramIds(config)).toEqual([1, 2]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("what the coordinator sees while waiting", () => {
    it("lists the proposal alongside the question", async () => {
      await pendingApproval();

      const waiting = await selectWaitingOn(harness.db);
      const proposals = await selectPendingChanges(harness.db);

      expect(waiting).toHaveLength(1);
      expect(proposals).toHaveLength(1);
      expect(waiting[0]?.pendingChangeId).toBe(proposals[0]?.id);
      expect(proposals[0]?.consequence).toBe("high");
    });
  });
});
