/**
 * Task dispatch.
 *
 * Five tasks, not one graph. Splitting them is a performance decision with product
 * consequences: one monolithic graph would re-run extraction on every sweep, making
 * the register slow to update at exactly the moment a judge is watching.
 *
 *   ingest   Graph: Curator → Cartographer
 *   assess   Graph: Assessor, gated by Restraint
 *   brief    Briefer, gated by Restraint
 *   respond  Respondent, gated by Restraint
 *   resume   Any producing task, restored from a snapshot
 *
 * **This file is where Restraint's scope is decided, and it is deliberately the only
 * place it can be.** A producing handler's signature requires a {@link RestraintGate}
 * as its fourth argument, so it cannot be registered without one, and `producing()`
 * is the only thing that supplies one. That is what makes the veto a property of the
 * container's wiring rather than a convention between prompts — and it is why
 * {@link RESTRAINT_ATTACHED_TASKS} is exported: a test asserts it is exactly
 * `assess`, `brief`, `respond`, which is what stops the veto silently narrowing to
 * findings during a refactor and leaving ungated the two surfaces a human reads
 * aloud.
 *
 * `ingest` is ungated on purpose — it produces no outbound text — and cannot be
 * registered as producing, because {@link ProducingTask} does not include it.
 */

import type { AgentRequest, AgentResponse, AgentTask } from "@baton/core";
import type { AgentConfig } from "../config.js";
import { TraceCollector } from "../model/trace.js";
import { NodeInterruptedError } from "../model/structured.js";
import { DataApiClient } from "../tools/data-api.js";
import type { AgentDeps } from "../agents/shared.js";
import { RestraintGate, type ProducingTask } from "../produce/gate.js";
import { runIngest } from "./ingest.js";
import { runAssess } from "./assess.js";
import { runBrief } from "./brief.js";
import { runRespond } from "./respond.js";
import { runResume } from "./resume.js";

/** A task that produces no text a human reads, and so needs no gate. */
type PlainHandler = (request: AgentRequest, deps: AgentDeps) => Promise<unknown>;

/** A task that produces text a human reads. The gate is not optional. */
type ProducingHandler = (
  request: AgentRequest,
  deps: AgentDeps,
  gate: RestraintGate,
) => Promise<unknown>;

const attached = new Set<AgentTask>();

/**
 * Registers a producing task, constructing its gate.
 *
 * The only route by which a `RestraintGate` reaches a handler.
 */
function producing(task: ProducingTask, handler: ProducingHandler): PlainHandler {
  attached.add(task);
  return (request, deps) => handler(request, deps, new RestraintGate(task, deps));
}

const handlers: Record<AgentTask, PlainHandler> = {
  // No gate: ingest returns extracted records for the worker to persist, not text.
  ingest: (request, deps) => runIngest(request.payload, request.context, deps),

  assess: producing("assess", (request, deps, gate) =>
    runAssess(request.payload, request.context, deps, gate),
  ),
  brief: producing("brief", (request, deps, gate) =>
    runBrief(request.payload, request.context, deps, gate),
  ),
  respond: producing("respond", (request, deps, gate) =>
    runRespond(request.payload, request.context, deps, gate),
  ),

  // Resume re-enters a producing node that has already been gated once, and gates the
  // resumed output on the way back out through the task that owns it.
  resume: (request, deps) => runResume(request, deps),
};

/**
 * The tasks Restraint is attached to, as observed at module load.
 *
 * Deterministic rather than test-order dependent: the set is populated when this
 * module is first evaluated, by the same `producing()` calls that build the handlers.
 */
export const RESTRAINT_ATTACHED_TASKS: ReadonlySet<AgentTask> = attached;

export async function dispatch(request: AgentRequest, config: AgentConfig): Promise<AgentResponse> {
  const trace = new TraceCollector();
  const deps: AgentDeps = {
    config,
    trace,
    dataApi: new DataApiClient(config.dataApi),
  };

  try {
    const result = await handlers[request.task](request, deps);
    return {
      task: request.task,
      runId: request.runId,
      stopReason: "complete",
      result,
      trace: trace.toArray(),
    };
  } catch (error) {
    if (error instanceof NodeInterruptedError) {
      // A held approval is a successful outcome. The worker writes the `questions` and
      // `pending_changes` rows and stores the snapshot, then calls `resume` when the
      // answer arrives.
      return {
        task: request.task,
        runId: request.runId,
        stopReason: "interrupt",
        interrupts: error.interrupts.map((interrupt) => ({
          interruptId: interrupt.id,
          interruptName: interrupt.name,
          reason:
            typeof interrupt.reason === "string"
              ? interrupt.reason
              : JSON.stringify(interrupt.reason ?? null),
        })),
        snapshot: error.snapshot,
        trace: trace.toArray(),
      };
    }

    return {
      task: request.task,
      runId: request.runId,
      stopReason: "error",
      error: error instanceof Error ? error.message : String(error),
      // The partial trace is returned on failure too: it is the only record of how far
      // the run got, and a failed run with an empty trace is undiagnosable.
      trace: trace.toArray(),
    };
  }
}
