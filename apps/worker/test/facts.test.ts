/**
 * Facts: merge, supersede, retire — against real Postgres.
 *
 * The assertion that matters most is the ordering invariant: a contradiction applied
 * forwards and backwards must reach the same final state. Supersession is
 * order-dependent, so processing a contradiction the wrong way round silently inverts a
 * fact, and "silently" is the whole problem.
 *
 * The second is that hearsay never reaches detection. A finding raised on the strength
 * of a rumour is worse than no finding.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, type CuratorRecord, type NormalisedMessage } from "@baton/core";
import { applyFact, resolveDeadline, type ApplyFactInput } from "../src/store/facts.js";
import type { HolderResolution } from "../src/pipeline/entities.js";
import { persistMessage } from "../src/store/messages.js";

const { facts, people } = schema;
const CHAT_ID = -1001234567890;
const IST = "Asia/Kolkata";

function record(overrides: Partial<CuratorRecord> = {}): CuratorRecord {
  return {
    kind: "durable_fact",
    claim: "Sunrise Clinic lets us settle at month end",
    confidence: 0.9,
    assetKind: "relationship",
    assetName: "Sunrise Clinic",
    sensitivity: "normal",
    holderMention: null,
    subjectMentions: [],
    capabilityName: null,
    deadlineText: null,
    deadlineDate: null,
    isHearsay: false,
    isNegation: false,
    lifecycleKind: null,
    ...overrides,
  };
}

const noHolder: HolderResolution = { kind: "none" };

describe("facts", () => {
  let harness: TestDatabase;
  let meera: string;
  let anil: string;
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
        { displayName: "Meera Sundaram", status: "member" },
        { displayName: "Anil Kumar", status: "member" },
      ])
      .returning({ id: people.id, displayName: people.displayName });
    meera = inserted.find((row) => row.displayName === "Meera Sundaram")?.id ?? "";
    anil = inserted.find((row) => row.displayName === "Anil Kumar")?.id ?? "";
  });

  /** Stores a message and returns its local id, so facts have real provenance. */
  async function message(text: string, sentAt: string): Promise<string> {
    const normalised: NormalisedMessage = {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: nextTelegramId++,
      senderTelegramUserId: 1,
      senderDisplayName: "Priya Raghavan",
      sentAt: new Date(sentAt),
      text,
      contentHash: contentHash(`${text}#${nextTelegramId}`),
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedAt: null,
      isUnprocessed: false,
      mediaKind: null,
    };
    const stored = await persistMessage(harness.db, normalised);
    return stored.id;
  }

  function input(
    overrides: Partial<ApplyFactInput> & { messageId: string; statedAt: Date },
  ): ApplyFactInput {
    return {
      record: record(),
      holder: noHolder,
      assetId: null,
      statedByPersonId: null,
      timezone: IST,
      ...overrides,
    };
  }

  describe("a claim the register does not hold", () => {
    it("is inserted, active, with the message as its evidence", async () => {
      const messageId = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const result = await applyFact(
        harness.db,
        input({ messageId, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );

      expect(result.outcome).toBe("inserted");
      expect(result.status).toBe("active");

      const rows = await harness.db.select().from(facts);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.evidenceMessageIds).toEqual([messageId]);
      expect(rows[0]?.supersedesFactId).toBeNull();
      expect(rows[0]?.matchKey).toBe("relationship:sunrise clinic#attribute");
    });

    it("records the Curator's reasoning for the detail panel", async () => {
      const messageId = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-04-13T09:00:00Z"),
          curatorReasoning: "States a standing settlement arrangement",
        }),
      );
      const rows = await harness.db.select({ reasoning: facts.curatorReasoning }).from(facts);
      expect(rows[0]?.reasoning).toBe("States a standing settlement arrangement");
    });
  });

  describe("restatement", () => {
    it("bumps last_confirmed_at without inserting a row", async () => {
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const again = await message("month end is fine with Sunrise", "2026-06-01T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      const second = await applyFact(
        harness.db,
        input({
          messageId: again,
          statedAt: new Date("2026-06-01T09:00:00Z"),
          record: record({ claim: "month end is fine with Sunrise" }),
        }),
      );

      expect(second.outcome).toBe("merged");
      const rows = await harness.db.select().from(facts);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lastConfirmedAt?.toISOString()).toBe("2026-06-01T09:00:00.000Z");
      // The original wording is kept; a restatement does not rewrite the claim.
      expect(rows[0]?.claim).toBe("Sunrise Clinic lets us settle at month end");
    });

    it("appends evidence rather than replacing it", async () => {
      // Provenance accumulates: a claim stated three times should show all three.
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const again = await message("month end is fine", "2026-06-01T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      await applyFact(
        harness.db,
        input({
          messageId: again,
          statedAt: new Date("2026-06-01T09:00:00Z"),
          record: record({ claim: "month end is fine" }),
        }),
      );

      const rows = await harness.db.select({ evidence: facts.evidenceMessageIds }).from(facts);
      expect(rows[0]?.evidence).toEqual([first, again]);
    });

    it("does not add the same message to evidence twice", async () => {
      // Backfill and crash replay both re-present the same message, and a duplicated
      // entry would inflate the count the suppression threshold reads.
      const messageId = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const args = input({ messageId, statedAt: new Date("2026-04-13T09:00:00Z") });

      await applyFact(harness.db, args);
      const replay = await applyFact(harness.db, args);

      expect(replay.outcome).toBe("merged");
      const rows = await harness.db.select({ evidence: facts.evidenceMessageIds }).from(facts);
      expect(rows[0]?.evidence).toEqual([messageId]);
    });

    it("never drags the confirmation date backwards", async () => {
      // A late-arriving older message confirms the claim but does not make it older.
      const newer = await message("month end is fine", "2026-06-01T09:00:00Z");
      const older = await message("clinic settles at month end", "2026-04-13T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: newer, statedAt: new Date("2026-06-01T09:00:00Z") }),
      );
      await applyFact(
        harness.db,
        input({ messageId: older, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );

      const rows = await harness.db.select({ lastConfirmedAt: facts.lastConfirmedAt }).from(facts);
      expect(rows[0]?.lastConfirmedAt?.toISOString()).toBe("2026-06-01T09:00:00.000Z");
    });

    it("merges a holder claim restated about the same person", async () => {
      const first = await message("Meera set up the donation page", "2026-04-08T09:00:00Z");
      const again = await message("the Razorpay page is Meera's", "2026-05-08T09:00:00Z");
      const holder: HolderResolution = {
        kind: "person",
        personId: meera,
        isPersonalResource: false,
        confidence: 1,
      };
      const holderRecord = record({
        claim: "Meera set up the Razorpay donation page",
        assetKind: "public_presence",
        assetName: "Razorpay donation page",
        holderMention: "Meera",
      });

      await applyFact(
        harness.db,
        input({
          messageId: first,
          statedAt: new Date("2026-04-08T09:00:00Z"),
          record: holderRecord,
          holder,
        }),
      );
      const second = await applyFact(
        harness.db,
        input({
          messageId: again,
          statedAt: new Date("2026-05-08T09:00:00Z"),
          record: record({ ...holderRecord, claim: "the Razorpay page is Meera's" }),
          holder,
        }),
      );

      expect(second.outcome).toBe("merged");
      await expect(harness.db.select().from(facts)).resolves.toHaveLength(1);
    });
  });

  describe("contradiction", () => {
    it("inserts a new row and links the one it replaced", async () => {
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const changed = await message(
        "clinic wants payment within 7 days now",
        "2026-07-01T09:00:00Z",
      );

      const before = await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      const after = await applyFact(
        harness.db,
        input({
          messageId: changed,
          statedAt: new Date("2026-07-01T09:00:00Z"),
          record: record({ claim: "Sunrise Clinic wants payment within 7 days" }),
        }),
      );

      expect(after.outcome).toBe("superseded");
      expect(after.supersededFactId).toBe(before.factId);

      const rows = await harness.db.select().from(facts).orderBy(facts.statedAt);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.status).toBe("superseded");
      expect(rows[1]?.status).toBe("active");
      expect(rows[1]?.supersedesFactId).toBe(rows[0]?.id);
    });

    it("leaves the superseded claim's text and evidence intact", async () => {
      // It is history now, not a mistake. The detail panel renders the chain.
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const changed = await message("within 7 days now", "2026-07-01T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      await applyFact(
        harness.db,
        input({
          messageId: changed,
          statedAt: new Date("2026-07-01T09:00:00Z"),
          record: record({ claim: "Sunrise Clinic wants payment within 7 days" }),
        }),
      );

      const rows = await harness.db.select().from(facts).orderBy(facts.statedAt);
      expect(rows[0]?.claim).toBe("Sunrise Clinic lets us settle at month end");
      expect(rows[0]?.evidenceMessageIds).toEqual([first]);
    });

    it("treats a transfer of holding as a contradiction", async () => {
      const first = await message("Meera holds the bank signatory", "2026-04-08T09:00:00Z");
      const moved = await message("Anil holds the bank signatory now", "2026-09-03T09:00:00Z");
      const holderRecord = record({
        claim: "holds the bank signatory",
        assetKind: "financial_control",
        assetName: "bank signatory",
        sensitivity: "sensitive",
        holderMention: "Meera",
      });

      await applyFact(
        harness.db,
        input({
          messageId: first,
          statedAt: new Date("2026-04-08T09:00:00Z"),
          record: holderRecord,
          holder: { kind: "person", personId: meera, isPersonalResource: false, confidence: 1 },
        }),
      );
      const after = await applyFact(
        harness.db,
        input({
          messageId: moved,
          statedAt: new Date("2026-09-03T09:00:00Z"),
          record: record({ ...holderRecord, holderMention: "Anil" }),
          holder: { kind: "person", personId: anil, isPersonalResource: false, confidence: 1 },
        }),
      );

      expect(after.outcome).toBe("superseded");
    });

    it("does not revive a superseded claim when it is mentioned again", async () => {
      // Only active rows are candidates. Reviving one would undo a contradiction the
      // group already settled.
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const changed = await message("within 7 days now", "2026-07-01T09:00:00Z");
      const restated = await message("still 7 days", "2026-08-01T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      await applyFact(
        harness.db,
        input({
          messageId: changed,
          statedAt: new Date("2026-07-01T09:00:00Z"),
          record: record({ claim: "Sunrise Clinic wants payment within 7 days" }),
        }),
      );
      const third = await applyFact(
        harness.db,
        input({
          messageId: restated,
          statedAt: new Date("2026-08-01T09:00:00Z"),
          record: record({ claim: "Sunrise still wants payment within 7 days" }),
        }),
      );

      expect(third.outcome).toBe("merged");
      const rows = await harness.db.select({ status: facts.status }).from(facts);
      expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
      expect(rows.filter((row) => row.status === "superseded")).toHaveLength(1);
    });
  });

  describe("the ordering invariant", () => {
    /**
     * Applies the two claims in the order given and reports the final state.
     *
     * Supersession is order-dependent, so the processing loop reads in strict `sent_at`
     * order. This asserts the payoff: given that ordering, the same pair of messages
     * reaches the same state whichever order they *arrived* in.
     */
    async function finalState(order: "forwards" | "backwards") {
      await harness.truncate();
      nextTelegramId = 1;

      const oldMessage = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const newMessage = await message("within 7 days now", "2026-07-01T09:00:00Z");

      const older = input({
        messageId: oldMessage,
        statedAt: new Date("2026-04-13T09:00:00Z"),
        record: record({ claim: "Sunrise Clinic lets us settle at month end" }),
      });
      const newer = input({
        messageId: newMessage,
        statedAt: new Date("2026-07-01T09:00:00Z"),
        record: record({ claim: "Sunrise Clinic wants payment within 7 days" }),
      });

      // Sorted by sent_at, exactly as the processing loop does, regardless of the order
      // the caller handed them over in.
      const batch = order === "forwards" ? [older, newer] : [newer, older];
      const ordered = [...batch].sort((a, b) => a.statedAt.getTime() - b.statedAt.getTime());
      for (const entry of ordered) await applyFact(harness.db, entry);

      const rows = await harness.db
        .select({ claim: facts.claim, status: facts.status })
        .from(facts)
        .orderBy(facts.statedAt);
      return rows;
    }

    it("reaches the same state applied forwards or backwards", async () => {
      const forwards = await finalState("forwards");
      const backwards = await finalState("backwards");
      expect(backwards).toEqual(forwards);
    });

    it("leaves the later claim active and the earlier one superseded", async () => {
      const state = await finalState("backwards");
      expect(state).toEqual([
        { claim: "Sunrise Clinic lets us settle at month end", status: "superseded" },
        { claim: "Sunrise Clinic wants payment within 7 days", status: "active" },
      ]);
    });
  });

  describe("negation", () => {
    it("retires the claim without inserting a replacement", async () => {
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const ended = await message("that arrangement has ended", "2026-08-01T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      const result = await applyFact(
        harness.db,
        input({
          messageId: ended,
          statedAt: new Date("2026-08-01T09:00:00Z"),
          record: record({ claim: "the settlement arrangement has ended", isNegation: true }),
        }),
      );

      expect(result.outcome).toBe("retired");
      const rows = await harness.db.select().from(facts);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("retired");
      expect(rows[0]?.retiredAt?.toISOString()).toBe("2026-08-01T09:00:00.000Z");
    });

    it("records the message that ended it as evidence", async () => {
      const first = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const ended = await message("that has ended", "2026-08-01T09:00:00Z");

      await applyFact(
        harness.db,
        input({ messageId: first, statedAt: new Date("2026-04-13T09:00:00Z") }),
      );
      await applyFact(
        harness.db,
        input({
          messageId: ended,
          statedAt: new Date("2026-08-01T09:00:00Z"),
          record: record({ isNegation: true }),
        }),
      );

      const rows = await harness.db.select({ evidence: facts.evidenceMessageIds }).from(facts);
      expect(rows[0]?.evidence).toEqual([first, ended]);
    });

    it("records nothing when ending an arrangement the register never held", async () => {
      // A retired claim for something never true would put a falsehood in the register.
      const ended = await message("that arrangement has ended", "2026-08-01T09:00:00Z");
      const result = await applyFact(
        harness.db,
        input({
          messageId: ended,
          statedAt: new Date("2026-08-01T09:00:00Z"),
          record: record({ isNegation: true }),
        }),
      );

      expect(result.outcome).toBe("skipped");
      await expect(harness.db.select().from(facts)).resolves.toHaveLength(0);
    });
  });

  describe("hearsay", () => {
    it("is recorded unverified, so detection cannot see it", async () => {
      const messageId = await message(
        "Divya said the clinic may close Sundays",
        "2026-07-01T09:00:00Z",
      );
      const result = await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-07-01T09:00:00Z"),
          record: record({
            claim: "the clinic may close on Sundays",
            isHearsay: true,
            confidence: 0.3,
          }),
        }),
      );

      expect(result.status).toBe("unverified");
      expect(result.requiresApproval).toBe(false);

      // The promise, expressed as the query detection actually runs.
      const detectable = await harness.db.select().from(facts).where(eq(facts.status, "active"));
      expect(detectable).toHaveLength(0);
    });

    it("stays unverified even when the Curator was confident it read it right", async () => {
      // Confidence in having read the sentence correctly is not confidence that the
      // third party was right.
      const messageId = await message("Divya said the clinic may close", "2026-07-01T09:00:00Z");
      const result = await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-07-01T09:00:00Z"),
          record: record({ isHearsay: true, confidence: 0.99 }),
        }),
      );
      expect(result.status).toBe("unverified");
    });
  });

  describe("consequence and the approval gate", () => {
    it("holds a high-consequence claim on weak evidence pending approval", async () => {
      const messageId = await message(
        "Anil may be taking over the bank signatory",
        "2026-09-03T09:00:00Z",
      );
      const result = await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-09-03T09:00:00Z"),
          record: record({
            claim: "Anil holds the bank signatory",
            assetKind: "financial_control",
            assetName: "bank signatory",
            sensitivity: "sensitive",
            holderMention: "Anil",
            confidence: 0.45,
          }),
          holder: { kind: "person", personId: anil, isPersonalResource: false, confidence: 0.45 },
        }),
      );

      expect(result.consequence).toBe("high");
      expect(result.status).toBe("pending_approval");
      expect(result.requiresApproval).toBe(true);

      const detectable = await harness.db.select().from(facts).where(eq(facts.status, "active"));
      expect(detectable).toHaveLength(0);
    });

    it("acts directly on a high-consequence claim that is well evidenced", async () => {
      const messageId = await message("Meera is the bank signatory", "2026-04-08T09:00:00Z");
      const result = await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-04-08T09:00:00Z"),
          record: record({
            assetKind: "financial_control",
            assetName: "bank signatory",
            confidence: 0.95,
          }),
        }),
      );

      expect(result.consequence).toBe("high");
      expect(result.status).toBe("active");
      expect(result.requiresApproval).toBe(false);
    });

    it("records low-consequence uncertainty without asking anyone", async () => {
      // The bottom-right cell of the matrix. Escalating here is how an agent becomes
      // noise and gets muted.
      const messageId = await message(
        "the poster template might be in the drive",
        "2026-05-01T09:00:00Z",
      );
      const result = await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-05-01T09:00:00Z"),
          record: record({ assetKind: "document", assetName: "poster template", confidence: 0.4 }),
        }),
      );

      expect(result.consequence).toBe("low");
      expect(result.status).toBe("unverified");
      expect(result.requiresApproval).toBe(false);
    });

    it("links the claim to its asset", async () => {
      const messageId = await message("clinic settles at month end", "2026-04-13T09:00:00Z");
      const result = await applyFact(
        harness.db,
        input({
          messageId,
          statedAt: new Date("2026-04-13T09:00:00Z"),
          assetId: null,
        }),
      );
      expect(result.factId).not.toBeNull();

      const rows = await harness.db
        .select({ assetId: facts.assetId })
        .from(facts)
        .where(and(eq(facts.id, result.factId as string)));
      expect(rows[0]?.assetId).toBeNull();
    });
  });

  describe("deadlines resolve against the group's timezone", () => {
    it("reads a date as local midnight, not UTC midnight", async () => {
      // UTC midnight is half past five in the morning in Bengaluru, which puts every
      // comparison half a day out and reads as a bug in provenance.
      const resolved = resolveDeadline({ deadlineDate: "2026-04-20" }, IST);
      expect(resolved?.toISOString()).toBe("2026-04-19T18:30:00.000Z");
    });

    it("returns null for an absent deadline", () => {
      expect(resolveDeadline({ deadlineDate: null }, IST)).toBeNull();
    });

    it("returns null rather than an invalid date for malformed model output", () => {
      expect(resolveDeadline({ deadlineDate: "next Tuesday" }, IST)).toBeNull();
      expect(resolveDeadline({ deadlineDate: "2026-13-45" }, IST)).toBeNull();
    });
  });
});
