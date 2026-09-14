/**
 * The `quiet_decisions` table. `[F18]`
 *
 * Restraint's veto is not a silent drop. Everything it withholds lands here with its
 * reasoning, and the UI renders it as a strip a coordinator can read — which is the only
 * thing that makes an agent that decides *not* to speak trustworthy rather than
 * unaccountable. A tool that quietly says less is indistinguishable from one that is
 * broken.
 *
 * `scope` is recorded rather than inferred, and that is the load-bearing detail. Restraint
 * gates three produce paths — findings, brief lines, answers — and the two nobody watches
 * are the two a human reads aloud. Storing the scope is what lets a test assert the veto
 * has not silently narrowed to findings during a refactor, leaving briefs and answers
 * ungated with every test still green.
 */

import { desc, eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { QuietDecisionRecord, QuietDecisionScope } from "@baton/core";
import type { Executor } from "./types.js";

const { quietDecisions } = schema;

/**
 * Writes the quiet decisions from one agent response.
 *
 * No de-duplication and no conflict target, deliberately. A withheld item is an *event*,
 * not a state: the same finding withheld on two sweeps was withheld twice, and collapsing
 * the two would make the strip read as though Restraint had stopped working. The
 * `created_at` index exists because the strip is always read newest-first.
 */
export async function recordQuietDecisions(
  db: Executor,
  records: readonly QuietDecisionRecord[],
  runId: string | null,
): Promise<number> {
  if (records.length === 0) return 0;

  const rows = await db
    .insert(quietDecisions)
    .values(
      records.map((record) => ({
        scope: record.scope,
        withheld: record.withheld,
        reason: record.reason,
        findingDedupeKey: record.findingDedupeKey,
        runId,
      })),
    )
    .returning({ id: quietDecisions.id });

  return rows.length;
}

export interface QuietDecisionRow {
  id: string;
  scope: QuietDecisionScope;
  withheld: string;
  reason: string;
  findingDedupeKey: string | null;
  runId: string | null;
  createdAt: Date;
}

/** The strip, newest first. */
export async function selectQuietDecisions(db: Executor, limit = 50): Promise<QuietDecisionRow[]> {
  return db
    .select({
      id: quietDecisions.id,
      scope: quietDecisions.scope,
      withheld: quietDecisions.withheld,
      reason: quietDecisions.reason,
      findingDedupeKey: quietDecisions.findingDedupeKey,
      runId: quietDecisions.runId,
      createdAt: quietDecisions.createdAt,
    })
    .from(quietDecisions)
    .orderBy(desc(quietDecisions.createdAt))
    .limit(limit);
}

/** How many decisions exist in one scope. The assertion that the veto has not narrowed. */
export async function countQuietDecisions(
  db: Executor,
  scope: QuietDecisionScope,
): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(quietDecisions)
    .where(eq(quietDecisions.scope, scope));
  return Number(rows[0]?.count ?? 0);
}
