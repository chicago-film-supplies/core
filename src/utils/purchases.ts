/**
 * Purchase helpers — the cumulative share that prices every receipt and every
 * pushed bill line, the per-line headroom, and the status rule.
 *
 * Design: api-cloudrun#1210.
 *
 * @module
 */
import { derivePurchaseStatus, type PurchaseLine } from "../schemas/mod.ts";
import { roundDivHalfUp } from "./money.ts";
import { purchaseCreditRemainingFromJournal, recomputePurchaseBillTotals } from "./invoices.ts";

// The payable settlement folds live beside their receivable twins in
// `utils/invoices.ts`, which owns the one fold; re-exported here so a purchase
// writer finds them in its own namespace.
export { derivePurchaseStatus, purchaseCreditRemainingFromJournal, recomputePurchaseBillTotals };

/**
 * The cents a line's units `(before, after]` cost — the k-th receipt or the
 * k-th bill line against a purchase line, priced from where the cumulative
 * count stood before it to where it stands after.
 *
 * `round(amount × after ÷ quantity) − round(amount × before ÷ quantity)`, each
 * rounded once, half-up, over integers.
 *
 * ⭐ **The CUMULATIVE value is rounded, never the partial.** So the partials
 * along any path from 0 to `quantity` telescope to `amount_cents` exactly — no
 * remainder rule, no "last one absorbs the cent" — and the price of reaching a
 * cumulative count is the same whichever deliveries got there. Rounding each
 * partial instead (`round(amount × k ÷ quantity)`) drifts: three receipts of 1
 * against a $10.00 line of 3 cost 333 + 333 + 333 = 999.
 *
 * Receipts and bills run this SEPARATELY, each on its own cumulative count, so
 * a CFS-pushed bill and the receipts it covers carry the same money however the
 * two were split (`cfs-money`: closure under the quantum, × n ÷ d in integer
 * cents, round once).
 *
 * A REVERSAL is the same call with the bounds swapped in sign: the units
 * `(after, before]` leave at exactly what they cost to arrive, because the
 * cumulative value at a count does not depend on the path.
 *
 * @throws when `quantity < 1`, `amountCents < 0`, or the bounds are not
 *   `0 ≤ before ≤ after ≤ quantity` — the writer owns those checks, and a
 *   caller that reaches this past them has a bucket bug to surface, not a price
 *   to invent.
 */
export function cumulativeShareCents(
  amountCents: number,
  quantity: number,
  before: number,
  after: number,
): number {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError(`cumulativeShareCents: quantity must be a positive integer, got ${quantity}`);
  }
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`cumulativeShareCents: amountCents must be a non-negative integer, got ${amountCents}`);
  }
  if (!Number.isInteger(before) || !Number.isInteger(after) || before < 0 || before > after || after > quantity) {
    throw new RangeError(
      `cumulativeShareCents: need 0 ≤ before ≤ after ≤ quantity, got before=${before} after=${after} quantity=${quantity}`,
    );
  }
  const amount = BigInt(amountCents);
  const qty = BigInt(quantity);
  const at = (k: number) => roundDivHalfUp(amount * BigInt(k), qty);
  return Number(at(after) - at(before));
}

/** Units of a line still to be received: `quantity − canceled − received`. */
export function remainingToReceive(line: Pick<PurchaseLine, "quantity" | "quantity_received" | "quantity_canceled">): number {
  return line.quantity - line.quantity_canceled - line.quantity_received;
}

/** Units of a line still to be billed: `quantity − canceled − billed`. */
export function remainingToBill(line: Pick<PurchaseLine, "quantity" | "quantity_billed" | "quantity_canceled">): number {
  return line.quantity - line.quantity_canceled - line.quantity_billed;
}
