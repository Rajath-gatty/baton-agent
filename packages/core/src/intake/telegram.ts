/**
 * The Telegram adapter. `[F1]` `[F4]` `[F5]` `[F35]`
 *
 * Turns one `Update` into one classified outcome. Two rejections happen here and
 * nowhere else, because both are cheap to state and expensive to forget:
 *
 *   - **Baton's own messages are dropped.** Without this it extracts facts from
 *     its own answers, and a stale figure it repeated once returns as a freshly
 *     confirmed fact — a corruption loop with no visible symptom. `[F35]`
 *   - **Messages from any chat but the configured one are ignored.**
 *
 * Nothing here touches the database or the network. It is a pure function of the
 * update and the two configured ids, which is what makes it testable without a bot
 * and identical in behaviour to the seed path.
 */

import type { MediaKind } from "../constants.js";
import { contentHash } from "../normalise.js";
import type {
  BotMembershipEvent,
  IntakeOutcome,
  MembershipEvent,
  MembershipTransition,
  NormalisedMessage,
  PrivateMessageEvent,
  TelegramChatMember,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export interface TelegramIntakeOptions {
  /** The one chat that is processed. */
  chatId: number;
  /**
   * The bot's own user id, from `getMe`. Null only before that call has returned;
   * while it is null nothing can be recognised as the bot's own message, so the
   * intake loop resolves it before polling rather than after.
   */
  botUserId: number | null;
}

/**
 * A person's name as it should be quoted.
 *
 * Prefers the real name over the handle, because that is what a brief reads like.
 * Falls back to the handle and then to the bare id, so this never returns empty and
 * a quote never renders as an anonymous blank.
 */
export function displayNameOf(user: TelegramUser): string {
  const full = [user.first_name, user.last_name].filter((part) => part !== undefined).join(" ");
  if (full.trim() !== "") return full.trim();
  if (user.username !== undefined && user.username !== "") return user.username;
  return String(user.id);
}

/**
 * Which of the seven media kinds this message carries, if any.
 *
 * `video_note` and `animation` fold into `video`: they are videos to a reader, and
 * a distinction Baton never acts on is a distinction not worth a column value.
 * Everything else recognisable but unlisted becomes `other` rather than null,
 * because null means "text message" downstream and a poll is not a text message.
 */
export function mediaKindOf(message: TelegramMessage): MediaKind | null {
  if (message.photo !== undefined) return "photo";
  if (message.voice !== undefined) return "voice";
  if (message.audio !== undefined) return "audio";
  if (message.video !== undefined) return "video";
  if (message.video_note !== undefined) return "video";
  if (message.animation !== undefined) return "video";
  if (message.document !== undefined) return "document";
  if (message.sticker !== undefined) return "sticker";
  if (
    message.contact !== undefined ||
    message.location !== undefined ||
    message.venue !== undefined ||
    message.poll !== undefined ||
    message.dice !== undefined
  ) {
    return "other";
  }
  return null;
}

/**
 * Who a forwarded message came from, as text.
 *
 * Recorded as a plain string rather than a person reference: the original author is
 * not ours to claim, and the message is attributed to the *forwarder*. Reads the
 * Bot API 7.0+ `forward_origin` first, then the legacy fields, because a deployed
 * bot may be talking to either.
 */
export function forwardedFromOf(message: TelegramMessage): string | null {
  const origin = message.forward_origin;
  if (origin !== undefined) {
    if (origin.sender_user !== undefined) return displayNameOf(origin.sender_user);
    if (origin.sender_user_name !== undefined && origin.sender_user_name !== "") {
      return origin.sender_user_name;
    }
    const chat = origin.chat ?? origin.sender_chat;
    if (chat?.title !== undefined && chat.title !== "") return chat.title;
    return origin.type;
  }

  if (message.forward_from !== undefined) return displayNameOf(message.forward_from);
  if (message.forward_sender_name !== undefined && message.forward_sender_name !== "") {
    return message.forward_sender_name;
  }
  if (message.forward_from_chat?.title !== undefined) return message.forward_from_chat.title;
  return null;
}

function isForwarded(message: TelegramMessage): boolean {
  return (
    message.forward_origin !== undefined ||
    message.forward_from !== undefined ||
    message.forward_from_chat !== undefined ||
    message.forward_sender_name !== undefined
  );
}

/** Whether a chat member status means the person is currently in the group. */
export function isPresent(member: TelegramChatMember): boolean {
  switch (member.status) {
    case "creator":
    case "administrator":
    case "member":
      return true;
    // A restricted member may or may not still be in the group; Telegram says which.
    case "restricted":
      return member.is_member !== false;
    default:
      // left, kicked, and anything Telegram adds later that we have not taught
      // ourselves about. Treating an unknown status as absent is the safe default:
      // it produces a departure brief, which is visible, rather than silence.
      return false;
  }
}

function transitionOf(update: {
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
}): MembershipTransition {
  const was = isPresent(update.old_chat_member);
  const now = isPresent(update.new_chat_member);
  if (!was && now) return "joined";
  if (was && !now) return "left";
  return "unchanged";
}

/**
 * Normalises one message. Shared by the `message` and `edited_message` paths, which
 * differ only in the tag they are returned under.
 */
function normaliseMessage(
  message: TelegramMessage,
  options: TelegramIntakeOptions,
): { message: NormalisedMessage } | { reason: "foreign_chat" | "own_message" | "no_sender" } {
  if (message.chat.id !== options.chatId) return { reason: "foreign_chat" };

  const from = message.from;
  if (from === undefined) return { reason: "no_sender" };
  if (options.botUserId !== null && from.id === options.botUserId) return { reason: "own_message" };

  const mediaKind = mediaKindOf(message);
  // A photo's caption is text and is curated normally. Only media with nothing to
  // read is `unprocessed` — the flag marks a gap, not the presence of a file.
  const text = message.text ?? message.caption ?? null;
  const hasText = text !== null && text.trim() !== "";

  return {
    message: {
      source: "telegram",
      chatId: message.chat.id,
      telegramMessageId: message.message_id,
      senderTelegramUserId: from.id,
      senderDisplayName: displayNameOf(from),
      sentAt: new Date(message.date * 1000),
      text: hasText ? text : null,
      contentHash: contentHash(hasText ? text : null),
      replyToTelegramMessageId: message.reply_to_message?.message_id ?? null,
      isForwarded: isForwarded(message),
      forwardedFrom: forwardedFromOf(message),
      isEdited: message.edit_date !== undefined,
      editedAt: message.edit_date === undefined ? null : new Date(message.edit_date * 1000),
      isUnprocessed: mediaKind !== null && !hasText,
      mediaKind,
    },
  };
}

/**
 * Recognises a direct message to the bot, or returns null.
 *
 * Detected on `chat.type` rather than by comparing the chat id to the sender's, because
 * the type is what Telegram actually states and the equality is an implementation
 * detail that happens to hold.
 *
 * Deliberately **not** turned into a `NormalisedMessage`: this is not something the
 * group said, and the register holds what the organisation knows. What it yields is
 * permission to write back.
 */
function asPrivateMessage(
  message: TelegramMessage,
  options: TelegramIntakeOptions,
): PrivateMessageEvent | null {
  if (message.chat.type !== "private") return null;

  const from = message.from;
  if (from === undefined) return null;
  // The bot's own outbound copy, echoed back. Not a person writing in.
  if (options.botUserId !== null && from.id === options.botUserId) return null;

  return {
    telegramUserId: from.id,
    displayName: displayNameOf(from),
    privateChatId: message.chat.id,
    at: new Date(message.date * 1000),
    text: message.text ?? message.caption ?? null,
    replyToTelegramMessageId: message.reply_to_message?.message_id ?? null,
  };
}

function membershipEvent(update: {
  chat: { id: number };
  date: number;
  new_chat_member: TelegramChatMember;
  old_chat_member: TelegramChatMember;
}): MembershipEvent {
  return {
    chatId: update.chat.id,
    at: new Date(update.date * 1000),
    telegramUserId: update.new_chat_member.user.id,
    displayName: displayNameOf(update.new_chat_member.user),
    transition: transitionOf(update),
    status: update.new_chat_member.status,
  };
}

function botMembershipEvent(update: {
  chat: { id: number };
  date: number;
  new_chat_member: TelegramChatMember;
}): BotMembershipEvent {
  return {
    chatId: update.chat.id,
    at: new Date(update.date * 1000),
    status: update.new_chat_member.status,
    isNowMember: isPresent(update.new_chat_member),
  };
}

/**
 * Classifies one update.
 *
 * The four update kinds handled are exactly the four `allowed_updates` requests.
 * Anything else is `unsupported_update` rather than an error: Telegram adds update
 * types, and a worker that threw on an unfamiliar one would stop polling.
 */
export function normaliseUpdate(
  update: TelegramUpdate,
  options: TelegramIntakeOptions,
): IntakeOutcome {
  if (update.message !== undefined) {
    // Checked before the chat filter, which would otherwise dismiss this as a foreign
    // chat and throw away the only signal that Baton can reach this person directly.
    const priv = asPrivateMessage(update.message, options);
    if (priv !== null) return { kind: "private_message", event: priv };

    const result = normaliseMessage(update.message, options);
    return "reason" in result
      ? { kind: "ignored", reason: result.reason }
      : { kind: "message", message: result.message };
  }

  if (update.edited_message !== undefined) {
    const result = normaliseMessage(update.edited_message, options);
    return "reason" in result
      ? { kind: "ignored", reason: result.reason }
      : { kind: "edited_message", message: result.message };
  }

  // `my_chat_member` is checked before `chat_member`: the bot's own membership
  // change arrives on both in some configurations, and the introduction is the
  // more specific behaviour.
  //
  // Deliberately **not** filtered by chat id, unlike every other path. The
  // introduction is idempotent per chat, and being added to an unexpected group is
  // something a coordinator should be able to see rather than something that
  // vanishes — which is also the symptom of a misconfigured TELEGRAM_CHAT_ID.
  if (update.my_chat_member !== undefined) {
    return { kind: "my_chat_member", event: botMembershipEvent(update.my_chat_member) };
  }

  if (update.chat_member !== undefined) {
    if (update.chat_member.chat.id !== options.chatId) {
      return { kind: "ignored", reason: "foreign_chat" };
    }
    return { kind: "chat_member", event: membershipEvent(update.chat_member) };
  }

  return { kind: "ignored", reason: "unsupported_update" };
}
