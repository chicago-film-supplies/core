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
 * ## Pure
 *
 * The input items are not mutated. Items come back as copies with a new `price`
 * on every priced line; dividers are returned as they were.
 */
import type { InvoiceStatusType, OrderStatusType, TaxRefType } from "../schemas/mod.ts";
import {
  assembleLinePrice,
  calculateReplacementTotals,
  calculateTransactionFeeAmountCents,
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
  type Tax,
} from "./orders.ts";
import { billableDays } from "./dates.ts";
import { assignLineTaxes, type DocumentTaxContext, type UnreviewedTaxWarning } from "./taxes.ts";
import { pricingTaxesOf } from "./tax-classes.ts";

/**
 * Which document is being priced, and whether it may be.
 *
 * An invoice states its `status` and whether any settlement (payment or credit)
 * has been recorded against it. The refusal reads exactly what api-cloudrun's
 * `updateInvoice` gate reads — `invoiceHasSettlement || paid || void` — so the
 * two cannot disagree about what "settled" means.
 */
export type PriceDocumentKind =
  | { kind: "order"; status: OrderStatusType }
  | { kind: "invoice"; status: InvoiceStatusType; has_settlement: boolean };

/**
 * The charge windows of one destination pair, as the pricer reads them: stored
 * day counts only, so pricing never needs the holiday list.
 */
export interface PairChargeWindows {
  /**
   * The path of the pair's destination divider: `[pair.uid]` on an order,
   * `[uid_order, pair.uid]` on an invoice. A line belongs to the pair whose
   * divider path is a prefix of its own.
   */
  divider_path: readonly string[];
  /** Each window's stored `days`, in order. */
  days: readonly number[];
}

/** The pair shape {@link chargeWindowContext} reads. */
export interface ChargeWindowPair {
  uid?: string | null;
  /** Set on an invoice pair: the order the pair is scoped to. */
  uid_order?: string | null;
  dates: {
    charge_windows: readonly { days: number }[];
  };
}

/**
 * **Build {@link PriceDocumentContext.charge_windows}** from a document's stored
 * `destinations`. Reads stored window days only.
 *
 * @throws PriceRefusalError on a pair with no windows: its lines would have no
 *   days to bill.
 */
export function chargeWindowContext(destinations: readonly ChargeWindowPair[]): PairChargeWindows[] {
  const out: PairChargeWindows[] = [];
  for (const pair of destinations) {
    if (!pair.uid) continue;
    const windows = pair.dates?.charge_windows;
    if (!windows || windows.length === 0) {
      throw new PriceRefusalError(`Destination pair ${pair.uid} has no charge windows`);
    }
    out.push({
      divider_path: pair.uid_order ? [pair.uid_order, pair.uid] : [pair.uid],
      days: windows.map((w) => w.days),
    });
  }
  return out;
}

/**
 * A date-extension section (#680, D7): every line whose `path` starts with
 * `divider_path` bills the days the order's window grew past what was billed.
 *
 * The day count is the LINE's own `chargeable_days` — the ADDED days, computed
 * once by the writer that builds the section (owner, 2026-09-15) — priced with
 * the one-week floor skipped. The section supplies only the rule, never a count,
 * so a re-price reads nothing beyond the document. Derive the sections with
 * {@link invoiceExtensionSections}.
 */
/**
 * A pricer refusal caused by the document it was handed — a rental line under no
 * pair, a percent fee line of quantity ≠ 1, a line under two extension sections,
 * a bad credit request — rather than by a fault in the pricer. The API maps it
 * to a 400; every other throw from this module stays a 500.
 */
export class PriceRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceRefusalError";
  }
}

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
 * to pass it re-prices extension lines at the one-week floor.
 */
export function invoiceExtensionSections(
  items: readonly { type: string; path: readonly string[]; path_extension_for?: readonly string[] }[],
): PriceDocumentExtension[] {
  return items
    .filter((it) => it.type === "destination" && (it.path_extension_for?.length ?? 0) > 0)
    .map((it) => ({ divider_path: [...it.path] }));
}

/** The two day counts a D7 extension is priced from. */
export interface LineExtension {
  /** The ORDER's charge days for the destination being extended. */
  order_charge_days: number;
  /** The charge days already billed for it. */
  billed_charge_days: number;
}

/** Everything {@link priceDocument} reads besides the items. */
export interface PriceDocumentContext {
  document: PriceDocumentKind;
  /** The tax rule's context: destinations, organization, origin, catalog, as-of. */
  tax: DocumentTaxContext;
  /** Date-extension sections, if the document has any. */
  extensions?: readonly PriceDocumentExtension[];
  /**
   * Every destination pair's charge windows — build it with
   * {@link chargeWindowContext}. Required: a line's `chargeable_days` and a
   * multi-window line's price both come from here.
   */
  charge_windows: readonly PairChargeWindows[];
}

/** What {@link priceDocument} returns. */
export interface PricedDocument<T extends LineItem> {
  /** Copies of the input items, every priced line carrying its stored price. */
  items: T[];
  /** The six totals fields orders and invoices share, as a sum of `items`. */
  totals: DocumentTotalsCore;
  /**
   * An order's replacement cost, or `null` for an invoice. Order-only, like the
   * `replacement_total_cents` it fills.
   */
  replacement_total_cents: number | null;
  /** Rates that priced on a lapsed review. A dropped value makes the lapse invisible. */
  warnings: UnreviewedTaxWarning[];
}

/** Refuse a document whose money may not move (D3). */
function assertRepriceable(document: PriceDocumentKind): void {
  if (document.kind !== "invoice") return;
  if (document.status === "void") {
    throw new Error("Cannot price a void invoice: its money is retracted, not re-priced");
  }
  if (document.status === "paid" || document.has_settlement) {
    throw new Error(
      `Cannot price a settled invoice (status "${document.status}"): its money is agreed. ` +
        "Void it and issue a new one, or reverse the settlement first",
    );
  }
}

/**
 * **Stage 2 for one line: the line pricer.** `priceDocument` prices every line
 * through it, and so does the one reader that must price a line outside a
 * document — `accountLine` (`./quantityAccounting.ts`), which prices a
 * remainder and a billed row's extension (#997 D11).
 *
 * `extensionDays` is D7: the line is priced for that many days with the
 * one-week minimum skipped, which is what an extension section on an invoice
 * bills. A document line passes its own `chargeable_days`; `accountLine` passes
 * the days an extension group adds for a billed row.
 *
 * @throws Error on a line with no pricing rule, and on an extension of a line
 *   that is not `five_day_week` or carries a flat tax.
 */
export function priceLine(
  item: LineItem,
  taxes: Tax[],
  extensionDays?: number,
): LinePriceMoney {
  const opts: LinePricingOptions = {};
  if (extensionDays !== undefined) opts.extensionDays = extensionDays;
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
 * Is this a line whose days come from its pair's windows? A `rental` priced
 * `five_day_week`. Every other line (a `sale`, `service` or `surcharge` stored
 * as `five_day_week` included) has `chargeable_days: null` and prices at
 * factor 1.
 */
function daysFromWindows(item: LineItem): boolean {
  return item.type === "rental" && item.price?.formula === "five_day_week";
}

/**
 * Has this document been sent out or closed, so its lines keep the day counts
 * they carry? A `complete` or `canceled` order (charge-windows census decision,
 * 2026-09-16). A void, paid or settled invoice never reaches here: it is refused
 * outright.
 */
function keepsStoredDays(document: PriceDocumentKind): boolean {
  return document.kind === "order" && (document.status === "complete" || document.status === "canceled");
}

/**
 * **A line's `chargeable_days`, the one derivation of it** (charge-windows
 * decision 3), and the window days that price it.
 *
 * | line | `chargeable_days` |
 * |---|---|
 * | in an extension section | Σ its pair's window days (the days added) |
 * | on a `complete`/`canceled` order | its own stored days |
 * | `rental` + `five_day_week` on a one-window pair | that window's days |
 * | `rental` + `five_day_week` on a 2+ window pair | `billableDays(windows)` |
 * | `rental` + `five_day_week` on no pair | refused |
 * | anything else | `null` |
 *
 * A 2+ window pair stores its BILLABLE days, Σ `max(days, 5)`, so the line's
 * own numbers multiply out to its subtotal: `quantity × base × days ÷ 5` (owner,
 * 2026-09-17, core#114). A one window pair keeps its raw count; the pricer's
 * `max(days, 5)` floor is the same thing for one window.
 *
 * @throws Error on a rental `five_day_week` line that hangs under no pair.
 */
export function lineChargeableDays(
  item: LineItem,
  ctx: Pick<PriceDocumentContext, "document" | "charge_windows" | "extensions">,
): { chargeable_days: number | null } {
  const stored = item.price?.chargeable_days ?? null;
  if (extensionFor(item, ctx.extensions)) {
    // An extension pair's one window carries the days the section ADDS, never
    // recounted, so its lines bill that.
    const pair = pairOf(item, ctx.charge_windows);
    if (pair) return { chargeable_days: pair.days.reduce((total, d) => total + d, 0) };
    return { chargeable_days: stored };
  }
  if (keepsStoredDays(ctx.document)) return { chargeable_days: stored };
  if (!daysFromWindows(item)) return { chargeable_days: null };
  const pair = pairOf(item, ctx.charge_windows);
  if (!pair) {
    throw new PriceRefusalError(
      `Rental line ${item.uid} is not under a destination pair, so it has no charge windows to bill. ` +
        "Move it under a destination",
    );
  }
  return { chargeable_days: pair.days.length >= 2 ? billableDays(pair.days) : pair.days[0] };
}

/** The added days an extension line bills: its own `chargeable_days`, which it must state. */
function extensionDaysOf(item: LineItem): number {
  const days = item.price?.chargeable_days;
  if (typeof days !== "number") {
    throw new PriceRefusalError(`Line ${item.uid} sits in an extension section and states no chargeable_days to extend by`);
  }
  return days;
}

function extensionFor(
  item: LineItem,
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
 *   extension section holding a fixed-formula line or a flat tax (D7); and when
 *   assembled money fails its identities.
 */
export function priceDocument<T extends LineItem>(
  items: readonly T[],
  ctx: PriceDocumentContext,
): PricedDocument<T> {
  assertRepriceable(ctx.document);

  // Copies, so the stages below can write prices without touching the caller's items.
  const out: T[] = items.map((item) =>
    item.price ? { ...item, price: { ...item.price, taxes: [...(item.price.taxes ?? [])] } } : { ...item }
  );

  // ── Stage 1: tax refs and taxes_base ──
  // Every document resolves the rate live at its own `asOf` — the rate windows
  // (`applied_from` / `applied_to`) are what date a document's tax, so an issued
  // invoice or a completed order needs no stored-version freeze (owner,
  // 2026-09-15, superseding #997 decision (a)).
  const warnings = assignLineTaxes(out, ctx.tax);
  const pricing = pricingTaxesOf(ctx.tax.catalog);

  // ── Stages 2 + 3: per-line money, assembled ──
  for (const item of out) {
    if (!isPriceableItem(item)) continue;
    const extension = extensionFor(item, ctx.extensions);
    const derived = isPreTaxItem(item) ? lineChargeableDays(item, ctx) : { chargeable_days: null };
    if (isPreTaxItem(item)) item.price = { ...item.price, chargeable_days: derived.chargeable_days };
    const price = item.price;
    const money: LinePriceMoney = priceLine(item, pricing, extension && extensionDaysOf(item));
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
    if (!isTransactionFeeItem(item) || item.price.formula !== "percent_of_total") continue;
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
    items: out,
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
    base_cents: number;
    chargeable_days: number | null;
    formula: PriceObject["formula"];
    discount: { rate: number; type: "percent" | "flat" } | null;
    taxes: readonly { uid: string }[];
  };
}

/** One invoice line to credit, and how many of it. */
export interface CreditSelectionLine<L extends CreditSourceLine = CreditSourceLine> {
  line: L;
  quantity: number;
}

/** The stored price of one credit-note line: the invoice line's declared half plus money. */
export interface CreditLinePrice extends LinePriceMoney {
  base_cents: number;
  chargeable_days: number | null;
  formula: PriceObject["formula"];
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
 *   {@link assembleLinePrice} at the credited quantity. Nothing scales money by
 *   `credited ÷ billed`: that would be a float factor on cents.
 * - **Stage 1 is deliberately skipped.** The line keeps the tax refs STORED on
 *   the invoice line, so a credit is taxed at the rate that was charged. It never
 *   re-resolves jurisdiction, exemption or version. An exempt line carries
 *   `taxes: []` and credits untaxed. `taxes` must therefore be the WHOLE rate
 *   catalog, superseded versions included.
 * - **No D3 refusal.** Credit is raised on settled invoices as a matter of
 *   course; crediting prices a NEW document and moves no invoice money.
 * - **Totals are stage 5's sum** ({@link sumPricedLines}).
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
  for (const { line, quantity } of selection) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new PriceRefusalError(`Credit quantity for line ${line.uid} must be a positive integer, got ${quantity}`);
    }
    // A line in an extension section is credited as it was billed: at its own
    // added days with the week minimum skipped. Priced as an ordinary line it
    // would be floored to a week and credit more than the invoice charged.
    const extension = extensionFor({ uid: line.uid, path: [...line.path] } as LineItem, extensions);
    const item = {
      uid: line.uid,
      path: [line.uid],
      name: "",
      type: line.type,
      quantity,
      price: {
        base_cents: line.price.base_cents,
        chargeable_days: line.price.chargeable_days,
        formula: line.price.formula,
        discount: line.price.discount,
        taxes: [...line.price.taxes],
      },
    } as unknown as LineItem;
    if (!isPreTaxItem(item)) {
      throw new PriceRefusalError(`Line ${line.uid} has type "${line.type}", which cannot be credited — only a pre-tax line has a credit`);
    }
    const price = assembleLinePrice(
      { base_cents: line.price.base_cents, chargeable_days: line.price.chargeable_days, formula: line.price.formula },
      priceLine(item, taxes, extension && extensionDaysOf(item)),
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
