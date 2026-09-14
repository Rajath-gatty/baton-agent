/**
 * The seed adapter. `[F2]`
 *
 * Renders one record of `scripts/out/seed-transcript.json` into the same
 * `NormalisedMessage` the Telegram adapter produces, so seeded history enters
 * through the same normaliser as live traffic. A second insert path in the seed
 * script would be a second normaliser, and the two would drift on precisely the
 * fields nobody checks — provenance flags, the content hash, the unprocessed flag.
 *
 * Three gaps between the artifact and the internal shape are closed here:
 *
 *   - **`chatId`** is not in the artifact. It comes from configuration, so re-seeding
 *     stays idempotent under the unique `(chat_id, telegram_message_id)` constraint.
 *   - **`senderTelegramUserId`** is a plan id in the artifact (`p01`…`p20`). Only the
 *     two or three accounts used on camera resolve to a real id; the other
 *     seventeen are legitimately null.
 *   - **An edit is one record carrying two texts**, where live Telegram delivers two
 *     separate updates. {@link expandRenderedMessage} splits it back into two, so the
 *     facts the original text produced are superseded rather than mutated.
 */

import { contentHash } from "../normalise.js";
import type { NormalisedMessage, SeedRenderedMessage } from "./types.js";

export interface SeedIntakeOptions {
  /** Stamped onto every seeded message, so the unique constraint stays meaningful. */
  chatId: number;
  /**
   * Resolves a plan person id to a real Telegram user id, for the accounts bound at
   * seed time. Returning null is the normal case — most of the roster only ever
   * appears by name in six months of conversation.
   */
  telegramUserIdFor?: (senderPlanId: string) => number | null;
}

/** Which text of an edited record to render. */
export type SeedVariant = "original" | "edited";

/**
 * Renders one seeded record.
 *
 * The `original` variant is the message as first sent, carrying `isEdited: false`
 * even where the plan records a later edit — because at that point in the
 * transcript it had not been edited yet, and the pre-filter and Curator must see
 * what the group actually saw.
 */
export function fromRenderedMessage(
  rendered: SeedRenderedMessage,
  options: SeedIntakeOptions,
  variant: SeedVariant = "original",
): NormalisedMessage {
  const isEditedVariant = variant === "edited" && rendered.editedText !== null;
  const text = isEditedVariant ? rendered.editedText : rendered.text;
  const hasText = text !== null && text.trim() !== "";

  return {
    source: "seed",
    chatId: options.chatId,
    telegramMessageId: rendered.telegramMessageId,
    senderTelegramUserId: options.telegramUserIdFor?.(rendered.senderPlanId) ?? null,
    senderDisplayName: rendered.senderDisplayName,
    sentAt: new Date(rendered.sentAt),
    text: hasText ? text : null,
    contentHash: contentHash(hasText ? text : null),
    replyToTelegramMessageId: rendered.replyToTelegramMessageId,
    isForwarded: rendered.isForwarded,
    forwardedFrom: rendered.forwardedFrom,
    isEdited: isEditedVariant,
    // The artifact records *that* a message was edited, never *when*. Synthesising a
    // timestamp would put a fabricated date on a provenance surface, so this stays
    // null and the UI renders "edited" without claiming to know the hour.
    editedAt: null,
    isUnprocessed: rendered.mediaKind !== null && !hasText,
    mediaKind: rendered.mediaKind,
  };
}

/**
 * Splits a seeded record into the events live Telegram would have delivered.
 *
 * One event for an ordinary message; two for an edited one, in order. Returning a
 * list rather than a single message is what lets backfill drive the same
 * re-curation path an `edited_message` update drives — the original text is
 * curated, then the edit resets `curated_at` and supersedes the facts the old text
 * produced. Feeding only the final text would silently skip the supersession the
 * seeded provenance case exists to exercise.
 */
export function expandRenderedMessage(
  rendered: SeedRenderedMessage,
  options: SeedIntakeOptions,
): NormalisedMessage[] {
  const original = fromRenderedMessage(rendered, options, "original");
  if (!rendered.isEdited || rendered.editedText === null) return [original];
  return [original, fromRenderedMessage(rendered, options, "edited")];
}
