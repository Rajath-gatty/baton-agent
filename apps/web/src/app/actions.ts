"use server";

/**
 * The register's write seam.
 *
 * These are the only ways a coordinator changes what the register holds: resolve
 * a finding (the exposure has been addressed), record that a backup already
 * exists (so the finding was never a real single-coverage), dismiss it (not worth
 * carrying), withdraw a claim's provenance (the quoted message is gone from
 * Telegram and Baton is not told), or file a brief line as a record. They are the
 * counterpart to the read seam in `lib/data.ts` — every write goes through here
 * so the persistence swap is contained to one file, exactly as every read goes
 * through one file.
 *
 * UNRESOLVED ARCHITECTURAL DECISION — do not silently pick one:
 * Whether the web app writes to Postgres directly (via `@baton/core/db`) or
 * POSTs to the worker (so the agent's own invariants — dedupe keys, the
 * detection-visibility rules, the audit trail on the run — are enforced in one
 * place) is not yet decided. Writing directly is simpler; going through the
 * worker keeps the register's rules in a single owner and avoids two writers
 * racing on the same row. These stubs are that seam: when the decision lands,
 * only the bodies below change, and they revalidate the continuity page so the
 * register re-reads. Signatures and the revalidate call stay put.
 */

import { revalidatePath } from "next/cache";
import type { FindingStatus } from "@baton/core";

/** What a write attempt reports back, so a caller can render its own error. */
export type FindingActionResult =
  | { status: "ok"; findingId: string; to: FindingStatus }
  | { status: "error"; findingId: string; message: string };

/**
 * Resolve a finding: the exposure it named has been addressed. Moves the
 * finding to `resolved` and drops it out of the open register.
 */
export async function resolveFinding(findingId: string): Promise<FindingActionResult> {
  // SEAM: persist status → "resolved" (Postgres write or worker POST, undecided).
  revalidatePath("/");
  return { status: "ok", findingId, to: "resolved" };
}

/**
 * Record that a backup already exists for what a finding named. This is not a
 * dismissal of judgement but a correction of fact: the capability was never
 * single-covered, so the finding closes as `resolved` with that reason.
 */
export async function markHasBackup(findingId: string): Promise<FindingActionResult> {
  // SEAM: persist status → "resolved", reason "we already have a backup".
  revalidatePath("/");
  return { status: "ok", findingId, to: "resolved" };
}

/**
 * Dismiss a finding: the coordinator judges it not worth carrying. Moves it to
 * `dismissed`, where it stays visible in the set-aside list at the foot of the
 * page rather than deleted, so a dismissal can always be traced and reversed.
 */
export async function dismissFinding(findingId: string): Promise<FindingActionResult> {
  // SEAM: persist status → "dismissed" with a dismissal reason.
  revalidatePath("/");
  return { status: "ok", findingId, to: "dismissed" };
}

/** What a fact-level or brief-level write reports back. */
export type RecordActionResult = { status: "ok" } | { status: "error"; message: string };

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
  // SEAM: persist facts.provenance_withdrawn = true for `factId`. Nothing else
  // changes; in particular the fact is neither retired nor deleted.
  void factId;
  revalidatePath("/");
  return { status: "ok" };
}

/**
 * File a brief line as a record.
 *
 * The silence is the feature: filing a continuity record must never ping twenty
 * people, so this writes and sends nothing. It lives in this file rather than in
 * the client island so that the promise is kept by the server seam and not by a
 * component that could later grow a notification call.
 */
export async function fileBriefLine(
  briefId: string,
  lineText: string,
): Promise<RecordActionResult> {
  // SEAM: persist the assignment against `brief_lines`. NO outbound message.
  void briefId;
  void lineText;
  revalidatePath("/");
  return { status: "ok" };
}
