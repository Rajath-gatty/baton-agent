/**
 * A `Graph` node that runs one of our agents.
 *
 * `Graph` is the SDK's own orchestration primitive and the design mandates it for
 * `ingest` and `assess`: pipeline order is fixed, agents must not choose their own
 * routing, and the node hook surface is where interrupts attach.
 *
 * The obvious wiring — wrap each agent in an `AgentNode` — cannot be used, and the
 * reason is worth recording. `AgentNode` invokes the agent itself and passes the
 * previous node's *text* onward, which would cost two things the pipeline cannot
 * give up: the validate-and-retry loop that makes a cheap model's output dependable,
 * and the Cartographer's deterministic alias pass, which resolves most mentions
 * before any model is involved. It would also mean the Cartographer re-parsing the
 * Curator's JSON out of a chat message, a decode step that can fail for no reason.
 *
 * `Node` is an abstract class with a single abstract method, so the supported
 * extension point is used instead. Each stage is a `Node` subclass whose `handle`
 * runs the real agent function and returns the one line describing what it did.
 * Ordering, per-node status and duration, failure capture and the hook surface all
 * remain the SDK's.
 *
 * Typed results travel by closure rather than through the graph's app state, because
 * `MultiAgentResult` exposes `status`, `results`, `content` and `usage` but not the
 * app state — so a value written there could not be read back out after `invoke`
 * returns.
 */

import { TextBlock } from "@strands-agents/sdk";
import { Node } from "@strands-agents/sdk/multiagent";
import type {
  MultiAgentInput,
  MultiAgentState,
  MultiAgentStreamEvent,
  NodeResultUpdate,
} from "@strands-agents/sdk/multiagent";

/** Runs one async step as a graph node, returning the line that describes it. */
export class PipelineNode extends Node {
  override readonly type = "batonPipelineNode";

  constructor(
    id: string,
    description: string,
    private readonly step: () => Promise<string>,
  ) {
    super(id, { description });
  }

  // `handle` is an async generator because the SDK streams intermediate events out of
  // long-running nodes. This node has none to emit: it awaits one agent function and
  // returns. The generator shape is the contract, not a hint that something should be
  // yielded, so `require-yield` is disabled rather than satisfied with a dummy yield.
  // eslint-disable-next-line require-yield
  override async *handle(
    _input: MultiAgentInput,
    _state: MultiAgentState,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const summary = await this.step();
    return { content: [new TextBlock(summary)] };
  }
}

/**
 * Re-raises a node failure.
 *
 * `Graph` captures a thrown error into the node's result rather than propagating it,
 * so without this a failed extraction would return an empty-but-successful result and
 * the worker would mark the batch curated. The messages would then never be
 * reprocessed, which is the most expensive kind of silent failure in this pipeline.
 */
export function throwIfAnyNodeFailed(
  results: readonly { nodeId: string; status: string; error?: Error }[],
  task: string,
): void {
  const failed = results.find((node) => node.status === "FAILED");
  if (failed === undefined) return;
  throw failed.error ?? new Error(`${task} node '${failed.nodeId}' failed without an error.`);
}
