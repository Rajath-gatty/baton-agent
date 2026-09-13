/**
 * The `assess` task — `Graph`: Assessor, with Restraint on the produce path.
 *
 * Restraint is a gate rather than a second graph node, and that is the design's
 * intent rather than a shortcut: as a node it would be one more step the pipeline
 * could be rewired around, whereas the gate is the only thing that assembles this
 * task's result. See `produce/gate.ts` for why it is not an SDK `addHook`.
 *
 * The findings path is the one place the gate is conditional. A suppressed candidate
 * never reaches Restraint at all — the Assessor has already decided it should not be
 * raised, and asking a second model whether to say something the first declined to
 * say is spending money to reach the same answer.
 */

import { Graph } from "@strands-agents/sdk";
import {
  assessContextSchema,
  assessPayloadSchema,
  type AssessResult,
  type AssessorFinding,
} from "@baton/core";
import { runAssessor } from "../agents/assessor.js";
import type { AgentDeps } from "../agents/shared.js";
import { shouldGateFinding, type RestraintGate } from "../produce/gate.js";
import { PipelineNode, throwIfAnyNodeFailed } from "./pipeline-node.js";

export async function runAssess(
  rawPayload: unknown,
  rawContext: unknown,
  deps: AgentDeps,
  gate: RestraintGate,
): Promise<AssessResult> {
  const payload = assessPayloadSchema.parse(rawPayload);
  const context = assessContextSchema.parse(rawContext);

  let judged: AssessorFinding[] = [];

  const assessorNode = new PipelineNode(
    "assessor",
    "Judges severity, phrasing, aggregation and suppression over SQL-derived candidates.",
    async () => {
      const output = await runAssessor(payload, context, deps);
      judged = output.findings;
      return `Judged ${judged.length} candidates.`;
    },
  );

  // A one-node graph, and `edges` is required even when there are none. The graph is
  // still worth keeping: it gives the node the same status, duration and failure
  // capture as the two-node ingest pipeline, so both tasks report themselves the same
  // way to the activity panel.
  const graph = new Graph({ nodes: [assessorNode], edges: [], sources: ["assessor"] });
  const result = await graph.invoke("Assess these candidate findings.");
  throwIfAnyNodeFailed(result.results, "assess");

  // A suppressed candidate is already a decision with a recorded reason. It becomes a
  // quiet decision directly rather than being put to Restraint.
  const suppressed = judged.filter((finding) => finding.suppress);
  const raisable = judged.filter((finding) => !finding.suppress);

  const previousSeverityByKey = new Map(
    payload.candidates.map((candidate) => [candidate.dedupeKey, candidate.previousSeverity]),
  );

  const { surfaced, quietDecisions } = await gate.apply(
    raisable.map((finding) => ({
      itemRef: finding.dedupeKey,
      findingDedupeKey: finding.dedupeKey,
      text: `${finding.title} — ${finding.whyItMatters}`,
      supporting: {
        severity: finding.severity,
        confidence: finding.confidence,
        subtype: finding.subtype,
      },
      value: finding,
      needsJudgement: shouldGateFinding({
        previousSeverity: previousSeverityByKey.get(finding.dedupeKey) ?? null,
        severity: finding.severity,
      }),
    })),
  );

  return {
    findings: surfaced,
    quietDecisions: [
      ...quietDecisions,
      ...suppressed.map((finding) => ({
        scope: "finding" as const,
        withheld: finding.title,
        // The schema already refuses a suppression with no reason, so the fallback
        // here is unreachable in practice and present only to satisfy the type.
        reason: finding.suppressionReason ?? "Suppressed by the assessor.",
        findingDedupeKey: finding.dedupeKey,
      })),
    ],
  };
}
