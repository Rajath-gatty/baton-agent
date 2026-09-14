/**
 * The pipeline lock. `[F14]`
 *
 * Exactly one pipeline pass may run at a time. The reason is not throughput but
 * correctness: supersession is order-dependent, so two passes reading the same
 * uncurated messages in `sent_at` order would both extract them, and the second
 * would process a contradiction against a register the first had already moved on
 * from. The visible result is a fact that flips depending on which pass committed
 * last — a bug with no stack trace and no reproduction.
 *
 * **Transaction-scoped, not session-scoped, and that is the whole design of this
 * file.** The obvious implementation is `pg_try_advisory_lock` held for the life of
 * the pass and released with `pg_advisory_unlock`. It is wrong here. Advisory locks
 * belong to the *connection* that took them, and every statement in this worker goes
 * through a pool — so the unlock can be served by a different connection than the
 * lock, where it finds nothing to release, returns false, and leaves the lock held
 * until the original connection is recycled. The failure mode is a worker that
 * silently stops processing and reports nothing wrong.
 *
 * `pg_try_advisory_xact_lock` inside a transaction cannot do that. Postgres releases
 * it at commit or rollback, including a rollback caused by the process dying, so
 * there is no path where the lock outlives the work it guards.
 *
 * The cost is honest: the transaction stays open for the whole pass, which includes
 * a model call. That is acceptable because this system has exactly one writer and a
 * pass is bounded — ten messages, one round trip — and because the alternative
 * trades a bounded open transaction for an unbounded stuck lock. The `runs` row is
 * deliberately written *outside* this transaction by the caller, so a failed pass
 * still leaves a record of having failed.
 */

import { sql } from "drizzle-orm";
import type { Database } from "@baton/core/db";
import type { Transaction } from "./types.js";

/**
 * The advisory lock key.
 *
 * Arbitrary but fixed, and it must never collide with another advisory lock in the
 * same database. There is only one other candidate use — none today — so a single
 * named constant is enough, and naming it here keeps the number from being typed
 * twice.
 */
export const PIPELINE_LOCK_KEY = 4_812_004;

/**
 * Runs `work` under the pipeline lock, or returns null if another pass holds it.
 *
 * Returning null rather than throwing or waiting is deliberate. A blocked pass is
 * not an error — the work is being done by the pass that holds the lock, and the
 * next tick will find whatever is left. Waiting would queue ticks behind each other
 * and turn a slow model call into a growing backlog of identical passes.
 */
export async function withPipelineLock<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const acquired = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${PIPELINE_LOCK_KEY}) as locked`,
    );
    // postgres-js returns an array-like of rows; the first row is the only row.
    const locked = [...acquired][0]?.locked === true;
    if (!locked) return null;

    return work(tx);
  });
}

/**
 * Whether the pipeline lock is currently held, by anyone.
 *
 * Reads `pg_locks` rather than trying to take the lock, because trying to take it
 * would succeed when called from the connection that already holds it — advisory
 * locks are re-entrant per session — and a health check that reports "free" while a
 * pass is running is worse than no health check.
 */
export async function isPipelineLocked(db: Database): Promise<boolean> {
  const rows = await db.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory'
        and objid = ${PIPELINE_LOCK_KEY}
        and granted
    ) as held
  `);
  return [...rows][0]?.held === true;
}
