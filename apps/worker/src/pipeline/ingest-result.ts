/**
 * Splitting a batch `ingest` result into per-message results. `[F12]`
 *
 * A batch of ten messages comes back as one result: a list of ten per-message Curator
 * results, and one flat list of attributions indexed across every record in the batch.
 * Derivation, however, has to happen **one message at a time in strict `sent_at`
 * order** — supersession is order-dependent, and a contradiction applied before the
 * claim it contradicts silently inverts a fact.
 *
 * That leaves two coordinate systems to reconcile, and this module is the only place
 * that knows about both. It re-bases each message's attributions onto its own records,
 * so everything downstream sees the same shape whether the result came from a model
 * call or from the cache. Without that, the cached path and the fresh path would need
 * separate derivation code, and the cached path is the one nobody watches.
 *
 * Re-basing rather than carrying an offset around is the point: an offset is a number
 * that has to be threaded through six function signatures and is wrong the first time
 * someone forgets it. After this, `recordIndex` always means "the nth record of this
 * message", everywhere.
 */

import type { CartographerAttribution, CuratorMessageResult, IngestResult } from "@baton/core";

export interface PerMessageIngest {
  /** The local `messages.id`, echoed by the Curator from what the worker sent. */
  messageId: string;
  /** A complete, self-contained result for exactly one message. */
  ingest: IngestResult;
}

/**
 * Builds a one-message result from a Curator result and its own attributions.
 *
 * The attributions must already be indexed against this message's records — index 0 is
 * its first record. Used directly by the cached path, where the worker attributes the
 * records itself and there was never a batch to be part of.
 */
export function singleMessageIngest(
  result: CuratorMessageResult,
  attributions: readonly CartographerAttribution[],
): IngestResult {
  return {
    curator: { results: [result] },
    cartographer: { attributions: [...attributions] },
  };
}

/**
 * Splits a batch result into one result per message, re-basing record indices.
 *
 * Attributions whose `recordIndex` falls outside the batch's records are dropped. That
 * is a model error — an index past the end of a list it was given — and dropping it is
 * the safe direction: a record left without a holder attribution is treated downstream
 * as unsettled and becomes a clarification question, whereas keeping it would attach a
 * person to whichever record happened to sit at that index.
 */
export function splitIngestResult(result: IngestResult): PerMessageIngest[] {
  // Bucketed once rather than filtered per message, so a batch carrying thirty
  // attributions across ten messages is one pass instead of ten.
  const byIndex = new Map<number, CartographerAttribution[]>();
  for (const attribution of result.cartographer.attributions) {
    const existing = byIndex.get(attribution.recordIndex);
    if (existing === undefined) byIndex.set(attribution.recordIndex, [attribution]);
    else existing.push(attribution);
  }

  const split: PerMessageIngest[] = [];
  let offset = 0;

  for (const message of result.curator.results) {
    const attributions: CartographerAttribution[] = [];

    for (let local = 0; local < message.records.length; local += 1) {
      for (const attribution of byIndex.get(offset + local) ?? []) {
        attributions.push({ ...attribution, recordIndex: local });
      }
    }

    split.push({
      messageId: message.messageId,
      ingest: singleMessageIngest(message, attributions),
    });
    offset += message.records.length;
  }

  return split;
}

/** Total records across a result. The Cartographer's index space, for a bounds check. */
export function countRecords(result: IngestResult): number {
  return result.curator.results.reduce((total, message) => total + message.records.length, 0);
}
