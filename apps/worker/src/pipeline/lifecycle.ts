/**
 * Membership lifecycle and the one-time introduction. `[F3]` `[F22]`
 *
 * A departure is the most valuable event Baton sees: it is the moment the register has
 * to answer what left with the person, and it is the first fifteen seconds of the demo.
 * Two things upstream of this file have to be right for it to fire at all, and both
 * fail silently — `allowed_updates` must request `chat_member`, and the bot must be a
 * group administrator or Telegram does not deliver those updates to it.
 *
 * What this module does **not** do is generate the brief. It updates who is in the
 * group and reports what happened; firing `brief` is the caller's decision, so a
 * backfill replaying six months of membership changes does not produce sixty briefs.
 */

import { eq, sql } from "drizzle-orm";
import { schema } from "@baton/core/db";
import type { BotMembershipEvent, MembershipEvent } from "@baton/core";
import { upsertPersonByTelegramId } from "../store/people.js";
import { claimIntroduction } from "../store/app-settings.js";
import type { Executor } from "../store/types.js";

const { people } = schema;

/**
 * What Baton says when it joins a group. `[F22]`
 *
 * States what is and is not recorded, because a bot that starts reading a
 * twenty-person group without saying so is not something people should have to
 * discover. The second half is the product's privacy guarantee in plain words — it is
 * enforced by the schema having nowhere to write a score or an attendance record, and
 * saying so out loud is what makes that worth anything to the people in the room.
 */
export const INTRODUCTION_TEXT = [
  "Hello — I'm Baton. I help this group remember what it knows: who holds which " +
    "accounts, keys and contacts, what's been promised, and who's been seen doing what.",
  "",
  "What I record: things said in this group that look durable — arrangements, " +
    "commitments, and who looks after what. Every claim I keep is traceable back to " +
    "the message it came from.",
  "",
  "What I don't record: anything about how active, reliable or punctual anyone is. " +
    "There is no attendance register and no score of any kind — I track what the " +
    "organisation knows, not what its people do.",
  "",
  "Mention me or reply to me to ask something. I'll say when I don't know.",
].join("\n");

export interface MembershipOutcome {
  personId: string;
  /** True when a brief should be generated. Only a real transition qualifies. */
  briefWorthy: boolean;
  transition: MembershipEvent["transition"];
}

/**
 * Applies a membership change to `people`.
 *
 * A rejoin clears `left_at` and returns the person to `member`, which is what makes
 * orphan findings about them close through ordinary `dedupe_key` re-evaluation rather
 * than needing a special path.
 *
 * **Known limitation, stated rather than hidden:** membership is current state, not
 * history. There is no table for a join/leave ledger, so someone who leaves and
 * rejoins keeps only their latest dates. That is a deliberate consequence of having no
 * per-person activity record at all — the same absence that makes an attendance table
 * unrepresentable — and the audit trail that does exist is the messages themselves.
 */
export async function applyMembershipEvent(
  db: Executor,
  event: MembershipEvent,
): Promise<MembershipOutcome> {
  const personId = await upsertPersonByTelegramId(db, {
    telegramUserId: event.telegramUserId,
    displayName: event.displayName,
  });

  switch (event.transition) {
    case "joined": {
      await db
        .update(people)
        .set({ status: "member", joinedAt: event.at, leftAt: null })
        .where(eq(people.id, personId));
      return { personId, briefWorthy: true, transition: event.transition };
    }
    case "left": {
      await db
        .update(people)
        .set({ status: "left", leftAt: event.at })
        .where(eq(people.id, personId));
      return { personId, briefWorthy: true, transition: event.transition };
    }
    default: {
      // A promotion or a restriction. The person is where they were, so nothing
      // changes and no brief is owed — firing one here would produce a handover
      // document every time someone was made an administrator.
      return { personId, briefWorthy: false, transition: event.transition };
    }
  }
}

export interface IntroductionOutcome {
  shouldSend: boolean;
  text: string;
  chatId: number;
}

/**
 * Decides whether to introduce Baton, and records the decision in the same statement.
 *
 * Only on actually being in the chat: `my_chat_member` also fires when the bot is
 * removed, and introducing itself on the way out would be absurd.
 *
 * Returns an intent rather than sending. Every outbound message goes through the one
 * throttled queue, and a module that sent directly would be a second outbound path
 * with its own rate limit — which is how a bot gets restricted mid-demo.
 */
export async function handleBotMembershipEvent(
  db: Executor,
  event: BotMembershipEvent,
): Promise<IntroductionOutcome> {
  if (!event.isNowMember) {
    return { shouldSend: false, text: INTRODUCTION_TEXT, chatId: event.chatId };
  }

  const claimed = await claimIntroduction(db, event.chatId);
  return { shouldSend: claimed, text: INTRODUCTION_TEXT, chatId: event.chatId };
}

/**
 * Whether the bot can actually receive membership events in this chat.
 *
 * `chat_member` updates are delivered only to administrators, so a non-admin bot
 * misses every departure — and misses them silently, which is indistinguishable from a
 * quiet group. Checked at startup so it becomes a line in the log instead of a demo
 * that does not happen.
 */
export function canReceiveMembershipEvents(status: string): boolean {
  return status === "administrator" || status === "creator";
}

/** Counts current members, for the `assess` context's people count. */
export async function countActiveMembers(db: Executor): Promise<number> {
  const rows = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(people)
    .where(eq(people.status, "member"));
  return Number(rows[0]?.count ?? 0);
}
