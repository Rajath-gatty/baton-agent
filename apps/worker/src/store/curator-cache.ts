/**
 * The curator cache. `[F11]`
 *
 * Keyed on `(content_hash, prompt_version)` and holding the Curator's whole validated
 * result for one message. Built on day one rather than as a later optimisation,
 * because it makes re-running a six-month backfill free and fast, and iteration speed
 * on six prompts matters more than the money saved.
 *
 * Three properties make it sound, and each is a constraint on something else:
 *
 *   - **The hash is over the exact text**, with no whitespace normalisation, so any
 *     edit misses the cache and re-curates. That is the correct default: an edit
 *     means the derived facts came from text that no longer exists.
 *   - **Each message is classified independently.** The Curator prompt forbids
 *     cross-message inference, which is what lets a result cached from one batch be
 *     reused in a batch of entirely different neighbours. Batches are formed from
 *     misses only, so their composition changes on every run.
 *   - **The result is per message, not per batch.** A batch of ten with nine hits
 *     costs one message's worth of model work, not ten.
 *
 * What the cache deliberately does **not** hold is the Cartographer's attributions.
 * Those depend on the alias table as it stands at call time — a mention that was
 * ambiguous in March resolves cleanly in September once the alias was learned — and
 * caching them against message content would freeze an identity decision that is
 * supposed to improve. The worker therefore re-attributes cached records itself,
 * deterministically, against the current alias table.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { curatorMessageResultSchema, type CuratorMessageResult } from "@baton/core";
import type { Executor } from "./types.js";

const { curatorCache } = schema;

export interface CachedCuratorResult {
  contentHash: string;
  /**
   * The stored result. **Its `messageId` is the id of whichever message was curated
   * first for this content**, which is not necessarily the message being processed
   * now — two identical messages share a hash. Callers must rebind it.
   */
  result: CuratorMessageResult;
}

/**
 * Looks up cached results for a set of content hashes at one prompt version.
 *
 * Returns a map keyed by content hash rather than a list, because the caller's next
 * move is always "did this particular message hit", and because two messages in the
 * same batch can share a hash — "thanks!" twice — which a list would represent twice
 * and a map represents once.
 *
 * A row whose stored JSON no longer validates is treated as a miss rather than an
 * error. That is what makes a schema change survivable: the shape of
 * `curatorMessageResultSchema` can gain a required field without a migration, and the
 * cost is a re-curation rather than a crashed pass.
 */
export async function lookupCuratorCache(
  db: Executor,
  contentHashes: readonly string[],
  promptVersion: number,
): Promise<Map<string, CuratorMessageResult>> {
  const hits = new Map<string, CuratorMessageResult>();
  const unique = [...new Set(contentHashes)];
  if (unique.length === 0) return hits;

  const rows = await db
    .select({ contentHash: curatorCache.contentHash, result: curatorCache.result })
    .from(curatorCache)
    .where(
      and(inArray(curatorCache.contentHash, unique), eq(curatorCache.promptVersion, promptVersion)),
    );

  for (const row of rows) {
    const parsed = curatorMessageResultSchema.safeParse(row.result);
    if (!parsed.success) continue;
    hits.set(row.contentHash, parsed.data);
  }

  return hits;
}

export interface CuratorCacheEntry {
  contentHash: string;
  result: CuratorMessageResult;
}

/**
 * Stores results, one row per message.
 *
 * `classification` is lifted out of the result into its own column so "how much of six
 * months was noise" is one query rather than a jsonb scan — the single number that
 * says whether the pre-filter and the Curator agree with each other.
 *
 * On conflict the row is left alone. A hit for the same key is by definition the same
 * classification of the same text by the same prompt, so rewriting it would only move
 * `created_at` and lose the record of when the answer was first paid for.
 */
export async function storeCuratorCache(
  db: Executor,
  entries: readonly CuratorCacheEntry[],
  promptVersion: number,
): Promise<number> {
  // De-duplicated on the way in: two identical messages in one batch produce two
  // entries with one key, and Postgres rejects a statement that touches the same row
  // twice in a single ON CONFLICT insert.
  const byHash = new Map<string, CuratorMessageResult>();
  for (const entry of entries) {
    if (!byHash.has(entry.contentHash)) byHash.set(entry.contentHash, entry.result);
  }
  if (byHash.size === 0) return 0;

  const rows = await db
    .insert(curatorCache)
    .values(
      [...byHash].map(([contentHash, result]) => ({
        contentHash,
        promptVersion,
        result,
        classification: result.classification,
      })),
    )
    .onConflictDoNothing({ target: [curatorCache.contentHash, curatorCache.promptVersion] })
    .returning({ contentHash: curatorCache.contentHash });

  return rows.length;
}

/**
 * Rebinds a cached result to the message being processed now.
 *
 * The stored `messageId` is whichever message was curated first for this content.
 * Reusing it verbatim would attribute every record to that first message — the
 * provenance link the UI renders, the `statedAt` the fact is dated by, and the
 * evidence array all point at the wrong row. Two identical "thanks Priya!" messages
 * six months apart is enough to trigger it.
 *
 * A separate function rather than an inline spread so there is one place to look when
 * asking whether the rebinding happens, and one place for a test to name.
 */
export function rebindCachedResult(
  result: CuratorMessageResult,
  messageId: string,
): CuratorMessageResult {
  return { ...result, messageId };
}

/** How many cache rows exist at a prompt version. For the activity panel and tests. */
export async function countCuratorCache(db: Executor, promptVersion: number): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(curatorCache)
    .where(eq(curatorCache.promptVersion, promptVersion));
  return Number(rows[0]?.count ?? 0);
}
