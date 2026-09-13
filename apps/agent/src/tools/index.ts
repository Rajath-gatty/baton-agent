/**
 * The Strands tools.
 *
 * Four read-only lookups over the worker's data API. Predictable context is
 * hydrated into the request payload; these exist for pull-based lookups the agent
 * cannot know it needs in advance — chiefly drilling into evidence before deciding
 * whether a claim is well enough supported to raise.
 *
 * **Input schemas are plain JSON Schema, not Zod.** The `tool()` factory accepts
 * either, and JSON Schema is used deliberately: it keeps every Zod schema in this
 * repository on our side of the SDK boundary, so the SDK's Zod 4 peer dependency
 * cannot conflict with the Zod 3 that `@baton/core` shares with Drizzle and the web
 * app. The callback validates its own input, which is what Zod would have bought.
 *
 * Every call is recorded in the trace, which is what feeds the agent activity panel.
 *
 * **The Curator gets none of these, on purpose.** Its cache is keyed on
 * `content_hash` plus `prompt_version`; if its output could depend on register state
 * at call time, a cached response would be silently wrong on the next backfill. The
 * Curator classifies text. It does not consult the register.
 */

import { tool } from "@strands-agents/sdk";
import type { JSONValue, ToolList } from "@strands-agents/sdk";
import type { DataApiClient, DataApiResult } from "./data-api.js";
import type { TraceCollector } from "../model/trace.js";

/** Truncates a tool argument for the trace, which is read by a human, not replayed. */
function summarise(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`;
}

function readString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Renders a result for the model.
 *
 * A failure is returned as data rather than thrown: a thrown tool aborts the agent
 * turn, whereas a reported failure lets the model finish with what it has — which for
 * the Respondent means answering `unknown` rather than the run producing nothing.
 */
function toJson(result: DataApiResult): JSONValue {
  if (!result.ok) return { error: result.error ?? "data API call failed" };
  return result.data ?? null;
}

export interface ToolDeps {
  dataApi: DataApiClient;
  trace: TraceCollector;
}

/**
 * Builds the read-only tool set.
 *
 * Returned as a fresh array per invocation because the trace collector is
 * per-invocation — a tool holding a stale collector would attribute this request's
 * lookups to the previous request's nodes.
 */
export function buildTools({ dataApi, trace }: ToolDeps): ToolList {
  const searchFacts = tool({
    name: "searchFacts",
    description:
      "Search the register for claims matching a phrase. Use when you need a claim that was not " +
      "included in the context you were given. Returns claims with their ids, holders and ages.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for in the claim text." },
      },
      required: ["query"],
    },
    callback: async (input) => {
      const query = readString(input, "query");
      if (query === null) {
        trace.recordToolCall({ name: "searchFacts", ok: false });
        return { error: "query is required and must be a non-empty string" };
      }
      const result = await dataApi.searchFacts(query);
      trace.recordToolCall({
        name: "searchFacts",
        argsSummary: summarise(query),
        ok: result.ok,
      });
      return toJson(result);
    },
  });

  const getEvidence = tool({
    name: "getEvidence",
    description:
      "Fetch the original messages a claim came from, with sender and date. Use before deciding " +
      "whether a claim rests on evidence thin enough to suppress or withhold.",
    inputSchema: {
      type: "object",
      properties: {
        factId: { type: "string", description: "The id of the claim to fetch evidence for." },
      },
      required: ["factId"],
    },
    callback: async (input) => {
      const factId = readString(input, "factId");
      if (factId === null) {
        trace.recordToolCall({ name: "getEvidence", ok: false });
        return { error: "factId is required and must be a non-empty string" };
      }
      const result = await dataApi.getEvidence(factId);
      trace.recordToolCall({
        name: "getEvidence",
        argsSummary: summarise(factId),
        ok: result.ok,
      });
      return toJson(result);
    },
  });

  const getHoldings = tool({
    name: "getHoldings",
    description:
      "Fetch who has held an asset, including past holders. Use to tell a transfer from a " +
      "genuine gap: an asset with no current holder may have had one last month.",
    inputSchema: {
      type: "object",
      properties: {
        assetRef: { type: "string", description: "The asset id or its name." },
      },
      required: ["assetRef"],
    },
    callback: async (input) => {
      const assetRef = readString(input, "assetRef");
      if (assetRef === null) {
        trace.recordToolCall({ name: "getHoldings", ok: false });
        return { error: "assetRef is required and must be a non-empty string" };
      }
      const result = await dataApi.getHoldings(assetRef);
      trace.recordToolCall({
        name: "getHoldings",
        argsSummary: summarise(assetRef),
        ok: result.ok,
      });
      return toJson(result);
    },
  });

  const getPerson = tool({
    name: "getPerson",
    description:
      "Look up the people a name or handle could refer to. Returns every match, because a name " +
      "matching more than one person is the ambiguity signal rather than an error.",
    inputSchema: {
      type: "object",
      properties: {
        alias: { type: "string", description: "The name, handle or nickname as written." },
      },
      required: ["alias"],
    },
    callback: async (input) => {
      const alias = readString(input, "alias");
      if (alias === null) {
        trace.recordToolCall({ name: "getPerson", ok: false });
        return { error: "alias is required and must be a non-empty string" };
      }
      const result = await dataApi.getPerson(alias);
      trace.recordToolCall({
        name: "getPerson",
        argsSummary: summarise(alias),
        ok: result.ok,
      });
      return toJson(result);
    },
  });

  return [searchFacts, getEvidence, getHoldings, getPerson];
}

/**
 * The tools each role may use. The allocation is a design decision, not an
 * oversight, and two entries in particular are load bearing:
 *
 *   - **curator: none.** See the note at the top of this file. Giving it a lookup
 *     tool would make its output depend on register state and silently invalidate
 *     the per-message cache.
 *   - **restraint: none.** Restraint judges what it is handed. A Restraint that
 *     could go looking for more evidence would be second-guessing the agent that
 *     produced the item rather than deciding whether to say it.
 */
export const TOOLS_BY_ROLE = {
  curator: [] as const,
  cartographer: ["getPerson"] as const,
  assessor: ["getEvidence"] as const,
  restraint: [] as const,
  briefer: ["getHoldings", "getEvidence"] as const,
  respondent: ["searchFacts", "getEvidence"] as const,
} as const;

/** Filters the built tool set down to what a role is permitted to use. */
export function toolsFor(role: keyof typeof TOOLS_BY_ROLE, deps: ToolDeps): ToolList {
  const permitted = new Set<string>(TOOLS_BY_ROLE[role]);
  if (permitted.size === 0) return [];

  return buildTools(deps).filter((candidate) => {
    const named = candidate as { name?: string };
    return named.name !== undefined && permitted.has(named.name);
  });
}
