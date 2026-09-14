/**
 * Agent configuration, read once at startup.
 *
 * Every agent's model comes from its own environment variable. The Curator runs
 * on every candidate message and dominates cost and latency; the Assessor,
 * Restraint and Briefer produce the text a reader actually judges. Separating
 * them means those three can be pointed at a stronger model by changing
 * environment variables, without touching the one that dominates cost.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export interface AgentConfig {
  port: number;
  model: {
    baseUrl: string;
    apiKey: string;
    curator: string;
    cartographer: string;
    assessor: string;
    restraint: string;
    briefer: string;
    respondent: string;
  };
  /** The worker's read-only data API, which the Strands tools call. */
  dataApi: {
    url: string;
    token: string;
  };
}

export function loadConfig(): AgentConfig {
  const defaultModel = optional("DEFAULT_MODEL", "deepseek-chat");

  return {
    /**
     * `AGENT_PORT` first, then `PORT`, then the AgentCore convention of 8080.
     *
     * Both this container and the worker read `PORT`, which is correct in production
     * where each is its own container and AgentCore sets it. Locally they share one
     * `.env`, so a single `PORT` had this process bind the worker's 8081 — and since
     * `AGENT_HTTP_URL` points at 8080, the worker then could not reach it. `AGENT_PORT`
     * separates them without breaking the deployed case, where it is simply unset.
     */
    port: Number.parseInt(optional("AGENT_PORT", optional("PORT", "8080")), 10),
    model: {
      baseUrl: required("MODEL_BASE_URL"),
      apiKey: required("MODEL_API_KEY"),
      curator: optional("CURATOR_MODEL", defaultModel),
      cartographer: optional("CARTOGRAPHER_MODEL", defaultModel),
      assessor: optional("ASSESSOR_MODEL", defaultModel),
      restraint: optional("RESTRAINT_MODEL", defaultModel),
      briefer: optional("BRIEFER_MODEL", defaultModel),
      respondent: optional("RESPONDENT_MODEL", defaultModel),
    },
    dataApi: {
      url: required("DATA_API_URL"),
      token: required("DATA_API_TOKEN"),
    },
  };
}
