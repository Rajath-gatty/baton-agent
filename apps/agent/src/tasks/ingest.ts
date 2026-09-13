/**
 * The `ingest` task — `Graph`: Curator → Cartographer.
 *
 * **The one task Restraint does not touch.** It produces no outbound text: its output
 * is extracted records for the worker to persist, and there is nothing here a
 * volunteer reads. Gating it would spend model calls on text nobody sees.
 *
 * A fixed two-node DAG rather than a swarm, because the order is not a decision the
 * agents get to make. Extraction always precedes attribution: the Cartographer
 * resolves the mentions the Curator found, and a Cartographer that ran first would
 * have nothing to resolve.
 */

import { Graph } from "@strands-agents/sdk";
import {
  ingestContextSchema,
  ingestPayloadSchema,
  type CartographerOutput,
  type CuratorOutput,
  type IngestResult,
} from "@baton/core";
import { runCurator } from "../agents/curator.js";
import { runCartographer } from "../agents/cartographer.js";
import type { AgentDeps } from "../agents/shared.js";
import { PipelineNode, throwIfAnyNodeFailed } from "./pipeline-node.js";

export async function runIngest(
  rawPayload: unknown,
  rawContext: unknown,
  deps: AgentDeps,
): Promise<IngestResult> {
  const payload = ingestPayloadSchema.parse(rawPayload);
  const context = ingestContextSchema.parse(rawContext);

  let curated: CuratorOutput | undefined;
  let attributed: CartographerOutput | undefined;

  const curatorNode = new PipelineNode(
    "curator",
    "Classifies each candidate message and extracts records.",
    async () => {
      curated = await runCurator(payload, context, deps);
      const records = curated.results.reduce((total, result) => total + result.records.length, 0);
      return `Classified ${curated.results.length} messages and extracted ${records} records.`;
    },
  );

  const cartographerNode = new PipelineNode(
    "cartographer",
    "Resolves the person mentions in those records to people.",
    async () => {
      if (curated === undefined) {
        throw new Error("Cartographer ran before the Curator, so the graph edges are wrong.");
      }
      attributed = await runCartographer(curated, context.aliases, deps);
      return `Attributed ${attributed.attributions.length} mentions.`;
    },
  );

  const graph = new Graph({
    nodes: [curatorNode, cartographerNode],
    edges: [["curator", "cartographer"]],
    sources: ["curator"],
  });

  const result = await graph.invoke("Ingest this batch of candidate messages.");
  throwIfAnyNodeFailed(result.results, "ingest");

  if (curated === undefined || attributed === undefined) {
    throw new Error(
      `Ingest finished with status '${result.status}' but produced no output. ` +
        `Nodes visited: ${result.results.map((node) => node.nodeId).join(", ")}.`,
    );
  }

  return { curator: curated, cartographer: attributed };
}
