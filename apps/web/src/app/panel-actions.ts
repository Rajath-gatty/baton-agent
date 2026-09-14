"use server";

/**
 * Panel reads, as server actions.
 *
 * The fact panel and the activity panel are the only two surfaces that read on
 * demand rather than being handed data by the page — a claim is pressed, and only
 * then does its provenance need loading. Both are client components, so they
 * cannot import `lib/data.ts` directly: that module holds the database client, and
 * importing it from the client would try to bundle Postgres into the browser.
 *
 * So the reads cross the boundary here. `lib/data.ts` stays the single place the
 * UI reaches for data; this file is only the doorway the two panels knock on.
 *
 * Reads, not writes — but they live in a `"use server"` module because that is
 * how a client component is allowed to call server code. Nothing here mutates.
 */

import { containsCredential, redactCredentials } from "@baton/core/redact";
import { getFact, getHoldingsForFact, getLastRun } from "@/lib/data";
import type { Fact, Holding, Run } from "@/lib/types";

/** Everything the fact panel renders for one claim, in one round trip. */
export interface FactDetail {
  fact: Fact;
  /** The facts this one replaced, newest first. Empty when it replaced nothing. */
  chain: Fact[];
  /** Holdings recorded against the same asset as the fact, current and released. */
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
 * asset.
 *
 * The chain walk is guarded with a visited set. `facts.supersedes_fact_id` is a
 * self-reference with no constraint forbidding a cycle, and a cycle would hang the
 * panel — cheap to prevent, unbounded to debug.
 *
 * Returns null when the id names nothing, which the panel renders as an empty
 * state rather than an error — a claim with no fact behind it is a real, calm
 * outcome, and it is what an evidence reference to a since-deleted row looks like.
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

  const holdings = await getHoldingsForFact(fact.id);

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
