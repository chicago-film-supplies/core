/**
 * Purchase → bill: the projector, the unbilled windows, the bill pricer and the
 * purchase → bill three-way sync (purchases-as-documents D5, D7; Phase 2
 * rulings 1, 3, 4, 7, 8).
 *
 * The supplier side's twin of the order → invoice machinery, built from the
 * same parts:
 *
 * | customer side | here |
 * |---|---|
 * | `projectOrderItemToInvoiceItem` | {@link projectPurchaseLineToBillLine} |
 * | `buildRemainingInvoice`'s "what is not yet billed" | {@link unbilledUnitWindows} |
 * | `priceDocument` / `priceCreditNote` | {@link pricePurchaseDocument} — an ASSEMBLER, not a second money author |
 * | `syncOrderToInvoiceSelective` | {@link syncPurchaseToBills} |
 *
 * ## One money step
 *
 * `priceFromFormula` (`schemas/_line-money.ts`) is the only place a time line's
 * counts become cents, for customer and supplier lines alike (ruling 3). A flat
 * line states its amount: its k-th bill is priced by `cumulativeShareCents`,
 * exactly as its receipts are, so the bills of a fully billed line sum to the
 * line's `amount_cents`.
 *
 * ## Counts are DELTAS of a cumulative meter
 *
 * A time bill line's `price.counts` are the UNIT-periods it bills, summed over
 * its units. For each unit they are
 *
 * ```
 * meter(billed ∪ new) − meter(billed)
 * ```
 *
 * where `billed` is the unit's coverage on the purchase line's EARLIER live
 * bills (net of live credits) and `new` the pieces this bill adds. Metering the
 * difference rather than the new pieces alone is what keeps a window billed in
 * two halves on ONE anchor: Vision's month runs from the switch-on, so a window
 * billed at day 10 and again at day 40 must bill a month and two weeks in all,
 * not two weeks and then a fresh month and a week. The deltas telescope: the
 * counts of every bill of a window sum to the meter of the whole window.
 *
 * ⚠️ **Pieces are unioned only INSIDE one unit window**, so two unit windows
 * that touch (one ends at the instant the next starts, which the unit refine
 * allows) never merge into one and the per-window anchor restart survives. A
 * single delta may carry a negative tier (a week becomes part of a month); the
 * line's money is still the delta of two non-negative amounts.
 *
 * ## Sync never touches windows or quantities
 *
 * The merge follows `price` (formula, rates, discount terms), `name`, `type`,
 * `description`, `ledger_account`, `uid_tracking_category`, the tax class and
 * the attribution keys onto every
 * UNSETTLED, PUSHED bill, three-way against the previous purchase — the
 * classification `classifySharedFields(PurchaseSchema, PurchaseBillSchema)`
 * reads off the two schemas. `quantity`, `amount_cents` and `dates` are
 * homonyms there, and `units` is bill-only, so a purchase-side extension can
 * never rewrite what the supplier already billed. A linked bill's money is
 * Xero's and is never written; a frozen (settled) bill is skipped whole.
 *
 * @module
 */
import {
  type ChargeWindowType,
  type DiscountType,
  type Purchase,
  type PurchaseBill,
  PurchaseBillSchema,
  type PurchaseCredit,
  type PurchaseDocumentItem,
  type PurchaseDocumentLinePrice,
  type PurchaseDocumentLineUnit,
  type CogsActivationEntryType,
  type COACostType,
  type Product,
  type PurchaseItem,
  type PurchaseLinePrice,
  purchaseItemBasis,
  purchaseItemCanceled,
  PurchaseSchema,
  type UidNameRefType,
  type UnitType,
} from "../schemas/mod.ts";
import {
  catalogRateSnapshot,
  combineTierCounts,
  type MeterRate,
  meterUnits,
  priceFromFormula,
  type PricingFormula,
  type PricingFormulas,
  type TierCount,
} from "./price-formulas.ts";
import { cumulativeShareCents } from "./purchases.ts";
import { roundDivHalfUp } from "./money.ts";
import { classifySharedFields, fieldsUnder, mergeSharedFields, type SharedField } from "./shared-fields.ts";
import { purchaseBillIsFrozen, purchaseBillIsLive } from "./invoices.ts";

export { purchaseBillIsLive };

// ── Context ─────────────────────────────────────────────────────

/**
 * What metering needs: every formula the purchase's lines name (retired ones
 * included — a billed line keeps the formula it priced by) and the holiday
 * list. The customer side's `AccountingContext`.
 */
export interface PurchaseDocumentContext {
  formulas: PricingFormulas;
  holidays: readonly string[];
}

/**
 * The purchase's existing bills and credits, as the "already billed" readers
 * see them. Pass EVERY bill and credit of the purchase; liveness is decided
 * here ({@link purchaseBillIsLive}, {@link purchaseCreditIsLive}).
 */
export interface PurchaseBilledDocuments {
  bills: readonly Pick<PurchaseBill, "uid" | "number" | "totals" | "items" | "voided_at">[];
  credits: readonly Pick<PurchaseCredit, "status" | "items">[];
}

// ── Intervals ───────────────────────────────────────────────────
//
// Every endpoint stays the ORIGINAL string it came from (a unit window's, a bill
// window's, or the caller's `through`), so nothing here mints an instant and the
// Chicago offset form survives (cfs-datetime). Comparison is by `Date.parse`.

interface Interval {
  s: number;
  e: number;
  start: string;
  end: string;
}

const toInterval = (w: { start: string; end: string }): Interval => ({
  s: Date.parse(w.start),
  e: Date.parse(w.end),
  start: w.start,
  end: w.end,
});

const fromInterval = (i: Interval): ChargeWindowType => ({ start: i.start, end: i.end });

/** Ascending, non-empty, with touching or overlapping intervals merged. */
function unionIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.e > i.s).sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.s <= last.e) {
      if (i.e > last.e) out[out.length - 1] = { ...last, e: i.e, end: i.end };
    } else {
      out.push({ ...i });
    }
  }
  return out;
}

/** `a − b`, each result interval's endpoints taken from whichever side cut it. */
function subtractIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  let rest = unionIntervals(a);
  for (const cut of unionIntervals(b)) {
    const next: Interval[] = [];
    for (const i of rest) {
      if (cut.e <= i.s || cut.s >= i.e) {
        next.push(i);
        continue;
      }
      if (cut.s > i.s) next.push({ s: i.s, e: cut.s, start: i.start, end: cut.start });
      if (cut.e < i.e) next.push({ s: cut.e, e: i.e, start: cut.end, end: i.end });
    }
    rest = next;
  }
  return rest;
}

/** `a ∩ w`, clipped to one window. */
function intersectWindow(a: readonly Interval[], w: Interval): Interval[] {
  const out: Interval[] = [];
  for (const i of a) {
    const s = Math.max(i.s, w.s);
    const e = Math.min(i.e, w.e);
    if (e > s) out.push({ s, e, start: s === i.s ? i.start : w.start, end: e === i.e ? i.end : w.end });
  }
  return out;
}

/**
 * **`a − b` over charge windows** — the time `a` covers that `b` does not,
 * ascending and merged. Endpoints are the inputs' own strings.
 */
export function subtractChargeWindows(
  a: readonly ChargeWindowType[],
  b: readonly ChargeWindowType[],
): ChargeWindowType[] {
  return subtractIntervals(a.map(toInterval), b.map(toInterval)).map(fromInterval);
}

// ── Reading units and existing coverage ────────────────────────

const samePath = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((s, k) => s === b[k]);

/** Is this credit live — not voided? Every "already billed" reader asks it. */
export function purchaseCreditIsLive(credit: Pick<PurchaseCredit, "status">): boolean {
  return credit.status !== "void";
}

/** The lines of a document that project the purchase item at `path`. */
function linesFor(items: readonly PurchaseDocumentItem[], path: readonly string[]): PurchaseDocumentItem[] {
  return items.filter((l) => l.path_purchase_item !== undefined && samePath(l.path_purchase_item, path));
}

/** The coverage-bearing half of a subrent or charge line: the units it names and the span it covers. */
export interface PurchaseLineCoverage {
  uid_units: readonly string[];
  /** `null` covers all time (a charge line with no span). */
  dates: { start: string; end: string | null } | null;
}

/** A buy covers no unit's windows — it is custody, not a service line. */
function coverageOf(item: PurchaseItem): PurchaseLineCoverage | null {
  return item.type === "sale" ? null : { uid_units: item.uid_units, dates: item.dates };
}

/** `w` clipped to the line's span and to `through`, or `null` when nothing of it is left. */
function clipToLine(
  w: { start: string; end: string | null },
  dates: PurchaseLineCoverage["dates"],
  through: string,
): ChargeWindowType | null {
  let s = Date.parse(w.start);
  let start = w.start;
  let e = w.end === null ? Date.parse(through) : Math.min(Date.parse(w.end), Date.parse(through));
  let end = w.end === null || Date.parse(w.end) > Date.parse(through) ? through : w.end;
  if (dates !== null) {
    if (Date.parse(dates.start) > s) {
      s = Date.parse(dates.start);
      start = dates.start;
    }
    if (dates.end !== null && Date.parse(dates.end) < e) {
      e = Date.parse(dates.end);
      end = dates.end;
    }
  }
  return e > s ? { start, end } : null;
}

/**
 * **The windows a purchase line covers, per unit**, closed at `through`: the
 * charge windows of every unit the line names (`uid_units`), clipped to the
 * line's `dates`. A window that opened after `through` is not yet billable; an
 * open window (`end: null`, the line still on) bills up to `through`.
 *
 * The LINE names the unit, so this reads the line and the units — nothing on a
 * unit says which line bills it (D10 item 10, the invoice ↔ out-of-service
 * direction).
 *
 * Keyed by unit, each list ascending — the unit's own order (the unit refine).
 */
export function unitWindowsForLine(
  units: readonly Pick<UnitType, "uid" | "charge_windows">[],
  line: PurchaseLineCoverage,
  through: string,
): Map<string, ChargeWindowType[]> {
  const named = new Set(line.uid_units);
  const out = new Map<string, ChargeWindowType[]>();
  for (const unit of units) {
    if (!named.has(unit.uid)) continue;
    const windows: ChargeWindowType[] = [];
    for (const w of unit.charge_windows) {
      const clipped = clipToLine(w, line.dates, through);
      if (clipped !== null) windows.push(clipped);
    }
    if (windows.length > 0) out.set(unit.uid, windows);
  }
  return out;
}

// ── Coverage: which line covers a unit's window, and the offer for the rest ──

/**
 * Does this purchase line COUNT for coverage? Its purchase was not canceled and
 * the line was not canceled in full with nothing billed (`purchaseItemCanceled`
 * — it never happened). A closed or completed line still covered the time it
 * covered.
 */
export function purchaseLineCovers(purchase: Pick<Purchase, "status">, item: PurchaseItem): boolean {
  return purchase.status !== "canceled" && item.type !== "sale" && !purchaseItemCanceled(item);
}

/** One live line covering one unit — the covering line and its span. */
export interface UnitCover {
  uid_purchase: string;
  path: string[];
  dates: PurchaseLineCoverage["dates"];
}

/** Every live line naming `uid_unit` across `purchases` — what `query_by_units` array-contains returns. */
export function coversForUnit(
  uid_unit: string,
  purchases: readonly Pick<Purchase, "uid" | "status" | "items">[],
): UnitCover[] {
  const out: UnitCover[] = [];
  for (const p of purchases) {
    for (const item of p.items) {
      const c = coverageOf(item);
      if (c === null || !c.uid_units.includes(uid_unit) || !purchaseLineCovers(p, item)) continue;
      out.push({ uid_purchase: p.uid, path: [...item.path], dates: c.dates });
    }
  }
  return out;
}

const ALL_TIME: Interval = { s: -8.64e15, e: 8.64e15, start: "", end: "" };

function coverInterval(c: UnitCover): Interval {
  if (c.dates === null) return ALL_TIME;
  return {
    s: Date.parse(c.dates.start),
    e: c.dates.end === null ? ALL_TIME.e : Date.parse(c.dates.end),
    start: c.dates.start,
    end: c.dates.end ?? "",
  };
}

/** A unit's windows closed at `through` (an open window bills up to `through`). */
function closedWindows(unit: Pick<UnitType, "charge_windows">, through: string): Interval[] {
  return unit.charge_windows.flatMap((w) => {
    const c = clipToLine(w, null, through);
    return c === null ? [] : [toInterval(c)];
  });
}

/** An interval back to window strings — an `ALL_TIME` bound never survives an intersection with a window. */
function fromCut(i: Interval): ChargeWindowType {
  return { start: i.start, end: i.end };
}

/**
 * **The pieces of each unit's windows that NO live purchase line covers**,
 * closed at `through` — the supplier side's "not yet billed" offer source
 * (`seedReplacementLines`' twin). Keyed by unit; a fully covered unit is absent.
 */
export function uncoveredUnitWindows(
  units: readonly Pick<UnitType, "uid" | "charge_windows">[],
  purchases: readonly Pick<Purchase, "uid" | "status" | "items">[],
  through: string,
): Map<string, ChargeWindowType[]> {
  const out = new Map<string, ChargeWindowType[]>();
  for (const unit of units) {
    const covers = coversForUnit(unit.uid, purchases).map(coverInterval);
    const rest = subtractIntervals(closedWindows(unit, through), covers).map(fromCut);
    if (rest.length > 0) out.set(unit.uid, rest);
  }
  return out;
}

/**
 * **Window time covered by TWO OR MORE live lines** — one unit's time billed
 * twice over. ADVISORY, never a refusal (D5: what is billed is flagged), the
 * `overbilled_out_of_service` twin. Keyed by unit; each entry names the lines
 * that overlap there.
 */
export function overcoveredUnitWindows(
  units: readonly Pick<UnitType, "uid" | "charge_windows">[],
  purchases: readonly Pick<Purchase, "uid" | "status" | "items">[],
  through: string,
): Map<string, { windows: ChargeWindowType[]; lines: UnitCover[] }> {
  const out = new Map<string, { windows: ChargeWindowType[]; lines: UnitCover[] }>();
  for (const unit of units) {
    const covers = coversForUnit(unit.uid, purchases);
    if (covers.length < 2) continue;
    const windows = closedWindows(unit, through);
    const doubled: Interval[] = [];
    const lines = new Set<number>();
    for (let a = 0; a < covers.length; a++) {
      for (let b = a + 1; b < covers.length; b++) {
        const ia = coverInterval(covers[a]);
        const ib = coverInterval(covers[b]);
        const lo = ia.s >= ib.s ? ia : ib;
        const hi = ia.e <= ib.e ? ia : ib;
        const both: Interval = { s: lo.s, e: hi.e, start: lo.start, end: hi.end };
        if (both.e <= both.s) continue;
        for (const w of windows) {
          const pieces = intersectWindow([w], both);
          if (pieces.length === 0) continue;
          doubled.push(...pieces);
          lines.add(a).add(b);
        }
      }
    }
    if (doubled.length === 0) continue;
    out.set(unit.uid, {
      windows: unionIntervals(doubled).map(fromCut),
      lines: [...lines].sort((x, y) => x - y).map((k) => covers[k]),
    });
  }
  return out;
}

/** What {@link seedPurchaseLinesForWindows} needs of a unit. */
export type SeedSourceUnit = Pick<UnitType, "uid" | "number" | "uid_product" | "charge_windows">;
/** What {@link seedPurchaseLinesForWindows} needs of a product. */
export type SeedSourceProduct = Pick<Product, "uid" | "name" | "cogs">;

/**
 * One offered purchase line for uncovered windows — the supplier twin of a
 * `ReplacementLineSeed`. Always a TIME `service` (Charge) line: a window is a service
 * line, not custody, and a supplier-owned unit's subrent line already names it
 * from its receipt.
 */
export interface PurchaseLineSeed {
  type: "service";
  uid_product: string;
  /** The product's name — the line's default `name`. */
  name: string;
  /** Ascending by unit number. */
  uid_units: string[];
  /** The formula the windows are metered under (`UnitChargeWindow.uid_price_formula`). */
  uid_price_formula: string;
  /**
   * Who bills it — the product's activation cost entry on that formula, or
   * `null` when the product names none (the operator picks the supplier).
   */
  provider: UidNameRefType | null;
  /** The entry's rates in force at `dates.start`, or `[]` with no entry. */
  rates: { rate_key: string; amount_cents: number }[];
  /**
   * The entry's Direct Costs account (the product's `coa_cost`, renamed in
   * one-document-model Phase 8), or `null` with no entry.
   */
  ledger_account: COACostType | null;
  /** From the earliest uncovered instant, open-ended: a carrier line accrues for as long as it lives. */
  dates: { start: string; end: null };
  /** The uncovered windows, per unit — what the offer is FOR, for display. */
  windows: { uid_unit: string; number: number; windows: ChargeWindowType[] }[];
  /** Why the seed is not plain (no cost entry, two entries on the formula), or `null`. */
  warning: string | null;
}

/**
 * **Offer a purchase line for every window no live line covers** — the
 * supplier side of the lost-and-damaged offer (`seedReplacementLines`): core
 * decides WHAT to offer, the manager shows it, and accepting it is an ordinary
 * `POST /purchases` (or an amend) whose lines name the units. Nothing on a unit
 * is written, because a window names no line.
 *
 * Grouped by (product, formula): one seed per group, naming every unit in it.
 * The provider and rates come from the product's activation entry on that
 * formula; `null` / `[]` when the product has none, with a warning.
 */
export function seedPurchaseLinesForWindows(
  units: readonly SeedSourceUnit[],
  purchases: readonly Pick<Purchase, "uid" | "status" | "items">[],
  products: ReadonlyMap<string, SeedSourceProduct>,
  through: string,
): PurchaseLineSeed[] {
  const uncovered = uncoveredUnitWindows(units, purchases, through);
  const groups = new Map<string, { product: string; formula: string; units: SeedSourceUnit[] }>();
  for (const unit of units) {
    const pieces = uncovered.get(unit.uid);
    if (!pieces) continue;
    // A unit's pieces fall under the formula of the window they came from.
    const formulas = new Set(
      unit.charge_windows.filter((w) => pieces.some((p) => clipToLine(w, { start: p.start, end: p.end }, through) !== null))
        .map((w) => w.uid_price_formula),
    );
    for (const formula of formulas) {
      const key = `${unit.uid_product}|${formula}`;
      const g = groups.get(key) ?? { product: unit.uid_product, formula, units: [] };
      g.units.push(unit);
      groups.set(key, g);
    }
  }

  const seeds: PurchaseLineSeed[] = [];
  for (const g of groups.values()) {
    const product = products.get(g.product);
    const entries = (product?.cogs ?? []).filter((e): e is CogsActivationEntryType =>
      e.trigger === "activation" && e.uid_price_formula === g.formula
    );
    const entry = entries[0];
    const sorted = [...g.units].sort((a, b) => a.number - b.number);
    const windows = sorted.map((u) => ({
      uid_unit: u.uid,
      number: u.number,
      windows: (uncovered.get(u.uid) ?? []).filter((p) =>
        u.charge_windows.some((w) => w.uid_price_formula === g.formula && clipToLine(w, { start: p.start, end: p.end }, through) !== null)
      ),
    })).filter((u) => u.windows.length > 0);
    if (windows.length === 0) continue;
    const start = windows.flatMap((u) => u.windows).reduce(
      (min, w) => (Date.parse(w.start) < Date.parse(min) ? w.start : min),
      windows[0].windows[0].start,
    );
    seeds.push({
      type: "service",
      uid_product: g.product,
      name: product?.name ?? g.product,
      uid_units: windows.map((u) => u.uid_unit),
      uid_price_formula: g.formula,
      provider: entry?.provider ?? null,
      rates: entry ? catalogRateSnapshot(entry.rates, start) : [],
      ledger_account: entry?.coa_cost ?? null,
      dates: { start, end: null },
      windows,
      warning: entry === undefined
        ? "The product has no activation cost entry on this formula; choose the supplier and rates"
        : entries.length > 1
        ? `The product has ${entries.length} activation cost entries on this formula; the first (${entry.label}) was used`
        : null,
    });
  }
  return seeds.sort((a, b) => a.name.localeCompare(b.name) || a.uid_product.localeCompare(b.uid_product));
}

/**
 * **What one purchase line's units are already billed for**: per unit, the
 * union of the windows on live bills (those `before` the given bill number, if
 * one is given) less the union of the windows on live credits. A credit un-bills
 * time, so what it names is owed again.
 *
 * ⚠️ Credits are subtracted whatever their date: a credit names no bill, so
 * which bill it un-bills is not stored. On a re-meter of an older bill this can
 * read a credited span as unbilled; it only affects that default.
 */
export function billedUnitCoverage(
  documents: PurchaseBilledDocuments,
  path: readonly string[],
  before?: number,
): Map<string, ChargeWindowType[]> {
  const byUnit = (items: readonly PurchaseDocumentItem[], into: Map<string, Interval[]>) => {
    for (const line of linesFor(items, path)) {
      for (const u of line.units ?? []) {
        const list = into.get(u.uid_unit) ?? [];
        list.push(...u.charge_windows.map(toInterval));
        into.set(u.uid_unit, list);
      }
    }
  };
  const billed = new Map<string, Interval[]>();
  for (const bill of documents.bills) {
    if (!purchaseBillIsLive(bill) || (before !== undefined && bill.number >= before)) continue;
    byUnit(bill.items, billed);
  }
  const credited = new Map<string, Interval[]>();
  for (const credit of documents.credits) {
    if (!purchaseCreditIsLive(credit)) continue;
    byUnit(credit.items, credited);
  }
  const out = new Map<string, ChargeWindowType[]>();
  for (const [unit, list] of billed) {
    const net = subtractIntervals(list, credited.get(unit) ?? []);
    if (net.length > 0) out.set(unit, net.map(fromInterval));
  }
  return out;
}

/** What the live documents bill of one purchase line, net of credits. */
export interface PurchaseLineBilledNet {
  /** Σ live bill line quantity − Σ live credit line quantity. May be negative. */
  quantity: number;
  /** Σ live bill line `amount_cents` − Σ live credit line `amount_cents`. May be negative. */
  amount_cents: number;
}

/**
 * **What the purchase line at `path` is billed, net of credits, UNFLOORED.** The
 * one sum behind {@link recomputePurchaseQuantityBilled} and the diff's `billed`
 * entry: lines join on the full path, because one product may sit on two lines.
 * A negative is a credit with no live bill left under it, which the diff has to
 * be able to show.
 */
export function purchaseLineBilledNet(path: readonly string[], documents: PurchaseBilledDocuments): PurchaseLineBilledNet {
  const net: PurchaseLineBilledNet = { quantity: 0, amount_cents: 0 };
  const add = (items: readonly PurchaseDocumentItem[], sign: 1 | -1) => {
    for (const line of linesFor(items, path)) {
      net.quantity += sign * line.quantity;
      net.amount_cents += sign * line.amount_cents;
    }
  };
  for (const bill of documents.bills) if (purchaseBillIsLive(bill)) add(bill.items, 1);
  for (const credit of documents.credits) if (purchaseCreditIsLive(credit)) add(credit.items, -1);
  return net;
}

/**
 * **A purchase's lines with `quantity_billed` recounted** from its documents
 * (api-cloudrun#1441). A flat line's count is {@link purchaseLineBilledNet}
 * floored at 0, because the schema's bucket is `.min(0)`; the diff keeps the
 * unfloored number. A time line counts nothing and comes back as it went in.
 *
 * ⚠️ `quantity_billed` is unlike its sibling buckets. `quantity_received` and
 * `quantity_returned` are kept by delta, because a receipt's quantity never
 * changes; a bill line's does, so a delta here releases the wrong number on a
 * void. Pass EVERY bill and credit of the purchase, including the one the
 * caller is writing.
 */
export function recomputePurchaseQuantityBilled(
  purchase: Pick<Purchase, "items">,
  documents: PurchaseBilledDocuments,
): PurchaseItem[] {
  return purchase.items.map((item) =>
    purchaseItemBasis(item) === "flat"
      ? { ...item, quantity_billed: Math.max(0, purchaseLineBilledNet(item.path, documents).quantity) }
      : item
  );
}

/**
 * **The latest end a span-metered line has been billed to** — the max `dates.end`
 * over the live bills projecting `path` (before `before`, if given), or `null`
 * when none has. A span line (Verizon) bills its span forward in contiguous
 * periods, so the next period starts there.
 */
export function billedSpanEnd(
  documents: PurchaseBilledDocuments,
  path: readonly string[],
  before?: number,
): string | null {
  let best: string | null = null;
  for (const bill of documents.bills) {
    if (!purchaseBillIsLive(bill) || (before !== undefined && bill.number >= before)) continue;
    for (const line of linesFor(bill.items, path)) {
      const end = line.dates?.end;
      if (end && (best === null || Date.parse(end) > Date.parse(best))) best = end;
    }
  }
  return best;
}

/**
 * **The windows a time line's units have recorded and no live bill covers** —
 * what a new bill defaults to (D5, the `buildRemainingInvoice` rule). Per unit,
 * its recorded windows (closed at `through`) less its billed coverage. A unit
 * with nothing left is left out.
 */
export function unbilledUnitWindows(
  recorded: ReadonlyMap<string, readonly ChargeWindowType[]>,
  billed: ReadonlyMap<string, readonly ChargeWindowType[]>,
): PurchaseDocumentLineUnit[] {
  const out: PurchaseDocumentLineUnit[] = [];
  for (const [uid_unit, windows] of recorded) {
    const covered = (billed.get(uid_unit) ?? []).map(toInterval);
    const pieces: ChargeWindowType[] = [];
    for (const w of windows.map(toInterval)) {
      pieces.push(...subtractIntervals([w], covered).map(fromInterval));
    }
    if (pieces.length > 0) out.push({ uid_unit, charge_windows: pieces });
  }
  return out;
}

// ── Metering a bill line ───────────────────────────────────────

function formulaFor(price: { price_formula: { uid: string; name: string } }, ctx: PurchaseDocumentContext): PricingFormula {
  const formula = ctx.formulas.get(price.price_formula.uid);
  if (!formula) {
    throw new Error(`Price formula "${price.price_formula.name}" (${price.price_formula.uid}) is not loaded`);
  }
  return formula;
}

/**
 * **One unit's counts for the pieces a bill line adds**, as a delta of the
 * cumulative meter (module docblock). `recorded` is the unit's windows on the
 * purchase line — the frames inside which pieces are unioned; `billed` its
 * coverage before this bill; `added` the pieces this bill line carries.
 * Coverage outside every recorded window (time the supplier billed that no
 * window recorded) is metered as its own window, so an operator-entered piece
 * still prices.
 */
function unitDeltaCounts(
  formula: PricingFormula,
  recorded: readonly ChargeWindowType[],
  billed: readonly ChargeWindowType[],
  added: readonly ChargeWindowType[],
  holidays: readonly string[],
  rates: readonly MeterRate[],
): TierCount[] {
  // The recorded windows themselves, NOT unioned: two that touch are two frames.
  const frames = recorded.map(toInterval).filter((f) => f.e > f.s).sort((a, b) => a.s - b.s);
  const before = billed.map(toInterval);
  const after = [...before, ...added.map(toInterval)];
  const framed = (list: readonly Interval[]): ChargeWindowType[] => {
    const out: Interval[] = [];
    for (const f of frames) out.push(...unionIntervals(intersectWindow(list, f)));
    out.push(...unionIntervals(subtractIntervals(list, frames)));
    return out.sort((a, b) => a.s - b.s).map(fromInterval);
  };
  const meter = (windows: ChargeWindowType[]) =>
    windows.length === 0 ? [] : meterUnits(formula, { windows, span: null, holidays, rates }).tiers;
  return combineTierCounts(meter(framed(after)), meter(framed(before)), -1);
}

/** Tier counts × an integer — a unit-less span line's counts for `quantity` units. */
function scaleCounts(counts: readonly TierCount[], quantity: number): TierCount[] {
  return counts.map((t) => ({ ...t, num: t.num * quantity }));
}

/** What {@link meterBillLine} needs about the bill line. */
export interface BillLineMeterInput {
  price: Pick<PurchaseDocumentLinePrice, "price_formula" | "rates">;
  units: readonly PurchaseDocumentLineUnit[];
  /** The span billed, for a span-metered formula. */
  dates: ChargeWindowType | null;
  /** The units billed, used only by a unit-less span line. */
  quantity: number;
}

/** What {@link meterBillLine} needs about the purchase line and what is billed before it. */
export interface BillLineMeterSource {
  /** The purchase line's span — the start a span formula meters from. */
  span: { start: string; end: string | null } | null;
  /** Each unit's recorded windows on the purchase line (`unitWindowsForLine`). */
  recorded: ReadonlyMap<string, readonly ChargeWindowType[]>;
  /** Each unit's coverage on earlier bills (`billedUnitCoverage`). */
  billed: ReadonlyMap<string, readonly ChargeWindowType[]>;
  /** Where earlier bills left a span line (`billedSpanEnd`). */
  billedSpanEnd: string | null;
}

/**
 * **A time bill line's frozen counts** — the unit-periods it bills, summed over
 * its units (ruling 8). Windows formulas meter each unit's delta (module
 * docblock); a span formula (`span_less_gaps`) meters each unit's span from the
 * purchase line's start to the bill's `dates.end`, less the same to where
 * earlier bills left it, with the unit's windows as the "on" time. A span line
 * with no units meters the span with no gaps, times `quantity`.
 *
 * @throws on a flat line, or a formula the context does not hold.
 */
export function meterBillLine(
  line: BillLineMeterInput,
  source: BillLineMeterSource,
  ctx: PurchaseDocumentContext,
): TierCount[] {
  if (line.price.price_formula.basis !== "time") {
    throw new Error("A flat line meters no counts");
  }
  const formula = formulaFor(line.price, ctx);
  if (formula.meter.source === "span_less_gaps") {
    if (line.dates === null || source.span === null) {
      throw new Error(`A "${formula.name}" line meters a span, and this one states none`);
    }
    const from = source.span.start;
    const prior = source.billedSpanEnd;
    const meterTo = (end: string, windows: readonly ChargeWindowType[]) =>
      Date.parse(end) <= Date.parse(from)
        ? []
        : meterUnits(formula, {
          windows,
          span: { start: from, end },
          holidays: ctx.holidays,
          rates: line.price.rates,
        }).tiers;
    const delta = (windows: readonly ChargeWindowType[]) =>
      combineTierCounts(meterTo(line.dates!.end, windows), prior === null ? [] : meterTo(prior, windows), -1);
    if (line.units.length === 0) {
      return scaleCounts(delta([{ start: from, end: line.dates.end }]), line.quantity);
    }
    return line.units.reduce<TierCount[]>(
      (sum, u) => combineTierCounts(sum, delta(source.recorded.get(u.uid_unit) ?? u.charge_windows), 1),
      [],
    );
  }
  return line.units.reduce<TierCount[]>((sum, u) =>
    combineTierCounts(
      sum,
      unitDeltaCounts(
        formula,
        source.recorded.get(u.uid_unit) ?? u.charge_windows,
        source.billed.get(u.uid_unit) ?? [],
        u.charge_windows,
        ctx.holidays,
        line.price.rates,
      ),
      1,
    ), []);
}

// ── Money ───────────────────────────────────────────────────────

/** A time line's money from its own snapshot: quantity is folded into the counts, so the money step runs at 1. */
function timeLineMoney(price: PurchaseDocumentLinePrice): { amount_cents: number; discount_cents: number } {
  const { subtotal_cents, subtotal_discounted_cents } = priceFromFormula(price.rates, price.counts, 1, price.discount);
  return { amount_cents: subtotal_discounted_cents, discount_cents: subtotal_cents - subtotal_discounted_cents };
}

/**
 * A FLAT bill line's share of its purchase line's discount, for the record.
 * `amount_cents` is already net (ruling 7), so this moves no money: it is
 * `round(discount × billed ÷ ordered)`, informational, and never summed.
 */
function flatDiscountShare(discount: DiscountType, billed: number, ordered: number): number {
  return Number(roundDivHalfUp(BigInt(discount.amount_cents) * BigInt(billed), BigInt(ordered)));
}

/**
 * The cents a flat line's units `(before, after]` cost — `cumulativeShareCents`,
 * extended past `quantity` at the same per-unit rate, because over-billing is
 * legal (D5) and still needs a default. A writer pricing anything against a
 * line's `quantity_billed`, which may stand past `quantity`, prices through this
 * and never through `cumulativeShareCents`, which throws there.
 */
export function flatShareCents(amountCents: number, quantity: number, before: number, after: number): number {
  if (after <= quantity) return cumulativeShareCents(amountCents, quantity, before, after);
  const at = (k: number) => Number(roundDivHalfUp(BigInt(amountCents) * BigInt(k), BigInt(quantity)));
  return at(after) - at(before);
}

/** The result of {@link pricePurchaseDocument}. */
export interface PricedPurchaseDocument {
  items: PurchaseDocumentItem[];
  /** Σ line money on a PUSHED document; `null` on a linked one, whose total stays Xero's. */
  total_cents: number | null;
}

/**
 * **Price a bill or credit from its lines** (D7) — the assembler beside
 * `priceCreditNote`, with no tax, fee, carried-line or replacement stage.
 *
 * - **pushed** — each time line's `amount_cents` and `discount.amount_cents`
 *   are re-derived from its own `rates × counts` (the refine's rule, run as
 *   the writer); a flat line keeps its stated net. The total is the Σ.
 * - **linked** — returned untouched: Xero's money is never written (D5).
 *
 * Counts are NOT re-metered here; they are frozen on the line, and a writer
 * that moves a line's windows re-meters through {@link meterBillLine} first.
 */
export function pricePurchaseDocument(
  doc: { origin: "pushed" | "linked"; items: readonly PurchaseDocumentItem[] },
): PricedPurchaseDocument {
  if (doc.origin === "linked") return { items: doc.items.map((i) => structuredCloneLine(i)), total_cents: null };
  const items = doc.items.map((item) => {
    const line = structuredCloneLine(item);
    if (line.price && line.price.price_formula.basis === "time") {
      const { amount_cents, discount_cents } = timeLineMoney(line.price);
      line.amount_cents = amount_cents;
      if (line.price.discount) line.price.discount = { ...line.price.discount, amount_cents: discount_cents };
    }
    return line;
  });
  return { items, total_cents: items.reduce((sum, i) => sum + i.amount_cents, 0) };
}

/** A deep copy of a line's plain data (no Timestamps live on a line). */
function structuredCloneLine<T extends PurchaseDocumentItem>(line: T): T {
  return JSON.parse(JSON.stringify(line)) as T;
}

// ── The projector ───────────────────────────────────────────────

/**
 * The shared keys a bill or credit line copies from the purchase line it
 * projects: the line head, posting and tax cores (one instance per key,
 * `schemas/_items.ts`) and the pointer back to the purchase line. `quantity` is
 * NOT here — it is the units the line bills, a homonym of the ordered quantity.
 */
function projectedLineHead(item: PurchaseItem, uid: string) {
  return {
    uid,
    name: item.name,
    description: item.description,
    path: [uid],
    zero_priced: item.zero_priced,
    ...(item.quantity_per_parent !== undefined ? { quantity_per_parent: item.quantity_per_parent } : {}),
    ledger_account: item.ledger_account,
    uid_tracking_category: item.uid_tracking_category,
    uid_tax_class: item.uid_tax_class,
    ...(item.uid_tax_class_override !== undefined ? { uid_tax_class_override: item.uid_tax_class_override } : {}),
    path_purchase_item: [...item.path],
  };
}

/**
 * What a purchase line's bill line attributes: the product a sale or rental
 * orders, or a service's optional product, and a replacement's record.
 */
function attributionOf(item: PurchaseItem): { uid_product?: string; uid_out_of_service?: string } {
  switch (item.type) {
    case "sale":
    case "rental":
      return { uid_product: item.uid_product };
    case "service":
      return item.uid_product !== undefined ? { uid_product: item.uid_product } : {};
    case "replacement":
      return {
        ...(item.uid_product !== undefined ? { uid_product: item.uid_product } : {}),
        uid_out_of_service: item.uid_out_of_service,
      };
    default: {
      const unreachable: never = item;
      throw new Error(`attributionOf: unknown purchase item ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The purchase line's exempt tax keys, copied onto a bill or credit line's price. */
function priceTaxesOf(price: PurchaseLinePrice): Pick<PurchaseLinePrice, "taxes" | "taxes_base"> {
  return {
    taxes: price.taxes.map((t) => ({ ...t })),
    ...(price.taxes_base !== undefined ? { taxes_base: price.taxes_base.map((t) => ({ ...t })) } : {}),
  };
}

/** {@link projectPurchaseLineToBillLine}'s inputs beside the purchase line. */
export interface ProjectBillLineOptions {
  /** The new bill line's row identity, minted by the writer. */
  uid: string;
  /** The purchase the line is on. */
  uid_purchase: string;
  /**
   * The units billed, on a FLAT line (the operator's input). Ignored on a time
   * line, whose quantity is the count of units it bills.
   */
  quantity: number;
  /** The billing cut-off: open windows and a span bill up to here. A Chicago instant. */
  through: string;
  /** The units whose windows name the line — every unit doc that may. */
  units: readonly Pick<UnitType, "uid" | "charge_windows">[];
  /** The purchase's existing bills and credits. */
  billed: PurchaseBilledDocuments;
}

/**
 * **Default a bill line from its purchase line** (D5). Name, formula, rates,
 * discount terms, posting and attribution are the purchase line's (each then
 * overridable on the bill until it settles); the money depends on the basis:
 *
 * - **flat** — `quantity` units at the line's cumulative share from where its
 *   `quantity_billed` stands (`cumulativeShareCents`, extended past the
 *   ordered count because over-billing is legal), so the bills of a line sum to
 *   its `amount_cents`.
 * - **time** — the units' UNBILLED windows up to `through`
 *   ({@link unbilledUnitWindows}), metered as deltas ({@link meterBillLine})
 *   and priced by the one money step. A span line (Verizon) bills from where
 *   its earlier bills left off to `through` (or the line's end, if sooner).
 *
 * Returns `null` when a time line has nothing to bill — no unbilled windows, or
 * a span already billed through `through` (the poll's `nothing_to_bill`). A
 * flat line always projects: what to bill is the operator's call.
 *
 * @throws on a time line whose formula the context does not hold, or a span
 *   formula on a line with no span.
 */
export function projectPurchaseLineToBillLine(
  item: PurchaseItem,
  opts: ProjectBillLineOptions,
  ctx: PurchaseDocumentContext,
): PurchaseDocumentItem | null {
  const head = projectedLineHead(item, opts.uid);
  const attribution = attributionOf(item);

  if (purchaseItemBasis(item) === "flat") {
    const amount = item.amount_cents ?? 0;
    const before = item.quantity_billed ?? 0;
    const amount_cents = flatShareCents(amount, item.quantity, before, before + opts.quantity);
    const price: PurchaseDocumentLinePrice | undefined = item.price
      ? {
        price_formula: { ...item.price.price_formula },
        rates: [],
        discount: item.price.discount
          ? { ...item.price.discount, amount_cents: flatDiscountShare(item.price.discount, opts.quantity, item.quantity) }
          : null,
        ...priceTaxesOf(item.price),
        counts: [],
      }
      : undefined;
    const line = {
      type: item.type,
      ...head,
      ...attribution,
      quantity: opts.quantity,
      amount_cents,
      ...(price ? { price } : {}),
      // A flat line meters nothing: no units, no span (api-cloudrun#1425).
      units: [],
      dates: null,
    };
    return line as PurchaseDocumentItem;
  }

  // A time line: item.price is required on subrent and charge.
  const itemPrice = item.price!;
  const formula = formulaFor(itemPrice, ctx);
  const recorded = unitWindowsForLine(opts.units, coverageOf(item) ?? { uid_units: [], dates: null }, opts.through);
  const billed = billedUnitCoverage(opts.billed, item.path);
  const itemSpan = item.type === "sale" ? null : item.dates;
  const source: BillLineMeterSource = {
    span: itemSpan,
    recorded,
    billed,
    billedSpanEnd: billedSpanEnd(opts.billed, item.path),
  };

  let units: PurchaseDocumentLineUnit[];
  let dates: ChargeWindowType | null = null;
  if (formula.meter.source === "span_less_gaps") {
    if (itemSpan === null) throw new Error(`A "${formula.name}" line meters a span, and this one states none`);
    const start = source.billedSpanEnd ?? itemSpan.start;
    const lineEnd = itemSpan.end;
    const end = lineEnd !== null && Date.parse(lineEnd) < Date.parse(opts.through) ? lineEnd : opts.through;
    if (Date.parse(end) <= Date.parse(start)) return null;
    dates = { start, end };
    const period = toInterval(dates);
    units = [...recorded].flatMap(([uid_unit, windows]) => {
      const inside = unionIntervals(intersectWindow(windows.map(toInterval), period));
      return inside.length > 0 ? [{ uid_unit, charge_windows: inside.map(fromInterval) }] : [];
    });
  } else {
    units = unbilledUnitWindows(recorded, billed);
    if (units.length === 0) return null;
  }

  const quantity = units.length > 0 ? units.length : item.quantity - item.quantity_canceled;
  if (quantity < 1) return null;
  const counts = meterBillLine({ price: itemPrice, units, dates, quantity }, source, ctx);
  const price: PurchaseDocumentLinePrice = {
    price_formula: { ...itemPrice.price_formula },
    rates: itemPrice.rates.map((r) => ({ ...r })),
    discount: itemPrice.discount ? { ...itemPrice.discount } : null,
    ...priceTaxesOf(itemPrice),
    counts,
  };
  const { amount_cents, discount_cents } = timeLineMoney(price);
  if (price.discount) price.discount.amount_cents = discount_cents;
  return {
    type: item.type,
    ...head,
    ...attribution,
    quantity,
    amount_cents,
    price,
    units,
    dates,
  } as PurchaseDocumentItem;
}

/** {@link projectPurchaseLineToCreditLine}'s inputs beside the purchase line. */
export interface ProjectCreditLineOptions {
  /** The new credit line's row identity, minted by the writer. */
  uid: string;
  /** The units it credits, each with the windows it un-bills. */
  units: readonly PurchaseDocumentLineUnit[];
  /** The span it un-bills, on a span-metered line. */
  dates: ChargeWindowType | null;
  /** The units credited on a unit-less span line; otherwise the count of `units`. */
  quantity: number;
  /** The purchase's existing bills and credits. */
  billed: PurchaseBilledDocuments;
}

/**
 * **A TIME credit line** — what un-billing some of a time line's billed time is
 * worth (`PurchaseCreditItemInput`'s docblock).
 *
 * Every credited piece must sit inside what is billed and not yet credited
 * (`billedUnitCoverage`; for a span line, between the line's start and where
 * its bills left it), or this throws: a credit cannot un-bill time nobody billed.
 * The counts are the meter's delta — the credited windows metered on top of what
 * stays billed — so a credit of a whole bill reverses it exactly, and a credit of
 * a window's tail inside a capped month credits the weeks the month still covers
 * (Q14), never the month. The money is the one money step at the purchase line's
 * snapshotted rates and discount; the account, category and attribution are the
 * purchase line's.
 *
 * @throws on a flat line, an unknown formula, or a piece outside the billed time.
 */
export function projectPurchaseLineToCreditLine(
  item: PurchaseItem,
  opts: ProjectCreditLineOptions,
  ctx: PurchaseDocumentContext,
): PurchaseDocumentItem {
  if (purchaseItemBasis(item) !== "time" || item.type === "sale") {
    throw new Error(`${item.name} is billed by quantity; credit it in units`);
  }
  const itemPrice = item.price!;
  const formula = formulaFor(itemPrice, ctx);
  const coverage = billedUnitCoverage(opts.billed, item.path);
  const remainder = new Map<string, ChargeWindowType[]>();
  for (const [uid, windows] of coverage) remainder.set(uid, windows);
  const units = opts.units.map((u) => ({
    uid_unit: u.uid_unit,
    charge_windows: unionIntervals(u.charge_windows.map(toInterval)).map(fromInterval),
  }));
  for (const u of units) {
    const covered = (coverage.get(u.uid_unit) ?? []).map(toInterval);
    const outside = subtractIntervals(u.charge_windows.map(toInterval), covered);
    if (outside.length > 0) {
      throw new Error(`Unit ${u.uid_unit} is not billed for ${outside.map(fromInterval).map((w) => `${w.start}–${w.end}`).join(", ")}`);
    }
    const left = subtractIntervals(covered, u.charge_windows.map(toInterval)).map(fromInterval);
    if (left.length > 0) remainder.set(u.uid_unit, left);
    else remainder.delete(u.uid_unit);
  }

  let dates: ChargeWindowType | null = null;
  let billedSpanEndAt: string | null = null;
  if (formula.meter.source === "span_less_gaps") {
    if (opts.dates === null || item.dates === null) {
      throw new Error(`A "${formula.name}" line credits a span, and this credit states none`);
    }
    const billedTo = billedSpanEnd(opts.billed, item.path);
    const from = Date.parse(opts.dates.start);
    const to = Date.parse(opts.dates.end);
    if (billedTo === null || from < Date.parse(item.dates.start) || to > Date.parse(billedTo) || to <= from) {
      throw new Error(`The credited span ${opts.dates.start}–${opts.dates.end} is not inside the span billed`);
    }
    // A span credit names no unit windows, so coverage cannot net it: refuse a
    // span an earlier live credit already un-billed.
    for (const credit of opts.billed.credits) {
      if (!purchaseCreditIsLive(credit)) continue;
      for (const line of linesFor(credit.items, item.path)) {
        if (line.dates && Date.parse(line.dates.start) < to && Date.parse(line.dates.end) > from) {
          throw new Error(`The span ${opts.dates.start}–${opts.dates.end} overlaps one already credited`);
        }
      }
    }
    dates = { start: opts.dates.start, end: opts.dates.end };
    billedSpanEndAt = opts.dates.start;
  } else if (units.length === 0) {
    throw new Error(`A credit of ${item.name} names the units and windows it un-bills`);
  }

  const quantity = units.length > 0 ? units.length : opts.quantity;
  const counts = meterBillLine(
    { price: itemPrice, units, dates, quantity },
    { span: item.dates, recorded: coverage, billed: remainder, billedSpanEnd: billedSpanEndAt },
    ctx,
  );
  const price: PurchaseDocumentLinePrice = {
    price_formula: { ...itemPrice.price_formula },
    rates: itemPrice.rates.map((r) => ({ ...r })),
    discount: itemPrice.discount ? { ...itemPrice.discount } : null,
    ...priceTaxesOf(itemPrice),
    counts,
  };
  const { amount_cents, discount_cents } = timeLineMoney(price);
  if (price.discount) price.discount.amount_cents = discount_cents;
  return {
    type: item.type,
    ...projectedLineHead(item, opts.uid),
    ...attributionOf(item),
    quantity,
    amount_cents,
    price,
    units,
    dates,
  } as PurchaseDocumentItem;
}

// ── The purchase → bill sync ───────────────────────────────────

let billFields: readonly SharedField[] | null = null;

/**
 * The line fields the purchase → bill merge follows, read off the two schemas
 * (fail-closed: an undeclared shared key throws, as on the order side).
 */
export function purchaseBillSharedLineFields(): readonly SharedField[] {
  if (billFields !== null) return billFields;
  const c = classifySharedFields(PurchaseSchema, PurchaseBillSchema);
  if (c.unhandled.length > 0 || c.undeclared.length > 0) {
    throw new Error(
      `purchase → bill shared fields are not all declared: unhandled ${JSON.stringify(c.unhandled)}, ` +
        `undeclared ${JSON.stringify(c.undeclared)}`,
    );
  }
  billFields = fieldsUnder(c, "items[]");
  return billFields;
}

/**
 * **A purchase line in a BILL line's shape, over the shared keys only** — the
 * merge's three arguments must all be in the downstream shape (core#52), and
 * the purchase↔bill diff compares exactly what the merge follows.
 */
export function projectPurchaseLineForBill(item: PurchaseItem): Record<string, unknown> {
  return {
    type: item.type,
    name: item.name,
    description: item.description,
    zero_priced: item.zero_priced,
    ...(item.quantity_per_parent !== undefined ? { quantity_per_parent: item.quantity_per_parent } : {}),
    ledger_account: item.ledger_account,
    uid_tracking_category: item.uid_tracking_category,
    uid_tax_class: item.uid_tax_class,
    ...(item.uid_tax_class_override !== undefined ? { uid_tax_class_override: item.uid_tax_class_override } : {}),
    ...(item.price
      ? {
        price: {
          price_formula: item.price.price_formula,
          rates: item.price.rates,
          discount: item.price.discount,
        },
      }
      : {}),
    ...attributionOf(item),
  };
}

/** One bill's outcome from {@link syncPurchaseToBills}. */
export interface PurchaseBillSync {
  uid: string;
  /** The bill to store — the input object unchanged when `changed` is false. */
  bill: PurchaseBill;
  /** `items[k].<field>` paths the bill kept because an operator overrode them. */
  overridden: string[];
  changed: boolean;
}

/** {@link syncPurchaseToBills}' inputs. */
export interface SyncPurchaseToBillsArgs {
  prev: Purchase;
  next: Purchase;
  /** Every bill of the purchase (the writer point-gets `query_by_bills`). */
  bills: readonly PurchaseBill[];
  /** Every credit of the purchase, for the coverage a re-meter reads. */
  credits: readonly Pick<PurchaseCredit, "status" | "items">[];
}

/**
 * **The purchase → bill three-way sync** (D5, the `stageOrderInvoiceSync`
 * shape): every PUSHED, unsettled, live bill's lines follow the purchase lines
 * they project, field by field, wherever the bill still holds the PREVIOUS
 * purchase's value. Pure; the writer stores the `changed` bills in the purchase
 * writer's transaction.
 *
 * After the merge each touched line is re-derived: a time line whose FORMULA
 * or RATES changed is re-metered from its own windows against the coverage of
 * the purchase's earlier bills, and every time line's money is re-priced from
 * its rates and counts; the bill's total is the Σ. A flat line's net amount is a
 * homonym and never follows (its share was fixed when billed); its discount
 * record is re-derived.
 *
 * Skipped whole: a linked bill (Xero is authoritative), a frozen one
 * (`purchaseBillIsFrozen`), a voided one.
 *
 * `total_cents` and `amount_due_cents` move together (an unfrozen bill has no
 * money settlement, so the identity holds with what is due); a writer that
 * also holds the settlement rows may refold with `recomputePurchaseBillTotals`.
 */
export function syncPurchaseToBills(args: SyncPurchaseToBillsArgs, ctx: PurchaseDocumentContext): PurchaseBillSync[] {
  const fields = purchaseBillSharedLineFields();
  const prevByPath = new Map(args.prev.items.map((i) => [i.path.join("/"), i]));
  const nextByPath = new Map(args.next.items.map((i) => [i.path.join("/"), i]));
  const documents: PurchaseBilledDocuments = { bills: args.bills, credits: args.credits };

  return args.bills.map((bill) => {
    const untouched = { uid: bill.uid, bill, overridden: [], changed: false };
    if (bill.origin !== "pushed" || !purchaseBillIsLive(bill) || purchaseBillIsFrozen(bill)) return untouched;

    const overridden: string[] = [];
    let changed = false;
    const items = bill.items.map((line, k) => {
      if (line.path_purchase_item === undefined) return line;
      const key = line.path_purchase_item.join("/");
      const prevItem = prevByPath.get(key);
      const nextItem = nextByPath.get(key);
      if (!prevItem || !nextItem) return line;
      const { merged, overridden: kept } = mergeSharedFields(
        fields,
        projectPurchaseLineForBill(prevItem) as unknown as PurchaseDocumentItem,
        projectPurchaseLineForBill(nextItem) as unknown as PurchaseDocumentItem,
        line,
      );
      overridden.push(...kept.map((f) => `items[${k}].${f}`));
      const rederived = rederiveLine(merged, line, nextItem, bill.number, documents, ctx);
      if (JSON.stringify(rederived) !== JSON.stringify(line)) changed = true;
      return rederived;
    });
    if (!changed) return { ...untouched, overridden };
    const priced = pricePurchaseDocument({ origin: "pushed", items });
    return {
      uid: bill.uid,
      bill: { ...bill, items: priced.items, totals: withTotal(bill.totals, priced.total_cents!) },
      overridden,
      changed: true,
    };
  });
}

/**
 * The totals at a new `total_cents`, the identity kept: an unfrozen bill carries
 * no money settlement, so what moves is what is due.
 */
function withTotal(totals: PurchaseBill["totals"], total: number): PurchaseBill["totals"] {
  const settled = totals.amount_paid_cents + totals.amount_credited_cents + totals.amount_void_cents;
  return { ...totals, total_cents: total, amount_due_cents: total - settled };
}

/** Re-derive a merged line's derived keys: counts on a formula or rate change, the flat discount record. */
function rederiveLine(
  merged: PurchaseDocumentItem,
  stored: PurchaseDocumentItem,
  item: PurchaseItem,
  billNumber: number,
  documents: PurchaseBilledDocuments,
  ctx: PurchaseDocumentContext,
): PurchaseDocumentItem {
  const price = merged.price;
  if (!price) return merged;
  const out = structuredCloneLine(merged);
  const outPrice = out.price!;
  if (price.price_formula.basis === "flat") {
    outPrice.rates = [];
    outPrice.counts = [];
    if (outPrice.discount) {
      outPrice.discount.amount_cents = flatDiscountShare(outPrice.discount, out.quantity, item.quantity);
    }
    return out;
  }
  const formulaMoved = stored.price?.price_formula.uid !== price.price_formula.uid || stored.price?.price_formula.basis !== "time";
  // A capped segment decides on the rates (Q14), so a rate change can move the
  // counts as well as the money. A bill edit re-meters on one too; the two
  // writers must agree on what a line's counts are.
  const ratesMoved = JSON.stringify(stored.price?.rates) !== JSON.stringify(price.rates);
  if (formulaMoved || ratesMoved) {
    const span = item.type === "sale" ? null : item.dates;
    outPrice.counts = meterBillLine(
      { price, units: out.units ?? [], dates: out.dates ?? null, quantity: out.quantity },
      {
        span,
        recorded: new Map(),
        billed: billedUnitCoverage(documents, item.path, billNumber),
        billedSpanEnd: billedSpanEnd(documents, item.path, billNumber),
      },
      ctx,
    );
  }
  return out;
}
