/**
 * A scripted stand-in for a Strands `Agent`.
 *
 * The agent layer's load-bearing logic is what happens *around* a model call —
 * validate, feed the error back, retry within a budget, record the trace, unwind an
 * interrupt carrying its snapshot. A live model can drive none of that reliably: it
 * cannot be made to emit malformed JSON on demand, so the failure branches would stay
 * unreached, and it would make the suite slow and non-deterministic besides.
 *
 * So the fake scripts the turns instead, and the tests assert on our side of the
 * boundary. Two properties are deliberate:
 *
 *   - **Running out of turns throws.** A test that scripts two responses and gets
 *     three invocations has found a real bug — a retry loop that ignored its budget —
 *     and the fake makes that a loud failure rather than a hang or a confusing
 *     undefined. This is why turns are consumed rather than repeated.
 *   - **Every prompt is recorded.** The repair prompt is the whole point of this
 *     layer: a cheap model told *which* key it got wrong fixes it far more often than
 *     one told nothing. That claim is only true if the message actually names the
 *     path, so the tests read `prompts[1]` and check.
 */

import type { Message } from "@strands-agents/sdk";
import type {
  AgentFactory,
  AgentSpec,
  StructuredAgent,
  StructuredInvocation,
} from "../../src/model/structured.js";

/** One scripted model response. */
export interface ScriptedTurn {
  /** The raw text the model "returns". Wrap in a fence or prose to exercise extraction. */
  text?: string;
  /** Defaults to `"complete"`. Use `"interrupt"` with `interrupts` to hold an approval. */
  stopReason?: string;
  interrupts?: readonly { id: string; name: string; reason?: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** Scripts a turn returning `value` as JSON, which is the common case. */
export function json(value: unknown, usage?: ScriptedTurn["usage"]): ScriptedTurn {
  return { text: JSON.stringify(value), ...(usage === undefined ? {} : { usage }) };
}

/** Scripts a turn that stops to ask for approval. */
export function interrupt(
  ...interrupts: readonly { id: string; name: string; reason?: unknown }[]
): ScriptedTurn {
  return { stopReason: "interrupt", interrupts };
}

function messageOf(text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "textBlock", text }],
  } as unknown as Message;
}

export class FakeAgent implements StructuredAgent {
  /** Every prompt passed to `invoke`, in order. The retry feedback is asserted from this. */
  readonly prompts: unknown[] = [];
  /** Snapshots handed out, so a test can prove the interrupt carried one. */
  snapshotsTaken = 0;
  /** The snapshot `loadSnapshot` was given, so a resume can be proved to restore it. */
  loadedSnapshot: unknown = undefined;

  private readonly turns: ScriptedTurn[];

  constructor(
    readonly spec: AgentSpec,
    turns: readonly ScriptedTurn[],
  ) {
    this.turns = [...turns];
  }

  invoke(prompt: unknown): Promise<StructuredInvocation> {
    this.prompts.push(prompt);

    const turn = this.turns.shift();
    if (turn === undefined) {
      // Loud on purpose. See the note at the top of the file.
      throw new Error(
        `FakeAgent for node '${this.spec.node}' was invoked ${this.prompts.length} time(s) ` +
          `but only ${this.prompts.length - 1} turn(s) were scripted. ` +
          `An unscripted invocation usually means a retry budget was not honoured.`,
      );
    }

    return Promise.resolve({
      stopReason: turn.stopReason ?? "complete",
      lastMessage: messageOf(turn.text ?? ""),
      ...(turn.interrupts === undefined ? {} : { interrupts: turn.interrupts }),
      ...(turn.usage === undefined ? {} : { metrics: { accumulatedUsage: turn.usage } }),
    });
  }

  takeSnapshot(_options: { preset: "session" }): unknown {
    this.snapshotsTaken += 1;
    return { fakeSnapshot: this.spec.node, turnsRemaining: this.turns.length };
  }

  loadSnapshot(snapshot: unknown): void {
    this.loadedSnapshot = snapshot;
  }
}

export interface FakeAgentHarness {
  factory: AgentFactory;
  /** Every agent the factory built. One per `callStructured`, in construction order. */
  readonly agents: FakeAgent[];
  /** The single agent built, asserting there was exactly one. */
  only(): FakeAgent;
}

/**
 * Builds a factory that hands out agents playing `turns`.
 *
 * The turns are shared across every agent the factory builds, which suits the common
 * case of one `callStructured` per test. A test needing different scripts per node can
 * read `agents` and script per construction instead.
 */
export function fakeAgents(...turns: readonly ScriptedTurn[]): FakeAgentHarness {
  const agents: FakeAgent[] = [];
  return {
    factory: (spec) => {
      const agent = new FakeAgent(spec, turns);
      agents.push(agent);
      return agent;
    },
    agents,
    only(): FakeAgent {
      if (agents.length !== 1) {
        throw new Error(`expected exactly one agent to be built, got ${agents.length}`);
      }
      return agents[0]!;
    },
  };
}
