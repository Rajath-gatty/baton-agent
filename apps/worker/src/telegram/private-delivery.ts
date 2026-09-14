/**
 * Delivering something to one person rather than to the group. `[F21]` `[F24]`
 *
 * Two behaviours depend on this. Anything touching financial control, credentials or an
 * individual's holdings goes to the coordinator privately rather than in front of twenty
 * people. And a departure brief is offered to its subject, not only to the coordinator.
 *
 * **The fallback is the feature, not an error path.** A bot cannot open a conversation
 * with someone who has never written to it first, so for most of a twenty-person roster
 * private delivery is simply impossible. That is why every function here reports
 * *undeliverable* as a normal outcome and hands the text back: the admin UI renders it
 * as copyable text for the coordinator to pass on, which is the documented behaviour
 * rather than a degradation.
 */

import type { OutboundQueue } from "./outbound-queue.js";
import { findPrivateChatId } from "../store/people.js";
import { getAppSettings } from "../store/app-settings.js";
import type { Executor } from "../store/types.js";

/**
 * Why a private message could not be delivered.
 *
 * - `no_private_chat` — Baton has never been written to by this person, so it has no
 *   chat to write into. Expected for most of the roster.
 * - `blocked` — a chat existed and Telegram refused, which usually means the person
 *   blocked the bot or deleted the conversation.
 * - `no_coordinator` — `app_settings.coordinator_person_id` is unset. Reachable for
 *   real: if the coordinator is the person who left, it must be reassigned before any
 *   approval can resolve.
 */
export type UndeliverableReason = "no_private_chat" | "blocked" | "no_coordinator" | "send_failed";

export type PrivateDelivery =
  | { delivered: true; messageId: number; chatId: number }
  | { delivered: false; reason: UndeliverableReason; text: string };

/**
 * Sends to one person, if Baton can reach them.
 *
 * Goes through the same queue as everything else. A separate direct send would be a
 * second outbound path with its own rate limit, which is precisely how a burst gets a
 * bot restricted.
 */
export async function sendPrivately(
  db: Executor,
  queue: OutboundQueue,
  personId: string,
  text: string,
  purpose?: string,
): Promise<PrivateDelivery> {
  const privateChatId = await findPrivateChatId(db, personId);
  if (privateChatId === null) {
    return { delivered: false, reason: "no_private_chat", text };
  }

  const outcome = await queue.enqueue({
    chatId: privateChatId,
    text,
    ...(purpose === undefined ? {} : { purpose }),
  });

  if (outcome.ok) {
    return { delivered: true, messageId: outcome.messageId, chatId: outcome.chatId };
  }
  return {
    delivered: false,
    reason: outcome.reason === "forbidden" ? "blocked" : "send_failed",
    text,
  };
}

/**
 * Sends to the coordinator privately.
 *
 * Used for anything sensitive: an approval about who controls the money is not asked in
 * front of the group. When the coordinator is unset or unreachable the caller has a
 * real decision to make rather than a retry — for an approval, asking the group instead
 * would hand a volunteer authority they must not have, so the honest outcome is that it
 * stays pending and visible in the UI.
 */
export async function sendToCoordinator(
  db: Executor,
  queue: OutboundQueue,
  text: string,
  purpose?: string,
): Promise<PrivateDelivery> {
  const settings = await getAppSettings(db);
  if (settings.coordinatorPersonId === null) {
    return { delivered: false, reason: "no_coordinator", text };
  }
  return sendPrivately(db, queue, settings.coordinatorPersonId, text, purpose);
}
