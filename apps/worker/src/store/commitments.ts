/**
 * `commitments` — promises, and noticing when they are kept.
 *
 * Two shapes matter and the schema keeps them apart by nullability rather than by a
 * flag:
 *
 *   - **`owner_person_id` is nullable** because "someone should sort the printers" is an
 *     unowned intent, and that is its own kind of loose end rather than missing data.
 *   - **`deadline` is nullable** because "I'll sort the printers" has no date, and that
 *     absence is the point: an undated intention is what a departure brief asks someone
 *     to consciously decide about rather than inherit by accident.
 *
 * **Closure detection is deliberately conservative.** The Curator has no "this is done"
 * record kind, so noticing a kept promise is a heuristic over later messages: completion
 * language *and* real overlap with what was promised. Both are required. A false close
 * silently drops a loose end nobody is now tracking, which is worse than a loose end that
 * stays open one message too long — so when the two signals disagree, nothing happens and
 * the commitment stays open.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import { normaliseAssetKey } from "@baton/core";
import type { CuratorRecord } from "@baton/core";
import type { HolderResolution } from "../pipeline/entities.js";
import { resolveDeadline } from "./facts.js";
import type { Executor } from "./types.js";

const { commitments } = schema;

export type CommitmentOutcome = "recorded" | "duplicate" | "skipped";

export interface AppliedCommitment {
  outcome: CommitmentOutcome;
  commitmentId: string | null;
  /** True when nobody owns it — a loose end with no name on it. */
  unowned: boolean;
  /** True when no date was given, which a brief treats differently. */
  undated: boolean;
}

export interface ApplyCommitmentInput {
  record: CuratorRecord;
  /** Who promised. `none` or unresolved leaves the commitment unowned. */
  holder: HolderResolution;
  messageId: string;
  /** The message's own timestamp: when the promise was made. */
  statedAt: Date;
  /** Resolved from `app_settings`, so a bare date becomes local midnight. */
  timezone: string;
}

/**
 * Records a promise.
 *
 * Idempotent on `(source_message_id, substance)`. There is no unique constraint to lean
 * on, and there should not be — the same promise can genuinely be made twice on different
 * days — so the guard is scoped to one message, which is exactly what a crash replay or a
 * re-curation re-presents.
 */
export async function applyCommitment(
  db: Executor,
  { record, holder, messageId, statedAt, timezone }: ApplyCommitmentInput,
): Promise<AppliedCommitment> {
  const substance = record.claim.trim();
  if (substance === "") {
    return { outcome: "skipped", commitmentId: null, unowned: true, undated: true };
  }

  const existing = await db
    .select({ id: commitments.id })
    .from(commitments)
    .where(and(eq(commitments.sourceMessageId, messageId), eq(commitments.substance, substance)))
    .limit(1);

  const deadline = resolveDeadline(record, timezone);
  // An unresolved holder leaves this unowned rather than guessing. An unowned commitment
  // is a real and useful state; a wrongly attributed one is a promise put in someone's
  // mouth.
  const ownerPersonId = holder.kind === "person" ? holder.personId : null;

  if (existing[0] !== undefined) {
    return {
      outcome: "duplicate",
      commitmentId: existing[0].id,
      unowned: ownerPersonId === null,
      undated: deadline === null,
    };
  }

  const inserted = await db
    .insert(commitments)
    .values({
      substance,
      ownerPersonId,
      promisedAt: statedAt,
      deadline,
      sourceMessageId: messageId,
      status: "open",
    })
    .returning({ id: commitments.id });

  const commitmentId = inserted[0]?.id;
  if (commitmentId === undefined) {
    throw new Error(`Failed to record a commitment from message ${messageId}`);
  }

  return {
    outcome: "recorded",
    commitmentId,
    unowned: ownerPersonId === null,
    undated: deadline === null,
  };
}

/** Words that report something finished. One of these is necessary but not sufficient. */
const COMPLETION =
  /\b(done|did it|sorted|sorted out|finished|completed|handled|took care of|picked up|dropped off|called them|spoke to|sent|paid|fixed|delivered|collected|submitted|closed|all set|taken care of)\b/i;

/** Words carrying no subject matter, excluded before overlap is measured. */
const OVERLAP_STOPWORDS = new Set([
  "i",
  "we",
  "you",
  "he",
  "she",
  "they",
  "it",
  "me",
  "us",
  "them",
  "will",
  "shall",
  "would",
  "can",
  "could",
  "should",
  "must",
  "have",
  "has",
  "had",
  "do",
  "did",
  "done",
  "be",
  "am",
  "is",
  "are",
  "was",
  "were",
  "been",
  "to",
  "of",
  "in",
  "on",
  "at",
  "for",
  "and",
  "or",
  "but",
  "with",
  "from",
  "by",
  "about",
  "this",
  "that",
  "these",
  "those",
  "my",
  "our",
  "their",
  "get",
  "got",
  "go",
  "going",
  "now",
  "today",
  "tomorrow",
  "yesterday",
  "just",
  "also",
  "all",
  "set",
  "up",
  "out",
  "off",
]);

/**
 * Trims the inflection off a word, crudely.
 *
 * Necessary rather than decorative: a promise is written in the future tense and its
 * fulfilment in the past, so "I'll **call** the printers" and "**called** the printers"
 * share the verb only after this. Without it the overlap score collapsed and a plainly
 * matching report failed to close anything.
 *
 * Left deliberately shallow — no stemmer library for four suffixes, and short words are
 * untouched so "call" and "sent" survive intact.
 */
function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** Significant, de-inflected words in a phrase, for overlap. */
function contentWords(text: string): Set<string> {
  return new Set(
    normaliseAssetKey(text)
      .split(" ")
      .filter((word) => word.length > 2 && !OVERLAP_STOPWORDS.has(word))
      .map(stem),
  );
}

/**
 * How much of what was promised the later message actually mentions.
 *
 * Measured against the *commitment's* content words rather than the message's, because a
 * long chatty message that happens to mention the printers should still close a promise
 * about the printers — while a short "done" that mentions nothing should not close
 * anything at all.
 */
export function substanceOverlap(substance: string, text: string): number {
  const promised = contentWords(substance);
  if (promised.size === 0) return 0;
  const said = contentWords(text);

  let shared = 0;
  for (const word of promised) if (said.has(word)) shared += 1;
  return shared / promised.size;
}

/**
 * How much of the promise a message must mention before it can close it.
 *
 * Half, which needs at least two of four content words to line up. Chosen so "called the
 * printers, all sorted" closes "I'll call the printers tomorrow" while "sent the photos"
 * does not — and deliberately not lower, because a false close drops a loose end nobody
 * is tracking any more.
 */
export const CLOSURE_OVERLAP_THRESHOLD = 0.5;

export interface ClosureCandidate {
  commitmentId: string;
  substance: string;
  overlap: number;
}

export interface DetectedClosure {
  closed: ClosureCandidate[];
  /** True when the message reads as a completion report at all. */
  soundedComplete: boolean;
}

export interface DetectClosureInput {
  messageId: string;
  text: string | null;
  sentAt: Date;
  /**
   * The sender. Their own promises are checked first, but an unowned commitment can be
   * closed by anyone — that is what makes "someone should sort the printers / done, sorted
   * the printers" work.
   */
  personId: string | null;
}

/**
 * Notices that an open promise has been kept. `[F8]`
 *
 * Only looks at commitments promised **before** this message: a promise cannot be
 * fulfilled by something said earlier, and without the bound a backfill replaying six
 * months in order would close promises with messages that predate them.
 */
export async function detectCommitmentClosure(
  db: Executor,
  { messageId, text, sentAt, personId }: DetectClosureInput,
): Promise<DetectedClosure> {
  if (text === null || !COMPLETION.test(text)) {
    return { closed: [], soundedComplete: false };
  }

  const open = await db
    .select({
      id: commitments.id,
      substance: commitments.substance,
      ownerPersonId: commitments.ownerPersonId,
    })
    .from(commitments)
    .where(
      and(
        eq(commitments.status, "open"),
        // Strictly earlier: a promise cannot be kept before it was made.
        sql`${commitments.promisedAt} < ${sentAt.toISOString()}::timestamptz`,
      ),
    );

  const closed: ClosureCandidate[] = [];

  for (const commitment of open) {
    // Someone else reporting that a third party's promise is done is hearsay about a
    // commitment, and closing on it would take a loose end off the register on someone
    // else's word. Only the owner, or anyone at all when nobody owns it.
    const mayClose = commitment.ownerPersonId === null || commitment.ownerPersonId === personId;
    if (!mayClose) continue;

    const overlap = substanceOverlap(commitment.substance, text);
    if (overlap < CLOSURE_OVERLAP_THRESHOLD) continue;

    await db
      .update(commitments)
      .set({
        status: "completed",
        completionEvidenceMessageId: messageId,
        closedAt: sentAt,
      })
      .where(eq(commitments.id, commitment.id));

    closed.push({ commitmentId: commitment.id, substance: commitment.substance, overlap });
  }

  return { closed, soundedComplete: true };
}

/** Open commitments, for the `assess` and `brief` contexts. */
export async function selectOpenCommitments(
  db: Executor,
  ownerPersonId?: string,
): Promise<
  {
    id: string;
    substance: string;
    ownerPersonId: string | null;
    promisedAt: Date;
    deadline: Date | null;
    sourceMessageId: string;
  }[]
> {
  const where =
    ownerPersonId === undefined
      ? eq(commitments.status, "open")
      : and(eq(commitments.status, "open"), eq(commitments.ownerPersonId, ownerPersonId));

  return db
    .select({
      id: commitments.id,
      substance: commitments.substance,
      ownerPersonId: commitments.ownerPersonId,
      promisedAt: commitments.promisedAt,
      deadline: commitments.deadline,
      sourceMessageId: commitments.sourceMessageId,
    })
    .from(commitments)
    .where(where)
    .orderBy(commitments.promisedAt);
}

/** Records that a commitment was asked about, so it is never asked about twice. */
export async function markCommitmentAsked(
  db: Executor,
  commitmentId: string,
  at: Date,
): Promise<boolean> {
  // Ask-once-then-stop, enforced in data rather than in a prompt: a prompt cannot
  // remember that it already asked, and a timestamp can.
  const rows = await db
    .update(commitments)
    .set({ askedOnceAt: at })
    .where(and(eq(commitments.id, commitmentId), isNull(commitments.askedOnceAt)))
    .returning({ id: commitments.id });
  return rows.length > 0;
}
