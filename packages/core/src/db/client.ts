/**
 * The Postgres client.
 *
 * Imported by the worker, the web app and the scripts. **Never by the agent** —
 * the AgentCore container holds no database credentials, and the root ESLint
 * config fails the build if anything under `apps/agent` imports this.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof createDatabase>;

export interface DatabaseOptions {
  /** Postgres connection string. */
  url: string;
  /**
   * Connection ceiling. The worker holds a small pool and the web app another;
   * Postgres runs on the same small VM as both, so these are deliberately low.
   */
  max?: number;
}

export function createDatabase({ url, max = 5 }: DatabaseOptions) {
  const sql = postgres(url, { max, onnotice: () => {} });
  return drizzle(sql, { schema });
}

/**
 * Advisory lock key for the pipeline. Only one pipeline task — backfill, live
 * ingest, or a sweep — may run at a time. Without this, a sweep can compute
 * findings against half-updated state, and backfill can collide with live
 * ingest.
 *
 * An arbitrary but fixed constant: it only has to be stable across processes.
 */
export const PIPELINE_LOCK_KEY = 8_270_144;

export * as schema from "./schema.js";
