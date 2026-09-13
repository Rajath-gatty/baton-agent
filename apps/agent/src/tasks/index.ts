/**
 * Task dispatch.
 *
 * Five tasks, not one graph. Splitting them is a performance decision with
 * product consequences: one monolithic graph would re-run extraction on every
 * sweep, making the register slow to update at exactly the moment a judge is
 * watching.
 *
 *   ingest   Graph: Curator -> Cartographer
 *   assess   Graph: Assessor, with Restraint hooked
 *   brief    Briefer, with Restraint hooked on produce
 *   respond  Respondent, with Restraint hooked on produce
 *   resume   Any of the above, restored from a snapshot
 *
 * Restraint attaches to the three producing tasks. `ingest` produces no
 * outbound text and is the one task it does not touch.
 */

import type { AgentRequest, AgentResponse } from "@baton/core";
import type { AgentConfig } from "../config.js";

export type TaskHandler = (request: AgentRequest, config: AgentConfig) => Promise<AgentResponse>;

/**
 * Placeholder until the six agents exist. Returns a well-formed envelope so the
 * worker's transport, the SigV4 path and the AgentCore deploy (gates G3 and G4)
 * can all be verified before any agent is written.
 */
const notImplemented: TaskHandler = (request) =>
  Promise.resolve({
    task: request.task,
    runId: request.runId,
    stopReason: "error",
    error: `Task '${request.task}' is not implemented yet.`,
    trace: [],
  });

const handlers: Record<AgentRequest["task"], TaskHandler> = {
  ingest: notImplemented,
  assess: notImplemented,
  brief: notImplemented,
  respond: notImplemented,
  resume: notImplemented,
};

export function dispatch(request: AgentRequest, config: AgentConfig): Promise<AgentResponse> {
  return handlers[request.task](request, config);
}
