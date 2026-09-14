/**
 * Dates, resolved against the group's timezone rather than UTC. `[F10]`
 *
 * The Curator returns a deadline twice: verbatim as the group wrote it ("next
 * Tuesday"), and resolved to `YYYY-MM-DD` against the timezone the prompt supplied.
 * What arrives here is therefore a **calendar date with no time**, and turning it into
 * an instant is where UTC quietly breaks things.
 *
 * `new Date("2026-04-20")` is midnight **UTC**, which is half past five in the morning
 * in Bengaluru. Every comparison then sits half a day out: a deadline is overdue before
 * the day it names has ended, and a date near midnight renders as the day before. The
 * design calls this out specifically because it does not look like a timezone bug — it
 * looks like a bug in provenance, which is the one thing the register cannot afford to
 * look like.
 *
 * No dependency is taken. `Intl` with a real ICU build — which Node has — already knows
 * every offset including historical changes, so the offset is *asked for* rather than
 * assumed, and the code stays correct for a group that is not in India.
 */

const MS_PER_DAY = 86_400_000;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The offset of a timezone at a particular instant, in milliseconds.
 *
 * Works by asking `Intl` what the wall clock reads there, reassembling that reading as
 * though it were UTC, and taking the difference. Positive east of Greenwich, so
 * Asia/Kolkata returns +19,800,000 — five and a half hours.
 *
 * Computed per instant rather than per zone because offsets move: a zone with daylight
 * saving has two, and a fixed constant would be wrong for half the year.
 */
export function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = new Map<string, string>(
    formatter.formatToParts(at).map((part) => [part.type as string, part.value]),
  );

  const read = (type: string): number => Number(parts.get(type) ?? "0");
  // `hour12: false` can render midnight as 24 in some ICU versions.
  const hour = read("hour") % 24;

  const asIfUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );

  return asIfUtc - at.getTime();
}

/**
 * Turns a `YYYY-MM-DD` calendar date into the instant local midnight begins in a zone.
 *
 * "2026-04-20" in Asia/Kolkata is 2026-04-19T18:30:00Z, not 2026-04-20T00:00:00Z.
 *
 * Returns null for anything that is not a bare date, so a malformed model output
 * becomes an absent deadline rather than an `Invalid Date` propagating into a
 * timestamptz column.
 */
export function zonedDateToInstant(dateOnly: string, timeZone: string): Date | null {
  const match = DATE_ONLY.exec(dateOnly.trim());
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const utcMidnight = Date.UTC(year, month - 1, day);
  // The offset is evaluated at roughly the right moment, which is what makes this
  // correct across a daylight-saving boundary.
  const offset = timeZoneOffsetMs(new Date(utcMidnight), timeZone);
  const instant = new Date(utcMidnight - offset);

  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * Whole days between two instants, never negative.
 *
 * This is the age an answer quotes and the number a staleness warning turns on, so it
 * is computed here rather than asked of a model: arithmetic on dates is exactly the
 * kind of work a cheap model gets subtly wrong, and an invented number makes the
 * warning unfalsifiable.
 */
export function ageInDays(from: Date, to: Date = new Date()): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * Days a deadline is past, or null when it has not arrived.
 *
 * Null and zero mean different things — not yet due, versus due today — so a caller
 * can phrase "due today" differently from "four days late".
 */
export function overdueDays(deadline: Date, now: Date = new Date()): number | null {
  const days = Math.floor((now.getTime() - deadline.getTime()) / MS_PER_DAY);
  return days < 0 ? null : days;
}
