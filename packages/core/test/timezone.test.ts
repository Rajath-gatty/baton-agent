/**
 * Timezone-correct dates.
 *
 * The failure this guards against does not look like a timezone bug — it looks like a
 * bug in provenance, which is the one thing the register cannot afford to look like.
 */

import { describe, expect, it } from "vitest";
import { ageInDays, overdueDays, timeZoneOffsetMs, zonedDateToInstant } from "../src/timezone.js";

const IST = "Asia/Kolkata";

describe("timeZoneOffsetMs", () => {
  it("reports five and a half hours for IST", () => {
    expect(timeZoneOffsetMs(new Date("2026-04-20T00:00:00Z"), IST)).toBe(19_800_000);
  });

  it("reports nothing for UTC", () => {
    expect(timeZoneOffsetMs(new Date("2026-04-20T00:00:00Z"), "UTC")).toBe(0);
  });

  it("is asked per instant, so a daylight-saving zone gets both of its offsets", () => {
    // The reason the offset is not cached per zone. London is +0 in January and +1 in
    // July, and a fixed constant would be wrong for half the year.
    const winter = timeZoneOffsetMs(new Date("2026-01-15T12:00:00Z"), "Europe/London");
    const summer = timeZoneOffsetMs(new Date("2026-07-15T12:00:00Z"), "Europe/London");
    expect(winter).toBe(0);
    expect(summer).toBe(3_600_000);
  });
});

describe("zonedDateToInstant", () => {
  it("reads a bare date as local midnight rather than UTC midnight", () => {
    // 2026-04-20 in Bengaluru begins at 18:30 UTC the previous day.
    expect(zonedDateToInstant("2026-04-20", IST)?.toISOString()).toBe("2026-04-19T18:30:00.000Z");
  });

  it("agrees with plain parsing only where the offset is zero", () => {
    expect(zonedDateToInstant("2026-04-20", "UTC")?.toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });

  it("still names the right calendar day in its own zone", () => {
    const instant = zonedDateToInstant("2026-04-20", IST);
    const rendered = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(instant as Date);
    expect(rendered).toBe("2026-04-20");
  });

  it("crosses a daylight-saving boundary correctly", () => {
    // British Summer Time began on 29 March 2026, so this local midnight is 23:00 UTC
    // the day before rather than midnight.
    expect(zonedDateToInstant("2026-07-01", "Europe/London")?.toISOString()).toBe(
      "2026-06-30T23:00:00.000Z",
    );
  });

  it("returns null for anything that is not a bare date", () => {
    // A malformed model output must become an absent deadline, not an Invalid Date
    // propagating into a timestamptz column.
    expect(zonedDateToInstant("next Tuesday", IST)).toBeNull();
    expect(zonedDateToInstant("2026-04-20T10:00:00Z", IST)).toBeNull();
    expect(zonedDateToInstant("", IST)).toBeNull();
  });

  it("rejects an impossible month or day", () => {
    expect(zonedDateToInstant("2026-13-01", IST)).toBeNull();
    expect(zonedDateToInstant("2026-04-45", IST)).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    expect(zonedDateToInstant("  2026-04-20 ", IST)).not.toBeNull();
  });
});

describe("ageInDays", () => {
  it("counts whole days", () => {
    expect(ageInDays(new Date("2026-06-01T09:00:00Z"), new Date("2026-09-14T09:00:00Z"))).toBe(105);
  });

  it("is zero on the same day", () => {
    expect(ageInDays(new Date("2026-06-01T09:00:00Z"), new Date("2026-06-01T20:00:00Z"))).toBe(0);
  });

  it("never goes negative for a future timestamp", () => {
    expect(ageInDays(new Date("2026-09-14T09:00:00Z"), new Date("2026-06-01T09:00:00Z"))).toBe(0);
  });
});

describe("overdueDays", () => {
  it("counts days past a deadline", () => {
    expect(overdueDays(new Date("2026-09-10T00:00:00Z"), new Date("2026-09-14T00:00:00Z"))).toBe(4);
  });

  it("is zero on the day it falls due", () => {
    expect(overdueDays(new Date("2026-09-14T00:00:00Z"), new Date("2026-09-14T10:00:00Z"))).toBe(0);
  });

  it("is null before the deadline, which is not the same as zero", () => {
    // "Not yet due" and "due today" read differently to a coordinator.
    expect(
      overdueDays(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-14T00:00:00Z")),
    ).toBeNull();
  });
});
