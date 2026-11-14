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
import { ITEM_CONTRACTS, type ItemTypeType, type RateType } from "./common.ts";
import { roundDivHalfAwayFromZero, toCentsBig } from "../utils/money.ts";

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
 * The line surface {@link lineMoneyAtCents} reads: a line states EITHER its
 * `rates` (and `counts`), or a total over its quantity in `price.stated_cents`
 * (the GROSS, before `discount`). Never both.
 */
export interface LineMoneyLike {
  /** Read only to refuse a line whose money is the document's (`pricing: "from_total"`). */
  type?: ItemTypeType;
  quantity: number;
  price: {
    rates: readonly RateSnapshot[];
    counts: readonly TierCountLike[];
    discount: FormulaDiscount | null;
    stated_cents?: number | null;
  };
}

function statedOf(line: LineMoneyLike): number | null {
  if (line.type !== undefined && ITEM_CONTRACTS[line.type].pricing !== "pre_tax") {
    throw new Error(`A "${line.type}" line has no line money of its own (pricing "${ITEM_CONTRACTS[line.type].pricing}")`);
  }
  const stated = line.price.stated_cents ?? null;
  if (stated === null) return null;
  if (!Number.isInteger(stated)) throw new Error(`price.stated_cents is integer cents, got ${stated}`);
  if (line.price.rates.length > 0) {
    throw new Error("A line states rates OR a stated total, never both");
  }
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

function moneyAt(line: LineMoneyLike, k: number): { gross: bigint; net: bigint } {
  assertUnits(k);
  const stated = statedOf(line);
  const discount = line.price.discount;
  if (stated === null) {
    const m = priceFromFormula(line.price.rates, line.price.counts, k, discount);
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
 * @throws on a non-integer or negative `k`, a line stating both rates and a total,
 *   or a line whose money is the document's (`pricing` other than `pre_tax`).
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
): number | null {
  let expected: number;
  try {
    expected = priceFromFormula(price.rates, price.counts, quantity, price.discount).subtotal_discounted_cents;
  } catch {
    return Number.NaN;
  }
  return expected === amountCents ? null : expected;
}

/** The line surface {@link checkFormulaLineMoney} reads. */
export interface FormulaPricedLineLike {
  quantity?: number;
  price?: {
    price_formula?: unknown;
    rates?: readonly RateSnapshot[];
    counts?: readonly TierCountLike[];
    discount?: FormulaDiscount | null;
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
    expected = priceFromFormula(price.rates, price.counts, item.quantity, price.discount ?? null);
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
