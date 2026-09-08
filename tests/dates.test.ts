import { assertEquals, assertThrows } from "@std/assert";
import { TZDate } from "@date-fns/tz";
import {
  addChicagoDays,
  chicagoDaysBetween,
  countCfsBusinessDays,
  getDefaultStartDate,
  isNonTerminatingWindow,
  formatChargeDays,
  formatChicagoDate,
  formatChicagoDateTime,
  formatChicagoShortDate,
  formatChicagoWeekdayDate,
  getDuration,
  getEndDateByChargePeriod,
  isHoliday,
  isOffHours,
  toChargeDays,
  toChicagoInstant,
  toChicagoEndOfDay,
  toChicagoStartOfDay,
  toChicagoYmd,
} from "../src/utils/dates.ts";

const holidays = [
  "2024-12-25",
  "2024-01-01",
  "2024-07-04",
  "2024-11-28",
];

// ── isHoliday ────────────────────────────────────────────────────

Deno.test("isHoliday returns true for a holiday", () => {
  const christmas = new TZDate(2024, 11, 25, "America/Chicago");
  assertEquals(isHoliday(christmas, holidays), true);
});

Deno.test("isHoliday returns false for a non-holiday", () => {
  const regularDay = new TZDate(2024, 11, 26, "America/Chicago");
  assertEquals(isHoliday(regularDay, holidays), false);
});

Deno.test("isHoliday returns false for empty holidays array", () => {
  const christmas = new TZDate(2024, 11, 25, "America/Chicago");
  assertEquals(isHoliday(christmas, []), false);
});

Deno.test("isHoliday throws for invalid date", () => {
  assertThrows(
    () => isHoliday(null as unknown as Date, holidays),
    Error,
    "testDate must be a valid date object",
  );
});

Deno.test("isHoliday throws when holidays is not an array", () => {
  const date = new TZDate(2024, 11, 25, "America/Chicago");
  assertThrows(
    () => isHoliday(date, null as unknown as string[]),
    Error,
    "holidays must be an array",
  );
});

// ── isOffHours ───────────────────────────────────────────────────

Deno.test("isOffHours returns true before 8am", () => {
  const earlyMorning = new TZDate(2024, 5, 15, 7, 59, 0, "America/Chicago");
  assertEquals(isOffHours(earlyMorning), true);
});

Deno.test("isOffHours returns false at 8am", () => {
  const openingTime = new TZDate(2024, 5, 15, 8, 0, 0, "America/Chicago");
  assertEquals(isOffHours(openingTime), false);
});

Deno.test("isOffHours returns false during business hours", () => {
  const midday = new TZDate(2024, 5, 15, 12, 0, 0, "America/Chicago");
  assertEquals(isOffHours(midday), false);
});

Deno.test("isOffHours returns true after 4pm", () => {
  const afterClose = new TZDate(2024, 5, 15, 16, 1, 0, "America/Chicago");
  assertEquals(isOffHours(afterClose), true);
});

Deno.test("isOffHours throws for invalid date", () => {
  assertThrows(
    () => isOffHours(null as unknown as Date),
    Error,
    "date must be a valid date object",
  );
});

// ── getEndDateByChargePeriod ─────────────────────────────────────

Deno.test("getEndDateByChargePeriod returns same day for 1 day", () => {
  const startDate = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const result = getEndDateByChargePeriod(startDate, 1, []);
  assertEquals(result.getDate(), 17);
});

Deno.test("getEndDateByChargePeriod calculates 3 days", () => {
  const startDate = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const result = getEndDateByChargePeriod(startDate, 3, []);
  assertEquals(result.getDate(), 19);
});

Deno.test("getEndDateByChargePeriod skips weekends", () => {
  const startDate = new TZDate(2024, 5, 20, 9, 0, 0, "America/Chicago");
  const result = getEndDateByChargePeriod(startDate, 3, []);
  assertEquals(result.getDate(), 24);
});

Deno.test("getEndDateByChargePeriod skips holidays", () => {
  const startDate = new TZDate(2024, 6, 2, 9, 0, 0, "America/Chicago");
  const result = getEndDateByChargePeriod(startDate, 3, ["2024-07-04"]);
  assertEquals(result.getDate(), 5);
});

Deno.test("getEndDateByChargePeriod handles 5-day week", () => {
  const startDate = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const result = getEndDateByChargePeriod(startDate, 5, []);
  assertEquals(result.getDate(), 21);
});

Deno.test("getEndDateByChargePeriod round-trips with countCfsBusinessDays", () => {
  const startDate = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  for (const period of [1, 2, 3, 5, 10]) {
    const endDate = getEndDateByChargePeriod(startDate, period, []);
    const duration = countCfsBusinessDays(startDate, endDate, []);
    assertEquals(duration.days, period);
  }
});

Deno.test("getEndDateByChargePeriod throws for invalid startDate", () => {
  assertThrows(
    () => getEndDateByChargePeriod(null as unknown as Date, 1, []),
    Error,
    "startDate not a valid date object",
  );
});

Deno.test("getEndDateByChargePeriod throws for chargePeriod < 1", () => {
  const startDate = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  assertThrows(
    () => getEndDateByChargePeriod(startDate, 0, []),
    Error,
    "charge period must be a whole number",
  );
});

// ── countCfsBusinessDays ─────────────────────────────────────────

Deno.test("countCfsBusinessDays counts 1 day for same-day range", () => {
  const start = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 17, 17, 0, 0, "America/Chicago");
  const result = countCfsBusinessDays(start, end, []);
  assertEquals(result.days, 1);
  assertEquals(result.label, "day");
  assertEquals(result.periodLabel, "1 day");
});

Deno.test("countCfsBusinessDays excludes weekends", () => {
  const start = new TZDate(2024, 5, 20, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 25, 17, 0, 0, "America/Chicago");
  const result = countCfsBusinessDays(start, end, []);
  assertEquals(result.calendarDays, 6);
  assertEquals(result.days, 4);
});

Deno.test("countCfsBusinessDays excludes holidays", () => {
  const start = new TZDate(2024, 6, 1, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 6, 5, 17, 0, 0, "America/Chicago");
  const result = countCfsBusinessDays(start, end, ["2024-07-04"]);
  assertEquals(result.calendarDays, 5);
  assertEquals(result.days, 4);
});

Deno.test("countCfsBusinessDays calculates weeks", () => {
  const start = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 21, 17, 0, 0, "America/Chicago");
  const result = countCfsBusinessDays(start, end, []);
  assertEquals(result.days, 5);
  assertEquals(result.weeks, 1);
  assertEquals(result.label, "week");
});

Deno.test("countCfsBusinessDays throws for invalid dates", () => {
  const end = new TZDate(2024, 5, 17, 17, 0, 0, "America/Chicago");
  assertThrows(
    () => countCfsBusinessDays(null as unknown as Date, end, []),
    Error,
    "start and end must be valid date objects",
  );
});

// ── getDuration ──────────────────────────────────────────────────

Deno.test("getDuration calculates active duration", () => {
  const start = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 19, 17, 0, 0, "America/Chicago");
  const result = getDuration({
    delivery_start: start.toISOString(),
    collection_start: end.toISOString(),
  }, []);
  assertEquals(result.activeDays, 3);
  assertEquals(result.activeLabel, "days");
});

Deno.test("getDuration computes charge independently when dates differ", () => {
  const deliveryStart = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const collectionStart = new TZDate(2024, 5, 21, 17, 0, 0, "America/Chicago");
  const chargeStart = new TZDate(2024, 5, 18, 9, 0, 0, "America/Chicago");
  const chargeEnd = new TZDate(2024, 5, 20, 17, 0, 0, "America/Chicago");
  const result = getDuration({
    delivery_start: deliveryStart.toISOString(),
    collection_start: collectionStart.toISOString(),
    charge_start: chargeStart.toISOString(),
    charge_end: chargeEnd.toISOString(),
  }, []);
  assertEquals(result.activeDays, 5);
  assertEquals(result.chargeDays, 3);
});

Deno.test("getDuration reuses active when charge dates match", () => {
  const start = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 21, 17, 0, 0, "America/Chicago");
  const iso1 = start.toISOString();
  const iso2 = end.toISOString();
  const result = getDuration({
    delivery_start: iso1,
    collection_start: iso2,
    charge_start: iso1,
    charge_end: iso2,
  }, []);
  assertEquals(result.chargeDays, result.activeDays);
});

Deno.test("getDuration throws for non-object dates", () => {
  assertThrows(
    () => getDuration(null as unknown as { delivery_start: string; collection_start: string }, []),
    Error,
    "dates must be a non-null object",
  );
});

// ── formatChargeDays ─────────────────────────────────────────────

Deno.test("formatChargeDays returns day label for 1", () => {
  const result = formatChargeDays(1);
  assertEquals(result.value, 1);
  assertEquals(result.label, "day");
  assertEquals(result.isWeeks, false);
});

Deno.test("formatChargeDays returns week label for 5", () => {
  const result = formatChargeDays(5);
  assertEquals(result.value, 1);
  assertEquals(result.label, "week");
  assertEquals(result.isWeeks, true);
});

Deno.test("formatChargeDays returns weeks for 10", () => {
  const result = formatChargeDays(10);
  assertEquals(result.value, 2);
  assertEquals(result.label, "weeks");
});

Deno.test("formatChargeDays forces weeks with unit override", () => {
  const result = formatChargeDays(3, "weeks");
  assertEquals(result.isWeeks, true);
});

Deno.test("formatChargeDays forces days with unit override", () => {
  const result = formatChargeDays(10, "days");
  assertEquals(result.value, 10);
  assertEquals(result.isWeeks, false);
});

Deno.test("formatChargeDays throws for zero", () => {
  assertThrows(() => formatChargeDays(0), Error, "days must be a positive number");
});

Deno.test("formatChargeDays throws for invalid unit", () => {
  // deno-lint-ignore no-explicit-any
  assertThrows(() => formatChargeDays(3, "months" as any), Error, "unit must be one of");
});

// ── toChargeDays ─────────────────────────────────────────────────

Deno.test("toChargeDays returns same value in days mode", () => {
  assertEquals(toChargeDays(3, false), 3);
});

Deno.test("toChargeDays multiplies by 5 in weeks mode", () => {
  assertEquals(toChargeDays(2, true), 10);
});

Deno.test("toChargeDays round-trips with formatChargeDays", () => {
  for (const days of [1, 3, 5, 10]) {
    const formatted = formatChargeDays(days);
    const result = toChargeDays(formatted.value, formatted.isWeeks);
    assertEquals(result, days);
  }
});

Deno.test("toChargeDays throws for negative", () => {
  assertThrows(
    () => toChargeDays(-1, false),
    Error,
    "inputValue must be a non-negative number",
  );
});

// ── toChicagoInstant ────────────────────────────────────────────

Deno.test("toChicagoInstant converts Z form to Chicago offset (CST)", () => {
  assertEquals(
    toChicagoInstant("2025-12-22T15:15:00.000Z"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("toChicagoInstant converts Z form to Chicago offset (CDT)", () => {
  assertEquals(
    toChicagoInstant("2025-07-04T14:15:00.000Z"),
    "2025-07-04T09:15:00.000-05:00",
  );
});

Deno.test("toChicagoInstant is no-op for canonical offset form", () => {
  assertEquals(
    toChicagoInstant("2025-12-22T09:15:00.000-06:00"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("toChicagoInstant converts other-tz offset to Chicago, same instant", () => {
  assertEquals(
    toChicagoInstant("2025-12-23T00:15:00.000+09:00"),
    "2025-12-22T09:15:00.000-06:00",
  );
});

Deno.test("toChicagoInstant preserves instant across forms", () => {
  const z = "2025-12-22T15:15:00.000Z";
  const chicago = toChicagoInstant(z);
  assertEquals(
    new Date(chicago).getTime(),
    new Date(z).getTime(),
  );
});

Deno.test("toChicagoInstant is idempotent", () => {
  const once = toChicagoInstant("2025-12-22T15:15:00.000Z");
  const twice = toChicagoInstant(once);
  assertEquals(once, twice);
});

Deno.test("toChicagoInstant DST spring-forward (pre-jump is CST)", () => {
  assertEquals(
    toChicagoInstant("2025-03-09T07:30:00.000Z"),
    "2025-03-09T01:30:00.000-06:00",
  );
});

Deno.test("toChicagoInstant DST spring-forward (post-jump is CDT)", () => {
  assertEquals(
    toChicagoInstant("2025-03-09T08:30:00.000Z"),
    "2025-03-09T03:30:00.000-05:00",
  );
});

Deno.test("toChicagoInstant DST fall-back (early hour is CST)", () => {
  assertEquals(
    toChicagoInstant("2025-11-02T07:30:00.000Z"),
    "2025-11-02T01:30:00.000-06:00",
  );
});

// ── toChicagoStartOfDay ─────────────────────────────────────────

Deno.test("toChicagoStartOfDay snaps instant to Chicago midnight (CST)", () => {
  assertEquals(
    toChicagoStartOfDay("2025-12-22T15:15:00.000Z"),
    "2025-12-22T00:00:00.000-06:00",
  );
});

Deno.test("toChicagoStartOfDay crosses back to previous Chicago day", () => {
  assertEquals(
    toChicagoStartOfDay("2025-12-22T03:00:00.000Z"),
    "2025-12-21T00:00:00.000-06:00",
  );
});

Deno.test("toChicagoStartOfDay handles date-only string (CDT)", () => {
  assertEquals(
    toChicagoStartOfDay("2025-07-04"),
    "2025-07-04T00:00:00.000-05:00",
  );
});

Deno.test("toChicagoStartOfDay handles date-only string (CST)", () => {
  assertEquals(
    toChicagoStartOfDay("2025-01-04"),
    "2025-01-04T00:00:00.000-06:00",
  );
});

Deno.test("toChicagoStartOfDay is idempotent", () => {
  const once = toChicagoStartOfDay("2025-12-22T15:15:00.000Z");
  const twice = toChicagoStartOfDay(once);
  assertEquals(once, twice);
});

Deno.test("toChicagoStartOfDay produces CDT offset for date inside DST window", () => {
  assertEquals(
    toChicagoStartOfDay("2025-07-04T12:00:00.000Z"),
    "2025-07-04T00:00:00.000-05:00",
  );
});

// ── toChicagoEndOfDay ───────────────────────────────────────────

Deno.test("toChicagoEndOfDay snaps instant to the last ms of the Chicago day (CST)", () => {
  assertEquals(
    toChicagoEndOfDay("2025-12-22T15:15:00.000Z"),
    "2025-12-22T23:59:59.999-06:00",
  );
});

Deno.test("toChicagoEndOfDay crosses back to the previous Chicago day", () => {
  // 03:00Z is still Dec 21 in Chicago.
  assertEquals(
    toChicagoEndOfDay("2025-12-22T03:00:00.000Z"),
    "2025-12-21T23:59:59.999-06:00",
  );
});

Deno.test("toChicagoEndOfDay handles a date-only string (CDT)", () => {
  assertEquals(
    toChicagoEndOfDay("2025-07-04"),
    "2025-07-04T23:59:59.999-05:00",
  );
});

Deno.test("toChicagoEndOfDay is idempotent", () => {
  const once = toChicagoEndOfDay("2025-12-22T15:15:00.000Z");
  assertEquals(toChicagoEndOfDay(once), once);
});

Deno.test("toChicagoEndOfDay closes the window its start-of-day twin opens", () => {
  // The pair must bracket the whole calendar day with no gap and no overlap.
  const start = toChicagoStartOfDay("2025-12-22T15:15:00.000Z");
  const end = toChicagoEndOfDay("2025-12-22T15:15:00.000Z");
  assertEquals(Date.parse(end) - Date.parse(start), 24 * 60 * 60 * 1000 - 1);
});

Deno.test("toChicagoEndOfDay: DST spring-forward day is 23h long", () => {
  // 2025-03-09: America/Chicago loses an hour at 02:00. The day still ends at
  // 23:59:59.999 local, but only 23h after its start — and the offset flips
  // CST→CDT across the boundary, which a naive +24h would get wrong.
  const start = toChicagoStartOfDay("2025-03-09T12:00:00.000Z");
  const end = toChicagoEndOfDay("2025-03-09T12:00:00.000Z");
  assertEquals(start, "2025-03-09T00:00:00.000-06:00");
  assertEquals(end, "2025-03-09T23:59:59.999-05:00");
  assertEquals(Date.parse(end) - Date.parse(start), 23 * 60 * 60 * 1000 - 1);
});

Deno.test("toChicagoEndOfDay: DST fall-back day is 25h long", () => {
  // 2025-11-02: America/Chicago repeats an hour at 02:00 (CDT→CST).
  const start = toChicagoStartOfDay("2025-11-02T12:00:00.000Z");
  const end = toChicagoEndOfDay("2025-11-02T12:00:00.000Z");
  assertEquals(start, "2025-11-02T00:00:00.000-05:00");
  assertEquals(end, "2025-11-02T23:59:59.999-06:00");
  assertEquals(Date.parse(end) - Date.parse(start), 25 * 60 * 60 * 1000 - 1);
});

// ── toChicagoYmd ────────────────────────────────────────────────

Deno.test("toChicagoYmd returns Chicago calendar date from canonical CST offset", () => {
  assertEquals(
    toChicagoYmd("2025-02-14T00:00:00.000-06:00"),
    "2025-02-14",
  );
});

Deno.test("toChicagoYmd returns Chicago calendar date from canonical CDT offset", () => {
  assertEquals(
    toChicagoYmd("2025-07-04T00:00:00.000-05:00"),
    "2025-07-04",
  );
});

Deno.test("toChicagoYmd interprets Z-form in Chicago TZ (midnight-crossing)", () => {
  // 2025-02-14T03:00:00Z === 2025-02-13T21:00:00-06:00 (Chicago day = Feb 13)
  assertEquals(
    toChicagoYmd("2025-02-14T03:00:00.000Z"),
    "2025-02-13",
  );
});

Deno.test("toChicagoYmd interprets Z-form daytime in Chicago TZ (same day)", () => {
  assertEquals(
    toChicagoYmd("2025-07-04T18:00:00.000Z"),
    "2025-07-04",
  );
});

Deno.test("toChicagoYmd round-trips with toChicagoStartOfDay", () => {
  const start = toChicagoStartOfDay("2025-02-14");
  assertEquals(toChicagoYmd(start), "2025-02-14");
});

// ── addChicagoDays / chicagoDaysBetween ──────────────────────────
//
// 🔴 **The fall-back case is the one that discriminates.** Both of these are
// calendar arithmetic precisely because `+ n * 86400000` is wrong across a DST
// boundary — and it is wrong in only ONE direction. Measured 2026-09-07: the
// naive form returns `2026-11-03` where the answer is `2026-11-04`, while the
// spring-forward span happens to come out right because the extra hour is
// absorbed by the `startOfDay` snap. **A suite that crosses only March is green
// on a broken implementation**, so the November case is not a duplicate of the
// March one and must not be dropped as redundant.

Deno.test("addChicagoDays crosses spring-forward (CST -> CDT)", () => {
  assertEquals(
    addChicagoDays("2026-02-25T00:00:00.000-06:00", 15),
    "2026-03-12T00:00:00.000-05:00",
  );
});

Deno.test("🔴 addChicagoDays crosses fall-back — naive ms arithmetic returns 11-03 here", () => {
  assertEquals(
    addChicagoDays("2026-10-20T00:00:00.000-05:00", 15),
    "2026-11-04T00:00:00.000-06:00",
  );
});

Deno.test("addChicagoDays within one offset", () => {
  assertEquals(
    addChicagoDays("2026-06-01T00:00:00.000-05:00", 15),
    "2026-06-16T00:00:00.000-05:00",
  );
});

Deno.test("addChicagoDays takes a negative count", () => {
  assertEquals(
    addChicagoDays("2026-06-16T00:00:00.000-05:00", -15),
    "2026-06-01T00:00:00.000-05:00",
  );
});

Deno.test("addChicagoDays(0) is the Chicago start of day, not a no-op", () => {
  // The contract is a calendar DATE, so a mid-day input snaps to midnight.
  assertEquals(
    addChicagoDays("2026-06-01T15:15:00.000-05:00", 0),
    "2026-06-01T00:00:00.000-05:00",
  );
});

Deno.test("addChicagoDays normalizes a non-Chicago input to the Chicago calendar day", () => {
  // 03:00Z on Jun 2 is still Jun 1 in Chicago — the day the count starts from.
  assertEquals(
    addChicagoDays("2026-06-02T03:00:00.000Z", 15),
    "2026-06-16T00:00:00.000-05:00",
  );
});

Deno.test("chicagoDaysBetween counts calendar days across spring-forward", () => {
  assertEquals(
    chicagoDaysBetween("2026-03-16T00:00:00.000-05:00", "2026-03-01T00:00:00.000-06:00"),
    15,
  );
});

Deno.test("🔴 chicagoDaysBetween counts calendar days across fall-back", () => {
  assertEquals(
    chicagoDaysBetween("2026-11-09T00:00:00.000-06:00", "2026-10-25T00:00:00.000-05:00"),
    15,
  );
});

Deno.test("chicagoDaysBetween is signed and zero on the same date", () => {
  assertEquals(
    chicagoDaysBetween("2026-06-01T00:00:00.000-05:00", "2026-06-16T00:00:00.000-05:00"),
    -15,
  );
  assertEquals(
    chicagoDaysBetween("2026-06-01T23:59:00.000-05:00", "2026-06-01T00:00:00.000-05:00"),
    0,
  );
});

Deno.test("chicagoDaysBetween counts BOUNDARIES, not elapsed time", () => {
  // Two minutes apart, one calendar boundary — the right answer for a report
  // that ages by date, and the wrong one for a duration. See getDuration.
  assertEquals(
    chicagoDaysBetween("2026-06-02T00:01:00.000-05:00", "2026-06-01T23:59:00.000-05:00"),
    1,
  );
});

Deno.test("addChicagoDays and chicagoDaysBetween round-trip across both boundaries", () => {
  for (const start of ["2026-02-25T00:00:00.000-06:00", "2026-10-20T00:00:00.000-05:00"]) {
    for (const n of [1, 15, 30, 90, 365]) {
      assertEquals(chicagoDaysBetween(addChicagoDays(start, n), start), n);
    }
  }
});

// ── Chicago display formatting ──────────────────────────────────────

Deno.test("formatChicago* — an offset-bearing instant renders its Chicago day", () => {
  const iso = "2026-09-07T00:00:00.000-05:00";
  assertEquals(formatChicagoDate(iso), "September 7, 2026");
  assertEquals(formatChicagoShortDate(iso), "9/7/26");
  assertEquals(formatChicagoWeekdayDate(iso), "Mon 9/7/26");
});

Deno.test("🔴 formatChicago* — a ZONE-LESS date is the Chicago day it NAMES, in any container zone", () => {
  // The whole reason these exist. `parseISO` on a date-only string resolves it
  // against the AMBIENT zone, so an unpinned parse formatted into Chicago lands
  // on the previous day wherever the process is west of nothing — measured in
  // production (UTC) as "August 31, 2026" for this exact input.
  //
  // ⚠️ Deno resolves the ambient zone once per process, so this arm cannot flip
  // `TZ` and re-measure in-process; what it pins is the ANSWER, which is
  // container-independent by construction because both the parse and the format
  // name Chicago. `templates`' `lint:dates` is what stops an unpinned call being
  // written in the first place.
  assertEquals(formatChicagoDate("2026-09-01"), "September 1, 2026");
  assertEquals(formatChicagoShortDate("2026-09-01"), "9/1/26");
  assertEquals(formatChicagoWeekdayDate("2026-09-01"), "Tue 9/1/26");
});

Deno.test("🔴 formatChicago* — across the DST boundary, both directions", () => {
  // CST and CDT, so an implementation that hardcoded one offset fails here. The
  // 2026 US transitions are 8 March (spring forward) and 1 November (fall back).
  assertEquals(formatChicagoDate("2026-01-15"), "January 15, 2026"); // CST
  assertEquals(formatChicagoDate("2026-07-15"), "July 15, 2026"); // CDT
  assertEquals(formatChicagoDate("2026-11-01"), "November 1, 2026"); // the fall-back day itself
  assertEquals(formatChicagoDate("2026-03-08"), "March 8, 2026"); // the spring-forward day itself
});

Deno.test("🔴 formatChicagoDateTime — an evening instant keeps its CHICAGO day, not the UTC one", () => {
  // 19:00 CDT is exactly 00:00 UTC, which is the boundary `quote`'s
  // `evening-boundary` fixture exists for: unpinned, this prints the NEXT day.
  assertEquals(
    formatChicagoDateTime("2026-04-30T19:00:00.000-05:00"),
    "April 30, 2026 · 7:00 PM",
  );
  assertEquals(formatChicagoDate("2026-04-30T19:00:00.000-05:00"), "April 30, 2026");
});

Deno.test("formatChicagoDateTime — renders the minute, which is why it is a separate helper", () => {
  assertEquals(
    formatChicagoDateTime("2026-09-02T14:05:00.000-05:00"),
    "September 2, 2026 · 2:05 PM",
  );
});

// ── the non-terminating window ───────────────────────────────────

// `countCfsBusinessDays` walks FORWARD from `start` toward `addDays(end, 1)`.
// An end two or more calendar days behind the start is therefore unreachable
// and the loop spins forever — a hung request server-side, a frozen tab in a
// browser. These arms come in pairs on purpose: the throw alone is satisfied by
// a naive `end < start` guard, which would refuse the one-day case below that
// the corpus already stores and every consumer already renders correctly.

Deno.test("countCfsBusinessDays throws when end is two calendar days before start", () => {
  const start = new TZDate(2024, 5, 19, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 17, 17, 0, 0, "America/Chicago");
  assertThrows(
    () => countCfsBusinessDays(start, end, []),
    Error,
    "would not terminate",
  );
});

Deno.test("countCfsBusinessDays ACCEPTS an end exactly one calendar day before start", () => {
  // `addDays(end, 1)` lands on `start`, so the body never runs. A real,
  // storable zero-day window — not an error.
  const start = new TZDate(2024, 5, 18, 9, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 17, 17, 0, 0, "America/Chicago");
  const result = countCfsBusinessDays(start, end, []);
  assertEquals(result.calendarDays, 0);
  assertEquals(result.days, 0);
});

Deno.test("countCfsBusinessDays accepts a same-day window whose end TIME is earlier", () => {
  // Same calendar day, end clock-time before start clock-time. The walk is
  // day-granular, so this is the ordinary one-day answer. Brackets the `:154`
  // arm, which covers the same day in the other direction.
  const start = new TZDate(2024, 5, 17, 17, 0, 0, "America/Chicago");
  const end = new TZDate(2024, 5, 17, 9, 0, 0, "America/Chicago");
  assertEquals(countCfsBusinessDays(start, end, []).days, 1);
});

Deno.test("isNonTerminatingWindow answers the boundary, not the ordering", () => {
  const at = (ymd: string, hm: string) => toChicagoInstant(`${ymd}T${hm}:00`);
  // Two or more days behind — unreachable.
  assertEquals(isNonTerminatingWindow(at("2024-06-19", "09:00"), at("2024-06-17", "17:00")), true);
  // Exactly one day behind — reachable, zero days.
  assertEquals(isNonTerminatingWindow(at("2024-06-18", "09:00"), at("2024-06-17", "17:00")), false);
  // Same day, earlier clock time — reachable.
  assertEquals(isNonTerminatingWindow(at("2024-06-17", "17:00"), at("2024-06-17", "09:00")), false);
  // Ordinary forward window.
  assertEquals(isNonTerminatingWindow(at("2024-06-17", "09:00"), at("2024-06-21", "17:00")), false);
});

// ── getDefaultStartDate ──────────────────────────────────────────

// The default start for a new order, and until now the only helper in this
// module with no test at all. Asserted by clock-independent PROPERTIES: it
// reads the wall clock, and this suite runs `--parallel` on the promise that
// nothing MUTATES the clock, which reading does not.

Deno.test("getDefaultStartDate opens at 09:00 Chicago", () => {
  const d = getDefaultStartDate([]);
  assertEquals(d.getHours(), 9);
  assertEquals(d.getMinutes(), 0);
  assertEquals(d.getSeconds(), 0);
  assertEquals(d.getMilliseconds(), 0);
});

Deno.test("getDefaultStartDate never lands on a weekend", () => {
  const day = getDefaultStartDate([]).getDay();
  assertEquals(day === 0 || day === 6, false);
});

Deno.test("getDefaultStartDate skips past a run of holidays", () => {
  // Every one of the next 12 calendar days is a holiday, so the result must
  // clear all of them — and still not be a weekend. Fixes the answer relative
  // to today without fixing today, which is what keeps this hermetic.
  const today = toChicagoYmd(TZDate.tz("America/Chicago").toISOString());
  const closed = Array.from({ length: 12 }, (_, i) => toChicagoYmd(addChicagoDays(`${today}T12:00:00.000-05:00`, i)));
  const d = getDefaultStartDate(closed);
  assertEquals(closed.includes(toChicagoYmd(d.toISOString())), false);
  const day = d.getDay();
  assertEquals(day === 0 || day === 6, false);
});
