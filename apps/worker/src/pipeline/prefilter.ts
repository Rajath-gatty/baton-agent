/**
 * The pre-filter pass. `[F6]` `[F28]`
 *
 * Applies the shared classifier to every message whose verdict is missing or stamped
 * with an older `prefilter_version`, and records the result. Those two cases are
 * deliberately one query: a fresh message has no verdict, an improved filter
 * invalidates every old one, and both mean "this needs classifying". Writing them as
 * separate paths would give the re-evaluation path its own bugs and no reason to
 * exist.
 *
 * **The verdict is written for every message, kept and discarded alike.** A discard
 * is a decision, not an absence — without the row saying so there is no way to find
 * what an improved filter should look at again, and the knowledge in a wrongly
 * discarded message is gone for good.
 *
 * Curation state is untouched here. Re-evaluating a verdict must not re-curate a
 * message whose text has not changed; that reset belongs to intake, where it is
 * driven by the content hash.
 */

import { inArray, isNotNull, isNull, or, sql, and, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { schema } from "@baton/core/db";
import { PREFILTER_VERSION, prefilter } from "@baton/core";
import type { Executor } from "../store/types.js";

const { messages, people } = schema;

/** Kept small enough that one `in (...)` list stays inside sane parameter limits. */
const UPDATE_CHUNK = 500;

export interface PrefilterPassOptions {
  /**
   * Cap on messages classified in one pass. The live loop uses a small number so a
   * pass never runs long; backfill leaves it unset and classifies everything.
   */
  limit?: number;
}

export interface PrefilterPassResult {
  evaluated: number;
  candidates: number;
  /** Feeds `runs.candidates_skipped`, so "read 400, extracted 3" reads as sane. */
  discarded: number;
}

async function setVerdict(
  db: Executor,
  ids: readonly string[],
  verdict: "candidate" | "discarded",
): Promise<void> {
  for (let index = 0; index < ids.length; index += UPDATE_CHUNK) {
    const chunk = ids.slice(index, index + UPDATE_CHUNK);
    if (chunk.length === 0) continue;
    await db
      .update(messages)
      .set({ prefilterVerdict: verdict, prefilterVersion: PREFILTER_VERSION })
      .where(inArray(messages.id, chunk));
  }
}

/**
 * Classifies and records verdicts for everything not yet judged at the current
 * version.
 *
 * Read in `sent_at` order so a capped pass makes progress from the oldest end rather
 * than nibbling at whatever Postgres returns first — which also means backfill and
 * the live loop see messages in the same order the processing loop will.
 */
export async function runPrefilterPass(
  db: Executor,
  { limit }: PrefilterPassOptions = {},
): Promise<PrefilterPassResult> {
  const base = db
    .select({
      id: messages.id,
      text: messages.text,
      isUnprocessed: messages.isUnprocessed,
    })
    .from(messages)
    // `is distinct from` in two parts, because a null version and a stale version are
    // both unjudged and Drizzle has no direct operator for it.
    .where(or(isNull(messages.prefilterVersion), ne(messages.prefilterVersion, PREFILTER_VERSION)))
    .orderBy(messages.sentAt);

  const pending = limit === undefined ? await base : await base.limit(limit);

  const candidates: string[] = [];
  const discarded: string[] = [];

  for (const row of pending) {
    const result = prefilter({ text: row.text, isUnprocessed: row.isUnprocessed });
    (result.verdict === "candidate" ? candidates : discarded).push(row.id);
  }

  await setVerdict(db, candidates, "candidate");
  await setVerdict(db, discarded, "discarded");

  return {
    evaluated: pending.length,
    candidates: candidates.length,
    discarded: discarded.length,
  };
}

/**
 * How many messages are still waiting on a verdict at the current version.
 *
 * Read by the loop to decide whether a pass is worth running at all, and by tests to
 * assert that a version bump really did invalidate prior verdicts.
 */
export async function countUnfiltered(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(messages)
    .where(or(isNull(messages.prefilterVersion), ne(messages.prefilterVersion, PREFILTER_VERSION)));
  return Number(rows[0]?.count ?? 0);
}

/**
 * The candidates the processing loop should curate: kept by the pre-filter and not
 * yet curated.
 *
 * This is the query the `messages(prefilter_verdict, curated_at)` index exists for,
 * and it is ordered by `sent_at` because supersession is order-dependent —
 * a contradiction processed backwards silently inverts a fact.
 */
export interface CurationCandidate {
  id: string;
  text: string | null;
  contentHash: string;
  sentAt: Date;
  /**
   * How the sender should be referred to in the request. The person's recorded display
   * name where the sender resolved, and the name carried on the message otherwise —
   * seventeen of the twenty seeded volunteers have no Telegram account to resolve, and
   * a batch that identified them as "unknown" would make every mention of them
   * unresolvable.
   */
  senderMention: string;
  /** Whoever the sender resolved to, so a fact can record who stated it. */
  senderPersonId: string | null;
  /**
   * The text of the message this replies to. Context for the Curator, never a
   * candidate itself — extracting from it would attribute the parent's claim to the
   * reply's sender and duplicate it once per reply.
   */
  replyToText: string | null;
}

export async function selectCurationCandidates(
  db: Executor,
  limit: number,
): Promise<CurationCandidate[]> {
  const parent = alias(messages, "parent");

  const rows = await db
    .select({
      id: messages.id,
      text: messages.text,
      contentHash: messages.contentHash,
      sentAt: messages.sentAt,
      senderPersonId: messages.senderPersonId,
      senderDisplayName: messages.senderDisplayName,
      personDisplayName: people.displayName,
      replyToText: parent.text,
    })
    .from(messages)
    .leftJoin(people, eq(people.id, messages.senderPersonId))
    .leftJoin(parent, eq(parent.id, messages.replyToMessageId))
    .where(
      and(
        eq(messages.prefilterVerdict, "candidate"),
        isNull(messages.curatedAt),
        isNotNull(messages.text),
      ),
    )
    .orderBy(messages.sentAt)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    contentHash: row.contentHash,
    sentAt: row.sentAt,
    senderPersonId: row.senderPersonId,
    // The resolved person wins: it is the name the alias table is keyed on, so a
    // self-reference in the message body resolves to the same person the sender is.
    senderMention: row.personDisplayName ?? row.senderDisplayName ?? "unknown sender",
    replyToText: row.replyToText,
  }));
}
