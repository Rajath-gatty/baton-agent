/**
 * The read seam.
 *
 * This is the single place the UI reaches for data. Today it returns synthetic
 * fixtures; when the Drizzle schema lands, only the bodies below change — they
 * become queries against `@baton/core/db` — and every page keeps working
 * unchanged. Keep the function signatures stable and keep all reads here, so
 * the swap is contained to this file.
 *
 * Everything is async, even though fixtures are synchronous, so the seam
 * already has the shape a database read will need.
 */

import type { AssetKind } from "@baton/core";
import { ASSET_KINDS } from "@baton/core";
import type {
  Asset,
  Brief,
  Diff,
  Fact,
  Finding,
  Holding,
  QuietDecision,
  Question,
  Run,
} from "./types";
import {
  assets,
  briefs,
  diffs,
  facts,
  findings,
  holdings,
  questions,
  quietDecisions,
  runs,
  stateSentence,
} from "./fixtures";

/** The most recent run, or null if the register has never run. */
export async function getLastRun(): Promise<Run | null> {
  const sorted = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  return sorted[0] ?? null;
}

/** The state of the organisation as one sentence. */
export async function getStateSentence(): Promise<string> {
  return stateSentence;
}

/** What changed since the coordinator last looked, newest first. */
export async function getSinceYouLastLooked(): Promise<Diff[]> {
  return [...diffs].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** Open questions (queued or asked), approvals first, then by age. */
export async function getOpenQuestions(): Promise<Question[]> {
  const open = questions.filter((q) => q.status === "queued" || q.status === "asked");
  const rank: Record<Question["kind"], number> = {
    approval: 0,
    clarification: 1,
    verification: 2,
  };
  return open.sort((a, b) => {
    const byKind = rank[a.kind] - rank[b.kind];
    if (byKind !== 0) return byKind;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

/** The most recent unread brief, or null if the coordinator is caught up. */
export async function getUnreadBrief(): Promise<Brief | null> {
  const unread = briefs
    .filter((b) => !b.read)
    .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
  return unread[0] ?? null;
}

/**
 * The register: open findings, ranked. Severity descending, then confidence
 * descending, so the exposures a coordinator must act on rise to the top.
 */
export async function getRegister(): Promise<Finding[]> {
  const severityRank: Record<Finding["severity"], number> = { high: 0, medium: 1, low: 2 };
  return findings
    .filter((f) => f.status === "open")
    .sort((a, b) => {
      const bySeverity = severityRank[a.severity] - severityRank[b.severity];
      if (bySeverity !== 0) return bySeverity;
      return b.confidence - a.confidence;
    });
}

/** The quiet decisions, newest first — restraint made visible. */
export async function getQuietDecisions(): Promise<QuietDecision[]> {
  return [...quietDecisions].sort(
    (a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime(),
  );
}

/** Findings the coordinator dismissed, newest first. */
export async function getDismissedFindings(): Promise<Finding[]> {
  return findings
    .filter((f) => f.status === "dismissed")
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());
}

/**
 * One asset kind with the assets of that kind and each asset's holdings. Every
 * one of the six kinds is present, even when empty, so the register reads as a
 * complete accounting rather than only the kinds that happen to have entries.
 */
export interface HoldingsGroup {
  kind: AssetKind;
  entries: { asset: Asset; holdings: Holding[] }[];
}

/** Holdings grouped by asset kind, in the fixed `ASSET_KINDS` order. */
export async function getHoldingsByKind(): Promise<HoldingsGroup[]> {
  return ASSET_KINDS.map((kind) => ({
    kind,
    entries: assets
      .filter((asset) => asset.kind === kind)
      .map((asset) => ({
        asset,
        holdings: holdings.filter((h) => h.assetId === asset.id),
      })),
  }));
}

/** Every brief, newest first. */
export async function getBriefs(): Promise<Brief[]> {
  return [...briefs].sort(
    (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime(),
  );
}

/** A single fact by id, or null if unknown. Used by the fact detail panel. */
export async function getFact(id: string): Promise<Fact | null> {
  return facts.find((f) => f.id === id) ?? null;
}

/** Every run, newest first. */
export async function getRuns(): Promise<Run[]> {
  return [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
}
