/**
 * Purchase → bill: the projector, unit coverage and the purchase → bill
 * three-way sync (purchases-as-documents D5, D7; api-cloudrun
 * `one-document-model` Phase 2).
 *
 * The supplier side's twin of the order → invoice machinery, built from the
 * same parts:
 *
 * | customer side | here |
 * |---|---|
 * | `projectOrderItemToInvoiceItem` | {@link projectPurchaseLineToBillLine} |
 * | `syncOrderToInvoiceSelective` | {@link syncPurchaseToBills} |
 * | `priceDocument` | `priceDocument` itself — its payable arm (`./price-document.ts`) |
 *
 * ## One pricer
 *
 * A payable line's money is written by `priceDocument`'s stated-total arm
 * (`priceStatedTotalLine`): the line states its net in `amount_cents`, and its
 * k-th bill is defaulted by `cumulativeShareCents` (via {@link flatShareCents}),
 * exactly as its receipts are, so the bills of a fully billed line sum to the
 * line's `amount_cents`.
 *
 * ⚠️ **Every payable line is priced FLAT until one-document-model Phase 3.**
 * The per-unit time metering that lived here (`meterBillLine`, the unbilled-window
 * projector, time credits) was deleted with `pricePurchaseDocument`: neither
 * environment stores a time purchase line (Phase 0b census), and Phase 3 meters
 * time lines from their destination pair's windows, as an order line is
 * metered. The unit-window READERS below (`unitWindowsForLine`, the coverage
 * helpers, `seedPurchaseLinesForWindows`) retire in that phase too.
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
  type CogsActivationEntryType,
  type COACostType,
  type Product,
  type PurchaseItem,
  purchaseItemBasis,
  purchaseItemCanceled,
  PurchaseSchema,
  type UidNameRefType,
  type UnitType,
} from "../schemas/mod.ts";
import { catalogRateSnapshot } from "./price-formulas.ts";
import { cumulativeShareCents } from "./purchases.ts";
import { roundDivHalfUp } from "./money.ts";
import { classifySharedFields, fieldsUnder, mergeSharedFields, type SharedField } from "./shared-fields.ts";
import { purchaseBillIsFrozen, purchaseBillIsLive } from "./invoices.ts";
import { flatPayablePrice, type PayablePriceDocumentContext, priceDocument } from "./price-document.ts";

export { purchaseBillIsLive };

// ── Context ─────────────────────────────────────────────────────

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

// ── Money ───────────────────────────────────────────────────────

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

/** {@link projectPurchaseLineToBillLine}'s inputs beside the purchase line. */
export interface ProjectBillLineOptions {
  /** The new bill line's row identity, minted by the writer. */
  uid: string;
  /** The purchase the line is on. */
  uid_purchase: string;
  /** The units billed (the operator's input). */
  quantity: number;
}

/**
 * **Default a bill line from its purchase line** (D5). Name, formula, discount
 * terms, posting and attribution are the purchase line's (each then
 * overridable on the bill until it settles). The amount is `quantity` units at
 * the line's cumulative share from where its `quantity_billed` stands
 * ({@link flatShareCents}, extended past the ordered count because
 * over-billing is legal), so the bills of a line sum to its `amount_cents`; the
 * discount record is the same share of the purchase line's.
 *
 * The line's price is built by `flatPayablePrice` (the stated-total arm), so
 * the projection parses on its own; the writer prices the whole document with
 * `priceDocument`, which states the same money and the line's `taxes_base`.
 *
 * @throws PriceRefusalError on a time-priced purchase line — refused until
 *   one-document-model Phase 3 meters it from its pair's windows.
 */
export function projectPurchaseLineToBillLine(
  item: PurchaseItem,
  opts: ProjectBillLineOptions,
): PurchaseDocumentItem {
  const amount = item.amount_cents ?? 0;
  const before = item.quantity_billed ?? 0;
  const amount_cents = flatShareCents(amount, item.quantity, before, before + opts.quantity);
  const price: PurchaseDocumentLinePrice = flatPayablePrice({
    uid: opts.uid,
    quantity: opts.quantity,
    amount_cents,
    price_formula: item.price.price_formula,
    discount: item.price.discount
      ? { ...item.price.discount, amount_cents: flatDiscountShare(item.price.discount, opts.quantity, item.quantity) }
      : null,
    taxes: item.price.taxes,
    taxes_base: item.price.taxes_base,
    counts: true,
  });
  return {
    type: item.type,
    ...projectedLineHead(item, opts.uid),
    ...attributionOf(item),
    quantity: opts.quantity,
    amount_cents,
    price,
    // A flat line meters nothing: no units, no span (api-cloudrun#1425).
    units: [],
    dates: null,
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
 *
 * `quantity` is the units the bill line bills: the discount record is that
 * share of the purchase line's ({@link projectPurchaseLineToBillLine}'s rule),
 * so an untouched bill line compares equal to its projection and follows it,
 * and a followed discount lands as the bill's share rather than the whole.
 */
export function projectPurchaseLineForBill(item: PurchaseItem, quantity: number): Record<string, unknown> {
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
    price: {
      price_formula: item.price.price_formula,
      rates: item.price.rates,
      discount: item.price.discount
        ? { ...item.price.discount, amount_cents: flatDiscountShare(item.price.discount, quantity, item.quantity) }
        : null,
    },
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
  /** The tax inputs each touched bill is priced under, at its own date. */
  tax: Omit<PayablePriceDocumentContext["tax"], "asOf">;
}

/**
 * **The purchase → bill three-way sync** (D5, the `stageOrderInvoiceSync`
 * shape): every PUSHED, unsettled, live bill's lines follow the purchase lines
 * they project, field by field, wherever the bill still holds the PREVIOUS
 * purchase's value. Pure; the writer stores the `changed` bills in the purchase
 * writer's transaction.
 *
 * A changed bill is re-priced whole by `priceDocument` (its stated-total arm,
 * at the bill's own date), and its total is the Σ. A line's net amount is a
 * homonym and never follows (its share was fixed when billed); a followed
 * discount arrives as the bill line's share of it
 * ({@link projectPurchaseLineForBill}).
 *
 * Skipped whole: a linked bill (Xero is authoritative), a frozen one
 * (`purchaseBillIsFrozen`), a voided one.
 *
 * `total_cents` and `amount_due_cents` move together (an unfrozen bill has no
 * money settlement, so the identity holds with what is due); a writer that
 * also holds the settlement rows may refold with `recomputePurchaseBillTotals`.
 */
export function syncPurchaseToBills(args: SyncPurchaseToBillsArgs): PurchaseBillSync[] {
  const fields = purchaseBillSharedLineFields();
  const prevByPath = new Map(args.prev.items.map((i) => [i.path.join("/"), i]));
  const nextByPath = new Map(args.next.items.map((i) => [i.path.join("/"), i]));

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
        projectPurchaseLineForBill(prevItem, line.quantity) as unknown as PurchaseDocumentItem,
        projectPurchaseLineForBill(nextItem, line.quantity) as unknown as PurchaseDocumentItem,
        line,
      );
      overridden.push(...kept.map((f) => `items[${k}].${f}`));
      if (JSON.stringify(merged) !== JSON.stringify(line)) changed = true;
      return merged;
    });
    if (!changed) return { ...untouched, overridden };
    const priced = priceDocument(items, { document: { kind: "purchase_bill" }, tax: { ...args.tax, asOf: bill.date } });
    return {
      uid: bill.uid,
      bill: { ...bill, items: priced.items, totals: withTotal(bill.totals, priced.totals.total_cents) },
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
