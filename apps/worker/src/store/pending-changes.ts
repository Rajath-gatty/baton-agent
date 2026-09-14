/**
 * The `pending_changes` table. `[F31]` `[F32]`
 *
 * A write held back until a human agrees. Three properties are load bearing, and each
 * prevents a specific failure the design names:
 *
 *   - **A pending change is never stored as truth and never used in any finding.** That is
 *     enforced elsewhere and by construction: the claim itself sits in `facts` at
 *     `pending_approval`, and every detection query, the fact index and the brief context
 *     all filter to `active`. This table holds the *proposal*, not the belief.
 *   - **Two approvals about one asset are never asked in parallel.** Two answers could
 *     contradict, and the second would silently win. So the second proposal is stored and
 *     waits; it is asked once the first resolves.
 *   - **`obsolete` is a real third outcome, neither applied nor discarded.** An answer that
 *     arrives after the claim it was about has been superseded is not a late yes — it is an
 *     answer to a question that no longer exists, and applying it would resurrect a claim
 *     the group has already moved past.
 *
 * Consequence is stored rather than recomputed because it decided the routing at the time
 * the ask went out. If the asset's sensitivity is raised later, an approval already sitting
 * with the coordinator should not retroactively claim it was always high-consequence.
 */

import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { ConsequenceLevel, PendingChangeStatus } from "@baton/core";
import type { Executor } from "./types.js";

const { pendingChanges } = schema;

export interface CreatePendingChangeInput {
  /** The write being held, as the agent or the worker proposed it. */
  proposedChange: unknown;
  consequence: ConsequenceLevel;
  assetId?: string | null;
  factId?: string | null;
  /** Present only when an agent interrupt raised this, so a `resume` can follow. */
  agentSessionId?: string | null;
}

export interface CreatedPendingChange {
  pendingChangeId: string;
  /**
   * Whether this may be asked about now.
   *
   * False when another proposal about the same asset is already awaiting an answer. The row
   * exists either way — nothing is dropped — but no question is created for it until the
   * one in front resolves.
   */
  askable: boolean;
}

/**
 * Records a proposal.
 *
 * The queue-behind check is scoped to the **asset**, not to the fact, because that is where
 * the contradiction lives: two proposals about who controls the bank account conflict even
 * when they concern different claims about it. A proposal with no asset — there are few —
 * is always askable, since there is nothing for it to conflict with.
 */
export async function createPendingChange(
  db: Executor,
  input: CreatePendingChangeInput,
): Promise<CreatedPendingChange> {
  const assetId = input.assetId ?? null;

  const blocking =
    assetId === null
      ? []
      : await db
          .select({ id: pendingChanges.id })
          .from(pendingChanges)
          .where(and(eq(pendingChanges.assetId, assetId), eq(pendingChanges.status, "pending")))
          .limit(1);

  const rows = await db
    .insert(pendingChanges)
    .values({
      proposedChange: input.proposedChange ?? {},
      consequence: input.consequence,
      assetId,
      factId: input.factId ?? null,
      agentSessionId: input.agentSessionId ?? null,
      status: "pending",
    })
    .returning({ id: pendingChanges.id });

  const row = rows[0];
  if (row === undefined) throw new Error("Failed to create a pending change");

  return { pendingChangeId: row.id, askable: blocking.length === 0 };
}

export interface PendingChangeRow {
  id: string;
  proposedChange: unknown;
  consequence: ConsequenceLevel;
  status: PendingChangeStatus;
  assetId: string | null;
  factId: string | null;
  agentSessionId: string | null;
  supersededById: string | null;
}

const columns = {
  id: pendingChanges.id,
  proposedChange: pendingChanges.proposedChange,
  consequence: pendingChanges.consequence,
  status: pendingChanges.status,
  assetId: pendingChanges.assetId,
  factId: pendingChanges.factId,
  agentSessionId: pendingChanges.agentSessionId,
  supersededById: pendingChanges.supersededById,
};

export async function findPendingChange(
  db: Executor,
  pendingChangeId: string,
): Promise<PendingChangeRow | null> {
  const rows = await db
    .select(columns)
    .from(pendingChanges)
    .where(eq(pendingChanges.id, pendingChangeId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The next proposal to ask about for an asset, once the one in front has resolved.
 *
 * Oldest first: a proposal that has been waiting is asked before one that arrived since,
 * because the alternative is a queue where the newest item permanently starves the rest.
 */
export async function selectNextAskablePendingChange(
  db: Executor,
  assetId: string,
): Promise<PendingChangeRow | null> {
  const rows = await db
    .select(columns)
    .from(pendingChanges)
    .where(and(eq(pendingChanges.assetId, assetId), eq(pendingChanges.status, "pending")))
    .orderBy(asc(pendingChanges.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Resolves a proposal as applied. Succeeds once, so a retried resume cannot apply twice. */
export async function markPendingChangeApplied(
  db: Executor,
  pendingChangeId: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(pendingChanges)
    .set({ status: "applied", appliedAt: at, resolvedAt: at })
    .where(and(eq(pendingChanges.id, pendingChangeId), eq(pendingChanges.status, "pending")))
    .returning({ id: pendingChanges.id });
  return rows.length > 0;
}

/** Resolves a proposal as rejected. The claim is not written; the record of asking survives. */
export async function markPendingChangeRejected(
  db: Executor,
  pendingChangeId: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(pendingChanges)
    .set({ status: "rejected", resolvedAt: at })
    .where(and(eq(pendingChanges.id, pendingChangeId), eq(pendingChanges.status, "pending")))
    .returning({ id: pendingChanges.id });
  return rows.length > 0;
}

/**
 * Retires a proposal whose subject has moved on.
 *
 * `supersededById` is set when a newer proposal about the same asset exists, which is the
 * only reading of that column that matches its name: this one was superseded by that one.
 * When nothing newer exists — the claim was simply superseded by a later message — the link
 * stays null and the status alone says what happened.
 */
export async function markPendingChangeObsolete(
  db: Executor,
  pendingChangeId: string,
  at: Date,
  supersededById: string | null = null,
): Promise<boolean> {
  const rows = await db
    .update(pendingChanges)
    .set({ status: "obsolete", resolvedAt: at, supersededById })
    .where(and(eq(pendingChanges.id, pendingChangeId), eq(pendingChanges.status, "pending")))
    .returning({ id: pendingChanges.id });
  return rows.length > 0;
}

/** Proposals still waiting. Rendered alongside the questions in the waiting-on line. */
export async function selectPendingChanges(db: Executor): Promise<PendingChangeRow[]> {
  return db
    .select(columns)
    .from(pendingChanges)
    .where(eq(pendingChanges.status, "pending"))
    .orderBy(asc(pendingChanges.createdAt));
}

/** How many proposals are held. For the activity panel and for tests. */
export async function countPendingChanges(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(pendingChanges)
    .where(eq(pendingChanges.status, "pending"));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Proposals holding a session nobody will resume.
 *
 * Used when abandoning: a proposal that went obsolete leaves a snapshot behind, and the
 * session has to be closed or the count of what Baton is waiting on stays wrong forever.
 */
export async function selectAbandonedSessions(db: Executor): Promise<string[]> {
  const rows = await db
    .select({ agentSessionId: pendingChanges.agentSessionId })
    .from(pendingChanges)
    .where(
      and(
        ne(pendingChanges.status, "pending"),
        sql`${pendingChanges.agentSessionId} is not null`,
        isNull(pendingChanges.appliedAt),
      ),
    );
  return rows.map((row) => row.agentSessionId).filter((id): id is string => id !== null);
}
