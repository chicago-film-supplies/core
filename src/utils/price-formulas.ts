/**
 * The price-formula engine: metered time → tier counts → money.
 *
 * ```ts
 * import { meterUnits, priceFromFormula, statedUnits } from "@cfs/core/utils/price-formulas";
 * ```
 *
 * Two pure steps, so a line that STATES its count (an operator-edited
 * `chargeable_days`, an extension section, a carried line) skips the first and
 * keeps the second:
 *
 * 1. {@link meterUnits} — `(formula, windows, span, holidays)` → per-tier counts,
 *    each an EXACT rational `num / den`. Nothing rounds here: a prorated month is
 *    `13 / 31`, a five-day week over 7 business days is `7 / 5`.
 * 2. {@link priceFromFormula} — `(formula, rates, counts, quantity, discount)` →
 *    `{ subtotal_cents, subtotal_discounted_cents }`. Each tier is
 *    `rate × quantity × num ÷ den` in BigInt integer cents, rounded ONCE with
 *    `roundDivHalfAwayFromZero` (a base may be negative, core#88); a discount is
 *    scaled by the same factor, exactly as `calculateItemSubtotal` scales it
 *    (`cfs-money`: closure under the storage quantum).
 *
 * For a single-tier formula this IS `calculateItemSubtotal`: Five-day week over
 * `d` days is the tier `max(d, 5) / 5`, Fixed is `1 / 1`. The sweep in
 * `tests/price-formulas.test.ts` holds the two to 0 disagreements.
 *
 * ## Calendar arithmetic
 *
 * Every period is Chicago CALENDAR arithmetic on `YYYY-MM-DD` dates — instants
 * are reduced to their Chicago date once, at the edge, with `toChicagoYmd`, and
 * nothing below adds milliseconds (`cfs-datetime`; `addChicagoDays`'s DST note).
 * A month anchored on day 29–31 lands on the month's last day where the month is
 * shorter, computed from the ANCHOR each time, never chained (Jan 31 → Feb 28 →
 * Mar 31).
 *
 * @module
 */
import type {
  PriceFormulaRef,
  PriceFormulaRule,
  PriceFormulaSegment,
} from "../schemas/price-formula.ts";
import { priceFormulaBasis, priceFormulaRuleIssues } from "../schemas/price-formula.ts";
import { toChicagoStartOfDay, toChicagoYmd } from "./dates.ts";

// ── Calendar days as integers ────────────────────────────────────────

const DAY_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Days since 1970-01-01 for a calendar date. Pure calendar: UTC is only the arithmetic carrier. */
function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function ymdOf(day: number): { y: number; m: number; d: number } {
  const dt = new Date(day * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** The day number of `(y, m + offset)` on `wantDay`, clamped to that month's last day. */
function monthDay(
  y: number,
  m: number,
  offset: number,
  wantDay: number,
): number {
  const total = y * 12 + m + offset;
  const yy = Math.floor(total / 12);
  const mm = total - yy * 12;
  return Date.UTC(yy, mm, Math.min(wantDay, daysInMonth(yy, mm))) / DAY_MS;
}

function isWeekendDay(day: number): boolean {
  const dow = new Date(day * DAY_MS).getUTCDay();
  return dow === 0 || dow === 6;
}

/** A Chicago calendar date for an instant, or a bare date passed through. */
function toYmd(input: string): string {
  return YMD.test(input) ? input : toChicagoYmd(input);
}

// ── Rationals ────────────────────────────────────────────────────────

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

interface Rational {
  num: bigint;
  den: bigint;
}

function reduce(r: Rational): Rational {
  if (r.num === 0n) return { num: 0n, den: 1n };
  const g = gcd(r.num, r.den);
  return { num: r.num / g, den: r.den / g };
}

function addRational(a: Rational, b: Rational): Rational {
  return reduce({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });
}

// ── Public types ─────────────────────────────────────────────────────

/** A window or span the meter reads. Instants (any offset) or bare `YYYY-MM-DD`. */
export interface MeterRange {
  start: string;
  /** Required: an open window is closed by the caller at its as-of instant. */
  end: string;
}

/**
 * One tier's metered count, an exact rational. `den > 0`, reduced. A count may
 * be zero, and a STATED count (an extension section's added days) may be
 * negative.
 */
export interface TierCount {
  rate_key: string;
  num: number;
  den: number;
}

/** {@link meterUnits}' answer. */
export interface MeteredUnits {
  /** One entry per segment, in segment order: the line's counts. */
  tiers: TierCount[];
  /** The same, per metered window (one entry for a span or a `none` meter). */
  windows: TierCount[][];
}

/** {@link meterUnits}' inputs. */
export interface MeterInput {
  /** The line's charge windows, ascending, non-overlapping. */
  windows: readonly MeterRange[];
  /** The line's whole span — read only by `span_less_gaps`. */
  span?: MeterRange | null;
  /** CFS holidays, `YYYY-MM-DD` or instants — read only by `business_day`. */
  holidays: readonly string[];
  /**
   * The line's rate snapshot (`price.rates`) — read only by a `cap` segment,
   * whose decision compares money (Q14). Required for a capped formula.
   */
  rates?: readonly MeterRate[] | null;
}

/** One rate a `cap` decision reads: `price.rates`' shape. */
export interface MeterRate {
  rate_key: string;
  amount_cents: number;
}

// ── The meter ────────────────────────────────────────────────────────

/** @throws when a formula rule is malformed — the engine never guesses at one. */
function assertRule(formula: PriceFormulaRule): void {
  const issues = priceFormulaRuleIssues(formula);
  if (issues.length > 0) {
    throw new Error(
      `Malformed price formula: ${
        issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      }`,
    );
  }
}

/** The metered dates of one window, as sorted day numbers. */
function windowDays(
  range: MeterRange,
  count: PriceFormulaRule["meter"]["count"],
  holidays: ReadonlySet<number>,
): number[] {
  const s = dayNumber(toYmd(range.start));
  const e = dayNumber(toYmd(range.end));
  const out: number[] = [];
  if (count === "calendar_day") {
    // Nights: from the start date up to, not including, the end date.
    for (let d = s; d < e; d++) out.push(d);
    return out;
  }
  // Business dates inclusive of both ends — `countCfsBusinessDays`' walk, which
  // refuses an end two or more days before the start; so does this.
  if (e - s <= -2) {
    throw new Error(
      "A business-day window ends more than one day before it starts",
    );
  }
  for (let d = s; d <= e; d++) {
    if (!isWeekendDay(d) && !holidays.has(d)) out.push(d);
  }
  return out;
}

/**
 * The span's metered dates: every night of the span, less the gap nights the
 * allowance forgives. A gap night is free while fewer than `free_days` gap
 * nights were free in the `per_months` months up to and including it.
 */
function spanLessGapsDays(
  span: MeterRange,
  windows: readonly MeterRange[],
  allowance: PriceFormulaRule["meter"]["gap_allowance"],
): number[] {
  const covered = new Set<number>();
  for (const w of windows) {
    for (const d of windowDays(w, "calendar_day", new Set())) {
      covered.add(d);
    }
  }
  const all = windowDays(span, "calendar_day", new Set());
  if (allowance === null) return all.filter((d) => covered.has(d));
  const free: number[] = [];
  const metered: number[] = [];
  for (const d of all) {
    if (covered.has(d)) {
      metered.push(d);
      continue;
    }
    const { y, m, d: dd } = ymdOf(d);
    const since = monthDay(y, m, -allowance.per_months, dd); // exclusive lower edge
    const used = free.filter((f) => f > since).length;
    if (used < allowance.free_days) free.push(d);
    else metered.push(d);
  }
  return metered;
}

/** The first period start of a `month` segment for dates beginning at `first`, anchored per the segment. */
function monthOrigin(
  seg: PriceFormulaSegment,
  windowStart: number,
  first: number,
): { y: number; m: number; want: number; k: number } {
  if (seg.anchor === "window_start" || seg.anchor === null) {
    const { y, m, d } = ymdOf(windowStart);
    return { y, m, want: d, k: 0 };
  }
  const want = seg.anchor.day_of_month;
  const { y, m } = ymdOf(first);
  // The latest anchor date on or before `first`.
  const k = monthDay(y, m, 0, want) <= first ? 0 : -1;
  return { y, m, want, k };
}

/**
 * **The periods a formula's LARGEST segment cuts a line's time into**, as
 * Chicago calendar dates `[start, end)` — the unit activity report's billed
 * periods (purchases-as-documents Q9: a Vision month block, a Verizon month,
 * cut whether or not the unit was on). Only periods that overlap `range` AND
 * some metered time (a window, or the span for `span_less_gaps`) are returned,
 * ascending and distinct.
 *
 * - a `month` segment walks calendar months from its anchor — the window's
 *   start (`window_start`, restarting at every window, Q1) or a fixed day of
 *   the month — with the meter's month-end rule (a start on the 31st anchors on
 *   each month's last day);
 * - a `week` segment walks 7-day periods from each window's start;
 * - a `day` segment is each Chicago date;
 * - a `none` (flat) formula cuts no periods.
 *
 * `range.end` is exclusive at the INSTANT, not the date: an end mid-day (the
 * report's `as_of`, now) keeps that day's periods, so a unit switched on today
 * is reported today rather than tomorrow. Only a date, or a Chicago midnight,
 * excludes its day.
 *
 * It decides no money: price a period by metering the windows clipped to it.
 */
export function formulaPeriods(
  formula: PriceFormulaRule,
  input: { windows: readonly MeterRange[]; span?: MeterRange | null },
  range: MeterRange,
): { start: string; end: string }[] {
  assertRule(formula);
  const seg = formula.segments[0];
  if (formula.meter.source === "none" || seg.unit === "none") return [];
  const sources = formula.meter.source === "span_less_gaps" && input.span ? [input.span] : input.windows;
  const lo = dayNumber(toYmd(range.start));
  const endsAtMidnight = YMD.test(range.end) || Date.parse(toChicagoStartOfDay(range.end)) === Date.parse(range.end);
  const hi = dayNumber(toYmd(range.end)) + (endsAtMidnight ? 0 : 1);
  const seen = new Map<number, number>();
  for (const src of sources) {
    const s = dayNumber(toYmd(src.start));
    const e = Math.max(dayNumber(toYmd(src.end)), s + 1);
    const push = (ps: number, pe: number) => {
      if (pe > lo && ps < hi && pe > s && ps < e && !seen.has(ps)) seen.set(ps, pe);
    };
    if (seg.unit === "month") {
      const o = monthOrigin(seg, s, s);
      for (let k = o.k; ; k++) {
        const ps = monthDay(o.y, o.m, k, o.want);
        if (ps >= e || ps >= hi) break;
        push(ps, monthDay(o.y, o.m, k + 1, o.want));
      }
    } else {
      const step = seg.unit === "week" ? 7 : 1;
      for (let ps = s; ps < e && ps < hi; ps += step) push(ps, ps + step);
    }
  }
  const ymd = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([ps, pe]) => ({ start: ymd(ps), end: ymd(pe) }));
}

/**
 * Run the ladder over ONE window's metered dates. `extra` is the minimum's
 * top-up, in counted days, which only the last (count) segment can absorb.
 */
/** A count segment's period count for `counted` days, by its own rounding. */
function countPeriods(seg: PriceFormulaSegment, counted: bigint): Rational {
  const P = BigInt(
    typeof seg.divisor === "number" ? seg.divisor : seg.unit === "week" ? 7 : 1,
  );
  if (seg.rounding === "prorate") return reduce({ num: counted, den: P });
  if (seg.rounding === "ceil") return { num: (counted + P - 1n) / P, den: 1n };
  return { num: counted / P, den: 1n };
}

/** The cents a `cap` decision compares: the period's own rate and the next segment's. */
interface CapRates {
  period: bigint;
  next: bigint;
}

function capRatesFor(
  formula: PriceFormulaRule,
  rates: readonly MeterRate[] | null | undefined,
): (CapRates | null)[] {
  return formula.segments.map((seg, i) => {
    if (seg.consume !== "cap") return null;
    const next = formula.segments[i + 1];
    const find = (key: string) => {
      const r = rates?.find((x) => x.rate_key === key);
      if (!r) {
        throw new Error(
          `A capped formula meters with the line's rates, and none names "${key}"`,
        );
      }
      return BigInt(r.amount_cents);
    };
    return { period: find(seg.rate_key), next: find(next.rate_key) };
  });
}

function runLadder(
  formula: PriceFormulaRule,
  days: readonly number[],
  windowStart: number,
  extra: number,
  caps: readonly (CapRates | null)[] = [],
): Rational[] {
  const out: Rational[] = [];
  let remaining = new Set(days);
  let carried = extra; // counted days with no calendar position
  for (const [si, seg] of formula.segments.entries()) {
    if (seg.unit === "none") {
      out.push({ num: 1n, den: 1n });
      continue;
    }
    if (seg.unit === "month") {
      const sorted = [...remaining].sort((a, b) => a - b);
      if (sorted.length === 0) {
        out.push({ num: 0n, den: 1n });
        continue;
      }
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const o = monthOrigin(seg, windowStart, first);
      let total: Rational = { num: 0n, den: 1n };
      const next = new Set(remaining);
      for (let k = o.k;; k++) {
        const ps = monthDay(o.y, o.m, k, o.want);
        const pe = monthDay(o.y, o.m, k + 1, o.want);
        if (ps > last) break;
        if (pe <= first) continue;
        const length = pe - ps;
        let c = 0;
        for (let d = ps; d < pe; d++) if (remaining.has(d)) c++;
        if (c === 0) continue;
        if (seg.consume === "cap") {
          // Q14: one block when the period's days would cost at least the
          // block on the next segment — the cap is the period's PRICE.
          const cap = caps[si]!;
          const fallback = countPeriods(formula.segments[si + 1], BigInt(c));
          if (fallback.num * cap.next >= cap.period * fallback.den) {
            total = addRational(total, { num: 1n, den: 1n });
            for (let d = ps; d < pe; d++) next.delete(d);
          }
          continue;
        }
        if (seg.consume === "whole") {
          if (c === length) {
            total = addRational(total, { num: 1n, den: 1n });
            for (let d = ps; d < pe; d++) next.delete(d);
          }
          continue;
        }
        if (seg.rounding === "prorate") {
          total = addRational(total, { num: BigInt(c), den: BigInt(length) });
        } else if (seg.rounding === "ceil") {
          total = addRational(total, { num: 1n, den: 1n });
        } else if (c === length) {
          total = addRational(total, { num: 1n, den: 1n });
        }
      }
      out.push(total);
      remaining = seg.consume === "remainder" ? new Set() : next;
      continue;
    }
    // A count segment: week or day.
    const counted = remaining.size + carried;
    const C = BigInt(counted);
    if (seg.consume === "whole") {
      const P = BigInt(
        typeof seg.divisor === "number" ? seg.divisor : seg.unit === "week" ? 7 : 1,
      );
      const k = C / P;
      out.push({ num: k, den: 1n });
      remaining = new Set();
      carried = Number(C - k * P);
      continue;
    }
    out.push(countPeriods(seg, C));
    remaining = new Set();
    carried = 0;
  }
  return out;
}

function minimumDays(formula: PriceFormulaRule): number {
  const m = formula.minimum;
  if (m === null) return 0;
  return m.unit === "week" ? m.units * 7 : m.units;
}

function toTiers(
  formula: PriceFormulaRule,
  rs: readonly Rational[],
): TierCount[] {
  return formula.segments.map((s, i) => {
    const r = reduce(rs[i] ?? { num: 0n, den: 1n });
    return { rate_key: s.rate_key, num: Number(r.num), den: Number(r.den) };
  });
}

/**
 * **Metered time → per-tier counts.** Pure; throws on a malformed rule.
 *
 * - `windows`: each window is metered on its own — a `window_start` anchor
 *   restarts at each one (Q1, Q5), and a `window`-scoped minimum floors each.
 * - `span_less_gaps`: the span, less forgiven gaps, metered as ONE window
 *   anchored at the span's start. Needs `input.span`.
 * - `none`: one flat tier `1 / 1`.
 *
 * A `line`-scoped minimum tops up the line's total on its last window. A line
 * with no windows meters nothing — no minimum invents a window.
 *
 * A `cap` segment decides each period on money, so a capped formula needs
 * `input.rates` (the line's snapshot) and throws without them. The counts stay
 * counts: {@link priceFromFormula} is unchanged, and a delta of two meterings
 * (an extension, a bill line) may carry `+1` month and `−3` weeks.
 */
export function meterUnits(
  formula: PriceFormulaRule,
  input: MeterInput,
): MeteredUnits {
  assertRule(formula);
  const caps = capRatesFor(formula, input.rates);
  const holidays = new Set(input.holidays.map((h) => dayNumber(toYmd(h))));
  let perWindow: { days: number[]; start: number }[];
  if (formula.meter.source === "none") {
    const r = runLadder(formula, [], 0, 0);
    const tiers = toTiers(formula, r);
    return { tiers, windows: [tiers] };
  }
  if (formula.meter.source === "span_less_gaps") {
    if (!input.span) {
      throw new Error("A span_less_gaps formula needs the line's span");
    }
    perWindow = [{
      days: spanLessGapsDays(
        input.span,
        input.windows,
        formula.meter.gap_allowance,
      ),
      start: dayNumber(toYmd(input.span.start)),
    }];
  } else {
    perWindow = input.windows.map((w) => ({
      days: windowDays(w, formula.meter.count, holidays),
      start: dayNumber(toYmd(w.start)),
    }));
  }

  const min = minimumDays(formula);
  const extras = perWindow.map(() => 0);
  if (min > 0 && perWindow.length > 0) {
    if (formula.minimum!.scope === "window") {
      perWindow.forEach((w, i) => extras[i] = Math.max(0, min - w.days.length));
    } else {
      const total = perWindow.reduce((n, w) => n + w.days.length, 0);
      extras[extras.length - 1] = Math.max(0, min - total);
    }
  }

  const windows = perWindow.map((w, i) =>
    runLadder(formula, w.days, w.start, extras[i], caps)
  );
  const sums = formula.segments.map((_, t) =>
    windows.reduce<Rational>((acc, w) => addRational(acc, w[t]), {
      num: 0n,
      den: 1n,
    })
  );
  return {
    tiers: toTiers(formula, sums),
    windows: windows.map((w) => toTiers(formula, w)),
  };
}

/**
 * **A STATED count → tier counts**, for a line whose count wins over the meter:
 * an operator-edited `chargeable_days`, an extension section's added days, a
 * carried line. Only a single-segment count formula (`week`/`day`) or a flat
 * one can take a stated count — a ladder has no single number to state.
 *
 * `minimum: false` skips the floor (an extension section: its minimum was
 * charged on the invoice being extended), and the count may then be zero or
 * negative.
 */
export function statedUnits(
  formula: PriceFormulaRule,
  count: number,
  opts: { minimum: boolean },
): TierCount[] {
  assertRule(formula);
  if (!Number.isInteger(count)) {
    throw new Error(`A stated count is whole days, got ${count}`);
  }
  const [seg, ...rest] = formula.segments;
  if (rest.length > 0 || seg.unit === "month") {
    throw new Error(
      "Only a single week/day segment or a flat formula takes a stated count",
    );
  }
  if (seg.unit === "none") return [{ rate_key: seg.rate_key, num: 1, den: 1 }];
  const counted = opts.minimum ? Math.max(count, minimumDays(formula)) : count;
  const r = runLadder(formula, [], 0, counted);
  return toTiers(formula, r);
}

function gcdN(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

/**
 * **Tier-wise `a + sign × b`** over the union of rate keys, each tier reduced.
 * The arithmetic of count DELTAS: an extension is `meter(order) − meter(billed)`
 * (`@cfs/core/utils/quantityAccounting`), and a supplier bill line's counts are
 * `meter(billed ∪ new) − meter(billed)` (`@cfs/core/utils/purchase-documents`),
 * which is what keeps a window split across two bills on one anchor.
 */
export function combineTierCounts(a: readonly TierCount[], b: readonly TierCount[], sign: 1 | -1): TierCount[] {
  const keys = [...new Set([...a.map((t) => t.rate_key), ...b.map((t) => t.rate_key)])];
  return keys.map((rate_key) => {
    const x = a.find((t) => t.rate_key === rate_key) ?? { rate_key, num: 0, den: 1 };
    const y = b.find((t) => t.rate_key === rate_key) ?? { rate_key, num: 0, den: 1 };
    const num = x.num * y.den + sign * y.num * x.den;
    const den = x.den * y.den;
    const g = gcdN(num, den);
    return { rate_key, num: num / g, den: den / g };
  });
}

// ── Money ────────────────────────────────────────────────────────────

// The money step lives schema-side (`schemas/_line-money.ts`) so the stored
// line refine — rates + counts + quantity + discount reproduce the line's money
// — can call the one implementation (Phase 2 ruling 8). Re-exported here.
export { type FormulaDiscount, priceFromFormula, type RateSnapshot } from "../schemas/_line-money.ts";
import type { RateSnapshot } from "../schemas/_line-money.ts";
import type { DocLineItemTypeType } from "../schemas/common.ts";

// ── Dated rates ──────────────────────────────────────────────────────

/** The fields of a dated rate row {@link rateInForce} reads. Calendar dates in Chicago offset form. */
export interface DatedRateLike {
  rate_key: string;
  amount_cents: number;
  applied_from: string;
  /** Exclusive; `null` = open. */
  applied_to: string | null;
}

/**
 * The row of `rate_key` in force at `asOf`: `applied_from ≤ asOf < applied_to`,
 * compared as instants with `Date.parse`, never lexically (a `-05:00` and a
 * `-06:00` string do not sort as their instants do).
 */
export function rateInForce<R extends DatedRateLike>(
  rates: readonly R[],
  rateKey: string,
  asOf: string,
): R | null {
  const at = Date.parse(asOf);
  return rates.find((r) =>
    r.rate_key === rateKey && Date.parse(r.applied_from) <= at &&
    (r.applied_to === null || at < Date.parse(r.applied_to))
  ) ?? null;
}

/**
 * The snapshot a line takes at its pricing date: one {@link RateSnapshot} per
 * segment's `rate_key`, from the rows in force at `asOf`.
 *
 * @throws naming the first key with no row in force — every key a formula's
 *   segments name must have one (D4).
 */
export function snapshotRates(
  formula: PriceFormulaRule,
  rates: readonly DatedRateLike[],
  asOf: string,
): RateSnapshot[] {
  return formula.segments.map((s) => {
    const row = rateInForce(rates, s.rate_key, asOf);
    if (row === null) {
      throw new Error(`No "${s.rate_key}" rate in force at ${asOf}`);
    }
    return { rate_key: s.rate_key, amount_cents: row.amount_cents };
  });
}

// ── Formula identity and catalog snapshots ──────────────────────────

/**
 * A price formula as a pricer or a line builder reads it: the rule, plus the
 * identity a line snapshots (`price.price_formula = { uid, name, basis }`).
 */
export type PricingFormula = PriceFormulaRule & { uid: string; name: string };

/**
 * **Every formula a set of lines names, keyed by uid** — build it with
 * {@link formulaUidsOf} and a point read per uid. Retired (`active: false`)
 * formulas included: a carried or frozen line keeps the formula it priced by.
 */
export type PricingFormulas = ReadonlyMap<string, PricingFormula>;

/** The formula uids a set of lines name — what a caller must load into {@link PricingFormulas}. */
export function formulaUidsOf(
  items: readonly { price?: { price_formula?: { uid: string } | null; uid_price_formula?: string | null } | null }[],
): string[] {
  const uids = new Set<string>();
  for (const item of items) {
    const uid = item.price?.price_formula?.uid ?? item.price?.uid_price_formula;
    if (uid) uids.add(uid);
  }
  return [...uids];
}

/** The snapshot a line stores for `formula` — `{ uid, name, basis }`. */
export function priceFormulaRefOf(formula: PricingFormula): PriceFormulaRef {
  return { uid: formula.uid, name: formula.name, basis: priceFormulaBasis(formula) };
}

/** A catalog rate row as a line builder reads it — a stored `DatedRate`, or a search hit's open row (no dates). */
export interface CatalogRateLike {
  rate_key: string;
  amount_cents: number;
  applied_from?: string | null;
  applied_to?: string | null;
}

/**
 * **The rates a new line snapshots off its catalog source** (D4, Q13): per
 * `rate_key`, the row in force at `asOf` — the line's pricing date — when the
 * source carries dates and `asOf` is known; otherwise the key's OPEN row (a
 * Typesense hit indexes only open rows), else its last row.
 *
 * ⚠️ A server writer passes the real pricing date; a client building an
 * optimistic line from a search hit gets the open rows, and the server
 * resolves the in-force rows when it builds the line.
 */
export function catalogRateSnapshot(
  rates: readonly CatalogRateLike[],
  asOf: string | null,
): RateSnapshot[] {
  const keys = [...new Set(rates.map((r) => r.rate_key))];
  return keys.map((key) => {
    const rows = rates.filter((r) => r.rate_key === key);
    const dated = asOf !== null && rows.every((r) => r.applied_from != null)
      ? rateInForce(rows as DatedRateLike[], key, asOf)
      : null;
    const row = dated ?? rows.find((r) => r.applied_to == null) ?? rows[rows.length - 1];
    return { rate_key: key, amount_cents: row.amount_cents };
  });
}

/**
 * **The formula a new custom line, or a line retyped to `type`, starts on**
 * (`settings/pricing`, api-cloudrun purchases-as-documents D10 item 11) — or
 * `null` for none, when the operator must choose. `null` too when the settings
 * are absent, name no formula for the type, or name one the caller did not load
 * or that is retired (`active: false`): a default never fails a line.
 *
 * Feed the result to `buildCustomOrderLine` / `retypedLinePrice`; it prices
 * nothing itself, so it is not a second price author.
 */
export function defaultPriceFormulaFor<F extends PricingFormula & { active?: boolean }>(
  settings: { price_formula_defaults: { readonly [T in DocLineItemTypeType]: string | null } } | null,
  formulas: ReadonlyMap<string, F>,
  type: DocLineItemTypeType,
): F | null {
  const uid = settings?.price_formula_defaults[type] ?? null;
  if (uid === null) return null;
  const formula = formulas.get(uid);
  return formula === undefined || formula.active === false ? null : formula;
}
