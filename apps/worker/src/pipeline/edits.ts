/**
 * What an edit means for what was already derived. `[F4]`
 *
 * An `edited_message` for a message already curated means the facts in the register
 * came from text that no longer exists. Intake has already cleared `curated_at` and the
 * pre-filter verdict — driven by the content hash, so a replayed edit and a crash
 * replay behave correctly without this module knowing which happened — and the
 * processing loop will re-curate the new text. What remains is the old text's output.
 *
 * **Superseded, never mutated.** The claim is not rewritten in place. Rewriting would
 * destroy the record that Baton once believed something else on the strength of a
 * message that has since changed, and provenance that can be silently rewritten is not
 * provenance. So the old row is marked `superseded` and re-curation inserts a fresh
 * one, which links back through `supersedes_fact_id`.
 *
 * **Only facts whose sole support was the edited message.** A claim restated by a later
 * message is still supported by that later message, and retiring it because its first
 * mention was corrected would delete something the group has said twice. This is the
 * one subtlety here and it is worth the extra clause.
 */

import { sql } from "drizzle-orm";
import type { Executor } from "../store/types.js";

export interface EditConsequences {
  /** Facts whose only evidence was the edited text, now marked superseded. */
  factsSuperseded: number;
  /** Facts left active because a later message also supports them. */
  factsRetained: number;
}

/**
 * Supersedes the facts the pre-edit text produced.
 *
 * Runs as two statements against the same message id: the update, then a count of what
 * survived. Both read `evidence_message_ids`, which accumulates on restatement rather
 * than being replaced — that accumulation is exactly what distinguishes a claim with
 * other support from one without.
 */
export async function applyEditConsequences(
  db: Executor,
  messageId: string,
): Promise<EditConsequences> {
  const superseded = await db.execute<{ id: string }>(sql`
    update facts
    set status = 'superseded'
    where source_message_id = ${messageId}
      and status = 'active'
      -- No other message supports this claim. Expanding an empty array yields no
      -- rows, so a fact with no accumulated evidence at all also matches here,
      -- which is correct: its only support was this text.
      and not exists (
        select 1
        from jsonb_array_elements_text(evidence_message_ids) as evidence(id)
        where evidence.id <> ${messageId}
      )
    returning id
  `);

  const retained = await db.execute<{ count: string }>(sql`
    select count(*)::text as count
    from facts
    where source_message_id = ${messageId} and status = 'active'
  `);

  return {
    factsSuperseded: [...superseded].length,
    factsRetained: Number([...retained][0]?.count ?? 0),
  };
}
