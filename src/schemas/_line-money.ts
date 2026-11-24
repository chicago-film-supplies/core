/**
 * The formula MONEY STEP — tier counts → integer cents — on the schema side of
 * the one-way `utils → schemas` edge, so a stored line's refine can assert that
 * its own `rates`, `counts`, `quantity` and `discount` reproduce its money
 * (purchases-as-documents Phase 2 ruling 8). `@cfs/core/utils/price-formulas`
 * re-exports it: there is one implementation.
 *
 * ⚠️ **This is core's one `schemas → utils` import**, and it is deliberately
 * narrow: the two BigInt primitives from `utils/money.ts`, whose own schema
 * import is type-only (erased at runtime), so no runtime cycle exists. Do not
 * widen it; a schema that wants anything else from `utils/` belongs in `utils/`.
 *
 * @module
 */
import { z } from "zod";
import { ITEM_CONTRACTS, type ItemTypeType, type RateType } from "./common.ts";
import { roundDivHalfAwayFromZero, toCentsBig } from "../utils/money.ts";
import type { LineKind } from "./side.ts";

/** One tier's exact metered count — `TierCount`, `@cfs/core/utils/price-formulas`. */
interface TierCountLike {
  rate_key: string;
  num: number;
  den: number;
}

/** A rate the line priced with — the snapshot a line owns (`price.rates`). */
export interface RateSnapshot {
  rate_key: string;
  /** Integer cents; may be negative (a credit line). */
  amount_cents: number;
}

/** A line's discount as the money step reads it. `rate` is 4dp DOLLARS on `flat`. */
export interface FormulaDiscount {
  rate: number;
  type: RateType;
}

/** Scale for a possibly-fractional quantity — `calculateItemSubtotal`'s own. */
const QTY_SCALE = 10_000n;
/** Scale for a percent discount rate — `calculateItemSubtotal`'s own. */
const RATE_SCALE = 1_000_000n;

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * **Tier counts → money.** Integer cents, each figure the EXACT rational rounded
 * ONCE, half away from zero (one-document-model ruling 39, owner 2026-11-13: the
 * strongest form).
 *
 * - `subtotal_cents` = `round(Σ tier rate × quantity × num ÷ den)`.
 * - percent discount: `subtotal_discounted_cents` = `round(Σ tier … × (100 − rate) ÷ 100)`,
 *   from the exact sum, never from the rounded subtotal.
 * - flat discount: `rate` dollars per unit per counted period, so the discounted
 *   amount is `round(Σ tier (rate_cents − flat_cents) × quantity × num ÷ den)`; a
 *   discount larger than the line goes negative, the caller's to surface.
 *
 * ⭐ **Why one rounding:** every part of a line is a difference of this function's
 * cumulative values ({@link lineUnitsCents}), and only a value rounded once from
 * the exact rational keeps every part within 1¢ of exact. Rounding per tier, or
 * the subtotal and then the discount, put a percent-discounted part 2¢ off
 * (measured: 874 of 100,000). Census before the change, prod, dev and `test`: no
 * stored line this function reproduced moved; the only lines that would are the
 * frozen ones it never reproduced.
 *
 * @throws when a tier names a rate key `rates` does not carry.
 */
export function priceFromFormula(
  rates: readonly RateSnapshot[],
  tiers: readonly TierCountLike[],
  quantity: number,
  discount: FormulaDiscount | null,
): { subtotal_cents: number; subtotal_discounted_cents: number } {
  const qty = BigInt(Math.round(quantity * Number(QTY_SCALE)));
  const byKey = new Map(rates.map((r) => [r.rate_key, r.amount_cents]));
  // One common denominator: QTY_SCALE × lcm(den), so the sums below are exact.
  let lcm = 1n;
  for (const t of tiers) {
    const d = BigInt(t.den);
    lcm = (lcm / gcd(lcm, d)) * d;
  }
  const den = QTY_SCALE * lcm;
  let gross = 0n;
  let flatOff = 0n;
  const flatCents = discount?.type === "flat" ? toCentsBig(discount.rate) : 0n;
  for (const t of tiers) {
    const amount = byKey.get(t.rate_key);
    if (amount === undefined) {
      throw new Error(`No rate for key "${t.rate_key}"`);
    }
    if (!Number.isInteger(amount)) {
      throw new Error(`Rate "${t.rate_key}" is not integer cents: ${amount}`);
    }
    const units = qty * BigInt(t.num) * (lcm / BigInt(t.den));
    gross += BigInt(amount) * units;
    flatOff += flatCents * units;
  }
  let discounted: bigint;
  if (discount?.type === "percent") {
    const rate = BigInt(Math.round(discount.rate * Number(RATE_SCALE)));
    const scale = 100n * RATE_SCALE;
    discounted = roundDivHalfAwayFromZero(gross * (scale - rate), den * scale);
  } else {
    discounted = roundDivHalfAwayFromZero(gross - flatOff, den);
  }
  return {
    subtotal_cents: Number(roundDivHalfAwayFromZero(gross, den)),
    subtotal_discounted_cents: Number(discounted),
  };
}


// ── The one line-money function (one-document-model ruling 39) ──────────

/**
 * The line surface {@link lineMoneyAtCents} reads: a line's money comes from its
 * `rates` (and `counts`), or from a total over its quantity in
 * `price.stated_cents` (the GROSS, before `discount`). When both are present the
 * stated total governs (a LINKED time line: Xero's money, the formula's rates).
 */
export interface LineMoneyLike {
  /** Read only to refuse a line whose money is the document's (`pricing: "from_total"`). */
  type?: ItemTypeType;
  quantity: number;
  /**
   * A RATE line that is a PART of its source line covers the source's units
   * `(units_from, units_from + quantity]` (one-document-model ruling 174), so its
   * first `k` units are worth `formula(units_from + k) − formula(units_from)`.
   * Absent or `null` is 0: a whole line, the money every line had before. A
   * stated line ignores it: its stated gross is already the part's.
   */
  units_from?: number | null;
  price: {
    rates: readonly RateSnapshot[];
    counts: readonly TierCountLike[];
    discount: FormulaDiscount | null;
    stated_cents?: number | null;
  };
}

/**
 * **The one predicate for how a line's money is stated** (6e-0b4 K7): `stated`
 * when it carries `price.stated_cents`, else `rate`. A stated total GOVERNS a
 * line that also carries rates (a LINKED time line). It reads the key alone, so
 * it answers for any line, a `transaction_fee` included (whose stored money is
 * a rate line's); {@link statedOf} is the money step's guarded read of it.
 */
export function lineKindOf(line: { price: { stated_cents?: number | null } }): LineKind {
  return (line.price.stated_cents ?? null) === null ? "rate" : "stated";
}

/**
 * A pre-tax line's stated gross, or `null` for a rate line ({@link lineKindOf}).
 * Throws on a line whose money is the document's (`pricing` other than
 * `pre_tax`), and on a non-integer total.
 */
export function statedOf(line: LineMoneyLike): number | null {
  if (line.type !== undefined && ITEM_CONTRACTS[line.type].pricing !== "pre_tax") {
    throw new Error(`A "${line.type}" line has no line money of its own (pricing "${ITEM_CONTRACTS[line.type].pricing}")`);
  }
  if (lineKindOf(line) === "rate") return null;
  const stated = line.price.stated_cents as number;
  if (!Number.isInteger(stated)) throw new Error(`price.stated_cents is integer cents, got ${stated}`);
  // A stated total GOVERNS a line that also carries rates: a LINKED time line's
  // money is Xero's, and its rates are the formula's, kept for the record.
  return stated;
}

function assertUnits(k: number): void {
  if (!Number.isInteger(k) || k < 0) throw new RangeError(`A unit count is a non-negative integer, got ${k}`);
}

/** The stated arm: `stated × k ÷ Q`, rounded once; `0` on a line of no units. */
function statedGrossAt(stated: number, quantity: number, k: number): bigint {
  if (quantity === 0) return 0n;
  return roundDivHalfAwayFromZero(BigInt(stated) * BigInt(k), BigInt(quantity));
}

/**
 * **A rate line's money over its source's units `(from, from + quantity]`**
 * (one-document-model ruling 174): `priceFromFormula` at both cumulative bounds,
 * each figure their difference, so the parts of a line along any path sum
 * EXACTLY to the whole and each rounds once. `from = 0` is the whole-line
 * formula, unchanged. The ONE place a part's rate money is computed: the
 * line-money function, the pricer (`calculateItemSubtotal`) and the stored-money
 * refine all read it.
 */
export function formulaPartMoney(
  rates: readonly RateSnapshot[],
  tiers: readonly TierCountLike[],
  from: number,
  quantity: number,
  discount: FormulaDiscount | null,
): { subtotal_cents: number; subtotal_discounted_cents: number } {
  const to = priceFromFormula(rates, tiers, from + quantity, discount);
  if (from === 0) return to;
  assertUnits(from);
  const at = priceFromFormula(rates, tiers, from, discount);
  return {
    subtotal_cents: to.subtotal_cents - at.subtotal_cents,
    subtotal_discounted_cents: to.subtotal_discounted_cents - at.subtotal_discounted_cents,
  };
}

/**
 * **`units_from` — the first unit of its SOURCE line a part covers**
 * (one-document-model D7, ruling 174), ONE declaration for every billing and
 * credit line on both sides: an invoice or bill line's units
 * `(units_from, units_from + quantity]` of its initiator line, a credit line's
 * of the billing row it credits.
 *
 * - On a RATE line it prices the part ({@link formulaPartMoney}): the line's own
 *   counts, the cumulative formula at both bounds.
 * - On a STATED line it is the marker the initiator → billing sync reads to tell
 *   an untouched part (still exactly its slice) from an overridden one; the
 *   stated gross is the money.
 * - Absent or `null` reads as 0: a whole line, as every line written before it.
 */
export const UnitsFromField: z.ZodType<number | null | undefined> = z.int().min(0).nullable().optional().meta({ seed: false });

/**
 * **The merge group a line's stated money moves in** (one-document-model rulings
 * 189, 198): `quantity` and `price.stated_cents` on every grain, plus the payable
 * `amount_cents` and a replacement line's `out_of_service`. A stated total is a
 * TOTAL, so a quantity that followed its source beside a total that stayed (or the
 * reverse) would bill the whole line's money for part of its units: the members
 * follow the source together, or are kept together. On a rate line `stated_cents`
 * is `null` on both documents, so the group decides exactly what `quantity` alone
 * did. Named `flat_money` until ruling 198, when the receivable side joined it.
 */
export const STATED_TOTAL_GROUP = "stated_total";

/**
 * **`price.stated_cents` — a line's stated GROSS over its quantity, before
 * `discount`** (one-document-model rulings 39, 189). ONE instance on every
 * priced line of every grain: order, invoice, credit note, purchase, bill and
 * supplier credit (`tests/item-shape-parity.test.ts` asserts the identity).
 *
 * - **Absent or `null`:** a RATE line, priced from `rates × counts`.
 * - **Set:** a STATED line ({@link lineKindOf}). `subtotal_cents` is the stated
 *   gross and the net is `stated_cents − discount.amount_cents` (D7): the
 *   discount's CENTS are the money, turned from the rate once at the operator's
 *   edit (`applyDiscountTerms`), and a part of the line slices the stored gross
 *   and cents (`sliceStoredMoney`). A stated total governs a line that also
 *   carries rates (a LINKED time line: Xero's money).
 *
 * In the {@link STATED_TOTAL_GROUP} merge group with `quantity`: it is a total,
 * so it follows or is kept with the quantity it is over. `xero: true` because a
 * rate ↔ stated flip with an unchanged net changes the Xero body
 * (`unit_amount` → `exact_split`) while moving no other tagged key.
 *
 * ⚠️ Not on the `@cfs/core/schemas` barrel: no consumer assembles a price from
 * parts. An INPUT schema declares its own untagged twin.
 */
export const StatedCore: { stated_cents: z.ZodType<number | null | undefined> } = {
  stated_cents: z.int().min(0).nullable().optional().meta({
    column: true,
    label: "Stated",
    propagate: true,
    shared_group: STATED_TOTAL_GROUP,
    xero: true,
  }),
};

function moneyAt(line: LineMoneyLike, k: number): { gross: bigint; net: bigint } {
  assertUnits(k);
  const stated = statedOf(line);
  const discount = line.price.discount;
  if (stated === null) {
    const m = formulaPartMoney(line.price.rates, line.price.counts, line.units_from ?? 0, k, discount);
    return { gross: BigInt(m.subtotal_cents), net: BigInt(m.subtotal_discounted_cents) };
  }
  const gross = statedGrossAt(stated, line.quantity, k);
  if (discount === null || line.quantity === 0) return { gross, net: gross };
  if (discount.type === "percent") {
    // From the exact gross, never the rounded one: one rounding (see priceFromFormula).
    const rate = BigInt(Math.round(discount.rate * Number(RATE_SCALE)));
    const scale = 100n * RATE_SCALE;
    const net = roundDivHalfAwayFromZero(BigInt(stated) * BigInt(k) * (scale - rate), BigInt(line.quantity) * scale);
    return { gross, net };
  }
  // flat: dollars per unit, and a stated line's pricing factor is 1 (ruling 39 D1).
  return { gross, net: gross - toCentsBig(discount.rate) * BigInt(k) };
}

/**
 * **The money of a line's first `k` units** — pre-tax, after discount — the one
 * function every whole-line, partial, credit, split, close and diff figure is a
 * difference of (one-document-model ruling 39).
 *
 * - **rate line:** `priceFromFormula(rates, counts, k, discount)`, so `k = quantity`
 *   is exactly the money `computeLineMoney` stores.
 * - **stated line:** the gross `stated_cents × k ÷ quantity`, rounded once; the
 *   net from the EXACT gross: a percent rounded once, a flat `rate × k` off
 *   (closed: a stated line's pricing factor is 1, ruling 39 D1).
 *
 * Defined past `quantity` (an over-billed line, D5) at the same per-unit money,
 * and `0` at `k = 0` and on a stated line of no units.
 *
 * @throws on a non-integer or negative `k`, or a line whose money is the
 *   document's (`pricing` other than `pre_tax`).
 */
export function lineMoneyAtCents(line: LineMoneyLike, k: number): number {
  return Number(moneyAt(line, k).net);
}

/**
 * **The money of units `(before, after]` of a line** — `lineMoneyAtCents(after) −
 * lineMoneyAtCents(before)`. ⭐ The CUMULATIVE value is rounded, never the part,
 * so the parts along any path from 0 to `quantity` sum exactly to the whole line
 * and a count's money does not depend on the path that reached it (the partition
 * rule, `cfs-money`). A reversal is the same call with the bounds swapped.
 */
export function lineUnitsCents(line: LineMoneyLike, before: number, after: number): number {
  return lineMoneyAtCents(line, after) - lineMoneyAtCents(line, before);
}

/**
 * **The discount on a line's first `k` units**: gross at `k` minus money at `k`,
 * so a part's discount RECORD is a difference of cumulative values too and the
 * parts' records sum to the whole line's.
 */
export function lineDiscountAtCents(line: LineMoneyLike, k: number): number {
  const m = moneyAt(line, k);
  return Number(m.gross - m.net);
}

/**
 * **A PSEUDO-line: `statedCents` over `quantity` units, undiscounted** — for a
 * partition of an amount that is not one line's money (one-document-model 6e-0b1
 * S3): a landed cost over its units, a bill split's leftover over its group, a
 * billed POOL over its units, a row's money rescaled to a new count. Named so a
 * reader can tell it from a real line. `lineUnitsCents(statedLine(a, q), b, k)`
 * is `round(a·k ÷ q) − round(a·b ÷ q)`, defined past `q`.
 */
export function statedLine(statedCents: number, quantity: number): LineMoneyLike {
  return { quantity, price: { rates: [], counts: [], discount: null, stated_cents: statedCents } };
}

/** The stored payable-line surface {@link payableStoredMoney} reads. */
export interface PayableMoneyLineLike {
  quantity: number;
  /** The stored NET; `null` on a purchase time line. */
  amount_cents: number | null;
  price: {
    price_formula?: { basis: string };
    discount: (FormulaDiscount & { amount_cents?: number }) | null;
    stated_cents?: number | null;
  };
}

/**
 * **A line's STORED money, as a part slices it** (one-document-model D7): its
 * gross and its discount in cents over its quantity. Net is their difference.
 */
export interface StoredLineMoney {
  quantity: number;
  gross_cents: number;
  discount_cents: number;
}

/** A slice of a line's stored money: each figure the line's, over the units it covers. */
export interface MoneySlice {
  gross_cents: number;
  discount_cents: number;
  /** `gross_cents − discount_cents`: a subtraction, nothing rounds. */
  net_cents: number;
}

/**
 * A stored payable line's money as a part slices it (D7): its stated GROSS
 * (`price.stated_cents`) and its discount in cents. A TIME line slices its
 * stored net with no discount: its money is its counts priced (or Xero's,
 * linked), so what a part takes of it is a share of that.
 *
 * ⚠️ **A STATED line only** since ruling 189: a flat line may be a RATE line,
 * whose parts price by the formula at `units_from` (ruling 174), never by a
 * slice. Ask the one part door, `billingRowPart`
 * (`@cfs/core/utils/price-document`), which dispatches on the line's kind.
 *
 * @throws Error on a flat line that states no gross (a rate line): there is
 * nothing to slice, and reading its net as the gross would be wrong.
 */
export function payableStoredMoney(line: PayableMoneyLineLike): StoredLineMoney {
  if (line.price.price_formula?.basis === "time") {
    return { quantity: line.quantity, gross_cents: line.amount_cents ?? 0, discount_cents: 0 };
  }
  const gross = line.price.stated_cents ?? null;
  if (gross === null) throw new Error("payableStoredMoney: a flat RATE line has no stated gross to slice; use billingRowPart");
  return { quantity: line.quantity, gross_cents: gross, discount_cents: line.price.discount?.amount_cents ?? 0 };
}

/**
 * **Units `(before, after]` of a line's STORED money** (one-document-model D7):
 * the gross and the discount each sliced on the CUMULATIVE value
 * (`round(x · k ÷ quantity)`, once), and the net their difference. A rate is
 * never re-applied: a part inherits money, so every part of a line sums EXACTLY
 * to the line on all three figures, and a part's own `net = gross − discount`
 * holds by construction. Defined past `quantity` (over-billing) and with the
 * bounds swapped (a reversal). A line of no units slices to zero.
 */
export function sliceStoredMoney(money: StoredLineMoney, before: number, after: number): MoneySlice {
  const at = (cents: number, k: number) => {
    assertUnits(k);
    return statedGrossAt(cents, money.quantity, k);
  };
  const gross = Number(at(money.gross_cents, after) - at(money.gross_cents, before));
  const discount = Number(at(money.discount_cents, after) - at(money.discount_cents, before));
  return { gross_cents: gross, discount_cents: discount, net_cents: gross - discount };
}

/**
 * **The ONE place a discount RATE becomes money on a stated line** (D7): when an
 * operator states a gross or discount terms. The discount on the whole line at
 * its quantity, by the one line-money function (`lineDiscountAtCents`: a percent
 * rounded once from the exact gross, a flat `rate × quantity`), and the net by
 * subtraction. Nothing re-applies a rate afterwards: the document pricer and the
 * refine read the stored cents, and parts slice them ({@link sliceStoredMoney}).
 *
 * A discount larger than the gross is a negative net, the writer's 400 to make.
 */
export function applyDiscountTerms(
  grossCents: number,
  quantity: number,
  terms: FormulaDiscount | null,
): { amount_cents: number; discount: { rate: number; type: FormulaDiscount["type"]; amount_cents: number } | null } {
  if (terms === null) return { amount_cents: grossCents, discount: null };
  const off = lineDiscountAtCents(
    { quantity, price: { rates: [], counts: [], discount: { rate: terms.rate, type: terms.type }, stated_cents: grossCents } },
    quantity,
  );
  return { amount_cents: grossCents - off, discount: { rate: terms.rate, type: terms.type, amount_cents: off } };
}

/** The line surface {@link statedLineSubtotals} reads: a stated gross and its discount. */
export interface StatedPricedLineLike {
  quantity: number;
  price: {
    stated_cents?: number | null;
    /** `amount_cents` set is the STORED cents (D7); absent, the terms are applied once. */
    discount?: (FormulaDiscount & { amount_cents?: number }) | null;
  };
}

/**
 * **THE stated pricer — one for both sides** (one-document-model ruling 189,
 * spec S3): a STATED line's two subtotals from its gross and its discount CENTS.
 *
 * - `subtotal_cents` = `price.stated_cents`, the gross;
 * - `subtotal_discounted_cents` = gross − `discount.amount_cents` (D7): a
 *   subtraction, so a rate is never re-applied to a line whose cents are stored
 *   (a part's cents are its slice of its source's, `sliceStoredMoney`);
 * - a discount carrying no cents is the RATE EVENT itself (a line just stated,
 *   or a client's input, which carries terms only): the terms become cents once,
 *   by {@link applyDiscountTerms}.
 *
 * A discount larger than the gross prices to a negative net: refusing it is the
 * line-edit module's (ruling 195), and a stored one (2 paid prod invoice lines)
 * must still price. Reached by `calculateItemSubtotal` (every receivable reader)
 * and the payable `priceStatedTotalLine`; Ratchet E counts its call sites.
 *
 * @throws Error on a rate line (no `stated_cents`) or a non-integer gross.
 */
export function statedLineSubtotals(line: StatedPricedLineLike): {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
} {
  const gross = line.price.stated_cents ?? null;
  if (gross === null) throw new Error("statedLineSubtotals: a rate line states no gross (price.stated_cents)");
  if (!Number.isInteger(gross)) throw new Error(`price.stated_cents is integer cents, got ${gross}`);
  const discount = line.price.discount ?? null;
  if (discount === null) return { subtotal_cents: gross, subtotal_discounted_cents: gross };
  const off = typeof discount.amount_cents === "number"
    ? discount.amount_cents
    : applyDiscountTerms(gross, line.quantity, { rate: discount.rate, type: discount.type }).discount!.amount_cents;
  return { subtotal_cents: gross, subtotal_discounted_cents: gross - off };
}

/**
 * Does a line's stored money equal what its own snapshot reproduces? The
 * single-document check every formula-priced line runs (ruling 8): `rates`,
 * `counts`, `quantity` and `discount` → `subtotal_discounted_cents`, compared
 * with `amountCents` to the cent. Returns the expected amount on a mismatch, or
 * `null` when it agrees. A rate key the counts name but the rates lack is a
 * mismatch too, reported as `NaN`.
 */
export function formulaMoneyMismatch(
  price: { rates: readonly RateSnapshot[]; counts: readonly TierCountLike[]; discount: FormulaDiscount | null },
  quantity: number,
  amountCents: number,
  unitsFrom: number | null = null,
): number | null {
  let expected: number;
  try {
    expected = formulaPartMoney(price.rates, price.counts, unitsFrom ?? 0, quantity, price.discount).subtotal_discounted_cents;
  } catch {
    return Number.NaN;
  }
  return expected === amountCents ? null : expected;
}

/** The line surface {@link checkFormulaLineMoney} reads. */
export interface FormulaPricedLineLike {
  quantity?: number;
  /** A part's first source unit (ruling 174); absent is a whole line. */
  units_from?: number | null;
  price?: {
    price_formula?: unknown;
    rates?: readonly RateSnapshot[];
    counts?: readonly TierCountLike[];
    discount?: (FormulaDiscount & { amount_cents?: number }) | null;
    stated_cents?: number | null;
    subtotal_cents?: number;
    subtotal_discounted_cents?: number;
  } | null;
}

/**
 * **A formula-priced line's money is what its own snapshot reproduces** — the
 * single-document refine ruling 8 puts on every customer line (order, invoice,
 * credit note). `rates`, `counts`, `quantity` and `discount` → both subtotals,
 * to the cent. A percent-of-total fee (no `price_formula`) is priced from the
 * document and is not checked here.
 *
 * Structural rather than a schema refine body so each grain attaches it to its
 * own line arm.
 */
export function checkFormulaLineMoney(
  item: FormulaPricedLineLike,
  ctx: { addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void },
): void {
  const price = item.price;
  if (price == null || price.price_formula == null || price.rates == null || price.counts == null) return;
  if (typeof item.quantity !== "number") return;
  let expected: { subtotal_cents: number; subtotal_discounted_cents: number };
  try {
    // A stated total governs a line that carries one (`statedOf`): its money is
    // the stated gross less its discount CENTS (D7, `statedLineSubtotals`), so a
    // part holding its slice of its source's cents is not re-derived from a rate.
    const quantity = item.quantity;
    const stated = price.stated_cents ?? null;
    expected = stated === null
      ? formulaPartMoney(price.rates, price.counts, item.units_from ?? 0, quantity, price.discount ?? null)
      : statedLineSubtotals({ quantity, price: { stated_cents: stated, discount: price.discount ?? null } });
  } catch (e) {
    ctx.addIssue({ code: "custom", path: ["price", "counts"], message: (e as Error).message });
    return;
  }
  for (const key of ["subtotal_cents", "subtotal_discounted_cents"] as const) {
    if (price[key] !== undefined && price[key] !== expected[key]) {
      ctx.addIssue({
        code: "custom",
        path: ["price", key],
        message: `price.${key} ${price[key]} must equal what the line's rates × counts reproduce: ${expected[key]}`,
      });
    }
  }
}

/**
 * {@link checkFormulaLineMoney} over a document's `items`, each issue pathed
 * under `["items", i]` — the DOCUMENT-level form, for a schema that runs the
 * money check only while the document may still be repriced.
 *
 * 🔴 **Why the invoice and the credit note scope it and the order does not**
 * (purchases-as-documents Phase 5, the D10 "risk to measure"): the backfill found
 * PAID invoices — CRMS-authored, Xero's money — and an APPLIED credit note whose
 * stored line money no `rates × counts` reproduces, and never had: the old
 * pricer disagreed with them too. Their money is settled fact, and inventing a
 * fractional count to make it agree would make `counts` lie about time to every
 * reader that budgets from them (credits, remainders, the diff). So a frozen
 * document keeps its money and its honest counts, and the check guards what can
 * still be repriced.
 */
export function checkItemsLineMoney(
  items: readonly unknown[],
  ctx: { addIssue: (issue: { code: "custom"; path: (string | number)[]; message: string }) => void },
): void {
  items.forEach((item, i) =>
    checkFormulaLineMoney(item as FormulaPricedLineLike, {
      addIssue: (issue) => ctx.addIssue({ ...issue, path: ["items", i, ...issue.path] }),
    })
  );
}
