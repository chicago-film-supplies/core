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
import type { InvoiceStatusType, TaxRefType } from "../schemas/mod.ts";
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
} from "./orders.ts";
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
  | { kind: "order" }
  | { kind: "invoice"; status: InvoiceStatusType; has_settlement: boolean };

/**
 * A date-extension section (#680, D7): every line whose `path` starts with
 * `divider_path` bills the days the order's window grew past what was billed.
 */
export interface PriceDocumentExtension {
  /** The path of the invoice destination divider that opens the section. */
  divider_path: readonly string[];
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

/**
 * The extension day count for D7: `max(order, 5) − max(billed, 5)`.
 *
 * Both sides floor at the one-week minimum, because each window was (or would
 * be) charged at least a week. The difference is therefore what the extension
 * adds on top, and it can be negative when the order's window shrank.
 */
export function extensionChargeDays(orderChargeDays: number, billedChargeDays: number): number {
  return Math.max(orderChargeDays, 5) - Math.max(billedChargeDays, 5);
}

/**
 * The rate versions an issued invoice already carries (#997 decision (a)).
 *
 * A draft has agreed nothing, so it prices at its date. Anything past draft was
 * sent to a customer at the rates on its lines, so a re-price must keep them:
 * each line's `taxes_base` names the rate it was taxed on (it survives an
 * exemption, where `taxes` is `[]`), and `taxes` covers a line stored before
 * `taxes_base` existed. The resolver reads only the rate uids, and a frozen rate
 * wins over the live version of the same code.
 *
 * Returns `undefined` for an order or a draft invoice, which is "not frozen".
 */
function frozenRateVersions(
  items: readonly LineItem[],
  document: PriceDocumentKind,
): ReadonlyMap<string, string> | undefined {
  if (document.kind !== "invoice" || document.status === "draft") return undefined;
  const frozen = new Map<string, string>();
  for (const item of items) {
    const price = item.price as { taxes_base?: readonly { uid: string }[]; taxes?: readonly { uid: string }[] } | undefined;
    for (const ref of price?.taxes_base ?? price?.taxes ?? []) frozen.set(ref.uid, ref.uid);
  }
  return frozen;
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

function extensionFor(
  item: LineItem,
  extensions: readonly PriceDocumentExtension[] | undefined,
): LinePricingOptions | undefined {
  if (!extensions?.length) return undefined;
  const match = extensions.filter((ext) =>
    ext.divider_path.length <= item.path.length &&
    ext.divider_path.every((segment, i) => item.path[i] === segment)
  );
  if (match.length === 0) return undefined;
  if (match.length > 1) {
    throw new Error(`Line ${item.uid} falls under ${match.length} extension sections; a line extends one window`);
  }
  return { extensionDays: extensionChargeDays(match[0].order_charge_days, match[0].billed_charge_days) };
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
  // An issued invoice resolves at the versions it carries, read off the INPUT
  // before stage 1 rewrites any ref. A caller-supplied freeze wins.
  const frozenVersions = ctx.tax.frozenVersions ?? frozenRateVersions(items, ctx.document);
  const warnings = assignLineTaxes(out, { ...ctx.tax, frozenVersions });
  const pricing = pricingTaxesOf(ctx.tax.catalog);

  // ── Stages 2 + 3: per-line money, assembled ──
  for (const item of out) {
    if (!isPriceableItem(item)) continue;
    const price = item.price;
    const money: LinePriceMoney = computeLineMoney(item, pricing, item.uid, extensionFor(item, ctx.extensions));
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
      throw new Error(`Percent fee line ${item.uid} has quantity ${item.quantity}; a percent fee line is quantity 1`);
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
