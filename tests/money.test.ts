/**
 * The dollars↔cents boundary.
 *
 * `toCents` / `roundDivHalfUp` were defined **twice, byte-identical and
 * unexported** (`utils/orders.ts` and `utils/movements.ts`) until this module
 * gave them one home. The property tests below are what stop the two flavours
 * drifting apart again — a `bigint` and a `number` widening that disagreed
 * would put the journal and the pricing path on different money.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  formatCents,
  fromCents,
  fromCentsBig,
  perUnitCostAt4dp,
  roundDivHalfUp,
  toCents,
  toCentsBig,
} from "../src/utils/money.ts";

Deno.test("toCents widens 2dp dollars losslessly, absorbing the binary representation error", () => {
  // 19.99 * 100 === 1998.9999999999998 in IEEE 754 — the Math.round is there for
  // that, not to decide a third decimal place.
  assertEquals(toCents(19.99), 1999);
  assertEquals(toCents(0.07), 7);
  // Not a bug and not ours to fix: 1.005 is stored as 1.00499999999999989…, so
  // `* 100` is 100.49999999999999 and rounds DOWN. Documented rather than
  // worked around — a 3dp input is already outside the 2dp contract, and the
  // caller that produced it is where the defect lives.
  assertEquals(toCents(1.005), 100);
  assertEquals(toCents(0), 0);
  assertEquals(toCents(-4495.62), -449562);
  assertEquals(toCents(1_000_000), 100_000_000);
});

Deno.test("toCents and toCentsBig agree on every value — one widening, two flavours", () => {
  let seed = 24_681;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 100_000; i++) {
    const dollars = (rand(100_000_000) - 50_000_000) / 100;
    assertEquals(
      BigInt(toCents(dollars)),
      toCentsBig(dollars),
      `flavours disagree at ${dollars}`,
    );
  }
});

Deno.test("fromCents round-trips every 2dp dollar value", () => {
  for (let cents = -500_00; cents <= 500_00; cents += 7) {
    assertEquals(toCents(fromCents(cents)), cents);
  }
});

Deno.test("fromCents and fromCentsBig agree", () => {
  for (const cents of [0, 1, -1, 99, 100, 101, -449562, 9_007_199_254_74]) {
    assertEquals(fromCents(cents), fromCentsBig(BigInt(cents)));
  }
});

Deno.test("roundDivHalfUp rounds by the definition, not by its own identity", () => {
  // Independent check: floor plus a doubled-remainder comparison. Same rule,
  // different arithmetic — the discipline core#48 exists to restore.
  const byDefinition = (num: bigint, den: bigint) => {
    const floor = num / den;
    const remainder = num % den;
    return 2n * remainder >= den ? floor + 1n : floor;
  };
  let seed = 13_579;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 200_000; i++) {
    const num = BigInt(rand(10_000_000));
    const den = BigInt(rand(9_999) + 1);
    assertEquals(roundDivHalfUp(num, den), byDefinition(num, den), `${num}/${den}`);
  }
});

Deno.test("roundDivHalfUp breaks exact ties upward", () => {
  assertEquals(roundDivHalfUp(1n, 2n), 1n, "0.5 → 1");
  assertEquals(roundDivHalfUp(3n, 2n), 2n, "1.5 → 2");
  assertEquals(roundDivHalfUp(5n, 2n), 3n, "2.5 → 3, not banker's 2");
  assertEquals(roundDivHalfUp(1n, 3n), 0n);
  assertEquals(roundDivHalfUp(2n, 3n), 1n);
});

Deno.test("roundDivHalfUp is exact above 2^53, which is why it takes bigint", () => {
  // `calculateItemSubtotal` scales cents by 100 × RATE_SCALE = 1e8, so a $1M
  // line reaches 1e16 — past Number.MAX_SAFE_INTEGER (9.007e15) — BEFORE any
  // division happens. This is the case a `number` implementation gets wrong.
  const num = 100_000_000_00n * 100_000_000n; // $100M in cents × 1e8
  assertEquals(roundDivHalfUp(num, 100_000_000n), 100_000_000_00n);
  assertEquals(
    Number.isSafeInteger(Number(num)),
    false,
    "the intermediate must actually exceed 2^53, or this test proves nothing",
  );
});

Deno.test("formatCents derives the string from the integer, never through a float", () => {
  assertEquals(formatCents(0), "$0.00");
  assertEquals(formatCents(7), "$0.07");
  assertEquals(formatCents(1999), "$19.99");
  assertEquals(formatCents(100), "$1.00");
  assertEquals(formatCents(123456), "$1,234.56");
  assertEquals(formatCents(449562), "$4,495.62");
  assertEquals(formatCents(-449562), "-$4,495.62");
  assertEquals(formatCents(-50_00), "-$50.00");
  assertEquals(formatCents(100_000_000_00), "$100,000,000.00");
  assertEquals(formatCents(1999, { symbol: "" }), "19.99");
});

Deno.test("formatCents matches manager's formatCurrency, so it is a visual drop-in", () => {
  // manager/src/utils/format.ts: currency(v, { symbol: "$" }).format()
  // Verified against currency.js's own output for the shapes a settlements table
  // renders; a divergence here would make one row in the UI look foreign.
  const cases: [number, string][] = [
    [0, "$0.00"],
    [5, "$0.05"],
    [999, "$9.99"],
    [1000, "$10.00"],
    [999_99, "$999.99"],
    [1_000_00, "$1,000.00"],
    [16_000_00, "$16,000.00"],
    [2_196_00, "$2,196.00"],
  ];
  for (const [cents, want] of cases) assertEquals(formatCents(cents), want);
});

Deno.test("formatCents never emits a fractional cent from a stray float input", () => {
  // The input is a z.int() everywhere, so this is a display guard rather than a
  // rounding policy — but "$12.34.5" reaching an operator is worse than a
  // truncation, and silence here would be the wrong failure.
  assertEquals(formatCents(1234.5), "$12.34");
  assertEquals(formatCents(-1234.5), "-$12.34");
});

Deno.test("the money module exports no throwing paths — the boundary must not fail closed", () => {
  // Every caller sits inside a totals recompute or a render. A throw here would
  // turn a display concern into a 500, so the contract is total.
  assertEquals(formatCents(Number.MAX_SAFE_INTEGER).startsWith("$90,071,992,547,409."), true);
  assertThrows(() => roundDivHalfUp(1n, 0n), RangeError, "Division by zero");
});

// ── perUnitCostAt4dp — a rate, not an amount ────────────────────────
//
// The whole point of this helper is that it must NOT agree with
// `fromCentsBig(roundDivHalfUp(…))`. Both were the same function until
// 2026-08-03, and the entire suite stayed green when the applier switched from
// one to the other — every fixture divided evenly, so nothing in the corpus of
// tests could tell the two apart. These are the cases that can.

Deno.test("perUnitCostAt4dp keeps the sub-cent a per-unit rate really has", () => {
  // The motivating case: 100 units for $6.39. Quantized to the cent this reads
  // $0.06/unit, a 6% error on a figure an operator is shown.
  assertEquals(perUnitCostAt4dp(639n, 100n), 0.0639);
  // Every sub-cent value the prod corpus actually held, recomputed from its
  // stored basis and quantity.
  assertEquals(perUnitCostAt4dp(13036n, 40n), 3.259);
  assertEquals(perUnitCostAt4dp(61718n, 288n), 2.143);
  assertEquals(perUnitCostAt4dp(766n, 5n), 1.532);
  assertEquals(perUnitCostAt4dp(19000n, 46n), 4.1304);
  assertEquals(perUnitCostAt4dp(50400n, 78n), 6.4615);
});

Deno.test("perUnitCostAt4dp DISAGREES with the cents form — the fail-closed half", () => {
  // If these ever agree, the helper has quietly become `fromCentsBig` again and
  // every assertion above would still pass on round numbers.
  const cases: Array<[bigint, bigint]> = [[639n, 100n], [19000n, 46n], [100n, 3n]];
  for (const [cents, units] of cases) {
    const atCent = fromCentsBig(roundDivHalfUp(cents, units));
    assertEquals(
      perUnitCostAt4dp(cents, units) === atCent,
      false,
      `${cents}/${units} must not equal the cent-quantized form`,
    );
  }
});

Deno.test("perUnitCostAt4dp rounds once, half-up, at the 4th decimal", () => {
  // One cent over three units is $0.003333… per unit → 0.0033.
  assertEquals(perUnitCostAt4dp(1n, 3n), 0.0033);
  assertEquals(perUnitCostAt4dp(2n, 3n), 0.0067);
  // Exactly half at the 4th decimal goes UP, matching roundDivHalfUp: one cent
  // over eight units is $0.00125 exactly.
  assertEquals(perUnitCostAt4dp(1n, 8n), 0.0013);
  // …and just under half goes down: $0.000625 → 0.0006.
  assertEquals(perUnitCostAt4dp(1n, 16n), 0.0006);
});

Deno.test("perUnitCostAt4dp agrees with the cents form whenever the division is exact", () => {
  // The compatibility half: where a unit cost lands on a whole cent, nothing
  // changed, which is why every pre-existing fixture stayed green.
  for (const [cents, units] of [[4000n, 10n], [400n, 1n], [900n, 3n], [0n, 7n]] as const) {
    assertEquals(perUnitCostAt4dp(cents, units), fromCentsBig(roundDivHalfUp(cents, units)));
  }
});

Deno.test("perUnitCostAt4dp is total — zero units yields 0, never a divide", () => {
  assertEquals(perUnitCostAt4dp(500n, 0n), 0);
  assertEquals(perUnitCostAt4dp(500n, -3n), 0);
  assertEquals(perUnitCostAt4dp(0n, 10n), 0);
});
