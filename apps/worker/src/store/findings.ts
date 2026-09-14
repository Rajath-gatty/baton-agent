/**
 * The `findings` table. `[F15]` `[F16]` `[F19]`
 *
 * Sweeps re-derive every finding from scratch, so this module's whole job is identity:
 * recognising that the thing SQL just detected is the thing already in the register.
 * `dedupe_key` is what makes that possible, and it is the reason a sweep does not either
 * duplicate the register or resurrect something a coordinator already dismissed.
 *
 * Three responsibilities that are easy to miss:
 *
 *   - **Judgment and evidence come from different places.** The Assessor returns severity,
 *     phrasing, suppression and aggregation; it is never given the evidence ids and could
 *     not echo them back reliably if it were. The candidate carries the evidence. This
 *     module marries the two, which is why it takes both.
 *   - **A dismissed row is never touched.** Dismissed keys are already dropped before the
 *     Assessor sees them, and the upsert additionally refuses to update a dismissed row —
 *     belt and braces, because a dismissal silently undone is the failure this column
 *     exists to prevent and one guard is one refactor away from none.
 *   - **The title must not name a person**, and only the worker knows the roster. That
 *     check lives here, at the last point before the text is written.
 */

import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { AssessorFinding, FindingCandidate } from "@baton/core";
import type { Executor } from "./types.js";

const { findings, people, personAliases } = schema;

export type UpsertOutcome = "created" | "updated" | "reopened" | "skipped";

export interface UpsertedFinding {
  dedupeKey: string;
  outcome: UpsertOutcome;
  findingId: string | null;
  /** Set when the Assessor's title named a person and was replaced. */
  titleRewritten: boolean;
}

export interface UpsertFindingsInput {
  /** The Assessor's judgments, keyed back to candidates by `dedupeKey`. */
  judged: readonly AssessorFinding[];
  /** Everything SQL detected this sweep. Carries the evidence. */
  candidates: readonly FindingCandidate[];
  runId: string;
  at: Date;
}

export interface ReconcileResult {
  written: UpsertedFinding[];
  /** Keys the Assessor suppressed. Existing rows are left open — see the note below. */
  suppressed: string[];
  /** Keys subsumed into another finding, and closed if they were open. */
  aggregated: string[];
  /** Open rows whose condition is no longer detected at all. */
  resolved: string[];
  titlesRewritten: number;
}

/**
 * Words that are never treated as a person's name, however they are capitalised.
 *
 * Without this, a roster containing someone called "Van" or "Key" would make every
 * sensible title look like it named a person. Short and boring on purpose: the check it
 * guards is a safety net, not a natural-language task.
 */
const NEVER_A_NAME = new Set(["the", "a", "an", "and", "or", "no", "one", "only", "it"]);

/**
 * Every name the roster knows, lowercased.
 *
 * Display names and learned aliases both, because "Meera" is an alias and "Meera
 * Sundaram" is a display name and a title naming either has named a person.
 */
export async function loadRosterNames(db: Executor): Promise<Set<string>> {
  const names = new Set<string>();

  const displayNames = await db.select({ displayName: people.displayName }).from(people);
  for (const row of displayNames) {
    for (const part of row.displayName.toLowerCase().split(/\s+/)) {
      if (part.length > 2 && !NEVER_A_NAME.has(part)) names.add(part);
    }
  }

  const aliases = await db
    .select({ normalisedAlias: personAliases.normalisedAlias, kind: personAliases.kind })
    .from(personAliases);
  for (const row of aliases) {
    // Role references are excluded: "the coordinator" is a role, not a name, and a title
    // saying "only the coordinator can approve payments" is exactly the phrasing wanted.
    if (row.kind === "role_reference") continue;
    for (const part of row.normalisedAlias.split(/\s+/)) {
      if (part.length > 2 && !NEVER_A_NAME.has(part)) names.add(part);
    }
  }

  return names;
}

/** Whether a title names someone on the roster. */
export function titleNamesAPerson(title: string, rosterNames: ReadonlySet<string>): boolean {
  // Word-boundary split on the same characters aliases are normalised over, so
  // "Meera's" and "(Meera)" both reduce to "meera".
  const words = title.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u);
  return words.some((word) => word.length > 2 && rosterNames.has(word));
}

/**
 * A person-free title, derived from what the finding is about.
 *
 * Used when the Assessor's title names someone. **The finding is still written** — the
 * risk it describes is real, and dropping it to punish the phrasing would lose the very
 * thing the register exists for. The model's original wording is kept in
 * `assessor_reasoning` so nothing is hidden and the prompt can be diagnosed.
 *
 * Only the title is repaired. `why_it_matters` is left as written: a sentence about
 * consequence can legitimately reference the holder the finding already records as an
 * attribute, and silently rewriting prose to satisfy a heuristic is a worse failure than
 * the one it avoids.
 */
export function neutralTitle(candidate: FindingCandidate): string {
  switch (candidate.subtype) {
    case "sole_holder":
      return candidate.type === "capability"
        ? `Only one person has been seen doing ${candidate.subjectName}`
        : `Only one person holds ${candidate.subjectName}`;
    case "no_owner":
      return `Nobody is recorded as holding ${candidate.subjectName}`;
    case "not_ours":
      return `${candidate.subjectName} is not the group's own property`;
    case "loose_end":
      return `An open commitment: ${candidate.subjectName}`;
  }
}

/**
 * Writes one finding, marrying the Assessor's judgment to the candidate's evidence.
 *
 * `first_seen_at` is deliberately absent from the update: it records when the register
 * first raised this, and a sweep rewriting it would erase how long a gap has been sitting
 * open — which is most of what makes the register worth reading.
 */
async function upsertFinding(
  db: Executor,
  judgment: AssessorFinding,
  candidate: FindingCandidate,
  rosterNames: ReadonlySet<string>,
  runId: string,
  at: Date,
): Promise<UpsertedFinding> {
  const namesAPerson = titleNamesAPerson(judgment.title, rosterNames);
  const title = namesAPerson ? neutralTitle(candidate) : judgment.title;
  const reasoning = namesAPerson
    ? `${judgment.reasoning} (Title replaced; the Assessor's wording named a person: ${judgment.title})`
    : judgment.reasoning;

  const rows = await db
    .insert(findings)
    .values({
      type: candidate.type,
      subtype: candidate.subtype,
      dedupeKey: candidate.dedupeKey,
      title,
      whyItMatters: judgment.whyItMatters,
      severity: judgment.severity,
      confidence: judgment.confidence,
      status: "open",
      subjectAssetId: candidate.subjectAssetId,
      subjectCapabilityId: candidate.subjectCapabilityId,
      subjectCommitmentId: candidate.subjectCommitmentId,
      holderPersonId: candidate.holderPersonId,
      evidenceFactIds: [...candidate.evidenceFactIds],
      evidenceMessageIds: [...candidate.evidenceMessageIds],
      assessorReasoning: reasoning,
      firstSeenAt: at,
      lastSeenAt: at,
      lastRunId: runId,
    })
    .onConflictDoUpdate({
      target: findings.dedupeKey,
      // A resolved finding whose condition has recurred reopens. `resolved_at` is cleared
      // with it, or the row would claim to be both open and settled.
      set: {
        title,
        whyItMatters: judgment.whyItMatters,
        severity: judgment.severity,
        confidence: judgment.confidence,
        status: "open",
        resolvedAt: null,
        subjectAssetId: candidate.subjectAssetId,
        subjectCapabilityId: candidate.subjectCapabilityId,
        subjectCommitmentId: candidate.subjectCommitmentId,
        holderPersonId: candidate.holderPersonId,
        evidenceFactIds: [...candidate.evidenceFactIds],
        evidenceMessageIds: [...candidate.evidenceMessageIds],
        assessorReasoning: reasoning,
        lastSeenAt: at,
        lastRunId: runId,
      },
      // Dismissal is permanent. Dismissed keys never reach here — they are dropped before
      // the Assessor — and this is the second lock on the same door.
      setWhere: ne(findings.status, "dismissed"),
    })
    .returning({
      id: findings.id,
      created: sql<boolean>`(xmax = 0)`,
      // Read back after the update, so a row that was resolved and is now open reports as
      // reopened rather than as an ordinary update.
      resolvedAt: findings.resolvedAt,
    });

  const row = rows[0];
  if (row === undefined) {
    // The `setWhere` refused it: the row is dismissed. Not an error.
    return {
      dedupeKey: candidate.dedupeKey,
      outcome: "skipped",
      findingId: null,
      titleRewritten: false,
    };
  }

  return {
    dedupeKey: candidate.dedupeKey,
    outcome: row.created ? "created" : "updated",
    findingId: row.id,
    titleRewritten: namesAPerson,
  };
}

/**
 * Applies a whole `assess` result to the register.
 *
 * The four dispositions a candidate can receive, and why each is what it is:
 *
 *   - **Judged and kept** — upserted on `dedupe_key`.
 *   - **Suppressed** — no row is created, and *an existing open row is left alone*.
 *     Suppression says "not worth raising", not "no longer true". Withdrawing something a
 *     coordinator has already read, with no explanation, is worse than leaving a thin item
 *     in the register where Dismiss is one click away. Its `last_seen_at` is bumped so the
 *     resolve pass below does not mistake it for a condition that has gone.
 *   - **Aggregated into another finding** — closed if it was open, because three exposures
 *     presented as one problem and also as three is how a register of eight useful items
 *     becomes thirty noisy ones. `resolved` is the only status available for "no longer
 *     separately open"; the alternative was inventing a fourth status for a UI that
 *     renders three.
 *   - **Not detected at all this sweep** — resolved. This is what closes the orphan
 *     finding after somebody takes over the donation page, with no special-case code for
 *     it anywhere.
 */
export async function applyAssessResult(
  db: Executor,
  { judged, candidates, runId, at }: UpsertFindingsInput,
): Promise<ReconcileResult> {
  const byKey = new Map(candidates.map((candidate) => [candidate.dedupeKey, candidate]));
  const rosterNames = await loadRosterNames(db);

  const written: UpsertedFinding[] = [];
  const suppressed: string[] = [];
  const aggregated = new Set<string>();

  for (const judgment of judged) {
    for (const key of judgment.aggregatedDedupeKeys) {
      // A finding cannot subsume itself, and a model that says so must not close the row
      // it just asked for.
      if (key !== judgment.dedupeKey) aggregated.add(key);
    }
  }

  for (const judgment of judged) {
    const candidate = byKey.get(judgment.dedupeKey);
    // A judgment for a key that was never a candidate is discarded. A hallucinated key
    // could otherwise write a finding about nothing, or collide with a real one.
    if (candidate === undefined) continue;
    if (aggregated.has(judgment.dedupeKey)) continue;

    if (judgment.suppress) {
      suppressed.push(judgment.dedupeKey);
      continue;
    }

    written.push(await upsertFinding(db, judgment, candidate, rosterNames, runId, at));
  }

  // Suppressed keys keep their place in the register, so they must not look abandoned.
  if (suppressed.length > 0) {
    await db
      .update(findings)
      .set({ lastSeenAt: at, lastRunId: runId })
      .where(and(inArray(findings.dedupeKey, suppressed), eq(findings.status, "open")));
  }

  const aggregatedKeys = [...aggregated];
  if (aggregatedKeys.length > 0) {
    await db
      .update(findings)
      .set({ status: "resolved", resolvedAt: at, lastSeenAt: at, lastRunId: runId })
      .where(and(inArray(findings.dedupeKey, aggregatedKeys), eq(findings.status, "open")));
  }

  const detectedKeys = candidates.map((candidate) => candidate.dedupeKey);
  const resolved = await resolveUndetected(db, detectedKeys, runId, at);

  return {
    written,
    suppressed,
    aggregated: aggregatedKeys,
    resolved,
    titlesRewritten: written.filter((entry) => entry.titleRewritten).length,
  };
}

/**
 * Closes open findings whose condition no longer appears in the candidate set.
 *
 * The mechanism behind the orphan case closing itself: once somebody else is recorded as
 * holding the donation page, the `sole_holder` query stops returning it, its key is absent
 * here, and the row resolves. No code anywhere knows about donation pages.
 *
 * Called only from a **successful** sweep. A failed detection pass returns an empty
 * candidate set, and resolving the entire register because one query threw would be the
 * most destructive thing this module could do.
 */
export async function resolveUndetected(
  db: Executor,
  detectedKeys: readonly string[],
  runId: string,
  at: Date,
): Promise<string[]> {
  const rows = await db
    .update(findings)
    .set({ status: "resolved", resolvedAt: at, lastRunId: runId })
    .where(
      and(
        eq(findings.status, "open"),
        detectedKeys.length === 0
          ? // `notInArray` with an empty list is not valid SQL, and "nothing was detected"
            // means every open finding is undetected.
            sql`true`
          : notInArray(findings.dedupeKey, [...detectedKeys]),
      ),
    )
    .returning({ dedupeKey: findings.dedupeKey });

  return rows.map((row) => row.dedupeKey);
}

export interface OpenFinding {
  id: string;
  dedupeKey: string;
  type: string;
  subtype: string;
  title: string;
  whyItMatters: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  holderPersonId: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** The register's only query: open findings, worst first. */
export async function selectOpenFindings(db: Executor): Promise<OpenFinding[]> {
  return (
    db
      .select({
        id: findings.id,
        dedupeKey: findings.dedupeKey,
        type: findings.type,
        subtype: findings.subtype,
        title: findings.title,
        whyItMatters: findings.whyItMatters,
        severity: findings.severity,
        confidence: findings.confidence,
        holderPersonId: findings.holderPersonId,
        firstSeenAt: findings.firstSeenAt,
        lastSeenAt: findings.lastSeenAt,
      })
      .from(findings)
      .where(eq(findings.status, "open"))
      // The enum is declared low → medium → high, so descending is worst first. This is
      // what the `findings(status, severity desc)` index exists for.
      .orderBy(sql`${findings.severity} desc`, findings.firstSeenAt)
  );
}

/**
 * Records a coordinator's dismissal.
 *
 * Permanent by design: the reason is kept because "we already have a backup" and "not a
 * problem" are different statements and both are worth reading later. Only an open finding
 * can be dismissed — dismissing a resolved one would reopen a question nobody asked.
 */
export async function dismissFinding(
  db: Executor,
  dedupeKey: string,
  reason: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(findings)
    .set({ status: "dismissed", dismissalReason: reason, dismissedAt: at })
    .where(and(eq(findings.dedupeKey, dedupeKey), eq(findings.status, "open")))
    .returning({ id: findings.id });
  return rows.length > 0;
}

/** Open findings not yet seen by any run. For tests and for the activity panel. */
export async function countUnattributedFindings(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(findings)
    .where(isNull(findings.lastRunId));
  return Number(rows[0]?.count ?? 0);
}
