/**
 * The periodic sweep. `[F17]` `[F18]` `[F19]`
 *
 * SQL derives the candidate findings; the Assessor judges them; the findings upsert on
 * `dedupe_key`. The single most important thing in this file is the thing it does *not* do.
 *
 * **The short-circuit lives in SQL, before the invocation.** If the candidate set is
 * byte-identical to the previous sweep's, the run ends without calling a model at all. A
 * sweep that calls a model and receives "nothing has changed" has already paid for the
 * answer. This system sits idle between judging sessions — nothing changes for days — and
 * an hourly unconditional sweep would cost more across a month than the entire build. The
 * short-circuit is therefore a design decision rather than an optimisation, and it cannot
 * be implemented in the Assessor's prompt no matter how the prompt is worded.
 *
 * Three consequences of that follow through the whole file:
 *
 *   - The fingerprint is stored **only after a successful sweep**. A failed sweep leaves
 *     the previous fingerprint in place, so the next one re-runs rather than concluding
 *     that nothing has changed since a sweep that never finished.
 *   - The fingerprint is computed over the *detected* state, excluding everything a sweep
 *     itself writes. `previousSeverity` is read from `findings`, so including it would
 *     guarantee the fingerprint differed after every sweep and the short-circuit would
 *     never fire once. See `fingerprintCandidates`.
 *   - A short-circuited sweep still writes a `runs` row. "Nothing had changed" is a result,
 *     and a silent sweep is indistinguishable from a scheduler that stopped.
 *
 * Restraint is gated inside the agent on `previousSeverity`, which the worker supplies.
 * That gating is what stops the second-largest model consumer in the system from re-vetoing
 * every settled finding on every sweep forever.
 */

import {
  assessResultSchema,
  type AgentRequest,
  type AssessContext,
  type AssessResult,
  type FindingCandidate,
  type RunKind,
  type RunStatus,
  type TraceEntry,
} from "@baton/core";
import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import { applyAssessResult, type ReconcileResult } from "../store/findings.js";
import { withPipelineLock } from "../store/lock.js";
import { recordQuietDecisions } from "../store/quiet-decisions.js";
import { closeRun, openRun } from "../store/runs.js";
import { getSweepState, setSweepState } from "../store/worker-state.js";
import type { Executor, Transaction } from "../store/types.js";
import { detectFindings } from "./detection.js";
import { hydrateAssessContext } from "./hydrate.js";

export interface SweepDeps {
  db: Database;
  transport: AgentTransport;
  now?: () => Date;
}

export interface SweepOptions {
  /** Defaults to `sweep`. Backfill's final pass passes `backfill`. */
  kind?: RunKind;
  /** An existing run to report into, for backfill's single-run replay. */
  runId?: string;
  /**
   * Runs the Assessor even when the candidate set is unchanged. For the initial register
   * after a backfill, where the fingerprint is meaningless because there was no previous
   * sweep to compare against but there is also nothing to protect against.
   */
  force?: boolean;
}

export interface SweepResult {
  runId: string | null;
  status: RunStatus | "skipped";
  lockHeld: boolean;
  /** True when the candidate set was unchanged and no model was called. */
  shortCircuited: boolean;

  candidates: number;
  dismissedKeysSkipped: number;
  fingerprint: string | null;

  findingsCreated: number;
  findingsUpdated: number;
  findingsSuppressed: number;
  findingsAggregated: number;
  findingsResolved: number;
  titlesRewritten: number;
  quietDecisions: number;
  trace: TraceEntry[];
}

function emptySweep(runId: string | null): SweepResult {
  return {
    runId,
    status: "complete",
    lockHeld: false,
    shortCircuited: false,
    candidates: 0,
    dismissedKeysSkipped: 0,
    fingerprint: null,
    findingsCreated: 0,
    findingsUpdated: 0,
    findingsSuppressed: 0,
    findingsAggregated: 0,
    findingsResolved: 0,
    titlesRewritten: 0,
    quietDecisions: 0,
    trace: [],
  };
}

/**
 * Sends the candidates for judgment.
 *
 * An `interrupt` is rejected rather than ignored. Restraint runs as a hook on the produce
 * path and withholds by returning a quiet decision, not by interrupting — an interrupt on
 * this path means the contract has changed, and continuing would drop whatever it asked
 * about while reporting success.
 */
async function invokeAssess(
  transport: AgentTransport,
  request: AgentRequest,
  trace: TraceEntry[],
): Promise<AssessResult> {
  const response = await transport.invoke(request);
  trace.push(...response.trace);

  if (response.stopReason === "error") {
    throw new Error(`Agent assess failed: ${response.error ?? "no error was reported"}`);
  }
  if (response.stopReason === "interrupt") {
    throw new Error(
      "Agent assess raised an interrupt, which the sweep does not implement. Restraint " +
        "withholds by returning a quiet decision rather than by interrupting.",
    );
  }

  return assessResultSchema.parse(response.result);
}

/** Folds a reconcile result into the counters the run row and the caller read. */
function countReconcile(result: SweepResult, reconciled: ReconcileResult): void {
  for (const entry of reconciled.written) {
    if (entry.outcome === "created") result.findingsCreated += 1;
    else if (entry.outcome === "updated") result.findingsUpdated += 1;
  }
  result.findingsSuppressed = reconciled.suppressed.length;
  result.findingsAggregated = reconciled.aggregated.length;
  result.findingsResolved = reconciled.resolved.length;
  result.titlesRewritten = reconciled.titlesRewritten;
}

/**
 * One sweep.
 *
 * Returns `lockHeld` rather than waiting when a pass is already running, for the same
 * reason the ingest pass does: the work is being done by whoever holds the lock, and
 * queueing ticks behind each other turns one slow model call into a growing backlog of
 * identical sweeps.
 */
export async function runSweepPass(
  deps: SweepDeps,
  options: SweepOptions = {},
): Promise<SweepResult> {
  const { db, transport } = deps;
  const now = deps.now?.() ?? new Date();
  const kind: RunKind = options.kind ?? "sweep";
  const ownsRun = options.runId === undefined;

  const trace: TraceEntry[] = [];
  let runId: string | null = options.runId ?? null;

  try {
    const outcome = await withPipelineLock(db, async (tx) => {
      // Opened on `db` rather than `tx`, so a failed sweep still leaves a record of having
      // failed. A run that rolled back its own evidence of existing is undiagnosable.
      if (runId === null) runId = await openRun(db, kind);

      return executeSweep(tx, {
        transport,
        runId,
        now,
        trace,
        force: options.force ?? false,
      });
    });

    if (outcome === null) {
      return { ...emptySweep(runId), status: "skipped", lockHeld: true };
    }

    const result: SweepResult = { ...outcome, runId, trace };
    if (ownsRun && runId !== null) {
      await closeRun(db, runId, {
        status: "complete",
        counters: { findingsProduced: result.findingsCreated + result.findingsUpdated },
        trace,
      });
    }
    return result;
  } catch (error) {
    if (ownsRun && runId !== null) {
      await closeRun(db, runId, {
        status: "failed",
        trace,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

interface ExecuteSweepInput {
  transport: AgentTransport;
  runId: string;
  now: Date;
  trace: TraceEntry[];
  force: boolean;
}

/** The locked half. Detection, the short-circuit, the invocation, and the writes. */
async function executeSweep(
  tx: Transaction,
  { transport, runId, now, trace, force }: ExecuteSweepInput,
): Promise<SweepResult> {
  const result = emptySweep(null);

  const detected = await detectFindings(tx, now);
  result.candidates = detected.candidates.length;
  result.dismissedKeysSkipped = detected.dismissedKeysSkipped;
  result.fingerprint = detected.fingerprint;

  // ── The short-circuit, before any invocation ───────────────────────────────
  const previous = await getSweepState(tx);
  if (!force && previous.fingerprint === detected.fingerprint) {
    result.shortCircuited = true;
    // The timestamp still advances: the sweep did happen, and it did conclude something.
    await setSweepState(tx, detected.fingerprint, now);
    return result;
  }

  // An empty candidate set is a legitimate state — a register with no gaps — and it still
  // has to resolve whatever was open before. It just needs no judgment, because there is
  // nothing to judge.
  if (detected.candidates.length === 0) {
    const reconciled = await applyAssessResult(tx, {
      judged: [],
      candidates: [],
      runId,
      at: now,
    });
    countReconcile(result, reconciled);
    await setSweepState(tx, detected.fingerprint, now);
    return result;
  }

  const context: AssessContext = await hydrateAssessContext(tx, now);
  const request: AgentRequest = {
    task: "assess",
    runId,
    payload: { candidates: detected.candidates },
    context,
  };

  const assessed = await invokeAssess(transport, request, trace);

  const reconciled = await applyAssessResult(tx, {
    judged: assessed.findings,
    candidates: detected.candidates,
    runId,
    at: now,
  });
  countReconcile(result, reconciled);

  result.quietDecisions = await recordQuietDecisions(tx, assessed.quietDecisions, runId);

  // Written last, and only on the success path. Storing it earlier would let a sweep that
  // failed after the invocation convince the next one that nothing had changed.
  await setSweepState(tx, detected.fingerprint, now);

  return result;
}

/**
 * Whether a sweep would do anything, without running one.
 *
 * For the scheduler, which would rather not take the pipeline lock every few minutes to
 * discover there is nothing to do. Cheap: five queries and a hash, no invocation.
 */
export async function sweepWouldChangeAnything(db: Executor, now: Date): Promise<boolean> {
  const detected = await detectFindings(db, now);
  const previous = await getSweepState(db);
  return previous.fingerprint !== detected.fingerprint;
}

/** The candidate set a sweep would judge, for the activity panel. Also invocation-free. */
export async function previewSweep(
  db: Executor,
  now: Date,
): Promise<{ candidates: FindingCandidate[]; fingerprint: string }> {
  const detected = await detectFindings(db, now);
  return { candidates: detected.candidates, fingerprint: detected.fingerprint };
}
