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
 * ## currency.js appears here, once, on purpose
 *
 * {@linkcode parseMoney} and {@linkcode parseRate} **wrap** currency.js rather
 * than reimplementing it, and they are the only place in CFS that should.
 * Separator, symbol, sign and epsilon handling is exactly the hand-rolled money
 * code this module exists to delete — `"$1,583.505"` has three ways to go wrong
 * before it is ever a number. {@linkcode distributeCents} takes the opposite
 * call and reimplements, because in integers it is five lines that outsource no
 * subtlety at all.
 *
 * ## The rate boundary is a parallel set, not an option on the money one
 *
 * `perUnitCostAt4dp` / {@linkcode parseRate} / {@linkcode formatRate} produce,
 * parse and render a **4dp rate**; `roundDivHalfUp` / {@linkcode parseMoney} /
 * {@linkcode formatCents} do the same for **integer cents**. They are twins
 * rather than one family with a `precision` argument because a rate is not an
 * amount: `Discount.rate`, `PriceModifier.rate`, `Tax.rate` and
 * `transactions:cost.unit_cost` hold four decimals to match Xero's
 * `DiscountRate`, and putting either through the other's function is a measured
 * regression in both directions — 2dp renders `$0.0639/unit` as **`$0.00`**,
 * and a rate is not in cents so a cents renderer is 100× out.
 *
 * @module
 */
import currency from "currency.js";

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
 * {@linkcode roundDivHalfUp} for a numerator of **either** sign, rounding half
 * *away from zero*: `1/2 → 1` and `-1/2 → -1`.
 *
 * Money that can legitimately go negative needs this rather than the bare
 * half-up form, and the distinction is not academic — `calculateItemSubtotal`
 * deliberately lets a flat discount larger than its line produce a negative
 * `subtotal_discounted` ("the caller's problem to surface, not ours to clamp"),
 * and that value is then handed straight to the tax calculation. Clamping it to
 * zero would silently drop the sign; passing it to `roundDivHalfUp` would round
 * it toward zero instead of half-up.
 *
 * Symmetry is the point: `f(-x) === -f(x)` for every input, so a sign flip
 * upstream can never change a magnitude downstream.
 */
export function roundDivHalfAwayFromZero(num: bigint, den: bigint): bigint {
  return num < 0n ? -roundDivHalfUp(-num, den) : roundDivHalfUp(num, den);
}

/**
 * A per-unit **rate** in dollars at 4dp — `cents ÷ units`, rounded once.
 *
 * **This is deliberately finer than money.** A purchase of 100 units for $6.39
 * has a true unit cost of $0.0639; quantizing it to cents stores $0.06, a 6%
 * error on the figure an operator reads. The same argument the schema makes for
 * `Discount.rate` at 4dp — a rate is not an amount, and forcing it to the money
 * quantum destroys information that was never money in the first place.
 *
 * So do **not** reach for `fromCentsBig(roundDivHalfUp(…))` here: it is the
 * right call for a value that will be stored, summed or paid, and the wrong one
 * for a ratio that only ever gets displayed. 4dp also matches what CFS already
 * does at its other rate boundary — Xero's `DiscountRate` holds 4 decimals.
 *
 * `× 100 ÷ units` widens to hundredths-of-a-cent *before* dividing, so the
 * rounding happens once, at the end, on exact integers.
 *
 * **Non-negative `cents` only** — {@linkcode roundDivHalfUp}'s precondition, and
 * every caller applies it to a cost basis. `units <= 0` yields 0 rather than
 * dividing. Headroom: the quotient must stay under `2^53`, i.e. ~$900B.
 */
export function perUnitCostAt4dp(cents: bigint, units: bigint): number {
  if (units <= 0n) return 0;
  return Number(roundDivHalfUp(cents * 100n, units)) / 10_000;
}

/**
 * Parse a money string to 2dp dollars — the string→money direction.
 *
 * Every external money value reaches CFS as text: an operator types into
 * `CurrencyInput`, CRMS sends `"1,583.50"` in a webhook body. Both grew their
 * own parser, and both were wrong in the same way — a bare
 * `parseFloat("1,583.50")` is **1**, and `Number("$12.00")` is `NaN`. This is
 * the one direction the module had no answer for, which is precisely why the
 * local copies appeared.
 *
 * Total by contract: unparseable input yields `0`, never `NaN` and never a
 * throw. `parseMoney("")` and `parseMoney("abc")` are both `0` — a parser at an
 * ingest boundary that can fail closed turns a bad character into a 500.
 *
 * ```ts
 * parseMoney("$1,583.50");  // 1583.5
 * parseMoney("1,583.505");  // 1583.51 — quantized to the money quantum
 * parseMoney("-5.00");      // -5   (sign preserved; a non-negative caller strips it)
 * parseMoney("abc");        // 0
 * ```
 *
 * **Sign is preserved.** A caller whose field is non-negative — `CurrencyInput`
 * is — strips it before calling; that is a UI contract, not a parsing rule, and
 * baking it in here would silently swallow a legitimate credit.
 */
export const parseMoney = (s: string | null | undefined): number =>
  s == null ? 0 : currency(s).value;

/**
 * Parse a **rate** string to 4dp — {@linkcode parseMoney}'s twin, and
 * deliberately a separate function rather than a `precision` option.
 *
 * A rate is not an amount. `Discount.rate`, `PriceModifier.rate` and `Tax.rate`
 * hold four decimals because Xero's `DiscountRate` does and it is a line's only
 * discount channel, so quantizing a rate to the money quantum coarsens every
 * discount in the system. Making the caller choose a `precision` argument would
 * put that domain fact behind a default — the failure mode this whole module is
 * organized against.
 *
 * ```ts
 * parseRate("33.3333"); // 33.3333 — parseMoney would give 33.33
 * ```
 */
export const parseRate = (s: string | null | undefined): number =>
  s == null ? 0 : currency(s, { precision: 4 }).value;

/**
 * Render a **rate** for display — {@linkcode formatCents}'s twin at the other
 * boundary, and the direction the rate pair was missing.
 *
 * The rate boundary already had a producer ({@linkcode perUnitCostAt4dp}) and a
 * parser ({@linkcode parseRate}); with no formatter, a collection table printed
 * a bare `0.0639` for a unit cost. It had previously printed **`$0.00`**,
 * because a name heuristic claimed `cost.unit_cost` for the money formatter —
 * "not money" turns out to be necessary and not sufficient, since a 2dp
 * formatter destroys a 4dp rate either way.
 *
 * **Not `formatCents` with a `dp` option.** `formatCents` takes *integer cents*
 * and its minor part is literally `abs % 100`; adding a precision knob would put
 * a 4dp rate through a function whose whole contract is integer minor units, and
 * would make correctness depend on a per-call-site option with a default. Same
 * argument that keeps `parseRate` separate from `parseMoney`.
 *
 * ```ts
 * formatRate(0.0639, { symbol: "$" });  // "$0.0639"
 * formatRate(10.25);                    // "10.25"     — trailing zeros trimmed
 * formatRate(10.25, { symbol: "%" });   // "10.25%"    — a percent trails its number
 * ```
 *
 * Trailing zeros are trimmed because a rate's precision is a *ceiling*, not a
 * denomination: `$6.39` should not read `$6.3900`. Money is the opposite and
 * pads to exactly 2, which is why these are two functions.
 *
 * @param value - The rate, in whatever unit the field declares. NOT cents.
 * @param options.dp - Maximum decimal places. 4 — Xero's `DiscountRate` width.
 * @param options.symbol - `"$"` prefixes; `"%"` suffixes; `""` (default) neither.
 */
export function formatRate(
  value: number,
  options: { dp?: number; symbol?: string } = {},
): string {
  const { dp = 4, symbol = "" } = options;
  const fixed = value.toFixed(dp);
  const trimmed = fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
  const negative = trimmed.startsWith("-");
  const magnitude = negative ? trimmed.slice(1) : trimmed;
  if (symbol === "%") return `${negative ? "-" : ""}${magnitude}%`;
  return `${negative ? "-" : ""}${symbol}${magnitude}`;
}

/**
 * Split `total` cents into `parts` whole-cent shares that **sum to exactly
 * `total`**.
 *
 * Conservation is the entire contract: `sum(distributeCents(t, n)) === t` for
 * every input. Everything else — how many shares, what order — is subordinate
 * to that.
 *
 * **Residual policy: front-loaded, and it is CFS's choice rather than an
 * inherited one.** `distributeCents(100_00n, 3n)` is
 * `[3334n, 3333n, 3333n]` — the leftover cent goes to the earliest shares. This
 * matches what `currency.js.distribute()` did before this function replaced it,
 * so no stored `unit_costs[]` array changes shape; but it is now *named*, and a
 * caller that needs the residual somewhere else has to say so rather than
 * discover it. Today the only consumer sums the shares back, so the order is
 * unobservable — display and any future FIFO cost semantics would not be.
 *
 * **Symmetric on negatives**: `f(-t, n) === f(t, n).map(x => -x)`, so a sign
 * flip upstream can never change a magnitude downstream. BigInt division
 * truncates toward zero, which is what makes the sign fold below correct rather
 * than merely convenient.
 *
 * **Throws on `parts <= 0`.** currency.js returned `[]`, which loses the whole
 * amount silently — both CFS callers had to guard at the call site to avoid it,
 * and a call-site guard is only ever one new caller away from being forgotten.
 * There is no split of $100 into zero parts that conserves $100, so the honest
 * answer is a refusal.
 *
 * `parts` is a `number` while `total` is a `bigint`, and the asymmetry is
 * deliberate: the returned array's **length must equal `parts` exactly**, so a
 * `bigint` count would have to be narrowed to build it — putting one lossy
 * conversion inside the function whose whole contract is conservation. A count
 * is not money; every schema already types a quantity as `z.number().int()`.
 *
 * @param total - The amount to split, in whole cents. Either sign.
 * @param parts - How many shares. Must be a positive integer.
 * @returns `parts` shares, in cents, summing to `total`.
 */
export function distributeCents(total: bigint, parts: number): bigint[] {
  if (!Number.isSafeInteger(parts) || parts <= 0) {
    throw new RangeError(
      `distributeCents needs a positive integer part count, got ${parts} — ` +
        `no split of ${total} into ${parts} parts conserves it`,
    );
  }
  if (total < 0n) return distributeCents(-total, parts).map((c) => -c);

  const n = BigInt(parts);
  const share = total / n;
  const remainder = total % n;
  return Array.from({ length: parts }, (_, i) => BigInt(i) < remainder ? share + 1n : share);
}

/**
 * How far a CFS settlement may sit from the Xero payment it matches, in cents.
 *
 * A domain rule, not a fudge factor: Xero rounds its own line arithmetic, so a
 * payment can land one cent from what CFS computed for the same invoice. One
 * cent is the whole allowance — the pre-2026-08 matcher used `<= 0.01` **on
 * floats**, twice as loose as the `0.005` the repair scripts used to re-check
 * the same match, so the live matcher could bind a pair those scripts then
 * flagged as broken.
 */
export const PAYMENT_MATCH_TOLERANCE_CENTS = 1;

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
 *
 * ## `{ symbol: "", group: false }` — the search-mirror form
 *
 * A Typesense `_str` mirror needs `"1234.56"`, not `"$1,234.56"`: **both `$`
 * and `,` are token separators**, so the display form tokenizes as
 * `1`/`234`/`56` and a plain `1234.56` query cannot match it. That is the whole
 * reason a second renderer existed in `api-cloudrun/scripts/_moneySurface.ts`
 * for two weeks; the options are cheaper than the copy, and this way the mirror
 * and the display cannot drift on rounding.
 *
 * @param cents - Integer minor units.
 * @param options.symbol - Currency symbol. `""` for a search mirror.
 * @param options.group - Thousands separators. `false` for a search mirror.
 */
export function formatCents(
  cents: number,
  options: { symbol?: string; group?: boolean } = {},
): string {
  const { symbol = "$", group = true } = options;
  const abs = Math.abs(Math.trunc(cents));
  const whole = String(Math.floor(abs / 100));
  const dollars = group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const minor = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${symbol}${dollars}.${minor}`;
}
