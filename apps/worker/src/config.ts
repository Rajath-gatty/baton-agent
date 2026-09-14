/**
 * Worker configuration, read once at startup and validated eagerly.
 *
 * Validating at startup rather than at first use matters for the deployed case:
 * Coolify restarts a container that exits, so a missing variable surfaces
 * immediately in the deploy log rather than hours later when the first sweep
 * fires.
 */

import { z } from "zod";

const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1),

    TELEGRAM_BOT_TOKEN: z.string().min(1),
    TELEGRAM_CHAT_ID: z.string().min(1),
    COORDINATOR_TELEGRAM_ID: z.string().min(1),

    /**
     * `agentcore` signs with SigV4 against AGENTCORE_RUNTIME_ARN.
     * `http` POSTs the same envelope to AGENT_HTTP_URL, for local development
     * where a deployed container could not reach this machine's data API.
     */
    AGENT_TRANSPORT: z.enum(["agentcore", "http"]).default("agentcore"),
    AGENTCORE_RUNTIME_ARN: z.string().optional(),
    AGENT_HTTP_URL: z.string().url().optional(),

    AWS_REGION: z.string().optional(),
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),

    /** Bearer token the agent presents to the read-only data API. */
    DATA_API_TOKEN: z.string().min(1),

    /**
     * Relative dates are resolved against this, not UTC. At IST, UTC would
     * shift dates by a day and look like a bug in provenance.
     */
    ORG_TIMEZONE: z.string().default("Asia/Kolkata"),

    PORT: z.coerce.number().int().positive().default(8081),
  })
  // Each transport needs different variables, so require them per transport
  // rather than requiring all of them and leaving half unused.
  .superRefine((value, ctx) => {
    if (value.AGENT_TRANSPORT === "agentcore") {
      for (const key of [
        "AGENTCORE_RUNTIME_ARN",
        "AWS_REGION",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
      ] as const) {
        if (value[key] === undefined || value[key] === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when AGENT_TRANSPORT is 'agentcore'`,
          });
        }
      }
    } else if (value.AGENT_HTTP_URL === undefined || value.AGENT_HTTP_URL === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AGENT_HTTP_URL"],
        message: "AGENT_HTTP_URL is required when AGENT_TRANSPORT is 'http'",
      });
    }
  });

export type WorkerConfig = z.infer<typeof configSchema>;

/**
 * The Telegram accounts permitted to answer an approval.
 *
 * `COORDINATOR_TELEGRAM_ID` accepts a **comma-separated list**, because a demo is operated
 * by more than one person and both need to be able to approve. The singular name is kept
 * because the product concept is singular: `app_settings.coordinator_person_id` is the one
 * coordinator the UI names and the one an approval is addressed to. This list is the
 * separate question of who may *answer*, and it exists so a second operator is not locked
 * out by a column that holds one id.
 *
 * What it is emphatically **not** is a widening of who may approve in general. Everyone on
 * this list is an operator named in the environment; a volunteer's "yes" is still not an
 * approval, which is the property the gate exists to protect.
 */
export function coordinatorTelegramIds(config: WorkerConfig): number[] {
  return (
    config.COORDINATOR_TELEGRAM_ID.split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => Number(part))
      // A non-numeric entry is dropped rather than becoming NaN, which would match nothing
      // and read as "the coordinator cannot approve" with no explanation anywhere.
      .filter((id) => Number.isSafeInteger(id))
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid worker configuration:\n${detail}`);
  }
  return parsed.data;
}
