/**
 * **FROZEN copies of the per-site money functions the one line-money function
 * replaced** (one-document-model 6e-0b1 S3, ruling 39) — `cumulativeShareCents`,
 * `flatShareCents` and `flatPurchaseLineMoney`, verbatim as they stood at core
 * `4e646728` less their docblocks.
 *
 * They exist ONLY as the equivalence oracle S5 owes: every former call site
 * must equal the new function on a shared undiscounted draw, with 0
 * disagreements. Nothing in `src/` may import this file, and nothing should
 * call it except to compare against `lineUnitsCents` / `lineMoneyAtCents`.
 * Delete it with the equivalence sweeps once those are no longer wanted.
 *
 * @module
 */
import { priceFromFormula } from "../../src/utils/price-formulas.ts";
import type { FormulaDiscount } from "../../src/utils/price-formulas.ts";
import { roundDivHalfUp, toCentsBig } from "../../src/utils/money.ts";

export function frozenCumulativeShareCents(amountCents: number, quantity: number, before: number, after: number): number {
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError(`quantity ${quantity}`);
  if (!Number.isInteger(amountCents) || amountCents < 0) throw new RangeError(`amountCents ${amountCents}`);
  if (!Number.isInteger(before) || !Number.isInteger(after) || before < 0 || before > after || after > quantity) {
    throw new RangeError(`bounds ${before} ${after} ${quantity}`);
  }
  const at = (k: number) => roundDivHalfUp(BigInt(amountCents) * BigInt(k), BigInt(quantity));
  return Number(at(after) - at(before));
}

export function frozenFlatShareCents(amountCents: number, quantity: number, before: number, after: number): number {
  if (after <= quantity) return frozenCumulativeShareCents(amountCents, quantity, before, after);
  const at = (k: number) => Number(roundDivHalfUp(BigInt(amountCents) * BigInt(k), BigInt(quantity)));
  return at(after) - at(before);
}

export function frozenFlatPurchaseLineMoney(
  grossCents: number,
  quantity: number,
  discount: FormulaDiscount | null,
): { amount_cents: number; discount: { rate: number; type: FormulaDiscount["type"]; amount_cents: number } | null } {
  if (!Number.isInteger(grossCents) || !Number.isInteger(quantity)) throw new Error(`${grossCents} × ${quantity}`);
  if (discount === null) return { amount_cents: grossCents, discount: null };
  const net = discount.type === "percent"
    ? priceFromFormula([{ rate_key: "flat", amount_cents: grossCents }], [{ rate_key: "flat", num: 1, den: 1 }], 1, discount)
      .subtotal_discounted_cents
    : grossCents - Number(toCentsBig(discount.rate)) * quantity;
  return { amount_cents: net, discount: { rate: discount.rate, type: discount.type, amount_cents: grossCents - net } };
}
