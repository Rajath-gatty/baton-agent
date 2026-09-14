/**
 * The Cartographer. `[F12]` `[F13]`
 *
 * Mostly deterministic. Every mention the Curator returned is first put through
 * fuzzy alias matching in plain code; only the residue — a mention matching several
 * people, or none — reaches a model. On a typical batch that is a handful of
 * mentions out of thirty, which is why this agent costs almost nothing.
 *
 * The model's permitted output includes *cannot determine*, and that branch is the
 * reason it is invoked at all rather than the tie being broken by score. An alias
 * resolving to two people becomes a clarification question; it does not become a
 * coin flip.
 *
 * When there is nothing ambiguous, no model is called and the node still appears in
 * the trace. A node missing from the trace reads as a node that failed.
 */

import {
  CARTOGRAPHER_SYSTEM_PROMPT,
  cartographerOutputSchema,
  type AliasEntry,
  type CartographerAttribution,
  type CartographerOutput,
  type CuratorOutput,
} from "@baton/core";
import { callStructured } from "../model/structured.js";
import { AliasIndex, needsEscalation, type AliasMatch } from "./alias-match.js";
import { buildInput, factoryOption, section, type AgentDeps } from "./shared.js";
import { toolsFor } from "../tools/index.js";

/** A mention pulled out of an extracted record, with its position preserved. */
interface PendingMention {
  recordIndex: number;
  mention: string;
  match: AliasMatch;
}

/**
 * Every person mention across the Curator's records, in a flat list with the record
 * index each came from. The index is what stops an attribution being applied to the
 * wrong record when they are merged back together.
 */
export function collectMentions(curated: CuratorOutput, index: AliasIndex): PendingMention[] {
  const pending: PendingMention[] = [];
  let recordIndex = 0;

  for (const result of curated.results) {
    for (const record of result.records) {
      const mentions = [
        ...(record.holderMention === null ? [] : [record.holderMention]),
        ...record.subjectMentions,
      ];

      for (const mention of mentions) {
        pending.push({ recordIndex, mention, match: index.resolve(mention) });
      }
      recordIndex += 1;
    }
  }

  return pending;
}

/** Builds the attribution for a mention that matched exactly one person. */
function resolvedAttribution(pending: PendingMention): CartographerAttribution {
  const personId = pending.match.candidatePersonIds[0];
  return {
    recordIndex: pending.recordIndex,
    mention: pending.mention,
    resolution: "resolved",
    personId: personId ?? null,
    candidatePersonIds: pending.match.candidatePersonIds,
    externalName: null,
    // Personal-resource judgment needs the surrounding text, which the deterministic
    // path does not read. Left false here; the model sets it on the escalated path.
    isPersonalResource: false,
    // An exact alias match is certain; a typo or first-name match is very likely but
    // not the same thing, and the difference is worth carrying into the register.
    confidence: pending.match.method === "exact" ? 1 : 0.9,
    reasoning: `Matched the alias table by ${pending.match.method} match.`,
  };
}

export async function runCartographer(
  curated: CuratorOutput,
  aliases: readonly AliasEntry[],
  deps: AgentDeps,
): Promise<CartographerOutput> {
  const index = new AliasIndex(aliases);
  const pending = collectMentions(curated, index);

  const settled = pending.filter((entry) => !needsEscalation(entry.match));
  const escalated = pending.filter((entry) => needsEscalation(entry.match));

  const attributions: CartographerAttribution[] = settled.map(resolvedAttribution);

  if (escalated.length === 0) {
    deps.trace.addDeterministic(
      "cartographer",
      `Resolved all ${settled.length} mentions by alias matching. No model call needed.`,
    );
    return { attributions };
  }

  const records = curated.results.flatMap((result) => result.records);

  const input = buildInput(
    [
      section("Known people", aliases),
      section(
        "Ambiguous mentions",
        escalated.map((entry) => ({
          recordIndex: entry.recordIndex,
          mention: entry.mention,
          candidatePersonIds: entry.match.candidatePersonIds,
          // Telling the model *why* automatic matching failed stops it re-deriving
          // the wrong conclusion — "matched nobody" and "matched three people" call
          // for different answers.
          automaticMatchResult:
            entry.match.candidatePersonIds.length === 0
              ? "matched nobody in the alias table"
              : `matched ${entry.match.candidatePersonIds.length} people`,
        })),
      ),
      section(
        "The records these mentions came from",
        escalated.map((entry) => ({
          recordIndex: entry.recordIndex,
          record: records[entry.recordIndex] ?? null,
        })),
      ),
    ],
    [
      `Decide who each of the ${escalated.length} ambiguous mentions refers to.`,
      "Return one attribution per mention, echoing recordIndex and mention exactly.",
      "Returning ambiguous or cannot_determine is a correct answer where the evidence does not settle it.",
    ].join(" "),
  );

  const output = await callStructured({
    role: "cartographer",
    node: "cartographer",
    systemPrompt: CARTOGRAPHER_SYSTEM_PROMPT,
    input,
    schema: cartographerOutputSchema,
    config: deps.config,
    trace: deps.trace,
    ...factoryOption(deps),
    tools: toolsFor("cartographer", { dataApi: deps.dataApi, trace: deps.trace }),
    reasoningOf: (value) => {
      const unresolved = value.attributions.filter(
        (attribution) => attribution.resolution !== "resolved",
      ).length;
      return (
        `Resolved ${settled.length} mentions deterministically; escalated ${escalated.length}, ` +
        `of which ${unresolved} could not be settled and become questions.`
      );
    },
  });

  return { attributions: [...attributions, ...output.attributions] };
}
