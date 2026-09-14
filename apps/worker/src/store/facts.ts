/**
 * `facts` — merge on restatement, supersede on contradiction, retire on negation. `[F8]`
 *
 * This is where the register either stays honest or fills with rubbish, and the three
 * outcomes are not symmetric:
 *
 *   - **Merge.** The same claim said again. `last_confirmed_at` moves forward and the
 *     new message is *appended* to the evidence. Nothing is replaced, because
 *     provenance accumulates — a claim the group has stated three times over five
 *     months should be able to show all three.
 *   - **Supersede.** The claim's value changed: the holder moved, or the figure did. A
 *     **new row** is inserted and `supersedes_fact_id` points at the old one, which
 *     becomes `superseded`. The old row is never rewritten, so "who held the van keys in
 *     March" stays answerable.
 *   - **Retire.** The arrangement was explicitly ended. No replacement row: the claim
 *     stops being true and nothing takes its place.
 *
 * `match_key` decides *which* claims are candidates for these three; `value_signature`
 * decides which of the three applies. Getting the second one wrong in the merge
 * direction is the dangerous failure — it bumps `last_confirmed_at` on a claim whose
 * content actually changed, so the register presents stale information as freshly
 * confirmed, which is invisible and is exactly what the staleness warning exists to
 * surface.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import {
  aspectFor,
  buildMatchKey,
  classifyConsequence,
  decideFactStatus,
  valueSignature,
  zonedDateToInstant,
} from "@baton/core";
import type { ConsequenceLevel, CuratorRecord, FactStatus } from "@baton/core";
import type { HolderResolution } from "../pipeline/entities.js";
import type { Executor } from "./types.js";

const { facts } = schema;

/** What happened to the register because of one record. */
export type FactOutcome = "inserted" | "merged" | "superseded" | "retired" | "skipped";

export interface AppliedFact {
  outcome: FactOutcome;
  /** Null only for `retired` and `skipped`, which produce no current row. */
  factId: string | null;
  /** Set on `superseded`: the row this one replaced. */
  supersededFactId?: string;
  status: FactStatus;
  consequence: ConsequenceLevel;
  matchKey: string;
  valueSignature: string;
  /** True when a human must agree before this becomes truth. Feeds the approval gate. */
  requiresApproval: boolean;
  reason: string;
}

export interface ApplyFactInput {
  record: CuratorRecord;
  holder: HolderResolution;
  /** The asset this claim is about, already upserted. Null for a claim about no thing. */
  assetId: string | null;
  /** The local `messages.id` this claim was read from. */
  messageId: string;
  /** The message's own timestamp — never "now". Backfill replays six months. */
  statedAt: Date;
  statedByPersonId: string | null;
  /** Resolved from `app_settings`, never UTC. */
  timezone: string;
  /** The Curator's one line, shown verbatim in the fact detail panel. */
  curatorReasoning?: string | null;
}

/**
 * Appends a message to a fact's evidence, at most once.
 *
 * Idempotent because backfill and crash replay both re-present the same message, and
 * evidence that grew a duplicate entry every replay would inflate the very count the
 * Assessor's suppression threshold reads.
 */
function appendEvidence(messageId: string) {
  return sql`case
    when ${facts.evidenceMessageIds} @> to_jsonb(array[${messageId}::text])
      then ${facts.evidenceMessageIds}
    else ${facts.evidenceMessageIds} || to_jsonb(array[${messageId}::text])
  end`;
}

/**
 * The holder identity a value signature is built from.
 *
 * An unresolved holder contributes nothing: the claim is about a person Baton could not
 * identify, so signing it by holder would make two different unknown holders look like
 * the same one. Falling back to the claim's figures is the honest reading, and the
 * clarification question is raised separately.
 */
function holderIdentity(holder: HolderResolution): string | null {
  if (holder.kind === "person") return holder.personId;
  if (holder.kind === "external") return holder.name;
  return null;
}

/**
 * Resolves the Curator's `YYYY-MM-DD` deadline into an instant at the group's timezone.
 *
 * Exported because commitments need the identical conversion, and two call sites doing
 * this differently would put a deadline a day out on one of them.
 */
export function resolveDeadline(
  record: Pick<CuratorRecord, "deadlineDate">,
  timezone: string,
): Date | null {
  if (record.deadlineDate === null) return null;
  return zonedDateToInstant(record.deadlineDate, timezone);
}

/**
 * Applies one extracted claim to the register.
 *
 * Returns what it did rather than logging it, so the processing loop can count outcomes
 * for the `runs` row and a test can assert on the decision rather than on a side effect.
 */
export async function applyFact(db: Executor, input: ApplyFactInput): Promise<AppliedFact> {
  const { record, holder, messageId, statedAt, statedByPersonId } = input;

  const aspect = aspectFor(record.holderMention);
  const matchKey = buildMatchKey({
    assetKind: record.assetKind,
    assetName: record.assetName,
    capabilityName: record.capabilityName,
    claim: record.claim,
    aspect,
  });
  const signature = valueSignature({ holder: holderIdentity(holder), claim: record.claim });

  const consequence = classifyConsequence({
    assetKind: record.assetKind,
    sensitivity: record.sensitivity,
  });
  const decision = decideFactStatus({
    consequence,
    confidence: record.confidence,
    isHearsay: record.isHearsay,
  });

  // The active claim this one is about, if there is one. Only `active` rows are
  // candidates: a superseded or retired row is history and must not be revived by a
  // later mention, which would undo a contradiction the group already settled.
  const existingRows = await db
    .select({
      id: facts.id,
      valueSignature: facts.valueSignature,
      lastConfirmedAt: facts.lastConfirmedAt,
      evidenceMessageIds: facts.evidenceMessageIds,
    })
    .from(facts)
    .where(and(eq(facts.matchKey, matchKey), eq(facts.status, "active")))
    .limit(1);
  const existing = existingRows[0];

  // ── Negation ───────────────────────────────────────────────────────────────
  if (record.isNegation) {
    if (existing === undefined) {
      // Nothing to end. Recording a retired claim for an arrangement never held would
      // put a fact in the register that was never true.
      return {
        outcome: "skipped",
        factId: null,
        status: decision.status,
        consequence,
        matchKey,
        valueSignature: signature,
        requiresApproval: false,
        reason: "An arrangement was ended that the register never held.",
      };
    }

    await db
      .update(facts)
      .set({
        status: "retired",
        retiredAt: statedAt,
        // The message that ended it is provenance for the ending.
        evidenceMessageIds: appendEvidence(messageId),
      })
      .where(eq(facts.id, existing.id));

    return {
      outcome: "retired",
      factId: existing.id,
      status: "retired",
      consequence,
      matchKey,
      valueSignature: signature,
      requiresApproval: false,
      reason: "The arrangement was explicitly ended.",
    };
  }

  // ── Restatement ────────────────────────────────────────────────────────────
  if (existing !== undefined && existing.valueSignature === signature) {
    await db
      .update(facts)
      .set({
        // `greatest` rather than assignment: backfill replays in `sent_at` order but a
        // late-arriving older message must not drag the confirmation date backwards.
        lastConfirmedAt: sql`greatest(${facts.lastConfirmedAt}, ${statedAt.toISOString()}::timestamptz)`,
        // Appended, never replaced.
        evidenceMessageIds: appendEvidence(messageId),
      })
      .where(eq(facts.id, existing.id));

    return {
      outcome: "merged",
      factId: existing.id,
      status: "active",
      consequence,
      matchKey,
      valueSignature: signature,
      requiresApproval: false,
      reason: "The same claim, stated again.",
    };
  }

  // ── Insert, superseding whatever it replaces ───────────────────────────────
  const inserted = await db
    .insert(facts)
    .values({
      assetId: input.assetId,
      claim: record.claim,
      matchKey,
      valueSignature: signature,
      confidence: record.confidence,
      status: decision.status,
      sensitivity: record.sensitivity,
      sourceMessageId: messageId,
      statedByPersonId,
      statedAt,
      lastConfirmedAt: statedAt,
      evidenceMessageIds: [messageId],
      supersedesFactId: existing?.id ?? null,
      curatorReasoning: input.curatorReasoning ?? null,
    })
    .returning({ id: facts.id });

  const factId = inserted[0]?.id;
  if (factId === undefined) throw new Error(`Failed to insert fact for message ${messageId}`);

  if (existing !== undefined) {
    // The old row keeps its claim text and its evidence. It is history now, not a
    // mistake, and the fact detail panel renders the chain.
    await db.update(facts).set({ status: "superseded" }).where(eq(facts.id, existing.id));

    return {
      outcome: "superseded",
      factId,
      supersededFactId: existing.id,
      status: decision.status,
      consequence,
      matchKey,
      valueSignature: signature,
      requiresApproval: decision.requiresApproval,
      reason: `The claim's value changed. ${decision.reason}`,
    };
  }

  return {
    outcome: "inserted",
    factId,
    status: decision.status,
    consequence,
    matchKey,
    valueSignature: signature,
    requiresApproval: decision.requiresApproval,
    reason: decision.reason,
  };
}

/**
 * The active claim for a match key, if the register holds one.
 *
 * Exported for the holdings logic, which needs the fact a holding is evidence for.
 */
export async function findActiveFactByMatchKey(
  db: Executor,
  matchKey: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: facts.id })
    .from(facts)
    .where(and(eq(facts.matchKey, matchKey), eq(facts.status, "active")))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** A fact's current status, or null when the row is gone. */
export async function findFactStatus(db: Executor, factId: string): Promise<FactStatus | null> {
  const rows = await db
    .select({ status: facts.status })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);
  return rows[0]?.status ?? null;
}

export interface FactStatusChange {
  /** Stamped when a human agreed. The strongest provenance any claim in the register has. */
  verifiedAt?: Date;
}

/**
 * Moves a fact between statuses.
 *
 * Deliberately narrow: it sets the status and, optionally, `verified_at`. It does not touch
 * the claim, the evidence or the supersession chain, because every caller that wants those
 * changed is doing something else — this exists for the approval gate, where a claim already
 * written as `pending_approval` becomes believed or disbelieved without its text changing.
 */
export async function updateFactStatus(
  db: Executor,
  factId: string,
  status: FactStatus,
  { verifiedAt }: FactStatusChange = {},
): Promise<boolean> {
  const rows = await db
    .update(facts)
    .set({ status, ...(verifiedAt === undefined ? {} : { verifiedAt }) })
    .where(eq(facts.id, factId))
    .returning({ id: facts.id });
  return rows.length > 0;
}
