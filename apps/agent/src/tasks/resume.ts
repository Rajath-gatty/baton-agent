/**
 * The `resume` task — any producing task, restored from a snapshot.
 *
 * The worker holds the snapshot in `agent_sessions` and the answer in `questions`.
 * Hours after a node stopped to ask the coordinator something, it calls back here
 * with both, and the node picks up from the interruption point in a container that
 * has no memory of the original request. That is what the agent being stateless buys.
 *
 * **Scope note.** The mechanism is implemented, but nothing in the pipeline raises an
 * interrupt yet — interrupt raising belongs to the approval round trip, which is a
 * separate section of the checklist. Until that lands, this path is reachable only by
 * a worker that already holds a snapshot, so it is wired and validated rather than
 * exercised end to end.
 *
 * `ingest` is not resumable and says so. It produces no outbound text and asks
 * nothing of anybody, so a snapshot claiming to resume it is a bug in the caller
 * rather than a case to handle.
 */

import {
  ASSESSOR_SYSTEM_PROMPT,
  BRIEFER_SYSTEM_PROMPT,
  RESPONDENT_SYSTEM_PROMPT,
  assessorOutputSchema,
  brieferOutputSchema,
  respondentOutputSchema,
  resumePayloadSchema,
  type AgentRequest,
} from "@baton/core";
import {
  resumeStructured,
  type InterruptAnswer,
  type SchemaValidator,
} from "../model/structured.js";
import type { AgentRole } from "../model/provider.js";
import { factoryOption, type AgentDeps } from "../agents/shared.js";
import { toolsFor } from "../tools/index.js";

/**
 * What each resumable task's interrupted node was, and what it must return.
 *
 * Annotated rather than `satisfies`-checked, deliberately: with `satisfies` the three
 * entries keep their distinct schema types, and `target.schema` becomes a union no
 * single generic can unify. Widening to `ZodTypeAny` here costs nothing, because the
 * worker re-validates the result against the same schema from `@baton/core` before it
 * writes anything.
 */
const RESUMABLE: Record<
  "assess" | "brief" | "respond",
  { role: AgentRole; node: string; systemPrompt: string; schema: SchemaValidator<unknown> }
> = {
  assess: {
    role: "assessor",
    node: "assessor",
    systemPrompt: ASSESSOR_SYSTEM_PROMPT,
    schema: assessorOutputSchema,
  },
  brief: {
    role: "briefer",
    node: "briefer",
    systemPrompt: BRIEFER_SYSTEM_PROMPT,
    schema: brieferOutputSchema,
  },
  respond: {
    role: "respondent",
    node: "respondent",
    systemPrompt: RESPONDENT_SYSTEM_PROMPT,
    schema: respondentOutputSchema,
  },
};

export class NotResumable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotResumable";
  }
}

export async function runResume(request: AgentRequest, deps: AgentDeps): Promise<unknown> {
  const payload = resumePayloadSchema.parse(request.payload);

  if (payload.originalTask === "ingest") {
    throw new NotResumable(
      "The ingest task raises no interrupts and cannot be resumed. " +
        "A snapshot claiming otherwise means the wrong session was looked up.",
    );
  }

  if (request.snapshot === undefined) {
    throw new NotResumable(
      `Resuming '${payload.originalTask}' requires the snapshot the worker stored, but none was sent.`,
    );
  }

  const answers: InterruptAnswer[] = (request.interruptResponses ?? []).map((response) => ({
    interruptId: response.interruptId,
    approved: response.approved,
    ...(response.answerText === undefined ? {} : { answerText: response.answerText }),
  }));

  if (answers.length === 0) {
    // Resuming with nothing to say would re-run the node and raise the same interrupt,
    // which from the group's side looks like being asked the same question twice.
    throw new NotResumable(
      `Resuming '${payload.originalTask}' requires at least one interrupt response.`,
    );
  }

  const target = RESUMABLE[payload.originalTask];

  return resumeStructured({
    role: target.role,
    node: target.node,
    systemPrompt: target.systemPrompt,
    snapshot: request.snapshot,
    answers,
    schema: target.schema,
    config: deps.config,
    trace: deps.trace,
    tools: toolsFor(target.role, { dataApi: deps.dataApi, trace: deps.trace }),
    ...factoryOption(deps),
  });
}
