/**
 * The `runs` table. `[F14]` `[F31]`
 *
 * Every pipeline pass opens a run and closes it, and the row is what the activity
 * panel renders. Two things about it are load bearing.
 *
 * **The counters exist as a set, not individually.** "Read 400, extracted 3" reads as
 * a broken pipeline unless the row also says 380 were never candidates. The
 * pre-filter's discards are therefore reported alongside the extractions rather than
 * left implicit, which is the difference between a coordinator trusting the number
 * and filing a bug.
 *
 * **The trace comes from the agent's response payload**, not from CloudWatch. The
 * panel needs it in the same database as everything else it renders, and a trace that
 * requires a second credentialled system to read is a trace nobody reads.
 *
 * The run row is written *outside* the pipeline lock's transaction. That is the point
 * of separating `openRun` from `closeRun`: if the locked work rolls back, the run row
 * survives to say so. A failed run that left no evidence of having run is
 * undiagnosable.
 */

import { eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { RunKind, RunStatus, TraceEntry } from "@baton/core";
import type { Executor } from "./types.js";

const { runs } = schema;

/**
 * The counters a pass reports. All optional and all defaulting to zero in the
 * column, so a pass that does not do a kind of work does not have to say so.
 */
export interface RunCounters {
  messagesRead?: number;
  candidates?: number;
  factsExtracted?: number;
  candidatesSkipped?: number;
  findingsProduced?: number;
}

export interface CloseRunInput {
  status: RunStatus;
  counters?: RunCounters;
  trace?: readonly TraceEntry[];
  /** One line. Present for `failed`, and read directly by the activity panel. */
  error?: string | null;
}

/** Opens a `running` row and returns its id. */
export async function openRun(db: Executor, kind: RunKind): Promise<string> {
  const rows = await db.insert(runs).values({ kind }).returning({ id: runs.id });
  const row = rows[0];
  if (row === undefined) throw new Error(`Failed to open a ${kind} run`);
  return row.id;
}

/**
 * Closes a run, stamping the finish time, the counters and the trace.
 *
 * Counters are *set*, not incremented. A pass computes its own totals and writes them
 * once, because an incrementing write would make the row depend on how many times the
 * pass happened to flush — and a run that reported 40 messages read because it
 * flushed four times is a number nobody can reconcile against the transcript.
 */
export async function closeRun(
  db: Executor,
  runId: string,
  { status, counters = {}, trace, error = null }: CloseRunInput,
): Promise<void> {
  await db
    .update(runs)
    .set({
      status,
      finishedAt: new Date(),
      messagesRead: counters.messagesRead ?? 0,
      candidates: counters.candidates ?? 0,
      factsExtracted: counters.factsExtracted ?? 0,
      candidatesSkipped: counters.candidatesSkipped ?? 0,
      findingsProduced: counters.findingsProduced ?? 0,
      ...(trace === undefined ? {} : { trace: [...trace] }),
      error,
    })
    .where(eq(runs.id, runId));
}

/**
 * Appends trace entries to a run without touching anything else.
 *
 * A pass that makes several agent calls accumulates a trace across them, and losing
 * the earlier calls' entries because the last one overwrote them would hide exactly
 * the call that was slow.
 */
export async function appendRunTrace(
  db: Executor,
  runId: string,
  entries: readonly TraceEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db
    .update(runs)
    .set({ trace: sql`${runs.trace} || ${JSON.stringify(entries)}::jsonb` })
    .where(eq(runs.id, runId));
}

export interface RunRow {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  messagesRead: number;
  candidates: number;
  factsExtracted: number;
  candidatesSkipped: number;
  findingsProduced: number;
  trace: TraceEntry[];
  error: string | null;
}

/** Reads one run back. For the activity panel and for tests. */
export async function findRun(db: Executor, runId: string): Promise<RunRow | null> {
  const rows = await db
    .select({
      id: runs.id,
      kind: runs.kind,
      status: runs.status,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      messagesRead: runs.messagesRead,
      candidates: runs.candidates,
      factsExtracted: runs.factsExtracted,
      candidatesSkipped: runs.candidatesSkipped,
      findingsProduced: runs.findingsProduced,
      trace: runs.trace,
      error: runs.error,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}
