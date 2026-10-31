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
import type { RateType } from "./common.ts";
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

/**
 * **Tier counts → money.** Integer cents, each tier `× n ÷ d` rounded once.
 *
 * - `subtotal_cents` = Σ tier `round(rate × quantity × num ÷ den)`.
 * - percent discount: `round(subtotal × (100 − rate) ÷ 100)`, once, on the sum.
 * - flat discount: `rate` dollars per unit per counted period, so each tier's
 *   discount is `round(rate × quantity × num ÷ den)`; a discount larger than
 *   the line goes negative, the caller's to surface.
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
  let subtotal = 0n;
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
    const den = QTY_SCALE * BigInt(t.den);
    subtotal += roundDivHalfAwayFromZero(
      BigInt(amount) * qty * BigInt(t.num),
      den,
    );
    if (flatCents !== 0n) {
      flatOff += roundDivHalfAwayFromZero(flatCents * qty * BigInt(t.num), den);
    }
  }
  let discounted = subtotal;
  if (discount?.type === "percent") {
    const rate = BigInt(Math.round(discount.rate * Number(RATE_SCALE)));
    const scale = 100n * RATE_SCALE;
    discounted = roundDivHalfAwayFromZero(subtotal * (scale - rate), scale);
  } else if (discount?.type === "flat") {
    discounted = subtotal - flatOff;
  }
  return {
    subtotal_cents: Number(subtotal),
    subtotal_discounted_cents: Number(discounted),
  };
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
