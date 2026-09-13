/**
 * The worker's HTTP surface. Two things, deliberately separated.
 *
 * `GET /health` is unauthenticated and exists for Coolify, not for the product.
 * Coolify's health checks want an HTTP endpoint, and pointing one at the
 * token-protected data API returns 401, which Coolify reads as unhealthy and
 * answers by restarting the container. That restart loop would bypass the
 * worker's own exponential backoff — the mechanism added specifically to stop
 * unattended retry storms — while also re-running migrations and disturbing the
 * polling offset on every cycle. It must not be published on the public domain.
 *
 * `/data/*` is the read-only API the agent's Strands tools call, behind a bearer
 * token, routed publicly by Coolify because the AgentCore container reaches it
 * from outside the VM.
 */

import express, { type Express, type RequestHandler } from "express";
import type { WorkerConfig } from "../config.js";

export interface ServerDeps {
  config: WorkerConfig;
  /** Cheap liveness probe against Postgres. */
  isDatabaseReachable: () => Promise<boolean>;
}

function bearerAuth(token: string): RequestHandler {
  return (req, res, next) => {
    const header = req.header("authorization");
    if (header !== `Bearer ${token}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

export function createServer({ config, isDatabaseReachable }: ServerDeps): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    const ok = await isDatabaseReachable();
    // 503 rather than 500: this is "not ready", which is what a health check is
    // asking about.
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded" });
  });

  const data = express.Router();
  data.use(bearerAuth(config.DATA_API_TOKEN));

  // All read-only. The agent never writes; it returns proposed changes and the
  // worker decides. Implemented alongside the Strands tools that call them.
  data.get("/facts", (_req, res) => res.status(501).json({ error: "Not implemented" }));
  data.get("/facts/:id/evidence", (_req, res) =>
    res.status(501).json({ error: "Not implemented" }),
  );
  data.get("/holdings", (_req, res) => res.status(501).json({ error: "Not implemented" }));
  data.get("/people", (_req, res) => res.status(501).json({ error: "Not implemented" }));

  app.use("/data", data);

  return app;
}
