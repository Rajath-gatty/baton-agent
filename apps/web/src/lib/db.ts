/**
 * The admin UI's database handle.
 *
 * The web app reads Postgres directly over the Docker network, as the technical
 * design states — it is the one reader that is not the worker. It holds a pool of
 * its own rather than sharing the worker's, because the two processes are separate
 * containers; the pool is deliberately small, since Postgres runs on the same
 * small VM as both.
 *
 * **Lazy, and cached on the module scope.** A client created at import time would
 * connect during `next build`, where there is no database, and fail the build for
 * a page that only renders. Created on first read instead, and reused after.
 *
 * The cache is keyed on `globalThis` because Next's dev server re-evaluates
 * modules on every edit: without it, each hot reload would open another pool and
 * a morning's editing would exhaust Postgres' connection slots.
 *
 * `DATABASE_URL` is read from the environment, which `next.config.mjs` populates
 * from the repository-root `.env` in development and Coolify injects in
 * production. Absent, this throws rather than falling back to a default — a page
 * silently reading an empty local database would look like an empty register,
 * which is the one failure that must not be quiet.
 */

import "server-only";
import { createDatabase, type Database } from "@baton/core/db";

/** Small on purpose: one human user, and Postgres shares the VM. */
const MAX_CONNECTIONS = 4;

const CACHE_KEY = Symbol.for("baton.web.database");

type Cache = { [CACHE_KEY]?: Database };

export function getDb(): Database {
  const cache = globalThis as unknown as Cache;
  const existing = cache[CACHE_KEY];
  if (existing !== undefined) return existing;

  const url = process.env.DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error(
      "DATABASE_URL is not set. The admin UI reads the register directly from Postgres; " +
        "without it there is nothing to read and an empty page would look like an empty register.",
    );
  }

  const db = createDatabase({ url, max: MAX_CONNECTIONS });
  cache[CACHE_KEY] = db;
  return db;
}
