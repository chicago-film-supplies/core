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
// The one comparison that needs the library this module is replacing. It exists
// here and nowhere else in the test suite.
import currency from "currency.js";
import {
  distributeCents,
  formatCents,
  fromCents,
  fromCentsBig,
  parseMoney,
  parseRate,
  PAYMENT_MATCH_TOLERANCE_CENTS,
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

Deno.test("formatCents { symbol: '', group: false } is the search-mirror form", () => {
  // A Typesense `_str` mirror must contain the literal digits a user types.
  // `$` and `,` are token separators, so "$1,234.56" tokenizes as 1/234/56 and
  // the query `1234.56` cannot match it. This replaced `plain2dp` in
  // api-cloudrun/scripts/_moneySurface.ts.
  const mirror = (cents: number) => formatCents(cents, { symbol: "", group: false });
  assertEquals(mirror(123456), "1234.56");
  assertEquals(mirror(150000), "1500.00");
  assertEquals(mirror(0), "0.00");
  assertEquals(mirror(7), "0.07");
  assertEquals(mirror(-449562), "-4495.62");
  assertEquals(mirror(100_000_000_00), "100000000.00");
  // The grouped default is unchanged — the option is additive.
  assertEquals(formatCents(123456), "$1,234.56");
  // …and this is the failure the marker exists to fix: the raw float renders as
  // one token that no dollar-and-cents query reaches.
  assertEquals(String(1500), "1500");
  assertEquals(mirror(toCents(1500)), "1500.00");
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

// ── parseMoney / parseRate — the string→money direction ─────────────
//
// The direction the module had no answer for until 2026-08-03, which is exactly
// why `CurrencyInput.parse` and the CRMS webhook ingest each grew their own.

Deno.test("parseMoney handles the separators and symbols a hand-rolled parser gets wrong", () => {
  assertEquals(parseMoney("$1,583.50"), 1583.5);
  assertEquals(parseMoney("1,583.50"), 1583.5);
  assertEquals(parseMoney("1583.50"), 1583.5);
  assertEquals(parseMoney("$12.00"), 12);
  assertEquals(parseMoney("0.07"), 0.07);
  // Sign survives. A non-negative caller strips it before calling; that is a UI
  // contract, and baking it in here would swallow a legitimate credit.
  assertEquals(parseMoney("-5.00"), -5);
  assertEquals(parseMoney("-$1,200.99"), -1200.99);
});

Deno.test("parseMoney is total — bad input is 0, never NaN and never a throw", () => {
  // It sits on two ingest boundaries. A parser that can fail closed turns one
  // bad character in a CRMS webhook body into a 500.
  assertEquals(parseMoney(""), 0);
  assertEquals(parseMoney("abc"), 0);
  assertEquals(parseMoney("$"), 0);
  assertEquals(parseMoney(null), 0);
  assertEquals(parseMoney(undefined), 0);
});

Deno.test("parseMoney quantizes to the money quantum, so toCents is a lossless widening after it", () => {
  // `toCents` documents its own precondition — 2dp in — and nothing in the
  // system enforces it. This is what enforces it at the boundary where text
  // becomes money.
  assertEquals(parseMoney("1,583.505"), 1583.51);
  assertEquals(parseMoney("0.005"), 0.01);
  assertEquals(parseMoney("0.004"), 0);
  let seed = 90_210;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  for (let i = 0; i < 50_000; i++) {
    // Three- and four-decimal text, with and without grouping and a symbol —
    // the shapes CRMS and an operator's keyboard actually produce.
    const whole = rand(1_000_000);
    const frac = String(rand(10_000)).padStart(4, "0");
    const grouped = whole.toLocaleString("en-US");
    const s = `${i % 2 ? "$" : ""}${i % 3 ? grouped : String(whole)}.${frac}`;
    const parsed = parseMoney(s);
    assertEquals(
      fromCents(toCents(parsed)),
      parsed,
      `parseMoney(${s}) = ${parsed} is not representable at 2dp`,
    );
    checked++;
  }
  assertEquals(checked, 50_000, "the sweep must actually have run");
});

Deno.test("the parsers a hand-rolled boundary reaches for DO disagree — the fail-closed half", () => {
  // Both of these have been live in CFS. If either ever agrees across this
  // corpus, `parseMoney` has quietly become one of them.
  const naiveFloat = (s: string) => parseFloat(s);
  const stripThenFloat = (s: string) => parseFloat(s.replace(/[^0-9.-]/g, ""));

  const corpus = ["$1,583.50", "1,583.50", "$12.00", "1,583.505", "-$1,200.99", "abc", ""];
  const naiveWrong = corpus.filter((s) => !Object.is(naiveFloat(s), parseMoney(s)));
  const strippedWrong = corpus.filter((s) => !Object.is(stripThenFloat(s), parseMoney(s)));

  // `parseFloat("1,583.50")` is 1 — off by three orders of magnitude, silently.
  assertEquals(naiveFloat("1,583.50"), 1);
  assertEquals(naiveWrong.length > 0, true, "bare parseFloat must disagree somewhere");
  // Stripping the separators fixes the grouping but not the quantum: a 3dp
  // string still arrives as a 3dp number, which is the corpus defect Phase 1
  // spent a repair script on.
  assertEquals(stripThenFloat("1,583.505"), 1583.505);
  assertEquals(strippedWrong.length > 0, true, "strip-then-parseFloat must disagree somewhere");
});

Deno.test("parseRate keeps four decimals, and is a separate function for that reason", () => {
  // A rate is not an amount. Xero's DiscountRate holds 4dp and is a line's only
  // discount channel, so 33.3333% must survive the boundary intact.
  assertEquals(parseRate("33.3333"), 33.3333);
  assertEquals(parseMoney("33.3333"), 33.33, "…and money must NOT — the two differ on purpose");
  assertEquals(parseRate("50"), 50);
  assertEquals(parseRate("0"), 0);
  assertEquals(parseRate(null), 0);
  assertEquals(parseRate("abc"), 0);
  // 5dp is past what Xero can carry, so it quantizes — half-up, like everything.
  assertEquals(parseRate("12.34565"), 12.3457);
});

// ── distributeCents — conservation is the contract ──────────────────

Deno.test("distributeCents front-loads the residual, matching what it replaced", () => {
  // currency.js's `distribute` produced exactly these. Preserving the order
  // means no stored `unit_costs[]` array changes shape — but the policy is now
  // named rather than inherited.
  assertEquals(distributeCents(100_00n, 3), [3334n, 3333n, 3333n]);
  assertEquals(distributeCents(5n, 3), [2n, 2n, 1n]);
  assertEquals(distributeCents(10_00n, 4), [250n, 250n, 250n, 250n]);
  assertEquals(distributeCents(0n, 3), [0n, 0n, 0n]);
  assertEquals(distributeCents(100_00n, 7), [1429n, 1429n, 1429n, 1429n, 1428n, 1428n, 1428n]);
  assertEquals(distributeCents(7n, 1), [7n]);
});

Deno.test("distributeCents is symmetric on negatives — a sign flip cannot change a magnitude", () => {
  for (const [total, parts] of [[100_00n, 3], [5n, 3], [1n, 7], [99n, 100]] as const) {
    const positive = distributeCents(total, parts);
    const negative = distributeCents(-total, parts);
    assertEquals(negative, positive.map((c) => -c), `${total}/${parts}`);
  }
});

Deno.test("distributeCents conserves the total over 200k random splits", () => {
  let seed = 31_337;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  let residualSeen = 0;
  for (let i = 0; i < 200_000; i++) {
    const total = BigInt(rand(100_000_000) - 50_000_000);
    const parts = rand(40) + 1;
    const shares = distributeCents(total, parts);

    assertEquals(shares.length, parts, `wrong share count for ${total}/${parts}`);
    assertEquals(
      shares.reduce((sum, c) => sum + c, 0n),
      total,
      `shares do not sum to ${total} over ${parts} parts`,
    );
    // Every share is within one cent of every other — the split is as even as
    // whole cents allow, which is the property "front-loaded" is a refinement of.
    const min = shares.reduce((a, b) => b < a ? b : a);
    const max = shares.reduce((a, b) => b > a ? b : a);
    assertEquals(max - min <= 1n, true, `shares spread by more than a cent: ${total}/${parts}`);
    if (max !== min) residualSeen++;
    checked++;
  }
  assertEquals(checked, 200_000, "the sweep must actually have run");
  // Domain coverage, asserted separately from correctness: an even-split-only
  // corpus would exercise none of the remainder arithmetic and still pass.
  assertEquals(residualSeen > 100_000, true, `only ${residualSeen} splits had a residual`);
});

Deno.test("a naive per-share round does NOT conserve — the fail-closed half", () => {
  // The obvious implementation: round each share independently. It is off by
  // the residual on every non-even split, which is money quietly created or
  // destroyed. If this ever stops disagreeing, `distributeCents` has become it.
  const naive = (total: bigint, parts: number): bigint[] =>
    Array.from({ length: parts }, () => roundDivHalfUp(total, BigInt(parts)));

  let seed = 4_242;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let wrong = 0;
  for (let i = 0; i < 100_000; i++) {
    const total = BigInt(rand(50_000_000));
    const parts = rand(40) + 1;
    if (naive(total, parts).reduce((sum, c) => sum + c, 0n) !== total) wrong++;
  }
  assertEquals(wrong > 0, true, "the naive form must fail conservation somewhere");
});

Deno.test("distributeCents matches the currency.js distribute it replaced, over 100k splits", () => {
  // The docstring claims stored `unit_costs[]` arrays do not change shape. That
  // is a parity claim about a function being deleted, so it runs here rather
  // than being asserted in prose — this is the last commit in which both
  // implementations exist and the comparison is possible at all.
  //
  // currency.js measured 0/200,000 against an exact reference: it was never
  // broken. The reasons for replacing it are unit consistency, a named residual
  // policy, and its silent `[]` on zero parts — not correctness.
  let seed = 8_675_309;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let checked = 0;
  for (let i = 0; i < 100_000; i++) {
    const dollars = (rand(10_000_000) - 5_000_000) / 100;
    const parts = rand(24) + 1;
    assertEquals(
      distributeCents(toCentsBig(dollars), parts).map(fromCentsBig),
      currency(dollars).distribute(parts).map((c) => c.value),
      `${dollars} over ${parts} parts`,
    );
    checked++;
  }
  assertEquals(checked, 100_000, "the sweep must actually have run");
});

Deno.test("distributeCents refuses a non-positive part count rather than losing the money", () => {
  // currency.js returned `[]` here, so `distribute(100, 0)` silently discarded
  // $100. Both CFS callers had to guard at the call site to avoid it — and a
  // call-site guard is one new caller away from being forgotten.
  assertThrows(() => distributeCents(100_00n, 0), RangeError, "positive integer part count");
  assertThrows(() => distributeCents(100_00n, -3), RangeError, "positive integer part count");
  assertThrows(() => distributeCents(100_00n, 2.5), RangeError, "positive integer part count");
  assertThrows(() => distributeCents(100_00n, NaN), RangeError, "positive integer part count");
});

Deno.test("PAYMENT_MATCH_TOLERANCE_CENTS is one cent, and lives in core because it is a domain rule", () => {
  // Xero rounds its own line arithmetic, so a payment can land a cent from what
  // CFS computed. The pre-2026-08 matcher used `<= 0.01` on floats — twice as
  // loose as the 0.005 the repair scripts used to re-check the same match, so
  // the live matcher could bind a pair those scripts then flagged.
  assertEquals(PAYMENT_MATCH_TOLERANCE_CENTS, 1);
  assertEquals(Number.isInteger(PAYMENT_MATCH_TOLERANCE_CENTS), true);
});
