/**
 * Trace assembly.
 *
 * The trace is returned in the response payload and stored by the worker in
 * `runs.trace`. It is **not** read from CloudWatch: the agent activity panel needs
 * the trace in the same database as everything else it renders, and an
 * observability round trip to AWS for a panel in a self-hosted UI would be
 * infrastructure bought for nothing.
 *
 * One entry per node visited, carrying the model used, token counts, duration, the
 * tool calls made, and the agent's own one-line account of what it decided. A run
 * that produced nothing still produces entries, which is what makes "read 400,
 * extracted 3" legible rather than alarming.
 */

import type { TraceEntry } from "@baton/core";

/** A tool call as it appears in the trace. */
export interface RecordedToolCall {
  name: string;
  argsSummary?: string;
  ok: boolean;
}

/**
 * Collects trace entries across a task.
 *
 * Tool calls are recorded against whichever node is currently open, because the
 * SDK reports tool usage on the agent that made the call and the panel wants it
 * attributed to the node a reader can see.
 */
export class TraceCollector {
  private readonly entries: TraceEntry[] = [];
  private pendingToolCalls: RecordedToolCall[] = [];

  /**
   * Records a tool call. Called by the tool wrappers, which do not know which node
   * they are inside — the collector does, because entries are appended in order.
   */
  recordToolCall(call: RecordedToolCall): void {
    this.pendingToolCalls.push(call);
  }

  /**
   * Appends a node entry, attaching any tool calls made since the last one.
   *
   * `exactOptionalPropertyTypes` is on, so an absent optional field must be left
   * off the object rather than set to `undefined`. Hence the conditional spreads.
   */
  add(entry: {
    node: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    durationMs?: number;
    reasoning?: string;
  }): void {
    const toolCalls = this.pendingToolCalls;
    this.pendingToolCalls = [];

    this.entries.push({
      node: entry.node,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.inputTokens === undefined ? {} : { inputTokens: entry.inputTokens }),
      ...(entry.outputTokens === undefined ? {} : { outputTokens: entry.outputTokens }),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
      ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }),
    });
  }

  /**
   * A node that ran without a model call — the Cartographer's deterministic path,
   * or a gate that short-circuited. Recorded because a node missing from the trace
   * reads as a node that failed.
   */
  addDeterministic(node: string, reasoning: string): void {
    this.add({ node, reasoning });
  }

  /** The assembled trace, in visit order. */
  toArray(): TraceEntry[] {
    return [...this.entries];
  }
}
