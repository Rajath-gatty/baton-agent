/**
 * The `respond` task — Respondent, with Restraint on the produce path.
 *
 * **Every answer is gated, unconditionally, before it is returned to the worker.**
 * The gate is inside the container rather than in the worker for a specific reason:
 * if the worker held the veto, an answer would exist as a returned value before
 * anything decided whether it should be said, and one refactor of the worker's
 * outbound path would leak it.
 *
 * An `unknown` outcome skips the gate. There is no claim in it to withhold — it is
 * Baton saying it does not know, which is exactly what it should say — and gating it
 * would spend a model call to approve a non-answer. The follow-up question it carries
 * is subject to the ask budget, which the worker counts in SQL.
 */

import {
  respondContextSchema,
  respondPayloadSchema,
  type RespondResult,
  type RespondentOutput,
} from "@baton/core";
import { runRespondent } from "../agents/respondent.js";
import type { AgentDeps } from "../agents/shared.js";
import type { RestraintGate } from "../produce/gate.js";

export async function runRespond(
  rawPayload: unknown,
  rawContext: unknown,
  deps: AgentDeps,
  gate: RestraintGate,
): Promise<RespondResult> {
  const payload = respondPayloadSchema.parse(rawPayload);
  const context = respondContextSchema.parse(rawContext);

  const reply = await runRespondent(payload, context, deps);

  if (reply.outcome === "unknown") {
    deps.trace.addDeterministic(
      "restraint:gate",
      "Outcome was unknown, so there is no claim to gate.",
    );
    return { reply, withheld: false, quietDecisions: [] };
  }

  const { surfaced, quietDecisions } = await gate.apply([
    {
      itemRef: payload.questionMessageId,
      text: reply.answerText ?? "",
      supporting: {
        outcome: reply.outcome,
        ageDays: reply.ageDays,
        citedClaims: reply.factIds.length,
        target: reply.target,
      },
      value: reply satisfies RespondentOutput,
    },
  ]);

  if (surfaced.length === 0) {
    // Withheld. The reply is still returned so the worker can record what was not
    // said against the question, but nothing is sent to the group.
    return { reply, withheld: true, quietDecisions };
  }

  return { reply, withheld: false, quietDecisions };
}
