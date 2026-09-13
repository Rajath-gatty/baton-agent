/**
 * The AgentCore container.
 *
 * Implements the AgentCore Runtime contract: `POST /invocations` and
 * `GET /ping`. Dispatches on the request's `task` field to one of five
 * handlers. Stateless by deliberate choice — input is a task, a payload and
 * hydrated context; output is structured results plus a trace. It never touches
 * Postgres, so database credentials exist in exactly one place, there is no VPC
 * or network plumbing, and this container is trivially redeployable.
 */

import express from "express";
import { agentRequestSchema, type AgentResponse } from "@baton/core";
import { loadConfig } from "./config.js";
import { dispatch } from "./tasks/index.js";

const config = loadConfig();
const app = express();

// The Curator is invoked with batches of candidate messages, so the default
// body limit is too small for a backfill batch.
app.use(express.json({ limit: "4mb" }));

/** AgentCore health probe. */
app.get("/ping", (_req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.post("/invocations", async (req, res) => {
  const parsed = agentRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    // A malformed envelope means the worker and this container disagree about
    // the contract, which happens in the window between deploying one and the
    // other. Say so explicitly rather than failing deeper in a task handler.
    res.status(400).json({
      stopReason: "error",
      error: `Invalid agent request envelope: ${parsed.error.message}`,
      trace: [],
    } satisfies Partial<AgentResponse>);
    return;
  }

  const request = parsed.data;

  try {
    const response = await dispatch(request, config);
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

const server = app.listen(config.port, () => {
  console.log(`[agent] listening on ${config.port}`);
});

// AgentCore may bill by session lifetime rather than request processing, so
// shutting down promptly on signal matters more here than it would elsewhere.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[agent] ${signal} received, closing`);
    server.close(() => process.exit(0));
  });
}
