/**
 * The five detection queries. `[F15]` `[F17]` `[F33]`
 *
 * **Detection is SQL; judgment is the agent.** These queries produce every candidate
 * finding in the system by counting and grouping, and the Assessor never counts
 * anything. Asking a model how many people hold the store room key would be slower,
 * more expensive and less reliable than `group by ... having count(*) = 1`, and a
 * miscount is invisible: nothing about "only Meera has this" looks wrong when three
 * people do.
 *
 * Five queries, four rendered subtypes. Capability single-coverage presents as
 * `sole_holder` because to a coordinator it is the same problem, and `findings.type`
 * is what tells the two apart so their dedupe keys cannot collide. An owned and an
 * unowned loose end differ only in phrasing, which is the Assessor's job.
 *
 * **Every query filters `status = 'active'`, and that is the mechanism behind the
 * product's promise that a pending change never appears in a finding.** It is worth
 * being precise about where the filter bites, because it is not where it first looks.
 * `applyFact` writes a high-consequence weak claim as `pending_approval` and
 * `applyHolding` still opens the holding — the holding exists, the claim behind it is
 * not yet believed. Joining `facts` and requiring `active` is what keeps that holding
 * out of detection. Filtering on `holdings.status` alone would let it straight through.
 *
 * The one query with nothing to filter is capability coverage, which is not derived
 * from `facts` and has no status column. Its gate is at write time in the processing
 * loop, which refuses to record coverage for a record that would not have been written
 * `active`. Stated here because "every query filters active" is only true of this file
 * if you know where the fifth one's filter went.
 *
 * Shape note: each query returns **flat rows** and the grouping into candidates happens
 * in TypeScript. Aggregating jsonb arrays of evidence ids across a group is possible in
 * SQL and unreadable, and this is the file where SQL has to stay legible.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import {
  buildDedupeKey,
  contentHash,
  redactCredentials,
  type AssetKind,
  type AssetSensitivity,
  type FindingCandidate,
} from "@baton/core";
import type { Executor } from "../store/types.js";

const { findings, messages } = schema;

/**
 * How long an undated promise sits before it counts as a loose end.
 *
 * **A decision, not a specification.** The design says "past threshold" and gives no
 * number for the undated case, so this is mine and it is deliberately short. Three days
 * is below the four-day-old planted case in the seeded transcript, which is the point:
 * that case has to *become* a candidate so Restraint can then withhold it, because a
 * candidate that never appears cannot demonstrate restraint. Tune this and the seeded
 * demonstration changes shape, so it lives alone with a name rather than inline.
 *
 * A dated promise needs no threshold. Its deadline is the threshold.
 */
export const LOOSE_END_UNDATED_DAYS = 3;

/** How many quoted excerpts travel with a candidate. */
const MAX_EXCERPTS = 3;
/** Excerpts are for judging whether evidence is thin, not for reading the transcript. */
const EXCERPT_MAX_CHARS = 240;

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes returned by the raw queries
// ─────────────────────────────────────────────────────────────────────────────

type AssetHolderRow = {
  asset_id: string;
  asset_name: string;
  asset_kind: AssetKind;
  asset_sensitivity: AssetSensitivity;
  holder_person_id: string | null;
  holder_display_name: string | null;
  holder_external: string | null;
  fact_id: string;
  evidence_message_ids: string[];
};

type CapabilityRow = {
  capability_id: string;
  capability_name: string;
  person_id: string;
  display_name: string;
  evidence_message_ids: string[];
};

type UnownedAssetRow = {
  asset_id: string;
  asset_name: string;
  asset_kind: AssetKind;
  asset_sensitivity: AssetSensitivity;
  fact_id: string;
  evidence_message_ids: string[];
};

type CommitmentRow = {
  commitment_id: string;
  substance: string;
  owner_person_id: string | null;
  owner_display_name: string | null;
  source_message_id: string;
  deadline: Date | null;
  promised_at: Date;
};

/** postgres-js returns an iterable result object rather than a plain array. */
function rows<T>(result: Iterable<T>): T[] {
  return [...result];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. sole_holder — an asset exactly one person holds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assets with exactly one active holder.
 *
 * Personal resources are excluded here rather than reported twice. A holding flagged
 * `is_personal_resource` is a `not_ours` finding, and reporting the van as both a
 * one-person risk and as not the group's property would ask a coordinator to find a
 * backup for someone's own car — the exact confusion the flag exists to prevent.
 *
 * A holding with neither a person nor an external name is not a holder; it is the
 * *absence* of one, which is what `no_owner` reports. Counting it here would say one
 * person holds a thing nobody holds.
 *
 * The counting and the reporting are separate steps on purpose. Grouping by asset and
 * selecting the holder in the same query would need the holder columns in the `group by`,
 * which silently changes the grouping: two holders of one asset would become two groups
 * of one and both would be reported as sole holders. That bug produces a finding that
 * reads perfectly.
 */
export async function detectSoleHolderAssets(db: Executor): Promise<FindingCandidate[]> {
  const result = await db.execute<AssetHolderRow>(sql`
    with active_holdings as (
      select h.id, h.asset_id, h.holder_person_id, h.holder_external, h.evidence_fact_id
      from holdings h
      join facts f on f.id = h.evidence_fact_id and f.status = 'active'
      where h.status = 'active'
        and h.is_personal_resource = false
        and (h.holder_person_id is not null or h.holder_external is not null)
    ),
    single as (
      select asset_id
      from active_holdings
      group by asset_id
      having count(*) = 1
    )
    select
      a.id                    as asset_id,
      a.name                  as asset_name,
      a.kind                  as asset_kind,
      a.sensitivity           as asset_sensitivity,
      ah.holder_person_id     as holder_person_id,
      p.display_name          as holder_display_name,
      ah.holder_external      as holder_external,
      f.id                    as fact_id,
      f.evidence_message_ids  as evidence_message_ids
    from single s
    join assets a on a.id = s.asset_id and a.status = 'active'
    join active_holdings ah on ah.asset_id = s.asset_id
    join facts f on f.id = ah.evidence_fact_id
    left join people p on p.id = ah.holder_person_id
    order by a.name
  `);

  return rows(result).map((row) => ({
    dedupeKey: buildDedupeKey({ subtype: "sole_holder", type: "asset", subjectId: row.asset_id }),
    type: "asset" as const,
    subtype: "sole_holder" as const,
    subjectName: row.asset_name,
    subjectAssetId: row.asset_id,
    subjectCapabilityId: null,
    subjectCommitmentId: null,
    assetKind: row.asset_kind,
    assetSensitivity: row.asset_sensitivity,
    holderPersonId: row.holder_person_id,
    // An external holder has no `people` row, so their name comes from the holding. The
    // Assessor needs a name either way — a finding that says "one person holds this,
    // and we will not say who" is not actionable.
    holderDisplayName: row.holder_display_name ?? row.holder_external,
    // The claim that says who holds it. Other active facts about the asset describe its
    // terms rather than its holder, and they do not support this finding.
    evidenceFactIds: [row.fact_id],
    evidenceMessageIds: row.evidence_message_ids,
    evidenceCount: row.evidence_message_ids.length,
    evidenceExcerpts: [],
    capabilityArea: null,
    previousSeverity: null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. sole_holder — a capability exactly one person has been seen doing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capabilities with exactly one observed person.
 *
 * Departed members still count. `capability_coverage` records that someone *was seen*
 * doing something, not that they are available to do it now, and a departure has its own
 * surface: the brief, whose third section is precisely "nobody else seen doing this".
 * Filtering the departed out here would make the capability vanish from the register at
 * the moment it became most fragile, and would quietly add a sixth query to a design that
 * specifies five.
 */
export async function detectSoleHolderCapabilities(db: Executor): Promise<FindingCandidate[]> {
  const result = await db.execute<CapabilityRow>(sql`
    with single as (
      select capability_id
      from capability_coverage
      group by capability_id
      having count(*) = 1
    )
    select
      c.id                    as capability_id,
      c.name                  as capability_name,
      cc.person_id            as person_id,
      p.display_name          as display_name,
      cc.evidence_message_ids as evidence_message_ids
    from single s
    join capabilities c on c.id = s.capability_id
    join capability_coverage cc on cc.capability_id = s.capability_id
    join people p on p.id = cc.person_id
    order by c.name
  `);

  return rows(result).map((row) => ({
    dedupeKey: buildDedupeKey({
      subtype: "sole_holder",
      // What keeps this from colliding with an asset finding of the same subtype.
      type: "capability",
      subjectId: row.capability_id,
    }),
    type: "capability" as const,
    subtype: "sole_holder" as const,
    subjectName: row.capability_name,
    subjectAssetId: null,
    subjectCapabilityId: row.capability_id,
    subjectCommitmentId: null,
    assetKind: null,
    assetSensitivity: null,
    holderPersonId: row.person_id,
    holderDisplayName: row.display_name,
    // Coverage is not derived from facts, so there is no fact to cite. Provenance runs
    // straight to the messages that named the person as taking part.
    evidenceFactIds: [],
    evidenceMessageIds: row.evidence_message_ids,
    evidenceCount: row.evidence_message_ids.length,
    evidenceExcerpts: [],
    // The schema has no area taxonomy, so the capability's own name is the only grouping
    // the data supports. It is enough for the Assessor to aggregate two findings about
    // the same capability; it cannot group "the accounts" with "the bank login", and
    // inventing a taxonomy to let it would be inventing facts about the organisation.
    capabilityArea: row.capability_name,
    previousSeverity: null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. no_owner — an active asset nobody holds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active assets with no active holding, and with at least one active claim.
 *
 * The second condition is the F33 filter in its least obvious form. An asset created from
 * a claim that is still `pending_approval` has no believed claim behind it yet, and
 * reporting "nobody owns the bank login" on the strength of an unapproved sentence would
 * put the pending change in front of a coordinator by another route.
 *
 * An asset whose only holding records *no* holder counts as unowned, which is why the
 * ownership test requires a non-null holder rather than merely an active row. Null there
 * is not missing data — null is the finding.
 */
export async function detectNoOwnerAssets(db: Executor): Promise<FindingCandidate[]> {
  const result = await db.execute<UnownedAssetRow>(sql`
    select
      a.id                    as asset_id,
      a.name                  as asset_name,
      a.kind                  as asset_kind,
      a.sensitivity           as asset_sensitivity,
      f.id                    as fact_id,
      f.evidence_message_ids  as evidence_message_ids
    from assets a
    join facts f on f.asset_id = a.id and f.status = 'active'
    where a.status = 'active'
      and not exists (
        select 1
        from holdings h
        join facts hf on hf.id = h.evidence_fact_id and hf.status = 'active'
        where h.asset_id = a.id
          and h.status = 'active'
          and (h.holder_person_id is not null or h.holder_external is not null)
      )
    order by a.name, f.stated_at
  `);

  return groupAssetRows(result);
}

/**
 * Folds several fact rows for one asset into a single candidate.
 *
 * A `no_owner` finding is about the asset, so all of its active claims are evidence for
 * it — unlike `sole_holder`, where only the holder claim supports the count. That is why
 * this one aggregates and the other does not.
 */
function groupAssetRows(result: Iterable<UnownedAssetRow>): FindingCandidate[] {
  const byAsset = new Map<string, FindingCandidate>();

  for (const row of rows(result)) {
    const existing = byAsset.get(row.asset_id);
    if (existing === undefined) {
      byAsset.set(row.asset_id, {
        dedupeKey: buildDedupeKey({
          subtype: "no_owner",
          type: "asset",
          subjectId: row.asset_id,
        }),
        type: "asset",
        subtype: "no_owner",
        subjectName: row.asset_name,
        subjectAssetId: row.asset_id,
        subjectCapabilityId: null,
        subjectCommitmentId: null,
        assetKind: row.asset_kind,
        assetSensitivity: row.asset_sensitivity,
        // Nobody holds it. A holder attribute here would be a contradiction in terms.
        holderPersonId: null,
        holderDisplayName: null,
        evidenceFactIds: [row.fact_id],
        evidenceMessageIds: [...row.evidence_message_ids],
        evidenceCount: row.evidence_message_ids.length,
        evidenceExcerpts: [],
        capabilityArea: null,
        previousSeverity: null,
      });
      continue;
    }

    existing.evidenceFactIds.push(row.fact_id);
    for (const messageId of row.evidence_message_ids) {
      // De-duplicated, because a duplicate would inflate the very count the Assessor's
      // thin-evidence suppression reads.
      if (!existing.evidenceMessageIds.includes(messageId)) {
        existing.evidenceMessageIds.push(messageId);
      }
    }
    existing.evidenceCount = existing.evidenceMessageIds.length;
  }

  return [...byAsset.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. not_ours — the group depends on something it does not own
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active holdings flagged as someone's personal property.
 *
 * Not a risk about a person and not a gap to be filled by finding a backup: it is the
 * observation that the group's arrangement rests on a thing it has no claim to. Mistaking
 * this for `sole_holder` produces a finding that asks the group to find a second van.
 */
export async function detectNotOurs(db: Executor): Promise<FindingCandidate[]> {
  const result = await db.execute<AssetHolderRow>(sql`
    select
      a.id                    as asset_id,
      a.name                  as asset_name,
      a.kind                  as asset_kind,
      a.sensitivity           as asset_sensitivity,
      h.holder_person_id      as holder_person_id,
      p.display_name          as holder_display_name,
      h.holder_external       as holder_external,
      f.id                    as fact_id,
      f.evidence_message_ids  as evidence_message_ids
    from holdings h
    join assets a on a.id = h.asset_id and a.status = 'active'
    join facts f on f.id = h.evidence_fact_id and f.status = 'active'
    left join people p on p.id = h.holder_person_id
    where h.status = 'active'
      and h.is_personal_resource = true
    order by a.name
  `);

  return rows(result).map((row) => ({
    dedupeKey: buildDedupeKey({ subtype: "not_ours", type: "asset", subjectId: row.asset_id }),
    type: "asset" as const,
    subtype: "not_ours" as const,
    subjectName: row.asset_name,
    subjectAssetId: row.asset_id,
    subjectCapabilityId: null,
    subjectCommitmentId: null,
    assetKind: row.asset_kind,
    assetSensitivity: row.asset_sensitivity,
    holderPersonId: row.holder_person_id,
    holderDisplayName: row.holder_display_name ?? row.holder_external,
    evidenceFactIds: [row.fact_id],
    evidenceMessageIds: row.evidence_message_ids,
    evidenceCount: row.evidence_message_ids.length,
    evidenceExcerpts: [],
    capabilityArea: null,
    previousSeverity: null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. loose_end — an open promise nobody has closed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open commitments past their threshold, owned or not.
 *
 * Two thresholds because there are two kinds of promise. A dated one is past threshold
 * when its deadline has gone; an undated one — "I'll sort the printers" — has only its
 * age, and {@link LOOSE_END_UNDATED_DAYS} is how long that is allowed to be.
 *
 * Unowned intents are included deliberately. "Someone should sort the printers" is the
 * loose end most likely to be forgotten precisely because no name is attached to it, and
 * excluding it would filter out the harder half of the problem. The Assessor phrases the
 * two differently; detection treats them the same.
 */
export async function detectLooseEnds(db: Executor, now: Date): Promise<FindingCandidate[]> {
  // Computed here rather than as a SQL interval so the cutoff is one value a test can
  // state, and so the threshold cannot drift between the query and the assertion.
  const undatedCutoff = new Date(now.getTime() - LOOSE_END_UNDATED_DAYS * 86_400_000);

  const result = await db.execute<CommitmentRow>(sql`
    select
      c.id                as commitment_id,
      c.substance         as substance,
      c.owner_person_id   as owner_person_id,
      p.display_name      as owner_display_name,
      c.source_message_id as source_message_id,
      c.deadline          as deadline,
      c.promised_at       as promised_at
    from commitments c
    left join people p on p.id = c.owner_person_id
    where c.status = 'open'
      and (
        (c.deadline is not null and c.deadline < ${now.toISOString()}::timestamptz)
        or
        (c.deadline is null and c.promised_at < ${undatedCutoff.toISOString()}::timestamptz)
      )
    order by coalesce(c.deadline, c.promised_at)
  `);

  return rows(result).map((row) => ({
    dedupeKey: buildDedupeKey({
      subtype: "loose_end",
      type: "commitment",
      subjectId: row.commitment_id,
    }),
    type: "commitment" as const,
    subtype: "loose_end" as const,
    subjectName: row.substance,
    subjectAssetId: null,
    subjectCapabilityId: null,
    subjectCommitmentId: row.commitment_id,
    assetKind: null,
    assetSensitivity: null,
    holderPersonId: row.owner_person_id,
    holderDisplayName: row.owner_display_name,
    // A commitment is not derived from a fact — it is its own record of a promise.
    evidenceFactIds: [],
    evidenceMessageIds: [row.source_message_id],
    evidenceCount: 1,
    evidenceExcerpts: [],
    capabilityArea: null,
    previousSeverity: null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembling the candidate set
// ─────────────────────────────────────────────────────────────────────────────

export interface DetectionResult {
  candidates: FindingCandidate[];
  /** Keys a coordinator has dismissed, which were withheld before the Assessor saw them. */
  dismissedKeysSkipped: number;
  /**
   * A hash of the detected state. The sweep short-circuits on this, so nothing that a
   * sweep itself writes may contribute to it — see {@link fingerprintCandidates}.
   */
  fingerprint: string;
}

/**
 * A stable hash of the candidate set. `[F17]`
 *
 * **The sweep's short-circuit rests entirely on this, and it must be computed over the
 * detected state only.** Two fields of `FindingCandidate` are deliberately excluded, and
 * both would break it:
 *
 *   - **`previousSeverity`** is read *from* `findings`. A sweep that writes findings
 *     changes it, so including it would make the next sweep see a different fingerprint on
 *     an unchanged register — and the short-circuit would never fire even once. It is the
 *     one field guaranteed to differ after the very run whose output it describes.
 *   - **`evidenceExcerpts`** are message text, and the message ids that produced them are
 *     already hashed. Including the text would make a coordinator withdrawing one message
 *     trigger a full model sweep, which is not a change to any finding.
 *
 * Evidence id arrays are sorted before hashing. They are accumulated by appending, so two
 * runs can produce the same set in a different order, and an order-sensitive hash would
 * report a change that is not one.
 */
export function fingerprintCandidates(candidates: readonly FindingCandidate[]): string {
  const projection = candidates.map((candidate) => [
    candidate.dedupeKey,
    candidate.type,
    candidate.subtype,
    candidate.subjectName,
    candidate.subjectAssetId,
    candidate.subjectCapabilityId,
    candidate.subjectCommitmentId,
    candidate.assetKind,
    candidate.assetSensitivity,
    candidate.holderPersonId,
    [...candidate.evidenceFactIds].sort(),
    [...candidate.evidenceMessageIds].sort(),
    candidate.evidenceCount,
    candidate.capabilityArea,
  ]);

  // Sorted by key as well, so the hash does not depend on the order the five queries ran
  // in. That order is stable today; a hash that silently depended on it would be a trap
  // for whoever reorders them.
  projection.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  return contentHash(JSON.stringify(projection));
}

/**
 * Attaches quoted excerpts to candidates.
 *
 * One query for every message any candidate cites, rather than one per candidate, because
 * a sweep over a six-month register can easily produce forty candidates citing the same
 * dozen messages.
 *
 * Excerpts are **redacted and truncated**. This text reaches a model and can end up in a
 * finding a coordinator reads aloud, which makes it a render surface — the same reason
 * the evidence endpoint redacts. Messages stay verbatim in the database.
 */
async function attachExcerpts(db: Executor, candidates: FindingCandidate[]): Promise<void> {
  const needed = new Set<string>();
  for (const candidate of candidates) {
    for (const messageId of candidate.evidenceMessageIds.slice(0, MAX_EXCERPTS)) {
      needed.add(messageId);
    }
  }
  if (needed.size === 0) return;

  // Query builder rather than raw SQL for this one: drizzle's `sql` template expands a
  // JavaScript array into a parameter *list*, so `= any(${ids})` becomes a row
  // constructor and Postgres rejects the cast. `inArray` builds the list correctly.
  const result = await db
    .select({ id: messages.id, text: messages.text })
    .from(messages)
    .where(and(inArray(messages.id, [...needed]), eq(messages.isWithdrawn, false)));

  const texts = new Map<string, string>();
  for (const row of result) {
    if (row.text === null || row.text.trim() === "") continue;
    const redacted = redactCredentials(row.text);
    texts.set(
      row.id,
      redacted.length > EXCERPT_MAX_CHARS ? `${redacted.slice(0, EXCERPT_MAX_CHARS)}…` : redacted,
    );
  }

  for (const candidate of candidates) {
    candidate.evidenceExcerpts = candidate.evidenceMessageIds
      .slice(0, MAX_EXCERPTS)
      .map((messageId) => texts.get(messageId))
      .filter((text): text is string => text !== undefined);
  }
}

/**
 * Attaches the severity each key carried on the previous sweep.
 *
 * **This is what gates Restraint on the findings path.** Sweeps re-derive findings from
 * scratch, so an ungated Restraint would re-veto the same settled items on every sweep
 * forever — the second-largest model consumer in the system, producing no new information
 * and churning the quiet-decisions strip between sweeps for no reason a coordinator can
 * observe. A null here means the key is genuinely new.
 */
async function attachPreviousSeverity(db: Executor, candidates: FindingCandidate[]): Promise<void> {
  if (candidates.length === 0) return;

  const result = await db
    .select({ dedupeKey: findings.dedupeKey, severity: findings.severity })
    .from(findings)
    .where(
      inArray(
        findings.dedupeKey,
        candidates.map((candidate) => candidate.dedupeKey),
      ),
    );

  const previous = new Map(result.map((row) => [row.dedupeKey, row.severity]));
  for (const candidate of candidates) {
    candidate.previousSeverity = previous.get(candidate.dedupeKey) ?? null;
  }
}

/**
 * Removes candidates whose key a coordinator has dismissed.
 *
 * Dismissal is permanent, and it is cheaper and more honest to drop these before the
 * Assessor rather than after. Judging them every sweep would spend model calls to produce
 * a finding the upsert then refuses to write, and the only observable effect would be the
 * cost.
 *
 * `resolved` keys are deliberately **not** dropped. A resolved finding whose condition
 * has recurred is a real finding again — one that was fixed and came back is arguably the
 * most worth surfacing — and only an explicit dismissal is a statement about the finding
 * itself rather than about its subject at a moment in time.
 */
async function dropDismissed(
  db: Executor,
  candidates: FindingCandidate[],
): Promise<{ kept: FindingCandidate[]; skipped: number }> {
  if (candidates.length === 0) return { kept: candidates, skipped: 0 };

  const result = await db
    .select({ dedupeKey: findings.dedupeKey })
    .from(findings)
    .where(
      and(
        eq(findings.status, "dismissed"),
        inArray(
          findings.dedupeKey,
          candidates.map((candidate) => candidate.dedupeKey),
        ),
      ),
    );

  const dismissed = new Set(result.map((row) => row.dedupeKey));
  if (dismissed.size === 0) return { kept: candidates, skipped: 0 };

  const kept = candidates.filter((candidate) => !dismissed.has(candidate.dedupeKey));
  return { kept, skipped: candidates.length - kept.length };
}

/**
 * Runs all five queries and returns the Assessor's candidate set.
 *
 * Order within the returned array is stable — the five queries in the order the design
 * lists them, each internally sorted — so a sweep fingerprint computed over it does not
 * change just because Postgres returned rows differently.
 */
export async function detectFindings(db: Executor, now: Date): Promise<DetectionResult> {
  const candidates = [
    ...(await detectSoleHolderAssets(db)),
    ...(await detectSoleHolderCapabilities(db)),
    ...(await detectNoOwnerAssets(db)),
    ...(await detectNotOurs(db)),
    ...(await detectLooseEnds(db, now)),
  ];

  const { kept, skipped } = await dropDismissed(db, candidates);

  // Fingerprinted before the two enrichment passes, which is belt to the braces of
  // excluding their fields from the projection: at this point `previousSeverity` and
  // `evidenceExcerpts` are not even populated yet.
  const fingerprint = fingerprintCandidates(kept);

  await attachPreviousSeverity(db, kept);
  await attachExcerpts(db, kept);

  return { candidates: kept, dismissedKeysSkipped: skipped, fingerprint };
}
