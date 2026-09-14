/**
 * The `messages` table — intake persistence. `[F1]` `[F4]` `[F5]`
 *
 * Intake persists and nothing more. No curation happens here: the poll loop must
 * never block on a model call, or one slow Curator stalls the live demo at exactly
 * the wrong moment.
 *
 * **Everything is an upsert on `(chat_id, telegram_message_id)`.** The polling
 * offset may be committed after processing, so reprocessing the same update after a
 * crash is expected rather than exceptional, and an insert would duplicate six
 * months of history on the first restart.
 *
 * The subtle part is when reprocessing must *undo* curation. An edit means the
 * derived facts came from text that no longer exists, so `curated_at` and the
 * pre-filter verdict have to be cleared and the message re-curated. A crash replay
 * of identical text must not clear them, or every restart re-curates the entire
 * transcript at real cost.
 *
 * Both are the same rule, expressed against the content rather than against the
 * update type: **clear the curation state exactly when the content hash changes.**
 * That is stronger than keying off `edited_message`, because it is also correct for
 * a replayed edit, for a seeded edit arriving as two events, and for any future path
 * that writes a message twice.
 */

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { NormalisedMessage } from "@baton/core";
import { upsertPersonByTelegramId } from "./people.js";
import type { Executor } from "./types.js";

const { messages, people } = schema;

/** Kept small enough that one `in (...)` list stays inside sane parameter limits. */
const CURATED_CHUNK = 500;

export interface PersistedMessage {
  /** The local row id, which everything downstream references. */
  id: string;
  telegramMessageId: number;
  /**
   * Whether this insert created the row. Feeds the `runs` counters, so "read 400"
   * can be told apart from "re-read 400 after a restart".
   */
  isNew: boolean;
}

export interface PersistMessageOptions {
  /**
   * An explicitly resolved sender, for seeded messages. The transcript identifies
   * senders by plan id, which only the backfill script can map to a `people` row,
   * so it resolves the sender and passes it in rather than this module guessing.
   */
  senderPersonId?: string | null;
  /**
   * Whether this message is a question directed at Baton.
   *
   * Passed in rather than derived, because both signals — an @-mention and a reply to one
   * of the bot's own messages — need things only the raw Telegram update carries: the
   * bot's username, and the replied-to message's sender. `NormalisedMessage` deliberately
   * has neither.
   */
  isQuestionToBot?: boolean;
}

/** Resolves a Telegram message id to the local row id, within one chat. */
export async function findMessageIdByTelegramId(
  db: Executor,
  chatId: number,
  telegramMessageId: number,
): Promise<string | null> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.telegramMessageId, telegramMessageId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** What `dispositionOfReply` needs about a stored message, and nothing more. */
export interface ReplyContext {
  messageId: string;
  senderPersonId: string | null;
  text: string;
  sentAt: Date;
}

/**
 * Reads back the fields a reply disposition needs.
 *
 * `persistMessage` returns only the row id, because that is all the intake loop needs to
 * carry the message forward. Deciding whether a reply *answers an approval* needs the
 * sender and the text as stored — as stored specifically, because an edited message must
 * be judged on the text the group can currently see, not on what the update happened to
 * carry.
 *
 * A null `senderPersonId` is returned rather than treated as an error: an unresolved
 * sender is a legitimate state, and the approval gate is what refuses it.
 */
export async function findReplyContext(
  db: Executor,
  messageId: string,
): Promise<ReplyContext | null> {
  const rows = await db
    .select({
      id: messages.id,
      senderPersonId: messages.senderPersonId,
      text: messages.text,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    messageId: row.id,
    senderPersonId: row.senderPersonId,
    text: row.text ?? "",
    sentAt: row.sentAt,
  };
}

/**
 * Persists one normalised message.
 *
 * The sender is resolved to a `people` row where there is a Telegram account to
 * resolve. Where there is not — seventeen of the twenty seeded volunteers — the
 * caller supplies the person, and failing that the row keeps its display name and no
 * person reference, which is a legitimate state rather than an error.
 */
export async function persistMessage(
  db: Executor,
  message: NormalisedMessage,
  options: PersistMessageOptions = {},
): Promise<PersistedMessage> {
  const senderPersonId =
    options.senderPersonId !== undefined
      ? options.senderPersonId
      : message.senderTelegramUserId !== null
        ? await upsertPersonByTelegramId(db, {
            telegramUserId: message.senderTelegramUserId,
            displayName: message.senderDisplayName ?? String(message.senderTelegramUserId),
          })
        : null;

  // Resolved before the write, and left null when the parent is not held. A reply to
  // a message from before Baton joined is ordinary, not an error, and the foreign key
  // would reject a fabricated pointer.
  const replyToMessageId =
    message.replyToTelegramMessageId === null
      ? null
      : await findMessageIdByTelegramId(db, message.chatId, message.replyToTelegramMessageId);

  const rows = await db
    .insert(messages)
    .values({
      source: message.source,
      chatId: message.chatId,
      telegramMessageId: message.telegramMessageId,
      senderPersonId,
      senderTelegramUserId: message.senderTelegramUserId,
      senderDisplayName: message.senderDisplayName,
      sentAt: message.sentAt,
      text: message.text,
      contentHash: message.contentHash,
      replyToTelegramMessageId: message.replyToTelegramMessageId,
      replyToMessageId,
      isForwarded: message.isForwarded,
      forwardedFrom: message.forwardedFrom,
      isEdited: message.isEdited,
      editedAt: message.editedAt,
      isUnprocessed: message.isUnprocessed,
      mediaKind: message.mediaKind,
      isQuestionToBot: options.isQuestionToBot ?? false,
    })
    .onConflictDoUpdate({
      target: [messages.chatId, messages.telegramMessageId],
      set: {
        senderPersonId: sql`coalesce(excluded.sender_person_id, ${messages.senderPersonId})`,
        senderTelegramUserId: sql`excluded.sender_telegram_user_id`,
        senderDisplayName: sql`excluded.sender_display_name`,
        text: sql`excluded.text`,
        contentHash: sql`excluded.content_hash`,
        replyToTelegramMessageId: sql`excluded.reply_to_telegram_message_id`,
        // Kept if already resolved: the parent may have arrived since, and losing a
        // resolved pointer would break a provenance chain the UI renders.
        replyToMessageId: sql`coalesce(excluded.reply_to_message_id, ${messages.replyToMessageId})`,
        isForwarded: sql`excluded.is_forwarded`,
        forwardedFrom: sql`excluded.forwarded_from`,
        isEdited: sql`excluded.is_edited`,
        editedAt: sql`coalesce(excluded.edited_at, ${messages.editedAt})`,
        isUnprocessed: sql`excluded.is_unprocessed`,
        mediaKind: sql`excluded.media_kind`,

        // An edit can add or remove the @-mention, so this follows the new text. It is
        // not part of the content-hash reset below because it is not derived from the
        // text alone — the reply signal comes from the update — so the caller's freshly
        // computed value is the authority.
        isQuestionToBot: sql`excluded.is_question_to_bot`,
        // Cleared with the curation state when the content changes, so an edited question
        // is answered again against what it now says. A replay of identical text keeps the
        // answer and stays quiet.
        questionAnsweredAt: sql`case when excluded.content_hash <> ${messages.contentHash} then null else ${messages.questionAnsweredAt} end`,

        // The curation reset, driven by content rather than by update type. An edit
        // clears these and re-curates; a crash replay of identical text does not.
        curatedAt: sql`case when excluded.content_hash <> ${messages.contentHash} then null else ${messages.curatedAt} end`,
        prefilterVerdict: sql`case when excluded.content_hash <> ${messages.contentHash} then null else ${messages.prefilterVerdict} end`,
        prefilterVersion: sql`case when excluded.content_hash <> ${messages.contentHash} then null else ${messages.prefilterVersion} end`,
      },
    })
    // `xmax = 0` distinguishes an insert from an ON CONFLICT update: Postgres leaves
    // xmax at zero on a fresh insert and stamps it with the updating transaction
    // otherwise. A system-column trick, but the alternative is a second round trip
    // per message across four and a half thousand of them.
    .returning({ id: messages.id, isNew: sql<boolean>`(xmax = 0)` });

  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `Failed to persist message ${message.telegramMessageId} in chat ${message.chatId}`,
    );
  }
  return { id: row.id, telegramMessageId: message.telegramMessageId, isNew: row.isNew };
}

/**
 * Persists a run of messages, in the order given.
 *
 * Order matters and is the caller's responsibility: a reply can only resolve to a
 * parent already stored, so intake feeds messages in `sent_at` order. Deliberately
 * does **not** open its own transaction — the caller owns that scope, because
 * backfill wants to chunk four and a half thousand messages while the live intake
 * loop wants one small transaction per poll.
 */
export async function persistMessages(
  db: Executor,
  batch: readonly NormalisedMessage[],
): Promise<PersistedMessage[]> {
  const persisted: PersistedMessage[] = [];
  for (const message of batch) {
    persisted.push(await persistMessage(db, message));
  }
  return persisted;
}

/**
 * Stamps messages as curated.
 *
 * `curated_at` is the instant curation *happened*, not the instant the message was
 * sent — it answers "has this been through the Curator", and backfilling six months
 * would otherwise stamp every row with a date in the past and make a re-run
 * indistinguishable from a first run.
 *
 * Written after derivation rather than before. A crash between the model call and the
 * writes leaves the message uncurated, so the next pass retries it — and the retry is
 * free, because the Curator's answer is already in the cache. Stamping first would
 * turn the same crash into a message silently skipped forever, which is the one
 * failure this pipeline cannot detect on its own.
 */
export async function markMessagesCurated(
  db: Executor,
  ids: readonly string[],
  at: Date = new Date(),
): Promise<number> {
  if (ids.length === 0) return 0;

  let updated = 0;
  for (let index = 0; index < ids.length; index += CURATED_CHUNK) {
    const chunk = ids.slice(index, index + CURATED_CHUNK);
    const rows = await db
      .update(messages)
      .set({ curatedAt: at })
      .where(inArray(messages.id, chunk))
      .returning({ id: messages.id });
    updated += rows.length;
  }
  return updated;
}

export interface PendingQuestion {
  id: string;
  /** Telegram's own id, so the answer can be threaded as a reply to the question. */
  telegramMessageId: number;
  text: string;
  sentAt: Date;
  senderPersonId: string | null;
  senderMention: string;
}

/**
 * Questions to Baton that have not been answered.
 *
 * Ordered oldest first: a question asked twenty minutes ago should be answered before one
 * asked two minutes ago, and answering the newest first is how a backlog after a restart
 * reads as though Baton had ignored everyone but the last person to speak.
 *
 * Withdrawn messages are excluded. Withdrawal is the coordinator's only remedy for
 * something that should not have been said, and answering a withdrawn question would quote
 * it back to the group.
 */
export async function selectUnansweredQuestions(
  db: Executor,
  limit = 5,
): Promise<PendingQuestion[]> {
  const rows = await db
    .select({
      id: messages.id,
      telegramMessageId: messages.telegramMessageId,
      text: messages.text,
      sentAt: messages.sentAt,
      senderPersonId: messages.senderPersonId,
      senderDisplayName: messages.senderDisplayName,
      personDisplayName: people.displayName,
    })
    .from(messages)
    .leftJoin(people, eq(people.id, messages.senderPersonId))
    .where(
      and(
        eq(messages.isQuestionToBot, true),
        isNull(messages.questionAnsweredAt),
        eq(messages.isWithdrawn, false),
        isNotNull(messages.text),
      ),
    )
    .orderBy(messages.sentAt)
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    telegramMessageId: row.telegramMessageId,
    text: row.text ?? "",
    sentAt: row.sentAt,
    senderPersonId: row.senderPersonId,
    senderMention: row.personDisplayName ?? row.senderDisplayName ?? "someone",
  }));
}

/**
 * Stamps a question as answered, once.
 *
 * `where question_answered_at is null ... returning` means this succeeds exactly once, so
 * two passes racing on the same question cannot both send a reply. Stamped **after** the
 * reply is sent, for the same reason `curated_at` is: a crash before the send leaves it
 * unanswered and the next pass retries, whereas stamping first would drop the question
 * silently.
 */
export async function markQuestionAnswered(
  db: Executor,
  messageId: string,
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ questionAnsweredAt: at })
    .where(and(eq(messages.id, messageId), isNull(messages.questionAnsweredAt)))
    .returning({ id: messages.id });
  return rows.length > 0;
}
