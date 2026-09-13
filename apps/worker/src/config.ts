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
