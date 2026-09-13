/**
 * Restraint output. `[F18]`
 *
 * Surface, or withhold with a recorded reason. There is no third option and no
 * free-text escape hatch, because a withheld item that leaves no trace is a silent
 * drop, and the whole reason Restraint is demonstrable rather than merely claimed is
 * that every withholding becomes a `quiet_decisions` row a coordinator can read.
 *
 * Restraint is attached via `addHook` on the produce path rather than placed in the
 * graph as a node. As a hook it cannot be routed around by the other agents, so the
 * veto holds structurally rather than by convention between prompts. `scope` is
 * carried on every decision so a test can assert the hook is still registered on all
 * three producing tasks — `assess`, `brief` and `respond` — which is what stops the
 * veto quietly narrowing to findings during a refactor, leaving ungated the two
 * surfaces a human actually reads aloud.
 *
 * Two invariants are enforced here:
 *
 *   - **A withholding requires a reason.** Without it the quiet-decisions strip
 *     renders an empty row, which reads as a bug and teaches a coordinator to ignore
 *     the strip.
 *   - **The reason is item-level or organisation-level.** Restraint exists to keep
 *     Baton from saying something about a person it has no business saying; a reason
 *     that itself characterises a person would defeat it.
 */

import { z } from "zod";
import { QUIET_DECISION_SCOPES, RESTRAINT_DECISIONS } from "../constants.js";

export const restraintDecisionSchema = z
  .object({
    /**
     * Identifies the item judged, echoed from the request: a finding's `dedupe_key`,
     * a brief line's position, or the question id an answer replies to.
     */
    itemRef: z.string().min(1),
    /** Which produce path this decision came from. */
    scope: z.enum(QUIET_DECISION_SCOPES),
    decision: z.enum(RESTRAINT_DECISIONS),
    /**
     * Required on a withholding, and recorded verbatim as the quiet decision. Free on
     * a surfaced item, where it is simply not stored.
     */
    reason: z.string().nullable(),
  })
  .superRefine((entry, ctx) => {
    if (entry.decision === "withhold" && (entry.reason ?? "").trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "a withheld item must record why, or it is a silent drop",
      });
    }
  });
export type RestraintDecisionEntry = z.infer<typeof restraintDecisionSchema>;

export const restraintOutputSchema = z.object({
  decisions: z.array(restraintDecisionSchema),
});
export type RestraintOutput = z.infer<typeof restraintOutputSchema>;
