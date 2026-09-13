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
    // AgentCore convention: the container listens on 8080.
    port: Number.parseInt(optional("PORT", "8080"), 10),
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
