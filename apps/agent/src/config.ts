/**
 * Agent configuration, read once at startup and validated eagerly.
 *
 * Every agent's model comes from its own environment variable. The Curator runs
 * on every candidate message and dominates cost and latency; the Assessor,
 * Restraint and Briefer produce the text a reader actually judges. Separating
 * them means those three can be pointed at a stronger model by changing
 * environment variables, without touching the one that dominates cost.
 *
 * **Why this is validated by a schema rather than by hand.** This container's
 * environment is the least inspectable in the system: it is set once at
 * `agentcore launch`, there is no manifest for it in this repository the way
 * `docker-compose.yml` is the manifest for the worker, and its logs are read
 * through CloudWatch. So a misconfiguration has to fail immediately and say
 * exactly which variable is wrong, in one message, rather than throwing on the
 * first of several and hiding the rest.
 *
 * Two specific failures this replaces:
 *
 *   - **A non-numeric port produced `NaN` silently.** `Number.parseInt("http")`
 *     is `NaN`, and `app.listen(NaN)` binds an arbitrary free port. The container
 *     comes up, reports healthy on a port nothing routes to, and AgentCore reports
 *     an unreachable agent — which looks like an egress or networking problem, not
 *     a typo.
 *   - **The environment was read from `process.env` directly**, so no test could
 *     exercise it. `loadConfig` now takes the environment as an argument, exactly
 *     as the worker's does.
 *
 * An empty string is treated as absent throughout. Some shells and process
 * managers export every name they know about, empty ones included, and a variable
 * set to `""` is not configuration — it is the absence of configuration wearing a
 * value. This is the same hazard `loadDotEnv` exists for, applied one layer up.
 *
 * Note this workspace runs Zod 4 while `packages/core` runs Zod 3, deliberately —
 * see the note in `package.json`. Nothing here crosses that boundary: this schema
 * is built and consumed entirely inside `apps/agent`.
 */

import { z } from "zod";

/** Used when no per-agent model and no `DEFAULT_MODEL` is set. */
const FALLBACK_MODEL = "deepseek-chat";

/**
 * The output ceiling for every agent call, when `MODEL_MAX_TOKENS` is unset.
 *
 * **An unset ceiling is not "no limit" — it is the model's maximum**, and that has two
 * costs. The visible one: a provider that authorises credit against the *requested*
 * ceiling rather than the tokens actually produced rejects the request outright. This
 * gate was found exactly that way, with OpenRouter answering `402 This request requires
 * more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only
 * afford 33326` — a message that reads as an account problem while being, in part, a
 * configuration one. The quieter cost: nothing bounds a runaway generation on the agent
 * that runs on every candidate message.
 *
 * 8,192 is chosen against the largest real output rather than by feel. The Curator is
 * the widest: ten messages per batch, each carrying a handful of flat records, which
 * measures in the low thousands of tokens. Briefs and answers are prose a human reads
 * and are shorter still. If a node ever needs more, it will stop with a truncated
 * response and fail schema validation — which is loud, and is the retry loop's job to
 * report — rather than silently producing half a register.
 */
const FALLBACK_MAX_TOKENS = 8192;

/** The AgentCore convention. */
const FALLBACK_PORT = 8080;

/** The six agent roles, in the order they appear in the pipeline. */
const MODEL_ROLES = [
  "curator",
  "cartographer",
  "assessor",
  "restraint",
  "briefer",
  "respondent",
] as const;

type ModelRole = (typeof MODEL_ROLES)[number];

/** `curator` → `CURATOR_MODEL`. */
const MODEL_ENV_VAR: Record<ModelRole, string> = {
  curator: "CURATOR_MODEL",
  cartographer: "CARTOGRAPHER_MODEL",
  assessor: "ASSESSOR_MODEL",
  restraint: "RESTRAINT_MODEL",
  briefer: "BRIEFER_MODEL",
  respondent: "RESPONDENT_MODEL",
};

/** An empty or whitespace-only string is absent, not a value. */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const requiredString = z.preprocess(blankToUndefined, z.string().min(1));
const optionalString = z.preprocess(blankToUndefined, z.string().min(1).optional());

/**
 * A port, or absent.
 *
 * `z.coerce.number()` is what turns the old `NaN` into a validation error:
 * `Number("http")` is `NaN` and fails `z.number()`, so the container refuses to
 * start instead of binding somewhere arbitrary.
 */
const optionalPort = z.preprocess(
  blankToUndefined,
  z.coerce.number().int().positive().max(65535).optional(),
);

const configSchema = z.object({
  /**
   * `AGENT_PORT` first, then `PORT`, then 8080.
   *
   * Both this container and the worker read `PORT`, which is correct in production
   * where each is its own container and AgentCore sets it. Locally they share one
   * `.env`, so a single `PORT` had this process bind the worker's 8081 — and since
   * `AGENT_HTTP_URL` points at 8080, the worker then could not reach it.
   * `AGENT_PORT` separates them without breaking the deployed case, where it is
   * simply unset.
   */
  AGENT_PORT: optionalPort,
  PORT: optionalPort,

  MODEL_BASE_URL: requiredString,
  MODEL_API_KEY: requiredString,

  /**
   * The output ceiling per call. Optional; see {@link FALLBACK_MAX_TOKENS} for why it
   * has a default at all rather than being left to the provider.
   *
   * Reuses `optionalPort`'s validation deliberately — both are "a positive integer or
   * absent", and 65,535 is above any plausible output ceiling, so the bound costs
   * nothing and the `NaN` protection is the same protection.
   */
  MODEL_MAX_TOKENS: optionalPort,

  DEFAULT_MODEL: optionalString,
  CURATOR_MODEL: optionalString,
  CARTOGRAPHER_MODEL: optionalString,
  ASSESSOR_MODEL: optionalString,
  RESTRAINT_MODEL: optionalString,
  BRIEFER_MODEL: optionalString,
  RESPONDENT_MODEL: optionalString,

  /** The worker's read-only data API, which the Strands tools call. */
  DATA_API_URL: requiredString,
  DATA_API_TOKEN: requiredString,
});

export interface AgentConfig {
  port: number;
  model: {
    baseUrl: string;
    apiKey: string;
    /** Output ceiling per call, applied to every role. */
    maxTokens: number;
  } & Record<ModelRole, string>;
  dataApi: {
    url: string;
    token: string;
  };
}

/**
 * Resolves the parsed environment into the shape the rest of the container reads.
 *
 * Kept separate from the schema because the per-agent model chain — role variable,
 * then `DEFAULT_MODEL`, then the fallback — is a resolution rule rather than a
 * validation rule, and Zod's `.default()` cannot reference a sibling field.
 */
function resolve(env: z.infer<typeof configSchema>): AgentConfig {
  const defaultModel = env.DEFAULT_MODEL ?? FALLBACK_MODEL;

  const models = Object.fromEntries(
    MODEL_ROLES.map((role) => [role, env[MODEL_ENV_VAR[role] as keyof typeof env] ?? defaultModel]),
  ) as Record<ModelRole, string>;

  return {
    port: env.AGENT_PORT ?? env.PORT ?? FALLBACK_PORT,
    model: {
      baseUrl: env.MODEL_BASE_URL,
      apiKey: env.MODEL_API_KEY,
      maxTokens: env.MODEL_MAX_TOKENS ?? FALLBACK_MAX_TOKENS,
      ...models,
    },
    dataApi: {
      url: env.DATA_API_URL,
      token: env.DATA_API_TOKEN,
    },
  };
}

/**
 * Reads and validates the configuration.
 *
 * Takes the environment rather than reaching for `process.env`, so it is testable.
 * Reports every problem at once: a container that fails on one missing variable,
 * is redeployed, then fails on the next costs a deploy cycle per mistake, and this
 * is the service where a deploy cycle is slowest.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = configSchema.safeParse(env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid agent configuration:\n${detail}`);
  }

  return resolve(parsed.data);
}
