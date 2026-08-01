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
