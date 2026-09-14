/**
 * "Since you last looked" — the visit window.
 *
 * `coordinator_state` is a one-row table holding when the coordinator last looked
 * at the register. The diff on the continuity stop is everything that changed
 * after that instant, which means the column has to advance on view — and that is
 * where the naive implementation goes wrong. Setting `last_seen_at = now()` on
 * every render empties the diff on the very next render, and every server action
 * on the page revalidates it: press Resolve and the list the coordinator was
 * reading disappears, with nothing to say it had ever been there.
 *
 * So the two columns are read as a pair. `updated_at` is when the register was
 * last *looked at*; `last_seen_at` is the start of the window currently being
 * shown. A render more than `VISIT_GAP_MS` after the last one counts as a new
 * visit: the window start moves up to the previous visit's instant, and the visit
 * clock moves to now. Renders within one sitting — a revalidation after a write,
 * a hot reload, React rendering twice in development — read the same window.
 *
 * The result is the honest reading of the phrase: the diff covers what changed
 * since the coordinator's *previous* visit, and it stays still while they are
 * looking at it.
 */

import "server-only";
import { sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { getDb } from "./db";

const { coordinatorState } = schema;

/**
 * How long a gap makes the next render a new visit. Fifteen minutes: long enough
 * that a sitting with several writes in it stays one visit, short enough that
 * coming back after lunch shows what happened while away.
 */
const VISIT_GAP_MS = 15 * 60 * 1000;

/**
 * How far back the very first visit looks.
 *
 * Null `last_seen_at` means nobody has ever opened the register. Reading that as
 * "since the beginning of time" would put six months of seeded history into a
 * four-line strip, so a first visit shows the last fortnight instead.
 */
const FIRST_VISIT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Opens a visit and returns the instant the diff should be measured from.
 *
 * Writes, despite being called from a read path, and that is deliberate: the
 * window and its advancement are one decision, and splitting them would let a
 * caller render a diff without ever advancing the clock — which reads as "nothing
 * has changed since your last visit" forever.
 */
export async function openVisitWindow(now: Date = new Date()): Promise<Date> {
  const db = getDb();

  // The singleton row, created on first sight. `id = 1` is enforced by a check
  // constraint, so this can never grow a second row with a second answer.
  const rows = await db
    .insert(coordinatorState)
    .values({ id: 1, lastSeenAt: null, updatedAt: now })
    .onConflictDoNothing({ target: coordinatorState.id })
    .returning({ lastSeenAt: coordinatorState.lastSeenAt });

  const inserted = rows[0];
  if (inserted !== undefined) {
    // First ever visit: there is no previous look to measure from.
    return new Date(now.getTime() - FIRST_VISIT_WINDOW_MS);
  }

  const current = await db
    .select({ lastSeenAt: coordinatorState.lastSeenAt, updatedAt: coordinatorState.updatedAt })
    .from(coordinatorState)
    .limit(1);

  const state = current[0];
  if (state === undefined) {
    // Raced with a truncation. Not worth a transaction: the next render recreates
    // the row, and a fortnight is the same answer a first visit gives.
    return new Date(now.getTime() - FIRST_VISIT_WINDOW_MS);
  }

  const withinSameVisit = now.getTime() - state.updatedAt.getTime() < VISIT_GAP_MS;
  if (withinSameVisit) {
    return state.lastSeenAt ?? new Date(now.getTime() - FIRST_VISIT_WINDOW_MS);
  }

  // A new visit. The window now starts where the previous visit ended.
  const previousVisitAt = state.updatedAt;
  await db
    .update(coordinatorState)
    .set({ lastSeenAt: previousVisitAt, updatedAt: now })
    .where(sql`${coordinatorState.id} = 1`);

  return previousVisitAt;
}
