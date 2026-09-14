/**
 * `capability_coverage` — who has been *seen* doing what. `[F14]`
 *
 * **This table is where the product's privacy guarantee is either kept or broken.** It
 * records that someone was observed taking part, and deliberately records nothing about
 * how often or how well. There is no count, no rate, no ranking, and no attendance row
 * for any of those to be aggregated from — the schema has nowhere to put them, which is
 * why the guarantee survives a careless prompt or a late feature.
 *
 * What it does keep is a first and last observation and the messages behind them. That is
 * enough for the one question the register asks: has anybody *else* been seen doing this?
 *
 * The observation constraint is binding and it is a constraint on *phrasing* downstream:
 * Baton may say no other volunteer has been seen doing something. It may never say no one
 * else *can*. This table cannot tell the difference, so nothing here should ever be read
 * as capability.
 */

import { and, eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { Executor } from "./types.js";

const { capabilityCoverage } = schema;

export interface AppliedCoverage {
  /** People newly observed in this capability. */
  added: number;
  /** People already known to have taken part, whose observation window widened. */
  widened: number;
}

export interface ApplyCoverageInput {
  capabilityId: string;
  /** Everyone the message named as taking part. Unidentifiable mentions are absent. */
  personIds: readonly string[];
  /** The message's own timestamp: when they were observed. */
  observedAt: Date;
  messageId: string;
}

/**
 * Records participation.
 *
 * Upserts on `(capability_id, person_id)`, which is the unique index the schema declares
 * — so a person seen ten times has exactly one row, and the register genuinely cannot say
 * how many times that was.
 *
 * `least`/`greatest` widen the observation window in whichever direction the message
 * falls, because backfill replays six months and a message arriving out of order must not
 * narrow it.
 */
export async function applyCoverage(
  db: Executor,
  { capabilityId, personIds, observedAt, messageId }: ApplyCoverageInput,
): Promise<AppliedCoverage> {
  let added = 0;
  let widened = 0;

  for (const personId of personIds) {
    const rows = await db
      .insert(capabilityCoverage)
      .values({
        capabilityId,
        personId,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidenceMessageIds: [messageId],
      })
      .onConflictDoUpdate({
        target: [capabilityCoverage.capabilityId, capabilityCoverage.personId],
        set: {
          firstObservedAt: sql`least(${capabilityCoverage.firstObservedAt}, excluded.first_observed_at)`,
          lastObservedAt: sql`greatest(${capabilityCoverage.lastObservedAt}, excluded.last_observed_at)`,
          // Appended once, never replaced. Provenance accumulates; the count of
          // observations does not become a number anyone can read as a score.
          evidenceMessageIds: sql`case
            when ${capabilityCoverage.evidenceMessageIds} @> to_jsonb(array[${messageId}::text])
              then ${capabilityCoverage.evidenceMessageIds}
            else ${capabilityCoverage.evidenceMessageIds} || to_jsonb(array[${messageId}::text])
          end`,
        },
      })
      .returning({ id: capabilityCoverage.id, created: sql<boolean>`(xmax = 0)` });

    const row = rows[0];
    if (row === undefined) continue;
    if (row.created) added += 1;
    else widened += 1;
  }

  return { added, widened };
}

/**
 * How many people have been observed in a capability.
 *
 * Exactly one is the capability variant of `sole_holder` — the same problem to a
 * coordinator as an asset with a single holder, which is why both render under one
 * subtype and are told apart by `findings.type`.
 */
export async function countObservedPeople(db: Executor, capabilityId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(capabilityCoverage)
    .where(eq(capabilityCoverage.capabilityId, capabilityId));
  return Number(rows[0]?.count ?? 0);
}

/** Whether a specific person has been observed in a capability. */
export async function hasBeenObserved(
  db: Executor,
  capabilityId: string,
  personId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: capabilityCoverage.id })
    .from(capabilityCoverage)
    .where(
      and(
        eq(capabilityCoverage.capabilityId, capabilityId),
        eq(capabilityCoverage.personId, personId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
