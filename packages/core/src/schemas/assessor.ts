/**
 * Assessor output. `[F15]` `[F16]` `[F17]`
 *
 * The Assessor never counts, groups or filters — five SQL queries have already done
 * that, faster and more reliably than any model would. It receives candidates and
 * does only the part that needs judgment: severity, phrasing, aggregation across a
 * capability area, and whether the evidence is thin enough to suppress.
 *
 * That the donation page has exactly one holder, and so does the poster template, is
 * arithmetic. That the first is serious and the second is not is the work.
 *
 * Two invariants are enforced here rather than hoped for in the prompt:
 *
 *   - **`suppress` requires a reason.** A suppressed candidate is a decision, and a
 *     decision with no recorded reason is indistinguishable from a dropped item.
 *   - **The title must not name a person.** Enforced properly by the worker against
 *     the roster, since only it knows the names; the length floor here just stops an
 *     empty or one-word title reaching the register.
 */

import { z } from "zod";
import { FINDING_SEVERITIES, FINDING_SUBTYPES, FINDING_TYPES } from "../constants.js";

export const assessorFindingSchema = z
  .object({
    /**
     * The candidate's `dedupe_key`, echoed from the request. This is the upsert
     * target: without it the worker cannot tell a re-derived finding from a new one,
     * and every sweep either duplicates the register or resurrects a dismissal.
     */
    dedupeKey: z.string().min(1),
    type: z.enum(FINDING_TYPES),
    subtype: z.enum(FINDING_SUBTYPES),

    /** Phrased about a capability, never about a person. */
    title: z.string().min(3),
    whyItMatters: z.string().min(1),

    /** Consequence, reversibility and urgency — not how sure it is. */
    severity: z.enum(FINDING_SEVERITIES),
    /** How sure. A separate axis, and a separate column. */
    confidence: z.number().min(0).max(1),

    /**
     * A candidate resting on a single throwaway mention should not be raised at all.
     * Suppression is a judgment the SQL cannot make, which is why it lives here.
     */
    suppress: z.boolean(),
    suppressionReason: z.string().nullable(),

    /**
     * Other candidates this finding subsumes. Three separate exposures inside one
     * capability area are one problem about that capability, and presenting them as
     * three is how a register of eight useful items becomes thirty noisy ones.
     */
    aggregatedDedupeKeys: z.array(z.string()),

    /** Shown in the register. One line, about the item or the organisation. */
    reasoning: z.string(),
  })
  .superRefine((finding, ctx) => {
    if (finding.suppress && (finding.suppressionReason ?? "").trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["suppressionReason"],
        message: "a suppressed candidate must record why, or it is a silent drop",
      });
    }
  });
export type AssessorFinding = z.infer<typeof assessorFindingSchema>;

export const assessorOutputSchema = z.object({
  findings: z.array(assessorFindingSchema),
});
export type AssessorOutput = z.infer<typeof assessorOutputSchema>;
