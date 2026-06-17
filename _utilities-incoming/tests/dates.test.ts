import { assertEquals, assertThrows } from "@std/assert";
import { TZDate } from "@date-fns/tz";
import {
  countCfsBusinessDays,
  formatChargeDays,
  getDuration,
  getEndDateByChargePeriod,
  isHoliday,
  isOffHours,
  toChargeDays,
  toChicagoInstant,
  toChicagoStartOfDay,
  toChicagoYmd,
} from "../src/dates.ts";

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
