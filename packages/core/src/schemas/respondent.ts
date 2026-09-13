/**
 * Respondent output. `[F20]` `[F21]`
 *
 * Four branches, and the three that are not `answer` are the valuable ones — *that
 * figure is five months old and worth confirming*, *two people are recorded as holding
 * this and I cannot tell which*, and plainly *nobody has told me that*. A tool that
 * only speaks when it is certain is a tool nobody can calibrate.
 *
 * They are branches of the schema rather than a free-text field precisely so the UI
 * and the tests can depend on them. A stale answer that is merely phrased as stale is
 * one prompt revision away from being phrased as certain.
 *
 * **Why this is one flat object with an `outcome` discriminator rather than a
 * discriminated union.** Nested and unioned schemas are where cheap models break, and
 * the whole system is built to run on one. The branch semantics are recovered by
 * `superRefine` instead: each outcome's invariants are enforced after parsing, so the
 * wire shape stays flat while an answer with no evidence, a stale answer with no age,
 * or an ambiguous case with one candidate are all rejected and retried with the
 * validation error fed back.
 */

import { z } from "zod";
import { QUESTION_TARGETS, RESPONDENT_OUTCOMES } from "../constants.js";

export const respondentOutputSchema = z
  .object({
    outcome: z.enum(RESPONDENT_OUTCOMES),

    /** Null on `unknown`, where there is nothing to say but so. */
    answerText: z.string().nullable(),

    /** Provenance on every claim, on every surface, without exception. */
    factIds: z.array(z.string()),
    evidenceMessageIds: z.array(z.string()),

    /**
     * Age of the fact in days, stated in the answer rather than implied. "Five months
     * old" is the useful part; "probably still right" is not.
     */
    ageDays: z.number().int().nonnegative().nullable(),

    /** Two or more on `ambiguous_holder`. That count *is* the ambiguity. */
    candidateHolderPersonIds: z.array(z.string()),

    /**
     * Where the answer goes. Sensitive questions route to the coordinator privately
     * rather than to twenty people, which is a routing decision the worker enforces
     * and the model only proposes.
     */
    target: z.enum(QUESTION_TARGETS),

    /**
     * On `unknown`, the question Baton would ask the group — subject to the ask budget,
     * and queued rather than dropped if the budget is full.
     */
    followUpQuestion: z.string().nullable(),

    reasoning: z.string(),
  })
  .superRefine((reply, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    const hasText = (reply.answerText ?? "").trim() !== "";

    switch (reply.outcome) {
      case "answer":
      case "stale_answer": {
        if (!hasText) issue("answerText", `outcome '${reply.outcome}' requires an answer`);
        if (reply.factIds.length === 0) {
          issue("factIds", "an answer must cite the fact it came from");
        }
        if (reply.outcome === "stale_answer" && reply.ageDays === null) {
          issue("ageDays", "a stale answer must state the age, or the warning is unfalsifiable");
        }
        break;
      }
      case "ambiguous_holder": {
        if (reply.candidateHolderPersonIds.length < 2) {
          issue(
            "candidateHolderPersonIds",
            "an ambiguous holder needs at least two candidates, or it is not ambiguous",
          );
        }
        break;
      }
      case "unknown": {
        if (hasText) {
          issue("answerText", "an unknown must not carry an answer");
        }
        break;
      }
    }
  });
export type RespondentOutput = z.infer<typeof respondentOutputSchema>;
