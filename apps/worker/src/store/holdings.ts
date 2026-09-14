/**
 * `holdings` — append-only history. `[F13]`
 *
 * **Nothing here is ever overwritten.** A transfer closes one row by setting
 * `released_at` and opens another. That is what keeps "who held the van keys in March"
 * answerable, and it is also what lets a finding tell a clean handover from a genuine
 * gap: an asset with no current holder may have had one last month, and only the closed
 * row says so.
 *
 * **The decision is driven by what happened to the *fact*, not by comparing holders.**
 * `applyFact` has already worked out whether a claim restated, contradicted or ended
 * what the register held, using the value signature. Re-deriving that here from holder
 * equality would be a second, weaker copy of the same judgment — and the two would
 * disagree eventually. So:
 *
 *   | Fact outcome | Holding                                            |
 *   | ------------ | -------------------------------------------------- |
 *   | `inserted`   | open a new holding                                 |
 *   | `merged`     | nothing — the same claim, said again                |
 *   | `superseded` | close the holdings the old fact opened, open a new one |
 *   | `retired`    | close them, and open nothing                       |
 *
 * **A known limitation, stated rather than hidden.** Two people holding one asset at the
 * same time is representable in the schema — several active rows, and the detection
 * query counts them — but it is not reachable through extraction today. Both "Meera has
 * the login" and "Anil has the login" are holder claims about one asset, so they share a
 * `match_key`, and the second reads as a transfer. The Curator returns no additive
 * signal that would distinguish "also has" from "has instead", and inventing one from
 * phrasing would guess wrong about who controls things. The gap is in extraction, not
 * storage: a co-holder recorded by any other route works correctly throughout.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { HolderResolution } from "../pipeline/entities.js";
import type { FactOutcome } from "./facts.js";
import type { Executor } from "./types.js";

const { holdings } = schema;

export type HoldingOutcome = "opened" | "transferred" | "released" | "unchanged" | "skipped";

export interface AppliedHolding {
  outcome: HoldingOutcome;
  /** The now-current holding, or null when nothing is held. */
  holdingId: string | null;
  /** Rows closed by this change, so a transfer is visible in the trace. */
  closedHoldingIds: string[];
  reason: string;
}

export interface ApplyHoldingInput {
  /** Null for a claim about no particular thing, which cannot be held. */
  assetId: string | null;
  holder: HolderResolution;
  /** What `applyFact` decided. This is what drives the branch. */
  factOutcome: FactOutcome;
  /** The current fact, which becomes this holding's evidence. */
  factId: string | null;
  /** Set when the fact superseded another; its holdings are the ones to close. */
  supersededFactId?: string | undefined;
  /** The message's own timestamp. Acquisition and release are dated by it, never by now. */
  at: Date;
}

/** Closes rows, dating the release from the message that reported the change. */
async function closeHoldings(db: Executor, holdingIds: readonly string[], at: Date): Promise<void> {
  if (holdingIds.length === 0) return;
  await db
    .update(holdings)
    .set({ status: "released", releasedAt: at })
    .where(inArray(holdings.id, [...holdingIds]));
}

/** The open holdings a given fact opened. */
async function activeHoldingsForFact(db: Executor, factId: string): Promise<string[]> {
  const rows = await db
    .select({ id: holdings.id })
    .from(holdings)
    .where(and(eq(holdings.evidenceFactId, factId), eq(holdings.status, "active")));
  return rows.map((row) => row.id);
}

/**
 * Applies a holder claim to the holdings history.
 *
 * Returns `skipped` rather than guessing whenever the claim does not settle who holds
 * what: no asset, or a holder the Cartographer could not identify. An unresolved holder
 * becomes a clarification question elsewhere; writing a holding for it would be a coin
 * flip, and a wrong guess about who holds financial control is invisible once written.
 */
export async function applyHolding(
  db: Executor,
  { assetId, holder, factOutcome, factId, supersededFactId, at }: ApplyHoldingInput,
): Promise<AppliedHolding> {
  const nothing = (reason: string): AppliedHolding => ({
    outcome: "skipped",
    holdingId: null,
    closedHoldingIds: [],
    reason,
  });

  if (assetId === null) return nothing("The claim names no asset, so there is nothing to hold.");

  // ── The arrangement ended ──────────────────────────────────────────────────
  if (factOutcome === "retired") {
    if (factId === null) return nothing("Nothing was retired.");
    const closing = await activeHoldingsForFact(db, factId);
    await closeHoldings(db, closing, at);
    return {
      outcome: closing.length > 0 ? "released" : "skipped",
      holdingId: null,
      closedHoldingIds: closing,
      reason:
        closing.length > 0
          ? "The arrangement ended, so the holding is closed rather than deleted."
          : "The arrangement ended, but no holding was open for it.",
    };
  }

  if (holder.kind === "unresolved") {
    return nothing(`The holder could not be identified (${holder.reason}), so nothing is claimed.`);
  }
  if (holder.kind === "none") {
    return nothing("The claim names no holder.");
  }

  // ── The same claim, said again ─────────────────────────────────────────────
  if (factOutcome === "merged") {
    // Holdings carry no confirmation date — a restatement changes nothing about who
    // holds what, and touching `acquired_at` would rewrite when they got it.
    const existing = factId === null ? [] : await activeHoldingsForFact(db, factId);
    return {
      outcome: "unchanged",
      holdingId: existing[0] ?? null,
      closedHoldingIds: [],
      reason: "The same holder, stated again.",
    };
  }

  if (factOutcome === "skipped") return nothing("The fact layer recorded nothing.");
  if (factId === null) return nothing("No fact to attach the holding to.");

  // ── A transfer, or a first record ──────────────────────────────────────────
  const closing =
    supersededFactId === undefined ? [] : await activeHoldingsForFact(db, supersededFactId);
  await closeHoldings(db, closing, at);

  const inserted = await db
    .insert(holdings)
    .values({
      assetId,
      holderPersonId: holder.kind === "person" ? holder.personId : null,
      holderExternal: holder.kind === "external" ? holder.name : null,
      isPersonalResource: holder.isPersonalResource,
      acquiredAt: at,
      status: "active",
      evidenceFactId: factId,
    })
    .returning({ id: holdings.id });

  const holdingId = inserted[0]?.id;
  if (holdingId === undefined) throw new Error(`Failed to open a holding for asset ${assetId}`);

  return {
    outcome: closing.length > 0 ? "transferred" : "opened",
    holdingId,
    closedHoldingIds: closing,
    reason:
      closing.length > 0
        ? "The asset changed hands: the previous holding is closed, not overwritten."
        : "First record of who holds this.",
  };
}

/**
 * Closes every open holding for a person.
 *
 * Deliberately **not** called when someone leaves the group. A departure is precisely
 * when the register must still say what they held — that is the entire content of a
 * departure brief. Provided for the admin UI, where a coordinator can record that a
 * handover actually happened.
 */
export async function releaseHoldingsForPerson(
  db: Executor,
  personId: string,
  at: Date,
): Promise<number> {
  const rows = await db
    .update(holdings)
    .set({ status: "released", releasedAt: at })
    .where(and(eq(holdings.holderPersonId, personId), eq(holdings.status, "active")))
    .returning({ id: holdings.id });
  return rows.length;
}

/** How many people currently hold an asset. Zero is the no-owner finding. */
export async function countActiveHolders(db: Executor, assetId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(holdings)
    .where(
      and(
        eq(holdings.assetId, assetId),
        eq(holdings.status, "active"),
        // A row with no holder at all is not a holder; it is the absence of one.
        sql`(${holdings.holderPersonId} is not null or ${holdings.holderExternal} is not null)`,
      ),
    );
  return Number(rows[0]?.count ?? 0);
}

/** Open holdings with no holder recorded — the shape a no-owner claim leaves. */
export async function countUnownedHoldings(db: Executor, assetId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(holdings)
    .where(
      and(
        eq(holdings.assetId, assetId),
        eq(holdings.status, "active"),
        isNull(holdings.holderPersonId),
        isNull(holdings.holderExternal),
      ),
    );
  return Number(rows[0]?.count ?? 0);
}
