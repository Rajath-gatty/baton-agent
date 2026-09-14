/**
 * Findings upsert, the sweep short-circuit, and assess — against real Postgres.
 *
 * Two assertions dominate this file, and both are about things not happening:
 *
 *   - **An unchanged register calls no model at all.** Asserted on the transport's request
 *     log, because that is the only place the claim is falsifiable. A sweep that called the
 *     model and got "nothing has changed" back has already paid for the answer, and on a
 *     system that sits idle for days an hourly unconditional sweep would cost more across a
 *     month than the whole build.
 *   - **Two consecutive sweeps produce one finding, and a dismissed finding never comes
 *     back.** Sweeps re-derive everything from scratch, so `dedupe_key` is the only thing
 *     standing between the register and either duplication or resurrection.
 *
 * The fingerprint has one trap worth naming, and there is a test for it: it must not
 * include anything a sweep itself writes. `previousSeverity` is read from `findings`, so a
 * fingerprint including it would differ after every sweep and the short-circuit would never
 * fire even once — while every other test still passed.
 */

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestDatabase } from "@baton/core/db/testing";
import { schema } from "@baton/core/db";
import { buildDedupeKey, contentHash, type AssessResult } from "@baton/core";
import { persistMessage } from "../src/store/messages.js";
import {
  dismissFinding,
  neutralTitle,
  selectOpenFindings,
  titleNamesAPerson,
} from "../src/store/findings.js";
import { countQuietDecisions, selectQuietDecisions } from "../src/store/quiet-decisions.js";
import { getSweepState } from "../src/store/worker-state.js";
import { fingerprintCandidates, detectFindings } from "../src/pipeline/detection.js";
import { hydrateAssessContext } from "../src/pipeline/hydrate.js";
import { runSweepPass, sweepWouldChangeAnything } from "../src/pipeline/sweep.js";
import { findRun } from "../src/store/runs.js";
import { FakeAssessor, judgeAllAt, type AssessResponder } from "./helpers/fake-agent.js";

const { appSettings, assets, commitments, facts, findings, holdings, people } = schema;
const CHAT_ID = -1001234567890;
const NOW = new Date("2026-06-01T10:00:00Z");
const LATER = new Date("2026-06-02T10:00:00Z");

describe("the sweep", () => {
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

  /** An asset held by exactly one person: one `sole_holder` candidate. */
  async function soleHeldAsset(name: string, holderPersonId: string): Promise<string> {
    const assetRows = await harness.db
      .insert(assets)
      .values({ kind: "physical_item", name, normalisedKey: name.toLowerCase() })
      .returning({ id: assets.id });
    const assetId = assetRows[0]?.id as string;

    const sourceMessageId = await message(`${name} is with someone`);
    const factRows = await harness.db
      .insert(facts)
      .values({
        assetId,
        claim: `${name} is held`,
        matchKey: `k:${name}`,
        confidence: 0.9,
        status: "active",
        sourceMessageId,
        statedAt: new Date("2026-05-01T10:00:00Z"),
        lastConfirmedAt: new Date("2026-05-01T10:00:00Z"),
        evidenceMessageIds: [sourceMessageId],
      })
      .returning({ id: facts.id });

    await harness.db.insert(holdings).values({
      assetId,
      holderPersonId,
      status: "active",
      acquiredAt: new Date("2026-05-01T10:00:00Z"),
      evidenceFactId: factRows[0]?.id as string,
    });
    return assetId;
  }

  async function looseEnd(substance: string): Promise<string> {
    const sourceMessageId = await message(substance);
    const rows = await harness.db
      .insert(commitments)
      .values({
        substance,
        ownerPersonId: meera,
        promisedAt: new Date("2026-05-01T10:00:00Z"),
        deadline: new Date("2026-05-10T00:00:00Z"),
        sourceMessageId,
        status: "open",
      })
      .returning({ id: commitments.id });
    return rows[0]?.id as string;
  }

  function sweep(responder: AssessResponder, at = NOW) {
    const transport = new FakeAssessor(responder);
    return {
      transport,
      run: () => runSweepPass({ db: harness.db, transport, now: () => at }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  describe("the short-circuit", () => {
    it("calls no model at all when the candidate set is unchanged", async () => {
      await soleHeldAsset("store room key", meera);

      const first = sweep(judgeAllAt("medium"));
      const firstResult = await first.run();
      expect(first.transport.requests).toHaveLength(1);
      expect(firstResult.shortCircuited).toBe(false);
      expect(firstResult.findingsCreated).toBe(1);

      const second = sweep(judgeAllAt("high"), LATER);
      const secondResult = await second.run();

      // The whole point. Not "the model returned nothing useful" — the model was never asked.
      expect(second.transport.requests).toHaveLength(0);
      expect(secondResult.shortCircuited).toBe(true);
      expect(secondResult.candidates).toBe(1);

      // And the severity from the first sweep survives, because nothing re-judged it.
      const open = await selectOpenFindings(harness.db);
      expect(open).toHaveLength(1);
      expect(open[0]?.severity).toBe("medium");
    });

    it("does not let the previous severity it wrote change its own fingerprint", async () => {
      await soleHeldAsset("store room key", meera);

      const before = await detectFindings(harness.db, NOW);
      await sweep(judgeAllAt("high")).run();
      const after = await detectFindings(harness.db, LATER);

      // `previousSeverity` is null before the sweep and "high" after it. If the fingerprint
      // included it, these would differ and the short-circuit could never fire once.
      expect(before.candidates[0]?.previousSeverity).toBeNull();
      expect(after.candidates[0]?.previousSeverity).toBe("high");
      expect(after.fingerprint).toBe(before.fingerprint);
    });

    it("runs again when a new candidate appears", async () => {
      await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();

      await soleHeldAsset("the projector", anil);
      const second = sweep(judgeAllAt("medium"), LATER);
      const result = await second.run();

      expect(result.shortCircuited).toBe(false);
      expect(second.transport.requests).toHaveLength(1);
      expect(second.transport.requests[0]?.candidates).toHaveLength(2);
      expect(await selectOpenFindings(harness.db)).toHaveLength(2);
    });

    it("runs again when a candidate's evidence changes", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();

      // A second message confirming the same claim: same finding, more evidence. This is
      // what a restatement leaves behind, and it has to reach the Assessor because thin
      // evidence becoming solid can legitimately change a severity.
      const extra = await message("yes the store room key is still with them");
      await harness.db
        .update(facts)
        .set({
          evidenceMessageIds: sql`${facts.evidenceMessageIds} || to_jsonb(array[${extra}::text])`,
        })
        .where(eq(facts.assetId, assetId));

      const second = sweep(judgeAllAt("medium"), LATER);
      const result = await second.run();
      expect(result.shortCircuited).toBe(false);
    });

    it("stores the fingerprint and the sweep time", async () => {
      await soleHeldAsset("store room key", meera);
      const result = await sweep(judgeAllAt("medium")).run();

      const state = await getSweepState(harness.db);
      expect(state.fingerprint).toBe(result.fingerprint);
      expect(state.lastSweepAt?.toISOString()).toBe(NOW.toISOString());
    });

    it("advances the sweep time even when it short-circuits", async () => {
      await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();
      await sweep(judgeAllAt("medium"), LATER).run();

      // The sweep did run and did conclude something; a silent one is indistinguishable
      // from a scheduler that stopped.
      const state = await getSweepState(harness.db);
      expect(state.lastSweepAt?.toISOString()).toBe(LATER.toISOString());
    });

    it("leaves the old fingerprint in place when the sweep fails", async () => {
      await soleHeldAsset("store room key", meera);

      const exploding = new FakeAssessor(() => {
        throw new Error("the model refused");
      });
      await expect(
        runSweepPass({ db: harness.db, transport: exploding, now: () => NOW }),
      ).rejects.toThrow(/the model refused/);

      // Null, not the fingerprint of a sweep that never finished. Otherwise the next sweep
      // would conclude nothing had changed since a run that produced nothing.
      expect((await getSweepState(harness.db)).fingerprint).toBeNull();

      const retry = sweep(judgeAllAt("medium"), LATER);
      const result = await retry.run();
      expect(result.shortCircuited).toBe(false);
      expect(retry.transport.requests).toHaveLength(1);
    });

    it("writes a run row even when it short-circuits", async () => {
      await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();

      const result = await sweep(judgeAllAt("medium"), LATER).run();
      const run = await findRun(harness.db, result.runId as string);

      expect(run?.kind).toBe("sweep");
      expect(run?.status).toBe("complete");
      expect(run?.finishedAt).not.toBeNull();
    });

    it("can be forced past the short-circuit", async () => {
      await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();

      const forced = new FakeAssessor(judgeAllAt("high"));
      const result = await runSweepPass(
        { db: harness.db, transport: forced, now: () => LATER },
        { force: true },
      );

      expect(result.shortCircuited).toBe(false);
      expect(forced.requests).toHaveLength(1);
      expect((await selectOpenFindings(harness.db))[0]?.severity).toBe("high");
    });

    it("answers whether a sweep would do anything, without invoking anything", async () => {
      await soleHeldAsset("store room key", meera);
      expect(await sweepWouldChangeAnything(harness.db, NOW)).toBe(true);

      await sweep(judgeAllAt("medium")).run();
      expect(await sweepWouldChangeAnything(harness.db, LATER)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("dedupe", () => {
    it("produces one finding from two sweeps of the same condition", async () => {
      await soleHeldAsset("store room key", meera);

      await sweep(judgeAllAt("medium")).run();
      // Forced, so the second sweep genuinely re-derives and re-upserts rather than
      // short-circuiting — which is the case the dedupe key has to survive.
      await runSweepPass(
        { db: harness.db, transport: new FakeAssessor(judgeAllAt("high")), now: () => LATER },
        { force: true },
      );

      const rows = await harness.db.select({ id: findings.id }).from(findings);
      expect(rows).toHaveLength(1);
    });

    it("keeps first_seen_at from the first sweep and moves last_seen_at", async () => {
      await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();
      await runSweepPass(
        { db: harness.db, transport: new FakeAssessor(judgeAllAt("high")), now: () => LATER },
        { force: true },
      );

      const open = await selectOpenFindings(harness.db);
      // How long a gap has been sitting open is most of what makes the register worth
      // reading, so a sweep must not rewrite when it was first raised.
      expect(open[0]?.firstSeenAt.toISOString()).toBe(NOW.toISOString());
      expect(open[0]?.lastSeenAt.toISOString()).toBe(LATER.toISOString());
      expect(open[0]?.severity).toBe("high");
    });

    it("never brings back a dismissed finding", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();

      const key = buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: assetId });
      expect(await dismissFinding(harness.db, key, "We already have a backup.", NOW)).toBe(true);

      const second = sweep(judgeAllAt("high"), LATER);
      const result = await second.run();

      // Dropped before the Assessor, so the model was never asked about it either.
      expect(second.transport.requests[0]?.candidates ?? []).toHaveLength(0);
      expect(result.dismissedKeysSkipped).toBe(1);

      const rows = await harness.db
        .select({ status: findings.status, reason: findings.dismissalReason })
        .from(findings);
      expect(rows[0]?.status).toBe("dismissed");
      expect(rows[0]?.reason).toBe("We already have a backup.");
    });

    it("reopens a resolved finding whose condition has recurred", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      await sweep(judgeAllAt("medium")).run();

      // The condition goes away: a second holder appears, so it is no longer sole-held.
      const factRows = await harness.db.select({ id: facts.id }).from(facts);
      await harness.db.insert(holdings).values({
        assetId,
        holderPersonId: anil,
        status: "active",
        acquiredAt: LATER,
        evidenceFactId: factRows[0]?.id as string,
      });

      await sweep(judgeAllAt("medium"), LATER).run();
      let rows = await harness.db
        .select({ status: findings.status, resolvedAt: findings.resolvedAt })
        .from(findings);
      expect(rows[0]?.status).toBe("resolved");
      expect(rows[0]?.resolvedAt).not.toBeNull();

      // And back again. This is the orphan case closing and reopening with no special-case
      // code for donation pages anywhere.
      await harness.db.delete(holdings).where(eq(holdings.holderPersonId, anil));
      const third = new Date("2026-06-03T10:00:00Z");
      await runSweepPass(
        { db: harness.db, transport: new FakeAssessor(judgeAllAt("high")), now: () => third },
        { force: true },
      );

      rows = await harness.db
        .select({ status: findings.status, resolvedAt: findings.resolvedAt })
        .from(findings);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("open");
      expect(rows[0]?.resolvedAt).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the Assessor's dispositions", () => {
    it("writes no row for a suppressed candidate", async () => {
      await soleHeldAsset("the poster template", meera);

      const result = await sweep(
        judgeAllAt("low", { suppress: true, suppressionReason: "One throwaway mention." }),
      ).run();

      expect(result.findingsSuppressed).toBe(1);
      expect(result.findingsCreated).toBe(0);
      expect(await harness.db.select({ id: findings.id }).from(findings)).toHaveLength(0);
    });

    it("leaves an already-open finding open when it is later suppressed", async () => {
      await soleHeldAsset("the poster template", meera);
      await sweep(judgeAllAt("medium")).run();

      await runSweepPass(
        {
          db: harness.db,
          transport: new FakeAssessor(
            judgeAllAt("low", { suppress: true, suppressionReason: "Thin, on reflection." }),
          ),
          now: () => LATER,
        },
        { force: true },
      );

      // Suppression says "not worth raising", not "no longer true". Withdrawing something a
      // coordinator has already read, with no explanation, is worse than leaving a thin item
      // where Dismiss is one click away.
      const open = await selectOpenFindings(harness.db);
      expect(open).toHaveLength(1);
      expect(open[0]?.lastSeenAt.toISOString()).toBe(LATER.toISOString());
    });

    it("closes a candidate that another finding subsumes", async () => {
      const first = await soleHeldAsset("the bank login", meera);
      const second = await soleHeldAsset("the accounts spreadsheet", meera);
      const firstKey = buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: first });
      const secondKey = buildDedupeKey({
        subtype: "sole_holder",
        type: "asset",
        subjectId: second,
      });

      const aggregating: AssessResponder = (candidates) => ({
        findings: candidates
          .filter((candidate) => candidate.dedupeKey === firstKey)
          .map((candidate) => ({
            dedupeKey: candidate.dedupeKey,
            type: candidate.type,
            subtype: candidate.subtype,
            title: "One person holds everything to do with the finances",
            whyItMatters: "Two exposures, one problem.",
            severity: "high" as const,
            confidence: 0.9,
            suppress: false,
            suppressionReason: null,
            aggregatedDedupeKeys: [secondKey],
            reasoning: "Aggregated.",
          })),
        quietDecisions: [],
      });

      const result = await sweep(aggregating).run();

      expect(result.findingsCreated).toBe(1);
      expect(result.findingsAggregated).toBe(1);
      const open = await selectOpenFindings(harness.db);
      expect(open).toHaveLength(1);
      expect(open[0]?.dedupeKey).toBe(firstKey);
    });

    it("discards a judgment for a key that was never a candidate", async () => {
      await soleHeldAsset("store room key", meera);

      const hallucinating: AssessResponder = () => ({
        findings: [
          {
            dedupeKey: "sole_holder:asset:00000000-0000-0000-0000-000000000000",
            type: "asset",
            subtype: "sole_holder",
            title: "A finding about nothing",
            whyItMatters: "Invented.",
            severity: "high",
            confidence: 0.9,
            suppress: false,
            suppressionReason: null,
            aggregatedDedupeKeys: [],
            reasoning: "Hallucinated.",
          },
        ],
        quietDecisions: [],
      });

      const result = await sweep(hallucinating).run();

      // A hallucinated key could otherwise write a finding about nothing, or collide with a
      // real one.
      expect(result.findingsCreated).toBe(0);
      expect(await harness.db.select({ id: findings.id }).from(findings)).toHaveLength(0);
    });

    it("resolves an open finding the Assessor was never asked about", async () => {
      const commitmentId = await looseEnd("book the hall");
      await sweep(judgeAllAt("medium")).run();
      expect(await selectOpenFindings(harness.db)).toHaveLength(1);

      await harness.db
        .update(commitments)
        .set({ status: "completed", closedAt: LATER })
        .where(eq(commitments.id, commitmentId));

      const result = await sweep(judgeAllAt("medium"), LATER).run();

      expect(result.candidates).toBe(0);
      expect(result.findingsResolved).toBe(1);
      expect(await selectOpenFindings(harness.db)).toHaveLength(0);
    });

    it("resolves what is open without invoking anything when nothing is detected", async () => {
      const commitmentId = await looseEnd("book the hall");
      await sweep(judgeAllAt("medium")).run();

      await harness.db
        .update(commitments)
        .set({ status: "completed", closedAt: LATER })
        .where(eq(commitments.id, commitmentId));

      const second = sweep(judgeAllAt("medium"), LATER);
      await second.run();

      // An empty candidate set is a register with no gaps. It still has to close what was
      // open, but there is nothing to judge.
      expect(second.transport.requests).toHaveLength(0);
      expect(await selectOpenFindings(harness.db)).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("titles must not name a person", () => {
    it("replaces a title that names someone on the roster", async () => {
      await soleHeldAsset("store room key", meera);

      const result = await sweep(
        judgeAllAt("medium", { title: "Meera is the only one with the store room key" }),
      ).run();

      expect(result.titlesRewritten).toBe(1);
      const open = await selectOpenFindings(harness.db);
      expect(open[0]?.title).toBe("Only one person holds store room key");

      // The finding is still written — the risk is real — and the model's wording is kept so
      // the prompt can be diagnosed rather than guessed at.
      const rows = await harness.db
        .select({ reasoning: findings.assessorReasoning })
        .from(findings);
      expect(rows[0]?.reasoning).toContain("Meera is the only one with the store room key");
    });

    it("leaves a title that names no one alone", async () => {
      await soleHeldAsset("store room key", meera);
      const result = await sweep(
        judgeAllAt("medium", { title: "Only one person holds the store room key" }),
      ).run();

      expect(result.titlesRewritten).toBe(0);
      expect((await selectOpenFindings(harness.db))[0]?.title).toBe(
        "Only one person holds the store room key",
      );
    });

    it("does not treat a role reference as a person's name", async () => {
      await harness.db.insert(schema.personAliases).values({
        personId: meera,
        alias: "the coordinator",
        normalisedAlias: "the coordinator",
        kind: "role_reference",
      });
      await soleHeldAsset("the payment approvals", meera);

      const result = await sweep(
        judgeAllAt("medium", { title: "Only the coordinator can approve payments" }),
      ).run();

      // Roles change hands and are not names. This phrasing is exactly what is wanted.
      expect(result.titlesRewritten).toBe(0);
    });

    it("matches a name regardless of punctuation or case", () => {
      const roster = new Set(["meera", "sundaram"]);
      expect(titleNamesAPerson("MEERA holds the key", roster)).toBe(true);
      expect(titleNamesAPerson("(Meera's) key", roster)).toBe(true);
      expect(titleNamesAPerson("Only one person holds the key", roster)).toBe(false);
    });

    it("builds a person-free title for every subtype", () => {
      const base = {
        dedupeKey: "k",
        subjectName: "the thing",
        subjectAssetId: null,
        subjectCapabilityId: null,
        subjectCommitmentId: null,
        assetKind: null,
        assetSensitivity: null,
        holderPersonId: null,
        holderDisplayName: null,
        evidenceFactIds: [],
        evidenceMessageIds: [],
        evidenceCount: 0,
        evidenceExcerpts: [],
        capabilityArea: null,
        previousSeverity: null,
      };
      const titles = [
        neutralTitle({ ...base, type: "asset", subtype: "sole_holder" }),
        neutralTitle({ ...base, type: "capability", subtype: "sole_holder" }),
        neutralTitle({ ...base, type: "asset", subtype: "no_owner" }),
        neutralTitle({ ...base, type: "asset", subtype: "not_ours" }),
        neutralTitle({ ...base, type: "commitment", subtype: "loose_end" }),
      ];
      expect(titles.every((title) => title.includes("the thing"))).toBe(true);
      expect(new Set(titles).size).toBe(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("quiet decisions", () => {
    it("records what Restraint withheld, with its scope", async () => {
      await soleHeldAsset("store room key", meera);

      const withholding: AssessResponder = (candidates) => {
        const judged = judgeAllAt("medium")(candidates, {
          org: { orgName: "", timezone: "", now: "" },
          openCommitments: [],
          activeMemberCount: 0,
        }) as AssessResult;
        return {
          findings: judged.findings,
          quietDecisions: [
            {
              scope: "finding",
              withheld: "A second finding about the same cupboard",
              reason: "The group already has this in hand.",
              findingDedupeKey: candidates[0]?.dedupeKey ?? null,
            },
          ],
        };
      };

      const result = await sweep(withholding).run();

      expect(result.quietDecisions).toBe(1);
      const strip = await selectQuietDecisions(harness.db);
      expect(strip).toHaveLength(1);
      expect(strip[0]).toMatchObject({
        scope: "finding",
        withheld: "A second finding about the same cupboard",
        reason: "The group already has this in hand.",
        runId: result.runId,
      });
      // Recorded rather than inferred, so a test can prove the veto has not narrowed to
      // findings during a refactor.
      expect(await countQuietDecisions(harness.db, "finding")).toBe(1);
      expect(await countQuietDecisions(harness.db, "brief_line")).toBe(0);
      expect(await countQuietDecisions(harness.db, "answer")).toBe(0);
    });

    it("records the same withheld item twice across two sweeps", async () => {
      await soleHeldAsset("store room key", meera);

      const withholding: AssessResponder = () => ({
        findings: [],
        quietDecisions: [
          {
            scope: "finding",
            withheld: "The same thing",
            reason: "Still in hand.",
            findingDedupeKey: null,
          },
        ],
      });

      await runSweepPass({
        db: harness.db,
        transport: new FakeAssessor(withholding),
        now: () => NOW,
      });
      await runSweepPass(
        { db: harness.db, transport: new FakeAssessor(withholding), now: () => LATER },
        { force: true },
      );

      // A withheld item is an event, not a state. Collapsing the two would make the strip
      // read as though Restraint had stopped working.
      expect(await countQuietDecisions(harness.db, "finding")).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the assess context", () => {
    it("carries the org, open commitments and a member count — and no roster", async () => {
      await looseEnd("book the hall");
      const context = await hydrateAssessContext(harness.db, NOW);

      expect(Object.keys(context).sort()).toEqual(["activeMemberCount", "openCommitments", "org"]);
      // Three, not two: intake resolves the message sender into a `people` row, so Priya
      // is as much a member as the two seeded directly.
      expect(context.activeMemberCount).toBe(3);
      // A count, never a list. Handing the Assessor the roster would invite it to write
      // about the people in it, and the finding is about the gap.
      expect(JSON.stringify(context)).not.toContain("Anil Kumar");
    });

    it("computes overdue days itself rather than asking the model", async () => {
      await looseEnd("book the hall");
      const context = await hydrateAssessContext(harness.db, NOW);

      // Deadline 2026-05-10, now 2026-06-01: 22 days.
      expect(context.openCommitments[0]?.overdueDays).toBe(22);
      expect(context.openCommitments[0]?.ownerDisplayName).toBe("Meera Sundaram");
    });

    it("reports null overdue days for a promise not yet due", async () => {
      const sourceMessageId = await message("book the hall in July");
      await harness.db.insert(commitments).values({
        substance: "book the hall in July",
        ownerPersonId: meera,
        promisedAt: new Date("2026-05-01T10:00:00Z"),
        deadline: new Date("2026-07-01T00:00:00Z"),
        sourceMessageId,
        status: "open",
      });

      const context = await hydrateAssessContext(harness.db, NOW);
      // Null rather than a negative number, which would render as "-30 days overdue".
      expect(context.openCommitments[0]?.overdueDays).toBeNull();
    });

    it("measures an undated promise from when it was made", async () => {
      const sourceMessageId = await message("sort out the printers");
      await harness.db.insert(commitments).values({
        substance: "sort out the printers",
        ownerPersonId: null,
        promisedAt: new Date("2026-05-01T10:00:00Z"),
        deadline: null,
        sourceMessageId,
        status: "open",
      });

      const context = await hydrateAssessContext(harness.db, NOW);
      expect(context.openCommitments[0]?.overdueDays).toBe(31);
      expect(context.openCommitments[0]?.ownerDisplayName).toBeNull();
    });

    it("is what the sweep actually sends", async () => {
      await soleHeldAsset("store room key", meera);
      const transport = new FakeAssessor(judgeAllAt("medium"));
      await runSweepPass({ db: harness.db, transport, now: () => NOW });

      expect(transport.requests[0]?.context.activeMemberCount).toBe(3);
      expect(transport.requests[0]?.context.org.orgName).toBe("Kolam Collective");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the fingerprint", () => {
    it("ignores the order the queries ran in", async () => {
      await soleHeldAsset("store room key", meera);
      await soleHeldAsset("the projector", anil);

      const { candidates } = await detectFindings(harness.db, NOW);
      const reversed = [...candidates].reverse();

      expect(fingerprintCandidates(reversed)).toBe(fingerprintCandidates(candidates));
    });

    it("ignores the order evidence ids accumulated in", async () => {
      await soleHeldAsset("store room key", meera);
      const { candidates } = await detectFindings(harness.db, NOW);
      const first = candidates[0] as (typeof candidates)[number];

      const shuffled = [{ ...first, evidenceMessageIds: [...first.evidenceMessageIds].reverse() }];
      expect(fingerprintCandidates(shuffled)).toBe(fingerprintCandidates([first]));
    });

    it("changes when a holder changes", async () => {
      const assetId = await soleHeldAsset("store room key", meera);
      const before = fingerprintCandidates((await detectFindings(harness.db, NOW)).candidates);

      await harness.db
        .update(holdings)
        .set({ holderPersonId: anil })
        .where(eq(holdings.assetId, assetId));
      const after = fingerprintCandidates((await detectFindings(harness.db, NOW)).candidates);

      expect(after).not.toBe(before);
    });

    it("is empty-set stable", () => {
      expect(fingerprintCandidates([])).toBe(fingerprintCandidates([]));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe("the lock", () => {
    it("skips when a pass already holds it", async () => {
      await soleHeldAsset("store room key", meera);

      let entered: () => void = () => undefined;
      const inFlight = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const held = new FakeAssessor(async (candidates, context) => {
        entered();
        await gate;
        return judgeAllAt("medium")(candidates, context);
      });

      const first = runSweepPass({ db: harness.db, transport: held, now: () => NOW });
      await inFlight;

      const blocked = new FakeAssessor(judgeAllAt("high"));
      const second = await runSweepPass({ db: harness.db, transport: blocked, now: () => LATER });

      expect(second.lockHeld).toBe(true);
      expect(second.status).toBe("skipped");
      expect(second.runId).toBeNull();
      expect(blocked.requests).toHaveLength(0);

      release();
      await first;
    });
  });
});
