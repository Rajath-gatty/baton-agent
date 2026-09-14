/**
 * The processing loop — against real Postgres and a fake agent.
 *
 * Four assertions carry this file, and each of them is about something invisible when
 * it breaks:
 *
 *   - **A cache hit forms no batch.** The only way to test a cache is to assert the
 *     question was never asked, so the fake agent records every request and the test
 *     asserts on the recording rather than on a hit count the code reports about itself.
 *   - **Batch composition may change without changing a cached classification.** Batches
 *     are formed from misses only, so composition changes on every run. If a cached
 *     result were ever re-derived from a differently-composed batch, six months of
 *     backfill would quietly stop being reproducible.
 *   - **Two passes serialise on the lock.** Asserted by holding one model call open
 *     while a second pass tries to start, because two passes that merely never happened
 *     to overlap prove nothing.
 *   - **The `ingest` context carries no fact index.** Reads like a strange thing to test
 *     until someone adds it to make the Curator smarter and silently poisons every
 *     cached classification.
 */

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import {
  AliasIndex,
  CURATOR_PROMPT_VERSION,
  INGEST_BATCH_SIZE,
  PREFILTER_VERSION,
  contentHash,
  type AliasEntry,
  type CandidateMessage,
  type IngestResult,
  type NormalisedMessage,
} from "@baton/core";
import { persistMessage } from "../src/store/messages.js";
import { storeCuratorCache } from "../src/store/curator-cache.js";
import { findRun } from "../src/store/runs.js";
import { hydrateIngestContext } from "../src/pipeline/hydrate.js";
import { splitIngestResult } from "../src/pipeline/ingest-result.js";
import { attributeRecords } from "../src/pipeline/attribute.js";
import { runIngestPass } from "../src/pipeline/processing-loop.js";
import {
  FailingAgent,
  FakeAgent,
  curatorRecord,
  curatorResult,
  resolveAllTo,
  type IngestResponder,
} from "./helpers/fake-agent.js";

const { appSettings, curatorCache, facts, holdings, messages, people, personAliases } = schema;
const CHAT_ID = -1001234567890;

describe("the processing loop", () => {
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

    await harness.db
      .insert(appSettings)
      .values({ id: 1, chatId: CHAT_ID, orgName: "Kolam Collective", timezone: "Asia/Kolkata" });

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

  /**
   * Persists a message and marks it a candidate.
   *
   * The verdict is set directly rather than by running the pre-filter, so a test about
   * the processing loop cannot fail because the pre-filter's rules moved.
   */
  async function candidate(text: string, sentAt: string): Promise<string> {
    const normalised: NormalisedMessage = {
      source: "telegram",
      chatId: CHAT_ID,
      telegramMessageId: nextTelegramId++,
      senderTelegramUserId: 5001,
      senderDisplayName: "Priya Raghavan",
      sentAt: new Date(sentAt),
      text,
      contentHash: contentHash(text),
      replyToTelegramMessageId: null,
      isForwarded: false,
      forwardedFrom: null,
      isEdited: false,
      editedAt: null,
      isUnprocessed: false,
      mediaKind: null,
    };
    const persisted = await persistMessage(harness.db, normalised);
    await harness.db
      .update(messages)
      .set({ prefilterVerdict: "candidate", prefilterVersion: PREFILTER_VERSION })
      .where(eq(messages.id, persisted.id));
    return persisted.id;
  }

  async function alias(personId: string, aliasText: string): Promise<void> {
    await harness.db.insert(personAliases).values({
      personId,
      alias: aliasText,
      normalisedAlias: aliasText.toLowerCase(),
      kind: "first_name",
    });
  }

  async function factRows(): Promise<{ claim: string; sourceMessageId: string | null }[]> {
    return harness.db
      .select({ claim: facts.claim, sourceMessageId: facts.sourceMessageId })
      .from(facts)
      .orderBy(facts.statedAt);
  }

  // ───────────────────────────────────────────────────────────────────────────
  describe("the cache, before batches exist", () => {
    it("forms no batch at all when every candidate is cached", async () => {
      const messageId = await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      const hash = contentHash("Meera has the store room key");

      // Cached against a *different* message id, which is the realistic case: the same
      // text curated on an earlier run.
      await storeCuratorCache(
        harness.db,
        [{ contentHash: hash, result: curatorResult("a-previous-message", [curatorRecord()]) }],
        CURATOR_PROMPT_VERSION,
      );
      await alias(meera, "Meera");

      const agent = new FakeAgent(resolveAllTo(meera));
      const result = await runIngestPass({ db: harness.db, transport: agent });

      expect(agent.requests).toHaveLength(0);
      expect(result.batches).toBe(0);
      expect(result.cacheHits).toBe(1);
      expect(result.cacheMisses).toBe(0);
      expect(result.messagesCurated).toBe(1);

      // And the register was still written, from the cached records.
      const rows = await factRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.claim).toBe("Meera holds the store room key");
      // Rebound: provenance points at the message being processed, not the one whose id
      // the cache happened to be storing.
      expect(rows[0]?.sourceMessageId).toBe(messageId);
    });

    it("batches only the misses when a pass is part cached", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      const freshId = await candidate("Anil has the projector", "2026-03-02T10:00:00Z");

      await storeCuratorCache(
        harness.db,
        [
          {
            contentHash: contentHash("Meera has the store room key"),
            result: curatorResult("older", [curatorRecord()]),
          },
        ],
        CURATOR_PROMPT_VERSION,
      );
      await alias(meera, "Meera");

      const agent = new FakeAgent(resolveAllTo(anil));
      const result = await runIngestPass({ db: harness.db, transport: agent });

      expect(result.cacheHits).toBe(1);
      expect(result.cacheMisses).toBe(1);
      expect(agent.requests).toHaveLength(1);
      expect(agent.requests[0]?.messageIds).toEqual([freshId]);
    });

    it("splits misses into batches of ten, in sent_at order", async () => {
      const ids: string[] = [];
      for (let index = 0; index < INGEST_BATCH_SIZE + 3; index += 1) {
        // Two-digit day so lexical and chronological order agree in the assertion.
        const day = String(index + 1).padStart(2, "0");
        ids.push(await candidate(`message number ${index}`, `2026-03-${day}T10:00:00Z`));
      }

      const agent = new FakeAgent(resolveAllTo(meera));
      const result = await runIngestPass({ db: harness.db, transport: agent });

      expect(result.batches).toBe(2);
      expect(agent.requests[0]?.messageIds).toHaveLength(INGEST_BATCH_SIZE);
      expect(agent.requests[1]?.messageIds).toHaveLength(3);
      expect([
        ...(agent.requests[0]?.messageIds ?? []),
        ...(agent.requests[1]?.messageIds ?? []),
      ]).toEqual(ids);
    });

    it("stores one cache row per message, keyed on content", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      await candidate("Anil has the projector", "2026-03-02T10:00:00Z");

      await runIngestPass({ db: harness.db, transport: new FakeAgent(resolveAllTo(meera)) });

      const cached = await harness.db
        .select({ hash: curatorCache.contentHash, classification: curatorCache.classification })
        .from(curatorCache);
      expect(cached).toHaveLength(2);
      // Lifted out of the jsonb so "how much of six months was noise" is one query.
      expect(cached.every((row) => row.classification === "durable_fact")).toBe(true);
    });

    it("counts two identical messages as one cache row", async () => {
      await candidate("thanks everyone", "2026-03-01T10:00:00Z");
      // Same text, different telegram id: one content hash, two rows in `messages`.
      await candidate("thanks everyone", "2026-03-02T10:00:00Z");

      const agent = new FakeAgent((batch) => ({
        curator: { results: batch.map((message) => curatorResult(message.messageId, [])) },
        cartographer: { attributions: [] },
      }));
      await runIngestPass({ db: harness.db, transport: agent });

      const cached = await harness.db.select({ hash: curatorCache.contentHash }).from(curatorCache);
      expect(cached).toHaveLength(1);
      expect(agent.requests[0]?.messageIds).toHaveLength(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("batch composition and cached classifications", () => {
    it("leaves a cached classification untouched when its neighbours change", async () => {
      const first = await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      const second = await candidate("Anil has the projector", "2026-03-02T10:00:00Z");
      await alias(meera, "Meera");
      await alias(anil, "Anil");

      // Run one: both are misses, one batch of two.
      const runOne = new FakeAgent((batch) => {
        const results = batch.map((message, index) =>
          curatorResult(message.messageId, [
            curatorRecord({
              claim: `claim ${index}`,
              assetName: `asset ${index}`,
              holderMention: index === 0 ? "Meera" : "Anil",
            }),
          ]),
        );
        return {
          curator: { results },
          cartographer: {
            attributions: results.map((_result, index) => ({
              recordIndex: index,
              mention: index === 0 ? "Meera" : "Anil",
              resolution: "resolved" as const,
              personId: index === 0 ? meera : anil,
              candidatePersonIds: [index === 0 ? meera : anil],
              externalName: null,
              isPersonalResource: false,
              confidence: 1,
              reasoning: "Fake.",
            })),
          },
        };
      });
      await runIngestPass({ db: harness.db, transport: runOne });
      expect(runOne.requests[0]?.messageIds).toEqual([first, second]);
      const afterRunOne = await factRows();
      expect(afterRunOne.map((row) => row.claim)).toEqual(["claim 0", "claim 1"]);

      // A re-run: derived tables cleared, `curated_at` cleared, the cache kept — which
      // is exactly what the reset path does. A third message joins them.
      await harness.db.delete(holdings);
      await harness.db.delete(facts);
      await harness.db.update(messages).set({ curatedAt: null });
      const third = await candidate("Meera also has the petty cash tin", "2026-03-03T10:00:00Z");

      // This responder would classify anything it is asked about as noise. If the cache
      // were bypassed, the first two claims would vanish.
      const runTwo = new FakeAgent((batch) => ({
        curator: {
          results: batch.map((message) =>
            curatorResult(
              message.messageId,
              [curatorRecord({ claim: "reclassified", assetName: "something else" })],
              { classification: "durable_fact" },
            ),
          ),
        },
        cartographer: {
          attributions: batch.map((_message, index) => ({
            recordIndex: index,
            mention: "Meera",
            resolution: "resolved" as const,
            personId: meera,
            candidatePersonIds: [meera],
            externalName: null,
            isPersonalResource: false,
            confidence: 1,
            reasoning: "Fake.",
          })),
        },
      }));
      const result = await runIngestPass({ db: harness.db, transport: runTwo });

      // The batch is a different shape entirely: one message, not two.
      expect(result.cacheHits).toBe(2);
      expect(runTwo.requests).toHaveLength(1);
      expect(runTwo.requests[0]?.messageIds).toEqual([third]);

      const afterRunTwo = await factRows();
      expect(afterRunTwo.map((row) => row.claim)).toEqual(["claim 0", "claim 1", "reclassified"]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("attribution for cached records", () => {
    it("resolves a cached holder mention against the alias table as it stands now", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      await storeCuratorCache(
        harness.db,
        [
          {
            contentHash: contentHash("Meera has the store room key"),
            result: curatorResult("older", [curatorRecord({ holderMention: "Meera" })]),
          },
        ],
        CURATOR_PROMPT_VERSION,
      );
      // Learned since the cached run. The cached attribution could not have known it.
      await alias(meera, "Meera");

      await runIngestPass({ db: harness.db, transport: new FakeAgent(resolveAllTo(meera)) });

      const held = await harness.db
        .select({ holderPersonId: holdings.holderPersonId })
        .from(holdings);
      expect(held).toHaveLength(1);
      expect(held[0]?.holderPersonId).toBe(meera);
    });

    it("turns an ambiguous cached mention into an unresolved mention, never a holding", async () => {
      await candidate("Priya has the store room key", "2026-03-01T10:00:00Z");
      await storeCuratorCache(
        harness.db,
        [
          {
            contentHash: contentHash("Priya has the store room key"),
            result: curatorResult("older", [curatorRecord({ holderMention: "Priya" })]),
          },
        ],
        CURATOR_PROMPT_VERSION,
      );
      // Two Priyas. The alias table is deliberately not unique, and this is why.
      await alias(meera, "Priya");
      await alias(anil, "Priya");

      const result = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(resolveAllTo(meera)),
      });

      expect(result.unresolvedMentions).toBe(1);
      expect(await harness.db.select({ id: holdings.id }).from(holdings)).toHaveLength(0);
    });

    it("attributes records without guessing when no alias matches", () => {
      const index = new AliasIndex([
        { personId: meera, alias: "Meera", kind: "first_name", displayName: "Meera Sundaram" },
      ]);
      const attributions = attributeRecords(
        [curatorRecord({ holderMention: "the printer's owner" })],
        index,
      );

      expect(attributions).toHaveLength(1);
      expect(attributions[0]?.resolution).toBe("cannot_determine");
      expect(attributions[0]?.personId).toBeNull();
      // The alias table cannot say whether something is someone's own property, so this
      // never claims it is.
      expect(attributions[0]?.isPersonalResource).toBe(false);
    });

    it("attributes a mention appearing as both holder and subject exactly once", () => {
      const index = new AliasIndex([
        { personId: meera, alias: "Meera", kind: "first_name", displayName: "Meera Sundaram" },
      ]);
      const attributions = attributeRecords(
        [curatorRecord({ holderMention: "Meera", subjectMentions: ["Meera", "Anil"] })],
        index,
      );

      expect(attributions.map((entry) => entry.mention)).toEqual(["Meera", "Anil"]);
      expect(attributions.every((entry) => entry.recordIndex === 0)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("hydration", () => {
    it("carries the org, the aliases and the assets — and no fact index", async () => {
      await alias(meera, "Meera");
      const context = await hydrateIngestContext(harness.db, new Date("2026-03-01T10:00:00Z"));

      expect(Object.keys(context).sort()).toEqual(["aliases", "assets", "org"]);
      expect("factIndex" in context).toBe(false);
      expect(context.org).toEqual({
        orgName: "Kolam Collective",
        timezone: "Asia/Kolkata",
        now: "2026-03-01T10:00:00.000Z",
      });
      expect(context.aliases).toHaveLength(1);
      expect(context.aliases[0]?.displayName).toBe("Meera Sundaram");
    });

    it("sends no fact index to the agent even once the register holds facts", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      await runIngestPass({ db: harness.db, transport: new FakeAgent(resolveAllTo(meera)) });
      expect(await factRows()).not.toHaveLength(0);

      await candidate("Anil has the projector", "2026-03-02T10:00:00Z");
      const agent = new FakeAgent(resolveAllTo(anil));
      await runIngestPass({ db: harness.db, transport: agent });

      const sent = agent.requests[0]?.context as Record<string, unknown>;
      expect(Object.keys(sent).sort()).toEqual(["aliases", "assets", "org"]);
    });

    it("keeps two people sharing an alias as two entries", async () => {
      await alias(meera, "Priya");
      await alias(anil, "Priya");

      const context = await hydrateIngestContext(harness.db, new Date("2026-03-01T10:00:00Z"));
      const priyas = context.aliases.filter((entry: AliasEntry) => entry.alias === "Priya");

      // De-duplicating here would erase the ambiguity signal before anything could ask
      // about it.
      expect(priyas).toHaveLength(2);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("the pipeline lock", () => {
    it("lets one pass through and tells the other the work is already being done", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      let entered: () => void = () => undefined;
      const inFlight = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const held: IngestResponder = async (batch, context) => {
        entered();
        await gate;
        return resolveAllTo(meera)(batch, context);
      };

      const firstPass = runIngestPass({ db: harness.db, transport: new FakeAgent(held) });
      await inFlight;

      // The first pass is inside the lock, mid model call.
      const secondPass = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(resolveAllTo(meera)),
      });
      expect(secondPass.lockHeld).toBe(true);
      expect(secondPass.status).toBe("skipped");
      // A blocked pass leaves no run row: a zero-counter run in the activity panel would
      // read as a pass that found nothing rather than one that never ran.
      expect(secondPass.runId).toBeNull();

      release();
      const firstResult = await firstPass;
      expect(firstResult.lockHeld).toBe(false);
      expect(firstResult.messagesCurated).toBe(1);
    });

    it("releases the lock when the pass fails", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      await expect(
        runIngestPass({ db: harness.db, transport: new FailingAgent() }),
      ).rejects.toThrow(/the model refused/);

      // The next pass acquires it, which a session-scoped lock on a pooled connection
      // could not guarantee.
      const second = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(resolveAllTo(meera)),
      });
      expect(second.lockHeld).toBe(false);
      expect(second.messagesCurated).toBe(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("the run row", () => {
    it("records a completed pass with its counters and trace", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      const result = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(resolveAllTo(meera)),
      });
      const run = await findRun(harness.db, result.runId as string);

      expect(run?.kind).toBe("ingest");
      expect(run?.status).toBe("complete");
      expect(run?.candidates).toBe(1);
      expect(run?.factsExtracted).toBe(1);
      expect(run?.finishedAt).not.toBeNull();
      expect(run?.trace.map((entry) => entry.node)).toEqual(["curator"]);
    });

    it("survives the rollback of the pass it describes", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      await expect(
        runIngestPass({ db: harness.db, transport: new FailingAgent("upstream exploded") }),
      ).rejects.toThrow();

      const runs = await harness.db.execute<{ status: string; error: string | null }>(
        sql`select status, error from runs`,
      );
      const rows = [...runs];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.error).toMatch(/upstream exploded/);
    });

    it("reports into a run the caller already opened, and leaves it open", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      const runs = await harness.db
        .insert(schema.runs)
        .values({ kind: "backfill" })
        .returning({ id: schema.runs.id });
      const runId = runs[0]?.id as string;

      const result = await runIngestPass(
        { db: harness.db, transport: new FakeAgent(resolveAllTo(meera)) },
        { runId },
      );

      expect(result.runId).toBe(runId);
      const run = await findRun(harness.db, runId);
      // Still running: backfill owns the row and closes it once, after every pass.
      expect(run?.status).toBe("running");
      expect(run?.finishedAt).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("curation state", () => {
    it("stamps curated_at only after the writes land", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      await expect(
        runIngestPass({ db: harness.db, transport: new FailingAgent() }),
      ).rejects.toThrow();

      const rows = await harness.db.select({ curatedAt: messages.curatedAt }).from(messages);
      // Uncurated, so the next pass retries it — and the retry is what the cache makes
      // free. Stamping first would drop the message forever.
      expect(rows[0]?.curatedAt).toBeNull();
    });

    it("does not re-curate on a second pass", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      const first = new FakeAgent(resolveAllTo(meera));
      await runIngestPass({ db: harness.db, transport: first });

      const second = new FakeAgent(resolveAllTo(meera));
      const result = await runIngestPass({ db: harness.db, transport: second });

      expect(result.candidates).toBe(0);
      expect(second.requests).toHaveLength(0);
      expect(await factRows()).toHaveLength(1);
    });

    it("keeps the classifications a failed pass already paid for", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");

      // Succeeds at the model call, then fails during derivation because the
      // Cartographer named a person that does not exist — a foreign key violation.
      const poisoned = new FakeAgent((batch) => ({
        curator: {
          results: batch.map((message) => curatorResult(message.messageId, [curatorRecord()])),
        },
        cartographer: {
          attributions: [
            {
              recordIndex: 0,
              mention: "Meera",
              resolution: "resolved" as const,
              personId: "00000000-0000-0000-0000-000000000000",
              candidatePersonIds: [],
              externalName: null,
              isPersonalResource: false,
              confidence: 1,
              reasoning: "Fake.",
            },
          ],
        },
      }));

      await expect(runIngestPass({ db: harness.db, transport: poisoned })).rejects.toThrow();

      // The register rolled back; the cache did not. The Curator's answer for that text
      // at that prompt version is true regardless of what derivation did with it.
      expect(await factRows()).toHaveLength(0);
      const cached = await harness.db.select({ hash: curatorCache.contentHash }).from(curatorCache);
      expect(cached).toHaveLength(1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("coverage and the F33 gate", () => {
    /** Participation evidence naming Meera, with the record's standing under test. */
    function participation(overrides: Partial<ReturnType<typeof curatorRecord>>): IngestResponder {
      return (batch) => {
        const results = batch.map((message) =>
          curatorResult(
            message.messageId,
            [
              curatorRecord({
                kind: "participation_evidence",
                claim: "Meera helped run the stall",
                assetKind: null,
                assetName: null,
                holderMention: null,
                subjectMentions: ["Meera"],
                capabilityName: "running the stall",
                ...overrides,
              }),
            ],
            { classification: "participation_evidence" },
          ),
        );
        return {
          curator: { results },
          cartographer: {
            attributions: results.map((_result, index) => ({
              recordIndex: index,
              mention: "Meera",
              resolution: "resolved" as const,
              personId: meera,
              candidatePersonIds: [meera],
              externalName: null,
              isPersonalResource: false,
              confidence: 1,
              reasoning: "Fake.",
            })),
          },
        };
      };
    }

    async function coverageRows(): Promise<{ personId: string }[]> {
      return harness.db
        .select({ personId: schema.capabilityCoverage.personId })
        .from(schema.capabilityCoverage);
    }

    it("records coverage from a firsthand observation", async () => {
      await candidate("thanks Meera for running the stall", "2026-03-01T10:00:00Z");
      const result = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(participation({})),
      });

      expect(result.coverageObservations).toBe(1);
      expect(await coverageRows()).toHaveLength(1);
    });

    it("refuses to record coverage from hearsay", async () => {
      await candidate("someone said Meera ran the stall", "2026-03-01T10:00:00Z");
      const result = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(participation({ isHearsay: true })),
      });

      // `capability_coverage` is not derived from `facts` and has no status column, so the
      // capability detection query has nothing to filter on. Without this gate a
      // sole-holder finding could rest on a rumour, which is exactly what F33 forbids.
      expect(result.coverageObservations).toBe(0);
      expect(await coverageRows()).toHaveLength(0);
    });

    it("refuses to record coverage from a claim too weak to be believed", async () => {
      await candidate("maybe Meera was at the stall?", "2026-03-01T10:00:00Z");
      const result = await runIngestPass({
        db: harness.db,
        transport: new FakeAgent(participation({ confidence: 0.3 })),
      });

      // The same policy `facts` uses, reused rather than restated: coverage is recorded
      // only where the equivalent claim would have been written `active`.
      expect(result.coverageObservations).toBe(0);
      expect(await coverageRows()).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("record ordering", () => {
    it("applies a contradiction after the claim it contradicts", async () => {
      await candidate("Meera has the store room key", "2026-03-01T10:00:00Z");
      await candidate("Anil has the store room key now", "2026-03-05T10:00:00Z");
      await alias(meera, "Meera");
      await alias(anil, "Anil");

      const agent = new FakeAgent((batch) => {
        const results = batch.map((message, index) =>
          curatorResult(message.messageId, [
            curatorRecord({
              claim:
                index === 0 ? "Meera holds the store room key" : "Anil holds the store room key",
              holderMention: index === 0 ? "Meera" : "Anil",
            }),
          ]),
        );
        return {
          curator: { results },
          cartographer: {
            attributions: results.map((_result, index) => ({
              recordIndex: index,
              mention: index === 0 ? "Meera" : "Anil",
              resolution: "resolved" as const,
              personId: index === 0 ? meera : anil,
              candidatePersonIds: [],
              externalName: null,
              isPersonalResource: false,
              confidence: 1,
              reasoning: "Fake.",
            })),
          },
        };
      });

      await runIngestPass({ db: harness.db, transport: agent });

      const active = await harness.db
        .select({ claim: facts.claim, status: facts.status })
        .from(facts)
        .orderBy(facts.statedAt);
      expect(active.map((row) => `${row.claim}:${row.status}`)).toEqual([
        "Meera holds the store room key:superseded",
        "Anil holds the store room key:active",
      ]);

      const open = await harness.db
        .select({ holderPersonId: holdings.holderPersonId })
        .from(holdings)
        .where(eq(holdings.status, "active"));
      expect(open).toHaveLength(1);
      expect(open[0]?.holderPersonId).toBe(anil);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("splitIngestResult", () => {
    it("re-bases each message's attributions onto its own records", () => {
      const batch: IngestResult = {
        curator: {
          results: [
            curatorResult("m1", [curatorRecord({ claim: "a" }), curatorRecord({ claim: "b" })]),
            curatorResult("m2", [curatorRecord({ claim: "c" })]),
          ],
        },
        cartographer: {
          attributions: [0, 1, 2].map((recordIndex) => ({
            recordIndex,
            mention: `mention ${recordIndex}`,
            resolution: "resolved" as const,
            personId: meera,
            candidatePersonIds: [],
            externalName: null,
            isPersonalResource: false,
            confidence: 1,
            reasoning: "Fake.",
          })),
        },
      };

      const split = splitIngestResult(batch);

      expect(split.map((entry) => entry.messageId)).toEqual(["m1", "m2"]);
      expect(
        split[0]?.ingest.cartographer.attributions.map((a) => [a.recordIndex, a.mention]),
      ).toEqual([
        [0, "mention 0"],
        [1, "mention 1"],
      ]);
      // The third attribution belonged to the second message's only record, so it is now
      // index zero.
      expect(
        split[1]?.ingest.cartographer.attributions.map((a) => [a.recordIndex, a.mention]),
      ).toEqual([[0, "mention 2"]]);
    });

    it("drops an attribution indexed past the end of the batch", () => {
      const batch: IngestResult = {
        curator: { results: [curatorResult("m1", [curatorRecord()])] },
        cartographer: {
          attributions: [
            {
              recordIndex: 7,
              mention: "Meera",
              resolution: "resolved" as const,
              personId: meera,
              candidatePersonIds: [],
              externalName: null,
              isPersonalResource: false,
              confidence: 1,
              reasoning: "Fake.",
            },
          ],
        },
      };

      const split = splitIngestResult(batch);
      // Dropped rather than reattached: a record with no holder attribution is treated as
      // unsettled downstream, which is the safe direction.
      expect(split[0]?.ingest.cartographer.attributions).toHaveLength(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  describe("what the agent is told about a message", () => {
    it("sends the sender's recorded name and the parent message's text", async () => {
      const parent = await candidate("who has the store room key?", "2026-03-01T09:00:00Z");
      const reply: NormalisedMessage = {
        source: "telegram",
        chatId: CHAT_ID,
        telegramMessageId: nextTelegramId++,
        senderTelegramUserId: 5001,
        senderDisplayName: "Priya Raghavan",
        sentAt: new Date("2026-03-01T09:05:00Z"),
        text: "Meera does",
        contentHash: contentHash("Meera does"),
        replyToTelegramMessageId: 1,
        isForwarded: false,
        forwardedFrom: null,
        isEdited: false,
        editedAt: null,
        isUnprocessed: false,
        mediaKind: null,
      };
      const persisted = await persistMessage(harness.db, reply);
      await harness.db
        .update(messages)
        .set({ prefilterVerdict: "candidate", prefilterVersion: PREFILTER_VERSION })
        .where(eq(messages.id, persisted.id));

      const agent = new FakeAgent(resolveAllTo(meera));
      await runIngestPass({ db: harness.db, transport: agent });

      const sent = (agent.requests[0]?.request.payload as { messages: CandidateMessage[] })
        .messages;
      expect(sent.map((message) => message.messageId)).toEqual([parent, persisted.id]);
      expect(sent[1]?.replyToText).toBe("who has the store room key?");
      // Resolved to the person's recorded display name, which is what the alias table is
      // keyed on.
      expect(sent[1]?.senderMention).toBe("Priya Raghavan");
    });
  });
});
