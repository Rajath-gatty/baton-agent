/**
 * The Curator. `[F7]` `[F11]`
 *
 * One model call classifies a batch of messages five ways and extracts records.
 * This is roughly eighty percent of token volume in the system.
 *
 * Two things about this agent are unlike the other five:
 *
 *   - **It has no tools.** Its cache is keyed on `content_hash` plus
 *     `prompt_version`, so an output that depended on register state at call time
 *     would be cached under a key that does not describe it.
 *   - **Batching is for the prompt, not for the judgment.** Ten messages share one
 *     system prompt to amortise it, but each is classified independently and the
 *     prompt forbids cross-message inference. That is what makes per-message
 *     caching sound, and it is a correctness requirement rather than a style.
 *
 * The response is checked for one thing beyond its schema: that every message asked
 * about came back, and nothing else did. A batch of ten that returns nine results
 * would otherwise silently drop a message from the backfill, and it would look like
 * the pre-filter had discarded it.
 */

import {
  CURATOR_SYSTEM_PROMPT,
  curatorOutputSchema,
  type CuratorOutput,
  type IngestContext,
  type IngestPayload,
} from "@baton/core";
import { callStructured } from "../model/structured.js";
import { buildInput, section, type AgentDeps } from "./shared.js";

export class CuratorBatchMismatch extends Error {
  constructor(missing: readonly string[], unexpected: readonly string[]) {
    super(
      `Curator returned a mismatched batch. Missing: [${missing.join(", ")}]. ` +
        `Unexpected: [${unexpected.join(", ")}].`,
    );
    this.name = "CuratorBatchMismatch";
  }
}

export async function runCurator(
  payload: IngestPayload,
  context: IngestContext,
  deps: AgentDeps,
): Promise<CuratorOutput> {
  const input = buildInput(
    [
      section("Group", {
        organisation: context.org.orgName,
        timezone: context.org.timezone,
        currentDate: context.org.now,
      }),
      // The assets index is supplied so an extracted record reuses an existing name
      // instead of coining a near-duplicate. It is not the fact index.
      section("Things the group already has recorded", context.assets),
      section("Messages", payload.messages),
    ],
    [
      `Classify each of the ${payload.messages.length} messages independently and extract its records.`,
      "Return one result object per message, echoing back its messageId exactly.",
      "Return a result for every message, including the ones that are noise.",
    ].join(" "),
  );

  const output = await callStructured({
    role: "curator",
    node: "curator",
    systemPrompt: CURATOR_SYSTEM_PROMPT,
    input,
    schema: curatorOutputSchema,
    config: deps.config,
    trace: deps.trace,
    // No tools. See the note above.
    reasoningOf: (value) => {
      const extracted = value.results.reduce((total, result) => total + result.records.length, 0);
      const noise = value.results.filter((result) => result.classification === "noise").length;
      return `Classified ${value.results.length} messages, ${noise} as noise, extracting ${extracted} records.`;
    },
  });

  const asked = new Set(payload.messages.map((message) => message.messageId));
  const answered = new Set(output.results.map((result) => result.messageId));

  const missing = [...asked].filter((id) => !answered.has(id));
  const unexpected = [...answered].filter((id) => !asked.has(id));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new CuratorBatchMismatch(missing, unexpected);
  }

  return output;
}
