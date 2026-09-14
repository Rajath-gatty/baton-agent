/**
 * The data API, against real Postgres with a small fixture organisation.
 *
 * The assertions that matter most here are the three refusals: a pending change must
 * not be searchable, a credential must not be quoted back, and a withdrawn message
 * must not still answer for a claim. Each would be invisible in normal use and each
 * ends up in text a human reads.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { REDACTION_PLACEHOLDER, contentHash, normaliseAlias, normaliseAssetKey } from "@baton/core";
import { getEvidence, getHoldings, getPerson, searchFacts } from "../src/store/data-api.js";

const { assets, facts, holdings, messages, people, personAliases } = schema;
const CHAT_ID = -1001234567890;

interface Fixture {
  meera: string;
  priyaR: string;
  priyaM: string;
  donationPage: string;
  van: string;
  clinic: string;
  settleFact: string;
  pageFact: string;
  settleMessage: string;
}

describe("the data API", () => {
  let harness: TestDatabase;
  let fx: Fixture;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  /**
   * A miniature of the real organisation: two people who share a first name, three
   * assets across three kinds, and a settlement claim with two messages behind it.
   */
  async function seedFixture(): Promise<Fixture> {
    const db = harness.db;

    const insertedPeople = await db
      .insert(people)
      .values([
        { displayName: "Meera Sundaram", status: "member" },
        { displayName: "Priya Raghavan", status: "member" },
        { displayName: "Priya Menon", status: "member" },
      ])
      .returning({ id: people.id, displayName: people.displayName });

    const idFor = (name: string): string => {
      const found = insertedPeople.find((row) => row.displayName === name);
      if (found === undefined) throw new Error(`fixture missing person ${name}`);
      return found.id;
    };
    const meera = idFor("Meera Sundaram");
    const priyaR = idFor("Priya Raghavan");
    const priyaM = idFor("Priya Menon");

    // Both Priyas answer to "Priya". This is the ambiguity the roster really contains.
    await db.insert(personAliases).values([
      {
        personId: meera,
        alias: "Meera",
        normalisedAlias: normaliseAlias("Meera"),
        kind: "first_name",
      },
      {
        personId: meera,
        alias: "@meera_s",
        normalisedAlias: normaliseAlias("@meera_s"),
        kind: "handle",
      },
      {
        personId: priyaR,
        alias: "Priya",
        normalisedAlias: normaliseAlias("Priya"),
        kind: "first_name",
      },
      {
        personId: priyaM,
        alias: "Priya",
        normalisedAlias: normaliseAlias("Priya"),
        kind: "first_name",
      },
    ]);

    const insertedAssets = await db
      .insert(assets)
      .values([
        {
          kind: "public_presence",
          name: "Razorpay donation page",
          normalisedKey: normaliseAssetKey("Razorpay donation page"),
          sensitivity: "sensitive",
        },
        {
          kind: "physical_item",
          name: "the van",
          normalisedKey: normaliseAssetKey("the van"),
        },
        {
          kind: "relationship",
          name: "Sunrise Clinic",
          normalisedKey: normaliseAssetKey("Sunrise Clinic"),
        },
      ])
      .returning({ id: assets.id, name: assets.name });

    const assetFor = (name: string): string => {
      const found = insertedAssets.find((row) => row.name === name);
      if (found === undefined) throw new Error(`fixture missing asset ${name}`);
      return found.id;
    };
    const donationPage = assetFor("Razorpay donation page");
    const van = assetFor("the van");
    const clinic = assetFor("Sunrise Clinic");

    const insertedMessages = await db
      .insert(messages)
      .values([
        {
          source: "seed",
          chatId: CHAT_ID,
          telegramMessageId: -100001,
          senderPersonId: meera,
          senderDisplayName: "Meera Sundaram",
          sentAt: new Date("2026-04-08T09:00:00Z"),
          text: "I set up the Razorpay donation page, password is hunter2trustno1",
          contentHash: contentHash("m1"),
        },
        {
          source: "seed",
          chatId: CHAT_ID,
          telegramMessageId: -100002,
          senderPersonId: priyaR,
          senderDisplayName: "Priya Raghavan",
          sentAt: new Date("2026-04-13T09:00:00Z"),
          text: "Sunrise Clinic lets us settle at month end",
          contentHash: contentHash("m2"),
        },
        {
          source: "seed",
          chatId: CHAT_ID,
          telegramMessageId: -100003,
          senderPersonId: priyaR,
          senderDisplayName: "Priya Raghavan",
          sentAt: new Date("2026-06-01T09:00:00Z"),
          text: "confirmed again with Sunrise, month end is fine",
          contentHash: contentHash("m3"),
        },
      ])
      .returning({ id: messages.id, telegramMessageId: messages.telegramMessageId });

    const messageFor = (telegramId: number): string => {
      const found = insertedMessages.find((row) => row.telegramMessageId === telegramId);
      if (found === undefined) throw new Error(`fixture missing message ${telegramId}`);
      return found.id;
    };
    const pageMessage = messageFor(-100001);
    const settleMessage = messageFor(-100002);
    const restatement = messageFor(-100003);

    const insertedFacts = await db
      .insert(facts)
      .values([
        {
          assetId: clinic,
          claim: "Sunrise Clinic lets us settle at month end",
          matchKey: "relationship:sunrise clinic#attribute",
          confidence: 0.9,
          status: "active",
          sourceMessageId: settleMessage,
          statedByPersonId: priyaR,
          statedAt: new Date("2026-04-13T09:00:00Z"),
          lastConfirmedAt: new Date("2026-06-01T09:00:00Z"),
          evidenceMessageIds: [settleMessage, restatement],
          curatorReasoning: "States a standing settlement arrangement",
        },
        {
          assetId: donationPage,
          claim: "Meera set up the Razorpay donation page",
          matchKey: "public_presence:razorpay donation page#holder",
          confidence: 0.85,
          status: "active",
          sensitivity: "sensitive",
          sourceMessageId: pageMessage,
          statedByPersonId: meera,
          statedAt: new Date("2026-04-08T09:00:00Z"),
          lastConfirmedAt: new Date("2026-04-08T09:00:00Z"),
          evidenceMessageIds: [pageMessage],
        },
        {
          assetId: van,
          claim: "the van will be signed over to the shelter",
          matchKey: "physical_item:van#attribute",
          confidence: 0.4,
          // Must never be searchable: a human has not agreed to it.
          status: "pending_approval",
          sourceMessageId: pageMessage,
          statedAt: new Date("2026-09-03T09:00:00Z"),
          lastConfirmedAt: new Date("2026-09-03T09:00:00Z"),
          evidenceMessageIds: [pageMessage],
        },
        {
          assetId: clinic,
          claim: "Divya said the clinic may close on Sundays",
          matchKey: "relationship:sunrise clinic#hearsay",
          confidence: 0.3,
          // Hearsay. Recorded, never presented as established.
          status: "unverified",
          sourceMessageId: pageMessage,
          statedAt: new Date("2026-07-01T09:00:00Z"),
          lastConfirmedAt: new Date("2026-07-01T09:00:00Z"),
          evidenceMessageIds: [pageMessage],
        },
      ])
      .returning({ id: facts.id, matchKey: facts.matchKey });

    const factFor = (key: string): string => {
      const found = insertedFacts.find((row) => row.matchKey === key);
      if (found === undefined) throw new Error(`fixture missing fact ${key}`);
      return found.id;
    };

    // The van changed hands: one closed row, one open row.
    await db.insert(holdings).values([
      {
        assetId: van,
        holderPersonId: meera,
        acquiredAt: new Date("2026-03-20T00:00:00Z"),
        releasedAt: new Date("2026-05-10T00:00:00Z"),
        status: "released",
        isPersonalResource: true,
      },
      {
        assetId: van,
        holderPersonId: priyaR,
        acquiredAt: new Date("2026-05-10T00:00:00Z"),
        status: "active",
        isPersonalResource: true,
      },
      {
        assetId: donationPage,
        holderPersonId: meera,
        acquiredAt: new Date("2026-04-08T00:00:00Z"),
        status: "active",
      },
      {
        assetId: clinic,
        holderExternal: "the clinic's accountant",
        acquiredAt: new Date("2026-04-01T00:00:00Z"),
        status: "active",
      },
    ]);

    return {
      meera,
      priyaR,
      priyaM,
      donationPage,
      van,
      clinic,
      settleFact: factFor("relationship:sunrise clinic#attribute"),
      pageFact: factFor("public_presence:razorpay donation page#holder"),
      settleMessage,
    };
  }

  beforeEach(async () => {
    await harness.truncate();
    fx = await seedFixture();
  });

  describe("searchFacts", () => {
    it("matches the claim text", async () => {
      const results = await searchFacts(harness.db, "settle");
      expect(results.map((row) => row.claim)).toEqual([
        "Sunrise Clinic lets us settle at month end",
      ]);
    });

    it("matches the asset's name, since that is how people refer to things", async () => {
      const results = await searchFacts(harness.db, "donation page");
      expect(results.map((row) => row.factId)).toContain(fx.pageFact);
    });

    it("never returns a pending change", async () => {
      // The promise that a pending change appears in nothing a human reads is
      // enforced here in SQL, not in prompt text.
      const results = await searchFacts(harness.db, "van");
      expect(results).toEqual([]);
    });

    it("never returns hearsay as an answerable claim", async () => {
      const results = await searchFacts(harness.db, "Sundays");
      expect(results).toEqual([]);
    });

    it("computes the age itself rather than leaving it to a model", async () => {
      // A staleness warning is unfalsifiable if the number in it was invented.
      const now = new Date("2026-09-14T09:00:00Z");
      const results = await searchFacts(harness.db, "settle", now);
      // last confirmed 2026-06-01, so 105 days.
      expect(results[0]?.ageDays).toBe(105);
      expect(results[0]?.lastConfirmedAt).toBe("2026-06-01T09:00:00.000Z");
    });

    it("reports every current holder rather than collapsing to one", async () => {
      const results = await searchFacts(harness.db, "donation page");
      expect(results[0]?.holders).toEqual([
        { personId: fx.meera, displayName: "Meera Sundaram", external: null },
      ]);
    });

    it("carries an external holder through", async () => {
      const results = await searchFacts(harness.db, "settle");
      expect(results[0]?.holders).toEqual([
        { personId: null, displayName: null, external: "the clinic's accountant" },
      ]);
    });

    it("does not multiply a fact row per holder", async () => {
      // The reason holders are stitched in code rather than joined.
      await harness.db
        .insert(holdings)
        .values({ assetId: fx.clinic, holderPersonId: fx.priyaM, status: "active" });
      const results = await searchFacts(harness.db, "settle");
      expect(results).toHaveLength(1);
      expect(results[0]?.holders).toHaveLength(2);
    });

    it("returns nothing for a blank query rather than the whole register", async () => {
      await expect(searchFacts(harness.db, "   ")).resolves.toEqual([]);
    });

    it("treats wildcard characters as literal text", async () => {
      // Without escaping, "%" would match every claim in the register.
      await expect(searchFacts(harness.db, "%")).resolves.toEqual([]);
    });
  });

  describe("getEvidence", () => {
    it("returns the messages a claim rests on, oldest first", async () => {
      const result = await getEvidence(harness.db, fx.settleFact);
      expect(result?.messages.map((row) => row.sentAt)).toEqual([
        "2026-04-13T09:00:00.000Z",
        "2026-06-01T09:00:00.000Z",
      ]);
      expect(result?.messages[0]?.senderDisplayName).toBe("Priya Raghavan");
    });

    it("carries the Curator's reasoning, so a strange finding is traceable", async () => {
      const result = await getEvidence(harness.db, fx.settleFact);
      expect(result?.curatorReasoning).toBe("States a standing settlement arrangement");
    });

    it("redacts a credential out of quoted text", async () => {
      // This response feeds a model and can reach a brief or an answer. A password
      // pasted into the group must not make that trip.
      const result = await getEvidence(harness.db, fx.pageFact);
      const text = result?.messages[0]?.text ?? "";
      expect(text).not.toContain("hunter2trustno1");
      expect(text).toContain(REDACTION_PLACEHOLDER);
      expect(text).toContain("Razorpay donation page");
    });

    it("does not quote a message whose provenance was withdrawn", async () => {
      // Withdrawal is the only remedy a coordinator has, since Telegram never
      // reports deletions. It has to actually remove the quote.
      await harness.db.update(messages).set({ isWithdrawn: true, withdrawnAt: new Date() });
      const result = await getEvidence(harness.db, fx.settleFact);
      expect(result?.messages).toEqual([]);
    });

    it("reports a missing claim rather than an empty one", async () => {
      await expect(
        getEvidence(harness.db, "00000000-0000-0000-0000-000000000000"),
      ).resolves.toBeNull();
    });

    it("rejects an id that is not a uuid without touching the database", async () => {
      // A malformed uuid is a Postgres error, not an empty result, so it is caught
      // before the query rather than surfacing as a 500 in a tool trace.
      await expect(getEvidence(harness.db, "not-a-uuid")).resolves.toBeNull();
    });
  });

  describe("getHoldings", () => {
    it("returns closed rows as well as open ones", async () => {
      // The whole reason this tool exists: an asset with no current holder may have
      // had one last month, and a transfer must be distinguishable from a gap.
      const result = await getHoldings(harness.db, fx.van);
      expect(result?.history).toHaveLength(2);
      expect(result?.history[0]).toMatchObject({
        displayName: "Meera Sundaram",
        status: "released",
        releasedAt: "2026-05-10T00:00:00.000Z",
      });
      expect(result?.history[1]).toMatchObject({
        displayName: "Priya Raghavan",
        status: "active",
        releasedAt: null,
      });
    });

    it("orders the history oldest first, so a transfer reads as a sequence", async () => {
      const result = await getHoldings(harness.db, fx.van);
      const acquired = result?.history.map((row) => row.acquiredAt);
      expect(acquired).toEqual(["2026-03-20T00:00:00.000Z", "2026-05-10T00:00:00.000Z"]);
    });

    it("marks a personal resource, which is not_ours rather than a risk", async () => {
      const result = await getHoldings(harness.db, fx.van);
      expect(result?.history.every((row) => row.isPersonalResource)).toBe(true);
    });

    it("accepts an asset name as well as an id", async () => {
      const byName = await getHoldings(harness.db, "the van");
      expect(byName?.assetId).toBe(fx.van);
    });

    it("finds an asset by name even when the article differs", async () => {
      const byName = await getHoldings(harness.db, "van");
      expect(byName?.assetId).toBe(fx.van);
    });

    it("reports an unknown asset rather than an empty history", async () => {
      // An empty history and a misspelled name mean very different things to the
      // agent, and conflating them invents a no-owner finding.
      await expect(getHoldings(harness.db, "the helicopter")).resolves.toBeNull();
    });
  });

  describe("getPerson", () => {
    it("returns every person a first name could mean", async () => {
      // Two volunteers really are both called Priya. Returning a best guess would
      // convert the ambiguity signal into a silent wrong answer about who holds what.
      const results = await getPerson(harness.db, "Priya");
      expect(results.map((row) => row.displayName).sort()).toEqual([
        "Priya Menon",
        "Priya Raghavan",
      ]);
    });

    it("resolves a handle to one person", async () => {
      const results = await getPerson(harness.db, "@meera_s");
      expect(results).toHaveLength(1);
      expect(results[0]?.personId).toBe(fx.meera);
    });

    it("normalises the alias, so punctuation and case do not matter", async () => {
      await expect(getPerson(harness.db, "  MEERA! ")).resolves.toHaveLength(1);
    });

    it("finds a person by display name even with no alias rows", async () => {
      await harness.db.delete(personAliases);
      const results = await getPerson(harness.db, "priya menon");
      expect(results.map((row) => row.personId)).toEqual([fx.priyaM]);
    });

    it("collects the aliases that matched, one row per person", async () => {
      const results = await getPerson(harness.db, "Meera");
      expect(results).toHaveLength(1);
      expect(results[0]?.matchedAliases).toEqual(["Meera"]);
    });

    it("returns nothing for a name it does not know", async () => {
      await expect(getPerson(harness.db, "Nobody")).resolves.toEqual([]);
    });

    it("returns nothing for a blank alias", async () => {
      await expect(getPerson(harness.db, "!!!")).resolves.toEqual([]);
    });
  });
});
