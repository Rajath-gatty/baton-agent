/**
 * One tick of the processing loop.
 *
 * Four passes, and **the order is not arbitrary.** Each dependency below is a real
 * failure if the order changes:
 *
 *   1. `runIngestPass`  — candidates become facts, holdings, commitments, coverage.
 *   2. `runSweepPass`   — SQL derives candidate findings from what ingest just wrote.
 *   3. `runRespondPass` — answers read the register the sweep just settled.
 *   4. `runAskPass`     — sends what the three passes above decided to ask.
 *
 * Sweep before respond because an answer that cites a finding needs the finding to exist;
 * running respond first would answer from a register one tick stale, which on a live demo
 * is the difference between "Priya holds it" and "nobody holds it". Ask last because it is
 * the only pass that *sends* — a question raised by ingest, by the sweep, or by an unknown
 * answer is queued as a row and reaches Telegram here, so putting ask first would always
 * be sending the previous tick's decisions.
 *
 * **`runRespondPass` deliberately runs outside the pipeline advisory lock.** It derives
 * nothing and supersedes nothing, so it cannot race the order-dependent work, and holding
 * the lock would make a group question wait behind a backfill — the one delay anybody
 * notices during a demo. Ingest and sweep take the lock themselves and report `lockHeld`
 * rather than throwing, so a tick that overlaps a backfill degrades to "answer questions,
 * derive nothing" instead of failing.
 *
 * A pass failing does **not** abort the tick. Each owns its own `runs` row and its own
 * durable state, and the later passes are useful even when an earlier one broke: if
 * ingest cannot reach the model, answering a question from the register that already
 * exists is still the right thing to do. Failures are collected and returned, and the
 * caller decides whether the tick counts as a failure for backoff purposes.
 */

import type { Database } from "@baton/core/db";
import type { AgentTransport } from "../agent/transport.js";
import type { OutboundQueue } from "../telegram/outbound-queue.js";
import { runIngestPass } from "../pipeline/processing-loop.js";
import { runSweepPass } from "../pipeline/sweep.js";
import { runRespondPass } from "../pipeline/respond.js";
import { runAskPass } from "../pipeline/ask.js";

/** The passes, in the order they run. Exported so a test can assert the order itself. */
export const TICK_PASSES = ["ingest", "sweep", "respond", "ask"] as const;

export type TickPass = (typeof TICK_PASSES)[number];

/**
 * The passes that take the pipeline advisory lock.
 *
 * Exported and asserted, because `respond` being outside the lock is a decision that
 * would be silently reversed by someone "tidying up" the tick into a single locked
 * block, and nothing would fail — questions would just start waiting behind backfills.
 */
export const LOCKED_PASSES: readonly TickPass[] = ["ingest", "sweep"];

export interface TickDeps {
  db: Database;
  transport: AgentTransport;
  queue: OutboundQueue;
  now?: () => Date;
}

export interface TickPassFailure {
  pass: TickPass;
  error: string;
}

export interface TickResult {
  /** Passes that ran without throwing, in order. */
  completed: TickPass[];
  failures: TickPassFailure[];
  /** True when ingest or sweep found the lock held. Not an error. */
  lockHeld: boolean;

  candidates: number;
  factsExtracted: number;
  approvalsRequested: number;
  findingsCreated: number;
  findingsUpdated: number;
  quietDecisions: number;
  questionsAnswered: number;
  questionsAsked: number;
  /** True when the sweep decided nothing had changed and called no model. */
  sweepShortCircuited: boolean;
  /** Run ids opened by this tick, for the activity panel. */
  runIds: string[];
}

/** Records a pass failure without aborting the tick. */
async function attempt<T>(
  pass: TickPass,
  result: TickResult,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    const value = await run();
    result.completed.push(pass);
    return value;
  } catch (error) {
    result.failures.push({
      pass,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Runs one tick.
 *
 * Returns rather than logs, so the caller decides what is worth saying and a test can
 * assert on the numbers instead of on captured output.
 */
export async function runTick(deps: TickDeps): Promise<TickResult> {
  const { db, transport, queue } = deps;
  const nowFn = deps.now;

  const result: TickResult = {
    completed: [],
    failures: [],
    lockHeld: false,
    candidates: 0,
    factsExtracted: 0,
    approvalsRequested: 0,
    findingsCreated: 0,
    findingsUpdated: 0,
    quietDecisions: 0,
    questionsAnswered: 0,
    questionsAsked: 0,
    sweepShortCircuited: false,
    runIds: [],
  };

  const record = (runId: string | null): void => {
    if (runId !== null) result.runIds.push(runId);
  };

  // 1. Ingest. Takes the lock.
  const ingest = await attempt("ingest", result, () =>
    runIngestPass({ db, transport, ...(nowFn === undefined ? {} : { now: nowFn }) }),
  );
  if (ingest !== null) {
    record(ingest.runId);
    result.candidates = ingest.candidates;
    result.factsExtracted = ingest.factsExtracted;
    result.approvalsRequested = ingest.approvalsRequested;
    if (ingest.lockHeld) result.lockHeld = true;
  }

  // 2. Sweep. Takes the lock. Short-circuits in SQL when nothing changed, so an idle
  //    system calls no model at all — which is what makes a frequent tick affordable.
  const sweep = await attempt("sweep", result, () =>
    runSweepPass({ db, transport, ...(nowFn === undefined ? {} : { now: nowFn }) }),
  );
  if (sweep !== null) {
    record(sweep.runId);
    result.findingsCreated = sweep.findingsCreated;
    result.findingsUpdated = sweep.findingsUpdated;
    result.quietDecisions = sweep.quietDecisions;
    result.sweepShortCircuited = sweep.shortCircuited;
    if (sweep.lockHeld) result.lockHeld = true;
  }

  // 3. Respond. **Outside the lock** — see the note at the top of this file.
  const respond = await attempt("respond", result, () =>
    runRespondPass({ db, transport, queue, ...(nowFn === undefined ? {} : { now: nowFn }) }),
  );
  if (respond !== null) {
    record(respond.runId);
    result.questionsAnswered = respond.answered.length;
  }

  // 4. Ask. Sends whatever the passes above queued, within the budget.
  const ask = await attempt("ask", result, () =>
    runAskPass({ db, queue, ...(nowFn === undefined ? {} : { now: nowFn }) }),
  );
  if (ask !== null) {
    result.questionsAsked = ask.asked.length;
  }

  return result;
}
