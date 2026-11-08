/**
 * # `priceDocument` — the one author of stored line money and document totals
 *
 * The priceDocument campaign (api-cloudrun#997) collapses every path that turns
 * price inputs into stored money — the deleted `materializeDocumentTax` reprice
 * and totals functions, order→invoice copies, credit-note money — into this one
 * function.
 *
 * ## The five stages, in this order
 *
 * 1. **Tax.** {@link assignLineTaxes} writes each pre-tax line's tax refs and
 *    `taxes_base` from the class resolver. It does not assume a line carries
 *    `uid_tax_class`: order lines are never bulk-stamped, because a stamp
 *    re-pushes Xero quotes.
 * 2. **Per line.** {@link computeLineMoney}, with the document-derived inputs
 *    (the extension no-minimum rule, D7).
 * 3. **Assembly.** {@link assembleLinePrice}, so its money identities and the
 *    fee normalization always run.
 * 4. **Fees.** Percent fee lines are costed against the basis
 *    (Σ pre-tax `subtotal_discounted` + Σ pre-tax tax) and the amount is STORED
 *    on the line (D6). Flat fees are unchanged: pre-discount subtotal plus a
 *    discount, as {@link priceTransactionFeeLine} has always stored them.
 * 5. **Totals.** A SUM of the stored line money. Nothing here re-prices a line
 *    to total it. The re-deriving form survives only as the audit oracle,
 *    `rederiveDocumentTotalsForAudit` (D2).
 *
 * ## An issued invoice keeps its tax versions
 *
 * Past draft, the rate each line already carries wins over today's version of
 * the same tax (#997 decision (a)). A draft invoice and an order price at their
 * as-of instant.
 *
 * ## It refuses a settled or void invoice (D3)
 *
 * A settled invoice's money is agreed; a void one's is retracted. Neither is
 * re-priced on any path, so the refusal is part of the input type rather than a
 * gate each caller has to remember.
 *
 * ## Both sides (api-cloudrun `one-document-model` Phase 2)
 *
 * The same five stages price a PAYABLE document — a purchase, a bill or a
 * supplier credit — given a {@link PayablePriceDocumentContext}. Two arms
 * differ, both read off the side rather than the collection:
 *
 * - **Tax.** The side's `SIDE_CONTRACTS` tax entry is `exempt`, so stage 1
 *   records each line's `taxes_base` and charges nothing, `replacement`
 *   included.
 * - **Line money: the stated-total arm** ({@link priceStatedTotalLine}). A
 *   payable line states its whole net cost in `amount_cents` — a buy's cost
 *   rarely divides by its quantity — so the money is that amount, with the
 *   declared discount on top as the gross. It is the twin of stage 4's fee arm:
 *   a declared amount stored as the line's money. A TIME-priced payable line is
 *   refused until Phase 3 gives purchases destination pairs to meter.
 *
 * ## Pure
 *
 * The input items are not mutated. Items come back as copies with a new `price`
 * on every priced line; dividers are returned as they were.
 */
import {
  type DiscountType,
  type InvoiceStatusType,
  type JurisdictionType,
  type OrderStatusType,
  type PriceFormulaRef,
  type PriceModifierType,
  type PurchaseDocumentRow,
  type PurchaseRow,
  SIDE_CONTRACTS,
  type TaxRefType,
  TERMINAL_ORDER_STATUSES,
} from "../schemas/mod.ts";
import {
  assembleLinePrice,
  calculateReplacementTotals,
  calculateTransactionFeeAmountCents,
  computeItemTaxAmountCents,
  computeLineMoney,
  type DocumentTotalsCore,
  getTransactionFeeTotals,
  isPreTaxItem,
  isPriceableItem,
  isTransactionFeeItem,
  type LineItem,
  type LinePriceMoney,
  type LinePricingOptions,
  type PriceModifier,
  type PriceObject,
  type StructuralItem,
  type Tax,
} from "./orders.ts";
import {
  meterUnits,
  type MeterRate,
  type PricingFormula,
  type PricingFormulas,
  priceFormulaRefOf,
  type RateSnapshot,
  type TierCount,
} from "./price-formulas.ts";
import { pairItemsAcrossRebuild, type PathedItem } from "./item-pairing.ts";
import { assignLineTaxes, type DocumentTaxContext, type UnreviewedTaxWarning } from "./taxes.ts";
import { pricingTaxesOf, type TaxCatalog } from "./tax-classes.ts";

/**
 * Which document is being priced, and whether it may be.
 *
 * An invoice states its `status` and `has_settlement`, which every caller
 * computes with `invoiceHasSettlement` (`utils/invoices.ts`) — money paid,
 * credited or voided, or a live closure. The refusal therefore reads exactly
 * what api-cloudrun's `updateInvoice` gate reads —
 * `invoiceHasSettlement || paid || void` — so the two cannot disagree about
 * what "settled" means. (An exported `hasSettlement` used to answer this with
 * `> 0` over two buckets; core#130 row 2 deleted it.)
 *
 * An order also states `stored_items`: the rows the order carries IN STORAGE,
 * before the edit being priced — `[]` for an order that does not exist yet. On
 * a `complete`/`canceled` order they decide which lines keep their own days
 * (see {@link lineChargeableDays}). ⚠️ **Required, with no default, because
 * both defaults are wrong:** "every line is carried" is api-cloudrun#1341 (a
 * line added to a finished order priced on whatever days the client sent), and
 * "no line is carried" re-derives every frozen line's money.
 *
 * 🔴 **A carried line's days are read off its STORED row, never off the row
 * being priced.** The order input schema strips `counts`, so on a PUT
 * every incoming row arrives with none. Reading the incoming row is how an
 * operator's quantity nudge on complete order 1013 nulled 25 lines' days and
 * repriced it from $4,952.91 to $2,667.17 at the one-week floor (2026-10-08).
 */
export type ReceivableDocumentKind =
  | { kind: "order"; status: OrderStatusType; stored_items: readonly StoredDaysRow[] }
  | { kind: "invoice"; status: InvoiceStatusType; has_settlement: boolean };

/**
 * A payable document. No arm carries a refusal: a payable line's money is its
 * stated `amount_cents`, so pricing reproduces it rather than moving it — a
 * LINKED document's amount is Xero's, stamped by the link writer, and prices to
 * exactly that. What may be EDITED on a settled bill is the freeze table's
 * question (`PURCHASE_BILL_FIELD_FREEZE`), asked by the writer.
 */
export type PayableDocumentKind =
  | { kind: "purchase" }
  | { kind: "purchase_bill" }
  | { kind: "purchase_credit" };

/** Every document `priceDocument` prices, on either side. */
export type PriceDocumentKind = ReceivableDocumentKind | PayableDocumentKind;

/** A stored order row as {@link carriedLines} reads it: its identity, and the counts it carries. */
export interface StoredDaysRow extends PathedItem {
  readonly price?: { readonly counts?: readonly TierCount[] | null } | null;
}

/**
 * The charge windows of one destination pair, as the pricer reads them.
 */
export interface PairChargeWindows {
  /**
   * The path of the pair's destination divider: `[pair.uid]` on an order,
   * `[uid_order, pair.uid]` on an invoice. A line belongs to the pair whose
   * divider path is a prefix of its own.
   */
  divider_path: readonly string[];
  /** The pair's windows, in order — instants only (ruling 8). */
  windows: readonly { start: string; end: string }[];
}

/** The pair shape {@link chargeWindowContext} reads. */
export interface ChargeWindowPair {
  uid?: string | null;
  /** Set on an invoice pair: the order the pair is scoped to. */
  uid_order?: string | null;
  dates: {
    /** `null` on a pair that bills no days (a document with no rental). */
    charge_windows: readonly { start: string; end: string }[] | null;
  };
}

/**
 * **Build {@link PriceDocumentContext.charge_windows}** from a document's stored
 * `destinations`.
 *
 * A pair whose windows are `null` bills no days (a document with no rental —
 * api-cloudrun#1154) and is simply absent from the context; a time-formula line
 * under it is refused where it is priced ({@link lineCounts}), which names the
 * line rather than the pair.
 *
 * @throws PriceRefusalError on a pair whose windows are an EMPTY array — never a
 *   stored shape (`.min(1)`), so a writer produced it by mistake.
 */
export function chargeWindowContext(destinations: readonly ChargeWindowPair[]): PairChargeWindows[] {
  for (const pair of destinations) {
    if (!pair.uid) continue;
    const windows = pair.dates?.charge_windows;
    if (windows != null && windows.length === 0) {
      throw new PriceRefusalError(`Destination pair ${pair.uid} states an empty charge_windows — null means none`);
    }
  }
  return statedChargeWindows(destinations);
}

/**
 * **The windows a document STATES** — the same traversal as
 * {@link chargeWindowContext} with the pricer's refusal left off, for a READER
 * rather than a writer (core#112).
 *
 * 🔴 **Use this one wherever a throw would be the wrong outcome**, which is every
 * comparator: `computeDocumentDiffs` documents itself as pure and never-throwing,
 * and raising a `PriceRefusalError` out of a diff view because one pair is
 * partial would take the whole page down to say nothing.
 */
export function statedChargeWindows(destinations: readonly ChargeWindowPair[]): PairChargeWindows[] {
  const out: PairChargeWindows[] = [];
  for (const pair of destinations) {
    if (!pair.uid) continue;
    const windows = pair.dates?.charge_windows;
    if (!windows || windows.length === 0) continue;
    out.push({
      divider_path: pair.uid_order ? [pair.uid_order, pair.uid] : [pair.uid],
      windows: windows.map((w) => ({ start: w.start, end: w.end })),
    });
  }
  return out;
}

/**
 * A pricer refusal caused by the document it was handed — a time-formula line
 * under no pair, a percent fee line of quantity ≠ 1, a line under two extension
 * sections, a formula the context does not carry, a bad credit request — rather
 * than by a fault in the pricer. The API maps it to a 400; every other throw
 * from this module stays a 500.
 */
export class PriceRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceRefusalError";
  }
}

/**
 * A date-extension section (#680, D7): every line whose `path` starts with
 * `divider_path` bills the days the order's window grew past what was billed.
 *
 * The count is the LINE's own `counts` — the ADDED days, stated once by the
 * writer that builds the section (owner, 2026-09-15) with the minimum skipped.
 * The section supplies only the rule, never a count, so a re-price reads
 * nothing beyond the document. Derive the sections with
 * {@link invoiceExtensionSections}.
 */
export interface PriceDocumentExtension {
  /** The path of the invoice destination divider that opens the section. */
  divider_path: readonly string[];
}

/**
 * The date-extension sections of an invoice's items: one per destination
 * divider carrying `path_extension_for`.
 *
 * The one derivation of {@link PriceDocumentContext.extensions}, shared by every
 * invoice writer and the manager's optimistic recompute — a caller that forgets
 * to pass it re-meters extension lines from their window, minimum included.
 */
export function invoiceExtensionSections(
  items: readonly { type: string; path: readonly string[]; path_extension_for?: readonly string[] }[],
): PriceDocumentExtension[] {
  return items
    .filter((it) => it.type === "destination" && (it.path_extension_for?.length ?? 0) > 0)
    .map((it) => ({ divider_path: [...it.path] }));
}

export { formulaUidsOf, type PricingFormula, type PricingFormulas, priceFormulaRefOf } from "./price-formulas.ts";

/** Everything {@link priceDocument} reads besides the items. */
export interface PriceDocumentContext {
  document: ReceivableDocumentKind;
  /** The tax rule's context: destinations, organization, origin, catalog, as-of. */
  tax: DocumentTaxContext;
  /** Date-extension sections, if the document has any. */
  extensions?: readonly PriceDocumentExtension[];
  /**
   * Every destination pair's charge windows — build it with
   * {@link chargeWindowContext}. Required: a time-formula line meters them.
   */
  charge_windows: readonly PairChargeWindows[];
  /** Every formula the lines name ({@link formulaUidsOf}). */
  formulas: PricingFormulas;
  /**
   * CFS holidays, read by a `business_day` meter. Required (ruling 8): a
   * window no longer stores a count, so metering one needs the list.
   */
  holidays: readonly string[];
}

/**
 * A row of a payable document: a purchase, bill or credit line, or one of its
 * dividers, which every stage passes over as an invoice's dividers are.
 */
export type PayableLine = PurchaseRow | PurchaseDocumentRow;

/**
 * How a payable document is priced. There is no destination, organization,
 * formula or window input: a payable line is taxed exempt at the store's origin
 * (`SIDE_CONTRACTS.payable.tax`) and states its own money.
 */
export interface PayablePriceDocumentContext {
  document: PayableDocumentKind;
  tax: {
    /** The store's jurisdiction — where an exempt line's `taxes_base` resolves. */
    origin: JurisdictionType;
    /** The tax catalog, as on the receivable side. */
    catalog: TaxCatalog;
    /** The document's own date. */
    asOf: string;
  };
}

/** What {@link priceDocument} returns. */
export interface PricedDocument<T> {
  /** Copies of the input items, every priced line carrying its stored price. */
  items: T[];
  /** The six totals fields orders and invoices share, as a sum of `items`. */
  totals: DocumentTotalsCore;
  /**
   * An order's replacement cost, or `null` for any other document. Order-only,
   * like the `replacement_total_cents` it fills.
   */
  replacement_total_cents: number | null;
  /** Rates that priced on a lapsed review. A dropped value makes the lapse invisible. */
  warnings: UnreviewedTaxWarning[];
}

/**
 * Why a document's money may NOT move, or `null` when it may (D3): a void
 * invoice is retracted, and a paid or settled one is agreed. The rule
 * `priceDocument` refuses on, exported so the manager reads it instead of
 * restating it (`invoiceIsRepriceable`). An order always reprices.
 */
export function invoiceRepriceRefusal(document: PriceDocumentKind): string | null {
  if (document.kind !== "invoice") return null;
  if (document.status === "void") return "Cannot price a void invoice: its money is retracted, not re-priced";
  if (document.status === "paid" || document.has_settlement) {
    return `Cannot price a settled invoice (status "${document.status}"): its money is agreed. ` +
      "Void it and issue a new one, or reverse the settlement first";
  }
  return null;
}

/** Refuse a document whose money may not move (D3). */
function assertRepriceable(document: PriceDocumentKind): void {
  const refusal = invoiceRepriceRefusal(document);
  if (refusal !== null) throw new Error(refusal);
}

/**
 * **Stage 2 for one line: the line pricer.** `priceDocument` prices every line
 * through it, and so does the one reader that must price a line outside a
 * document — `accountLine` (`./quantityAccounting.ts`), which prices a
 * remainder and a billed row's extension (#997 D11).
 *
 * The line must already carry its `counts` ({@link lineCounts}). `extension`
 * marks a line whose counts are the days an extension section ADDS, stated with
 * the minimum skipped — only a flat tax reads it, and is refused.
 *
 * @throws Error on a line with no pricing rule, and on an extension line that
 *   carries a flat tax.
 */
export function priceLine(
  item: LineItem,
  taxes: Tax[],
  extension = false,
): LinePriceMoney {
  const opts: LinePricingOptions = {};
  if (extension) opts.extension = true;
  return computeLineMoney(item, taxes, item.uid, opts);
}

/**
 * The pair a line hangs under: the entry whose `divider_path` is the longest
 * prefix of the line's `path`.
 */
function pairOf(item: { path: readonly string[] }, pairs: readonly PairChargeWindows[]): PairChargeWindows | undefined {
  let best: PairChargeWindows | undefined;
  for (const pair of pairs) {
    if (pair.divider_path.length > item.path.length) continue;
    if (!pair.divider_path.every((segment, i) => item.path[i] === segment)) continue;
    if (!best || pair.divider_path.length > best.divider_path.length) best = pair;
  }
  return best;
}

/**
 * **The lines that keep the counts they carry, and those counts**: on a
 * `complete` or `canceled` order (charge-windows census decision, 2026-09-16),
 * every line that pairs with a row of `stored_items`, mapped to THAT STORED
 * ROW's `counts` — never its own, which an API write has stripped (see
 * {@link PriceDocumentKind}). Empty on any other document. A void, paid or
 * settled invoice never reaches here: it is refused outright.
 *
 * The census decision protects counts the order ALREADY carried. A line the
 * edit adds has none to protect, so it meters its windows like any live line
 * (api-cloudrun#1341).
 *
 * ⚠️ **Paired with `pairItemsAcrossRebuild`, never by exact `path` and never by
 * `uid` alone.** A path changes when a line moves under another group or a
 * divider is re-minted; a uid repeats. The pairing's `(uid, k-th occurrence)`
 * fallback gives both: a moved row stays carried, an extra occurrence does not.
 */
export function carriedLines<T extends PathedItem>(
  items: readonly T[],
  document: PriceDocumentKind,
): ReadonlyMap<T, readonly TierCount[]> {
  if (document.kind !== "order" || !TERMINAL_ORDER_STATUSES.includes(document.status)) return new Map();
  const pairs = pairItemsAcrossRebuild(items, document.stored_items).forward;
  return new Map([...pairs].map(([item, stored]) => [item, stored.price?.counts ?? []]));
}

/** The formula a line names, from the context — refused by name when absent. */
function formulaOf(item: LineItem, formulas: PricingFormulas): PricingFormula {
  const uid = item.price?.price_formula?.uid;
  if (!uid) {
    throw new PriceRefusalError(`Line ${item.uid} names no price formula`);
  }
  const formula = formulas.get(uid);
  if (!formula) {
    throw new PriceRefusalError(`Line ${item.uid} names price formula ${uid}, which the pricing context does not carry`);
  }
  return formula;
}

/**
 * **What a line's formula meters from its pair's windows** — `null` when the
 * line hangs under no pair with windows. A flat formula meters no time and
 * answers `[{ flat, 1, 1 }]` wherever the line sits.
 *
 * ⚠️ **It knows nothing about extension sections or carried lines**, which keep
 * counts they STATE. {@link lineCounts} owns that; this is the window half,
 * split out so the invoice sync comparator can ask the same question
 * (core#112).
 */
export function meteredLineCounts(
  item: LineItem,
  ctx: Pick<PriceDocumentContext, "charge_windows" | "formulas" | "holidays">,
): TierCount[] | null {
  const formula = formulaOf(item, ctx.formulas);
  if (formula.meter.source === "none") {
    return meterUnits(formula, { windows: [], holidays: ctx.holidays }).tiers;
  }
  const pair = pairOf(item, ctx.charge_windows);
  if (!pair) return null;
  const envelope = { start: pair.windows[0].start, end: pair.windows[pair.windows.length - 1].end };
  return meterUnits(formula, {
    windows: pair.windows,
    span: envelope,
    holidays: ctx.holidays,
    rates: item.price?.rates,
  }).tiers;
}

/**
 * **A line's `counts`, the one derivation of them** (ruling 8).
 *
 * | line | `counts` |
 * |---|---|
 * | percent-of-total fee (no formula) | `[]` |
 * | in an extension section | its OWN stated counts — the days the section adds |
 * | in `carried` (a line a `complete`/`canceled` order already had) | its STORED row's counts |
 * | on a flat formula | `[{ flat, 1, 1 }]` |
 * | on a time formula under a pair with windows | what the formula meters from them |
 * | on a time formula under no such pair | refused |
 *
 * Five-day week's per-window minimum is the formula's own (`minimum.scope:
 * "window"`), so a 2+ window line stores Σ `max(days, 5)` business days ÷ 5 and
 * its own numbers multiply out to its subtotal.
 *
 * @throws PriceRefusalError on a time-formula line under no pair, an extension
 *   line that states no counts, and a formula the context does not carry.
 */
export function lineCounts(
  item: LineItem,
  ctx: Pick<PriceDocumentContext, "charge_windows" | "extensions" | "formulas" | "holidays">,
  carried: ReadonlyMap<LineItem, readonly TierCount[]>,
): TierCount[] {
  if (item.price?.price_formula == null) return [];
  if (extensionFor(item, ctx.extensions)) {
    const stated = item.price.counts ?? [];
    if (stated.length === 0) {
      throw new PriceRefusalError(`Line ${item.uid} sits in an extension section and states no counts to extend by`);
    }
    return [...stated];
  }
  if (carried.has(item)) return [...(carried.get(item) ?? [])];
  const counts = meteredLineCounts(item, ctx);
  if (counts === null) {
    throw new PriceRefusalError(
      `Line ${item.uid} is on a time formula but under no destination pair with charge windows, so it has no time to bill. ` +
        "Move it under a destination, or give its pair charge dates",
    );
  }
  return counts;
}

/**
 * **The counts to SEED on a line about to land under one destination divider**
 * (core#130 row 5) — the same rule {@link meteredLineCounts} prices with, for a
 * client building a line before the pricer has run. Joins the pair by the
 * divider's own `path`, exactly as the pricer does.
 *
 * @returns `null` when that pair states no windows or the divider is unknown
 *   (a flat formula still answers).
 */
export function seedLineCounts(
  items: readonly StructuralItem[],
  destinations: readonly ChargeWindowPair[],
  dividerUid: string,
  formula: PricingFormula,
  holidays: readonly string[],
  rates?: readonly MeterRate[] | null,
): TierCount[] | null {
  if (formula.meter.source === "none") return meterUnits(formula, { windows: [], holidays }).tiers;
  const divider = items.find((it) => it.uid === dividerUid && it.type === "destination");
  if (!divider?.path) return null;
  const path = divider.path;
  const pair = statedChargeWindows(destinations).find((p) =>
    p.divider_path.length === path.length && p.divider_path.every((segment, i) => path[i] === segment)
  );
  if (!pair) return null;
  const envelope = { start: pair.windows[0].start, end: pair.windows[pair.windows.length - 1].end };
  return meterUnits(formula, { windows: pair.windows, span: envelope, holidays, rates }).tiers;
}

/**
 * One line that breaks the charge-window pair invariant (core#113).
 *
 * `stored` is what the line carries; `expected` is what its formula meters from
 * the pair's windows. Both are stated so a report can show the difference
 * without re-deriving either.
 */
export interface ChargeWindowPairViolation {
  /** The offending line's `uid`. ⚠️ NOT a row identity — `path` is. */
  item_uid: string;
  /** The line's `path`, which IS its row identity within this document. */
  path: readonly string[];
  /** The divider path of the pair whose windows the line should meter. */
  divider_path: readonly string[];
  /** The line's stored `price.counts`. */
  stored: readonly TierCount[];
  /** What the line's formula meters from the pair's windows. */
  expected: readonly TierCount[];
}

/**
 * Does this document keep the line counts it already carries, rather than
 * re-metering them from its windows?
 *
 * ⚠️ **Deliberately WIDER than the pricer's own {@link carriedLines}, and it must
 * not be merged with it.** The pricer only ever sees orders in this state,
 * because {@link assertRepriceable} refuses a frozen invoice first. A WRITE is
 * the other case: a void, paid or settled invoice is still written
 * (`updateInvoice` admits non-money edits on one), and it carries its stored
 * counts through by design (charge-windows decision 10).
 */
function keepsStoredLineDays(document: ReceivableDocumentKind): boolean {
  if (document.kind === "order") return TERMINAL_ORDER_STATUSES.includes(document.status);
  return document.status === "void" || document.status === "paid" || document.has_settlement;
}

/** Two count lists name the same tiers with the same exact values. */
function sameCounts(a: readonly TierCount[], b: readonly TierCount[]): boolean {
  return a.length === b.length &&
    a.every((t, i) => t.rate_key === b[i].rate_key && t.num * b[i].den === b[i].num * t.den);
}

/**
 * **The charge-window pair invariant, checked (core#113):** in a pair holding
 * two or more charge windows, every time-formula line outside an extension
 * section stores the counts its formula meters from those windows.
 *
 * It holds **by construction**: {@link lineCounts} is the one author of a
 * line's counts and every order/invoice writer prices through
 * {@link priceDocument}. This exists for the writers that do not — a `scripts/`
 * repair, a direct Firestore write — and is called from api-cloudrun's
 * `assertValidForWrite`, so a divergent document is refused at the write.
 *
 * ⚠️ **Returns violations rather than throwing** — the write path turns one into
 * a 400, the audit script reports every row.
 *
 * ⚠️ **Single-window pairs are NOT checked**: a one-window line whose counts
 * differ from its window is legacy CRMS divergence the 2026-09-16 census left
 * alone on purpose, carried into `counts` by the ruling-8 backfill.
 */
export function chargeWindowPairViolations(
  items: readonly LineItem[],
  ctx: Pick<PriceDocumentContext, "document" | "charge_windows" | "extensions" | "formulas" | "holidays">,
): ChargeWindowPairViolation[] {
  if (keepsStoredLineDays(ctx.document)) return [];
  const out: ChargeWindowPairViolation[] = [];
  for (const item of items) {
    if (!isPriceableItem(item) || item.price.price_formula?.basis !== "time") continue;
    // An extension line bills the days its section ADDS, not its pair's total.
    if (extensionFor(item, ctx.extensions)) continue;
    const pair = pairOf(item, ctx.charge_windows);
    // A time line with no pair at all is `lineCounts`' refusal to make.
    if (!pair || pair.windows.length < 2) continue;
    const expected = meteredLineCounts(item, ctx) ?? [];
    const stored = item.price.counts ?? [];
    if (sameCounts(stored, expected)) continue;
    out.push({ item_uid: item.uid, path: item.path, divider_path: pair.divider_path, stored, expected });
  }
  return out;
}

function extensionFor(
  item: { uid: string; path: readonly string[] },
  extensions: readonly PriceDocumentExtension[] | undefined,
): PriceDocumentExtension | undefined {
  if (!extensions?.length) return undefined;
  const match = extensions.filter((ext) =>
    ext.divider_path.length <= item.path.length &&
    ext.divider_path.every((segment, i) => item.path[i] === segment)
  );
  if (match.length === 0) return undefined;
  if (match.length > 1) {
    throw new PriceRefusalError(`Line ${item.uid} falls under ${match.length} extension sections; a line extends one window`);
  }
  return match[0];
}

/** The line surface {@link priceStatedTotalLine} reads. */
export interface StatedTotalLine {
  uid: string;
  quantity: number;
  amount_cents: number | null;
  price: {
    price_formula: { basis: string; name: string };
    discount: DiscountType | null;
    taxes: readonly PriceModifierType[];
  };
}

/**
 * **The stated-total arm: a payable line's money is its stated amount.**
 *
 * - `subtotal_discounted_cents` = `amount_cents`, the net CFS pays;
 * - `subtotal_cents` = net + `discount.amount_cents` — the operator's gross, the
 *   discount being DECLARED on a payable line (what came off), not derived;
 * - `taxes` re-amounted on the net from each tax's own rate and type
 *   (`computeItemTaxAmountCents`, the one tax-amount author) — `[]` on an exempt
 *   side;
 * - `total_cents` = net + Σ taxes.
 *
 * The twin of stage 4's fee arm: a declared amount stored as the line's money,
 * not re-derived from rates. Exported for the projectors that default a bill
 * or credit line from its purchase line before the writer prices the document.
 *
 * @throws PriceRefusalError on a time-priced line (refused until
 *   one-document-model Phase 3 meters it from its pair's windows) and on a line
 *   that states no amount.
 */
export function priceStatedTotalLine(line: StatedTotalLine): LinePriceMoney {
  if (line.price.price_formula.basis !== "flat") {
    throw new PriceRefusalError(
      `Line ${line.uid} is priced "${line.price.price_formula.name}", by time; a payable line is priced flat until ` +
        "it can meter its destination pair's windows (one-document-model Phase 3)",
    );
  }
  const amount = line.amount_cents;
  if (amount === null) throw new PriceRefusalError(`Line ${line.uid} states no amount`);
  const discount = line.price.discount === null ? null : { ...line.price.discount };
  const taxes = line.price.taxes.map((t) => ({
    uid: t.uid,
    name: t.name,
    rate: t.rate,
    type: t.type,
    amount_cents: computeItemTaxAmountCents(t, amount, line.quantity),
  }));
  let taxSum = 0;
  for (const t of taxes) taxSum += t.amount_cents;
  return {
    subtotal_cents: amount + (discount?.amount_cents ?? 0),
    subtotal_discounted_cents: amount,
    discount,
    taxes,
    total_cents: amount + taxSum,
  };
}

/**
 * **A payable line's declared price, with its stated-total money added** —
 * {@link priceStatedTotalLine}'s three money keys spread onto the declared
 * half, and its `taxes` re-amounted on the net. For a writer BUILDING a line
 * (a projector, a charge line, a credit line) so that the line parses before
 * the document is priced; the writer still runs `priceDocument` over the whole
 * document, which states the same money and the line's `taxes_base`.
 *
 * @throws PriceRefusalError as {@link priceStatedTotalLine} does.
 */
export function withStatedTotalMoney<P extends StatedTotalLine["price"]>(
  declared: P,
  line: Omit<StatedTotalLine, "price">,
): P & { taxes: PriceModifierType[]; subtotal_cents: number; subtotal_discounted_cents: number; total_cents: number } {
  const money = priceStatedTotalLine({ ...line, price: declared });
  return {
    ...declared,
    taxes: money.taxes,
    subtotal_cents: money.subtotal_cents,
    subtotal_discounted_cents: money.subtotal_discounted_cents,
    total_cents: money.total_cents,
  };
}

/**
 * **The one builder of a FLAT payable line's price** — the declared half
 * (`price_formula`, `rates: []`, the discount record, the tax modifiers, and
 * `counts: []` on a bill or credit line) plus the stated-total money
 * ({@link withStatedTotalMoney}). Every payable line builder calls it: the
 * purchase-line writer, the bill-line projector, a bill's charge line, a credit
 * line. A hand-spelled declared literal per builder is how a key gets dropped
 * from one of them (`ORDER_DECLARED_PRICE_KEYS`' docblock, api-cloudrun#984).
 *
 * @throws PriceRefusalError on a time formula (refused until one-document-model
 *   Phase 3).
 */
export function flatPayablePrice<C extends boolean>(args: {
  uid: string;
  quantity: number;
  amount_cents: number;
  price_formula: PriceFormulaRef;
  discount: DiscountType | null;
  /** The purchase line's tax modifiers, re-amounted on the net — `[]` on the exempt side. */
  taxes?: readonly PriceModifierType[];
  /** The class's pre-exemption rates, carried as the source line states them. */
  taxes_base?: readonly TaxRefType[];
  /** `true` on a bill or credit line, which carries `counts: []`; a purchase line has no `counts` key. */
  counts: C;
}): FlatPayablePrice & (C extends true ? { counts: never[] } : unknown) {
  const declared = {
    price_formula: { ...args.price_formula },
    rates: [] as never[],
    discount: args.discount === null ? null : { ...args.discount },
    taxes: (args.taxes ?? []).map((t) => ({ ...t })),
    ...(args.taxes_base !== undefined ? { taxes_base: args.taxes_base.map((t) => ({ ...t })) } : {}),
    ...(args.counts ? { counts: [] as never[] } : {}),
  };
  return withStatedTotalMoney(declared, { uid: args.uid, quantity: args.quantity, amount_cents: args.amount_cents }) as
    & FlatPayablePrice
    & (C extends true ? { counts: never[] } : unknown);
}

/** What {@link flatPayablePrice} returns: a flat payable line price, money stated. */
export interface FlatPayablePrice {
  price_formula: PriceFormulaRef;
  rates: never[];
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  taxes_base?: TaxRefType[];
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  total_cents: number;
}

/** The tax context a payable document prices under — the side's rule, no destinations. */
function payableTaxContext(tax: PayablePriceDocumentContext["tax"]): DocumentTaxContext {
  return {
    destinations: [],
    origin: tax.origin,
    exempt: SIDE_CONTRACTS.payable.tax === "exempt",
    catalog: tax.catalog,
    asOf: tax.asOf,
    side: "payable",
  };
}

function isPayableContext(
  ctx: PriceDocumentContext | PayablePriceDocumentContext,
): ctx is PayablePriceDocumentContext {
  return ctx.document.kind === "purchase" || ctx.document.kind === "purchase_bill" ||
    ctx.document.kind === "purchase_credit";
}

/** Split a stored price into its declared half (everything that is not money or `taxes_base`). */
function declaredHalf(price: PriceObject): Record<string, unknown> {
  const {
    subtotal_cents: _s,
    subtotal_discounted_cents: _sd,
    discount: _d,
    taxes: _t,
    total_cents: _tt,
    taxes_base: _tb,
    ...declared
  } = price as PriceObject & { taxes_base?: unknown };
  return declared;
}

/**
 * Price a document: taxes, line money, fee amounts and totals, in one pass.
 *
 * @throws Error on a settled or void invoice (D3); on a line whose type has no
 *   pricing rule; on a percent fee line whose quantity is not 1 (D6); on an
 *   extension line carrying a flat tax (D7); and when assembled money fails its
 *   identities. PriceRefusalError on a line whose counts cannot be derived
 *   ({@link lineCounts}).
 */
export function priceDocument<T extends LineItem>(items: readonly T[], ctx: PriceDocumentContext): PricedDocument<T>;
export function priceDocument<T extends PayableLine>(
  items: readonly T[],
  ctx: PayablePriceDocumentContext,
): PricedDocument<T>;
export function priceDocument<T extends LineItem | PayableLine>(
  input: readonly T[],
  ctx: PriceDocumentContext | PayablePriceDocumentContext,
): PricedDocument<T> {
  const payable = isPayableContext(ctx);
  if (!payable) assertRepriceable(ctx.document);
  // A payable line enters the shared stages as a line item: it carries the
  // `type`, `quantity`, `price` and tax-class keys they read, and its price the
  // same money keys once priced. The cast is on the way IN; the return is `T`.
  const items = input as unknown as readonly LineItem[];

  // Copies, so the stages below can write prices without touching the caller's items.
  const out: LineItem[] = items.map((item) =>
    item.price ? { ...item, price: { ...item.price, taxes: [...(item.price.taxes ?? [])] } } : { ...item }
  );

  // ── Stage 1: tax refs and taxes_base ──
  // Every document resolves the rate live at its own `asOf` — the rate windows
  // (`applied_from` / `applied_to`) are what date a document's tax, so an issued
  // invoice or a completed order needs no stored-version freeze (owner,
  // 2026-09-15, superseding #997 decision (a)).
  const warnings = assignLineTaxes(out, payable ? payableTaxContext(ctx.tax) : ctx.tax);
  const pricing = pricingTaxesOf(ctx.tax.catalog);

  // ── Stages 2 + 3: per-line counts and money, assembled ──
  // Each line's `counts` are metered here from its pair's windows through its
  // own formula (ruling 8), and its `price_formula` snapshot is re-stamped from
  // the formula document — the formula is immutable once referenced, so this
  // only ever fills `name`/`basis` on a line a writer built from a uid.
  const carried = payable ? new Map() : carriedLines(out, ctx.document);
  for (const item of out) {
    if (!isPriceableItem(item)) continue;
    if (payable) {
      // The stated-total arm: no formula to re-stamp and no windows to meter —
      // the line's declared amount is its money.
      const price = item.price;
      const money = priceStatedTotalLine(item as unknown as StatedTotalLine);
      const taxesBase = (price as { taxes_base?: TaxRefType[] }).taxes_base;
      item.price = assembleLinePrice(
        declaredHalf(price),
        money,
        item,
        taxesBase === undefined ? undefined : { taxesBase },
      ) as unknown as PriceObject;
      continue;
    }
    const extension = extensionFor(item, ctx.extensions);
    const formulaRef = item.price.price_formula == null ? null : priceFormulaRefOf(formulaOf(item, ctx.formulas));
    item.price = { ...item.price, price_formula: formulaRef, counts: lineCounts(item, ctx, carried) };
    const price = item.price;
    const money: LinePriceMoney = priceLine(item, pricing, extension !== undefined);
    // ⚠️ Stage 1 has ALREADY written `taxes_base` on every pre-tax line, so it is
    // always present here, as the deleted `materializeDocumentTax` also left it.
    // That widens the key set of a stored line that never carried it (measured
    // on 3 live prod invoices, api-cloudrun#997 step 3). A fee line's key is
    // untouched by stage 1, so presence there still reflects what was stored.
    const taxesBase = (price as { taxes_base?: TaxRefType[] }).taxes_base;
    item.price = assembleLinePrice(
      declaredHalf(price),
      money,
      item,
      taxesBase === undefined ? undefined : { taxesBase },
    ) as unknown as PriceObject;
  }

  // ── Stage 4: percent fee lines store their costed amount ──
  // The basis is stage 5's own sum over the pre-tax lines just priced; a fee
  // line is not pre-tax, so its stale stored amount cannot feed its own basis.
  const basis = sumPricedLines(out);
  const feeBasisCents = basis.subtotal_discounted_cents + basis.taxes.reduce((sum, tax) => sum + tax.amount_cents, 0);
  for (const item of out) {
    if (!isTransactionFeeItem(item) || item.price.base_percent == null) continue;
    if (item.quantity !== 1) {
      // Xero's UnitAmount is amount ÷ quantity, so a percent fee at any other
      // quantity would push a different unit price than the one CFS stored.
      throw new PriceRefusalError(`Percent fee line ${item.uid} has quantity ${item.quantity}; a percent fee line is quantity 1`);
    }
    const amountCents = calculateTransactionFeeAmountCents(item, feeBasisCents);
    item.price = {
      ...item.price,
      subtotal_cents: amountCents,
      subtotal_discounted_cents: amountCents,
      discount: null,
      taxes: [],
      total_cents: amountCents,
    };
  }

  // ── Stage 5: totals are a sum of what is stored ──
  return {
    items: out as unknown as T[],
    totals: sumPricedLines(out),
    replacement_total_cents: ctx.document.kind === "order"
      ? calculateReplacementTotals(out, pricing).total_cents
      : null,
    warnings,
  };
}

/** The invoice-line surface a credit is priced from (api-cloudrun#997 D4). */
export interface CreditSourceLine {
  uid: string;
  /** The line's path on the invoice — what places it in a date-extension section. */
  path: readonly string[];
  type: LineItem["type"];
  quantity: number;
  price: {
    price_formula: PriceFormulaRef | null;
    rates: readonly RateSnapshot[];
    counts: readonly TierCount[];
    discount: { rate: number; type: "percent" | "flat" } | null;
    taxes: readonly { uid: string }[];
  };
}

/** One invoice line to credit, and how many of it. */
export interface CreditSelectionLine<L extends CreditSourceLine = CreditSourceLine> {
  line: L;
  quantity: number;
  /**
   * Credit TIME rather than whole units: a charge window the order SHORTENED
   * after this line was billed (api-cloudrun#1028 phase 1c) — the magnitude of
   * the over-billing offer's `extension_counts` (`buildOverbillingCredits`).
   *
   * 🔴 **A difference of METERED counts, never a count of calendar days.** Both
   * sides were metered through the line's formula with its minimum (Five-day
   * week floors EACH window at five), so a window that shrank from 7 calendar
   * days to 6 credits nothing at all. The credit is priced at these counts
   * directly — pricing it as an ordinary line of N days would floor to a week
   * and credit more than was billed.
   *
   * ⚠️ Refused on a flat-formula line: it never read its time, so there is no
   * time of it to give back.
   */
  credited_counts?: readonly TierCount[];
}

/** The stored price of one credit-note line: the invoice line's declared half plus money. */
export interface CreditLinePrice extends LinePriceMoney {
  price_formula: PriceFormulaRef | null;
  rates: RateSnapshot[];
  counts: TierCount[];
}

/** What {@link priceCreditNote} returns. */
export interface PricedCreditNote {
  /** One price per selection entry, in selection order. */
  prices: CreditLinePrice[];
  /** A credit note's totals: a sum of `prices`. A credit note has no fee rows. */
  totals: Omit<DocumentTotalsCore, "transaction_fees">;
}

/**
 * **Price a credit note from the invoice lines it credits** (api-cloudrun#997 D4).
 * The server stores this result, and the manager renders it as a preview.
 *
 * - **Stages 2 + 3 only.** Each line goes through {@link priceLine} and
 *   {@link assembleLinePrice} at the credited quantity, on the invoice line's own
 *   rates and counts. Nothing scales money by `credited ÷ billed`: that would be
 *   a float factor on cents.
 * - **Stage 1 is deliberately skipped.** The line keeps the tax refs STORED on
 *   the invoice line, so a credit is taxed at the rate that was charged.
 * - **No D3 refusal.** Credit is raised on settled invoices as a matter of
 *   course; crediting prices a NEW document and moves no invoice money.
 * - **Totals are stage 5's sum** ({@link sumPricedLines}).
 * - **A line may credit TIME instead of whole units** —
 *   {@link CreditSelectionLine.credited_counts}: the line is priced at those
 *   counts, minimum already out of them.
 *
 * ⚠️ **The credit composes to within a rounding of re-charging the difference,
 * and that is the SHIPPED property rather than a defect.** Both round once,
 * they just round different products. Measured worst 1¢ over the sweep in
 * `tests/price-document.test.ts`. 🔴 **Do not "fix" it by pricing the credit as a
 * difference of two charges.**
 *
 * @throws Error on a line that is not a pre-tax line (a divider or a fee has no
 *   credit), on a quantity that is not a positive integer, and when assembled
 *   money fails its identities.
 */
export function priceCreditNote(
  selection: readonly CreditSelectionLine[],
  taxes: Tax[],
  extensions: readonly PriceDocumentExtension[],
): PricedCreditNote {
  const prices: CreditLinePrice[] = [];
  const priced: LineItem[] = [];
  for (const { line, quantity, credited_counts } of selection) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new PriceRefusalError(`Credit quantity for line ${line.uid} must be a positive integer, got ${quantity}`);
    }
    // A line in an extension section is credited as it was billed: at its own
    // stated added days, minimum skipped.
    const extension = extensionFor({ uid: line.uid, path: line.path }, extensions);
    const source = {
      uid: line.uid,
      path: [line.uid],
      name: "",
      type: line.type,
      quantity,
      price: {
        price_formula: line.price.price_formula,
        rates: [...line.price.rates],
        counts: [...line.price.counts],
        discount: line.price.discount,
        taxes: [...line.price.taxes],
      },
    } as unknown as LineItem;
    if (!isPreTaxItem(source)) {
      throw new PriceRefusalError(`Line ${line.uid} has type "${line.type}", which cannot be credited — only a pre-tax line has a credit`);
    }
    let counts = [...line.price.counts];
    if (credited_counts !== undefined) {
      if (line.price.price_formula?.basis !== "time") {
        throw new PriceRefusalError(
          `Line ${line.uid} is priced "${line.price.price_formula?.name ?? "from the document"}", which never read its time — there is no time of it to credit`,
        );
      }
      const keys = new Set(line.price.rates.map((r) => r.rate_key));
      if (
        credited_counts.length === 0 || credited_counts.some((t) => !keys.has(t.rate_key) || t.den < 1) ||
        credited_counts.every((t) => t.num <= 0)
      ) {
        throw new PriceRefusalError(
          `Credited counts for line ${line.uid} must name the line's own rate keys and credit a positive amount of time`,
        );
      }
      // ⚠️ The DECLARED counts are what the stored line credited, so a time
      // credit carries the credited counts rather than the invoice line's own.
      counts = credited_counts.map((t) => ({ ...t }));
    }
    const item = { ...source, price: { ...source.price, counts } } as unknown as LineItem;
    const price = assembleLinePrice(
      { price_formula: line.price.price_formula, rates: [...line.price.rates], counts },
      priceLine(item, taxes, credited_counts !== undefined || extension !== undefined),
      item,
    ) as CreditLinePrice;
    prices.push(price);
    priced.push({ ...item, price } as unknown as LineItem);
  }
  const { transaction_fees: _fees, ...totals } = sumPricedLines(priced);
  return { prices, totals };
}

/**
 * **Stage 5 on its own: a document's totals as the SUM of its stored line
 * money.** Nothing is re-priced.
 *
 * `priceDocument` calls it after pricing. It is exported for the reader that
 * must total a document without pricing it — the manager when no tax catalog is
 * loaded, where the contract is "fold the stored lines, never re-price".
 *
 * - `subtotal_cents`, `subtotal_discounted_cents` and the discount are summed
 *   over PRE-TAX lines only, as the totals always have been.
 * - `taxes` aggregates each pre-tax line's stored taxes by NAME, in first-seen
 *   order, dropping zero amounts.
 * - `transaction_fees` aggregates fee lines' stored `total_cents`.
 * - `total_cents` = `subtotal_discounted` + Σ tax + Σ fees.
 *
 * ⚠️ A percent fee line stored before D6 carries `total_cents: 0`, so a document
 * not yet re-priced by `priceDocument` folds with no fee. Re-pricing it stores
 * the amount (api-cloudrun#997 step 7 re-prices the two live ones).
 */
export function sumPricedLines(items: readonly LineItem[]): DocumentTotalsCore {
  let subtotalCents = 0;
  let subtotalDiscountedCents = 0;
  const taxTotals = new Map<string, PriceModifier>();
  for (const item of items) {
    if (!isPreTaxItem(item)) continue;
    subtotalCents += item.price.subtotal_cents;
    subtotalDiscountedCents += item.price.subtotal_discounted_cents;
    for (const tax of item.price.taxes) {
      if (tax.amount_cents === 0) continue;
      const entry = taxTotals.get(tax.name);
      if (entry) entry.amount_cents += tax.amount_cents;
      else taxTotals.set(tax.name, { uid: tax.uid, name: tax.name, rate: tax.rate, type: tax.type, amount_cents: tax.amount_cents });
    }
  }
  const taxes = [...taxTotals.values()];
  let taxSumCents = 0;
  for (const tax of taxes) taxSumCents += tax.amount_cents;

  const transaction_fees = getTransactionFeeTotals([...items]);
  let feeSumCents = 0;
  for (const fee of transaction_fees) feeSumCents += fee.amount_cents;

  return {
    discount_amount_cents: subtotalCents - subtotalDiscountedCents,
    subtotal_cents: subtotalCents,
    subtotal_discounted_cents: subtotalDiscountedCents,
    taxes,
    transaction_fees,
    total_cents: subtotalDiscountedCents + taxSumCents + feeSumCents,
  };
}
