/**
 * Worker-side attribution, for records restored from the curator cache. `[F12]`
 *
 * A cache hit gives back the Curator's classification and records but no
 * attributions. It cannot give attributions: identity resolution runs against
 * `person_aliases` as it stands at call time, and the cache is keyed on message
 * content alone. A mention that was ambiguous in March resolves cleanly in September
 * once the alias was learned, so a cached attribution would freeze an identity
 * decision that is supposed to improve — and freeze it in the *wrong* direction,
 * since the March answer was the less informed one.
 *
 * So a cached record still needs its mentions resolved, and this does it using the
 * same `AliasIndex` the Cartographer uses. That is why the matcher lives in
 * `@baton/core`: one implementation, two callers, no chance of them drifting apart.
 *
 * **The bounded difference from the agent's path, stated plainly.** The Cartographer
 * escalates the residue — a mention matching several people, or none — to the model,
 * which can say "that is the clinic's accountant, not one of us". This cannot. A
 * mention it cannot settle deterministically becomes `ambiguous` or
 * `cannot_determine`, which downstream becomes a clarification question rather than a
 * holding.
 *
 * That is the right trade for three reasons. The outcome class is the same: an
 * ambiguous mention was always going to end up as a question, and the model attempt
 * is an optimisation on how often the question is avoidable, not a correctness
 * requirement. It never guesses, so nothing false enters the register. And paying for
 * a model call on a cache hit would defeat the only reason the cache exists — a
 * re-run that costs the same as the first run is not a cache.
 *
 * The cost is that a re-run after the derived tables are truncated can produce a few
 * more clarification questions than the original run did, on exactly the mentions
 * that were ambiguous in the first place. Visible, bounded, and recoverable by
 * answering the question — which is the failure direction this system prefers
 * everywhere else too.
 */

import type { AliasIndex, CartographerAttribution, CuratorRecord, MatchMethod } from "@baton/core";

/**
 * Confidence per match method.
 *
 * Reported rather than acted on: fact status is decided by the Curator's confidence in
 * the *claim*, not by how the holder's name was matched. Kept explicit anyway, because
 * the number reaches the UI's provenance panel and "resolved at 0.8 by a typo match"
 * is a sentence a coordinator can check.
 */
const METHOD_CONFIDENCE: Record<MatchMethod, number> = {
  exact: 1,
  "first-name": 0.9,
  typo: 0.8,
  none: 0,
};

/**
 * Resolves one mention against the alias index into the Cartographer's own shape.
 *
 * `isPersonalResource` is always false here, and that is a deliberate refusal rather
 * than a default. Whether the van is the group's or Anil's own car is a judgment about
 * the world that only the model can make from the message text; the alias table says
 * nothing about it. Claiming false is the safe direction — the asset is treated as the
 * group's and can surface as a one-person risk, which a coordinator can dismiss.
 * Claiming true would silently exclude something the group actually depends on.
 */
function attributeMention(
  index: AliasIndex,
  recordIndex: number,
  mention: string,
): CartographerAttribution {
  const match = index.resolve(mention);
  const candidatePersonIds = match.candidatePersonIds;

  if (candidatePersonIds.length === 1) {
    return {
      recordIndex,
      mention,
      resolution: "resolved",
      personId: candidatePersonIds[0] as string,
      candidatePersonIds,
      externalName: null,
      isPersonalResource: false,
      confidence: METHOD_CONFIDENCE[match.method],
      reasoning: `Matched one recorded alias by ${match.method} match.`,
    };
  }

  if (candidatePersonIds.length > 1) {
    return {
      recordIndex,
      mention,
      resolution: "ambiguous",
      personId: null,
      candidatePersonIds,
      externalName: null,
      isPersonalResource: false,
      confidence: 0,
      reasoning: `Matched ${candidatePersonIds.length} recorded aliases by ${match.method} match.`,
    };
  }

  return {
    recordIndex,
    mention,
    resolution: "cannot_determine",
    personId: null,
    candidatePersonIds: [],
    externalName: null,
    isPersonalResource: false,
    confidence: 0,
    reasoning:
      "No recorded alias matched, and a cached result carries no model judgment about who this is.",
  };
}

/**
 * Attributes every person mention in a list of records.
 *
 * `recordIndex` counts the records given, in order — the same coordinate system
 * `flattenRecords` produces and `upsertEntitiesFromIngest` reads. Callers pass the
 * records of one message, so the indices are that message's own.
 *
 * A mention appearing twice in the same record — as the holder and again in the
 * subject list — is attributed once. Two attributions with the same index and the same
 * mention are indistinguishable downstream, and the subject collector deliberately
 * skips the holder's attribution object, so the duplicate would simply be dropped
 * after costing a lookup.
 */
export function attributeRecords(
  records: readonly CuratorRecord[],
  aliases: AliasIndex,
): CartographerAttribution[] {
  const attributions: CartographerAttribution[] = [];

  records.forEach((record, recordIndex) => {
    const seen = new Set<string>();

    const mentions: string[] = [];
    if (record.holderMention !== null && record.holderMention.trim() !== "") {
      mentions.push(record.holderMention);
    }
    mentions.push(...record.subjectMentions);

    for (const mention of mentions) {
      if (mention.trim() === "") continue;
      if (seen.has(mention)) continue;
      seen.add(mention);
      attributions.push(attributeMention(aliases, recordIndex, mention));
    }
  });

  return attributions;
}
