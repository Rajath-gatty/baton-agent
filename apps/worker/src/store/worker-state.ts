/**
 * The single-row `worker_state` table.
 *
 * Every write goes through an upsert on `id = 1` rather than an update, so the row
 * does not have to be seeded before the worker's first poll. A missing row and a row
 * with a null offset mean the same thing — "start from whatever Telegram still holds"
 * — and collapsing them removes a startup step that would otherwise be easy to forget
 * and hard to diagnose.
 */

import { eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { Executor } from "./types.js";

const { workerState } = schema;

const SINGLETON_ID = 1;

/** The next update id to request, or null when nothing has been polled yet. */
export async function getTelegramOffset(db: Executor): Promise<number | null> {
  const rows = await db
    .select({ offset: workerState.telegramOffset })
    .from(workerState)
    .where(eq(workerState.id, SINGLETON_ID))
    .limit(1);
  return rows[0]?.offset ?? null;
}

/**
 * Commits the polling offset.
 *
 * Called **after** the batch has been persisted, never before. The consequence is
 * that a crash mid-batch replays those updates on restart — which is exactly why
 * intake upserts on `(chat_id, telegram_message_id)`. The other order would lose
 * messages instead, and losing a message is unrecoverable while replaying one is free.
 */
export async function setTelegramOffset(db: Executor, offset: number): Promise<void> {
  await db
    .insert(workerState)
    .values({ id: SINGLETON_ID, telegramOffset: offset })
    .onConflictDoUpdate({
      target: workerState.id,
      set: { telegramOffset: sql`excluded.telegram_offset`, updatedAt: sql`now()` },
    });
}

export interface SweepState {
  fingerprint: string | null;
  lastSweepAt: Date | null;
}

/** The previous sweep's candidate fingerprint, for the short-circuit. */
export async function getSweepState(db: Executor): Promise<SweepState> {
  const rows = await db
    .select({
      fingerprint: workerState.lastSweepFingerprint,
      lastSweepAt: workerState.lastSweepAt,
    })
    .from(workerState)
    .where(eq(workerState.id, SINGLETON_ID))
    .limit(1);
  return { fingerprint: rows[0]?.fingerprint ?? null, lastSweepAt: rows[0]?.lastSweepAt ?? null };
}

/** Records what the sweep saw, so an unchanged register costs nothing next time. */
export async function setSweepState(
  db: Executor,
  fingerprint: string,
  at: Date = new Date(),
): Promise<void> {
  await db
    .insert(workerState)
    .values({ id: SINGLETON_ID, lastSweepFingerprint: fingerprint, lastSweepAt: at })
    .onConflictDoUpdate({
      target: workerState.id,
      set: {
        lastSweepFingerprint: sql`excluded.last_sweep_fingerprint`,
        lastSweepAt: sql`excluded.last_sweep_at`,
        updatedAt: sql`now()`,
      },
    });
}
