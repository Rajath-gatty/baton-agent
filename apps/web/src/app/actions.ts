"use server";

/**
 * The register's write seam — the server actions the UI calls.
 *
 * Thin on purpose. Each function is a mutation from `lib/mutations.ts`, a
 * `revalidatePath("/")` so the one page re-reads, and the shape the calling
 * component renders. The decision-carrying code and every SQL statement live in
 * that module instead, for one reason: a `"use server"` module cannot be imported
 * outside Next, so writes kept in here could never be tested against a real
 * database. `test/register.test.ts` drives the mutations directly.
 *
 * **The architectural decision these stubs were waiting on has been taken: the
 * admin UI writes to Postgres directly.** The reasoning is recorded in
 * `lib/mutations.ts`, where the writes are — briefly, adding write routes to the
 * worker's data API would hand a write path to the bearer token the *agent* holds,
 * and there is no invariant here for the worker to protect, because every column
 * these actions touch is one only a coordinator writes.
 *
 * The one write that does not live here is sending. Nothing in the web app can put
 * a message on Telegram: the outbound queue and the bot token are the worker's. For
 * filing a brief line that is not a limitation but the promise itself — a
 * continuity record must never ping twenty people.
 */

import { revalidatePath } from "next/cache";
import type { FindingStatus } from "@baton/core";
import * as db from "@/lib/mutations";

/** What a write attempt reports back, so a caller can render its own error. */
export type FindingActionResult =
  | { status: "ok"; findingId: string; to: FindingStatus }
  | { status: "error"; findingId: string; message: string };

/** What a fact-level or brief-level write reports back. */
export type RecordActionResult = { status: "ok" } | { status: "error"; message: string };

/**
 * Re-read the one page.
 *
 * Every action calls this, including the failing ones: a write that failed because
 * the row had already moved on is exactly the case where the coordinator is looking
 * at a stale register and should be shown the current one.
 */
function reread(): void {
  revalidatePath("/");
}

function finding(
  result: db.WriteResult,
  findingId: string,
  to: FindingStatus,
): FindingActionResult {
  reread();
  return result.ok
    ? { status: "ok", findingId, to }
    : { status: "error", findingId, message: result.message };
}

function record(result: db.WriteResult): RecordActionResult {
  reread();
  return result.ok ? { status: "ok" } : { status: "error", message: result.message };
}

/**
 * Resolve a finding: the exposure it named has been addressed. Moves the
 * finding to `resolved` and drops it out of the open register.
 */
export async function resolveFinding(findingId: string): Promise<FindingActionResult> {
  return finding(await db.resolveFinding(findingId), findingId, "resolved");
}

/**
 * Record that a backup already exists for what a finding named. This is not a
 * dismissal of judgement but a correction of fact: the capability was never
 * single-covered, so the finding closes as `resolved` with that reason.
 */
export async function markHasBackup(findingId: string): Promise<FindingActionResult> {
  return finding(await db.markHasBackup(findingId), findingId, "resolved");
}

/**
 * Dismiss a finding: the coordinator judges it not worth carrying. Moves it to
 * `dismissed`, where it stays visible in the set-aside list at the foot of the
 * page rather than deleted, so a dismissal can always be traced — and where the
 * worker's sweep will not reopen it, because dismissal is permanent.
 */
export async function dismissFinding(findingId: string): Promise<FindingActionResult> {
  return finding(await db.dismissFinding(findingId), findingId, "dismissed");
}

/**
 * Withdraw a claim's provenance [F4].
 *
 * Telegram reports no deletions, so a volunteer who deletes a message leaves
 * Baton still quoting it in front of whoever opens the fact panel. This is the
 * coordinator's only remedy, and it is deliberately narrow: the quote stops being
 * shown, and the fact, its status, its supersession chain and the run that
 * recorded it all stay exactly as they were. Deleting the fact would be the
 * larger lie — the register would then claim it never knew something it did.
 */
export async function withdrawProvenance(factId: string): Promise<RecordActionResult> {
  return record(await db.withdrawProvenance(factId));
}

/** Retire a claim: the arrangement it describes has ended, and nothing replaces it. */
export async function retireFact(factId: string): Promise<RecordActionResult> {
  return record(await db.retireFact(factId));
}

/**
 * Confirm an unverified claim. A human agreeing is the strongest provenance the
 * register has, and it is the moment the claim becomes visible to detection.
 */
export async function markFactVerified(factId: string): Promise<RecordActionResult> {
  return record(await db.markFactVerified(factId));
}

/**
 * Correct a claim's wording. Writes a new fact that supersedes the old one rather
 * than editing it, so the register keeps what it used to say.
 */
export async function correctFact(
  factId: string,
  correctedClaim: string,
): Promise<RecordActionResult> {
  return record(await db.correctFact(factId, correctedClaim));
}

/**
 * File a brief line as a record.
 *
 * The silence is the feature: filing a continuity record must never ping twenty
 * people, so this writes and sends nothing.
 */
export async function fileBriefLine(lineId: string): Promise<RecordActionResult> {
  return record(await db.fileBriefLine(lineId));
}

/** Mark a brief read, which clears the unread banner on the continuity stop. */
export async function markBriefRead(briefId: string): Promise<RecordActionResult> {
  return record(await db.markBriefRead(briefId));
}
