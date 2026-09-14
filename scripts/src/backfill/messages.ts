/**
 * Message loading — the transcript into `messages`, through the shared normaliser.
 *
 * **Interim implementation.** The checklist's *Worker — backfill* section specifies that
 * this file goes away: stage two drives the worker's own `persistMessage` and
 * `runIngestPass` so that backfill and live traffic share one insert path rather than
 * two. That rewrite needs `apps/worker` to expose those modules, which it does not yet,
 * so this keeps its own insert in the meantime. It is the second insert path the design
 * warns about, and it is here on borrowed time — the mitigation is that every field it
 * writes comes from `expandRenderedMessage`, so the *normalisation* is shared even while
 * the insert is not.
 *
 * Four properties this has to have, each of which is a real failure otherwise:
 *
 *   - **Strict `sent_at` ordering.** Supersession is order-dependent, so processing a
 *     contradiction backwards silently inverts a fact. The transcript is sorted here
 *     rather than trusted to be in order.
 *   - **Upsert on `(chat_id, telegram_message_id)`.** Re-running backfill must not
 *     duplicate the transcript. The same constraint is what makes the live loop safe
 *     to reprocess after a crash, since the polling offset may be committed after
 *     processing.
 *   - **A verdict for every message**, kept and discarded alike, with
 *     `prefilter_version`. A discard with no recorded verdict cannot be re-examined
 *     when the filter improves, so it is lost rather than merely rejected.
 *   - **`senderPersonId` passed explicitly.** Seventeen of the twenty volunteers have no
 *     Telegram account, so resolving senders through `senderTelegramUserId` would
 *     attribute seventeen people's messages to nobody — and nothing would report it.
 *
 * Inserted in chunks because a single 4,400-row statement with twenty-odd columns each
 * is a very large parameter list, and chunking costs nothing once the order is fixed.
 */

import { sql } from "drizzle-orm";
import { prefilter } from "@baton/core";
import { messages, type Database } from "@baton/core/db";
import { expandRenderedMessage, type SeedRenderedMessage } from "@baton/core/intake";

/** Rows per insert statement. Large enough to be fast, small enough to stay legible. */
const CHUNK_SIZE = 500;

export interface LoadMessagesResult {
  read: number;
  candidates: number;
  discarded: number;
  unprocessed: number;
  /** Edited records replayed as a second upsert over the original. */
  edits: number;
}

export interface LoadMessagesOptions {
  chatId: number;
  /** Plan person id → `people` row id. Every sender resolves through this. */
  personIdByPlanId: ReadonlyMap<string, string>;
  /** Plan person id → real Telegram user id, for the two or three bound accounts. */
  telegramUserIdByPlanId: ReadonlyMap<string, number>;
}

export async function loadMessages(
  db: Database,
  transcript: readonly SeedRenderedMessage[],
  options: LoadMessagesOptions,
): Promise<LoadMessagesResult> {
  // Strict `sent_at` order. Ties break on the message id so the order is total and a
  // re-run produces the same sequence rather than an arbitrary one.
  const ordered = [...transcript].sort((a, b) => {
    const byTime = Date.parse(a.sentAt) - Date.parse(b.sentAt);
    return byTime !== 0 ? byTime : a.telegramMessageId - b.telegramMessageId;
  });

  const toRow = (
    rendered: SeedRenderedMessage,
    normalised: ReturnType<typeof expandRenderedMessage>[number],
  ) => {
    const verdict = prefilter({
      text: normalised.text,
      isUnprocessed: normalised.isUnprocessed,
    });

    return {
      ...normalised,
      senderPersonId: options.personIdByPlanId.get(rendered.senderPlanId) ?? null,
      prefilterVerdict: verdict.verdict,
      prefilterVersion: verdict.version,
    };
  };

  const originals: ReturnType<typeof toRow>[] = [];
  // Edited variants share their original's `telegramMessageId`, which is the point — the
  // edit is an upsert onto the row the original created, exactly as an `edited_message`
  // update is. They cannot travel in the same statement as their original, though:
  // Postgres rejects an INSERT whose ON CONFLICT target is hit twice by one command. So
  // they are applied afterwards, one at a time, in order.
  const edits: ReturnType<typeof toRow>[] = [];

  for (const rendered of ordered) {
    const expanded = expandRenderedMessage(rendered, {
      chatId: options.chatId,
      telegramUserIdFor: (planId) => options.telegramUserIdByPlanId.get(planId) ?? null,
    });

    const [original, edited] = expanded;
    if (original === undefined) continue;

    originals.push(toRow(rendered, original));
    if (edited !== undefined) edits.push(toRow(rendered, edited));
  }

  // A re-run is a no-op on rows that already exist rather than an error. The verdict
  // adopts `excluded` — the values this statement was about to insert — so a bumped
  // `prefilter_version` takes effect without reloading the transcript. Re-asserting the
  // stored value instead would make a filter improvement invisible.
  //
  // Not `as const`: Drizzle's conflict target is a mutable `IndexColumn[]`.
  const conflictTarget = [messages.chatId, messages.telegramMessageId];

  for (let start = 0; start < originals.length; start += CHUNK_SIZE) {
    await db
      .insert(messages)
      .values(originals.slice(start, start + CHUNK_SIZE))
      .onConflictDoUpdate({
        target: conflictTarget,
        set: {
          prefilterVerdict: sql`excluded.prefilter_verdict`,
          prefilterVersion: sql`excluded.prefilter_version`,
        },
      });
  }

  // The edit overwrites the text it replaced, so `text`, `content_hash` and `is_edited`
  // must land too — not only the verdict. A changed `content_hash` is what makes the
  // edited text miss the curator cache and be re-curated.
  for (const edit of edits) {
    await db
      .insert(messages)
      .values(edit)
      .onConflictDoUpdate({
        target: conflictTarget,
        set: {
          text: sql`excluded.text`,
          contentHash: sql`excluded.content_hash`,
          isEdited: sql`excluded.is_edited`,
          prefilterVerdict: sql`excluded.prefilter_verdict`,
          prefilterVersion: sql`excluded.prefilter_version`,
          curatedAt: null,
        },
      });
  }

  return {
    read: originals.length,
    candidates: originals.filter((row) => row.prefilterVerdict === "candidate").length,
    discarded: originals.filter((row) => row.prefilterVerdict === "discarded").length,
    unprocessed: originals.filter((row) => row.isUnprocessed).length,
    edits: edits.length,
  };
}
