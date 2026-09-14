/**
 * Whether a message is a question directed at Baton. `[F20]`
 *
 * **Two signals, and nothing else: an @-mention of the bot, or a reply to one of its
 * messages.** The restraint is the design. A bot that answers anything ending in a
 * question mark joins every conversation it is not part of — twenty people discussing
 * where to eat do not want a register consulted — and the failure is not merely noisy: it
 * spends model calls on chatter and trains the group to ignore Baton's messages, which is
 * the one thing that cannot be recovered by a code change.
 *
 * Deliberately **not** signals:
 *
 *   - A question mark. "anyone free saturday?" is a question and none of Baton's business.
 *   - Question words. "who's bringing the tea" is the same problem in a different shape.
 *   - The bot's name in prose. "baton reckons" is talking *about* it, not *to* it, and a
 *     mention without the @ is not addressed to anyone in Telegram's own model of a group.
 *
 * The two signals that are used are both explicit acts of address: an @-mention is
 * Telegram's own convention for speaking to someone, and a reply is unambiguous. Anything
 * looser turns a judgment call into a guess, and the cost of guessing wrong is
 * asymmetric — a missed question is a coordinator repeating themselves with an @, while a
 * false positive is a bot that will not stop talking.
 */

import type { TelegramMessage } from "./types.js";

export type QuestionSignal = "mention" | "reply_to_bot" | "none";

export interface QuestionDetection {
  isQuestion: boolean;
  signal: QuestionSignal;
  /**
   * The bot message this replies to, when that is the signal. The caller needs it to tell
   * an *answer to Baton's own question* from a *new question* — a reply to an approval
   * request is the former, and treating it as the latter would answer a question nobody
   * asked while leaving the approval pending.
   */
  repliedToBotMessageId: number | null;
}

export interface QuestionDetectionOptions {
  /** From `getMe`. Required: without it a reply to anyone reads as a reply to the bot. */
  botUserId: number | null;
  /** From `getMe`. Without it the @-mention signal is unavailable, not merely weaker. */
  botUsername: string | null;
}

const NOT_A_QUESTION: QuestionDetection = {
  isQuestion: false,
  signal: "none",
  repliedToBotMessageId: null,
};

/**
 * Whether the text @-mentions the bot.
 *
 * Matched against the username with a word boundary, case-insensitively, because Telegram
 * usernames are case-insensitive and a client may render the case the user typed. The
 * boundary matters: `@batonbot_test` must not match a bot called `batonbot`, or Baton
 * answers questions addressed to a different bot in the same group.
 */
export function mentionsBot(text: string | null | undefined, botUsername: string | null): boolean {
  if (botUsername === null || botUsername.trim() === "") return false;
  if (text === null || text === undefined || text.trim() === "") return false;

  const handle = botUsername.replace(/^@/, "").toLowerCase();
  // Escaped because a username is external input, even though Telegram restricts it to
  // word characters — the guarantee is theirs to change, and the cost of assuming is a
  // regular expression built from a stranger's string.
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * Classifies one raw Telegram message.
 *
 * Takes the raw message rather than a `NormalisedMessage` because both signals need
 * information normalisation drops: the reply's *sender*, which is how "reply to the bot" is
 * distinguished from "reply to anyone", and the raw text before any media handling.
 */
export function detectQuestionToBot(
  message: TelegramMessage,
  { botUserId, botUsername }: QuestionDetectionOptions,
): QuestionDetection {
  const parent = message.reply_to_message;
  if (parent !== undefined && botUserId !== null && parent.from?.id === botUserId) {
    return {
      isQuestion: true,
      signal: "reply_to_bot",
      repliedToBotMessageId: parent.message_id,
    };
  }

  const text = message.text ?? message.caption ?? null;
  if (mentionsBot(text, botUsername)) {
    return { isQuestion: true, signal: "mention", repliedToBotMessageId: null };
  }

  return NOT_A_QUESTION;
}
