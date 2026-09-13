/**
 * Render: phase two. Prose against the plan, in day-sized chunks.
 *
 * The renderer walks the calendar one day at a time and never holds six months in
 * context. Each day it interleaves two things:
 *
 *   - **Placed messages**, verbatim from the plan. These are rendered *in place* rather
 *     than appended, which is why the orphan's donation-page message sits in April
 *     surrounded by ordinary April chatter instead of in a block at the end.
 *   - **Filler**, from a {@link FillerProvider}. Filler is the only part a model needs to
 *     touch, and it carries no coverage obligation — which is the whole reason the split
 *     exists. A model asked to improve the hearsay message could silently destroy the
 *     only hearsay material in six months.
 *
 * The provider seam is here rather than added later for the same reason `AGENT_TRANSPORT`
 * exists: retrofitting a seam into code built around one implementation is more work than
 * designing for two. {@link templateFiller} works offline today; a model-backed provider
 * lands once G1 and G2 are proven, and swapping it changes tone and nothing else.
 */

import type { PlanEvent, PlanPerson, RenderedMessage, SeedPlan } from "./plan-types.js";
import { activeOn } from "./roster.js";
import { addDays, createRng, daysBetween, eachDay, weekday, type Rng } from "./rng.js";
import { indexByDate } from "./calendar.js";

export interface DayContext {
  date: string;
  events: PlanEvent[];
  /** Everyone in the group that day. Filler is never sent by someone absent. */
  present: PlanPerson[];
  rng: Rng;
}

export interface FillerLine {
  senderId: string;
  text: string;
}

export interface FillerProvider {
  readonly name: string;
  lines(context: DayContext, count: number): FillerLine[];
}

// ─────────────────────────────────────────────────────────────────────────────────
// The offline provider
// ─────────────────────────────────────────────────────────────────────────────────

const ANIMALS = [
  "the tabby from Domlur",
  "the three-legged pup",
  "the Lab mix",
  "the pregnant calico",
  "the beagle from the gate",
  "the shepherd cross",
  "the kitten litter",
  "the old indie boy",
];

const PLACES = [
  "Indiranagar",
  "Whitefield",
  "Koramangala",
  "Domlur",
  "HSR",
  "Jayanagar",
  "Hebbal",
  "Bellandur",
];

/** Agreement fragments. The single most common message shape in any group chat. */
const FRAGMENTS = ["ok", "okay", "sure", "noted", "👍", "yes please", "same", "on it"];

const CHATTER = [
  "Anyone free for a pickup in {place} this evening?",
  "{animal} is doing much better today, eating properly at last.",
  "Vaccination due for {animal} — can someone check the card?",
  "Two enquiries from the Instagram post, both look genuine.",
  "Can we get more newspaper? The kennels are down to the last stack.",
  "Auto fare to {place} and back came to ₹340, will put it in the sheet.",
  "{animal} has been adopted! Family came back a second time and everything.",
  "Rain again. Camp setup is going to be miserable.",
  "Does anyone have a spare crate, medium size?",
  "Feed order arrives Thursday, ₹4,200 for the month.",
  "Somebody left the store room unlocked last night, please be careful.",
  "{animal} needs a foster for two weeks max, anyone?",
  "Called the {place} vet, they can take two tomorrow morning.",
  "Photos from yesterday are in the drive folder.",
  "The gate lock is jammed again.",
  "Reminder: nobody hands over an animal without the agreement signed.",
  "Half the collars are missing, I think they're in the van.",
  "{animal} bit the thermometer clean in half.",
  "Six calls today, four were about the same dog.",
  "Can we shift the {place} pickup to Sunday? Nothing is working for tomorrow.",
  "Deworming for the litter is done.",
  "Someone dropped a puppy at the gate in a shoebox. We have him inside.",
  "₹1,500 came in through the donation link today.",
  "The scale is broken, weights from this week are guesses.",
  "Adoption paperwork for {animal} is signed and filed.",
];

const EVENT_BEFORE = [
  "What time are we starting for the {event}?",
  "Bringing the folding table for the {event}, someone else get the banner.",
  "Who's driving to the {event} tomorrow?",
  "Reminder about the {event} — please be there by eight.",
];

const EVENT_AFTER = [
  "Good {event} today, quieter than last time but steady.",
  "Long {event}. Everything's packed and back in the store room.",
  "That {event} went better than expected honestly.",
  "Wrapping up from the {event}, thanks all.",
];

const JOKES = [
  "{animal} has decided the sofa is his now. Nothing I can do.",
  "I have been outsmarted by a kitten today, professionally speaking.",
  "If anyone needs me I'll be under three dogs.",
  "{animal} looked directly at me and chose violence.",
];

function fill(template: string, rng: Rng): string {
  return template
    .replace("{animal}", rng.pick(ANIMALS))
    .replace("{place}", rng.pick(PLACES))
    .replace("{event}", "camp");
}

/**
 * Deterministic templates. Honest about what it is: this produces plausible operational
 * chatter, not prose that reads as genuinely human. That row of the checklist stays open
 * until a model provider renders these days, which is a tone problem rather than a
 * structural one — every coverage row is satisfied by the placements either way.
 */
export const templateFiller: FillerProvider = {
  name: "template",
  lines(context, count) {
    const out: FillerLine[] = [];
    const ids = context.present.map((person) => person.id);
    if (ids.length === 0) return out;

    for (let index = 0; index < count; index += 1) {
      const roll = context.rng.next();
      const eventName = context.events[0]?.name ?? "camp";
      let text: string;

      if (roll < 0.22) {
        text = context.rng.pick(FRAGMENTS);
      } else if (roll < 0.3) {
        text = fill(context.rng.pick(JOKES), context.rng);
      } else if (roll < 0.42 && context.events.length > 0) {
        const bank = index < count / 2 ? EVENT_BEFORE : EVENT_AFTER;
        text = context.rng.pick(bank).replace("{event}", eventName);
      } else {
        text = fill(context.rng.pick(CHATTER), context.rng);
      }

      out.push({ senderId: context.rng.pick(ids), text });
    }

    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Two months for development, six for the final pass. Placements compress, never drop. */
  months?: number;
  filler?: FillerProvider;
  seed?: number;
  /** Roughly how many messages the whole transcript should carry. */
  targetMessages?: number;
}

/**
 * The two-month slice is the same plan with a truncated calendar and its coverage rows
 * **compressed into the shorter span rather than dropped**. Proportional compression
 * keeps order intact and keeps the stale figure near the start of the window, which is
 * what the cut order requires of a shortened history.
 */
function compressDate(
  date: string,
  windowStart: string,
  fullDays: number,
  sliceDays: number,
): string {
  if (sliceDays >= fullDays) return date;
  const offset = daysBetween(windowStart, date);
  return addDays(windowStart, Math.round((offset * sliceDays) / fullDays));
}

export interface RenderResult {
  messages: RenderedMessage[];
  windowStart: string;
  windowEnd: string;
  fillerProvider: string;
}

export function renderTranscript(plan: SeedPlan, options: RenderOptions = {}): RenderResult {
  const filler = options.filler ?? templateFiller;
  const rng = createRng(options.seed ?? 987654321);
  const target = options.targetMessages ?? 4500;

  const fullDays = daysBetween(plan.windowStart, plan.windowEnd);
  const months = options.months ?? plan.months;
  const sliceDays =
    months >= plan.months ? fullDays : Math.round((fullDays * months) / plan.months);
  const windowEnd = addDays(plan.windowStart, sliceDays);

  /**
   * Compression can land two placements from different days on the same compressed day,
   * and sorting that day by its original minutes would then **invert** them — the
   * donation-page message could end up after the reply thanking her for it. Placements are
   * therefore re-timed within each compressed day so their original order survives, which
   * matters because supersession is order-dependent: a contradiction processed backwards
   * silently inverts a fact.
   */
  const placementsByDate = new Map<
    string,
    { placement: SeedPlan["placements"][number]; minute: number }[]
  >();
  const ordered = [...plan.placements].sort((a, b) =>
    a.date === b.date ? a.minute - b.minute : a.date < b.date ? -1 : 1,
  );
  for (const placement of ordered) {
    const date = compressDate(placement.date, plan.windowStart, fullDays, sliceDays);
    const group = placementsByDate.get(date);
    if (group === undefined) {
      placementsByDate.set(date, [{ placement, minute: placement.minute }]);
      continue;
    }
    const previous = group[group.length - 1]?.minute ?? 0;
    group.push({ placement, minute: Math.max(placement.minute, previous + 1) });
  }

  const eventsByDate = indexByDate(
    plan.events.map((event) => ({
      ...event,
      date: compressDate(event.date, plan.windowStart, fullDays, sliceDays),
    })),
  );

  const days = eachDay(plan.windowStart, windowEnd);
  // Derived from the **full** window, not the slice, so the two-month slice is
  // proportionally as busy as the six-month run rather than cramming four and a half
  // thousand messages into two months of implausible chatter.
  //
  // The event-day and weekend bonuses below add roughly this much per day on average, so
  // the base is reduced by it. Without the correction the target is exceeded by about a
  // sixth, which is a slow Curator backfill bought for nothing.
  const AVERAGE_BONUS_PER_DAY = 3.4;
  const perDay = Math.max(
    4,
    Math.round((target - plan.placements.length) / fullDays - AVERAGE_BONUS_PER_DAY),
  );

  const messages: RenderedMessage[] = [];
  const byId = new Map(plan.people.map((person) => [person.id, person] as const));

  interface DayEntry {
    minute: number;
    senderId: string;
    text: string;
    /** Null for filler. Present for an authored placement, rendered verbatim. */
    placement: SeedPlan["placements"][number] | null;
  }

  for (const date of days) {
    const events = eventsByDate.get(date) ?? [];
    const present = activeOn(plan.people, date);
    const context: DayContext = { date, events, present, rng };

    const weekend = weekday(date) === 0 || weekday(date) === 6;
    const count = Math.max(
      3,
      perDay - 4 + rng.int(9) + (events.length > 0 ? 6 + rng.int(8) : 0) + (weekend ? 3 : 0),
    );

    const dayEntries: DayEntry[] = filler.lines(context, count).map((line) => ({
      // 07:00 to 23:00 local. Spread rather than clustered, so a day reads as a day.
      minute: 420 + rng.int(960),
      senderId: line.senderId,
      text: line.text,
      placement: null,
    }));

    for (const entry of placementsByDate.get(date) ?? []) {
      dayEntries.push({
        minute: entry.minute,
        senderId: entry.placement.senderId,
        text: entry.placement.text,
        placement: entry.placement,
      });
    }

    dayEntries.sort((a, b) => a.minute - b.minute);

    // Seconds disambiguate messages sharing a minute. Derived from the position within
    // that minute rather than from a global counter, because a global counter wraps at 60
    // and produces timestamps that run backwards inside a single minute.
    const withinMinute = new Map<number, number>();

    for (const entry of dayEntries) {
      const { placement } = entry;
      const person = byId.get(entry.senderId);
      const index = messages.length;
      const previous = messages[messages.length - 1];

      const seen = withinMinute.get(entry.minute) ?? 0;
      withinMinute.set(entry.minute, seen + 1);
      const second = Math.min(59, seen);

      // Some replies use Telegram's reply feature and some do not, which is exactly the
      // case reply matching has to handle: reply_to first, then the most recent open
      // question from that sender, then ambiguous.
      const isReply = previous !== undefined && placement === null && rng.next() < 0.12;

      messages.push({
        telegramMessageId: -(100_000 + index),
        sentAt: `${date}T${String(Math.floor(entry.minute / 60)).padStart(2, "0")}:${String(
          entry.minute % 60,
        ).padStart(2, "0")}:${String(second).padStart(2, "0")}+05:30`,
        senderPlanId: entry.senderId,
        senderDisplayName: person?.displayName ?? entry.senderId,
        // A voice note or an image carries no text. The description in the plan is a
        // note for a human reader, not something the group actually said.
        text: placement?.flags.media !== undefined ? null : entry.text,
        replyToTelegramMessageId: isReply ? (previous?.telegramMessageId ?? null) : null,
        isForwarded: placement?.flags.forwarded === true,
        forwardedFrom: placement?.flags.forwardedFrom ?? null,
        isEdited: placement?.flags.editedTo !== undefined,
        editedText: placement?.flags.editedTo ?? null,
        mediaKind: placement?.flags.media ?? null,
        planMessageId: placement?.id ?? null,
        coverage: placement?.coverage ?? [],
        cases: placement?.cases ?? [],
      });
    }
  }

  return { messages, windowStart: plan.windowStart, windowEnd, fillerProvider: filler.name };
}
