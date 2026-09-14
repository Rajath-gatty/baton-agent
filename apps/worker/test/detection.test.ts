/**
 * The five detection queries — against real Postgres.
 *
 * The assertions here divide into three kinds, and the middle kind is the one worth
 * writing carefully:
 *
 *   - **Positive**: each query finds the thing it is for. Easy, and the least valuable.
 *   - **Exclusion**: each query does *not* find the things it must not. This is where
 *     detection bugs live, because a query that over-reports produces findings that read
 *     perfectly and quietly train a coordinator to ignore the register.
 *   - **F33**: a claim that is `pending_approval` or `unverified` is invisible to every
 *     one of them. Asserted per query rather than once, because the filter sits in a
 *     different join in each and a refactor can drop it from one without touching the
 *     others.
 *
 * The `sole_holder` suite includes the specific bug this query is easy to write: grouping
 * by asset *and* holder turns two holders of one asset into two groups of one, and both
 * get reported as sole holders. There is a test for exactly that shape.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { buildDedupeKey, contentHash, type FindingCandidate } from "@baton/core";
import { persistMessage } from "../src/store/messages.js";
import {
  LOOSE_END_UNDATED_DAYS,
  detectFindings,
  detectLooseEnds,
  detectNoOwnerAssets,
  detectNotOurs,
  detectSoleHolderAssets,
  detectSoleHolderCapabilities,
} from "../src/pipeline/detection.js";

const {
  assets,
  capabilities,
  capabilityCoverage,
  commitments,
  facts,
  findings,
  holdings,
  messages,
  people,
} = schema;

const CHAT_ID = -1001234567890;
const NOW = new Date("2026-06-01T10:00:00Z");

describe("detection", () => {
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

  // ── fixture helpers ────────────────────────────────────────────────────────

  async function message(text: string, sentAt = "2026-05-01T10:00:00Z"): Promise<string> {
    const persisted = await persistMessage(harness.db, {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: nextTelegramId++,
      senderTelegramUserId: 5001,
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
    });
    return persisted.id;
  }

  async function asset(
    name: string,
    kind:
      | "physical_item"
      | "account_login"
      | "financial_control"
      | "relationship" = "physical_item",
    sensitivity: "normal" | "sensitive" = "normal",
  ): Promise<string> {
    const rows = await harness.db
      .insert(assets)
      .values({ kind, name, normalisedKey: name.toLowerCase(), sensitivity })
      .returning({ id: assets.id });
    return rows[0]?.id as string;
  }

  async function fact(
    assetId: string | null,
    claim: string,
    status: "active" | "pending_approval" | "unverified" | "superseded" | "retired" = "active",
  ): Promise<string> {
    const sourceMessageId = await message(claim);
    const rows = await harness.db
      .insert(facts)
      .values({
        assetId,
        claim,
        matchKey: `k:${claim}`,
        confidence: 0.9,
        status,
        sourceMessageId,
        statedAt: new Date("2026-05-01T10:00:00Z"),
        lastConfirmedAt: new Date("2026-05-01T10:00:00Z"),
        evidenceMessageIds: [sourceMessageId],
      })
      .returning({ id: facts.id });
    return rows[0]?.id as string;
  }

  async function holding(input: {
    assetId: string;
    factId: string;
    holderPersonId?: string | null;
    holderExternal?: string | null;
    isPersonalResource?: boolean;
    status?: "active" | "released";
  }): Promise<string> {
    const rows = await harness.db
      .insert(holdings)
      .values({
        assetId: input.assetId,
        holderPersonId: input.holderPersonId ?? null,
        holderExternal: input.holderExternal ?? null,
        isPersonalResource: input.isPersonalResource ?? false,
        status: input.status ?? "active",
        acquiredAt: new Date("2026-05-01T10:00:00Z"),
        evidenceFactId: input.factId,
      })
      .returning({ id: holdings.id });
    return rows[0]?.id as string;
  }

  async function capability(name: string): Promise<string> {
    const rows = await harness.db
      .insert(capabilities)
      .values({ name, normalisedKey: name.toLowerCase() })
      .returning({ id: capabilities.id });
    return rows[0]?.id as string;
  }

  async function observe(capabilityId: string, personId: string): Promise<void> {
    const messageId = await message(`thanks for helping with it, ${personId.slice(0, 6)}`);
    await harness.db.insert(capabilityCoverage).values({
      capabilityId,
      personId,
      firstObservedAt: new Date("2026-05-01T10:00:00Z"),
      lastObservedAt: new Date("2026-05-01T10:00:00Z"),
      evidenceMessageIds: [messageId],
    });
  }

  async function commitment(input: {
    substance: string;
    ownerPersonId?: string | null;
    promisedAt: string;
    deadline?: string | null;
    status?: "open" | "completed" | "abandoned";
  }): Promise<string> {
    const sourceMessageId = await message(input.substance, input.promisedAt);
    const rows = await harness.db
      .insert(commitments)
      .values({
        substance: input.substance,
        ownerPersonId: input.ownerPersonId ?? null,
        promisedAt: new Date(input.promisedAt),
        deadline:
          input.deadline === undefined || input.deadline === null ? null : new Date(input.deadline),
        sourceMessageId,
        status: input.status ?? "open",
      })
      .returning({ id: commitments.id });
    return rows[0]?.id as string;
  }

  /** One asset held by exactly one person, the plain sole-holder shape. */
  async function soleHeldAsset(name: string, holderPersonId: string): Promise<string> {
    const assetId = await asset(name);
    const factId = await fact(assetId, `${name} is held by someone`);
    await holding({ assetId, factId, holderPersonId });
    return assetId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe("sole_holder — assets", () => {
    it("finds an asset exactly one person holds", async () => {
      const assetId = await soleHeldAsset("store room key", meera);

      const found = await detectSoleHolderAssets(harness.db);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: "asset",
        subtype: "sole_holder",
        subjectName: "store room key",
        subjectAssetId: assetId,
        subjectCapabilityId: null,
        subjectCommitmentId: null,
        holderPersonId: meera,
        holderDisplayName: "Meera Sundaram",
        assetKind: "physical_item",
        assetSensitivity: "normal",
      });
      expect(found[0]?.dedupeKey).toBe(
        buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: assetId }),
      );
      expect(found[0]?.evidenceFactIds).toHaveLength(1);
      expect(found[0]?.evidenceCount).toBe(1);
    });

    it("does not report an asset two people hold — as one finding or as two", async () => {
      const assetId = await asset("the projector");
      const first = await fact(assetId, "Meera has the projector");
      const second = await fact(assetId, "Anil has the projector too");
      await holding({ assetId, factId: first, holderPersonId: meera });
      await holding({ assetId, factId: second, holderPersonId: anil });

      // The bug this guards: grouping by asset AND holder makes two groups of one, and
      // both get reported. The finding that results reads perfectly.
      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
    });

    it("names an external holder even though they have no people row", async () => {
      const assetId = await asset("the clinic relationship", "relationship");
      const factId = await fact(assetId, "the clinic's accountant handles it");
      await holding({ assetId, factId, holderExternal: "the clinic's accountant" });

      const found = await detectSoleHolderAssets(harness.db);
      expect(found[0]?.holderPersonId).toBeNull();
      expect(found[0]?.holderDisplayName).toBe("the clinic's accountant");
    });

    it("ignores a personal resource, which is not_ours rather than a one-person risk", async () => {
      const assetId = await asset("the van");
      const factId = await fact(assetId, "Anil's van gets used for deliveries");
      await holding({ assetId, factId, holderPersonId: anil, isPersonalResource: true });

      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
      expect(await detectNotOurs(harness.db)).toHaveLength(1);
    });

    it("ignores a released holding", async () => {
      const assetId = await asset("the old key");
      const factId = await fact(assetId, "Meera used to have the old key");
      await holding({ assetId, factId, holderPersonId: meera, status: "released" });

      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
    });

    it("ignores a retired asset", async () => {
      const assetId = await soleHeldAsset("the fax machine", meera);
      await harness.db.update(assets).set({ status: "retired" }).where(eq(assets.id, assetId));

      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
    });

    it("does not treat a holding with no holder as one person holding it", async () => {
      const assetId = await asset("the petty cash tin");
      const factId = await fact(assetId, "nobody seems to have the petty cash tin");
      await holding({ assetId, factId });

      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
      // That shape is the no-owner finding instead.
      expect(await detectNoOwnerAssets(harness.db)).toHaveLength(1);
    });

    it("is blind to a holding whose claim is still pending approval", async () => {
      const assetId = await asset("the bank login", "account_login", "sensitive");
      const factId = await fact(assetId, "Meera has the bank login", "pending_approval");
      await holding({ assetId, factId, holderPersonId: meera });

      // F33. The holding exists; the claim behind it is not yet believed. Filtering on
      // `holdings.status` alone would let this through.
      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
    });

    it("is blind to a holding resting on hearsay", async () => {
      const assetId = await asset("the spare keys");
      const factId = await fact(assetId, "someone said Anil has the spare keys", "unverified");
      await holding({ assetId, factId, holderPersonId: anil });

      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
    });

    it("is blind to a holding whose claim was superseded", async () => {
      const assetId = await asset("the laptop");
      const factId = await fact(assetId, "Meera has the laptop", "superseded");
      await holding({ assetId, factId, holderPersonId: meera });

      expect(await detectSoleHolderAssets(harness.db)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("sole_holder — capabilities", () => {
    it("finds a capability exactly one person has been seen doing", async () => {
      const capabilityId = await capability("running the stall");
      await observe(capabilityId, meera);

      const found = await detectSoleHolderCapabilities(harness.db);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: "capability",
        subtype: "sole_holder",
        subjectName: "running the stall",
        subjectCapabilityId: capabilityId,
        subjectAssetId: null,
        holderPersonId: meera,
        holderDisplayName: "Meera Sundaram",
        assetKind: null,
        assetSensitivity: null,
        capabilityArea: "running the stall",
      });
      // Coverage is not derived from facts, so there is no fact to cite.
      expect(found[0]?.evidenceFactIds).toEqual([]);
      expect(found[0]?.evidenceMessageIds).toHaveLength(1);
    });

    it("does not report a capability two people have been seen doing", async () => {
      const capabilityId = await capability("setting up the sound");
      await observe(capabilityId, meera);
      await observe(capabilityId, anil);

      expect(await detectSoleHolderCapabilities(harness.db)).toHaveLength(0);
    });

    it("keeps a capability whose only person has left", async () => {
      const capabilityId = await capability("doing the accounts");
      await observe(capabilityId, meera);
      await harness.db
        .update(people)
        .set({ status: "left", leftAt: new Date("2026-05-20T10:00:00Z") })
        .where(eq(people.id, meera));

      // Still one observed person. Departure is the brief's surface, not a reason for the
      // capability to vanish from the register at its most fragile moment.
      expect(await detectSoleHolderCapabilities(harness.db)).toHaveLength(1);
    });

    it("gives an asset finding and a capability finding different keys", async () => {
      // The two queries that render as the same subtype. Sharing a key would make the
      // second overwrite the first.
      const assetId = await soleHeldAsset("store room key", meera);
      const capabilityId = await capability("running the stall");
      await observe(capabilityId, anil);

      const assetFinding = (await detectSoleHolderAssets(harness.db))[0];
      const capabilityFinding = (await detectSoleHolderCapabilities(harness.db))[0];

      expect(assetFinding?.dedupeKey).toBe(`sole_holder:asset:${assetId}`);
      expect(capabilityFinding?.dedupeKey).toBe(`sole_holder:capability:${capabilityId}`);
      expect(assetFinding?.dedupeKey).not.toBe(capabilityFinding?.dedupeKey);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("no_owner", () => {
    it("finds an active asset nobody holds", async () => {
      const assetId = await asset("the projector");
      await fact(assetId, "the projector lives in the cupboard");

      const found = await detectNoOwnerAssets(harness.db);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: "asset",
        subtype: "no_owner",
        subjectAssetId: assetId,
        holderPersonId: null,
        holderDisplayName: null,
      });
    });

    it("does not report an asset that has a holder", async () => {
      await soleHeldAsset("store room key", meera);
      expect(await detectNoOwnerAssets(harness.db)).toHaveLength(0);
    });

    it("reports an asset whose only holding was released", async () => {
      const assetId = await asset("the old key");
      const factId = await fact(assetId, "Meera used to have the old key");
      await holding({ assetId, factId, holderPersonId: meera, status: "released" });

      expect(await detectNoOwnerAssets(harness.db)).toHaveLength(1);
    });

    it("does not report an asset held only as someone's personal property", async () => {
      const assetId = await asset("the van");
      const factId = await fact(assetId, "Anil's van gets used for deliveries");
      await holding({ assetId, factId, holderPersonId: anil, isPersonalResource: true });

      // It has a holder. It is `not_ours`, which is a different observation.
      expect(await detectNoOwnerAssets(harness.db)).toHaveLength(0);
    });

    it("is silent about an asset whose only claim is pending approval", async () => {
      const assetId = await asset("the bank login", "account_login", "sensitive");
      await fact(assetId, "we opened a new bank login", "pending_approval");

      // F33 in its least obvious form: without an active claim there is nothing believed
      // about this asset, and reporting on it would put the pending change in front of a
      // coordinator by another route.
      expect(await detectNoOwnerAssets(harness.db)).toHaveLength(0);
    });

    it("gathers every active claim about the asset as evidence, de-duplicated", async () => {
      const assetId = await asset("the projector");
      await fact(assetId, "the projector lives in the cupboard");
      await fact(assetId, "the projector needs a new bulb");
      await fact(assetId, "an old note about the projector", "superseded");

      const found = await detectNoOwnerAssets(harness.db);

      expect(found).toHaveLength(1);
      // Two active claims, two messages. The superseded one contributes nothing.
      expect(found[0]?.evidenceFactIds).toHaveLength(2);
      expect(found[0]?.evidenceMessageIds).toHaveLength(2);
      expect(found[0]?.evidenceCount).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("not_ours", () => {
    it("finds an active holding flagged as personal property", async () => {
      const assetId = await asset("the van");
      const factId = await fact(assetId, "Anil's van gets used for deliveries");
      await holding({ assetId, factId, holderPersonId: anil, isPersonalResource: true });

      const found = await detectNotOurs(harness.db);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: "asset",
        subtype: "not_ours",
        subjectAssetId: assetId,
        holderPersonId: anil,
        holderDisplayName: "Anil Kumar",
      });
    });

    it("ignores an ordinary holding", async () => {
      await soleHeldAsset("store room key", meera);
      expect(await detectNotOurs(harness.db)).toHaveLength(0);
    });

    it("ignores a released personal holding", async () => {
      const assetId = await asset("the van");
      const factId = await fact(assetId, "Anil's van used to get used for deliveries");
      await holding({
        assetId,
        factId,
        holderPersonId: anil,
        isPersonalResource: true,
        status: "released",
      });

      expect(await detectNotOurs(harness.db)).toHaveLength(0);
    });

    it("is blind to a personal holding whose claim is unverified", async () => {
      const assetId = await asset("the van");
      const factId = await fact(assetId, "someone said the van is Anil's", "unverified");
      await holding({ assetId, factId, holderPersonId: anil, isPersonalResource: true });

      expect(await detectNotOurs(harness.db)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("loose_end", () => {
    it("finds an overdue dated promise", async () => {
      const commitmentId = await commitment({
        substance: "book the hall for the fundraiser",
        ownerPersonId: meera,
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-05-20T00:00:00Z",
      });

      const found = await detectLooseEnds(harness.db, NOW);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: "commitment",
        subtype: "loose_end",
        subjectName: "book the hall for the fundraiser",
        subjectCommitmentId: commitmentId,
        holderPersonId: meera,
        holderDisplayName: "Meera Sundaram",
        assetKind: null,
      });
      expect(found[0]?.evidenceFactIds).toEqual([]);
      expect(found[0]?.evidenceMessageIds).toHaveLength(1);
    });

    it("leaves a dated promise alone before its deadline", async () => {
      await commitment({
        substance: "book the hall",
        ownerPersonId: meera,
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-07-01T00:00:00Z",
      });

      expect(await detectLooseEnds(harness.db, NOW)).toHaveLength(0);
    });

    it("finds an undated intention once it is older than the threshold", async () => {
      const older = new Date(NOW.getTime() - (LOOSE_END_UNDATED_DAYS + 1) * 86_400_000);
      await commitment({
        substance: "sort out the printers",
        ownerPersonId: null,
        promisedAt: older.toISOString(),
      });

      const found = await detectLooseEnds(harness.db, NOW);

      expect(found).toHaveLength(1);
      // Unowned, and included deliberately: the loose end with no name attached is the one
      // most likely to be forgotten.
      expect(found[0]?.holderPersonId).toBeNull();
      expect(found[0]?.holderDisplayName).toBeNull();
    });

    it("leaves an undated intention alone while it is younger than the threshold", async () => {
      const recent = new Date(NOW.getTime() - (LOOSE_END_UNDATED_DAYS - 1) * 86_400_000);
      await commitment({
        substance: "sort out the printers",
        promisedAt: recent.toISOString(),
      });

      expect(await detectLooseEnds(harness.db, NOW)).toHaveLength(0);
    });

    it("ignores a completed promise however overdue it was", async () => {
      await commitment({
        substance: "book the hall",
        ownerPersonId: meera,
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-05-02T00:00:00Z",
        status: "completed",
      });

      expect(await detectLooseEnds(harness.db, NOW)).toHaveLength(0);
    });

    it("ignores an abandoned promise", async () => {
      await commitment({
        substance: "book the hall",
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-05-02T00:00:00Z",
        status: "abandoned",
      });

      expect(await detectLooseEnds(harness.db, NOW)).toHaveLength(0);
    });

    it("orders by when the promise came due", async () => {
      await commitment({
        substance: "the later one",
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-05-25T00:00:00Z",
      });
      await commitment({
        substance: "the earlier one",
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-05-05T00:00:00Z",
      });

      const found = await detectLooseEnds(harness.db, NOW);
      expect(found.map((candidate) => candidate.subjectName)).toEqual([
        "the earlier one",
        "the later one",
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the assembled candidate set", () => {
    /** One of each of the five, so the assembled set can be checked as a whole. */
    async function plantAllFive(): Promise<void> {
      await soleHeldAsset("store room key", meera);

      const capabilityId = await capability("running the stall");
      await observe(capabilityId, anil);

      const unowned = await asset("the projector");
      await fact(unowned, "the projector lives in the cupboard");

      const van = await asset("the van");
      const vanFact = await fact(van, "Anil's van gets used for deliveries");
      await holding({
        assetId: van,
        factId: vanFact,
        holderPersonId: anil,
        isPersonalResource: true,
      });

      await commitment({
        substance: "book the hall",
        ownerPersonId: meera,
        promisedAt: "2026-05-01T10:00:00Z",
        deadline: "2026-05-20T00:00:00Z",
      });
    }

    it("produces five candidates across four rendered subtypes", async () => {
      await plantAllFive();

      const { candidates } = await detectFindings(harness.db, NOW);

      expect(candidates).toHaveLength(5);
      expect(new Set(candidates.map((candidate) => candidate.subtype))).toEqual(
        new Set(["sole_holder", "no_owner", "not_ours", "loose_end"]),
      );
      // Five queries, four subtypes — `type` is the fifth distinction.
      expect(
        new Set(candidates.map((candidate) => `${candidate.subtype}:${candidate.type}`)).size,
      ).toBe(5);
    });

    it("gives every candidate exactly one subject", async () => {
      await plantAllFive();
      const { candidates } = await detectFindings(harness.db, NOW);

      for (const candidate of candidates) {
        const subjects = [
          candidate.subjectAssetId,
          candidate.subjectCapabilityId,
          candidate.subjectCommitmentId,
        ].filter((id) => id !== null);
        expect(subjects).toHaveLength(1);
      }
    });

    it("gives every candidate a unique dedupe key", async () => {
      await plantAllFive();
      const { candidates } = await detectFindings(harness.db, NOW);

      const keys = candidates.map((candidate) => candidate.dedupeKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("attaches quoted excerpts, redacted", async () => {
      const assetId = await asset("the bank login", "account_login", "sensitive");
      const sourceMessageId = await message("the bank login password is hunter2 by the way");
      const factRows = await harness.db
        .insert(facts)
        .values({
          assetId,
          claim: "Meera has the bank login",
          matchKey: "k:bank",
          confidence: 0.95,
          status: "active",
          sourceMessageId,
          statedAt: new Date("2026-05-01T10:00:00Z"),
          lastConfirmedAt: new Date("2026-05-01T10:00:00Z"),
          evidenceMessageIds: [sourceMessageId],
        })
        .returning({ id: facts.id });
      await holding({ assetId, factId: factRows[0]?.id as string, holderPersonId: meera });

      const { candidates } = await detectFindings(harness.db, NOW);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.evidenceExcerpts).toHaveLength(1);
      // This text reaches a model and can end up in a finding read aloud, so it is a
      // render surface.
      expect(candidates[0]?.evidenceExcerpts[0]).not.toContain("hunter2");
    });

    it("does not quote a withdrawn message", async () => {
      await soleHeldAsset("store room key", meera);
      await harness.db
        .update(messages)
        .set({ isWithdrawn: true, withdrawnAt: NOW })
        .where(eq(messages.isWithdrawn, false));

      const { candidates } = await detectFindings(harness.db, NOW);

      expect(candidates).toHaveLength(1);
      // Withdrawal is the coordinator's only remedy, so it has to actually remove the
      // quote. The finding itself survives — the register still knows the thing.
      expect(candidates[0]?.evidenceExcerpts).toEqual([]);
      expect(candidates[0]?.evidenceMessageIds).toHaveLength(1);
    });

    it("carries the severity a key held on the previous sweep", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      const dedupeKey = buildDedupeKey({
        subtype: "sole_holder",
        type: "asset",
        subjectId: assetId,
      });
      await harness.db.insert(findings).values({
        type: "asset",
        subtype: "sole_holder",
        dedupeKey,
        title: "Only one person holds the store room key",
        whyItMatters: "It matters.",
        severity: "medium",
        confidence: 0.8,
        subjectAssetId: assetId,
      });

      const { candidates } = await detectFindings(harness.db, NOW);

      // What gates Restraint on the findings path. Null would mean the key is new, and an
      // ungated Restraint would re-veto every settled item on every sweep forever.
      expect(candidates[0]?.previousSeverity).toBe("medium");
    });

    it("reports null previous severity for a key never seen before", async () => {
      await soleHeldAsset("store room key", meera);
      const { candidates } = await detectFindings(harness.db, NOW);
      expect(candidates[0]?.previousSeverity).toBeNull();
    });

    it("withholds a dismissed key before the Assessor sees it", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      await harness.db.insert(findings).values({
        type: "asset",
        subtype: "sole_holder",
        dedupeKey: buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: assetId }),
        title: "Only one person holds the store room key",
        whyItMatters: "It matters.",
        severity: "medium",
        confidence: 0.8,
        status: "dismissed",
        dismissalReason: "We already have a backup.",
        dismissedAt: new Date("2026-05-15T10:00:00Z"),
        subjectAssetId: assetId,
      });

      const { candidates, dismissedKeysSkipped } = await detectFindings(harness.db, NOW);

      // Judging it would spend a model call to produce a finding the upsert then refuses
      // to write, and the only observable effect would be the cost.
      expect(candidates).toHaveLength(0);
      expect(dismissedKeysSkipped).toBe(1);
    });

    it("still reports a resolved key whose condition has recurred", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      await harness.db.insert(findings).values({
        type: "asset",
        subtype: "sole_holder",
        dedupeKey: buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: assetId }),
        title: "Only one person holds the store room key",
        whyItMatters: "It matters.",
        severity: "medium",
        confidence: 0.8,
        status: "resolved",
        resolvedAt: new Date("2026-05-15T10:00:00Z"),
        subjectAssetId: assetId,
      });

      const { candidates, dismissedKeysSkipped } = await detectFindings(harness.db, NOW);

      // Only an explicit dismissal is a statement about the finding itself. A thing that
      // was fixed and came back is arguably the most worth surfacing.
      expect(candidates).toHaveLength(1);
      expect(dismissedKeysSkipped).toBe(0);
    });

    it("returns nothing at all from an empty register", async () => {
      const { candidates, dismissedKeysSkipped } = await detectFindings(harness.db, NOW);
      expect(candidates).toEqual([]);
      expect(dismissedKeysSkipped).toBe(0);
    });

    it("is stable across two identical runs", async () => {
      await plantAllFive();

      const keysOf = (candidates: FindingCandidate[]): string[] =>
        candidates.map((candidate) => candidate.dedupeKey);
      const first = await detectFindings(harness.db, NOW);
      const second = await detectFindings(harness.db, NOW);

      // A sweep fingerprint is computed over this, so ordering that varied with whatever
      // Postgres returned first would make the short-circuit useless.
      expect(keysOf(second.candidates)).toEqual(keysOf(first.candidates));
    });
  });
});
