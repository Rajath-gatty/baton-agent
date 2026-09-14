/**
 * The one internal message shape, and the outside shapes it is built from. `[F1]`
 *
 * Two sources feed this: live Telegram updates, and the rendered seed transcript.
 * They must arrive at an identical shape, because everything downstream — the
 * pre-filter, the curator cache, fact extraction, provenance — runs on this type
 * alone and cannot tell the two apart. That is the point: a second insert path for
 * seeded messages would be a second normaliser, and the two would drift on exactly
 * the fields nobody thinks to check.
 *
 * The Telegram types here are **structural and partial** on purpose. Only the
 * fields Baton actually reads are declared, so this doubles as the record of what
 * the product depends on in the Bot API, and no dependency is taken on a
 * generated-types package that would have to be kept current.
 */

import type { MediaKind, MessageSource } from "../constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// The internal shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One message, normalised. Maps almost column-for-column onto `messages`.
 *
 * Ids stay `number` rather than `bigint` because Telegram's ids sit far inside
 * the safe integer range and the schema declares its `bigint` columns with
 * `mode: "number"` for the same reason.
 */
export interface NormalisedMessage {
  source: MessageSource;
  chatId: number;
  telegramMessageId: number;

  /** Null for a seeded person never bound to a real account — 17 of the 20. */
  senderTelegramUserId: number | null;
  /** Kept even once the sender resolves, so a quote reads as it did that day. */
  senderDisplayName: string | null;

  sentAt: Date;
  /** Null for media carrying no caption. */
  text: string | null;
  /** Over the text exactly as stored, so an edit misses the curator cache. */
  contentHash: string;

  replyToTelegramMessageId: number | null;

  /** Attributed to the forwarder; the original author is not ours to claim. */
  isForwarded: boolean;
  forwardedFrom: string | null;

  isEdited: boolean;
  /**
   * Null when the source cannot say. The seed artifact records that a message was
   * edited but not when, and inventing a timestamp there would put a fabricated
   * date on a provenance surface.
   */
  editedAt: Date | null;

  /**
   * Non-text media with nothing to curate. Logged rather than dropped, so a voice
   * note that carried a fact is at least visible as a gap.
   */
  isUnprocessed: boolean;
  mediaKind: MediaKind | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why an update was not turned into a message.
 *
 * Enumerated rather than a boolean because the intake loop counts these, and
 * "dropped 400 updates" is only actionable if it says which kind.
 */
export type IgnoreReason =
  | "foreign_chat"
  | "own_message"
  | "no_sender"
  | "empty_message"
  | "unsupported_update";

/** Whether a person entered or left the group. */
export type MembershipTransition = "joined" | "left" | "unchanged";

export interface MembershipEvent {
  chatId: number;
  at: Date;
  telegramUserId: number;
  displayName: string;
  transition: MembershipTransition;
  /** Telegram's own status word, kept for the record. */
  status: string;
}

/** The bot's own membership changing — what the introduction message fires from. */
export interface BotMembershipEvent {
  chatId: number;
  at: Date;
  status: string;
  isNowMember: boolean;
}

/**
 * Someone messaging the bot directly.
 *
 * **Never ingested as knowledge.** The register holds what the *organisation* knows,
 * and a private message is not something the group said — treating it as a group fact
 * would put a private remark into a brief everyone can read.
 *
 * It is still worth noticing, for exactly one reason: a bot cannot open a conversation
 * with someone who has never written to it first. This is the only moment Baton learns
 * that it *can* reach a person directly, which is what makes a departure brief
 * deliverable to its subject rather than only copyable by the coordinator.
 */
export interface PrivateMessageEvent {
  telegramUserId: number;
  displayName: string;
  /** In a private chat this equals the user's own id, but it is read, not assumed. */
  privateChatId: number;
  at: Date;
  text: string | null;
  /** The bot's own message id this replies to, where it replies to one. */
  replyToTelegramMessageId: number | null;
}

/**
 * A classified update.
 *
 * `message` and `edited_message` carry the identical shape and differ only in the
 * tag, because an edit is an upsert onto the row the original created — same
 * `(chat_id, telegram_message_id)` — not a new message.
 */
export type IntakeOutcome =
  | { kind: "message"; message: NormalisedMessage }
  | { kind: "edited_message"; message: NormalisedMessage }
  | { kind: "chat_member"; event: MembershipEvent }
  | { kind: "my_chat_member"; event: BotMembershipEvent }
  | { kind: "private_message"; event: PrivateMessageEvent }
  | { kind: "ignored"; reason: IgnoreReason };

// ─────────────────────────────────────────────────────────────────────────────
// Telegram, partially
// ─────────────────────────────────────────────────────────────────────────────

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
}

/** Bot API 7.0+ replaced the `forward_from*` fields with this. Both are read. */
export interface TelegramForwardOrigin {
  type: string;
  sender_user?: TelegramUser;
  sender_user_name?: string;
  sender_chat?: TelegramChat;
  chat?: TelegramChat;
  author_signature?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  /** Unix seconds. */
  date: number;
  edit_date?: number;
  chat: TelegramChat;

  text?: string;
  /** A photo or document may carry its text here instead. */
  caption?: string;

  /**
   * `from` is read here and nowhere else in this shape, and only for one purpose:
   * deciding whether a message is a reply **to Baton**. That is one of the two signals
   * that make a message a question directed at it, and the bot's own messages are never
   * stored — so this is the only place the fact is available.
   */
  reply_to_message?: { message_id: number; from?: TelegramUser };

  forward_origin?: TelegramForwardOrigin;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_sender_name?: string;

  // Media. Only presence is read, never contents — Baton does not download files.
  photo?: unknown[];
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  video_note?: unknown;
  animation?: unknown;
  document?: unknown;
  sticker?: unknown;
  contact?: unknown;
  location?: unknown;
  venue?: unknown;
  poll?: unknown;
  dice?: unknown;
}

export interface TelegramChatMember {
  user: TelegramUser;
  status: string;
  /** `restricted` members are still in the group unless this is false. */
  is_member?: boolean;
}

export interface TelegramChatMemberUpdated {
  chat: TelegramChat;
  from: TelegramUser;
  date: number;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  chat_member?: TelegramChatMemberUpdated;
  my_chat_member?: TelegramChatMemberUpdated;
}

// ─────────────────────────────────────────────────────────────────────────────
// The seed transcript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One record from `scripts/out/seed-transcript.json`.
 *
 * Declared here rather than imported from `scripts`, which would invert the
 * dependency — the seed scripts already import this package. `RenderedMessage` in
 * `scripts/src/seed/plan-types.ts` is structurally assignable to this, and the
 * scripts workspace asserts that so the two cannot drift silently.
 *
 * The fields after `mediaKind` are the renderer's own bookkeeping for its coverage
 * report and are deliberately absent: they have no column in `messages`.
 */
export interface SeedRenderedMessage {
  telegramMessageId: number;
  /** ISO 8601 with the group's offset. */
  sentAt: string;
  senderPlanId: string;
  senderDisplayName: string;
  text: string | null;
  replyToTelegramMessageId: number | null;
  isForwarded: boolean;
  forwardedFrom: string | null;
  isEdited: boolean;
  /** The text *after* the edit. The pre-edit text stays in `text`. */
  editedText: string | null;
  mediaKind: MediaKind | null;
}

/** The transcript envelope, which the artifact has but no type described until now. */
export interface SeedTranscript {
  planVersion: number;
  months: number;
  windowStart: string;
  windowEnd: string;
  timezone: string;
  source: "seed";
  fillerProvider: string;
  accountBindings: {
    role: string;
    personId: string;
    telegramUserId: number | null;
  }[];
  messages: SeedRenderedMessage[];
}
