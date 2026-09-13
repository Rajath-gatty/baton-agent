/**
 * Structured output, with validation and retry.
 *
 * The pipeline depends on strict schema conformance, and a cheap model's failure
 * mode is not a crash but plausible output that is subtly wrong — which surfaces as
 * findings that look arbitrary. Two defences, and this file is the first: validate
 * every response against its Zod schema and retry with the validation error fed
 * back. (The second is keeping the schemas flat, which is done in `@baton/core`.)
 *
 * **Why this does not use the SDK's `structuredOutputSchema`.** Two reasons, and
 * the first alone would be sufficient:
 *
 *   1. The SDK throws `StructuredOutputError` on a non-conforming response. It does
 *      not feed the validation error back to the model and retry, which is the
 *      behaviour the design requires — a cheap model that is told *which* key it
 *      got wrong fixes it on the second attempt far more often than one told
 *      nothing and asked again.
 *   2. The SDK peer-depends on Zod 4; this repository is pinned to Zod 3, because
 *      `@baton/core`'s schemas are shared with Drizzle and the web app. Validating
 *      on our side of the boundary means no Zod schema ever crosses it, so the
 *      version difference cannot bite.
 *
 * Retries reuse the same `Agent`, so the model sees its own rejected output and the
 * reason in conversation history. Starting a fresh agent per attempt would discard
 * exactly the context that makes the second attempt likely to succeed.
 */

import { Agent, type Message, type TextBlock, type ToolList } from "@strands-agents/sdk";
import type { AgentConfig } from "../config.js";
import { buildModel, modelIdFor, type AgentRole } from "./provider.js";
import type { TraceCollector } from "./trace.js";

/** How many times a single node will try to produce conforming output. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * One validation failure, as the retry prompt needs it.
 *
 * Structurally compatible with a Zod issue, but declared here rather than imported,
 * because **this workspace deliberately does not bind a Zod version.** The SDK
 * peer-depends on Zod 4 and calls Zod 4 APIs while its own barrel initialises;
 * `@baton/core` is on Zod 3, shared with Drizzle and the web app. Typing against the
 * shape rather than the library means the two never have to agree: the schema objects
 * are built in core and only ever have `safeParse` called on them, which is
 * instance-local.
 */
export interface SchemaIssue {
  path: (string | number | symbol)[];
  message: string;
}

/** The only thing this file needs from a schema. */
export interface SchemaValidator<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: SchemaIssue[] } };
}

/**
 * Raised when a node stopped to ask a human something.
 *
 * This is a successful outcome, not a failure: it carries the interrupts the worker
 * turns into a `questions` row and a `pending_changes` row, plus the snapshot it
 * stores in `agent_sessions`. It is an exception only because it has to unwind a
 * call stack that was expecting a validated value.
 */
export class NodeInterruptedError extends Error {
  constructor(
    readonly node: string,
    readonly interrupts: readonly { id: string; name: string; reason?: unknown }[],
    readonly snapshot: unknown,
  ) {
    super(`Node '${node}' raised ${interrupts.length} interrupt(s)`);
    this.name = "NodeInterruptedError";
  }
}

/** Raised when a node could not produce schema-conforming output within its budget. */
export class StructuredOutputFailure extends Error {
  constructor(
    readonly node: string,
    readonly attempts: number,
    readonly lastError: string,
  ) {
    super(
      `Node '${node}' failed to produce valid output after ${attempts} attempts. ` +
        `Last validation error: ${lastError}`,
    );
    this.name = "StructuredOutputFailure";
  }
}

export interface StructuredCallOptions<T> {
  role: AgentRole;
  /** The node name as it appears in the trace and in the register's activity panel. */
  node: string;
  systemPrompt: string;
  /** The request body: payload and hydrated context, already serialised. */
  input: string;
  schema: SchemaValidator<T>;
  config: AgentConfig;
  trace: TraceCollector;
  tools?: ToolList;
  maxAttempts?: number;
  /**
   * Pulls the agent's one-line reasoning out of its own validated output, for the
   * trace. Every schema carries one, but at different paths, so the caller supplies
   * the accessor rather than this file guessing.
   */
  reasoningOf?: (value: T) => string | undefined;
  /**
   * Registers hooks on the freshly built agent before it is invoked. This is where
   * an approval interrupt is attached, since a hook must be registered before the
   * call it guards.
   */
  configureAgent?: (agent: Agent) => void;
}

/** Concatenates the text blocks of a message, ignoring reasoning and tool blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((block): block is TextBlock => block.type === "textBlock")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Extracts a JSON object from a model response.
 *
 * The prompt asks for bare JSON, but a cheap model wraps it in a fence or a
 * sentence often enough that being strict here would spend a retry on a response
 * that was actually correct. Tolerating the wrapper is cheaper than re-asking, and
 * it does not mask a real failure: anything that is not a JSON object still fails.
 */
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return candidate;
  }
  return candidate.slice(start, end + 1);
}

/** Formats Zod issues as instructions the model can act on. */
function describeIssues(issues: readonly SchemaIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "(root)" : issue.path.join(".");
      return `- ${path}: ${issue.message}`;
    })
    .join("\n");
}

function isInterrupted(stopReason: string): boolean {
  return stopReason === "interrupt";
}

/**
 * Invokes one agent and returns validated output, retrying on validation failure
 * with the error fed back.
 */
export async function callStructured<T>(options: StructuredCallOptions<T>): Promise<T> {
  const {
    role,
    node,
    systemPrompt,
    input,
    schema,
    config,
    trace,
    tools,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    reasoningOf,
    configureAgent,
  } = options;

  const model = buildModel(role, config);
  const agent = new Agent({
    model,
    systemPrompt,
    id: node,
    // The container writes structured logs; the SDK's console printer would
    // interleave partial model output into them.
    printer: false,
    ...(tools === undefined ? {} : { tools }),
  });

  configureAgent?.(agent);

  const startedAt = Date.now();
  let lastError = "no attempt was made";
  let prompt = input;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await agent.invoke(prompt);

    if (isInterrupted(result.stopReason)) {
      // A held approval, not a failure. The snapshot carries interrupt state, so
      // the worker can store it and resume in a completely fresh invocation.
      throw new NodeInterruptedError(
        node,
        (result.interrupts ?? []).map((interrupt) => ({
          id: interrupt.id,
          name: interrupt.name,
          ...(interrupt.reason === undefined ? {} : { reason: interrupt.reason }),
        })),
        agent.takeSnapshot({ preset: "session" }),
      );
    }

    const raw = textOf(result.lastMessage);
    const usage = result.metrics?.accumulatedUsage;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(extractJsonObject(raw));
    } catch (error) {
      lastError = `response was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`;
      prompt = [
        "That response was not valid JSON.",
        lastError,
        "Return only the JSON object, with no surrounding text.",
      ].join("\n");
      continue;
    }

    const validated = schema.safeParse(parsedJson);
    if (validated.success) {
      trace.add({
        node,
        model: modelIdFor(role, config),
        ...(usage === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage === undefined ? {} : { outputTokens: usage.outputTokens }),
        durationMs: Date.now() - startedAt,
        ...(() => {
          const reasoning = reasoningOf?.(validated.data);
          return reasoning === undefined ? {} : { reasoning };
        })(),
      });
      return validated.data;
    }

    lastError = describeIssues(validated.error.issues);
    prompt = [
      "That response did not match the required schema. Fix exactly these problems",
      "and return the corrected JSON object only:",
      "",
      lastError,
      "",
      "Do not change anything that was not listed. Do not add commentary.",
    ].join("\n");
  }

  // The trace records the failed node too. A node absent from the trace looks like
  // a node that was never reached, which sends a reader looking in the wrong place.
  trace.add({
    node,
    model: modelIdFor(role, config),
    durationMs: Date.now() - startedAt,
    reasoning: `Failed schema validation after ${maxAttempts} attempts.`,
  });

  throw new StructuredOutputFailure(node, maxAttempts, lastError);
}

/** One human answer to one raised interrupt. */
export interface InterruptAnswer {
  interruptId: string;
  approved: boolean;
  answerText?: string;
}

export interface ResumeOptions {
  role: AgentRole;
  node: string;
  systemPrompt: string;
  /** The snapshot the worker stored in `agent_sessions`, verbatim. */
  snapshot: unknown;
  answers: readonly InterruptAnswer[];
  /**
   * Widened rather than generic: the caller dispatches over three different task
   * schemas, and the worker re-validates the result against the same schema from
   * `@baton/core` before writing anything.
   */
  schema: SchemaValidator<unknown>;
  config: AgentConfig;
  trace: TraceCollector;
  tools?: ToolList;
}

/**
 * Resumes an interrupted node from a snapshot.
 *
 * The snapshot's `session` preset carries interrupt state, so a node that stopped to
 * ask the coordinator something can be restored in a completely fresh invocation —
 * which is what keeps the container stateless while the approval waits hours in
 * Postgres.
 *
 * The response body handed back to the model is the human's answer, not a rewritten
 * instruction. A resume that reworded the answer would be deciding the thing it was
 * waiting to be told.
 */
export async function resumeStructured(options: ResumeOptions): Promise<unknown> {
  const { role, node, systemPrompt, snapshot, answers, schema, config, trace, tools } = options;

  const agent = new Agent({
    model: buildModel(role, config),
    systemPrompt,
    id: node,
    printer: false,
    ...(tools === undefined ? {} : { tools }),
  });

  agent.loadSnapshot(snapshot as Parameters<Agent["loadSnapshot"]>[0]);

  const startedAt = Date.now();
  const result = await agent.invoke(
    answers.map((answer) => ({
      interruptResponse: {
        interruptId: answer.interruptId,
        response: {
          approved: answer.approved,
          ...(answer.answerText === undefined ? {} : { answer: answer.answerText }),
        },
      },
    })) as Parameters<Agent["invoke"]>[0],
  );

  if (isInterrupted(result.stopReason)) {
    // A second interrupt from the same node. Legitimate — one approval can uncover
    // another — and handled the same way: hold it and ask.
    throw new NodeInterruptedError(
      node,
      (result.interrupts ?? []).map((interrupt) => ({
        id: interrupt.id,
        name: interrupt.name,
        ...(interrupt.reason === undefined ? {} : { reason: interrupt.reason }),
      })),
      agent.takeSnapshot({ preset: "session" }),
    );
  }

  const usage = result.metrics?.accumulatedUsage;
  const validated = schema.safeParse(JSON.parse(extractJsonObject(textOf(result.lastMessage))));

  trace.add({
    node: `${node}:resumed`,
    model: modelIdFor(role, config),
    ...(usage === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage === undefined ? {} : { outputTokens: usage.outputTokens }),
    durationMs: Date.now() - startedAt,
    reasoning: `Resumed from a snapshot with ${answers.length} answer(s).`,
  });

  if (!validated.success) {
    throw new StructuredOutputFailure(node, 1, describeIssues(validated.error.issues));
  }

  return validated.data;
}
