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
 * The Chicago calendar date `days` after `instant`'s, at `timeOf`'s Chicago time
 * of day, in Chicago offset form. Unlike {@link addChicagoDays} it keeps a time
 * of day, which is what a window bound needs.
 *
 * ```ts
 * chicagoDayAtTimeOf("2026-03-06T15:00:00.000-06:00", 1, "2026-03-02T09:00:00.000-06:00");
 * // "2026-03-07T09:00:00.000-06:00"
 * ```
 */
export function chicagoDayAtTimeOf(instant: string, days: number, timeOf: string): string {
  const day = addDays(parseISO(instant, { in: tz("America/Chicago") }), days);
  const t = parseISO(timeOf, { in: tz("America/Chicago") });
  return toChicagoInstant(
    set(day, { hours: t.getHours(), minutes: t.getMinutes(), seconds: t.getSeconds(), milliseconds: t.getMilliseconds() }).toISOString(),
  );
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
}

/**
 * The possession duration returned by {@link getDuration}.
 *
 * There is no charge half: a pair's charged days are its stored window counts
 * (`chargedDays`), counted once by `canonicalChargeWindows`.
 */
export interface DurationResult {
  activeDays: number;
  activeWeeks: number;
  activeLabel: string;
  activePeriodLabel: string;
}

/**
 * Calculate the possession (delivery → collection) duration for a pair's dates.
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

  return {
    activeDays: active.days,
    activeWeeks: active.weeks,
    activeLabel: active.label,
    activePeriodLabel: active.periodLabel,
  };
}

// ── Charge windows ──────────────────────────────────────────────────
//
// A destination pair charges for one or more windows (`charge_windows` on
// `OrderDocDates`). Each window stores the business days it charges, counted
// once when it is written. Every total is a sum of those stored counts, so
// nothing below the write path needs the holiday list.

/** A window as the helpers read it. `days` is present once the window is stored. */
export interface ChargeWindowLike {
  start: string;
  end: string;
  days?: number;
}

/** A stored window: its day count has been written. */
export interface CountedChargeWindow {
  start: string;
  end: string;
  days: number;
}

/**
 * The date fields the charge-window helpers read and write.
 *
 * Structural, so an `OrderDocDatesType`, a manager draft and an invoice pair's
 * dates all fit. Every key is optional here because a draft pair may not have
 * its dates yet. The legacy keys are written, never read.
 */
export interface ChargeDates {
  delivery_start?: string | null;
  delivery_end?: string | null;
  collection_start?: string | null;
  collection_end?: string | null;
  charge_windows?: readonly ChargeWindowLike[] | null;
  /** Legacy: the first window's start, kept in step until the field is removed. */
  charge_start?: string | null;
  /** Legacy: the last window's end, kept in step until the field is removed. */
  charge_end?: string | null;
  days_active?: number | null;
  /** Legacy: Σ window days, kept in step until the field is removed. */
  days_charged?: number | null;
}

/**
 * **The days a pair charges: Σ `window.days`.** Reads stored counts only.
 *
 * ```ts
 * chargedDays({ charge_windows: [{ start, end, days: 3 }, { start, end, days: 4 }] }); // 7
 * ```
 */
export function chargedDays(dates: { charge_windows: readonly { days: number }[] }): number {
  let sum = 0;
  for (const w of dates.charge_windows) sum += w.days;
  return sum;
}

/**
 * **The days a set of windows bills: Σ `max(days, 5)`.** Every window carries
 * the one-week minimum, a 0-day window included (charge-windows decision 2).
 *
 * For a single window this is today's `max(days, 5)`, so a one-window pair
 * prices exactly as before.
 *
 * ```ts
 * billableDays([3, 4, 2]); // 15 → 3.0 × base
 * billableDays([3, 0, 4]); // 15
 * billableDays([8, 7, 6]); // 21 → 4.2 × base
 * ```
 */
export function billableDays(days: readonly number[]): number {
  let sum = 0;
  for (const d of days) sum += Math.max(d, 5);
  return sum;
}

/**
 * **The span a pair's windows cover**: the first window's start and the last
 * window's end. `null` when the pair has no windows.
 *
 * It is not a window: the gaps between windows charge nothing.
 */
export function chargeEnvelope(
  dates: { charge_windows?: readonly { start: string; end: string }[] | null },
): { start: string; end: string } | null {
  const windows = dates.charge_windows;
  if (!windows || windows.length === 0) return null;
  return { start: windows[0].start, end: windows[windows.length - 1].end };
}

/**
 * A copy of a pair's windows, or `null` when it states none (a draft whose dates
 * have not been authored yet). Every stored pair has at least one window.
 */
export function chargeWindowsOf(dates: ChargeDates): ChargeWindowLike[] | null {
  if (!dates.charge_windows || dates.charge_windows.length === 0) return null;
  return dates.charge_windows.map((w) => ({ ...w }));
}

/** Business days in one window, counted in Chicago. */
function countWindowDays(start: string, end: string, holidays: readonly string[]): number {
  return countCfsBusinessDays(
    parseISO(start, { in: CHICAGO }),
    parseISO(end, { in: CHICAGO }),
    [...holidays],
  ).days;
}

/** What {@link canonicalChargeWindows} guarantees about the dates it returns. */
export interface CanonicalChargeDates {
  /** Counted, in Chicago offset form. Absent only when the pair has no charge bounds at all. */
  charge_windows?: CountedChargeWindow[];
}

/** Options for {@link canonicalChargeWindows}. */
export interface CanonicalChargeWindowsOptions {
  /**
   * The pair opens a date-extension section. Its windows keep their stored
   * `days` — the added days its writer computed — and are never recounted.
   */
  extension?: boolean;
}

/**
 * **The one writer of stored day counts.** Recounts every window's `days` and
 * the pair's `days_active` against `holidays`.
 *
 * - **Windows.** Instants are canonicalized to Chicago offset form. A pair with
 *   no windows is left without them.
 * - **Extension pairs keep their days** (`opts.extension`): the count is the
 *   days added past what was billed, not a count of the window.
 * - **The legacy fields follow the windows** — `charge_start`/`charge_end` are
 *   the envelope and `days_charged` is Σ days — until they are removed. When a
 *   legacy boundary moves, its `_fs` mirror is set to `null`, because a utility
 *   cannot mint a Firestore Timestamp. The writer must stamp it.
 *
 * Pure: returns a copy.
 *
 * @throws Error when a window or the possession span cannot be counted
 *   ({@link isNonTerminatingWindow}), when an extension window states no days,
 *   or when `holidays` is not an array.
 */
export function canonicalChargeWindows<D extends ChargeDates>(
  dates: D,
  holidays: readonly string[],
  opts: CanonicalChargeWindowsOptions = {},
): D & CanonicalChargeDates {
  if (!Array.isArray(holidays)) {
    throw new Error("holidays must be an array");
  }
  const out = { ...dates } as D & CanonicalChargeDates & Record<string, unknown>;

  const windows = chargeWindowsOf(dates);
  if (windows !== null) {
    const counted: CountedChargeWindow[] = windows.map((w, i) => {
      const start = toChicagoInstant(w.start);
      const end = toChicagoInstant(w.end);
      if (opts.extension) {
        if (typeof w.days !== "number") {
          throw new Error(`Extension charge window ${i + 1} states no days`);
        }
        return { start, end, days: w.days };
      }
      if (isNonTerminatingWindow(start, end)) {
        throw new Error(`Charge window ${i + 1} ends more than one day before it starts`);
      }
      return { start, end, days: countWindowDays(start, end, holidays) };
    });
    out.charge_windows = counted;
    const envelope = chargeEnvelope({ charge_windows: counted })!;
    setLegacyBound(out, "charge_start", envelope.start);
    setLegacyBound(out, "charge_end", envelope.end);
    out.days_charged = chargedDays({ charge_windows: counted });
  }

  if (dates.delivery_start && dates.collection_start) {
    if (isNonTerminatingWindow(dates.delivery_start, dates.collection_start)) {
      throw new Error("collection_start is more than one day before delivery_start");
    }
    out.days_active = countWindowDays(dates.delivery_start, dates.collection_start, holidays);
  } else if ("days_active" in dates) {
    out.days_active = null;
  }
  return out;
}

/** Write a legacy boundary, clearing its `_fs` mirror when the instant moved. */
function setLegacyBound(out: Record<string, unknown>, key: "charge_start" | "charge_end", value: string): void {
  const previous = out[key];
  const moved = typeof previous !== "string" || toChicagoInstant(previous) !== value;
  out[key] = value;
  if (moved && `${key}_fs` in out) out[`${key}_fs`] = null;
}

// ── applyDateEdit ───────────────────────────────────────────────────

/** An edit to one pair's dates. See {@link applyDateEdit}. */
export type DateEdit =
  | { type: "set_possession"; delivery_start?: string | null; collection_start?: string | null }
  | { type: "set_possession_days"; days: number }
  | { type: "set_window"; index: number; start?: string; end?: string }
  | { type: "set_window_days"; index: number; days: number }
  | { type: "add_window"; start: string; end: string }
  | { type: "remove_window"; index: number }
  | { type: "reset_windows" }
  | { type: "copy_from"; dates: ChargeDates }
  | { type: "default_dates"; now: Date | string };

/** Why {@link applyDateEdit} refused an edit. */
export type DateEditError =
  | "holidays_unloaded"
  | "non_terminating"
  | "overlap"
  | "adjacent"
  | "missing_dates"
  | "invalid_days"
  | "no_such_window"
  | "last_window"
  | "extension_window"
  | "invalid_instant";

/** Context for {@link applyDateEdit}. */
export interface DateEditContext {
  /**
   * Chicago holiday dates. `null` means the list has not loaded, and every edit
   * is refused with `holidays_unloaded` rather than counting holidays as
   * business days.
   */
  holidays: readonly string[] | null;
  /**
   * The dates the follow rules compare against. Defaults to `dates` itself. The
   * API passes the STORED pair, so an input that moved possession and left its
   * windows as stored follows exactly as the manager's edit would have.
   */
  prev?: ChargeDates;
  /** The pair opens a date-extension section: its windows cannot be edited. */
  extension?: boolean;
}

/** What {@link applyDateEdit} returns. */
export type DateEditResult<D> = { dates: D & CanonicalChargeDates } | { error: DateEditError };

/** Same instant, whatever offset each string is written in. */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return Date.parse(a) === Date.parse(b);
}

/** The Chicago calendar date of `day`, at the Chicago time of day of `timeOf`. */
function atTimeOf(day: Date, timeOf: string): string {
  const t = parseISO(timeOf, { in: CHICAGO });
  return set(day, {
    hours: t.getHours(),
    minutes: t.getMinutes(),
    seconds: t.getSeconds(),
    milliseconds: t.getMilliseconds(),
  }, { in: CHICAGO }).toISOString();
}

/** The end `days` business days on from `start`, keeping `endTimeOf`'s time of day. */
function endAfterBusinessDays(start: string, days: number, endTimeOf: string, holidays: readonly string[]): string {
  const endDay = getEndDateByChargePeriod(parseISO(start, { in: CHICAGO }), days, [...holidays]);
  return atTimeOf(endDay, endTimeOf);
}

/** Is there no business day strictly between `earlierEnd` and `laterStart`? */
function windowsAdjacent(earlierEnd: string, laterStart: string, holidays: readonly string[]): boolean {
  const from = addDays(startOfDay(parseISO(earlierEnd, { in: CHICAGO })), 1);
  const to = addDays(startOfDay(parseISO(laterStart, { in: CHICAGO })), -1);
  if (differenceInCalendarDays(to, from) < 0) return true;
  return countCfsBusinessDays(from, to, [...holidays]).days === 0;
}

/** Order, overlap, adjacency and walkability — the checks a stored pair must pass. */
function checkWindows(
  windows: readonly ChargeWindowLike[],
  holidays: readonly string[],
): DateEditError | null {
  for (const w of windows) {
    if (isNonTerminatingWindow(w.start, w.end)) return "non_terminating";
  }
  for (let i = 1; i < windows.length; i++) {
    if (toChicagoYmd(windows[i].start) <= toChicagoYmd(windows[i - 1].end)) return "overlap";
    if (windowsAdjacent(windows[i - 1].end, windows[i].start, holidays)) return "adjacent";
  }
  return null;
}

/**
 * **Apply one date edit to a pair and recount it.** The one home of the date
 * rules, shared by the manager's date editor and the API.
 *
 * Instants are parsed in Chicago and returned in Chicago offset form, and every
 * successful edit ends in {@link canonicalChargeWindows}.
 *
 * The follow rules (both compare instants, not strings, against `ctx.prev`):
 * - **An `*_end` follows its `*_start`** while it equals the previous start.
 * - **The window follows possession** when the pair has exactly one window
 *   whose bounds equal the previous delivery and collection starts.
 *
 * The edits:
 * - `set_possession` — move delivery and/or collection start.
 * - `set_possession_days` — collection start moves to `days` business days from
 *   delivery start, keeping its own time of day.
 * - `set_window` / `set_window_days` — one window's bounds, or its end by day
 *   count keeping the end's time of day. Refused on an extension pair.
 * - `add_window` (inserted in order), `remove_window` (at least one stays),
 *   `reset_windows` (one window over possession).
 * - `copy_from` — a new pair takes a previous pair's dates.
 * - `default_dates` — delivery at 09:00 on the next business day (tomorrow once
 *   the Chicago hour is past 8), collection 5 business days on at 15:00, one
 *   window over both.
 *
 * Never throws for a bad edit: it returns `{ error }`.
 */
export function applyDateEdit<D extends ChargeDates>(
  dates: D,
  edit: DateEdit,
  ctx: DateEditContext,
): DateEditResult<D> {
  const holidays = ctx.holidays;
  if (!Array.isArray(holidays)) return { error: "holidays_unloaded" };
  const prev = ctx.prev ?? dates;
  const next = { ...dates } as D & Record<string, unknown>;
  let windows = chargeWindowsOf(dates);

  const editsWindows = edit.type === "set_window" || edit.type === "set_window_days" ||
    edit.type === "add_window" || edit.type === "remove_window" || edit.type === "reset_windows";
  if (ctx.extension && editsWindows) return { error: "extension_window" };

  /** Move possession, then apply both follow rules against `prev`. */
  const moveP = (delivery: string | null | undefined, collection: string | null | undefined): void => {
    const followsPossession = windows !== null && windows.length === 1 &&
      sameInstant(windows[0].start, prev.delivery_start) && sameInstant(windows[0].end, prev.collection_start);
    if (delivery !== undefined) {
      const value = delivery === null ? null : toChicagoInstant(delivery);
      if (sameInstant(dates.delivery_end, prev.delivery_start)) next.delivery_end = value;
      next.delivery_start = value;
    }
    if (collection !== undefined) {
      const value = collection === null ? null : toChicagoInstant(collection);
      if (sameInstant(dates.collection_end, prev.collection_start)) next.collection_end = value;
      next.collection_start = value;
    }
    if (followsPossession && next.delivery_start && next.collection_start) {
      windows = [{ start: next.delivery_start, end: next.collection_start }];
    }
  };

  try {
    switch (edit.type) {
      case "set_possession":
        moveP(edit.delivery_start, edit.collection_start);
        break;
      case "set_possession_days": {
        if (!Number.isInteger(edit.days) || edit.days < 1) return { error: "invalid_days" };
        if (!dates.delivery_start || !dates.collection_start) return { error: "missing_dates" };
        moveP(undefined, endAfterBusinessDays(dates.delivery_start, edit.days, dates.collection_start, holidays));
        break;
      }
      case "set_window": {
        if (!windows || !windows[edit.index]) return { error: "no_such_window" };
        const w = windows[edit.index];
        windows[edit.index] = {
          start: edit.start !== undefined ? toChicagoInstant(edit.start) : w.start,
          end: edit.end !== undefined ? toChicagoInstant(edit.end) : w.end,
        };
        break;
      }
      case "set_window_days": {
        if (!Number.isInteger(edit.days) || edit.days < 1) return { error: "invalid_days" };
        if (!windows || !windows[edit.index]) return { error: "no_such_window" };
        const w = windows[edit.index];
        windows[edit.index] = { start: w.start, end: endAfterBusinessDays(w.start, edit.days, w.end, holidays) };
        break;
      }
      case "add_window": {
        const added = { start: toChicagoInstant(edit.start), end: toChicagoInstant(edit.end) };
        windows = [...(windows ?? []), added].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        break;
      }
      case "remove_window": {
        if (!windows || !windows[edit.index]) return { error: "no_such_window" };
        if (windows.length === 1) return { error: "last_window" };
        windows = windows.filter((_, i) => i !== edit.index);
        break;
      }
      case "reset_windows": {
        if (!dates.delivery_start || !dates.collection_start) return { error: "missing_dates" };
        windows = [{ start: dates.delivery_start, end: dates.collection_start }];
        break;
      }
      case "copy_from": {
        const source = edit.dates;
        for (const key of ["delivery_start", "delivery_end", "collection_start", "collection_end"] as const) {
          next[key] = source[key] ? toChicagoInstant(source[key]!) : null;
        }
        windows = chargeWindowsOf(source);
        break;
      }
      case "default_dates": {
        const now = typeof edit.now === "string" ? parseISO(edit.now, { in: CHICAGO }) : new TZDate(edit.now, "America/Chicago");
        let day: Date = now;
        if (getHours(day) > 8) day = addDays(day, 1);
        day = set(day, { hours: 9, minutes: 0, seconds: 0, milliseconds: 0 }, { in: CHICAGO });
        while (isWeekend(day) || isHoliday(day, [...holidays])) day = addDays(day, 1);
        const start = day.toISOString();
        const endDay = getEndDateByChargePeriod(day, 5, [...holidays]);
        const end = set(endDay, { hours: 15, minutes: 0, seconds: 0, milliseconds: 0 }, { in: CHICAGO }).toISOString();
        next.delivery_start = start;
        next.delivery_end = start;
        next.collection_start = end;
        next.collection_end = end;
        windows = [{ start, end }];
        break;
      }
    }

    if (next.delivery_start && next.collection_start && isNonTerminatingWindow(next.delivery_start, next.collection_start)) {
      return { error: "non_terminating" };
    }
    if (windows !== null) {
      const problem = checkWindows(windows, holidays);
      if (problem) return { error: problem };
      next.charge_windows = windows;
    }
    return { dates: canonicalChargeWindows(next as D, holidays, { extension: ctx.extension }) };
  } catch {
    // Every refusable edit is checked above, so a throw here is an instant
    // that does not parse.
    return { error: "invalid_instant" };
  }
}
