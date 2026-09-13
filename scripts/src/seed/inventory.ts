/**
 * The inventory: assets across all six kinds, and the capability areas.
 *
 * The six-asset-kinds coverage row is satisfied structurally here rather than hoped
 * for in prose — at least one of each of login, physical item, financial control,
 * relationship, document and public presence, asserted by
 * `assertSixAssetKinds` below so a later edit cannot quietly drop one.
 *
 * The rescue setting was chosen because its dependencies are unambiguous and the
 * consequences of losing them are immediate, and this list is where that shows: a
 * clinic that extends credit, an emergency number on printed posters, a van that is
 * actually someone's own car, a foster-carer list in a personal spreadsheet, and a
 * payment link that donations flow through.
 */

import { ASSET_KINDS } from "@baton/core";
import type { PlanAsset, PlanCapability } from "./plan-types.js";

const ASSETS: PlanAsset[] = [
  {
    // The orphan. Its holder is the volunteer who leaves on camera.
    id: "a01",
    kind: "financial_control",
    name: "Razorpay donation page",
    normalisedKey: "razorpay donation page",
    sensitivity: "sensitive",
    isPersonalResource: false,
  },
  {
    // The approval case: one ambiguous message about this changing hands.
    id: "a02",
    kind: "financial_control",
    name: "bank account signatory",
    normalisedKey: "bank account signatory",
    sensitivity: "sensitive",
    isPersonalResource: false,
  },
  {
    id: "a03",
    kind: "account_login",
    name: "Instagram login",
    normalisedKey: "instagram login",
    sensitivity: "sensitive",
    isPersonalResource: false,
  },
  {
    id: "a04",
    kind: "account_login",
    name: "PetRescue listings portal login",
    normalisedKey: "petrescue listings portal login",
    sensitivity: "sensitive",
    isPersonalResource: false,
  },
  {
    // Personal resource: actually Suresh's own car. `not_ours`, not a one-person risk.
    id: "a05",
    kind: "physical_item",
    name: "the van",
    normalisedKey: "the van",
    sensitivity: "normal",
    isPersonalResource: true,
  },
  {
    // Changes hands cleanly mid-window, so holdings history carries a closed row.
    id: "a06",
    kind: "physical_item",
    name: "microchip scanner",
    normalisedKey: "microchip scanner",
    sensitivity: "normal",
    isPersonalResource: false,
  },
  {
    // The settlement arrangement: durable fact, then contradiction when terms change,
    // then negation when it ends.
    id: "a07",
    kind: "relationship",
    name: "Sunrise Clinic account",
    normalisedKey: "sunrise clinic account",
    sensitivity: "normal",
    isPersonalResource: false,
  },
  {
    id: "a08",
    kind: "relationship",
    name: "Green Paws pet store sponsorship",
    normalisedKey: "green paws pet store sponsorship",
    sensitivity: "normal",
    isPersonalResource: false,
  },
  {
    // A foster-carer list in a personal spreadsheet — the classic quiet dependency.
    id: "a09",
    kind: "document",
    name: "foster carer spreadsheet",
    normalisedKey: "foster carer spreadsheet",
    sensitivity: "sensitive",
    isPersonalResource: false,
  },
  {
    id: "a10",
    kind: "document",
    name: "adoption agreement template",
    normalisedKey: "adoption agreement template",
    sensitivity: "normal",
    isPersonalResource: false,
  },
  {
    // Printed on two hundred posters, so it cannot simply be changed. This is also the
    // number the redaction helper must never touch.
    id: "a11",
    kind: "public_presence",
    name: "emergency number on the posters",
    normalisedKey: "emergency number on the posters",
    sensitivity: "normal",
    isPersonalResource: false,
  },
  {
    id: "a12",
    kind: "public_presence",
    name: "Instagram page",
    normalisedKey: "instagram page",
    sensitivity: "normal",
    isPersonalResource: false,
  },
];

const CAPABILITIES: PlanCapability[] = [
  // The aggregation row: three separate exposures sit inside this one area.
  { id: "c01", name: "foster placement", normalisedKey: "foster placement" },
  // Several observed participants — the healthy case, for contrast.
  { id: "c02", name: "adoption day setup", normalisedKey: "adoption day setup" },
  // Exactly one observed participant: the capability variant of sole_holder.
  { id: "c03", name: "microchipping", normalisedKey: "microchipping" },
  { id: "c04", name: "vet transport", normalisedKey: "vet transport" },
  { id: "c05", name: "intake triage", normalisedKey: "intake triage" },
  { id: "c06", name: "social media posting", normalisedKey: "social media posting" },
];

export function buildAssets(): PlanAsset[] {
  return ASSETS.map((asset) => ({ ...asset }));
}

export function buildCapabilities(): PlanCapability[] {
  return CAPABILITIES.map((capability) => ({ ...capability }));
}

/**
 * Throws if any of the six asset kinds has no asset. Called by `seed-plan.ts` so the
 * failure lands at generation rather than as a coverage row that reads *asserted by
 * plan* while being false.
 */
export function assertSixAssetKinds(assets: PlanAsset[]): void {
  const present = new Set(assets.map((asset) => asset.kind));
  const missing = ASSET_KINDS.filter((kind) => !present.has(kind));
  if (missing.length > 0) {
    throw new Error(`asset inventory is missing kinds: ${missing.join(", ")}`);
  }
}
