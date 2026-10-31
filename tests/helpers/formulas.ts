/**
 * Price-formula fixtures for tests that price customer lines (Phase 2 ruling 8).
 *
 * Five-day week and Fixed are the two formulas every pre-ruling customer line
 * maps onto: `five_day_week` → {@link FIVE_DAY_WEEK} (rate key `week`, counts
 * `max(days, 5) / 5` per window), `fixed` → {@link FIXED} (rate key `flat`,
 * count `1 / 1`). {@link fdwPrice} and {@link fixedPrice} build the price
 * snapshot an old `{ base_cents, formula, chargeable_days }` literal stated, so
 * a test that is not about formulas keeps the money it asserted.
 */
import { getEndDateByChargePeriod } from "../../src/utils/dates.ts";
import {
  priceFormulaRefOf,
  type PricingFormula,
  type PricingFormulas,
  type RateSnapshot,
  type TierCount,
} from "../../src/utils/price-formulas.ts";
import type { PriceFormulaRef } from "../../src/schemas/price-formula.ts";
import { addDays, parseISO } from "date-fns";
import { tz } from "@date-fns/tz";

export const FIVE_DAY_WEEK: PricingFormula = {
  uid: "FiveDayWeekFormu1aAA",
  name: "Five-day week",
  meter: { source: "windows", count: "business_day", gap_allowance: null },
  segments: [{ rate_key: "week", unit: "week", anchor: null, consume: "remainder", rounding: "prorate", divisor: 5 }],
  reprice: "remainder",
  minimum: { units: 5, unit: "business_day", scope: "window" },
};

export const FIXED: PricingFormula = {
  uid: "FixedFormu1aAAAAAAAA",
  name: "Fixed",
  meter: { source: "none", count: "calendar_day", gap_allowance: null },
  segments: [{ rate_key: "flat", unit: "none", anchor: null, consume: "remainder", rounding: "ceil", divisor: null }],
  reprice: "remainder",
  minimum: null,
};

/** Both fixtures, as a pricer's formula map. */
export const FORMULAS: PricingFormulas = new Map([[FIVE_DAY_WEEK.uid, FIVE_DAY_WEEK], [FIXED.uid, FIXED]]);

export const FDW_REF: PriceFormulaRef = priceFormulaRefOf(FIVE_DAY_WEEK);
export const FIXED_REF: PriceFormulaRef = priceFormulaRefOf(FIXED);

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/** `num / den`, reduced — the form the engine stores. */
export function tier(rate_key: string, num: number, den: number): TierCount {
  const g = gcd(num, den);
  return { rate_key, num: num / g, den: den / g };
}

/** Five-day week counts for `days` billable business days — the one-week floor applied unless `stated`. */
export function fdwCounts(days: number, opts: { stated?: boolean } = {}): TierCount[] {
  return [tier("week", opts.stated ? days : Math.max(days, 5), 5)];
}

/**
 * A Five-day week line price: `baseCents` per week. `days` given → its counts
 * (`max(days, 5) / 5`); `null` → no counts yet (the pricer meters them).
 */
export function fdwPrice(
  baseCents: number,
  days: number | null = null,
): { price_formula: PriceFormulaRef; rates: RateSnapshot[]; counts: TierCount[] } {
  return {
    price_formula: FDW_REF,
    rates: [{ rate_key: "week", amount_cents: baseCents }],
    counts: days === null ? [] : fdwCounts(days),
  };
}

/** A Fixed line price: `baseCents` per unit, count `1 / 1`. */
export function fixedPrice(
  baseCents: number,
): { price_formula: PriceFormulaRef; rates: RateSnapshot[]; counts: TierCount[] } {
  return { price_formula: FIXED_REF, rates: [{ rate_key: "flat", amount_cents: baseCents }], counts: [tier("flat", 1, 1)] };
}

const CHICAGO = tz("America/Chicago");

/**
 * A charge window holding exactly `days` CFS business days (no holidays), from
 * a Monday. `0` is a weekend window.
 */
export function businessDayWindow(days: number, startYmd = "2026-01-05"): { start: string; end: string } {
  const start = parseISO(`${startYmd}T09:00:00`, { in: CHICAGO });
  if (days === 0) {
    // The Saturday–Sunday after the Monday `startYmd`.
    const sat = addDays(start, 5);
    const sun = addDays(start, 6);
    sun.setHours(15, 0, 0, 0);
    return { start: sat.toISOString(), end: sun.toISOString() };
  }
  const end = getEndDateByChargePeriod(start, days, []);
  end.setHours(15, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** A product price on a formula with one open rate — the catalog shape (D4). */
export function catalogPrice(formula: PricingFormula, amountCents: number): {
  uid_price_formula: string;
  rates: { rate_key: string; amount_cents: number }[];
} {
  return { uid_price_formula: formula.uid, rates: [{ rate_key: formula.segments[0].rate_key, amount_cents: amountCents }] };
}

/**
 * **A pre-ruling-8 price literal → the formula shape**, for test builders whose
 * call sites still speak `{ base_cents, chargeable_days, formula }`.
 *
 * - `percent_of_total` → no formula, rates or counts (`base_percent` carries it);
 * - `fixed` → {@link fixedPrice};
 * - `five_day_week` (the default) → {@link fdwPrice}: counts `max(days, 5) / 5`,
 *   or none when `chargeable_days` is null/absent.
 *
 * Any NEW key the literal states (`price_formula`, `rates`, `counts`) wins, so
 * a test that means a stated (unfloored) count says so explicitly.
 */
export function legacyPrice(price: Record<string, unknown>): Record<string, unknown> {
  const { base_cents, chargeable_days, formula, ...rest } = price as {
    base_cents?: number;
    chargeable_days?: number | null;
    formula?: string;
    [k: string]: unknown;
  };
  let shape: Record<string, unknown>;
  if (formula === "percent_of_total") shape = { price_formula: null, rates: [], counts: [] };
  else if (formula === "fixed") shape = fixedPrice(base_cents ?? 0);
  else shape = fdwPrice(base_cents ?? 0, typeof chargeable_days === "number" ? chargeable_days : null);
  const out: Record<string, unknown> = { ...shape };
  for (const [k, v] of Object.entries(rest)) out[k] = v;
  return out;
}

/**
 * Windows holding `days[i]` business days each, three weeks apart from Monday
 * `startYmd` (so a window of up to 15 days never meets the next).
 */
export function businessDayWindows(days: readonly number[], startYmd = "2026-10-05"): { start: string; end: string }[] {
  const start = parseISO(`${startYmd}T00:00:00`, { in: CHICAGO });
  return days.map((d, i) => {
    const monday = addDays(start, 21 * i);
    const ymd = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    return businessDayWindow(d, ymd);
  });
}

/** The calendar date dated catalog fixtures open on (Chicago start of day). */
export const RATES_FROM = "2026-01-01T00:00:00.000-06:00";

/**
 * A catalog price (D4): `formula`'s uid and ONE open dated row per segment key
 * at `amountCents` — what a product, a component copy or a webshop mirror
 * stores in place of `{ base_cents, formula }`.
 */
export function datedPrice(formula: PricingFormula, amountCents: number): {
  uid_price_formula: string;
  rates: { uid: string; rate_key: string; amount_cents: number; applied_from: string; applied_to: null }[];
} {
  return {
    uid_price_formula: formula.uid,
    rates: formula.segments.map((seg, i) => ({
      uid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      rate_key: seg.rate_key,
      amount_cents: amountCents,
      applied_from: RATES_FROM,
      applied_to: null,
    })),
  };
}

/**
 * Vision's "weekly while on, capped at the month" (D1, Q14): windows metered on
 * calendar nights; per month from each switch-on, a started week is $45, and a
 * unit never costs more than the month price in that month (`consume: "cap"`).
 * Its uid is the one `tests/purchases.test.ts` snapshots.
 */
export const VISION: PricingFormula = {
  uid: "VisionWeeklyFormula0",
  name: "Weekly while on",
  meter: { source: "windows", count: "calendar_day", gap_allowance: null },
  segments: [
    { rate_key: "month", unit: "month", anchor: "window_start", consume: "cap", rounding: "floor", divisor: null },
    { rate_key: "week", unit: "week", anchor: null, consume: "remainder", rounding: "ceil", divisor: null },
  ],
  reprice: "remainder",
  minimum: null,
};

/**
 * Verizon's "monthly unless suspended" (D1): the line's span less suspensions
 * beyond 30 free days per rolling 12 months, in months anchored on the 2nd,
 * prorated by the days in the period.
 */
export const VERIZON: PricingFormula = {
  uid: "VerizonMonthlyFormul",
  name: "Monthly unless suspended",
  meter: { source: "span_less_gaps", count: "calendar_day", gap_allowance: { free_days: 30, per_months: 12 } },
  segments: [{
    rate_key: "month",
    unit: "month",
    anchor: { day_of_month: 2 },
    consume: "remainder",
    rounding: "prorate",
    divisor: "days_in_period",
  }],
  reprice: "remainder",
  minimum: null,
};
