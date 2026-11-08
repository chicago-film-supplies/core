/**
 * Payable line prices for fixtures (api-cloudrun `one-document-model` Phase 2).
 *
 * A payable line states its net in `amount_cents`, and its `price` carries the
 * money `priceDocument`'s stated-total arm derives from it. Built here from the
 * amount so a fixture cannot state money its own amount disagrees with — the
 * schema refuses that, and a hand-spelled triple per fixture is how one would.
 *
 * ⚠️ The money is computed by the rule, not by `priceStatedTotalLine`, so a
 * fixture built here can still catch a regression in the pricer.
 */
import type { DiscountType, PriceFormulaRef, PriceModifierType } from "../../src/schemas/mod.ts";

/** The Fixed formula snapshot every flat payable line carries. */
export const FIXED_REF: PriceFormulaRef = { uid: "FixedFormula00000000", name: "Fixed", basis: "flat" };

/** A flat payable line price for a stated net of `amountCents`. */
export function payablePrice(
  amountCents: number,
  opts: { discount?: DiscountType | null; taxes?: PriceModifierType[]; formula?: PriceFormulaRef } = {},
) {
  const discount = opts.discount ?? null;
  const taxes = opts.taxes ?? [];
  return {
    price_formula: opts.formula ?? FIXED_REF,
    rates: [] as never[],
    discount,
    taxes,
    subtotal_cents: amountCents + (discount?.amount_cents ?? 0),
    subtotal_discounted_cents: amountCents,
    total_cents: amountCents + taxes.reduce((sum, t) => sum + t.amount_cents, 0),
  };
}

/** {@link payablePrice} plus the bill/credit line's `counts: []`. */
export function payableDocPrice(
  amountCents: number,
  opts: { discount?: DiscountType | null; taxes?: PriceModifierType[]; formula?: PriceFormulaRef } = {},
) {
  return { ...payablePrice(amountCents, opts), counts: [] as never[] };
}

/**
 * A fixture line with its price money restated from its own `amount_cents` —
 * applied LAST in a builder, after the caller's overrides, so an override of
 * the amount or the discount cannot leave the money stale. A line with no
 * `price` is returned as it is (a test dropping the key on purpose).
 */
export function withPayableMoney<T>(line: T): T {
  const l = line as unknown as { amount_cents?: number | null; price?: Record<string, unknown> };
  if (!l.price) return line;
  const discount = (l.price.discount ?? null) as DiscountType | null;
  const taxes = (l.price.taxes ?? []) as PriceModifierType[];
  const money = payablePrice(l.amount_cents ?? 0, { discount, taxes });
  return {
    ...line,
    price: {
      ...l.price,
      subtotal_cents: money.subtotal_cents,
      subtotal_discounted_cents: money.subtotal_discounted_cents,
      total_cents: money.total_cents,
    },
  } as T;
}
