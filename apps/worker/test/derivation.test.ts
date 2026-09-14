/**
 * Holdings, commitments and coverage — against real Postgres.
 *
 * Three guarantees are asserted here that nothing else would catch:
 *
 *   - A transfer leaves a **closed** row behind. Without it, an asset with no current
 *     holder is indistinguishable from one that changed hands cleanly, and "who held the
 *     van keys in March" becomes unanswerable.
 *   - `capability_coverage` has **no count column**. Someone seen ten times has one row,
 *     so the register genuinely cannot report how often anyone turns up.
 *   - Closure needs completion language *and* real overlap. A false close silently drops a
 *     loose end nobody is tracking any more.
 */

import { eq, getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, type CuratorRecord, type NormalisedMessage } from "@baton/core";
import {
  applyHolding,
  countActiveHolders,
  countUnownedHoldings,
  releaseHoldingsForPerson,
} from "../src/store/holdings.js";
import {
  CLOSURE_OVERLAP_THRESHOLD,
  applyCommitment,
  detectCommitmentClosure,
  markCommitmentAsked,
  selectOpenCommitments,
  substanceOverlap,
} from "../src/store/commitments.js";
import { applyCoverage, countObservedPeople, hasBeenObserved } from "../src/store/coverage.js";
import { applyFact } from "../src/store/facts.js";
import { upsertAsset, upsertCapability } from "../src/store/assets.js";
import { persistMessage } from "../src/store/messages.js";
import type { HolderResolution } from "../src/pipeline/entities.js";

const { capabilityCoverage, commitments, holdings } = schema;
const CHAT_ID = -1001234567890;
const IST = "Asia/Kolkata";

function person(personId: string, isPersonalResource = false): HolderResolution {
  return { kind: "person", personId, isPersonalResource, confidence: 1 };
}

function record(overrides: Partial<CuratorRecord> = {}): CuratorRecord {
  return {
    kind: "durable_fact",
    claim: "Meera has the van keys",
    confidence: 0.9,
    assetKind: "physical_item",
    assetName: "van keys",
    sensitivity: "normal",
    holderMention: "Meera",
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

describe("derivation", () => {
  let harness: TestDatabase;
  let meera: string;
  let anil: string;
  let divya: string;
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
      .insert(schema.people)
      .values([
        { displayName: "Meera Sundaram", status: "member" },
        { displayName: "Anil Kumar", status: "member" },
        { displayName: "Divya Nair", status: "member" },
      ])
      .returning({ id: schema.people.id, displayName: schema.people.displayName });
    const idFor = (name: string): string => {
      const found = inserted.find((row) => row.displayName === name);
      if (found === undefined) throw new Error(`fixture missing ${name}`);
      return found.id;
    };
    meera = idFor("Meera Sundaram");
    anil = idFor("Anil Kumar");
    divya = idFor("Divya Nair");
  });

  async function message(text: string, sentAt: string, senderPersonId?: string): Promise<string> {
    const normalised: NormalisedMessage = {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: nextTelegramId++,
      senderTelegramUserId: null,
      senderDisplayName: "Someone",
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
    const stored = await persistMessage(
      harness.db,
      normalised,
      senderPersonId === undefined ? {} : { senderPersonId },
    );
    return stored.id;
  }

  describe("holdings as history", () => {
    it("opens a holding on the first record of who holds something", async () => {
      const asset = await upsertAsset(harness.db, { kind: "physical_item", name: "van keys" });
      const messageId = await message("Meera has the van keys", "2026-03-20T09:00:00Z");
      const fact = await applyFact(harness.db, {
        record: record(),
        holder: person(meera),
        assetId: asset.id,
        messageId,
        statedAt: new Date("2026-03-20T09:00:00Z"),
        statedByPersonId: meera,
        timezone: IST,
      });

      const result = await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(meera),
        factOutcome: fact.outcome,
        factId: fact.factId,
        at: new Date("2026-03-20T09:00:00Z"),
      });

      expect(result.outcome).toBe("opened");
      const rows = await harness.db.select().from(holdings);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ holderPersonId: meera, status: "active", releasedAt: null });
    });

    it("closes one row and opens another when an asset changes hands", async () => {
      // The row that makes a clean handover distinguishable from a genuine gap.
      const asset = await upsertAsset(harness.db, { kind: "physical_item", name: "van keys" });

      const first = await message("Meera has the van keys", "2026-03-20T09:00:00Z");
      const firstFact = await applyFact(harness.db, {
        record: record(),
        holder: person(meera),
        assetId: asset.id,
        messageId: first,
        statedAt: new Date("2026-03-20T09:00:00Z"),
        statedByPersonId: meera,
        timezone: IST,
      });
      await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(meera),
        factOutcome: firstFact.outcome,
        factId: firstFact.factId,
        at: new Date("2026-03-20T09:00:00Z"),
      });

      const moved = await message("Anil has the van keys now", "2026-05-10T09:00:00Z");
      const movedFact = await applyFact(harness.db, {
        record: record({ claim: "Anil has the van keys", holderMention: "Anil" }),
        holder: person(anil),
        assetId: asset.id,
        messageId: moved,
        statedAt: new Date("2026-05-10T09:00:00Z"),
        statedByPersonId: anil,
        timezone: IST,
      });
      expect(movedFact.outcome).toBe("superseded");

      const transfer = await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(anil),
        factOutcome: movedFact.outcome,
        factId: movedFact.factId,
        supersededFactId: movedFact.supersededFactId,
        at: new Date("2026-05-10T09:00:00Z"),
      });

      expect(transfer.outcome).toBe("transferred");
      expect(transfer.closedHoldingIds).toHaveLength(1);

      const rows = await harness.db.select().from(holdings).orderBy(holdings.acquiredAt);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ holderPersonId: meera, status: "released" });
      expect(rows[0]?.releasedAt?.toISOString()).toBe("2026-05-10T09:00:00.000Z");
      expect(rows[1]).toMatchObject({ holderPersonId: anil, status: "active", releasedAt: null });
      // "Who held the van keys in March" is still answerable.
      expect(rows[0]?.acquiredAt?.toISOString()).toBe("2026-03-20T09:00:00.000Z");
      await expect(countActiveHolders(harness.db, asset.id)).resolves.toBe(1);
    });

    it("changes nothing when the same holder is stated again", async () => {
      const asset = await upsertAsset(harness.db, { kind: "physical_item", name: "van keys" });
      const first = await message("Meera has the van keys", "2026-03-20T09:00:00Z");
      const fact = await applyFact(harness.db, {
        record: record(),
        holder: person(meera),
        assetId: asset.id,
        messageId: first,
        statedAt: new Date("2026-03-20T09:00:00Z"),
        statedByPersonId: meera,
        timezone: IST,
      });
      await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(meera),
        factOutcome: fact.outcome,
        factId: fact.factId,
        at: new Date("2026-03-20T09:00:00Z"),
      });

      const again = await message("the van keys are with Meera", "2026-06-01T09:00:00Z");
      const merged = await applyFact(harness.db, {
        record: record({ claim: "the van keys are with Meera" }),
        holder: person(meera),
        assetId: asset.id,
        messageId: again,
        statedAt: new Date("2026-06-01T09:00:00Z"),
        statedByPersonId: meera,
        timezone: IST,
      });
      const result = await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(meera),
        factOutcome: merged.outcome,
        factId: merged.factId,
        at: new Date("2026-06-01T09:00:00Z"),
      });

      expect(result.outcome).toBe("unchanged");
      const rows = await harness.db.select().from(holdings);
      expect(rows).toHaveLength(1);
      // A restatement must not rewrite when they got it.
      expect(rows[0]?.acquiredAt?.toISOString()).toBe("2026-03-20T09:00:00.000Z");
    });

    it("closes the holding when the arrangement is ended", async () => {
      const asset = await upsertAsset(harness.db, { kind: "relationship", name: "Sunrise Clinic" });
      const first = await message("Meera is our contact at Sunrise", "2026-03-20T09:00:00Z");
      const fact = await applyFact(harness.db, {
        record: record({ assetKind: "relationship", assetName: "Sunrise Clinic" }),
        holder: person(meera),
        assetId: asset.id,
        messageId: first,
        statedAt: new Date("2026-03-20T09:00:00Z"),
        statedByPersonId: meera,
        timezone: IST,
      });
      await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(meera),
        factOutcome: fact.outcome,
        factId: fact.factId,
        at: new Date("2026-03-20T09:00:00Z"),
      });

      const ended = await message("that arrangement has ended", "2026-08-01T09:00:00Z");
      const retired = await applyFact(harness.db, {
        record: record({
          assetKind: "relationship",
          assetName: "Sunrise Clinic",
          isNegation: true,
        }),
        holder: person(meera),
        assetId: asset.id,
        messageId: ended,
        statedAt: new Date("2026-08-01T09:00:00Z"),
        statedByPersonId: meera,
        timezone: IST,
      });

      const result = await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(meera),
        factOutcome: retired.outcome,
        factId: retired.factId,
        at: new Date("2026-08-01T09:00:00Z"),
      });

      expect(result.outcome).toBe("released");
      const rows = await harness.db.select().from(holdings);
      // Closed, not deleted.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("released");
      await expect(countActiveHolders(harness.db, asset.id)).resolves.toBe(0);
    });

    it("records an external holder without inventing a person", async () => {
      const asset = await upsertAsset(harness.db, {
        kind: "document",
        name: "vaccination records",
      });
      const messageId = await message("the clinic keeps the records", "2026-04-01T09:00:00Z");
      const holder: HolderResolution = {
        kind: "external",
        name: "the clinic's accountant",
        isPersonalResource: false,
        confidence: 0.8,
      };
      const fact = await applyFact(harness.db, {
        record: record({
          assetKind: "document",
          assetName: "vaccination records",
          holderMention: "the clinic",
        }),
        holder,
        assetId: asset.id,
        messageId,
        statedAt: new Date("2026-04-01T09:00:00Z"),
        statedByPersonId: null,
        timezone: IST,
      });
      await applyHolding(harness.db, {
        assetId: asset.id,
        holder,
        factOutcome: fact.outcome,
        factId: fact.factId,
        at: new Date("2026-04-01T09:00:00Z"),
      });

      const rows = await harness.db.select().from(holdings);
      expect(rows[0]).toMatchObject({
        holderPersonId: null,
        holderExternal: "the clinic's accountant",
      });
      await expect(countActiveHolders(harness.db, asset.id)).resolves.toBe(1);
    });

    it("marks a personal resource, which is not_ours rather than a risk", async () => {
      const asset = await upsertAsset(harness.db, { kind: "physical_item", name: "the van" });
      const messageId = await message("the van is Anil's own car", "2026-04-01T09:00:00Z");
      const fact = await applyFact(harness.db, {
        record: record({
          assetName: "the van",
          claim: "the van is Anil's own car",
          holderMention: "Anil",
        }),
        holder: person(anil, true),
        assetId: asset.id,
        messageId,
        statedAt: new Date("2026-04-01T09:00:00Z"),
        statedByPersonId: anil,
        timezone: IST,
      });
      await applyHolding(harness.db, {
        assetId: asset.id,
        holder: person(anil, true),
        factOutcome: fact.outcome,
        factId: fact.factId,
        at: new Date("2026-04-01T09:00:00Z"),
      });

      const rows = await harness.db
        .select({ personal: holdings.isPersonalResource })
        .from(holdings);
      expect(rows[0]?.personal).toBe(true);
    });

    it("refuses to record a holding for a holder it could not identify", async () => {
      // A coin flip about who holds something is invisible once written.
      const asset = await upsertAsset(harness.db, { kind: "physical_item", name: "van keys" });
      const result = await applyHolding(harness.db, {
        assetId: asset.id,
        holder: {
          kind: "unresolved",
          reason: "ambiguous",
          candidatePersonIds: [meera, anil],
          mention: "Priya",
        },
        factOutcome: "inserted",
        factId: null,
        at: new Date("2026-04-01T09:00:00Z"),
      });

      expect(result.outcome).toBe("skipped");
      await expect(harness.db.select().from(holdings)).resolves.toHaveLength(0);
    });

    it("records nothing for a claim about no asset", async () => {
      const result = await applyHolding(harness.db, {
        assetId: null,
        holder: person(meera),
        factOutcome: "inserted",
        factId: null,
        at: new Date("2026-04-01T09:00:00Z"),
      });
      expect(result.outcome).toBe("skipped");
    });

    it("counts an unowned open row as no holder at all", async () => {
      // Null holder is the no-owner finding, not missing data.
      const asset = await upsertAsset(harness.db, {
        kind: "public_presence",
        name: "donation page",
      });
      await harness.db.insert(holdings).values({ assetId: asset.id, status: "active" });

      await expect(countActiveHolders(harness.db, asset.id)).resolves.toBe(0);
      await expect(countUnownedHoldings(harness.db, asset.id)).resolves.toBe(1);
    });

    it("releases a person's holdings only when explicitly asked", async () => {
      // Not on departure: a departure is exactly when the register must still say what
      // they held, because that is the content of the brief.
      const asset = await upsertAsset(harness.db, { kind: "physical_item", name: "van keys" });
      await harness.db
        .insert(holdings)
        .values({ assetId: asset.id, holderPersonId: meera, status: "active" });

      const released = await releaseHoldingsForPerson(
        harness.db,
        meera,
        new Date("2026-06-18T10:00:00Z"),
      );
      expect(released).toBe(1);
      const rows = await harness.db.select({ status: holdings.status }).from(holdings);
      expect(rows[0]?.status).toBe("released");
    });
  });

  describe("commitments", () => {
    it("records a dated promise with its deadline at local midnight", async () => {
      const messageId = await message(
        "I'll call the printers tomorrow",
        "2026-04-19T09:00:00Z",
        anil,
      );
      const result = await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "call the printers",
          assetKind: null,
          assetName: null,
          holderMention: "Anil",
          deadlineText: "tomorrow",
          deadlineDate: "2026-04-20",
        }),
        holder: person(anil),
        messageId,
        statedAt: new Date("2026-04-19T09:00:00Z"),
        timezone: IST,
      });

      expect(result).toMatchObject({ outcome: "recorded", unowned: false, undated: false });
      const rows = await harness.db.select().from(commitments);
      expect(rows[0]?.ownerPersonId).toBe(anil);
      // Local midnight in Bengaluru, not UTC midnight.
      expect(rows[0]?.deadline?.toISOString()).toBe("2026-04-19T18:30:00.000Z");
    });

    it("records an undated intention, and says it is undated", async () => {
      // The absence of a date is the point: a brief asks someone to consciously decide
      // about it rather than inherit it by accident.
      const messageId = await message(
        "I'll sort the printers at some point",
        "2026-09-09T09:00:00Z",
        anil,
      );
      const result = await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "sort the printers",
          assetKind: null,
          assetName: null,
          holderMention: "Anil",
        }),
        holder: person(anil),
        messageId,
        statedAt: new Date("2026-09-09T09:00:00Z"),
        timezone: IST,
      });

      expect(result.undated).toBe(true);
      const rows = await harness.db.select({ deadline: commitments.deadline }).from(commitments);
      expect(rows[0]?.deadline).toBeNull();
    });

    it("records an unowned intent rather than guessing who promised", async () => {
      const messageId = await message("someone should sort the printers", "2026-09-09T09:00:00Z");
      const result = await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "sort the printers",
          assetKind: null,
          assetName: null,
          holderMention: null,
        }),
        holder: { kind: "none" },
        messageId,
        statedAt: new Date("2026-09-09T09:00:00Z"),
        timezone: IST,
      });

      expect(result.unowned).toBe(true);
      const rows = await harness.db.select({ owner: commitments.ownerPersonId }).from(commitments);
      expect(rows[0]?.owner).toBeNull();
    });

    it("leaves a commitment unowned when the promiser could not be identified", async () => {
      // A wrongly attributed promise is a promise put in someone's mouth.
      const messageId = await message("Priya will call them", "2026-09-09T09:00:00Z");
      const result = await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "call the printers",
          assetKind: null,
          assetName: null,
          holderMention: "Priya",
        }),
        holder: {
          kind: "unresolved",
          reason: "ambiguous",
          candidatePersonIds: [meera, anil],
          mention: "Priya",
        },
        messageId,
        statedAt: new Date("2026-09-09T09:00:00Z"),
        timezone: IST,
      });
      expect(result.unowned).toBe(true);
    });

    it("does not duplicate on a crash replay of the same message", async () => {
      const messageId = await message("I'll call the printers", "2026-04-19T09:00:00Z", anil);
      const args = {
        record: record({
          kind: "commitment" as const,
          claim: "call the printers",
          assetKind: null,
          assetName: null,
        }),
        holder: person(anil),
        messageId,
        statedAt: new Date("2026-04-19T09:00:00Z"),
        timezone: IST,
      };

      const first = await applyCommitment(harness.db, args);
      const second = await applyCommitment(harness.db, args);

      expect(first.outcome).toBe("recorded");
      expect(second.outcome).toBe("duplicate");
      expect(second.commitmentId).toBe(first.commitmentId);
      await expect(harness.db.select().from(commitments)).resolves.toHaveLength(1);
    });

    it("asks about a commitment only once", async () => {
      // Ask-once-then-stop enforced in data, because a prompt cannot remember that it
      // already asked and a timestamp can.
      const messageId = await message("I'll call the printers", "2026-04-19T09:00:00Z", anil);
      const commitment = await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "call the printers",
          assetKind: null,
          assetName: null,
        }),
        holder: person(anil),
        messageId,
        statedAt: new Date("2026-04-19T09:00:00Z"),
        timezone: IST,
      });

      const first = await markCommitmentAsked(
        harness.db,
        commitment.commitmentId as string,
        new Date(),
      );
      const second = await markCommitmentAsked(
        harness.db,
        commitment.commitmentId as string,
        new Date(),
      );
      expect([first, second]).toEqual([true, false]);
    });

    it("lists open commitments, oldest first", async () => {
      const later = await message("I'll fix the gate", "2026-06-01T09:00:00Z", anil);
      const earlier = await message("I'll call the printers", "2026-04-19T09:00:00Z", anil);
      await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "fix the gate",
          assetKind: null,
          assetName: null,
        }),
        holder: person(anil),
        messageId: later,
        statedAt: new Date("2026-06-01T09:00:00Z"),
        timezone: IST,
      });
      await applyCommitment(harness.db, {
        record: record({
          kind: "commitment",
          claim: "call the printers",
          assetKind: null,
          assetName: null,
        }),
        holder: person(anil),
        messageId: earlier,
        statedAt: new Date("2026-04-19T09:00:00Z"),
        timezone: IST,
      });

      const open = await selectOpenCommitments(harness.db);
      expect(open.map((row) => row.substance)).toEqual(["call the printers", "fix the gate"]);
    });
  });

  describe("noticing a promise was kept", () => {
    /** Records a promise by `anil` and returns its id. */
    async function promise(
      substance: string,
      at: string,
      owner: string | null = anil,
    ): Promise<string> {
      const messageId = await message(`promise: ${substance}`, at, owner ?? undefined);
      const applied = await applyCommitment(harness.db, {
        record: record({ kind: "commitment", claim: substance, assetKind: null, assetName: null }),
        holder: owner === null ? { kind: "none" } : person(owner),
        messageId,
        statedAt: new Date(at),
        timezone: IST,
      });
      return applied.commitmentId as string;
    }

    it("closes a promise the owner reports as done", async () => {
      const id = await promise("call the printers about the poster order", "2026-04-19T09:00:00Z");
      const report = await message("called the printers, all sorted", "2026-04-21T09:00:00Z", anil);

      const result = await detectCommitmentClosure(harness.db, {
        messageId: report,
        text: "called the printers, all sorted",
        sentAt: new Date("2026-04-21T09:00:00Z"),
        personId: anil,
      });

      expect(result.closed.map((entry) => entry.commitmentId)).toEqual([id]);
      const rows = await harness.db.select().from(commitments).where(eq(commitments.id, id));
      expect(rows[0]?.status).toBe("completed");
      expect(rows[0]?.completionEvidenceMessageId).toBe(report);
      expect(rows[0]?.closedAt?.toISOString()).toBe("2026-04-21T09:00:00.000Z");
    });

    it("needs completion language, not just the subject matter", async () => {
      await promise("call the printers about the poster order", "2026-04-19T09:00:00Z");
      const chatter = await message(
        "the printers are on Brigade Road",
        "2026-04-21T09:00:00Z",
        anil,
      );

      const result = await detectCommitmentClosure(harness.db, {
        messageId: chatter,
        text: "the printers are on Brigade Road",
        sentAt: new Date("2026-04-21T09:00:00Z"),
        personId: anil,
      });

      expect(result.soundedComplete).toBe(false);
      expect(result.closed).toEqual([]);
    });

    it("needs real overlap, not just the word done", async () => {
      // A bare "done" must not close every open promise in the register.
      await promise("call the printers about the poster order", "2026-04-19T09:00:00Z");
      const vague = await message("done", "2026-04-21T09:00:00Z", anil);

      const result = await detectCommitmentClosure(harness.db, {
        messageId: vague,
        text: "done",
        sentAt: new Date("2026-04-21T09:00:00Z"),
        personId: anil,
      });

      expect(result.soundedComplete).toBe(true);
      expect(result.closed).toEqual([]);
    });

    it("does not let one person close another's promise", async () => {
      // Reporting that someone else's promise is done is hearsay about a commitment, and
      // closing on it takes a loose end off the register on a third party's word.
      const id = await promise(
        "call the printers about the poster order",
        "2026-04-19T09:00:00Z",
        anil,
      );
      const report = await message(
        "called the printers, all sorted",
        "2026-04-21T09:00:00Z",
        divya,
      );

      const result = await detectCommitmentClosure(harness.db, {
        messageId: report,
        text: "called the printers, all sorted",
        sentAt: new Date("2026-04-21T09:00:00Z"),
        personId: divya,
      });

      expect(result.closed).toEqual([]);
      const rows = await harness.db
        .select({ status: commitments.status })
        .from(commitments)
        .where(eq(commitments.id, id));
      expect(rows[0]?.status).toBe("open");
    });

    it("lets anyone close an unowned intent", async () => {
      // Which is what makes "someone should sort the printers" / "sorted the printers"
      // work at all.
      const id = await promise(
        "sort the printers about the poster order",
        "2026-04-19T09:00:00Z",
        null,
      );
      const report = await message(
        "sorted the printers, poster order done",
        "2026-04-21T09:00:00Z",
        divya,
      );

      const result = await detectCommitmentClosure(harness.db, {
        messageId: report,
        text: "sorted the printers, poster order done",
        sentAt: new Date("2026-04-21T09:00:00Z"),
        personId: divya,
      });

      expect(result.closed.map((entry) => entry.commitmentId)).toEqual([id]);
    });

    it("never closes a promise with a message that predates it", async () => {
      // Backfill replays six months in order; without the bound, a promise could be
      // closed by something said before it was made.
      const id = await promise("call the printers about the poster order", "2026-06-01T09:00:00Z");
      const earlier = await message(
        "called the printers, all sorted",
        "2026-04-01T09:00:00Z",
        anil,
      );

      const result = await detectCommitmentClosure(harness.db, {
        messageId: earlier,
        text: "called the printers, all sorted",
        sentAt: new Date("2026-04-01T09:00:00Z"),
        personId: anil,
      });

      expect(result.closed).toEqual([]);
      const rows = await harness.db
        .select({ status: commitments.status })
        .from(commitments)
        .where(eq(commitments.id, id));
      expect(rows[0]?.status).toBe("open");
    });

    it("does nothing for a message with no text", async () => {
      await promise("call the printers about the poster order", "2026-04-19T09:00:00Z");
      const result = await detectCommitmentClosure(harness.db, {
        messageId: await message("x", "2026-04-21T09:00:00Z", anil),
        text: null,
        sentAt: new Date("2026-04-21T09:00:00Z"),
        personId: anil,
      });
      expect(result).toEqual({ closed: [], soundedComplete: false });
    });

    describe("substanceOverlap", () => {
      it("scores a close paraphrase above the threshold", () => {
        expect(
          substanceOverlap(
            "call the printers about the poster order",
            "called the printers, poster order sorted",
          ),
        ).toBeGreaterThanOrEqual(CLOSURE_OVERLAP_THRESHOLD);
      });

      it("scores an unrelated report below it", () => {
        expect(
          substanceOverlap(
            "call the printers about the poster order",
            "sent the photos to the vet",
          ),
        ).toBeLessThan(CLOSURE_OVERLAP_THRESHOLD);
      });

      it("scores a bare acknowledgement at zero", () => {
        expect(substanceOverlap("call the printers about the poster order", "done")).toBe(0);
      });

      it("is zero when the promise has no content words to match", () => {
        expect(substanceOverlap("do it", "done")).toBe(0);
      });

      it("matches across tense, because a promise and its fulfilment differ in tense", () => {
        // The bug this caught: "call the printers" against "called the printers" scored
        // 0.25 and closed nothing, because "call" and "called" are different strings.
        expect(substanceOverlap("call the printers", "called the printers")).toBe(1);
        expect(substanceOverlap("collect the food order", "collected the food order")).toBe(1);
      });

      it("matches across singular and plural", () => {
        expect(substanceOverlap("fix the printer", "fixed the printers")).toBe(1);
      });
    });
  });

  describe("capability coverage", () => {
    it("records everyone a thanks-list named", async () => {
      const capability = await upsertCapability(harness.db, "microchipping");
      const messageId = await message(
        "Thanks Anil and Meera for yesterday",
        "2026-05-01T09:00:00Z",
      );

      const result = await applyCoverage(harness.db, {
        capabilityId: capability.id,
        personIds: [anil, meera],
        observedAt: new Date("2026-05-01T09:00:00Z"),
        messageId,
      });

      expect(result).toEqual({ added: 2, widened: 0 });
      await expect(countObservedPeople(harness.db, capability.id)).resolves.toBe(2);
    });

    it("keeps one row per person however many times they are seen", async () => {
      // The register genuinely cannot report how often anyone turns up.
      const capability = await upsertCapability(harness.db, "microchipping");
      for (const day of ["2026-05-01", "2026-05-08", "2026-05-15"]) {
        const messageId = await message(`thanks Anil for ${day}`, `${day}T09:00:00Z`);
        await applyCoverage(harness.db, {
          capabilityId: capability.id,
          personIds: [anil],
          observedAt: new Date(`${day}T09:00:00Z`),
          messageId,
        });
      }

      const rows = await harness.db.select().from(capabilityCoverage);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.evidenceMessageIds).toHaveLength(3);
    });

    it("widens the observation window in whichever direction the message falls", async () => {
      const capability = await upsertCapability(harness.db, "microchipping");
      const middle = await message("thanks Anil", "2026-05-08T09:00:00Z");
      const later = await message("thanks Anil again", "2026-07-01T09:00:00Z");
      const earlier = await message("thanks Anil back then", "2026-03-20T09:00:00Z");

      await applyCoverage(harness.db, {
        capabilityId: capability.id,
        personIds: [anil],
        observedAt: new Date("2026-05-08T09:00:00Z"),
        messageId: middle,
      });
      await applyCoverage(harness.db, {
        capabilityId: capability.id,
        personIds: [anil],
        observedAt: new Date("2026-07-01T09:00:00Z"),
        messageId: later,
      });
      // Out of order, as backfill can deliver.
      const widened = await applyCoverage(harness.db, {
        capabilityId: capability.id,
        personIds: [anil],
        observedAt: new Date("2026-03-20T09:00:00Z"),
        messageId: earlier,
      });

      expect(widened).toEqual({ added: 0, widened: 1 });
      const rows = await harness.db.select().from(capabilityCoverage);
      expect(rows[0]?.firstObservedAt?.toISOString()).toBe("2026-03-20T09:00:00.000Z");
      expect(rows[0]?.lastObservedAt?.toISOString()).toBe("2026-07-01T09:00:00.000Z");
    });

    it("does not record the same message as evidence twice", async () => {
      const capability = await upsertCapability(harness.db, "microchipping");
      const messageId = await message("thanks Anil", "2026-05-01T09:00:00Z");
      const args = {
        capabilityId: capability.id,
        personIds: [anil],
        observedAt: new Date("2026-05-01T09:00:00Z"),
        messageId,
      };
      await applyCoverage(harness.db, args);
      await applyCoverage(harness.db, args);

      const rows = await harness.db.select().from(capabilityCoverage);
      expect(rows[0]?.evidenceMessageIds).toEqual([messageId]);
    });

    it("reports exactly one participant, which is the capability sole_holder case", async () => {
      const capability = await upsertCapability(harness.db, "microchipping");
      const messageId = await message("thanks Divya", "2026-05-01T09:00:00Z");
      await applyCoverage(harness.db, {
        capabilityId: capability.id,
        personIds: [divya],
        observedAt: new Date("2026-05-01T09:00:00Z"),
        messageId,
      });

      await expect(countObservedPeople(harness.db, capability.id)).resolves.toBe(1);
      await expect(hasBeenObserved(harness.db, capability.id, divya)).resolves.toBe(true);
      await expect(hasBeenObserved(harness.db, capability.id, anil)).resolves.toBe(false);
    });

    it("records nothing for an empty participant list", async () => {
      const capability = await upsertCapability(harness.db, "microchipping");
      const messageId = await message("thanks everyone", "2026-05-01T09:00:00Z");
      const result = await applyCoverage(harness.db, {
        capabilityId: capability.id,
        personIds: [],
        observedAt: new Date("2026-05-01T09:00:00Z"),
        messageId,
      });
      expect(result).toEqual({ added: 0, widened: 0 });
    });

    it("has no column that could count or rank anyone", () => {
      // The privacy guarantee, asserted against the table itself rather than trusted.
      // There is nowhere to write a completion rate, a reliability figure or an
      // activity metric even if a later feature wanted one.
      const columns = Object.keys(getTableColumns(capabilityCoverage));
      expect(columns.sort()).toEqual([
        "capabilityId",
        "createdAt",
        "evidenceMessageIds",
        "firstObservedAt",
        "id",
        "lastObservedAt",
        "personId",
      ]);
    });
  });
});
