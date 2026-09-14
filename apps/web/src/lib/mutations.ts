/**
 * The register's writes.
 *
 * **The architectural decision this file records, because it was open until now:
 * the admin UI writes to Postgres directly.** The alternative was POSTing to the
 * worker so the register's invariants stayed in one owner, and it was rejected for
 * a specific reason rather than for convenience:
 *
 *   - The worker's only HTTP surface is the token-authenticated `/data/*` API, and
 *     that token is held by the **agent**. Adding write routes behind it would give
 *     the agent a write path, which is the one property the whole split exists to
 *     prevent — the agent holds no credentials and writes nothing. A second router
 *     with a second token would be two auth surfaces on a public domain to save one
 *     process a database connection it already has.
 *   - There is no invariant here for the worker to protect. Every column below is
 *     one only a coordinator writes: `findings.status` toward resolved or dismissed
 *     (the sweep's upsert already refuses to touch a dismissed row, so a dismissal
 *     survives a re-derivation by design), `messages.is_withdrawn` (set *only* by
 *     this action — Telegram never reports a deletion), `brief_lines.assigned_*`,
 *     and a fact's own status. The two writers do not race for a row.
 *
 * What does stay with the worker is anything that has to *leave* the VM: the
 * outbound Telegram queue lives there, so nothing in this file sends a message.
 * That is not a limitation to work around — see `fileBriefLine`, where the silence
 * is the product promise.
 *
 * This module is deliberately free of Next imports so it can be tested against a
 * real database without a server. `app/actions.ts` is the thin server-action
 * wrapper that adds `revalidatePath`.
 */

import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { valueSignature } from "@baton/core";
import { schema } from "@baton/core/db";
import type { Database } from "@baton/core/db";
import { getDb } from "./db";
import { getCoordinatorPersonId } from "./data";

const { briefLines, briefs, facts, findings, holdings, messages } = schema;

/** What every write reports back. Callers render their own error inline. */
export type WriteResult = { ok: true } | { ok: false; message: string };

const OK: WriteResult = { ok: true };

/** The reason recorded when a finding closes because a backup already exists. */
export const HAS_BACKUP_REASON = "We already have a backup for this.";

/** The reason recorded when a coordinator simply puts a finding down. */
export const DISMISSED_REASON = "Judged not worth carrying.";

// ── findings ────────────────────────────────────────────────────────────────

/**
 * Closes a finding.
 *
 * Only an open finding can be closed, which is what makes the button idempotent
 * under a double press: the second update matches nothing and reports that the
 * exposure is no longer open rather than rewriting a timestamp.
 *
 * A resolved finding is **not** the end of the story, and that is correct: if the
 * condition is still there on the next sweep, the worker's upsert reopens it and
 * clears `resolved_at`. Resolving says "I have dealt with this", and the register
 * is entitled to disagree next time it looks. Dismissal is the permanent one.
 */
async function closeFinding(
  db: Database,
  findingId: string,
  reason: string | null,
  at: Date,
): Promise<WriteResult> {
  const rows = await db
    .update(findings)
    .set({
      status: "resolved",
      resolvedAt: at,
      // The only column the schema keeps for a closing reason. "We already have a
      // backup" and "not a problem" are different statements and both are worth
      // reading later, which is why it is recorded at all.
      ...(reason === null ? {} : { dismissalReason: reason }),
    })
    .where(and(eq(findings.id, findingId), eq(findings.status, "open")))
    .returning({ id: findings.id });

  return rows.length > 0
    ? OK
    : { ok: false, message: "That exposure is no longer open — reload to see the register." };
}

/** Resolve: the exposure has been addressed. */
export async function resolveFinding(findingId: string, at = new Date()): Promise<WriteResult> {
  return closeFinding(getDb(), findingId, null, at);
}

/**
 * Record that a backup already exists.
 *
 * Not a dismissal of judgement but a correction of fact — the capability was never
 * single-covered — so it closes as resolved, with the reason kept.
 */
export async function markHasBackup(findingId: string, at = new Date()): Promise<WriteResult> {
  return closeFinding(getDb(), findingId, HAS_BACKUP_REASON, at);
}

/**
 * Dismiss a finding: the coordinator judges it not worth carrying.
 *
 * **Permanent by design.** Dismissed keys are dropped before the Assessor sees
 * them and the sweep's upsert refuses to update a dismissed row, so this decision
 * survives every later re-derivation. The row stays visible in the set-aside list
 * with its reason, because hiding must stay distinguishable from forgetting.
 */
export async function dismissFinding(
  findingId: string,
  reason: string = DISMISSED_REASON,
  at = new Date(),
): Promise<WriteResult> {
  const rows = await getDb()
    .update(findings)
    .set({ status: "dismissed", dismissalReason: reason, dismissedAt: at })
    .where(and(eq(findings.id, findingId), eq(findings.status, "open")))
    .returning({ id: findings.id });

  return rows.length > 0
    ? OK
    : { ok: false, message: "That exposure is no longer open — reload to see the register." };
}

// ── provenance ──────────────────────────────────────────────────────────────

/**
 * Withdraw a claim's provenance.
 *
 * Telegram reports no deletions, so a volunteer who deletes a message leaves Baton
 * still quoting it. This is the coordinator's only remedy, and it is deliberately
 * narrow: `messages.is_withdrawn` is set on the quoted message, and the fact, its
 * status, its supersession chain and the run that recorded it are all untouched.
 * Deleting the fact would be the larger lie — the register would then claim it
 * never knew something it did.
 *
 * The withdrawal travels: the worker's `/data` API already refuses to return a
 * withdrawn message as evidence, so the quote stops reaching the agent as well as
 * the browser.
 */
export async function withdrawProvenance(factId: string, at = new Date()): Promise<WriteResult> {
  const db = getDb();

  const factRows = await db
    .select({ sourceMessageId: facts.sourceMessageId })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);

  const sourceMessageId = factRows[0]?.sourceMessageId;
  if (sourceMessageId === undefined) {
    return { ok: false, message: "That claim is not in the register." };
  }

  await db
    .update(messages)
    .set({ isWithdrawn: true, withdrawnAt: at })
    .where(and(eq(messages.id, sourceMessageId), eq(messages.isWithdrawn, false)));

  return OK;
}

// ── facts ───────────────────────────────────────────────────────────────────

/**
 * Retire a claim: the arrangement it describes has ended.
 *
 * No replacement row, which is what distinguishes this from a correction — the
 * claim stops being true and nothing takes its place. The row itself stays, so the
 * record of what the group once knew is intact, and detection stops seeing it
 * because only `active` is visible there.
 */
export async function retireFact(factId: string, at = new Date()): Promise<WriteResult> {
  const rows = await getDb()
    .update(facts)
    .set({ status: "retired", retiredAt: at })
    .where(and(eq(facts.id, factId), inArray(facts.status, ["active", "unverified"])))
    .returning({ id: facts.id });

  return rows.length > 0
    ? OK
    : { ok: false, message: "Only a standing or unverified claim can be retired." };
}

/**
 * Mark an unverified claim verified.
 *
 * A human agreeing is the strongest provenance any claim in the register has, so
 * `verified_at` is stamped and the claim becomes `active` — which is the moment it
 * becomes visible to detection.
 *
 * **Narrower than it looks, deliberately: this does not approve a pending change.**
 * A claim held at `pending_approval` belongs to the approval gate, which resolves
 * by the coordinator answering the question in Telegram so the agent can be resumed
 * from its snapshot. Adopting it here would leave that snapshot open forever and
 * bypass the check that the answerer is permitted.
 */
export async function markFactVerified(factId: string, at = new Date()): Promise<WriteResult> {
  const rows = await getDb()
    .update(facts)
    .set({ status: "active", verifiedAt: at })
    .where(and(eq(facts.id, factId), eq(facts.status, "unverified")))
    .returning({ id: facts.id });

  return rows.length > 0
    ? OK
    : {
        ok: false,
        message:
          "Only an unverified claim can be confirmed here. An approval is answered in the group chat.",
      };
}

/**
 * Correct a claim's wording or value.
 *
 * Modelled exactly as the worker models a contradiction, because that is what a
 * correction is: a **new row** carrying the corrected claim, with
 * `supersedes_fact_id` pointing at the old one, and the old one moved to
 * `superseded`. Nothing is overwritten, so "what did the register say before the
 * coordinator fixed it" stays answerable — and the fact panel's chain renders the
 * correction as the history it is.
 *
 * Three details that keep the new row consistent with the ones the pipeline writes:
 *
 *   - `match_key` is **inherited**, not rebuilt. The subject and the aspect have
 *     not changed — this is the same claim, said correctly — and a rebuilt key
 *     would move the row into a different group, where a later restatement of the
 *     old wording would fail to merge and would look like a fresh fact.
 *   - `value_signature` is recomputed with core's own function, from the corrected
 *     text and the holder the register currently records. A stale signature would
 *     make the next restatement of the *corrected* value look like a contradiction.
 *   - Provenance stays on the original message. The correction is the
 *     coordinator's, and it is recorded as such in the reasoning rather than
 *     attributed to whoever happened to send the message.
 */
export async function correctFact(
  factId: string,
  correctedClaim: string,
  at = new Date(),
): Promise<WriteResult> {
  const claim = correctedClaim.trim();
  if (claim === "") return { ok: false, message: "A correction needs some text." };

  const db = getDb();

  const rows = await db
    .select({
      id: facts.id,
      assetId: facts.assetId,
      claim: facts.claim,
      matchKey: facts.matchKey,
      confidence: facts.confidence,
      status: facts.status,
      sensitivity: facts.sensitivity,
      sourceMessageId: facts.sourceMessageId,
      statedByPersonId: facts.statedByPersonId,
      statedAt: facts.statedAt,
      evidenceMessageIds: facts.evidenceMessageIds,
    })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);

  const existing = rows[0];
  if (existing === undefined) return { ok: false, message: "That claim is not in the register." };
  if (existing.status === "superseded" || existing.status === "retired") {
    return { ok: false, message: "That claim is already history — correct the one that replaced it." };
  }
  if (existing.claim.trim() === claim) return OK;

  // The holder the claim is currently signed by, so the new signature is built the
  // same way `applyFact` builds one: a holder claim is signed by who holds the
  // thing, and `facts` deliberately keeps no holder column.
  const holderRows =
    existing.assetId === null
      ? []
      : await db
          .select({ personId: holdings.holderPersonId, external: holdings.holderExternal })
          .from(holdings)
          .where(and(eq(holdings.assetId, existing.assetId), eq(holdings.status, "active")))
          .limit(1);
  const holder = holderRows[0]?.personId ?? holderRows[0]?.external ?? null;

  const previousClaim = existing.claim;

  await db.transaction(async (tx) => {
    await tx.insert(facts).values({
      assetId: existing.assetId,
      claim,
      matchKey: existing.matchKey,
      valueSignature: valueSignature({ holder, claim }),
      // A human wrote this, which is the strongest provenance the register has —
      // hence full confidence and a verification stamp on the same row.
      confidence: 1,
      status: "active",
      sensitivity: existing.sensitivity,
      sourceMessageId: existing.sourceMessageId,
      statedByPersonId: existing.statedByPersonId,
      statedAt: existing.statedAt,
      lastConfirmedAt: at,
      evidenceMessageIds: existing.evidenceMessageIds,
      supersedesFactId: existing.id,
      curatorReasoning: `Corrected by the coordinator in the admin UI. The claim it replaced read: “${previousClaim}”`,
      verifiedAt: at,
    });

    await tx.update(facts).set({ status: "superseded" }).where(eq(facts.id, existing.id));
  });

  return OK;
}

// ── briefs ──────────────────────────────────────────────────────────────────

/**
 * File a brief line as a record.
 *
 * **The silence is the feature.** Filing writes `assigned_to_person_id` and
 * `assigned_at` and sends nothing — no group message, no direct message, nothing
 * queued. It lives in this module rather than in the client island so the promise
 * is kept by the write path and not by a component that could later grow a
 * notification call. Nothing in this file can send a Telegram message: the outbound
 * queue is in the worker, and this process has no route to it.
 *
 * Filed *against the coordinator*, because there is exactly one human user of the
 * admin UI and the assignment records who has taken the line on. Where no
 * coordinator is on record — reachable for real, if the coordinator is the person
 * who left — it says so rather than filing against nobody.
 */
export async function fileBriefLine(lineId: string, at = new Date()): Promise<WriteResult> {
  const coordinatorPersonId = await getCoordinatorPersonId();
  if (coordinatorPersonId === null) {
    return {
      ok: false,
      message:
        "No coordinator is on record, so there is nobody to file this against. Set one before filing.",
    };
  }

  const rows = await getDb()
    .update(briefLines)
    .set({ assignedToPersonId: coordinatorPersonId, assignedAt: at })
    .where(eq(briefLines.id, lineId))
    .returning({ id: briefLines.id });

  return rows.length > 0 ? OK : { ok: false, message: "That brief line is no longer on record." };
}

/** Marks a brief read, which is what clears the unread banner. */
export async function markBriefRead(briefId: string, at = new Date()): Promise<WriteResult> {
  const rows = await getDb()
    .update(briefs)
    .set({ readAt: at })
    .where(and(eq(briefs.id, briefId), isNull(briefs.readAt)))
    .returning({ id: briefs.id });

  return rows.length > 0 ? OK : { ok: false, message: "That brief was already read." };
}
