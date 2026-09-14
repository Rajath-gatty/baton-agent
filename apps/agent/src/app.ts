/**
 * The Express app, separated from the process that runs it.
 *
 * `server.ts` used to load configuration and call `listen` at module scope, which made
 * the HTTP contract untestable: importing it started a server and required a populated
 * environment. Since that contract is the boundary between the worker and this
 * container — the place where a version skew between the two shows up as a 400 — it is
 * worth being able to exercise without a socket.
 *
 * The split is deliberate about what lives where. Everything decided by the request
 * lives here; everything decided by the process — which port, which signals, when to
 * exit — stays in `server.ts`.
 */

import express, { type Express } from "express";
import { agentRequestSchema, type AgentRequest, type AgentResponse } from "@baton/core";
import type { AgentConfig } from "./config.js";
import { dispatch } from "./tasks/index.js";

/** The one thing the route does that a test wants to control. */
export type Dispatcher = (request: AgentRequest, config: AgentConfig) => Promise<AgentResponse>;

export interface AppOptions {
  config: AgentConfig;
  /** Overridden in tests, so the HTTP contract can be exercised without a model. */
  dispatcher?: Dispatcher;
}

export function createApp({ config, dispatcher = dispatch }: AppOptions): Express {
  const app = express();

  // The Curator is invoked with batches of candidate messages, so the default body
  // limit is too small for a backfill batch.
  app.use(express.json({ limit: "4mb" }));

  /** AgentCore health probe. */
  app.get("/ping", (_req, res) => {
    res.status(200).json({ status: "healthy" });
  });

  app.post("/invocations", async (req, res) => {
    const parsed = agentRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      // A malformed envelope means the worker and this container disagree about the
      // contract, which happens in the window between deploying one and the other. Say
      // so explicitly rather than failing deeper in a task handler.
      res.status(400).json({
        stopReason: "error",
        error: `Invalid agent request envelope: ${parsed.error.message}`,
        trace: [],
      } satisfies Partial<AgentResponse>);
      return;
    }

    const request = parsed.data;

    try {
      const response = await dispatcher(request, config);
      res.status(200).json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        task: request.task,
        runId: request.runId,
        stopReason: "error",
        error: message,
        trace: [],
      } satisfies AgentResponse);
    }
  });

  return app;
}
