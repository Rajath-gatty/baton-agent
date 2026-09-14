/**
 * Turning an `ingest` result into rows. `[F12]`
 *
 * The agent returns two lists that have to be married back together: the Curator's
 * records, and the Cartographer's attributions of the person mentions inside them.
 *
 * **The coordinate system is the flattened record list**, and getting this wrong would
 * misattribute holdings silently. `recordIndex` counts records across
 * `curator.results[*].records[*]` in order, one increment per *record* — not per
 * message and not per mention. Several attributions therefore share one index, because
 * a record can carry a holder and a list of subjects. Which attribution is which is
 * decided by matching `mention` back against `holderMention` and `subjectMentions`,
 * since the index alone cannot say.
 *
 * This module creates only the things a claim *refers to* — assets, capabilities, and
 * alias forms. It deliberately creates no people: the Cartographer resolves mentions
 * against the alias table it was given and never invents a person, so people arrive
 * only from Telegram senders, membership events, or the seeded roster. An unresolvable
 * mention is reported, not guessed at.
 */

import type { CartographerAttribution, CuratorRecord, IngestResult } from "@baton/core";
import { upsertAsset, upsertCapability } from "../store/assets.js";
import { getPersonDisplayNames, learnAlias } from "../store/people.js";
import type { Executor } from "../store/types.js";

/** Who holds the thing a record is about. */
export type HolderResolution =
  | {
      kind: "person";
      personId: string;
      /** The van is someone's own car: `not_ours` rather than a one-person risk. */
      isPersonalResource: boolean;
      confidence: number;
    }
  | { kind: "external"; name: string; isPersonalResource: boolean; confidence: number }
  /**
   * The mention could not be settled. **Becomes a clarification question, never a
   * holding.** Writing a holding here would be a guess about who holds something, and a
   * wrong guess about who holds financial control is invisible once written.
   */
  | {
      kind: "unresolved";
      reason: "ambiguous" | "cannot_determine";
      candidatePersonIds: string[];
      mention: string;
    }
  /** The record names no holder — an arrangement rather than a possession. */
  | { kind: "none" };

export interface ResolvedRecord {
  /** The Cartographer's coordinate. Kept so a trace can be read back. */
  index: number;
  /** The local `messages.id`, echoed by the Curator from what the worker sent. */
  messageId: string;
  record: CuratorRecord;
  assetId: string | null;
  capabilityId: string | null;
  holder: HolderResolution;
  /** People named as having taken part. Unresolvable subjects are simply absent. */
  subjectPersonIds: string[];
}

export interface UnresolvedMention {
  index: number;
  mention: string;
  reason: "ambiguous" | "cannot_determine";
  candidatePersonIds: string[];
  /** The Cartographer's one line, about the evidence and never about the person. */
  reasoning: string;
}

export interface EntityUpsertResult {
  records: ResolvedRecord[];
  assetsCreated: number;
  capabilitiesCreated: number;
  aliasesLearned: number;
  /** Feeds the clarification questions the ask budget then rations. */
  unresolved: UnresolvedMention[];
}

/**
 * Flattens the Curator's output into the Cartographer's coordinate system.
 *
 * Mirrors `collectMentions` in the agent exactly. If these two ever disagree,
 * attributions land on the wrong records and the register fills with confident
 * nonsense, so the shape of the loop matters more than its brevity.
 */
export function flattenRecords(
  result: IngestResult,
): { index: number; messageId: string; record: CuratorRecord }[] {
  const flat: { index: number; messageId: string; record: CuratorRecord }[] = [];
  let index = 0;

  for (const message of result.curator.results) {
    for (const record of message.records) {
      flat.push({ index, messageId: message.messageId, record });
      index += 1;
    }
  }

  return flat;
}

/** Groups attributions by the record they belong to. */
function attributionsByRecord(result: IngestResult): Map<number, CartographerAttribution[]> {
  const grouped = new Map<number, CartographerAttribution[]>();
  for (const attribution of result.cartographer.attributions) {
    const existing = grouped.get(attribution.recordIndex) ?? [];
    existing.push(attribution);
    grouped.set(attribution.recordIndex, existing);
  }
  return grouped;
}

/** Matches on the mention as written, which is how both sides refer to it. */
function findByMention(
  attributions: readonly CartographerAttribution[],
  mention: string,
): CartographerAttribution | undefined {
  return attributions.find((attribution) => attribution.mention === mention);
}

function toHolder(
  attribution: CartographerAttribution | undefined,
  holderMention: string | null,
): HolderResolution {
  if (holderMention === null || holderMention.trim() === "") return { kind: "none" };

  // The Curator named a holder but no attribution came back for it. Treated as
  // unsettled rather than dropped: silence from the Cartographer is not permission to
  // guess, and the mention is still worth asking about.
  if (attribution === undefined) {
    return {
      kind: "unresolved",
      reason: "cannot_determine",
      candidatePersonIds: [],
      mention: holderMention,
    };
  }

  switch (attribution.resolution) {
    case "resolved": {
      if (attribution.personId === null) {
        // `resolved` with no person is a contradiction in the output. Refusing it is
        // safer than picking a candidate.
        return {
          kind: "unresolved",
          reason: "cannot_determine",
          candidatePersonIds: attribution.candidatePersonIds,
          mention: attribution.mention,
        };
      }
      return {
        kind: "person",
        personId: attribution.personId,
        isPersonalResource: attribution.isPersonalResource,
        confidence: attribution.confidence,
      };
    }
    case "external": {
      if (attribution.externalName === null || attribution.externalName.trim() === "") {
        return {
          kind: "unresolved",
          reason: "cannot_determine",
          candidatePersonIds: attribution.candidatePersonIds,
          mention: attribution.mention,
        };
      }
      return {
        kind: "external",
        name: attribution.externalName.trim(),
        isPersonalResource: attribution.isPersonalResource,
        confidence: attribution.confidence,
      };
    }
    default: {
      return {
        kind: "unresolved",
        reason: attribution.resolution,
        candidatePersonIds: attribution.candidatePersonIds,
        mention: attribution.mention,
      };
    }
  }
}

/**
 * Creates the assets, capabilities and alias forms an ingest result refers to, and
 * resolves each record's holder and subjects.
 *
 * Writes nothing to `facts`, `holdings`, `commitments` or `capability_coverage` — those
 * are the next steps and they need what this returns.
 */
export async function upsertEntitiesFromIngest(
  db: Executor,
  result: IngestResult,
): Promise<EntityUpsertResult> {
  const flat = flattenRecords(result);
  const grouped = attributionsByRecord(result);

  const records: ResolvedRecord[] = [];
  const unresolved: UnresolvedMention[] = [];
  let assetsCreated = 0;
  let capabilitiesCreated = 0;
  let aliasesLearned = 0;

  // One lookup for every person the Cartographer named, rather than one per mention:
  // alias classification needs the display name, and a batch of ten messages can carry
  // thirty mentions of five people.
  const personIds = new Set<string>();
  for (const attribution of result.cartographer.attributions) {
    if (attribution.personId !== null) personIds.add(attribution.personId);
  }
  const displayNames = await getPersonDisplayNames(db, [...personIds]);

  for (const { index, messageId, record } of flat) {
    const attributions = grouped.get(index) ?? [];

    const assetId =
      record.assetName !== null && record.assetName.trim() !== "" && record.assetKind !== null
        ? await (async () => {
            const upserted = await upsertAsset(db, {
              kind: record.assetKind as NonNullable<CuratorRecord["assetKind"]>,
              name: record.assetName as string,
              sensitivity: record.sensitivity,
            });
            if (upserted.created) assetsCreated += 1;
            return upserted.id;
          })()
        : null;

    const capabilityId =
      record.capabilityName !== null && record.capabilityName.trim() !== ""
        ? await (async () => {
            const upserted = await upsertCapability(db, record.capabilityName as string);
            if (upserted.created) capabilitiesCreated += 1;
            return upserted.id;
          })()
        : null;

    const holderAttribution = findByMention(attributions, record.holderMention ?? "\u0000");
    const holder = toHolder(holderAttribution, record.holderMention);
    if (holder.kind === "unresolved") {
      unresolved.push({
        index,
        mention: holder.mention,
        reason: holder.reason,
        candidatePersonIds: holder.candidatePersonIds,
        reasoning: holderAttribution?.reasoning ?? "No attribution was returned for this mention.",
      });
    }

    const subjectPersonIds: string[] = [];
    for (const mention of record.subjectMentions) {
      // The holder's attribution is excluded so a record whose holder is also listed as
      // a subject does not count that person twice.
      const attribution = attributions.find(
        (candidate) => candidate.mention === mention && candidate !== holderAttribution,
      );
      if (attribution === undefined) continue;

      if (attribution.resolution === "resolved" && attribution.personId !== null) {
        if (!subjectPersonIds.includes(attribution.personId)) {
          subjectPersonIds.push(attribution.personId);
        }
      } else if (
        attribution.resolution === "ambiguous" ||
        attribution.resolution === "cannot_determine"
      ) {
        // Reported, not guessed. Participation evidence naming someone unidentifiable
        // is a gap, and inventing coverage would be worse than the gap.
        unresolved.push({
          index,
          mention: attribution.mention,
          reason: attribution.resolution,
          candidatePersonIds: attribution.candidatePersonIds,
          reasoning: attribution.reasoning,
        });
      }
    }

    records.push({ index, messageId, record, assetId, capabilityId, holder, subjectPersonIds });
  }

  // Learned last, once, per resolved attribution — so the same mention appearing in ten
  // records costs one write rather than ten.
  const learnable = new Map<string, { personId: string; alias: string }>();
  for (const attribution of result.cartographer.attributions) {
    if (attribution.resolution !== "resolved" || attribution.personId === null) continue;
    learnable.set(`${attribution.personId}\u0000${attribution.mention}`, {
      personId: attribution.personId,
      alias: attribution.mention,
    });
  }
  for (const { personId, alias } of learnable.values()) {
    const displayName = displayNames.get(personId);
    if (displayName === undefined) continue;
    if (await learnAlias(db, { personId, alias, displayName })) aliasesLearned += 1;
  }

  return { records, assetsCreated, capabilitiesCreated, aliasesLearned, unresolved };
}
