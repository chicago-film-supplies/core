/**
 * The cost model, applied: a product's effective cost rules, and how an
 * activation entry cuts a unit's service-line spans into billed periods.
 *
 * ```ts
 * import { billablePeriods, effectiveCogs, remainingUsageToBill } from "@cfs/core/utils/cogs";
 * ```
 *
 * One home for both halves of `api-cloudrun/.claude/plans/serialized-subrent.md`
 * § 7a, so the unit activity report, the usage-bill pre-fill and the manager's
 * "already billed through" hint all read the same periods. Pure and
 * platform-free.
 *
 * ## Periods, and why any active day bills the whole one
 *
 * A provider bills a line per PERIOD, not per day: a Vision week costs the same
 * whether the hotspot was on for one day of it or seven (owner, 2026-10-27,
 * Q11). So a period is billable iff any activation span under the entry
 * overlaps it, and the expected cost is `periods × rate_cents` — an integer
 * times an integer, closed money with no rounding decision (`cfs-money`).
 *
 * ⚠️ Switching a line off mid-period therefore saves nothing for that period,
 * which is what the manager's "already billed through" hint exists to say.
 *
 * @module
 */
import { addMonths, parseISO, startOfMonth } from "date-fns";
import { tz } from "@date-fns/tz";
import type {
  CogsActivationEntryType,
  CogsEntryType,
  Product,
  UnitActivationType,
} from "../schemas/mod.ts";
import { addChicagoDays, toChicagoStartOfDay } from "./dates.ts";

// ── Effective rules ──────────────────────────────────────────────────

/**
 * The account a `sale` product relieves inventory to when it states no `sale`
 * entry: `5000` "Cost of Goods Sold: Retail Inventory".
 *
 * ⚠️ **A code constant, deliberately not catalog-derived** (as tax classes'
 * `is_default_for` is). It replaces the literal `"5000"` the Xero item body
 * sent, one for one, so every existing product's item body is byte-identical
 * and nothing re-pushes.
 */
export const DEFAULT_SALE_COA_COST = 5000;

/**
 * A product's cost rules as every reader must see them: the stored `cogs`,
 * plus the TYPE default — a `sale` product with no stored `sale` entry gets
 * `{ trigger: "sale", formula: "average_cost", coa_cost: 5000 }`.
 *
 * The default is derived rather than stored because stamping it would be a
 * write to every sale product, and each product write fans out to a Xero item
 * sync and a Typesense reindex (`Product.cogs`'s docblock).
 */
export function effectiveCogs(product: Pick<Product, "type" | "cogs">): CogsEntryType[] {
  const stored = product.cogs ?? [];
  if (product.type !== "sale" || stored.some((e) => e.trigger === "sale")) return [...stored];
  return [
    { trigger: "sale", formula: "average_cost", label: "Inventory relief", coa_cost: DEFAULT_SALE_COA_COST },
    ...stored,
  ];
}

/** The activation entry `uid_cogs` names on a product, or `undefined`. */
export function cogsActivationEntry(
  product: Pick<Product, "cogs">,
  uid_cogs: string,
): CogsActivationEntryType | undefined {
  return product.cogs?.find((e): e is CogsActivationEntryType => e.trigger === "activation" && e.uid === uid_cogs);
}

// ── Spans ────────────────────────────────────────────────────────────

/** Which instants a span's period cut used. */
export type SpanInstantSource = "provider" | "cfs";

/** A span's resolved on/off instants. */
export interface SpanInstants {
  start: string;
  /** `null` while the line is still on. */
  end: string | null;
  /**
   * `provider` when the provider confirmed the on-instant (and, if the span
   * has ended, the off-instant); otherwise `cfs`, CFS's own instants.
   */
  source: SpanInstantSource;
}

/**
 * The instants a span is billed over: the provider's confirmed ones where set,
 * otherwise CFS's own (§ 8 — the operator reconciles against the provider's
 * invoice, so the provider's word wins once it exists). A confirmed on-instant
 * with no confirmed off-instant keeps CFS's off-instant, and says `cfs`, since
 * the pair is then only half confirmed.
 */
export function spanInstants(span: Pick<UnitActivationType, "start" | "end" | "provider_confirmed">): SpanInstants {
  const c = span.provider_confirmed;
  if (c === null) return { start: span.start, end: span.end, source: "cfs" };
  if (span.end === null || c.end !== null) return { start: c.start, end: c.end ?? span.end, source: "provider" };
  return { start: c.start, end: span.end, source: "cfs" };
}

// ── Periods ──────────────────────────────────────────────────────────

/** A half-open instant range `[start, end)`; a `null` start is the beginning of time. */
export interface CogsRange {
  start: string | null;
  end: string;
}

/** One billed period. */
export interface BillablePeriod {
  /** The period's first instant, Chicago start of day. */
  start: string;
  /** The next period's first instant: the range is `[start, end)`. */
  end: string;
  /** The activation spans that touched it, by `uid`, ascending by span start. */
  activation_uids: string[];
}

/** {@link billablePeriods}' answer. */
export interface BillablePeriods {
  periods: BillablePeriod[];
  /** `periods.length × entry.rate_cents` — closed money. */
  expectedCents: number;
}

/** The span fields {@link billablePeriods} reads. */
export type BillableSpan = Pick<UnitActivationType, "uid" | "start" | "end" | "uid_cogs" | "provider_confirmed">;

function chicagoMonthStart(instant: string): string {
  return startOfMonth(parseISO(instant, { in: tz("America/Chicago") })).toISOString();
}

function nextChicagoMonth(monthStart: string): string {
  return startOfMonth(addMonths(parseISO(monthStart, { in: tz("America/Chicago") }), 1)).toISOString();
}

/**
 * The periods of ONE unit's spans under ONE activation entry that are billable
 * and overlap `range`, and their expected cost.
 *
 * - Only spans whose `uid_cogs` is `entry.uid` count; pass the unit's WHOLE
 *   activation list, since a `per_week` cycle is anchored on the unit's FIRST
 *   activation day under the entry (owner, 2026-10-28, Q11b), which can lie
 *   before `range`.
 * - `per_week`: 7 Chicago calendar days from that anchor's start of day, so a
 *   re-activation inside a week already billed continues it at no extra cost.
 *   Calendar days, never `7 × 86,400,000 ms` (`addChicagoDays`'s DST note).
 * - `per_calendar_month`: Chicago calendar months.
 * - A period is billable iff some span `[start, end)` overlaps it; a still-open
 *   span runs on to `range.end`. A zero-length span bills nothing.
 *
 * Spans' instants come from {@link spanInstants}.
 */
export function billablePeriods(
  spans: readonly BillableSpan[],
  entry: Pick<CogsActivationEntryType, "uid" | "formula" | "rate_cents">,
  range: CogsRange,
): BillablePeriods {
  const mine = spans
    .filter((s) => s.uid_cogs === entry.uid)
    .map((s) => ({ uid: s.uid, ...spanInstants(s) }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const rangeEnd = Date.parse(range.end);
  const rangeStart = range.start === null ? -Infinity : Date.parse(range.start);
  const periods: BillablePeriod[] = [];
  if (mine.length === 0) return { periods, expectedCents: 0 };

  const first = mine[0].start;
  let start = entry.formula === "per_week" ? toChicagoStartOfDay(first) : chicagoMonthStart(first);
  const next = (p: string) => entry.formula === "per_week" ? addChicagoDays(p, 7) : nextChicagoMonth(p);

  while (Date.parse(start) < rangeEnd) {
    const end = next(start);
    const ps = Date.parse(start);
    const pe = Date.parse(end);
    if (pe > rangeStart) {
      const touching = mine.filter((s) => {
        const ss = Date.parse(s.start);
        const se = s.end === null ? rangeEnd : Date.parse(s.end);
        return se > ss && ss < pe && se > ps;
      });
      if (touching.length > 0) periods.push({ start, end, activation_uids: touching.map((s) => s.uid) });
    }
    start = end;
  }
  return { periods, expectedCents: periods.length * entry.rate_cents };
}

// ── Usage billing ────────────────────────────────────────────────────

/**
 * The fields of a usage-billed purchase item {@link remainingUsageToBill} reads —
 * structural, so both a carrier's `usage` item and an activation-billed
 * `subrent` item take it (the purchase-items plan, chicago-film-supplies/api-cloudrun#1407,
 * landed 2026-10-30).
 */
export interface UsageBilledItem {
  uid_cogs: string;
  /** Periods billed so far across every bill on the item. */
  quantity_billed: number;
}

/**
 * How many billable periods of `item`'s cost entry remain unbilled through
 * `range.end`: `Σ billablePeriods(each unit's spans)` − `quantity_billed`.
 *
 * A SEPARATE function from `remainingToBill`, which six callers share over
 * stored buckets; a usage item's billable quantity is derived from spans the
 * caller has read (each unit's whole activation list, from the product's
 * roster, point-read inside the bill transaction). It is the guard that a
 * unit-period cannot be billed twice.
 *
 * ⚠️ May be NEGATIVE: an over-billed item, which the caller reports rather
 * than clamps.
 */
export function remainingUsageToBill(
  item: UsageBilledItem,
  unitSpans: ReadonlyArray<readonly BillableSpan[]>,
  entry: Pick<CogsActivationEntryType, "uid" | "formula" | "rate_cents">,
  range: CogsRange,
): number {
  if (item.uid_cogs !== entry.uid) {
    throw new Error(`usage item bills cost entry ${item.uid_cogs}, not ${entry.uid}`);
  }
  const billable = unitSpans.reduce((n, spans) => n + billablePeriods(spans, entry, range).periods.length, 0);
  return billable - item.quantity_billed;
}
