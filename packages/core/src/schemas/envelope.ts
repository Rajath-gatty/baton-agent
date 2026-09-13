/**
 * The agent request and response envelope.
 *
 * This is the contract across the only network boundary in the system that
 * separates two independently deployed things: the worker on the VM and the
 * agent on AgentCore. Both validate against these schemas, which is why a shape
 * change here requires deploying the agent before the worker.
 *
 * The per-agent output schemas (Curator, Cartographer, Assessor, Restraint,
 * Briefer, Respondent) are separate files, because each is validated against a
 * model response with retry-on-failure and they are edited independently.
 */

import { z } from "zod";
import { AGENT_TASKS } from "../constants.js";

export const agentTaskSchema = z.enum(AGENT_TASKS);

/**
 * One entry in the trace. The trace is returned in the response payload and
 * stored by the worker in `runs.trace` — it is not read from CloudWatch,
 * because the activity panel needs it in the same database as everything else
 * it renders.
 */
export const traceEntrySchema = z.object({
  node: z.string(),
  model: z.string().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  toolCalls: z
    .array(
      z.object({
        name: z.string(),
        argsSummary: z.string().optional(),
        ok: z.boolean(),
      }),
    )
    .optional(),
  /** One line, the agent's own account of what it decided and why. */
  reasoning: z.string().optional(),
});
export type TraceEntry = z.infer<typeof traceEntrySchema>;

/**
 * A raised interrupt, surfaced to the worker so it can write a `questions` row,
 * a `pending_changes` row, and store the snapshot.
 */
export const agentInterruptSchema = z.object({
  interruptId: z.string(),
  interruptName: z.string(),
  reason: z.string(),
  /** The write being held pending, as proposed by the agent. */
  proposedChange: z.unknown().optional(),
});
export type AgentInterrupt = z.infer<typeof agentInterruptSchema>;

export const agentRequestSchema = z.object({
  task: agentTaskSchema,
  /** Correlates the invocation with the worker's `runs` row. */
  runId: z.string(),
  /**
   * Task-specific input. Validated by the task handler against its own schema
   * rather than here, so adding a task does not touch this envelope.
   */
  payload: z.unknown(),
  /**
   * Context the worker hydrated. Deliberately per-task: the Curator does not
   * receive the fact index, because it classifies text rather than consulting
   * the register, and sending it would make hydration the dominant cost.
   */
  context: z.unknown(),
  /** Present only for `resume`. */
  snapshot: z.unknown().optional(),
  interruptResponses: z
    .array(
      z.object({
        interruptId: z.string(),
        approved: z.boolean(),
        answeredBy: z.string().optional(),
        answerText: z.string().optional(),
      }),
    )
    .optional(),
});
export type AgentRequest = z.infer<typeof agentRequestSchema>;

export const agentResponseSchema = z.object({
  task: agentTaskSchema,
  runId: z.string(),
  stopReason: z.enum(["complete", "interrupt", "error"]),
  /** Task-specific output, validated by the caller against the task's schema. */
  result: z.unknown().optional(),
  interrupts: z.array(agentInterruptSchema).optional(),
  /** Serialisable session state, stored by the worker in `agent_sessions`. */
  snapshot: z.unknown().optional(),
  trace: z.array(traceEntrySchema),
  error: z.string().optional(),
});
export type AgentResponse = z.infer<typeof agentResponseSchema>;
