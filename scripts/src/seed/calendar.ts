/**
 * The six-month event calendar.
 *
 * Events exist so post-event conversation has something to be about — that chatter is
 * what the coverage inference reads, and it is also most of the transcript's volume.
 *
 * Participation is shaped rather than random, because two coverage rows depend on the
 * shape: one capability must have several observed participants and one must have
 * exactly one. Microchipping is the second: only Farhan is ever named doing it, which
 * is what produces the capability variant of a sole-holder finding. Leaving that to
 * chance across a hundred events would reliably produce nothing.
 */

import type { PlanEvent, PlanPerson } from "./plan-types.js";
import { activeOn } from "./roster.js";
import { addDays, eachDay, weekday, type Rng } from "./rng.js";

/**
 * Fixed participant pools per capability area. Coverage is inferred from these being
 * named in post-event thanks, never from an attendance record — there is no
 * attendance table for one to be written to.
 */
export const CAPABILITY_POOLS = {
  /** Aggregation: three separate exposures land inside this one area. */
  foster_placement: ["p10", "p02", "p12"],
  adoption_day_setup: ["p03", "p06", "p07", "p11", "p13", "p16", "p19"],
  /** Exactly one. This is the capability variant of `sole_holder`. */
  microchipping: ["p07"],
  vet_transport: ["p05", "p09", "p04"],
  intake_triage: ["p01", "p14", "p17"],
  social_media_posting: ["p02", "p18"],
} as const;

const EVENT_KINDS = [
  { kind: "adoption_day", name: "adoption day at the park", everyDays: 21, weekdayOnly: false },
  { kind: "sterilisation_camp", name: "sterilisation camp", everyDays: 28, weekdayOnly: false },
  { kind: "vet_run", name: "vet run", everyDays: 7, weekdayOnly: true },
  { kind: "intake", name: "intake from the shelter gate", everyDays: 11, weekdayOnly: true },
  { kind: "fundraiser", name: "fundraiser stall", everyDays: 84, weekdayOnly: false },
] as const;

/** Which capability pools an event of each kind draws its participants from. */
const KIND_POOLS: Record<string, (keyof typeof CAPABILITY_POOLS)[]> = {
  adoption_day: ["adoption_day_setup", "foster_placement"],
  sterilisation_camp: ["microchipping", "vet_transport"],
  vet_run: ["vet_transport"],
  intake: ["intake_triage", "foster_placement"],
  fundraiser: ["adoption_day_setup", "social_media_posting"],
};

export function buildCalendar(
  people: PlanPerson[],
  windowStart: string,
  windowEnd: string,
  rng: Rng,
): PlanEvent[] {
  const events: PlanEvent[] = [];

  for (const spec of EVENT_KINDS) {
    // Offset each series so they do not all land on the same day, which would leave
    // long silent stretches and then implausible pile-ups.
    let cursor = addDays(windowStart, spec.everyDays % 9);
    while (cursor <= windowEnd) {
      // A weekday-only series must *shift* onto the next weekday, not skip the
      // occurrence. Skipping silently drops the entire series when its interval is a
      // multiple of seven and its first date falls on a weekend — which is how a vet
      // run every seven days produced no vet runs at all.
      let date = cursor;
      if (spec.weekdayOnly) {
        while (weekday(date) === 0 || weekday(date) === 6) date = addDays(date, 1);
      }

      if (date <= windowEnd) {
        const pools = KIND_POOLS[spec.kind] ?? [];
        const candidates = new Set<string>();
        for (const pool of pools) {
          for (const id of CAPABILITY_POOLS[pool]) candidates.add(id);
        }

        const present = activeOn(people, date).map((person) => person.id);
        const eligible = [...candidates].filter((id) => present.includes(id));
        // Everyone in a single-person pool always attends; larger pools vary, so the
        // register sees genuine differences in coverage breadth.
        const take = Math.max(1, Math.min(eligible.length, 2 + rng.int(4)));

        events.push({
          id: `e${String(events.length + 1).padStart(3, "0")}`,
          date,
          kind: spec.kind,
          name: spec.name,
          participantIds: rng.sample(eligible, take).sort(),
        });
      }
      cursor = addDays(cursor, spec.everyDays);
    }
  }

  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Events indexed by date, so the renderer can give a day something to talk about. */
export function indexByDate(events: PlanEvent[]): Map<string, PlanEvent[]> {
  const index = new Map<string, PlanEvent[]>();
  for (const event of events) {
    const existing = index.get(event.date);
    if (existing === undefined) index.set(event.date, [event]);
    else existing.push(event);
  }
  return index;
}

/** Every day in the window, so the renderer walks the calendar rather than the events. */
export function calendarDays(windowStart: string, windowEnd: string): string[] {
  return eachDay(windowStart, windowEnd);
}
