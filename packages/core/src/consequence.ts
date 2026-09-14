/**
 * Consequence, and what a new claim's status should be. `[F31]`
 *
 * **Consequence is policy, not judgment, and is never asked of a model.** Whether a
 * write is high-consequence has a fixed answer — financial control, credentials and
 * named contacts for critical relationships always are — and letting a cheap model
 * decide would make the approval gate itself unreliable, which is the one thing that
 * must not be. The model supplies confidence; this supplies consequence; the matrix
 * below combines them.
 *
 * |                      | High confidence        | Low confidence               |
 * | -------------------- | ---------------------- | ---------------------------- |
 * | **High consequence** | Act, and record it     | **Stop and ask for approval** |
 * | **Low consequence**  | Act silently           | Record as unverified, do not ask |
 *
 * The bottom-right cell matters as much as the top-right. An agent that escalates
 * everything it is unsure about becomes noise and gets muted, so low-consequence
 * uncertainty is recorded as unverified rather than raised. Asking is rationed
 * precisely so that being asked means something.
 */

import type { AssetKind, AssetSensitivity, ConsequenceLevel, FactStatus } from "./constants.js";

/**
 * Asset kinds that are always high-consequence, whatever their sensitivity flag says.
 *
 * Financial control is self-evident. Logins are here because a credential is the one
 * thing whose holder being wrong is both invisible and immediately costly — and because
 * a login is exactly what a departing volunteer takes with them.
 */
const ALWAYS_HIGH_CONSEQUENCE: ReadonlySet<AssetKind> = new Set<AssetKind>([
  "financial_control",
  "account_login",
]);

export interface ConsequenceInput {
  /** Null for a claim about no particular thing, which is never high-consequence. */
  assetKind: AssetKind | null;
  sensitivity: AssetSensitivity;
}

/**
 * Classifies a write's consequence from the asset's kind and sensitivity.
 *
 * Sensitivity is the escape hatch that makes the other four kinds reachable: a
 * `relationship` marked sensitive is the named contact for something critical, and a
 * `document` marked sensitive is one whose loss actually costs something.
 */
export function classifyConsequence({
  assetKind,
  sensitivity,
}: ConsequenceInput): ConsequenceLevel {
  if (assetKind !== null && ALWAYS_HIGH_CONSEQUENCE.has(assetKind)) return "high";
  return sensitivity === "sensitive" ? "high" : "low";
}

/**
 * Below this, the Curator's confidence counts as weak evidence.
 *
 * The design document sets no number, so this is a decision rather than a
 * transcription — and it is deliberately kept here, alone, so it can be moved once
 * real model output exists to calibrate against. Too high and every claim becomes an
 * approval request; too low and the gate never fires.
 */
export const WEAK_EVIDENCE_CONFIDENCE = 0.7;

export interface FactStatusInput {
  consequence: ConsequenceLevel;
  /** The Curator's confidence in the record. */
  confidence: number;
  /** Someone relaying what a third party said. */
  isHearsay: boolean;
}

export interface FactStatusDecision {
  status: FactStatus;
  /**
   * True when a human has to agree before this becomes truth. The claim is held
   * `pending_approval`, which detection SQL cannot see, so silence produces a visible
   * gap rather than an invented fact.
   */
  requiresApproval: boolean;
  /** One line, for the trace and for the approval message. */
  reason: string;
}

/**
 * Decides what status a newly extracted claim gets.
 *
 * Hearsay is checked first and unconditionally. Someone relaying what a third party
 * said is not established, however confident the Curator was about having read it
 * correctly — and `unverified` keeps it out of detection SQL entirely, so it can never
 * become a finding on the strength of a rumour.
 */
export function decideFactStatus({
  consequence,
  confidence,
  isHearsay,
}: FactStatusInput): FactStatusDecision {
  if (isHearsay) {
    return {
      status: "unverified",
      requiresApproval: false,
      reason: "Relayed from a third party, so recorded but not established.",
    };
  }

  const weak = confidence < WEAK_EVIDENCE_CONFIDENCE;

  if (consequence === "high" && weak) {
    return {
      status: "pending_approval",
      requiresApproval: true,
      reason:
        `High-consequence claim on weak evidence (confidence ${confidence.toFixed(2)}), ` +
        "so it is held until someone confirms it.",
    };
  }

  if (weak) {
    // The bottom-right cell: recorded, not asked about. Escalating here is how an
    // agent becomes noise and gets muted.
    return {
      status: "unverified",
      requiresApproval: false,
      reason: `Low-consequence claim on weak evidence (confidence ${confidence.toFixed(2)}).`,
    };
  }

  return { status: "active", requiresApproval: false, reason: "Acted on directly." };
}
