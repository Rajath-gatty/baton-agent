/**
 * Context hydration for `ingest`. `[F10]`
 *
 * The `ingest` context is three things: the organisation's name and timezone and the
 * run's start instant, the alias table, and the asset index. **The fact index is
 * absent, and its absence is the design rather than an omission to be fixed later.**
 *
 * Two reasons, and the second is the one that bites:
 *
 *   - The Curator classifies text. It does not consult the register, so a fact index
 *     would be tokens spent on every message of a four-and-a-half-thousand-message
 *     backfill for no change in output. Hydration would become the dominant cost of
 *     the system.
 *   - It is what keeps the per-message `content_hash` cache sound. An extractor whose
 *     output depended on register state at call time could not be cached on message
 *     content alone — the same message would legitimately classify differently in
 *     March and September, and a cache keyed on the text would serve the March answer
 *     forever.
 *
 * There is a test asserting the fact index is absent from what this returns, which
 * reads like a strange thing to test until the day someone adds it to make the Curator
 * "smarter" and silently poisons every cached classification.
 *
 * The alias table is hydrated **whole, including departed members and including
 * duplicate aliases**. Two volunteers both called "Priya" appear as two entries with
 * the same alias, and that repetition *is* the ambiguity signal the Cartographer
 * escalates on — de-duplicating on the way in would erase it before anything could
 * ask about it. Departed members stay because backfill replays six months during which
 * they were present, and a mention of someone who has since left must still resolve to
 * them rather than to nobody.
 */

import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { STALE_FACT_THRESHOLD_DAYS, ageInDays, overdueDays } from "@baton/core";
import type {
  AliasEntry,
  AssessContext,
  AssetEntry,
  BriefContext,
  BriefKind,
  CoverageEntry,
  FactIndexEntry,
  HoldingEntry,
  IngestContext,
  OpenCommitment,
  OrgContext,
  RespondContext,
} from "@baton/core";
import { getAppSettings } from "../store/app-settings.js";
import { selectOpenCommitments } from "../store/commitments.js";
import { getPersonDisplayNames } from "../store/people.js";
import { askBudgetStatus } from "../store/questions.js";
import { countActiveMembers } from "./lifecycle.js";
import type { Executor } from "../store/types.js";

const { assets, capabilities, capabilityCoverage, facts, holdings, people, personAliases } = schema;

/**
 * Fallbacks for a database that has not been seeded yet.
 *
 * A missing settings row is an ordinary early state — the first message can arrive
 * before a coordinator has configured anything — and refusing to hydrate would stop
 * intake rather than degrade it. The timezone falls back to the one the Curator's
 * relative-date resolution was written against, because a null there would put every
 * deadline a day out.
 */
const DEFAULT_ORG_NAME = "this group";
const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Every alias, flattened, with the person's current display name attached.
 *
 * The display name travels alongside the alias because alias classification needs it —
 * "Pri" is a nickname or a first name depending on what the person is actually called —
 * and a second lookup per mention would be a query per mention.
 */
export async function hydrateAliases(db: Executor): Promise<AliasEntry[]> {
  const rows = await db
    .select({
      personId: personAliases.personId,
      alias: personAliases.alias,
      kind: personAliases.kind,
      displayName: people.displayName,
    })
    .from(personAliases)
    .innerJoin(people, eq(people.id, personAliases.personId))
    // Newest first so a truncated hydration keeps recently learned forms, which are
    // the ones a live message is most likely to use.
    .orderBy(desc(personAliases.createdAt));

  return rows;
}

/**
 * The asset index — active assets only.
 *
 * Retired assets are excluded so the Curator does not helpfully reuse the name of
 * something the group has already got rid of, which would resurrect it as a live
 * holding. A retired asset is invisible to detection for the same reason.
 */
export async function hydrateAssets(db: Executor): Promise<AssetEntry[]> {
  const rows = await db
    .select({
      assetId: assets.id,
      kind: assets.kind,
      name: assets.name,
      normalisedKey: assets.normalisedKey,
    })
    .from(assets)
    .where(eq(assets.status, "active"))
    .orderBy(assets.normalisedKey);

  return rows;
}

/** Organisation context. `now` is the worker's instant; the model is never asked the date. */
export async function hydrateOrgContext(db: Executor, now: Date): Promise<OrgContext> {
  const settings = await getAppSettings(db);
  return {
    orgName: settings.orgName ?? DEFAULT_ORG_NAME,
    timezone: settings.timezone ?? DEFAULT_TIMEZONE,
    now: now.toISOString(),
  };
}

/**
 * The whole `ingest` context.
 *
 * Returns exactly the three keys `ingestContextSchema` declares. Anything more would
 * be silently dropped by the agent's own validation, which is the polite failure — the
 * impolite one is the extra key changing the model's output and quietly invalidating
 * the cache.
 */
export async function hydrateIngestContext(db: Executor, now: Date): Promise<IngestContext> {
  // Sequential rather than `Promise.all`. These run inside the pipeline lock's
  // transaction, and a transaction is one connection — concurrent statements on it
  // are pipelined by the driver and interleave in ways that are nobody's intent.
  const org = await hydrateOrgContext(db, now);
  const aliases = await hydrateAliases(db);
  const assetIndex = await hydrateAssets(db);

  return { org, aliases, assets: assetIndex };
}

/**
 * Open commitments, shaped for the `assess` and `brief` contexts.
 *
 * `overdueDays` is computed here rather than by the model. Date arithmetic is exactly the
 * kind of work a cheap model gets subtly wrong, and "three weeks overdue" is unfalsifiable
 * if the number was invented — a coordinator has no way to check it and every reason to
 * believe it.
 *
 * An undated promise is measured from when it was made, which is what the schema's
 * "or past `promisedAt` where there is no deadline" means. `overdueDays` returns null
 * before something is due, so a dated promise not yet at its deadline reports null rather
 * than a negative number that would render as "-4 days overdue".
 */
export async function hydrateOpenCommitments(
  db: Executor,
  now: Date,
  ownerPersonId?: string,
): Promise<OpenCommitment[]> {
  const open = await selectOpenCommitments(db, ownerPersonId);
  if (open.length === 0) return [];

  const ownerIds = [...new Set(open.map((row) => row.ownerPersonId).filter(isPresent))];
  const names = await getPersonDisplayNames(db, ownerIds);

  return open.map((row) => ({
    commitmentId: row.id,
    substance: row.substance,
    ownerPersonId: row.ownerPersonId,
    ownerDisplayName: row.ownerPersonId === null ? null : (names.get(row.ownerPersonId) ?? null),
    promisedAt: row.promisedAt.toISOString(),
    deadline: row.deadline === null ? null : row.deadline.toISOString(),
    overdueDays: overdueDays(row.deadline ?? row.promisedAt, now),
    evidenceMessageIds: [row.sourceMessageId],
  }));
}

/** Narrowing helper, because `filter(Boolean)` does not narrow `string | null`. */
function isPresent(value: string | null): value is string {
  return value !== null;
}

/**
 * The whole `assess` context.
 *
 * **`activeMemberCount` is a count and never a list of names.** The Assessor phrases
 * findings about capabilities, and it needs to know whether "only one person" means one of
 * three or one of thirty — but handing it the roster would invite it to write about the
 * people in it. The finding is about the gap, not the person, and the cheapest way to keep
 * that true is not to send the names.
 *
 * The fact index is absent here too, for a plainer reason than in `ingest`: the Assessor
 * judges the candidates it is given, and every claim behind them already travelled as
 * evidence excerpts.
 */
export async function hydrateAssessContext(db: Executor, now: Date): Promise<AssessContext> {
  const org = await hydrateOrgContext(db, now);
  const openCommitments = await hydrateOpenCommitments(db, now);
  const activeMemberCount = await countActiveMembers(db);

  return { org, openCommitments, activeMemberCount };
}

/**
 * The fact index. `[F20]`
 *
 * **This is the whole of Baton's retrieval layer, and there is no vector store on purpose.**
 * A couple of hundred claims is a few thousand tokens, so the entire retrievable surface
 * fits in the request. Embeddings, pgvector and a search index for two hundred rows would
 * be ceremony that also introduces a way for the right fact to be *absent* from a request
 * — which is a far worse failure than a slightly larger prompt.
 *
 * `status = 'active'` only. Anything the Respondent can see can end up in an answer read
 * aloud, so a `pending_approval` claim reaching this list would break the promise that a
 * pending change never appears — by a different route than findings, and one nobody would
 * think to check.
 *
 * `ageDays` is computed here rather than by the model. It is the load-bearing number in a
 * stale answer, and a number a model invented is unfalsifiable: the coordinator has no way
 * to check "five months old" and every reason to believe it.
 */
export async function hydrateFactIndex(db: Executor, now: Date): Promise<FactIndexEntry[]> {
  const rows = await db
    .select({
      factId: facts.id,
      claim: facts.claim,
      assetName: assets.name,
      assetSensitivity: facts.sensitivity,
      lastConfirmedAt: facts.lastConfirmedAt,
      evidenceMessageIds: facts.evidenceMessageIds,
    })
    .from(facts)
    .leftJoin(assets, eq(assets.id, facts.assetId))
    .where(eq(facts.status, "active"))
    .orderBy(desc(facts.lastConfirmedAt));

  if (rows.length === 0) return [];

  // Holders come from `holdings`, not from `facts` — a claim has no holder column, because
  // who holds a thing is history and lives in its own table. One query for all of them
  // rather than one per fact.
  const holderRows = await db
    .select({
      evidenceFactId: holdings.evidenceFactId,
      holderPersonId: holdings.holderPersonId,
      holderExternal: holdings.holderExternal,
      displayName: people.displayName,
    })
    .from(holdings)
    .leftJoin(people, eq(people.id, holdings.holderPersonId))
    .where(eq(holdings.status, "active"));

  const holderByFact = new Map<string, { personId: string | null; name: string | null }>();
  for (const row of holderRows) {
    if (row.evidenceFactId === null) continue;
    holderByFact.set(row.evidenceFactId, {
      personId: row.holderPersonId,
      name: row.displayName ?? row.holderExternal,
    });
  }

  return rows.map((row) => {
    const holder = holderByFact.get(row.factId);
    return {
      factId: row.factId,
      claim: row.claim,
      assetName: row.assetName,
      assetSensitivity: row.assetSensitivity,
      holderPersonId: holder?.personId ?? null,
      holderDisplayName: holder?.name ?? null,
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
      ageDays: ageInDays(row.lastConfirmedAt, now),
      evidenceMessageIds: row.evidenceMessageIds,
    };
  });
}

/**
 * The whole `respond` context.
 *
 * `askBudgetAvailable` is a boolean the worker computed, not a rule the prompt is asked to
 * follow. The Respondent's `unknown` branch proposes a follow-up question, and whether
 * there is room to ask it is a count against `questions` — a prompt cannot remember what it
 * already asked, and one that was merely told the limit would forget it on the week the
 * register got busy.
 *
 * The aliases are included because an answer names people, and naming them the way the
 * group does is the difference between an answer that reads as Baton's and one that reads
 * as a database's.
 */
export async function hydrateRespondContext(db: Executor, now: Date): Promise<RespondContext> {
  const org = await hydrateOrgContext(db, now);
  const factIndex = await hydrateFactIndex(db, now);
  const aliases = await hydrateAliases(db);
  const budget = await askBudgetStatus(db, now);

  return {
    org,
    factIndex,
    aliases,
    askBudgetAvailable: budget.available,
    staleThresholdDays: STALE_FACT_THRESHOLD_DAYS,
  };
}

/**
 * Active holdings, with a count of who else holds the same thing.
 *
 * `otherActiveHolders === 0` is what makes a line belong in "only they held". The count
 * excludes the row itself, so a thing two people hold reports 1 and does not become a
 * handover item — the group has not lost access to it.
 */
async function hydrateHoldings(db: Executor, where: SQL): Promise<HoldingEntry[]> {
  const rows = await db
    .select({
      holdingId: holdings.id,
      assetId: assets.id,
      assetName: assets.name,
      assetKind: assets.kind,
      assetSensitivity: assets.sensitivity,
      isPersonalResource: holdings.isPersonalResource,
      evidenceFactId: holdings.evidenceFactId,
      // Counted in SQL rather than by a second pass in JS: it is a count, and the Briefer
      // must never be the thing that counts.
      otherActiveHolders: sql<string>`(
        select count(*)
        from holdings peer
        where peer.asset_id = ${holdings.assetId}
          and peer.status = 'active'
          and peer.id <> ${holdings.id}
          and (peer.holder_person_id is not null or peer.holder_external is not null)
      )::text`,
    })
    .from(holdings)
    .innerJoin(assets, eq(assets.id, holdings.assetId))
    // The F33 join again: a holding whose claim is `pending_approval` must not reach a
    // handover document any more than it reaches a finding.
    .innerJoin(facts, and(eq(facts.id, holdings.evidenceFactId), eq(facts.status, "active")))
    .where(and(eq(holdings.status, "active"), eq(assets.status, "active"), where))
    .orderBy(assets.name);

  if (rows.length === 0) return [];

  const factIds = [...new Set(rows.map((row) => row.evidenceFactId).filter(isPresent))];
  const evidenceRows =
    factIds.length === 0
      ? []
      : await db
          .select({ id: facts.id, evidenceMessageIds: facts.evidenceMessageIds })
          .from(facts)
          .where(inArray(facts.id, factIds));
  const messagesByFact = new Map(evidenceRows.map((row) => [row.id, row.evidenceMessageIds]));

  return rows.map((row) => ({
    holdingId: row.holdingId,
    assetId: row.assetId,
    assetName: row.assetName,
    assetKind: row.assetKind,
    assetSensitivity: row.assetSensitivity,
    isPersonalResource: row.isPersonalResource,
    otherActiveHolders: Number(row.otherActiveHolders),
    evidenceFactIds: row.evidenceFactId === null ? [] : [row.evidenceFactId],
    evidenceMessageIds:
      row.evidenceFactId === null ? [] : (messagesByFact.get(row.evidenceFactId) ?? []),
  }));
}

/**
 * Coverage sets, with everyone observed in each.
 *
 * `observedPersonIds.length === 1` is what makes a capability belong in "nobody else seen
 * doing this". The list is ids rather than names because the Briefer phrases lines about the
 * capability, and handing it a list of names invites lines about the people.
 */
async function hydrateCoverage(db: Executor, capabilityIds: string[]): Promise<CoverageEntry[]> {
  if (capabilityIds.length === 0) return [];

  const rows = await db
    .select({
      capabilityId: capabilities.id,
      capabilityName: capabilities.name,
      personId: capabilityCoverage.personId,
      evidenceMessageIds: capabilityCoverage.evidenceMessageIds,
    })
    .from(capabilityCoverage)
    .innerJoin(capabilities, eq(capabilities.id, capabilityCoverage.capabilityId))
    .where(inArray(capabilityCoverage.capabilityId, capabilityIds))
    .orderBy(capabilities.name);

  const byCapability = new Map<string, CoverageEntry>();
  for (const row of rows) {
    const existing = byCapability.get(row.capabilityId);
    if (existing === undefined) {
      byCapability.set(row.capabilityId, {
        capabilityId: row.capabilityId,
        capabilityName: row.capabilityName,
        observedPersonIds: [row.personId],
        evidenceMessageIds: [...row.evidenceMessageIds],
      });
      continue;
    }
    existing.observedPersonIds.push(row.personId);
    for (const messageId of row.evidenceMessageIds) {
      if (!existing.evidenceMessageIds.includes(messageId)) {
        existing.evidenceMessageIds.push(messageId);
      }
    }
  }

  return [...byCapability.values()];
}

/** Capabilities the subject has been observed in. */
async function capabilityIdsFor(db: Executor, personId: string): Promise<string[]> {
  const rows = await db
    .select({ capabilityId: capabilityCoverage.capabilityId })
    .from(capabilityCoverage)
    .where(eq(capabilityCoverage.personId, personId));
  return [...new Set(rows.map((row) => row.capabilityId))];
}

/** Capabilities with exactly one observed person — the arrival brief's third section. */
async function thinlyCoveredCapabilityIds(db: Executor): Promise<string[]> {
  const result = await db.execute<{ capability_id: string }>(sql`
    select capability_id
    from capability_coverage
    group by capability_id
    having count(*) = 1
  `);
  return [...result].map((row) => row.capability_id);
}

export interface BriefContextInput {
  kind: BriefKind;
  subjectPersonId: string;
}

/**
 * The `brief` context. **Not the whole register**, and the scoping differs by kind.
 *
 * A **departure** brief is about what is leaving with this person: their active holdings,
 * their open commitments, the coverage sets they appear in. Sending the whole register would
 * multiply cost by its size and invite a document about the organisation rather than about
 * the handover.
 *
 * An **arrival** brief runs the same generator against the same three sections, but scoped to
 * *the register's gaps* rather than to the subject — who by definition holds nothing yet.
 * So: assets with no owner or a single holder, unowned open commitments, and capabilities
 * only one person has been seen doing. That is the honest reading of "what currently has no
 * owner or a single holder", and it is why this function branches rather than taking a
 * person and a flag.
 *
 * Unowned commitments are the arrival analogue of an unowned asset: "someone should sort the
 * printers" is exactly the kind of thing a new volunteer can pick up, and the kind most
 * likely to have been forgotten precisely because no name was attached to it.
 */
export async function hydrateBriefContext(
  db: Executor,
  now: Date,
  { kind, subjectPersonId }: BriefContextInput,
): Promise<BriefContext> {
  const org = await hydrateOrgContext(db, now);

  if (kind === "departure") {
    const subjectHoldings = await hydrateHoldings(db, eq(holdings.holderPersonId, subjectPersonId));
    const openCommitments = await hydrateOpenCommitments(db, now, subjectPersonId);
    const coverage = await hydrateCoverage(db, await capabilityIdsFor(db, subjectPersonId));
    return { org, holdings: subjectHoldings, openCommitments, coverage };
  }

  const fragile = await hydrateHoldings(db, sql`true`);
  const gaps = fragile.filter((entry) => entry.otherActiveHolders === 0);
  const unowned = (await hydrateOpenCommitments(db, now)).filter(
    (entry) => entry.ownerPersonId === null,
  );
  const coverage = await hydrateCoverage(db, await thinlyCoveredCapabilityIds(db));

  return { org, holdings: gaps, openCommitments: unowned, coverage };
}
