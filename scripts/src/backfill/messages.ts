/**
 * Message loading — the transcript into `messages`, through the shared normaliser.
 *
 * Three properties this has to have, each of which is a real failure otherwise:
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
 *
 * Inserted in chunks because a single 4,400-row statement with twenty-odd columns each
 * is a very large parameter list, and chunking costs nothing once the order is fixed.
 */

import { sql } from "drizzle-orm";
import { messages, type Database } from "@baton/core/db";
import { normaliseSeedMessage, prefilter, type SeedMessage } from "@baton/core/intake";

/** Rows per insert statement. Large enough to be fast, small enough to stay legible. */
const CHUNK_SIZE = 500;

export interface LoadMessagesResult {
  read: number;
  candidates: number;
  discarded: number;
  unprocessed: number;
}

export async function loadMessages(
  db: Database,
  transcript: readonly SeedMessage[],
  options: { chatId: number; personIdByPlanId: ReadonlyMap<string, string> },
): Promise<LoadMessagesResult> {
  // Strict `sent_at` order. Ties break on the message id so the order is total and a
  // re-run produces the same sequence rather than an arbitrary one.
  const ordered = [...transcript].sort((a, b) => {
    const byTime = Date.parse(a.sentAt) - Date.parse(b.sentAt);
    return byTime !== 0 ? byTime : a.telegramMessageId - b.telegramMessageId;
  });

  const rows = ordered.map((message) => {
    const normalised = normaliseSeedMessage(message, {
      chatId: options.chatId,
      personIdByPlanId: options.personIdByPlanId,
    });

    const verdict = prefilter({ text: normalised.text, mediaKind: normalised.mediaKind });

    return {
      ...normalised,
      prefilterVerdict: verdict.verdict,
      prefilterVersion: verdict.version,
    };
  });

  for (let start = 0; start < rows.length; start += CHUNK_SIZE) {
    await db
      .insert(messages)
      .values(rows.slice(start, start + CHUNK_SIZE))
      // A re-run is a no-op on rows that already exist rather than an error. The
      // verdict adopts `excluded` — the values this statement was about to insert — so
      // a bumped `prefilter_version` takes effect without reloading the transcript.
      // Re-asserting the stored value instead would make a filter improvement invisible.
      .onConflictDoUpdate({
        target: [messages.chatId, messages.telegramMessageId],
        set: {
          prefilterVerdict: sql`excluded.prefilter_verdict`,
          prefilterVersion: sql`excluded.prefilter_version`,
        },
      });
  }

  return {
    read: rows.length,
    candidates: rows.filter((row) => row.prefilterVerdict === "candidate").length,
    discarded: rows.filter((row) => row.prefilterVerdict === "discarded").length,
    unprocessed: rows.filter((row) => row.isUnprocessed).length,
  };
}
