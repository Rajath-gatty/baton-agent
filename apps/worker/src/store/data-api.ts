/**
 * The read-only queries behind `/data/*`.
 *
 * These four exist because the agent container holds no database credentials. What
 * the agent can predict it needs is hydrated into the request; these serve the
 * lookups it cannot know about in advance — chiefly drilling into evidence before
 * deciding whether a claim is well enough supported to raise or to say out loud.
 *
 * **Read-only without exception.** The agent never writes; it returns proposed
 * changes and the worker decides. There is no write path here to be tempted by.
 *
 * Three decisions here are about safety rather than shape, and each is the kind that
 * would be invisible if got wrong:
 *
 *   1. **Only `active` facts are searchable.** Anything the agent can retrieve may
 *      end up in an answer read aloud in the group. `pending_approval` is a change a
 *      human has not agreed to yet and `unverified` is hearsay — surfacing either as
 *      an answer would break the promise that a pending change never appears, so the
 *      filter lives in SQL rather than in prompt text.
 *   2. **Quoted message text is redacted.** Messages are stored verbatim because
 *      provenance depends on them, but this response is a render surface: it feeds a
 *      model and can reach a brief or an answer. A password pasted into the group
 *      must not make that trip.
 *   3. **Withdrawn messages are not returned.** Withdrawing provenance is the only
 *      remedy a coordinator has, since Telegram never reports deletions. A withdrawn
 *      message that still answered `getEvidence` would make that remedy cosmetic.
 */

import { and, eq, inArray, ilike, or, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { ageInDays, normaliseAlias, normaliseAssetKey, redactCredentials } from "@baton/core";
import type { AssetKind, AssetSensitivity } from "@baton/core";
import type { Executor } from "./types.js";

const { assets, facts, holdings, messages, people, personAliases } = schema;

/** Keeps a model prompt bounded. The whole register is only a couple of hundred rows. */
const SEARCH_LIMIT = 25;

/** Escapes a user-supplied `LIKE` pattern so `%` and `_` match literally. */
function likeLiteral(term: string): string {
  return `%${term.replace(/([\\%_])/g, "\\$1")}%`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FactSearchResult {
  factId: string;
  claim: string;
  status: string;
  confidence: number;
  assetId: string | null;
  assetName: string | null;
  assetKind: AssetKind | null;
  assetSensitivity: AssetSensitivity | null;
  /**
   * Every current holder, not one. A claim with two active holders is the
   * ambiguous-holder case, and collapsing it to a single name would hide the thing
   * the Respondent is supposed to escalate.
   */
  holders: { personId: string | null; displayName: string | null; external: string | null }[];
  statedAt: string;
  lastConfirmedAt: string;
  ageDays: number;
  evidenceMessageIds: string[];
}

/**
 * Free-text search over the register.
 *
 * Matches the claim text and the asset's name, because a coordinator asking about
 * "the donation page" is naming the asset rather than quoting the claim.
 */
export async function searchFacts(
  db: Executor,
  query: string,
  now: Date = new Date(),
): Promise<FactSearchResult[]> {
  const term = query.trim();
  if (term === "") return [];
  const pattern = likeLiteral(term);

  const rows = await db
    .select({
      factId: facts.id,
      claim: facts.claim,
      status: facts.status,
      confidence: facts.confidence,
      statedAt: facts.statedAt,
      lastConfirmedAt: facts.lastConfirmedAt,
      evidenceMessageIds: facts.evidenceMessageIds,
      assetId: assets.id,
      assetName: assets.name,
      assetKind: assets.kind,
      assetSensitivity: assets.sensitivity,
    })
    .from(facts)
    .leftJoin(assets, eq(assets.id, facts.assetId))
    .where(
      and(
        // See note 1 at the top of this file.
        eq(facts.status, "active"),
        or(ilike(facts.claim, pattern), ilike(assets.name, pattern)),
      ),
    )
    .orderBy(sql`${facts.lastConfirmedAt} desc`)
    .limit(SEARCH_LIMIT);

  const assetIds = [...new Set(rows.map((row) => row.assetId).filter((id) => id !== null))];
  const holderRows =
    assetIds.length === 0
      ? []
      : await db
          .select({
            assetId: holdings.assetId,
            personId: holdings.holderPersonId,
            displayName: people.displayName,
            external: holdings.holderExternal,
          })
          .from(holdings)
          .leftJoin(people, eq(people.id, holdings.holderPersonId))
          .where(and(inArray(holdings.assetId, assetIds), eq(holdings.status, "active")));

  // Stitched in code rather than joined, because joining holdings would multiply a
  // fact row per holder and the caller would have to undo it.
  const holdersByAsset = new Map<string, FactSearchResult["holders"]>();
  for (const row of holderRows) {
    const list = holdersByAsset.get(row.assetId) ?? [];
    list.push({ personId: row.personId, displayName: row.displayName, external: row.external });
    holdersByAsset.set(row.assetId, list);
  }

  return rows.map((row) => ({
    factId: row.factId,
    claim: row.claim,
    status: row.status,
    confidence: row.confidence,
    assetId: row.assetId,
    assetName: row.assetName,
    assetKind: row.assetKind,
    assetSensitivity: row.assetSensitivity,
    holders: row.assetId === null ? [] : (holdersByAsset.get(row.assetId) ?? []),
    statedAt: row.statedAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    // Computed by the worker, never by the model: arithmetic on dates is exactly the
    // kind of work a cheap model gets subtly wrong, and a staleness warning whose
    // number was invented is unfalsifiable.
    ageDays: ageInDays(row.lastConfirmedAt, now),
    evidenceMessageIds: row.evidenceMessageIds,
  }));
}

export interface EvidenceMessage {
  messageId: string;
  sentAt: string;
  senderDisplayName: string | null;
  /** Redacted. See note 2 at the top of this file. */
  text: string | null;
  isForwarded: boolean;
  forwardedFrom: string | null;
  isEdited: boolean;
}

export interface EvidenceResult {
  factId: string;
  claim: string;
  curatorReasoning: string | null;
  messages: EvidenceMessage[];
}

/**
 * The messages a claim rests on, oldest first.
 *
 * The source message and the accumulated evidence are unioned: a restatement appends
 * to `evidence_message_ids` rather than replacing, so a well-supported claim carries
 * several, and the count is what the Assessor's suppression threshold turns on.
 */
export async function getEvidence(db: Executor, factId: string): Promise<EvidenceResult | null> {
  if (!UUID.test(factId)) return null;

  const factRows = await db
    .select({
      id: facts.id,
      claim: facts.claim,
      curatorReasoning: facts.curatorReasoning,
      sourceMessageId: facts.sourceMessageId,
      evidenceMessageIds: facts.evidenceMessageIds,
    })
    .from(facts)
    .where(eq(facts.id, factId))
    .limit(1);

  const fact = factRows[0];
  if (fact === undefined) return null;

  const ids = [...new Set([fact.sourceMessageId, ...fact.evidenceMessageIds])];
  const messageRows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: messages.id,
            sentAt: messages.sentAt,
            senderDisplayName: messages.senderDisplayName,
            text: messages.text,
            isForwarded: messages.isForwarded,
            forwardedFrom: messages.forwardedFrom,
            isEdited: messages.isEdited,
          })
          .from(messages)
          // See note 3: a withdrawn message is not quotable.
          .where(and(inArray(messages.id, ids), eq(messages.isWithdrawn, false)))
          .orderBy(messages.sentAt);

  return {
    factId: fact.id,
    claim: fact.claim,
    curatorReasoning: fact.curatorReasoning,
    messages: messageRows.map((row) => ({
      messageId: row.id,
      sentAt: row.sentAt.toISOString(),
      senderDisplayName: row.senderDisplayName,
      text: row.text === null ? null : redactCredentials(row.text),
      isForwarded: row.isForwarded,
      forwardedFrom: row.forwardedFrom,
      isEdited: row.isEdited,
    })),
  };
}

export interface HoldingHistoryEntry {
  holdingId: string;
  personId: string | null;
  displayName: string | null;
  external: string | null;
  isPersonalResource: boolean;
  status: string;
  acquiredAt: string | null;
  releasedAt: string | null;
}

export interface HoldingsResult {
  assetId: string;
  assetName: string;
  assetKind: AssetKind;
  assetSensitivity: AssetSensitivity;
  /** Open **and** closed rows. See the note on the function. */
  history: HoldingHistoryEntry[];
}

/**
 * Every holder an asset has ever had, current and past.
 *
 * Closed rows are included deliberately, and it is the whole reason this tool
 * exists: an asset with no current holder may have had one last month, and telling a
 * clean transfer from a genuine gap is impossible without the history. Holdings are
 * append-only for exactly this reason — a transfer closes one row and opens another,
 * and nothing is ever overwritten.
 *
 * Accepts an asset id or a name, because the agent has whichever the register gave
 * it and should not have to guess.
 */
export async function getHoldings(db: Executor, assetRef: string): Promise<HoldingsResult | null> {
  const ref = assetRef.trim();
  if (ref === "") return null;

  const assetRows = await db
    .select({
      id: assets.id,
      name: assets.name,
      kind: assets.kind,
      sensitivity: assets.sensitivity,
    })
    .from(assets)
    .where(
      UUID.test(ref)
        ? eq(assets.id, ref)
        : or(
            eq(assets.normalisedKey, normaliseAssetKey(ref)),
            ilike(assets.name, likeLiteral(ref)),
          ),
    )
    .limit(1);

  const asset = assetRows[0];
  if (asset === undefined) return null;

  const rows = await db
    .select({
      holdingId: holdings.id,
      personId: holdings.holderPersonId,
      displayName: people.displayName,
      external: holdings.holderExternal,
      isPersonalResource: holdings.isPersonalResource,
      status: holdings.status,
      acquiredAt: holdings.acquiredAt,
      releasedAt: holdings.releasedAt,
    })
    .from(holdings)
    .leftJoin(people, eq(people.id, holdings.holderPersonId))
    .where(eq(holdings.assetId, asset.id))
    // Oldest first, so a transfer reads as a sequence.
    .orderBy(sql`${holdings.acquiredAt} asc nulls first`);

  return {
    assetId: asset.id,
    assetName: asset.name,
    assetKind: asset.kind,
    assetSensitivity: asset.sensitivity,
    history: rows.map((row) => ({
      holdingId: row.holdingId,
      personId: row.personId,
      displayName: row.displayName,
      external: row.external,
      isPersonalResource: row.isPersonalResource,
      status: row.status,
      acquiredAt: row.acquiredAt?.toISOString() ?? null,
      releasedAt: row.releasedAt?.toISOString() ?? null,
    })),
  };
}

export interface PersonMatch {
  personId: string;
  displayName: string;
  status: string;
  joinedAt: string | null;
  leftAt: string | null;
  matchedAliases: string[];
}

/**
 * Everyone a name could refer to.
 *
 * **Returns every match, and that is the contract rather than a limitation.** An
 * alias resolving to two people is the ambiguity signal that becomes a clarification
 * question; returning a best guess would convert it into a silent wrong answer about
 * who holds something. Two volunteers really are both called Priya.
 */
export async function getPerson(db: Executor, alias: string): Promise<PersonMatch[]> {
  const key = normaliseAlias(alias);
  if (key === "") return [];

  const rows = await db
    .select({
      personId: people.id,
      displayName: people.displayName,
      status: people.status,
      joinedAt: people.joinedAt,
      leftAt: people.leftAt,
      alias: personAliases.alias,
    })
    .from(people)
    .leftJoin(personAliases, eq(personAliases.personId, people.id))
    .where(
      or(
        eq(personAliases.normalisedAlias, key),
        // Also matched directly, so a person whose aliases were never expanded is
        // still findable by the name they are quoted under.
        sql`lower(${people.displayName}) = ${key}`,
      ),
    );

  const byPerson = new Map<string, PersonMatch>();
  for (const row of rows) {
    const existing = byPerson.get(row.personId);
    if (existing === undefined) {
      byPerson.set(row.personId, {
        personId: row.personId,
        displayName: row.displayName,
        status: row.status,
        joinedAt: row.joinedAt?.toISOString() ?? null,
        leftAt: row.leftAt?.toISOString() ?? null,
        matchedAliases: row.alias === null ? [] : [row.alias],
      });
    } else if (row.alias !== null && !existing.matchedAliases.includes(row.alias)) {
      existing.matchedAliases.push(row.alias);
    }
  }

  return [...byPerson.values()];
}
