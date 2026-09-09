/**
 * Pure date helper functions for CFS applications.
 * All functions accept holidays as a parameter to enable client-side calculations.
 *
 * ```ts
 * import { formatChargeDays, countCfsBusinessDays } from "@cfs/core/utils/dates";
 *
 * const result = formatChargeDays(10);
 * console.log(result.periodLabel); // "2 weeks"
 *
 * const start = new Date("2025-01-06");
 * const end = new Date("2025-01-10");
 * const days = countCfsBusinessDays(start, end, []);
 * console.log(days.days); // 5
 * ```
 *
 * Published in lockstep with `@cfs/core/schemas` — version bumps track the
 * schemas package so consumers pin one pair of beta versions without
 * resolving dual shapes (Card.recurrence_overrides, Recurrence collection
 * rollout, etc.).
 *
 * @module
 */

import {
  addDays,
  differenceInCalendarDays,
  endOfDay,
  format,
  getHours,
  isAfter,
  isBefore,
  isSameDay,
  isValid,
  isWeekend,
  parseISO,
  set,
  startOfDay,
} from "date-fns";
import { TZDate, tz } from "@date-fns/tz";

/**
 * Canonicalize any valid ISO datetime string to Chicago offset form,
 * preserving the instant. Idempotent.
 *
 * ```ts
 * toChicagoInstant("2025-12-22T15:15:00.000Z");      // "2025-12-22T09:15:00.000-06:00"
 * toChicagoInstant("2025-12-22T09:15:00.000-06:00"); // "2025-12-22T09:15:00.000-06:00" (no-op)
 * toChicagoInstant("2025-12-23T00:15:00.000+09:00"); // "2025-12-22T09:15:00.000-06:00" (same instant)
 * ```
 */
export function toChicagoInstant(input: string): string {
  return parseISO(input, { in: tz("America/Chicago") }).toISOString();
}

/**
 * Canonicalize to Chicago local midnight for the calendar date containing
 * the input instant. Use for fields that semantically represent a date
 * (invoice.date, invoice.due_date, payments[].date). Idempotent.
 *
 * ```ts
 * toChicagoStartOfDay("2025-12-22T15:15:00.000Z"); // "2025-12-22T00:00:00.000-06:00"
 * toChicagoStartOfDay("2025-12-22T03:00:00.000Z"); // "2025-12-21T00:00:00.000-06:00" (Chicago day = Dec 21)
 * toChicagoStartOfDay("2025-07-04");               // "2025-07-04T00:00:00.000-05:00" (CDT)
 * ```
 */
export function toChicagoStartOfDay(input: string): string {
  return startOfDay(parseISO(input, { in: tz("America/Chicago") }))
    .toISOString();
}

/**
 * Canonicalize to the last representable instant of the Chicago calendar date
 * containing the input (`23:59:59.999` local). The closing twin of
 * {@link toChicagoStartOfDay} — together they turn a pair of dates into the
 * half-open-in-spirit, closed-in-fact window `[startOfDay(s), endOfDay(e)]` that
 * {@link module:stock} overlaps intervals against. Idempotent, DST-aware.
 *
 * ```ts
 * toChicagoEndOfDay("2025-12-22T15:15:00.000Z"); // "2025-12-22T23:59:59.999-06:00"
 * toChicagoEndOfDay("2025-12-22T03:00:00.000Z"); // "2025-12-21T23:59:59.999-06:00" (Chicago day = Dec 21)
 * toChicagoEndOfDay("2025-07-04");               // "2025-07-04T23:59:59.999-05:00" (CDT)
 * ```
 */
export function toChicagoEndOfDay(input: string): string {
  return endOfDay(parseISO(input, { in: tz("America/Chicago") }))
    .toISOString();
}

/**
 * Format an ISO datetime as the Chicago calendar date in `YYYY-MM-DD` form.
 * The inverse of {@link toChicagoStartOfDay} — use to populate
 * `<input type="date">` from a canonical Chicago-offset value.
 *
 * ```ts
 * toChicagoYmd("2025-02-14T00:00:00.000-06:00"); // "2025-02-14"
 * toChicagoYmd("2025-02-14T03:00:00.000Z");      // "2025-02-13" (Chicago day)
 * toChicagoYmd("2025-07-04T00:00:00.000-05:00"); // "2025-07-04" (CDT)
 * ```
 */
export function toChicagoYmd(input: string): string {
  return format(parseISO(input), "yyyy-MM-dd", { in: tz("America/Chicago") });
}

/**
 * The Chicago start of day `days` calendar days after `input`'s Chicago
 * calendar date. DST-aware; `days` may be negative.
 *
 * 🔴 **Calendar arithmetic, NOT `+ days * 86400000`, and the difference is a
 * silent off-by-one twice a year.** Chicago days are 23 or 25 hours long across
 * a DST boundary, so adding a fixed number of milliseconds lands on the wrong
 * calendar date whenever the span crosses one. Measured 2026-09-07, the
 * fall-back direction:
 *
 * ```text
 * 2026-10-20 + 15 days   correct: 2026-11-04    naive ms: 2026-11-03
 * ```
 *
 * The spring-forward direction happens to survive the naive form — the extra
 * hour is absorbed by the `startOfDay` snap — which is exactly what makes this
 * hard to catch by testing one boundary. ⚠️ **A test that only crosses March is
 * green on a broken implementation.**
 *
 * ⭐ Returns the START OF DAY, not the input's time of day. Both callers
 * (`invoice.due_date`, which is a `chicagoStartOfDay()` field, and aging-bucket
 * edges) want a calendar date, and a helper that sometimes preserved a time
 * would put the DST question back where it started.
 *
 * ```ts
 * addChicagoDays("2026-02-25T00:00:00.000-06:00", 15); // "2026-03-12T00:00:00.000-05:00"
 * addChicagoDays("2026-10-20T00:00:00.000-05:00", 15); // "2026-11-04T00:00:00.000-06:00"
 * addChicagoDays("2026-06-16T00:00:00.000-05:00", -15); // "2026-06-01T00:00:00.000-05:00"
 * ```
 */
export function addChicagoDays(input: string, days: number): string {
  return startOfDay(addDays(parseISO(input, { in: tz("America/Chicago") }), days))
    .toISOString();
}

/**
 * Whole Chicago calendar days from `earlier` to `later` — positive when `later`
 * is the later date, negative when it is not, `0` on the same calendar date.
 *
 * 🔴 **The aging report's bucket edges are calendar days, so this cannot be a
 * millisecond subtraction** — same DST hazard as {@link addChicagoDays}, and
 * here it moves an invoice between buckets rather than merely mis-dating it. It
 * counts DATE BOUNDARIES CROSSED, so it is insensitive to the times of day and
 * to the two irregular days entirely.
 *
 * ⚠️ **Not a duration.** `chicagoDaysBetween(a, b)` is `1` for 23:59 yesterday →
 * 00:01 today, which is two minutes. That is the right answer for a report that
 * ages by date and the wrong one for anything measuring elapsed time — for that,
 * see {@link getDuration}.
 *
 * ```ts
 * chicagoDaysBetween("2026-03-16T00:00:00.000-05:00", "2026-03-01T00:00:00.000-06:00"); // 15
 * chicagoDaysBetween("2026-11-09T00:00:00.000-06:00", "2026-10-25T00:00:00.000-05:00"); // 15
 * chicagoDaysBetween("2026-06-01T00:00:00.000-05:00", "2026-06-16T00:00:00.000-05:00"); // -15
 * ```
 */
export function chicagoDaysBetween(later: string, earlier: string): number {
  return differenceInCalendarDays(
    parseISO(later, { in: tz("America/Chicago") }),
    parseISO(earlier, { in: tz("America/Chicago") }),
  );
}

// ── Display formatting ──────────────────────────────────────────────

/**
 * The one timezone this business keeps. Bound once so no caller names it.
 *
 * 🔴 **Naming a zone at a CALL SITE is the defect these helpers exist to
 * remove.** The correct spelling by hand is
 * `format(parseISO(x, { in: CHICAGO }), pattern, { in: CHICAGO })` — the zone
 * appears TWICE, and omitting either is silent, correct on a developer machine
 * in Chicago, and wrong in a UTC container. Eleven call sites across the
 * `templates` repo pinned the format and not the parse, and a customer statement
 * printed its period start a day early in production as a result.
 */
const CHICAGO = tz("America/Chicago");

/**
 * Parse in Chicago, so a string with NO offset is read as the Chicago
 * wall-clock day it NAMES rather than resolved against the ambient zone.
 *
 * ⚠️ **`{ in: … }` on the format alone does not save you** — by then the zone is
 * already lost. Measured on one string, three container zones:
 *
 * ```
 * TZ=UTC              2026-09-01  ->  August 31, 2026   (unpinned parse)
 * TZ=Asia/Tokyo       2026-09-01  ->  August 31, 2026   (unpinned parse)
 * TZ=America/Chicago  2026-09-01  ->  September 1, 2026 (unpinned parse)
 * any of the three    2026-09-01  ->  September 1, 2026 (parsed in Chicago)
 * ```
 *
 * An input that already carries an offset is unaffected either way, which is
 * exactly why this class of bug is so quiet: every datetime stored by CFS
 * carries one, so an unpinned call is correct on every document anyone tests
 * with, and only a value that skipped the storage contract exposes it.
 */
const inChicago = (input: string): Date => parseISO(input, { in: CHICAGO });

/**
 * A date as a CFS document prints it — `"September 1, 2026"`.
 *
 * ⭐ **The zone is named zero times by the caller**, which is the whole point:
 * these five helpers exist so a template cannot get it half-right. They also
 * make the document typography enforced rather than coincidental — `MMMM d,
 * yyyy` was repeated by convention in five places, and nothing stopped a sixth
 * family writing `MMM d, yyyy`.
 *
 * ⚠️ **Add a fifth NAME here rather than hand-rolling a fifth pattern.** A
 * hand-rolled call is not forbidden — `templates`' `lint:dates` requires only
 * that it name the zone — but a one-off pattern is how a document set stops
 * looking like one company's paperwork.
 */
export function formatChicagoDate(input: string): string {
  return format(inChicago(input), "MMMM d, yyyy", { in: CHICAGO });
}

/**
 * A date and time — `"September 1, 2026 · 2:05 PM"`.
 *
 * For a document recording WHEN something happened to the minute: a receipt for
 * goods changing hands, a pick sheet's render stamp. Two check-ins on one day
 * are routine, and a date alone cannot tell them apart.
 */
export function formatChicagoDateTime(input: string): string {
  return format(inChicago(input), "MMMM d, yyyy · h:mm a", { in: CHICAGO });
}

/** A compact numeric date for a dense column — `"9/1/26"`. */
export function formatChicagoShortDate(input: string): string {
  return format(inChicago(input), "M/d/yy", { in: CHICAGO });
}

/**
 * A weekday and a compact date — `"Wed 9/1/26"`.
 *
 * The delivery/collection form. The weekday is load-bearing on those: a crew
 * reads "is that a Saturday" off the page, and the date alone does not say.
 */
export function formatChicagoWeekdayDate(input: string): string {
  return format(inChicago(input), "EEE M/d/yy", { in: CHICAGO });
}

/**
 * The time of day alone — `"9:00 AM"`.
 *
 * ⭐ **The one helper here that renders a FRAGMENT rather than a whole date**,
 * and it exists because of a width. A delivery boundary carries an hour worth
 * showing — prod delivery times run 03:00 to 21:00, so a 06:30 drop and a 21:00
 * drop are otherwise the same row — but `templates`' destinations block is four
 * columns summing to the alignment edge every table on the page shares.
 * Measured in Chromium at 9px: `Wed 12/22/26` is 60.6px and
 * `Wed 12/22/26 · 12:00 AM` is 110.3px, so an inline time would have widened
 * that shared edge from 24rem to 35rem and re-gridded every document. Stacked
 * on a second line the time is 41.4px and fits the column already there.
 *
 * So the caller pairs it with {@link formatChicagoWeekdayDate} on the line
 * above rather than asking for one combined string. It still parses in
 * Chicago — a fragment is exactly where a zone is easiest to lose, and
 * `2026-04-30T19:00:00.000-05:00` is `7:00 PM` here and `12:00 AM` unpinned.
 *
 * ⚠️ **A destination boundary renders as a POINT — because of the WRITER, and
 * not because the domain forbids a window.** `delivery_end` equals
 * `delivery_start`, and `collection_end` equals `collection_start`, on all
 * 1,020 destinations of all 1,020 prod orders (full census 2026-09-09, widened
 * from the 190-order sample this note first cited). That is a fact about
 * `manager`'s `OrderDestinationDates.saveDatesAndSync`, which mirrors both
 * `*_end ← *_start` and offers no editor for either end. So today a caller
 * renders one of the pair and never a range — `9:00 AM – 9:00 AM` would be a
 * window one instant wide that does not exist.
 *
 * 🔴 **Do not read this as a ruling that a boundary IS a point. Windows are a
 * roadmap item** (owner, 2026-09-09: *"right now they set equal, in the future
 * they wont"*), so the day an editor ships, `start !== end` becomes ordinary and
 * a caller rendering one half starts hiding real information. ⭐ The `charge`
 * pair in the same map is the control: it DIFFERS on 970 of the same 1,020
 * destinations, because it is the one pair that already has an independent
 * editor. **The uniformity measures the missing editor, never the domain.**
 * api-cloudrun#943 has the consumer map and the decision.
 */
export function formatChicagoTime(input: string): string {
  return format(inChicago(input), "h:mm a", { in: CHICAGO });
}

/** Display values returned by {@link formatChargeDays}. */
export type ChargeDaysLabel = "day" | "days" | "week" | "weeks";

export interface FormatChargeDaysResult {
  value: number;
  label: ChargeDaysLabel;
  periodLabel: string;
  isWeeks: boolean;
  step: number;
}

/**
 * Format a chargeable days number into display values for a duration input.
 *
 * The unit (day vs. week) is chosen one of two ways:
 * - **Explicit** — pass `unit` (`"day"`, `"days"`, `"week"`, or `"weeks"`); the
 *   caller's choice wins, and singular/plural is normalized from the computed value.
 * - **Auto (omit `unit`)** — the mode is derived from the day count: weeks when
 *   `days >= 5`, days when `days < 5` (the boundary `days === 5` formats as `1 week`).
 *   Omitting the argument *is* the auto path — there is no separate `"default"`/`"auto"` unit value.
 *
 * In weeks mode `value = days / 5` and `step = 0.2`; in days mode `value = days` and
 * `step = 1`. `label` is always one of the four concrete {@link ChargeDaysLabel} literals,
 * singularized when `value === 1`.
 *
 * @param days - A positive, finite number of chargeable days. Throws on `<= 0` / non-finite.
 * @param unit - Optional display unit. Omit to auto-derive from `days` (see above).
 * @returns {@link FormatChargeDaysResult} — `{ value, label, periodLabel, isWeeks, step }`.
 */
export function formatChargeDays(
  days: number,
  unit?: "day" | "days" | "week" | "weeks",
): FormatChargeDaysResult {
  if (typeof days !== "number" || !isFinite(days) || days <= 0) {
    throw new Error("days must be a positive number; days: " + days);
  }

  let isWeeks: boolean;
  if (unit !== undefined) {
    if (!["day", "days", "week", "weeks"].includes(unit)) {
      throw new Error(
        "unit must be one of 'day', 'days', 'week', 'weeks'; unit: " + unit,
      );
    }
    isWeeks = unit === "week" || unit === "weeks";
  } else {
    isWeeks = days >= 5;
  }

  const value = isWeeks ? days / 5 : days;
  const step = isWeeks ? 0.2 : 1;

  let label: ChargeDaysLabel;
  if (isWeeks) {
    label = value === 1 ? "week" : "weeks";
  } else {
    label = value === 1 ? "day" : "days";
  }
  const periodLabel = value + " " + label;

  return { value, label, periodLabel, isWeeks, step };
}

/**
 * Convert a duration input value back to chargeable days.
 */
export function toChargeDays(inputValue: number, isWeeks: boolean): number {
  if (
    typeof inputValue !== "number" || !isFinite(inputValue) || inputValue < 0
  ) {
    throw new Error("inputValue must be a non-negative number");
  }

  return isWeeks ? inputValue * 5 : inputValue;
}

/**
 * Test if a given date is a CFS holiday.
 */
export function isHoliday(testDate: Date, holidays: string[]): boolean {
  if (!testDate || !isValid(testDate)) {
    throw new Error("testDate must be a valid date object");
  }
  if (!Array.isArray(holidays)) {
    throw new Error("holidays must be an array");
  }

  for (const holiday of holidays) {
    if (
      isSameDay(parseISO(holiday, { in: tz("America/Chicago") }), testDate)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Test if a date/time is outside business hours (before 8am or after 4pm).
 */
export function isOffHours(date: Date): boolean {
  if (!date || !isValid(date)) {
    throw new Error("date must be a valid date object");
  }

  const open = set(date, { hours: 8, minutes: 0, seconds: 0, milliseconds: 0 }, {
    in: tz("America/Chicago"),
  });
  const close = set(date, { hours: 16, minutes: 0, seconds: 0, milliseconds: 0 }, {
    in: tz("America/Chicago"),
  });

  if (isBefore(date, open) || isAfter(date, close)) {
    return true;
  } else {
    return false;
  }
}

/**
 * Get the default start date for a rental (next business day at 9am).
 * If after 8am today, defaults to tomorrow. Skips weekends and holidays.
 */
export function getDefaultStartDate(holidays: string[]): Date {
  if (!Array.isArray(holidays)) {
    throw new Error("holidays must be an array");
  }

  let day: Date = TZDate.tz("America/Chicago");

  if (getHours(day) > 8) {
    day = addDays(day, 1);
  }

  day = set(day, { hours: 9, minutes: 0, seconds: 0, milliseconds: 0 });

  while (isWeekend(day) === true || isHoliday(day, holidays)) {
    day = addDays(day, 1);
  }

  return day;
}

/**
 * Calculate end date based on start date and number of chargeable days.
 * Chargeable days exclude weekends and holidays.
 */
export function getEndDateByChargePeriod(
  startDate: Date,
  chargePeriod: number,
  holidays: string[],
): Date {
  if (!isValid(startDate)) {
    throw new Error("startDate not a valid date object");
  }
  if (chargePeriod < 1) {
    throw new Error("charge period must be a whole number");
  }
  if (!Array.isArray(holidays)) {
    throw new Error("holidays must be an array");
  }

  let endDate = startDate;
  let chargeableDays = 0;

  while (chargeableDays < chargePeriod) {
    if (!isWeekend(endDate) && !isHoliday(endDate, holidays)) {
      chargeableDays++;
    }
    if (chargeableDays < chargePeriod) {
      endDate = addDays(endDate, 1);
    }
  }

  return endDate;
}

/** Result of a business-day count between two dates. */
export interface BusinessDaysResult {
  calendarDays: number;
  calendarWeeks: number;
  days: number;
  weeks: number;
  label: ChargeDaysLabel;
  periodLabel: string;
}

/**
 * The calendar-day gap at which a window stops being walkable.
 *
 * {@link countCfsBusinessDays} walks FORWARD from `start` toward
 * `addDays(end, 1)`, so the walk reaches its terminator only while
 * `end + 1 day >= start`. One shared constant, because the same boundary is
 * asked two ways — on `Date`s inside the walk, and on ISO strings by
 * {@link isNonTerminatingWindow} for callers holding stored values.
 */
const NON_TERMINATING_DAY_GAP = -2;

/**
 * Would {@link countCfsBusinessDays} fail to terminate on this window?
 *
 * 🔴 **The boundary is `end + 1 day < start`, NOT `end < start`.** The walk
 * tests `isSameDay(addDays(end, 1), …)`, so an end exactly ONE calendar day
 * before its start makes the terminator equal the first value tested: the body
 * never runs and the window measures a legitimate zero days. Only an end two or
 * more calendar days behind is unreachable.
 *
 * That distinction is not cosmetic — a guard written as `end < start` refuses
 * windows the corpus already stores and every consumer already renders.
 *
 * Both arguments are ISO datetime strings, parsed in Chicago, and only their
 * calendar days are compared. Use this at a boundary that holds stored values —
 * an API handler deciding whether to 400, a client deciding whether to render —
 * so no caller restates the rule.
 */
export function isNonTerminatingWindow(start: string, end: string): boolean {
  return chicagoDaysBetween(end, start) <= NON_TERMINATING_DAY_GAP;
}

/**
 * Count CFS business days between two dates (excludes weekends and CFS holidays).
 *
 * @throws if `end` is two or more calendar days before `start`. The walk moves
 * forward only, so such a window has no reachable terminator and the loop would
 * spin forever — a hung request server-side and a frozen tab in a browser.
 * Refusing is deliberate: returning a zero-day result instead would be
 * indistinguishable from a weekend-only rental, which is an ordinary booking.
 * See {@link isNonTerminatingWindow} to ask before calling.
 */
export function countCfsBusinessDays(
  start: Date,
  end: Date,
  holidays: string[],
): BusinessDaysResult {
  if (!start || !isValid(start) || !end || !isValid(end)) {
    throw new Error("start and end must be valid date objects");
  }
  if (!Array.isArray(holidays)) {
    throw new Error("holidays must be an array");
  }
  if (differenceInCalendarDays(end, start) <= NON_TERMINATING_DAY_GAP) {
    throw new Error(
      "end must not be more than one calendar day before start — the business-day walk moves forward and would not terminate",
    );
  }

  let calendarDays = 0;
  let days = 0;
  let lastTested = start;
  const lastDay = addDays(end, 1);

  while (isSameDay(lastDay, lastTested) === false) {
    calendarDays++;
    if (
      isWeekend(lastTested) === false &&
      isHoliday(lastTested, holidays) === false
    ) {
      days++;
    }
    lastTested = addDays(lastTested, 1);
  }

  const weeks = days / 5;
  const calendarWeeks = calendarDays / 5;

  let label: ChargeDaysLabel = "days";
  let periodLabel = "0 days";
  if (days > 0) {
    ({ label, periodLabel } = formatChargeDays(days));
  }

  return { calendarDays, calendarWeeks, days, weeks, label, periodLabel };
}

/** Date strings required by {@link getDuration}. Nullable to mirror OrderDocDatesType — runtime guards throw when either boundary is null. */
export interface DurationDates {
  delivery_start: string | null;
  collection_start: string | null;
  charge_start?: string | null;
  charge_end?: string | null;
}

/** Active and chargeable duration breakdown returned by {@link getDuration}. */
export interface DurationResult {
  activeDays: number;
  activeWeeks: number;
  activeLabel: string;
  activePeriodLabel: string;
  chargeDays: number;
  chargeWeeks: number;
  chargeLabel: string;
  chargePeriodLabel: string;
}

/**
 * Calculate active and chargeable durations for an order's dates.
 */
export function getDuration(
  dates: DurationDates,
  holidays: string[],
): DurationResult {
  if (!dates || typeof dates !== "object") {
    throw new Error("dates must be a non-null object");
  }
  if (!dates.delivery_start || !dates.collection_start) {
    throw new Error(
      "dates.delivery_start and dates.collection_start are required",
    );
  }
  if (!Array.isArray(holidays)) {
    throw new Error("holidays must be an array");
  }

  const deliveryStart = parseISO(dates.delivery_start, {
    in: tz("America/Chicago"),
  });
  const collectionStart = parseISO(dates.collection_start, {
    in: tz("America/Chicago"),
  });

  if (!isValid(deliveryStart) || !isValid(collectionStart)) {
    throw new Error(
      "delivery_start or collection_start is not a valid date string",
    );
  }

  const active = countCfsBusinessDays(deliveryStart, collectionStart, holidays);

  const chargeStart = dates.charge_start
    ? dates.charge_start
    : dates.delivery_start;
  const chargeEnd = dates.charge_end
    ? dates.charge_end
    : dates.collection_start;

  let charge: BusinessDaysResult;
  if (
    chargeStart === dates.delivery_start &&
    chargeEnd === dates.collection_start
  ) {
    charge = active;
  } else {
    const parsedChargeStart = parseISO(chargeStart, {
      in: tz("America/Chicago"),
    });
    const parsedChargeEnd = parseISO(chargeEnd, { in: tz("America/Chicago") });
    charge = countCfsBusinessDays(parsedChargeStart, parsedChargeEnd, holidays);
  }

  return {
    activeDays: active.days,
    activeWeeks: active.weeks,
    activeLabel: active.label,
    activePeriodLabel: active.periodLabel,
    chargeDays: charge.days,
    chargeWeeks: charge.weeks,
    chargeLabel: charge.label,
    chargePeriodLabel: charge.periodLabel,
  };
}
