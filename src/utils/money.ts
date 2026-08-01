/**
 * Money as integer minor units — the dollars↔cents boundary, the exact-division
 * primitive that factor arithmetic is built on, and a float-free formatter.
 *
 * ```ts
 * import { formatCents, roundDivHalfUp, toCents } from "@cfs/core/utils/money";
 *
 * toCents(19.99); // 1999
 * formatCents(-4495_62); // "-$4,495.62"
 * roundDivHalfUp(1000n * 33n, 100n); // 330n  — × n ÷ d, never × (n/d)
 * ```
 *
 * **Never let a float carry a money value or a factor applied to one.** The trap
 * is operation order, not precision: `× (n / d)` bakes an unrepresentable
 * quotient into the money before it is ever scaled, while `× n ÷ d` over integer
 * cents rounds exactly once, at the end. Measured over a 500k-pair corpus,
 * divide-first is wrong 496,088 times and integer cents 0.
 *
 * ## Two numeric flavours, and which to reach for
 *
 * - **`number`** — `toCents` / `fromCents` / `formatCents`. The storage and
 *   display boundary: a `*_cents` field, a wire payload, a rendered row. Safe
 *   because `Number.MAX_SAFE_INTEGER` is 9.007e15 cents ≈ **$90 trillion**, so a
 *   cent value and a sum of cent values never approach it.
 * - **`bigint`** — `toCentsBig` / `fromCentsBig` / `roundDivHalfUp`. Applying a
 *   *factor* to money, where the intermediate is the problem rather than the
 *   result: `calculateItemSubtotal` scales cents by `100 × RATE_SCALE` = 1e8, so
 *   a $1M line reaches 1e16 and overflows 2^53 before any division happens.
 *
 * Sums of cents need neither — integer addition is exact by construction, which
 * is the whole reason journals store minor units.
 *
 * @module
 */

/**
 * Widen dollars to exact integer cents.
 *
 * Stored money is 2dp, so `× 100` is a lossless widening rather than a rounding;
 * the `Math.round` is there to absorb the binary representation error in values
 * like `19.99 * 100 === 1998.9999999999998`, not to make a decision about a
 * third decimal place.
 */
export const toCents = (dollars: number): number => Math.round(dollars * 100);

/**
 * Narrow integer cents back to dollars, for a dollar-denominated projection.
 *
 * This is the one place a money value re-enters float space, so it belongs at a
 * named boundary and nowhere else — see `recomputeSettlementTotals`.
 */
export const fromCents = (cents: number): number => cents / 100;

/**
 * The `bigint` flavour of {@linkcode toCents}, for factor arithmetic whose
 * intermediates exceed `Number.MAX_SAFE_INTEGER`.
 */
export const toCentsBig = (dollars: number): bigint => BigInt(Math.round(dollars * 100));

/** The `bigint` flavour of {@linkcode fromCents}. */
export const fromCentsBig = (cents: bigint): number => Number(cents) / 100;

/**
 * Round `num / den` half-up, exactly, over integers.
 *
 * **Non-negative numerator and positive denominator only.** BigInt division
 * truncates toward zero, so `(2n + d) / 2d` rounds a negative numerator the
 * wrong way — toward zero rather than half-up. Every caller applies a factor to
 * a non-negative money value (a base price, a quantity, a chargeable-day count,
 * a rate, a cost basis), which is what makes the form correct rather than merely
 * convenient. A caller that acquires a negative numerator must not reach for
 * this without revisiting the rounding rule.
 */
export function roundDivHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/**
 * Format integer cents for display **without ever creating a float**.
 *
 * Integer division and a modulo, then string work — so the number on screen and
 * the number in the journal are the same object, which is what a ledger UI
 * should do. Output matches manager's `formatCurrency`
 * (`currency(v, { symbol: "$" }).format()`) so this is a visual drop-in for a
 * cents-denominated value: `"$1,234.56"`, `"-$50.00"`.
 *
 * `cents` is expected to be an integer — every `*_cents` field is a `z.int()`.
 * The truncation is a display guard against a stray float reaching the renderer,
 * not a rounding policy; a caller with a fractional cent has a bug upstream.
 */
export function formatCents(cents: number, options: { symbol?: string } = {}): string {
  const { symbol = "$" } = options;
  const abs = Math.abs(Math.trunc(cents));
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const minor = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${symbol}${dollars}.${minor}`;
}
