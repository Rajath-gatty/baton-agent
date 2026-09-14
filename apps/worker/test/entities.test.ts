/**
 * Turning an ingest result into rows.
 *
 * The load-bearing assertion is the coordinate system: `recordIndex` counts records
 * across the flattened list, several attributions share one index, and matching them up
 * by mention is what stops a holding landing on the wrong person. That failure is
 * silent — the register just quietly says someone else holds the money.
 *
 * The second is refusal. An ambiguous mention must produce a question, never a holding.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { contentHash, normaliseAlias } from "@baton/core";
import type {
  CartographerAttribution,
  CuratorMessageResult,
  CuratorRecord,
  IngestResult,
} from "@baton/core";
import { flattenRecords, upsertEntitiesFromIngest } from "../src/pipeline/entities.js";
import { classifyAlias } from "../src/store/people.js";
import { persistMessage } from "../src/store/messages.js";
import { upsertAsset, upsertCapability } from "../src/store/assets.js";

const { assets, capabilities, personAliases, people } = schema;
const CHAT_ID = -1001234567890;

function record(overrides: Partial<CuratorRecord> = {}): CuratorRecord {
  return {
    kind: "durable_fact",
    claim: "Meera set up the Razorpay donation page",
    confidence: 0.9,
    assetKind: "public_presence",
    assetName: "Razorpay donation page",
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

function attribution(overrides: Partial<CartographerAttribution> = {}): CartographerAttribution {
  return {
    recordIndex: 0,
    mention: "Meera",
    resolution: "resolved",
    personId: null,
    candidatePersonIds: [],
    externalName: null,
    isPersonalResource: false,
    confidence: 1,
    reasoning: "Matched the alias table by exact match.",
    ...overrides,
  };
}

function ingest(
  results: CuratorMessageResult[],
  attributions: CartographerAttribution[],
): IngestResult {
  return { curator: { results }, cartographer: { attributions } };
}

function messageResult(messageId: string, records: CuratorRecord[]): CuratorMessageResult {
  return { messageId, classification: "durable_fact", reasoning: "States who set it up", records };
}

describe("the record coordinate system", () => {
  it("counts records across messages, one increment per record", () => {
    // Mirrors `collectMentions` in the agent. If these disagree, attributions land on
    // the wrong records and the register fills with confident nonsense.
    const result = ingest(
      [
        messageResult("m1", [record({ claim: "a" }), record({ claim: "b" })]),
        messageResult("m2", [record({ claim: "c" })]),
      ],
      [],
    );

    expect(
      flattenRecords(result).map((entry) => [entry.index, entry.messageId, entry.record.claim]),
    ).toEqual([
      [0, "m1", "a"],
      [1, "m1", "b"],
      [2, "m2", "c"],
    ]);
  });

  it("is empty for a batch that was all noise", () => {
    const result = ingest(
      [{ messageId: "m1", classification: "noise", reasoning: "a joke", records: [] }],
      [],
    );
    expect(flattenRecords(result)).toEqual([]);
  });
});

describe("classifyAlias", () => {
  it("recognises a handle", () => {
    expect(classifyAlias("@priya_pc", "Priya Raghavan")).toBe("handle");
  });

  it("recognises a full name", () => {
    expect(classifyAlias("Priya Raghavan", "Priya Raghavan")).toBe("display_name");
  });

  it("tells a first name from a nickname using the recorded name", () => {
    expect(classifyAlias("Priya", "Priya Raghavan")).toBe("first_name");
    expect(classifyAlias("Pri", "Priya Raghavan")).toBe("nickname");
  });

  it("recognises a role reference, which must never be learned", () => {
    // Roles change hands. Learning one would resolve every later mention of the
    // coordinator to whoever held it once, exactly, with no escalation.
    expect(classifyAlias("the coordinator", "Priya Raghavan")).toBe("role_reference");
    expect(classifyAlias("coordinator", "Priya Raghavan")).toBe("role_reference");
    expect(classifyAlias("the treasurer", "Meera Sundaram")).toBe("role_reference");
  });
});

describe("upserting entities from an ingest result", () => {
  let harness: TestDatabase;
  let meera: string;
  let priyaR: string;
  let priyaM: string;
  let messageId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.truncate();

    const inserted = await harness.db
      .insert(people)
      .values([
        { displayName: "Meera Sundaram", status: "member" },
        { displayName: "Priya Raghavan", status: "member" },
        { displayName: "Priya Menon", status: "member" },
      ])
      .returning({ id: people.id, displayName: people.displayName });

    const idFor = (name: string): string => {
      const found = inserted.find((row) => row.displayName === name);
      if (found === undefined) throw new Error(`fixture missing ${name}`);
      return found.id;
    };
    meera = idFor("Meera Sundaram");
    priyaR = idFor("Priya Raghavan");
    priyaM = idFor("Priya Menon");

    const stored = await persistMessage(harness.db, {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: 4021,
      senderTelegramUserId: 1,
      senderDisplayName: "Meera Sundaram",
      sentAt: new Date("2026-04-08T09:00:00Z"),
      text: "I set up the Razorpay donation page",
      contentHash: contentHash("I set up the Razorpay donation page"),
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedAt: null,
      isUnprocessed: false,
      mediaKind: null,
    });
    messageId = stored.id;
  });

  it("creates the asset a claim refers to", async () => {
    const result = await upsertEntitiesFromIngest(
      harness.db,
      ingest([messageResult(messageId, [record()])], [attribution({ personId: meera })]),
    );

    expect(result.assetsCreated).toBe(1);
    expect(result.records[0]?.assetId).not.toBeNull();

    const rows = await harness.db.select().from(assets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Razorpay donation page");
    expect(rows[0]?.normalisedKey).toBe("razorpay donation page");
  });

  it("reuses an asset already known, however it was spelled", async () => {
    await upsertAsset(harness.db, { kind: "physical_item", name: "the van" });

    const result = await upsertEntitiesFromIngest(
      harness.db,
      ingest(
        [
          messageResult(messageId, [
            record({ assetKind: "physical_item", assetName: "Van", holderMention: null }),
          ]),
        ],
        [],
      ),
    );

    expect(result.assetsCreated).toBe(0);
    await expect(harness.db.select().from(assets)).resolves.toHaveLength(1);
  });

  it("ratchets sensitivity up and never back down", async () => {
    // Sensitivity drives approval routing. A downgrade would send an approval about
    // financial control to the group instead of privately to the coordinator.
    await upsertAsset(harness.db, {
      kind: "financial_control",
      name: "bank signatory",
      sensitivity: "sensitive",
    });

    await upsertEntitiesFromIngest(
      harness.db,
      ingest(
        [
          messageResult(messageId, [
            record({
              assetKind: "financial_control",
              assetName: "bank signatory",
              sensitivity: "normal",
              holderMention: null,
            }),
          ]),
        ],
        [],
      ),
    );

    const rows = await harness.db.select({ sensitivity: assets.sensitivity }).from(assets);
    expect(rows[0]?.sensitivity).toBe("sensitive");
  });

  it("raises sensitivity when a later record says it is sensitive", async () => {
    await upsertAsset(harness.db, { kind: "account_login", name: "clinic portal" });

    await upsertEntitiesFromIngest(
      harness.db,
      ingest(
        [
          messageResult(messageId, [
            record({
              assetKind: "account_login",
              assetName: "clinic portal",
              sensitivity: "sensitive",
              holderMention: null,
            }),
          ]),
        ],
        [],
      ),
    );

    const rows = await harness.db.select({ sensitivity: assets.sensitivity }).from(assets);
    expect(rows[0]?.sensitivity).toBe("sensitive");
  });

  it("creates a capability a record names", async () => {
    const result = await upsertEntitiesFromIngest(
      harness.db,
      ingest(
        [
          messageResult(messageId, [
            record({
              kind: "participation_evidence",
              assetKind: null,
              assetName: null,
              holderMention: null,
              capabilityName: "Foster placement",
              subjectMentions: [],
            }),
          ]),
        ],
        [],
      ),
    );

    expect(result.capabilitiesCreated).toBe(1);
    const rows = await harness.db.select().from(capabilities);
    expect(rows[0]?.normalisedKey).toBe("foster placement");
    expect(result.records[0]?.capabilityId).toBe(rows[0]?.id);
  });

  it("reuses a capability already known", async () => {
    await upsertCapability(harness.db, "foster placement");
    const result = await upsertEntitiesFromIngest(
      harness.db,
      ingest(
        [
          messageResult(messageId, [
            record({
              assetKind: null,
              assetName: null,
              holderMention: null,
              capabilityName: "Foster Placement",
            }),
          ]),
        ],
        [],
      ),
    );
    expect(result.capabilitiesCreated).toBe(0);
  });

  it("creates nothing for a record naming neither an asset nor a capability", async () => {
    const result = await upsertEntitiesFromIngest(
      harness.db,
      ingest(
        [
          messageResult(messageId, [
            record({ assetKind: null, assetName: null, capabilityName: null, holderMention: null }),
          ]),
        ],
        [],
      ),
    );
    expect(result.assetsCreated).toBe(0);
    expect(result.capabilitiesCreated).toBe(0);
    expect(result.records[0]?.assetId).toBeNull();
    expect(result.records[0]?.capabilityId).toBeNull();
  });

  describe("resolving the holder", () => {
    it("resolves a person the Cartographer identified", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest([messageResult(messageId, [record()])], [attribution({ personId: meera })]),
      );

      expect(result.records[0]?.holder).toEqual({
        kind: "person",
        personId: meera,
        isPersonalResource: false,
        confidence: 1,
      });
    });

    it("carries the personal-resource flag, which is not_ours rather than a risk", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [
              record({ holderMention: "Anil", assetName: "the van", assetKind: "physical_item" }),
            ]),
          ],
          [attribution({ mention: "Anil", personId: priyaR, isPersonalResource: true })],
        ),
      );

      expect(result.records[0]?.holder).toMatchObject({ kind: "person", isPersonalResource: true });
    });

    it("records an external holder as a name, not a person", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "the clinic's accountant" })])],
          [
            attribution({
              mention: "the clinic's accountant",
              resolution: "external",
              externalName: "the clinic's accountant",
              confidence: 0.8,
            }),
          ],
        ),
      );

      expect(result.records[0]?.holder).toEqual({
        kind: "external",
        name: "the clinic's accountant",
        isPersonalResource: false,
        confidence: 0.8,
      });
    });

    it("reports no holder when the record names none", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest([messageResult(messageId, [record({ holderMention: null })])], []),
      );
      expect(result.records[0]?.holder).toEqual({ kind: "none" });
    });

    it("refuses to guess an ambiguous holder, and asks instead", async () => {
      // Two volunteers are both Priya. Writing a holding here would be a coin flip
      // about who holds something, and a wrong guess is invisible once written.
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "Priya" })])],
          [
            attribution({
              mention: "Priya",
              resolution: "ambiguous",
              candidatePersonIds: [priyaR, priyaM],
              confidence: 0.4,
              reasoning:
                "Two people answer to this first name and the message does not distinguish them.",
            }),
          ],
        ),
      );

      expect(result.records[0]?.holder).toMatchObject({
        kind: "unresolved",
        reason: "ambiguous",
        candidatePersonIds: [priyaR, priyaM],
      });
      expect(result.unresolved).toHaveLength(1);
      expect(result.unresolved[0]?.mention).toBe("Priya");
    });

    it("treats cannot_determine as a question too", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "someone from the shelter" })])],
          [
            attribution({
              mention: "someone from the shelter",
              resolution: "cannot_determine",
              confidence: 0.1,
              reasoning: "Nothing in the message identifies a person.",
            }),
          ],
        ),
      );
      expect(result.records[0]?.holder).toMatchObject({
        kind: "unresolved",
        reason: "cannot_determine",
      });
    });

    it("treats a missing attribution as unsettled rather than absent", async () => {
      // Silence from the Cartographer is not permission to guess.
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest([messageResult(messageId, [record({ holderMention: "Meera" })])], []),
      );
      expect(result.records[0]?.holder).toMatchObject({
        kind: "unresolved",
        reason: "cannot_determine",
      });
      expect(result.unresolved).toHaveLength(1);
    });

    it("refuses a resolved attribution that names nobody", async () => {
      // Self-contradictory output. Picking a candidate would be worse than asking.
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record()])],
          [attribution({ resolution: "resolved", personId: null, candidatePersonIds: [meera] })],
        ),
      );
      expect(result.records[0]?.holder).toMatchObject({ kind: "unresolved" });
    });
  });

  describe("resolving participation subjects", () => {
    it("collects everyone a thanks-list names", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [
              record({
                kind: "participation_evidence",
                assetKind: null,
                assetName: null,
                holderMention: null,
                capabilityName: "microchipping",
                subjectMentions: ["Meera", "Priya Raghavan"],
              }),
            ]),
          ],
          [
            attribution({ mention: "Meera", personId: meera }),
            attribution({ mention: "Priya Raghavan", personId: priyaR }),
          ],
        ),
      );

      expect(result.records[0]?.subjectPersonIds).toEqual([meera, priyaR]);
    });

    it("leaves out a subject it could not identify, and asks about them", async () => {
      // Inventing coverage would be worse than the gap it leaves.
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [
              record({
                kind: "participation_evidence",
                assetKind: null,
                assetName: null,
                holderMention: null,
                capabilityName: "microchipping",
                subjectMentions: ["Meera", "Priya"],
              }),
            ]),
          ],
          [
            attribution({ mention: "Meera", personId: meera }),
            attribution({
              mention: "Priya",
              resolution: "ambiguous",
              candidatePersonIds: [priyaR, priyaM],
              reasoning: "Two people answer to this first name.",
            }),
          ],
        ),
      );

      expect(result.records[0]?.subjectPersonIds).toEqual([meera]);
      expect(result.unresolved.map((entry) => entry.mention)).toEqual(["Priya"]);
    });

    it("does not count the holder twice when they are also listed as a subject", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [
              record({
                holderMention: "Meera",
                subjectMentions: ["Meera"],
                capabilityName: "microchipping",
              }),
            ]),
          ],
          [attribution({ mention: "Meera", personId: meera })],
        ),
      );

      expect(result.records[0]?.holder).toMatchObject({ kind: "person", personId: meera });
      expect(result.records[0]?.subjectPersonIds).toEqual([]);
    });
  });

  describe("attributions across several records", () => {
    it("applies each attribution to the record it belongs to", async () => {
      // The failure this prevents: a holding landing on the wrong person, silently.
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [
              record({
                claim: "Meera set up the page",
                holderMention: "Meera",
                assetName: "donation page",
              }),
              record({
                claim: "Anil has the van keys",
                holderMention: "Anil",
                assetName: "van keys",
                assetKind: "physical_item",
              }),
            ]),
          ],
          [
            attribution({ recordIndex: 0, mention: "Meera", personId: meera }),
            attribution({ recordIndex: 1, mention: "Anil", personId: priyaR }),
          ],
        ),
      );

      expect(result.records[0]?.holder).toMatchObject({ personId: meera });
      expect(result.records[1]?.holder).toMatchObject({ personId: priyaR });
    });

    it("keeps records from different messages apart", async () => {
      const second = await persistMessage(harness.db, {
        source: "telegram",
        chatId: CHAT_ID,
        telegramMessageId: 4022,
        senderTelegramUserId: 1,
        senderDisplayName: "Meera Sundaram",
        sentAt: new Date("2026-04-09T09:00:00Z"),
        text: "Anil has the van keys",
        contentHash: contentHash("Anil has the van keys"),
        replyToTelegramMessageId: null,
        isForwarded: false,
        forwardedFrom: null,
        isEdited: false,
        editedAt: null,
        isUnprocessed: false,
        mediaKind: null,
      });

      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [record()]),
            messageResult(second.id, [
              record({ holderMention: "Anil", assetName: "van keys", assetKind: "physical_item" }),
            ]),
          ],
          [
            attribution({ recordIndex: 0, mention: "Meera", personId: meera }),
            attribution({ recordIndex: 1, mention: "Anil", personId: priyaR }),
          ],
        ),
      );

      expect(result.records[0]?.messageId).toBe(messageId);
      expect(result.records[1]?.messageId).toBe(second.id);
    });
  });

  describe("learning alias forms", () => {
    it("records a nickname the Cartographer resolved", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "Pri" })])],
          [attribution({ mention: "Pri", personId: priyaR, confidence: 0.9 })],
        ),
      );

      expect(result.aliasesLearned).toBe(1);
      const rows = await harness.db
        .select({
          alias: personAliases.alias,
          kind: personAliases.kind,
          normalised: personAliases.normalisedAlias,
        })
        .from(personAliases)
        .where(eq(personAliases.personId, priyaR));
      expect(rows[0]).toMatchObject({ alias: "Pri", kind: "nickname", normalised: "pri" });
    });

    it("never learns a role reference", async () => {
      // The hazard: the coordinator changes, and a learned alias would resolve to the
      // old one exactly, forever, without escalating.
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "the coordinator" })])],
          [attribution({ mention: "the coordinator", personId: priyaR })],
        ),
      );

      expect(result.aliasesLearned).toBe(0);
      await expect(harness.db.select().from(personAliases)).resolves.toHaveLength(0);
    });

    it("does not learn from an unresolved mention", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "Priya" })])],
          [
            attribution({
              mention: "Priya",
              resolution: "ambiguous",
              candidatePersonIds: [priyaR, priyaM],
            }),
          ],
        ),
      );
      expect(result.aliasesLearned).toBe(0);
      await expect(harness.db.select().from(personAliases)).resolves.toHaveLength(0);
    });

    it("writes one alias row however many records mention it", async () => {
      const result = await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [
            messageResult(messageId, [
              record({ holderMention: "Pri", claim: "one" }),
              record({
                holderMention: "Pri",
                claim: "two",
                assetName: "van",
                assetKind: "physical_item",
              }),
            ]),
          ],
          [
            attribution({ recordIndex: 0, mention: "Pri", personId: priyaR }),
            attribution({ recordIndex: 1, mention: "Pri", personId: priyaR }),
          ],
        ),
      );

      expect(result.aliasesLearned).toBe(1);
    });

    it("is idempotent — a second ingest learns nothing new", async () => {
      const payload = ingest(
        [messageResult(messageId, [record({ holderMention: "Pri" })])],
        [attribution({ mention: "Pri", personId: priyaR })],
      );

      await upsertEntitiesFromIngest(harness.db, payload);
      const second = await upsertEntitiesFromIngest(harness.db, payload);

      expect(second.aliasesLearned).toBe(0);
      await expect(harness.db.select().from(personAliases)).resolves.toHaveLength(1);
    });

    it("lets two people keep the same first name", async () => {
      // Not unique on the alias, deliberately: the collision is the ambiguity signal.
      await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "Priya" })])],
          [attribution({ mention: "Priya", personId: priyaR })],
        ),
      );
      await upsertEntitiesFromIngest(
        harness.db,
        ingest(
          [messageResult(messageId, [record({ holderMention: "Priya" })])],
          [attribution({ mention: "Priya", personId: priyaM })],
        ),
      );

      const rows = await harness.db
        .select({ personId: personAliases.personId })
        .from(personAliases)
        .where(eq(personAliases.normalisedAlias, normaliseAlias("Priya")));
      expect(rows.map((row) => row.personId).sort()).toEqual([priyaR, priyaM].sort());
    });
  });
});
