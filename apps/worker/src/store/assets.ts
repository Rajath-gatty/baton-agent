/**
 * `assets` and `capabilities`.
 *
 * Both are upserted on their normalised key rather than their name, so "The van" and
 * "van" are one thing. That normalisation is what `facts.match_key` is built from, and
 * without it every mention of the van keys becomes another active row.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { normaliseAssetKey } from "@baton/core";
import type { AssetKind, AssetSensitivity } from "@baton/core";
import type { Executor } from "./types.js";

const { assets, capabilities } = schema;

export interface UpsertResult {
  id: string;
  created: boolean;
}

export interface UpsertAssetInput {
  kind: AssetKind;
  /** As written, kept for display. The key is derived from it. */
  name: string;
  sensitivity?: AssetSensitivity;
}

/**
 * Upserts an asset on `(kind, normalised_key)`.
 *
 * **Sensitivity ratchets upward and never down.** It drives approval routing, so a
 * later record that happens to omit the flag must not quietly downgrade an asset —
 * that would send an approval about who controls the money to the group instead of
 * privately to the coordinator. Raising it is always safe; lowering it never is.
 */
export async function upsertAsset(
  db: Executor,
  { kind, name, sensitivity = "normal" }: UpsertAssetInput,
): Promise<UpsertResult> {
  const normalisedKey = normaliseAssetKey(name);

  const rows = await db
    .insert(assets)
    .values({ kind, name, normalisedKey, sensitivity })
    .onConflictDoUpdate({
      target: [assets.kind, assets.normalisedKey],
      set: {
        sensitivity: sql`case when excluded.sensitivity = 'sensitive' then 'sensitive'::asset_sensitivity else ${assets.sensitivity} end`,
      },
    })
    .returning({ id: assets.id, created: sql<boolean>`(xmax = 0)` });

  const row = rows[0];
  if (row === undefined) throw new Error(`Failed to upsert asset ${kind}:${name}`);
  return { id: row.id, created: row.created };
}

/** Upserts a capability on its normalised key. */
export async function upsertCapability(db: Executor, name: string): Promise<UpsertResult> {
  const normalisedKey = normaliseAssetKey(name);

  const rows = await db
    .insert(capabilities)
    .values({ name, normalisedKey })
    .onConflictDoUpdate({
      target: capabilities.normalisedKey,
      // Nothing worth changing, but a DO NOTHING would return no row and cost a
      // second round trip to find the id.
      set: { normalisedKey: sql`excluded.normalised_key` },
    })
    .returning({ id: capabilities.id, created: sql<boolean>`(xmax = 0)` });

  const row = rows[0];
  if (row === undefined) throw new Error(`Failed to upsert capability ${name}`);
  return { id: row.id, created: row.created };
}

/** Finds an asset by kind and name without creating one. */
export async function findAsset(
  db: Executor,
  kind: AssetKind,
  name: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.kind, kind), eq(assets.normalisedKey, normaliseAssetKey(name))))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Finds a capability by name without creating one. */
export async function findCapability(db: Executor, name: string): Promise<string | null> {
  const rows = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.normalisedKey, normaliseAssetKey(name)))
    .limit(1);
  return rows[0]?.id ?? null;
}
