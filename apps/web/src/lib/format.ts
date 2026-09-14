/**
 * Rendering helpers.
 *
 * Two rules hold throughout. Time is always rendered in the organisation's zone
 * — Asia/Kolkata — never the reader's local zone and never UTC, because a
 * coordinator in Bengaluru reading "yesterday 6pm" must mean their yesterday,
 * their 6pm. Money is always INR, in the Indian digit grouping (lakh/crore),
 * because that is the only currency the group counts in.
 */

import type { AssetKind, FactStatus, FindingSeverity, FindingSubtype } from "@baton/core";

/**
 * The organisation's timezone. Not exported from core (core is server-agnostic
 * about presentation), so it is fixed here as the single source the UI formats
 * against.
 */
export const ORG_TIMEZONE = "Asia/Kolkata";

/**
 * The reference "now" for relative ages.
 *
 * Live, because the register is. It was fixed while the UI read synthetic fixtures
 * — a hard-coded date is what makes a fixture's ages read consistently — and a
 * fixed reference against real rows would report a claim confirmed this morning as
 * days old, which is precisely the reading the staleness warning depends on.
 */
function referenceNow(): Date {
  return new Date();
}

const dateFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: ORG_TIMEZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-IN", {
  timeZone: ORG_TIMEZONE,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

/** "14 Aug 2026". */
export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}

/** "14 Aug, 6:32 pm" — used where a message's exact moment matters. */
export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso));
}

const MS_PER_DAY = 86_400_000;

/**
 * A coarse, human age: "today", "3 days old", "5 months old". Coarse on
 * purpose — the coordinator needs the order of magnitude of an exposure's age,
 * not a precise duration.
 */
export function formatRelativeAge(iso: string, now: Date = referenceNow()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day old";
  if (days < 14) return `${days} days old`;
  if (days < 61) return `${Math.round(days / 7)} weeks old`;
  if (days < 365) return `${Math.round(days / 30)} months old`;
  const years = Math.round(days / 365);
  return years === 1 ? "1 year old" : `${years} years old`;
}

/** "82%" — confidence rendered as a plain percentage for reading, not a bar. */
export function formatConfidence(confidence: number): string {
  const clamped = Math.max(0, Math.min(1, confidence));
  return `${Math.round(clamped * 100)}%`;
}

/** "₹18,000" / "₹1,20,000" — Indian grouping, no paise. */
export function formatINR(amount: number): string {
  return inrFormatter.format(amount);
}

const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  account_login: "Account login",
  physical_item: "Physical item",
  financial_control: "Financial control",
  relationship: "Relationship",
  document: "Document",
  public_presence: "Public presence",
};

export function assetKindLabel(kind: AssetKind): string {
  return ASSET_KIND_LABELS[kind];
}

const FACT_STATUS_LABELS: Record<FactStatus, string> = {
  active: "Active",
  superseded: "Superseded",
  retired: "Retired",
  unverified: "Unverified",
  pending_approval: "Held for approval",
};

export function factStatusLabel(status: FactStatus): string {
  return FACT_STATUS_LABELS[status];
}

const SUBTYPE_LABELS: Record<FindingSubtype, string> = {
  sole_holder: "Held by one person",
  no_owner: "No owner",
  not_ours: "Not the organisation's",
  loose_end: "Loose end",
};

export function subtypeLabel(subtype: FindingSubtype): string {
  return SUBTYPE_LABELS[subtype];
}

const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function severityLabel(severity: FindingSeverity): string {
  return SEVERITY_LABELS[severity];
}
