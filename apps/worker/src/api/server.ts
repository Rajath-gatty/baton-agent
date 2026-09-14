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
import type { Executor } from "../store/types.js";
import { getEvidence, getHoldings, getPerson, searchFacts } from "../store/data-api.js";

export interface ServerDeps {
  config: WorkerConfig;
  /** Reads only. Nothing reachable from this server writes. */
  db: Executor;
  /** Cheap liveness probe against Postgres. */
  isDatabaseReachable: () => Promise<boolean>;
}

/** Reads a required single-value query parameter, or null when it is absent or blank. */
function queryParam(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
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

export function createServer({ config, db, isDatabaseReachable }: ServerDeps): Express {
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
  // worker decides. The paths and parameter names are fixed by the agent's client in
  // `apps/agent/src/tools/data-api.ts` — a rename here silently breaks a tool, since
  // the client reports a failed lookup as data rather than throwing.
  //
  // A missing parameter is a 400 rather than an empty result: the agent's tool
  // callbacks already reject blank input, so a blank arriving here means something is
  // wrong that should be visible in the trace instead of looking like "nothing found".

  /** `searchFacts(query)` */
  data.get("/facts", async (req, res) => {
    const q = queryParam(req.query["q"]);
    if (q === null) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    res.json({ facts: await searchFacts(db, q) });
  });

  /** `getEvidence(factId)` */
  data.get("/facts/:id/evidence", async (req, res) => {
    const result = await getEvidence(db, req.params.id);
    if (result === null) {
      res.status(404).json({ error: "No such claim" });
      return;
    }
    res.json(result);
  });

  /** `getHoldings(assetRef)` — open and closed rows, so a transfer is legible. */
  data.get("/holdings", async (req, res) => {
    const asset = queryParam(req.query["asset"]);
    if (asset === null) {
      res.status(400).json({ error: "asset is required" });
      return;
    }
    const result = await getHoldings(db, asset);
    if (result === null) {
      res.status(404).json({ error: "No such asset" });
      return;
    }
    res.json(result);
  });

  /** `getPerson(alias)` — every match, because several is the ambiguity signal. */
  data.get("/people", async (req, res) => {
    const alias = queryParam(req.query["alias"]);
    if (alias === null) {
      res.status(400).json({ error: "alias is required" });
      return;
    }
    res.json({ people: await getPerson(db, alias) });
  });

  app.use("/data", data);

  return app;
}
