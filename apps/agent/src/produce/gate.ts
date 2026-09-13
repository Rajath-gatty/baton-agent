/**
 * The Restraint gate — where the veto attaches.
 *
 * The design calls for Restraint to sit on the **produce path** rather than as a
 * node in the graph, so that it cannot be routed around by the other agents: the
 * veto then holds structurally rather than by convention between prompts.
 *
 * **A deviation from the design document, forced by the SDK.** The design describes
 * this as an `addHook` on the produce path. The Strands TypeScript SDK has no
 * after-node hook that can modify or suppress what a node produced —
 * `AfterNodeCallEvent` and `NodeResultEvent` expose the result read-only, and the
 * only documented veto is `BeforeNodeCallEvent.cancel`, which fires *before* a node
 * runs and so cannot judge its output. An `addHook` implementation would therefore
 * have been an observer that could not actually withhold anything.
 *
 * What is implemented instead keeps every property the design was buying:
 *
 *   - **Not routable around.** A producing task cannot return a result except
 *     through this gate, because {@link RestraintGate} is the only thing that
 *     assembles one, and the handler signature for a producing task requires it.
 *   - **Registered on all three producing tasks**, as a property of the container's
 *     wiring rather than of any one graph. {@link RESTRAINT_SCOPE_BY_TASK} is that
 *     wiring, and it is a plain value a test can read.
 *   - **`ingest` is untouched**, which is correct: it produces no outbound text. It
 *     is excluded by construction here — {@link ProducingTask} does not include it,
 *     so adding it would not typecheck.
 *
 * **Gating differs by output class**, because one rule for all three would be wrong
 * in both directions. See {@link shouldGateFinding}.
 */

import type { AgentTask, QuietDecisionRecord, QuietDecisionScope } from "@baton/core";
import { runRestraint, type RestraintItem } from "../agents/restraint.js";
import type { AgentDeps } from "../agents/shared.js";

/** The three tasks that produce text a human reads. `ingest` is deliberately absent. */
export type ProducingTask = "assess" | "brief" | "respond";

/**
 * The wiring, as data. Each producing task maps to the quiet-decision scope its
 * withheld items are recorded under.
 *
 * `satisfies Record<ProducingTask, ...>` makes this exhaustive: a fourth producing
 * task cannot be added to {@link ProducingTask} without also appearing here.
 */
export const RESTRAINT_SCOPE_BY_TASK = {
  assess: "finding",
  brief: "brief_line",
  respond: "answer",
} as const satisfies Record<ProducingTask, QuietDecisionScope>;

export const PRODUCING_TASKS = Object.keys(RESTRAINT_SCOPE_BY_TASK) as readonly ProducingTask[];

export function isProducingTask(task: AgentTask): task is ProducingTask {
  return task in RESTRAINT_SCOPE_BY_TASK;
}

/**
 * Whether a finding needs judging on this sweep.
 *
 * **Findings are gated; brief lines and answers are not.** Briefs and answers are
 * each produced once in response to one event and never recomputed, so there is
 * nothing to re-judge and no natural identity to key a gate on. Findings are the
 * opposite case: sweeps re-derive them from scratch, so an ungated Restraint would
 * re-veto the same thirty settled items on every sweep forever — the second-largest
 * model consumer in the system, producing no new information.
 *
 * It is also a correctness point. Re-judging a settled finding lets the
 * quiet-decisions strip churn between sweeps, so a coordinator sees withheld items
 * appear and disappear for no reason they can observe.
 */
export function shouldGateFinding(finding: {
  previousSeverity: string | null;
  severity: string;
}): boolean {
  return finding.previousSeverity === null || finding.previousSeverity !== finding.severity;
}

/** An item offered to the gate, carrying the value to return if it survives. */
export interface GateCandidate<T> {
  itemRef: string;
  text: string;
  supporting: Record<string, unknown>;
  value: T;
  /**
   * Set false to bypass judging for this item — the findings path only. A bypassed
   * item is surfaced without a model call, because it was already judged on an
   * earlier sweep and nothing about it has changed.
   */
  needsJudgement?: boolean;
  /** Set when the item is a finding, so the quiet-decisions strip can link to it. */
  findingDedupeKey?: string;
}

export interface GateOutcome<T> {
  surfaced: T[];
  quietDecisions: QuietDecisionRecord[];
}

/**
 * The produce-path gate for one task.
 *
 * Constructed per invocation, because it carries the trace collector. A producing
 * task receives one and has no other way to emit a result.
 */
export class RestraintGate {
  readonly scope: QuietDecisionScope;

  constructor(
    readonly task: ProducingTask,
    private readonly deps: AgentDeps,
  ) {
    this.scope = RESTRAINT_SCOPE_BY_TASK[task];
  }

  /**
   * Judges the candidates and returns what may be said, plus what may not.
   *
   * A candidate marked `needsJudgement: false` is surfaced without being sent to the
   * model. Everything else is judged, and a withholding produces a quiet decision
   * rather than a silent drop.
   */
  async apply<T>(candidates: readonly GateCandidate<T>[]): Promise<GateOutcome<T>> {
    const bypassed = candidates.filter((candidate) => candidate.needsJudgement === false);
    const toJudge = candidates.filter((candidate) => candidate.needsJudgement !== false);

    if (bypassed.length > 0) {
      this.deps.trace.addDeterministic(
        "restraint:gate",
        `${bypassed.length} item(s) already settled on an earlier run and were not re-judged.`,
      );
    }

    const items: RestraintItem[] = toJudge.map((candidate) => ({
      itemRef: candidate.itemRef,
      scope: this.scope,
      text: candidate.text,
      supporting: candidate.supporting,
    }));

    const { decisions } = await runRestraint(items, this.deps);
    const byRef = new Map(decisions.map((decision) => [decision.itemRef, decision]));

    const surfaced: T[] = bypassed.map((candidate) => candidate.value);
    const quietDecisions: QuietDecisionRecord[] = [];

    for (const candidate of toJudge) {
      const decision = byRef.get(candidate.itemRef);

      // `runRestraint` guarantees a decision per item and defaults a missing one to
      // withheld. Belt and braces: an item with no decision here is not surfaced.
      if (decision === undefined || decision.decision === "withhold") {
        quietDecisions.push({
          scope: this.scope,
          withheld: candidate.text,
          reason: decision?.reason ?? "No restraint decision was returned for this item.",
          findingDedupeKey: candidate.findingDedupeKey ?? null,
        });
        continue;
      }

      surfaced.push(candidate.value);
    }

    return { surfaced, quietDecisions };
  }
}
