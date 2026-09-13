/**
 * Briefer output. `[F23]` `[F25]`
 *
 * Line-level records, not prose blocks. This is a hard requirement rather than a
 * preference: `brief_lines` rows are individually assignable and each carries its own
 * evidence reference, so a brief returned as three paragraphs cannot be stored, cannot
 * be assigned, and cannot be clicked through to the five-month-old message it came
 * from — which is the single most persuasive thing the product does.
 *
 * The three sections are fixed and ordered. An arrival brief runs the same generator
 * against the same three sections, scoped to what currently has no owner or a single
 * holder, and differs only in its opening line.
 *
 * The empty case is a real branch, not an absence: if a departing volunteer held
 * nothing, the brief says so plainly. Three empty sections read as broken software,
 * and a coordinator who sees that once stops opening briefs.
 */

import { z } from "zod";
import { BRIEF_KINDS, BRIEF_SECTIONS } from "../constants.js";

export const briefLineSchema = z.object({
  section: z.enum(BRIEF_SECTIONS),
  /** One item, phrased about the thing rather than the person who held it. */
  text: z.string().min(1),

  /**
   * Provenance on every claim. A line with no evidence cannot be verified by the
   * person reading it, which makes it indistinguishable from something Baton invented.
   */
  evidenceFactIds: z.array(z.string()),
  evidenceMessageIds: z.array(z.string()),

  /** Whichever of the three applies; the other two are null. */
  subjectAssetId: z.string().nullable(),
  subjectCapabilityId: z.string().nullable(),
  subjectCommitmentId: z.string().nullable(),
});
export type BriefLine = z.infer<typeof briefLineSchema>;

export const brieferOutputSchema = z
  .object({
    kind: z.enum(BRIEF_KINDS),
    subjectPersonId: z.string().min(1),
    /** One sentence. Also carries the empty case on its own. */
    openingLine: z.string().min(1),
    isEmpty: z.boolean(),
    lines: z.array(briefLineSchema),
    reasoning: z.string(),
  })
  .superRefine((brief, ctx) => {
    if (brief.isEmpty && brief.lines.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lines"],
        message: "an empty brief cannot carry lines",
      });
    }
    if (!brief.isEmpty && brief.lines.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["isEmpty"],
        message:
          "a brief with no lines must say so plainly rather than render three empty sections",
      });
    }
  });
export type BrieferOutput = z.infer<typeof brieferOutputSchema>;
