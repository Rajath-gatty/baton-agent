/**
 * The tool layer and the data API client.
 *
 * Two things are being protected here, and they are different in kind.
 *
 * **The allocation is a privacy and correctness boundary, not a convenience.**
 * `TOOLS_BY_ROLE` gives the Curator and Restraint nothing, deliberately: a Curator
 * that could consult the register would produce output that depends on register state,
 * which its `content_hash` + `prompt_version` cache key does not describe — so a
 * cached response would be silently wrong on the next backfill. Nothing about that is
 * visible at a call site, so it is asserted here.
 *
 * **A failing lookup must not abort the turn.** A thrown tool takes the whole agent
 * turn down; a tool that reports "could not reach the register" lets the Respondent
 * answer `unknown` instead of the run producing nothing at all. That means the client
 * returns failures as values, and the tools pass them to the model as data.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { DataApiClient } from "../src/tools/data-api.js";
import { TOOLS_BY_ROLE, buildTools, toolsFor } from "../src/tools/index.js";
import { TraceCollector } from "../src/model/trace.js";

/**
 * The configured base is the worker's origin, not its `/data` prefix — the client
 * appends `/data/...` itself. Getting this wrong yields `/data/data/facts`, which
 * 404s and would present as an empty register rather than a misconfiguration.
 */
const CONFIG = { url: "https://worker.test", token: "tok-1" };

/** Replaces global fetch for one test, returning what the handler decides. */
function stubFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return handler(url, init ?? {});
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the data API client", () => {
  it("sends the bearer token on every call", async () => {
    // The agent container holds no database credentials; this token is the only thing
    // that gets it a read. A call without it is a 401 the model would report as
    // "the register is unavailable", which reads like an outage rather than a bug.
    const spy = stubFetch(() => jsonResponse({ facts: [] }));
    await new DataApiClient(CONFIG).searchFacts("keys");

    const init = spy.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
  });

  it("puts the search term in the query string, not the path", async () => {
    const spy = stubFetch(() => jsonResponse({ facts: [] }));
    await new DataApiClient(CONFIG).searchFacts("store room key");

    const url = spy.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/data/facts");
    expect(url.searchParams.get("q")).toBe("store room key");
  });

  it("encodes a fact id into the path", async () => {
    const spy = stubFetch(() => jsonResponse({ messages: [] }));
    await new DataApiClient(CONFIG).getEvidence("fact/with slash");

    const url = spy.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/data/facts/fact%2Fwith%20slash/evidence");
  });

  it("tolerates a trailing slash on the configured url", async () => {
    // Otherwise the path doubles up and every lookup 404s — a configuration typo that
    // would present as an empty register.
    const spy = stubFetch(() => jsonResponse({ facts: [] }));
    await new DataApiClient({ ...CONFIG, url: "https://worker.test/" }).searchFacts("k");

    expect((spy.mock.calls[0]?.[0] as URL).pathname).toBe("/data/facts");
  });

  it("reports a non-2xx as a failed result rather than throwing", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 503));
    const result = await new DataApiClient(CONFIG).getHoldings("a-1");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  it("reports an unreachable worker as a failed result rather than throwing", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await new DataApiClient(CONFIG).getPerson("Priya");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unreachable/i);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns the parsed body on success", async () => {
    stubFetch(() => jsonResponse({ people: [{ personId: "p-1" }] }));
    const result = await new DataApiClient(CONFIG).getPerson("Priya");

    expect(result).toEqual({ ok: true, data: { people: [{ personId: "p-1" }] } });
  });

  it("has no write method to be tempted by", () => {
    // The agent never writes; it proposes and the worker decides. Asserted as an
    // absence because the guarantee is that there is nothing here to call.
    const client = new DataApiClient(CONFIG) as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(DataApiClient.prototype);

    expect(methods.filter((name) => /post|put|patch|delete|write|create/i.test(name))).toEqual([]);
    expect(client.post).toBeUndefined();
  });
});

describe("the tool allocation", () => {
  function deps() {
    return { dataApi: new DataApiClient(CONFIG), trace: new TraceCollector() };
  }

  it("gives the Curator no tools, because its cache key cannot describe register state", () => {
    expect(TOOLS_BY_ROLE.curator).toEqual([]);
    expect(toolsFor("curator", deps())).toEqual([]);
  });

  it("gives Restraint no tools, because it judges only what it is handed", () => {
    // A Restraint that could go looking for more evidence would be second-guessing the
    // agent that produced the item rather than deciding whether to say it.
    expect(TOOLS_BY_ROLE.restraint).toEqual([]);
    expect(toolsFor("restraint", deps())).toEqual([]);
  });

  it("gives each other role exactly its permitted tools, by name", () => {
    const named = (role: Parameters<typeof toolsFor>[0]) =>
      toolsFor(role, deps())
        .map((entry) => (entry as { name?: string }).name)
        .sort();

    expect(named("cartographer")).toEqual(["getPerson"]);
    expect(named("assessor")).toEqual(["getEvidence"]);
    expect(named("briefer")).toEqual(["getEvidence", "getHoldings"]);
    expect(named("respondent")).toEqual(["getEvidence", "searchFacts"]);
  });

  it("builds the full set of four", () => {
    expect(
      buildTools(deps())
        .map((entry) => (entry as { name?: string }).name)
        .sort(),
    ).toEqual(["getEvidence", "getHoldings", "getPerson", "searchFacts"]);
  });

  it("returns a fresh set per call, so a tool cannot hold a stale trace collector", () => {
    // The collector is per-invocation. A retained one would attribute this request's
    // lookups to the previous request's nodes.
    const [first] = buildTools(deps());
    const [second] = buildTools(deps());

    expect(first).not.toBe(second);
  });
});

describe("what a tool hands back to the model", () => {
  function harness() {
    const trace = new TraceCollector();
    const tools = buildTools({ dataApi: new DataApiClient(CONFIG), trace });
    const byName = new Map(tools.map((entry) => [(entry as { name?: string }).name, entry]));
    return { trace, byName };
  }

  /**
   * Invokes a built tool the way the SDK does.
   *
   * Through the public `invoke` rather than by reaching for the private `_callback`:
   * a test that bypasses the SDK's own entry point would keep passing if the contract
   * between `tool()` and the runtime changed.
   */
  async function invoke(built: unknown, input: unknown): Promise<unknown> {
    return (built as { invoke: (input: unknown) => Promise<unknown> }).invoke(input);
  }

  it("returns a failure as data, so the turn survives an unreachable register", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const { byName } = harness();

    const output = (await invoke(byName.get("searchFacts"), { query: "keys" })) as {
      error?: string;
    };

    expect(output.error).toMatch(/unreachable/i);
  });

  it("records every call in the trace, successful or not", async () => {
    stubFetch(() => jsonResponse({ facts: [] }));
    const { trace, byName } = harness();

    await invoke(byName.get("searchFacts"), { query: "store room key" });
    trace.add({ node: "respondent" });

    expect(trace.toArray()[0]?.toolCalls).toEqual([
      { name: "searchFacts", argsSummary: "store room key", ok: true },
    ]);
  });

  it("marks a failed lookup as not ok in the trace", async () => {
    stubFetch(() => jsonResponse({}, 500));
    const { trace, byName } = harness();

    await invoke(byName.get("getEvidence"), { factId: "f-1" });
    trace.add({ node: "assessor" });

    expect(trace.toArray()[0]?.toolCalls?.[0]).toMatchObject({ name: "getEvidence", ok: false });
  });

  it("rejects a missing argument without calling the register", async () => {
    const spy = stubFetch(() => jsonResponse({}));
    const { byName } = harness();

    const output = (await invoke(byName.get("getPerson"), {})) as { error?: string };

    expect(output.error).toMatch(/alias is required/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats a blank argument as missing, rather than searching for nothing", async () => {
    const spy = stubFetch(() => jsonResponse({}));
    const { byName } = harness();

    const output = (await invoke(byName.get("searchFacts"), { query: "   " })) as {
      error?: string;
    };

    expect(output.error).toMatch(/query is required/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("truncates a long argument in the trace, which a human reads", async () => {
    stubFetch(() => jsonResponse({ facts: [] }));
    const { trace, byName } = harness();

    await invoke(byName.get("searchFacts"), { query: "x".repeat(200) });
    trace.add({ node: "respondent" });

    const summary = trace.toArray()[0]?.toolCalls?.[0]?.argsSummary ?? "";
    expect(summary).toHaveLength(60);
    expect(summary.endsWith("...")).toBe(true);
  });
});
