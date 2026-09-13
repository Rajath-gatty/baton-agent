"use server";

/**
 * The register's write seam.
 *
 * These three actions are the only way a coordinator changes a finding's state:
 * resolve it (the exposure has been addressed), record that a backup already
 * exists (so the finding was never a real single-coverage), or dismiss it (not
 * worth carrying). They are the counterpart to the read seam in `lib/data.ts` —
 * every write goes through here so the persistence swap is contained to one
 * file, exactly as every read goes through one file.
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
 * `dismissed`, where it remains visible on /dismissed rather than deleted, so a
 * dismissal can always be traced and reversed.
 */
export async function dismissFinding(findingId: string): Promise<FindingActionResult> {
  // SEAM: persist status → "dismissed" with a dismissal reason.
  revalidatePath("/");
  return { status: "ok", findingId, to: "dismissed" };
}
