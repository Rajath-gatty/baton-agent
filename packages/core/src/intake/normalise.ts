/**
 * The normaliser. `[F1]` `[F4]` `[F5]` `[F35]`
 *
 * One internal message shape, and **one implementation of it**, because seeded
 * messages must enter through the same normaliser as live traffic. A second insert
 * path would be a second normaliser, and the two would drift — the backfill would
 * start producing rows that live intake never produces, and every prompt tuned
 * against the backfill would be tuned against a shape the demo does not have.
 *
 * It lives in `@baton/core/intake` rather than in the worker for exactly that
 * reason: `scripts/backfill.ts` and the worker's poll loop are different processes,
 * and the only way to guarantee they share this code is for there to be one copy
 * neither of them owns. The design describes the pre-filter as being "in the
 * worker", meaning it is deterministic code rather than a model call; that is
 * preserved — the worker is what runs it.
 *
 * This module holds no database client. It converts an input into a row shape and
 * returns it; deciding what to do with that is the caller's job.
 */

import { createHash } from "node:crypto";
import type { MediaKind, MessageSource } from "../constants.js";

/**
 * The one internal message shape.
 *
 * Field names mirror `messages` columns so a caller can insert without a second
 * mapping step — a mapping layer between this and the table would be the third
 * place a field name could drift.
 */
export interface NormalisedMessage {
  source: MessageSource;
  chatId: number;
  telegramMessageId: number;
  /** Resolved by the caller against `people`; the normaliser does not know ids. */
  senderPersonId: string | null;
  senderTelegramUserId: number | null;
  senderDisplayName: string | null;
  sentAt: Date;
  text: string | null;
  contentHash: string;
  replyToTelegramMessageId: number | null;
  isForwarded: boolean;
  forwardedFrom: string | null;
  isEdited: boolean;
  editedAt: Date | null;
  /** Non-text media carries no text to curate, so it is logged as a visible gap. */
  isUnprocessed: boolean;
  mediaKind: MediaKind | null;
}

/**
 * The cache key half that depends on content. `curator_cache` is keyed on this plus
 * `prompt_version`, so it must be stable across runs and identical for identical
 * text — hence the whitespace fold, and hence hashing the text alone rather than
 * anything about who sent it or when.
 *
 * An empty or absent body still gets a hash, because the column is NOT NULL and a
 * media-only message is still a row.
 */
export function contentHash(text: string | null): string {
  const normalised = (text ?? "").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/** A seeded message, as `seed-transcript.ts` writes it. */
export interface SeedMessage {
  telegramMessageId: number;
  sentAt: string;
  senderPlanId: string;
  senderDisplayName: string;
  text: string | null;
  replyToTelegramMessageId: number | null;
  isForwarded: boolean;
  forwardedFrom: string | null;
  isEdited: boolean;
  editedText: string | null;
  mediaKind: MediaKind | null;
}

export interface SeedNormaliseContext {
  chatId: number;
  /** Plan person id → the `people` row id the caller inserted. */
  personIdByPlanId: ReadonlyMap<string, string>;
}

/**
 * Normalises one seeded message.
 *
 * An edited seeded message stores the **edited** text as the body, because that is
 * what the group can currently see and provenance must quote what exists. The flag
 * is kept so the edit is visible as an edit rather than silently becoming the
 * original.
 */
export function normaliseSeedMessage(
  message: SeedMessage,
  context: SeedNormaliseContext,
): NormalisedMessage {
  const text = message.isEdited ? (message.editedText ?? message.text) : message.text;
  const sentAt = new Date(message.sentAt);

  if (Number.isNaN(sentAt.getTime())) {
    throw new Error(
      `Seeded message ${message.telegramMessageId} has an unparseable sentAt: '${message.sentAt}'`,
    );
  }

  const senderPersonId = context.personIdByPlanId.get(message.senderPlanId);
  if (senderPersonId === undefined) {
    // Every seeded sender comes from the plan roster, so a miss means identity was
    // loaded from a different plan than the transcript was rendered from.
    throw new Error(
      `Seeded message ${message.telegramMessageId} names sender '${message.senderPlanId}', ` +
        `who is not in the loaded roster.`,
    );
  }

  return {
    source: "seed",
    chatId: context.chatId,
    telegramMessageId: message.telegramMessageId,
    senderPersonId,
    // Seeded people have no Telegram account except the demo three, and those are
    // bound onto `people` rather than onto every message they sent.
    senderTelegramUserId: null,
    senderDisplayName: message.senderDisplayName,
    sentAt,
    text,
    contentHash: contentHash(text),
    replyToTelegramMessageId:
      message.replyToTelegramMessageId === null ? null : message.replyToTelegramMessageId,
    isForwarded: message.isForwarded,
    forwardedFrom: message.forwardedFrom,
    isEdited: message.isEdited,
    // The seed does not model when an edit happened, only that it did. Recording
    // `sentAt` would assert an edit time the transcript never claimed.
    editedAt: null,
    isUnprocessed: message.mediaKind !== null && (text ?? "").trim() === "",
    mediaKind: message.mediaKind,
  };
}

/** The shape the live poll loop will hand in, kept minimal on purpose. */
export interface TelegramMessageLike {
  message_id: number;
  date: number;
  chat: { id: number };
  from?: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number };
  forward_origin?: { type: string; sender_user_name?: string; chat?: { title?: string } };
  edit_date?: number;
  photo?: unknown;
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  document?: unknown;
  sticker?: unknown;
}

export interface TelegramNormaliseContext {
  /** Only this chat is processed. Messages from anywhere else are ignored. */
  chatId: number;
  /** The bot's own user id, so its messages are dropped at intake. */
  botUserId: number;
  /** Telegram user id → `people` row id, for senders already known. */
  personIdByTelegramUserId: ReadonlyMap<string, string>;
}

/** Which media a message carries, if any. Order is only for determinism. */
export function mediaKindOf(message: TelegramMessageLike): MediaKind | null {
  if (message.photo !== undefined) return "photo";
  if (message.voice !== undefined) return "voice";
  if (message.audio !== undefined) return "audio";
  if (message.video !== undefined) return "video";
  if (message.document !== undefined) return "document";
  if (message.sticker !== undefined) return "sticker";
  return null;
}

/**
 * Normalises one live Telegram message, or returns null when it must be ignored.
 *
 * Two drops, both of which are silent corruption if missed:
 *
 *   - **A message from an unconfigured chat.** Only the configured chat is processed.
 *   - **A message from Baton itself.** Without this, a stale figure it repeated comes
 *     back as a freshly confirmed fact — a corruption loop with no visible symptom.
 */
export function normaliseTelegramMessage(
  message: TelegramMessageLike,
  context: TelegramNormaliseContext,
): NormalisedMessage | null {
  if (message.chat.id !== context.chatId) return null;

  const from = message.from;
  if (from !== undefined && from.id === context.botUserId) return null;

  const text = message.text ?? message.caption ?? null;
  const mediaKind = mediaKindOf(message);

  // A forward is attributed to the forwarder — they are the one who put it in front
  // of the group — and flagged, so the register can show it was not their own words.
  const forwardOrigin = message.forward_origin;
  const forwardedFrom =
    forwardOrigin === undefined
      ? null
      : (forwardOrigin.sender_user_name ?? forwardOrigin.chat?.title ?? forwardOrigin.type);

  const senderTelegramUserId = from === undefined ? null : from.id;
  const senderPersonId =
    senderTelegramUserId === null
      ? null
      : (context.personIdByTelegramUserId.get(String(senderTelegramUserId)) ?? null);

  const displayName =
    from === undefined ? null : (from.username ?? from.first_name ?? String(from.id));

  return {
    source: "telegram",
    chatId: context.chatId,
    telegramMessageId: message.message_id,
    senderPersonId,
    senderTelegramUserId,
    senderDisplayName: displayName,
    // Telegram sends seconds; JavaScript wants milliseconds.
    sentAt: new Date(message.date * 1000),
    text,
    contentHash: contentHash(text),
    replyToTelegramMessageId:
      message.reply_to_message === undefined ? null : message.reply_to_message.message_id,
    isForwarded: forwardOrigin !== undefined,
    forwardedFrom,
    isEdited: message.edit_date !== undefined,
    editedAt: message.edit_date === undefined ? null : new Date(message.edit_date * 1000),
    isUnprocessed: mediaKind !== null && (text ?? "").trim() === "",
    mediaKind,
  };
}
