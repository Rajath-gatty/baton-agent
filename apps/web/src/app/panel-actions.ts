"use server";

/**
 * Panel reads, as server actions.
 *
 * The fact panel and the activity panel are the only two surfaces that read on
 * demand rather than being handed data by the page — a claim is pressed, and only
 * then does its provenance need loading. Both are client components, so they
 * cannot import `lib/data.ts` directly: that module is the seam that becomes
 * Drizzle queries, and importing it from the client would either pull a database
 * client into the browser bundle or, today, silently ship every fixture to it.
 *
 * So the reads cross the boundary here. `lib/data.ts` stays the single place the
 * UI reaches for data; this file is only the doorway the two panels knock on.
 *
 * Reads, not writes — but they live in a `"use server"` module because that is
 * how a client component is allowed to call server code. Nothing here mutates.
 */

import { containsCredential, redactCredentials } from "@baton/core/redact";
import { getFact, getHoldingsByKind, getLastRun } from "@/lib/data";
import type { Fact, Holding, Run } from "@/lib/types";

/** Everything the fact panel renders for one claim, in one round trip. */
export interface FactDetail {
  fact: Fact;
  /** The facts this one replaced, newest first. Empty when it replaced nothing. */
  chain: Fact[];
  /** Holdings recorded against the same subject as the fact. */
  holdings: Holding[];
  /**
   * The source message's text, ALREADY REDACTED [F30].
   *
   * Redaction happens here rather than at render, and the raw text is not part of
   * this shape at all. That is the point: redacting in the component would put the
   * literal credential in the page payload — visible in the network tab and in
   * view-source — and call it redacted because the pixels never showed it. The
   * only copy that crosses to the browser is the redacted one.
   *
   * Null when the coordinator has withdrawn the quote, so a withdrawn message's
   * text does not travel either.
   */
  sourceText: string | null;
  /** Whether redaction actually removed something, so the panel can say so. */
  credentialRedacted: boolean;
}

/**
 * Load a fact, its supersession chain and the holdings that sit under the same
 * subject.
 *
 * The chain walk is guarded with a visited set: a cycle in synthetic data would
 * otherwise hang the panel, and a fixture is exactly where a cycle comes from.
 * Returns null when the id names nothing, which the panel renders as an empty
 * state rather than an error — a claim with no fact behind it is a real, calm
 * outcome.
 */
export async function loadFactDetail(factId: string): Promise<FactDetail | null> {
  const fact = await getFact(factId);
  if (!fact) return null;

  const chain: Fact[] = [];
  const seen = new Set<string>([fact.id]);
  let cursor = fact.supersedes;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const prior = await getFact(cursor);
    if (!prior) break;
    chain.push(prior);
    cursor = prior.supersedes;
  }

  const groups = await getHoldingsByKind();
  const holdings = groups
    .flatMap((group) => group.entries)
    .filter((entry) => topicMatchesAsset(fact.topic, entry.asset.label))
    .flatMap((entry) => entry.holdings);

  const raw = fact.sourceMessage.text;
  const withdrawn = fact.provenanceWithdrawn;

  return {
    // The raw text is stripped off the message before it crosses the boundary, so
    // the browser never receives a credential even in a field it does not render.
    fact: { ...fact, sourceMessage: { ...fact.sourceMessage, text: "" } },
    chain: chain.map((prior) => ({
      ...prior,
      sourceMessage: { ...prior.sourceMessage, text: "" },
    })),
    holdings,
    sourceText: withdrawn ? null : redactCredentials(raw),
    credentialRedacted: !withdrawn && containsCredential(raw),
  };
}

/** The most recent run, for the activity panel. */
export async function loadLastRun(): Promise<Run | null> {
  return getLastRun();
}

/**
 * A fact's topic and an asset's label share a subject phrase (e.g. "Public
 * presence — Instagram" ↔ "Instagram — @streetpaws.blr"). Matched on the shared
 * significant word rather than requiring a foreign key the fixture layer does not
 * model yet; when the schema lands this becomes a join and this function goes.
 */
function topicMatchesAsset(topic: string, assetLabel: string): boolean {
  const key = significantWord(topic);
  if (!key) return false;
  return assetLabel.toLowerCase().includes(key);
}

function significantWord(topic: string): string | null {
  // Take the phrase after the em dash if present, else the whole topic, and
  // reduce to its first meaningful token.
  const parts = topic.split("—");
  const tailPart = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const tail = (tailPart ?? "").trim().toLowerCase();
  const words = tail.split(/\s+/).filter((w) => w.length > 3);
  return words[0] ?? null;
}
