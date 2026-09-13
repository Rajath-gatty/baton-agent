/**
 * Cartographer output. `[F12]` `[F13]`
 *
 * Mostly deterministic work: fuzzy alias matching against `person_aliases` handles
 * the overwhelming majority of mentions at zero model cost. The model is invoked
 * **only** when an alias resolves to more than one person, so this schema describes
 * the ambiguous minority.
 *
 * `cannot_determine` is a permitted output rather than a failure, and that is the
 * entire point of escalating at all. "Priya" resolving to two people is not a
 * problem to be solved with a coin flip — the ambiguity is the *output*, and it
 * becomes a question. A schema without this branch would force a guess, and a
 * wrong guess about who holds financial control is invisible once written.
 */

import { z } from "zod";
import { IDENTITY_RESOLUTIONS } from "../constants.js";

export const cartographerAttributionSchema = z.object({
  /**
   * Index into the records the request supplied, so an attribution cannot be
   * misapplied to the wrong extracted record.
   */
  recordIndex: z.number().int().nonnegative(),
  /** The mention as written, echoed back for the same reason. */
  mention: z.string().min(1),

  resolution: z.enum(IDENTITY_RESOLUTIONS),
  /** Set only when `resolution` is `resolved`. */
  personId: z.string().nullable(),
  /**
   * The people the mention could refer to. Two or more of these with a resolution
   * of `ambiguous` or `cannot_determine` is what the worker turns into a
   * clarification question instead of a holding row.
   */
  candidatePersonIds: z.array(z.string()),
  /** Someone outside the group: the clinic's accountant, the printer's owner. */
  externalName: z.string().nullable(),
  /**
   * The asset is actually this person's own property — the van. That is `not_ours`
   * rather than a one-person risk, and mistaking the two produces a finding that
   * asks the group to find a backup for someone's car.
   */
  isPersonalResource: z.boolean(),

  confidence: z.number().min(0).max(1),
  /** One line, about the evidence. Never about the person. */
  reasoning: z.string(),
});
export type CartographerAttribution = z.infer<typeof cartographerAttributionSchema>;

export const cartographerOutputSchema = z.object({
  attributions: z.array(cartographerAttributionSchema),
});
export type CartographerOutput = z.infer<typeof cartographerOutputSchema>;
