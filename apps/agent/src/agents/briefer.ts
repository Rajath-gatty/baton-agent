/**
 * The Briefer. `[F23]` `[F25]`
 *
 * One call, three fixed sections, line-level records. Its difficulty is tone rather
 * than logic, which argues for a stronger model on this agent specifically.
 *
 * The arrival variant runs the same generator against the same three sections,
 * scoped to what currently has no owner or a single holder, and differs only in its
 * opening line. Two prompts would have drifted apart.
 *
 * The empty case is a real branch. A departing volunteer who held nothing gets one
 * plain sentence and no lines — three empty sections read as broken software, and a
 * coordinator who sees that once stops opening briefs. The schema enforces the pair
 * (`isEmpty` and a line count) agree; this file supplies the emptiness that makes it
 * reachable without a model call at all.
 */

import {
  BRIEFER_SYSTEM_PROMPT,
  brieferOutputSchema,
  type BriefContext,
  type BriefPayload,
  type BrieferOutput,
} from "@baton/core";
import { callStructured } from "../model/structured.js";
import { buildInput, section, type AgentDeps } from "./shared.js";
import { toolsFor } from "../tools/index.js";

/** Whether there is anything at all to write a brief about. */
export function hasMaterial(context: BriefContext): boolean {
  return (
    context.holdings.length > 0 || context.openCommitments.length > 0 || context.coverage.length > 0
  );
}

export async function runBriefer(
  payload: BriefPayload,
  context: BriefContext,
  deps: AgentDeps,
): Promise<BrieferOutput> {
  if (!hasMaterial(context)) {
    // Answered without a model. Asking one to write "there is nothing here" spends a
    // call and risks it inventing something to fill the space.
    deps.trace.addDeterministic(
      "briefer",
      "No holdings, commitments or coverage for the subject. Empty brief written directly.",
    );
    return {
      kind: payload.kind,
      subjectPersonId: payload.subjectPersonId,
      openingLine:
        payload.kind === "departure"
          ? `${payload.subjectDisplayName} has left the group. Nothing appears to have left with them.`
          : `${payload.subjectDisplayName} has joined the group. Nothing is currently uncovered.`,
      isEmpty: true,
      lines: [],
      reasoning: "No material for any of the three sections.",
    };
  }

  const framing =
    payload.kind === "departure"
      ? "This person has left the group. Write what the group needs to pick up."
      : "This person has just joined. Write what is currently uncovered, so they can see where they would be useful.";

  const input = buildInput(
    [
      section("Group", {
        organisation: context.org.orgName,
        currentDate: context.org.now,
      }),
      section("Subject", {
        personId: payload.subjectPersonId,
        displayName: payload.subjectDisplayName,
        briefKind: payload.kind,
      }),
      section("Things they hold", context.holdings),
      section("Commitments they left open", context.openCommitments),
      section("Capability areas touching them", context.coverage),
    ],
    [
      framing,
      "Return one line per item, each carrying its own evidence ids from the data above.",
      "Never invent an evidence id: use only ids that appear above.",
      "Name the person once, in the opening line. Every line after that is about the work.",
    ].join(" "),
  );

  const output = await callStructured({
    role: "briefer",
    node: "briefer",
    systemPrompt: BRIEFER_SYSTEM_PROMPT,
    input,
    schema: brieferOutputSchema,
    config: deps.config,
    trace: deps.trace,
    tools: toolsFor("briefer", { dataApi: deps.dataApi, trace: deps.trace }),
    reasoningOf: (value) => {
      const bySection = value.lines.reduce<Record<string, number>>((counts, line) => {
        counts[line.section] = (counts[line.section] ?? 0) + 1;
        return counts;
      }, {});
      return `Wrote ${value.lines.length} lines: ${JSON.stringify(bySection)}.`;
    },
  });

  // The subject is supplied by the worker from a Telegram event; a model echoing it
  // back differently would orphan every line from the person the brief is about.
  return { ...output, subjectPersonId: payload.subjectPersonId, kind: payload.kind };
}
