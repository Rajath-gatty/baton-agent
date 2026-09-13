/**
 * The `brief` task — Briefer, with Restraint on the produce path.
 *
 * A single agent rather than a graph, because there is one judgment to make.
 *
 * **Every line is gated, every time.** Unlike findings there is nothing to key a
 * conditional gate on: a brief is produced once in response to one membership event
 * and never recomputed, so there is no previous version to compare against and
 * nothing settled to skip. This is also the surface a coordinator is most likely to
 * read aloud, which is the last place an ungated line should reach.
 *
 * When gating empties the brief, the empty branch is re-entered rather than returning
 * a brief with an opening line and no lines under it. The schema would reject that
 * pair anyway, but the reason it is worth handling here is that "nothing appears to
 * have left with them" is a sentence a coordinator can act on, and three empty
 * sections is not.
 */

import {
  briefContextSchema,
  briefPayloadSchema,
  type BriefLine,
  type BriefResult,
} from "@baton/core";
import { runBriefer } from "../agents/briefer.js";
import type { AgentDeps } from "../agents/shared.js";
import type { RestraintGate } from "../produce/gate.js";

export async function runBrief(
  rawPayload: unknown,
  rawContext: unknown,
  deps: AgentDeps,
  gate: RestraintGate,
): Promise<BriefResult> {
  const payload = briefPayloadSchema.parse(rawPayload);
  const context = briefContextSchema.parse(rawContext);

  const brief = await runBriefer(payload, context, deps);

  if (brief.isEmpty) {
    // Nothing was produced, so there is nothing to gate. The opening line is Baton
    // reporting an absence, not a claim about anybody.
    return { brief, quietDecisions: [] };
  }

  const { surfaced, quietDecisions } = await gate.apply(
    brief.lines.map((line, position) => ({
      // Position rather than content: a brief line has no id of its own, and two lines
      // in different sections can legitimately read the same.
      itemRef: `${payload.subjectPersonId}:${line.section}:${position}`,
      text: line.text,
      supporting: {
        section: line.section,
        evidenceCount: line.evidenceFactIds.length + line.evidenceMessageIds.length,
      },
      value: line satisfies BriefLine,
    })),
  );

  if (surfaced.length === 0) {
    return {
      brief: {
        ...brief,
        openingLine:
          payload.kind === "departure"
            ? `${payload.subjectDisplayName} has left the group. Nothing appears to have left with them.`
            : `${payload.subjectDisplayName} has joined the group. Nothing is currently uncovered.`,
        isEmpty: true,
        lines: [],
        reasoning: `${brief.reasoning} (Every line was withheld, so the brief reports an absence.)`,
      },
      quietDecisions,
    };
  }

  return { brief: { ...brief, lines: surfaced }, quietDecisions };
}
