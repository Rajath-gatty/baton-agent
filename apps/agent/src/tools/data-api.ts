/**
 * The data API client.
 *
 * The agent container holds no database credentials, so every read that is not
 * hydrated into the request goes over HTTP to the worker's token-authenticated
 * read-only API. This is the only outbound call the container makes other than to
 * the model provider.
 *
 * **Read-only, without exception.** The agent never writes; it returns proposed
 * changes and the worker decides. There is no write method here to be tempted by.
 *
 * Failures are returned rather than thrown. A tool that throws aborts the whole
 * agent turn, whereas a tool that reports "could not reach the register" lets the
 * model finish with what it has — which for the Respondent means answering
 * `unknown` instead of the run producing nothing at all. The failure is recorded in
 * the trace either way, so a coordinator sees that a lookup did not land.
 */

import type { JSONValue } from "@strands-agents/sdk";

/** How long a single data API call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Results are typed as `JSONValue` rather than a domain shape.
 *
 * The agent does not own these shapes — the worker does, and it re-validates
 * everything it receives back anyway. Mirroring its row types here would create a
 * second definition to drift, for a value that is only ever handed to a model as
 * text.
 */
export interface DataApiResult<T = JSONValue> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface DataApiConfig {
  url: string;
  token: string;
}

export class DataApiClient {
  constructor(private readonly config: DataApiConfig) {}

  private async get(path: string, query: Record<string, string>): Promise<DataApiResult> {
    const base = this.config.url.endsWith("/") ? this.config.url.slice(0, -1) : this.config.url;
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        return { ok: false, error: `data API returned ${response.status}` };
      }

      return { ok: true, data: (await response.json()) as JSONValue };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `data API unreachable: ${message}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Free-text search over the fact index. */
  searchFacts(query: string): Promise<DataApiResult> {
    return this.get("/data/facts", { q: query });
  }

  /** The messages behind a fact, for drilling into provenance. */
  getEvidence(factId: string): Promise<DataApiResult> {
    return this.get(`/data/facts/${encodeURIComponent(factId)}/evidence`, {});
  }

  /** Holding history for an asset — open and closed rows, because transfers matter. */
  getHoldings(assetRef: string): Promise<DataApiResult> {
    return this.get("/data/holdings", { asset: assetRef });
  }

  /** Resolve an alias to the people it could mean. */
  getPerson(alias: string): Promise<DataApiResult> {
    return this.get("/data/people", { alias });
  }
}
