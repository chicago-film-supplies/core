/**
 * Pure date helper functions for CFS applications.
 * All functions accept holidays as a parameter to enable client-side calculations.
 *
 * ```ts
 * import { formatChargeDays, countCfsBusinessDays } from "@cfs/utilities/dates";
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
 * Published in lockstep with `@cfs/schemas` — version bumps track the
 * schemas package so consumers pin one pair of beta versions without
 * resolving dual shapes (Card.recurrence_overrides, Recurrence collection
 * rollout, etc.).
 *
 * @module
 */

import {
  addDays,
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
 * @param days - A positive number of chargeable days.
 * @param unit - Display unit: `"day"`, `"days"`, `"week"`, or `"weeks"`. When omitted, weeks are used if `days >= 5`.
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
 * Count CFS business days between two dates (excludes weekends and CFS holidays).
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
