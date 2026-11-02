/**
 * The two refinements in `schemas/common.ts` that take a STRUCTURAL BOUND
 * rather than a schema — and are therefore the only checks in the package the
 * compiler cannot keep honest.
 *
 * Both are exercised through the schemas elsewhere (`tests/order.test.ts`), and
 * that is not the same thing. A schema test asks "does this document parse?"; a
 * document can fail to parse for a reason that has nothing to do with the arm
 * under test, and — worse — an arm that has gone *vacuous* still lets every
 * valid document parse, so a suite full of positive cases goes green over a
 * guard that stopped guarding. These call the functions directly, so each arm's
 * firing and its NOT firing are both asserted.
 */
import { assertEquals } from "@std/assert";
import { fdwPrice } from "./helpers/formulas.ts";
import { z } from "zod";
import { checkItemContract, checkLinePrice, checkLinePriceInput } from "../src/schemas/common.ts";

/** Collect the issue paths a refinement emits for one input. */
function issuePaths(
  refine: (v: never, ctx: z.RefinementCtx) => void,
  value: unknown,
): string[] {
  const schema = z.unknown().superRefine(refine as (v: unknown, ctx: z.RefinementCtx) => void);
  const r = schema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

// ── checkItemContract: the replacement axis ─────────────────────────
//
// The failure this pins is trap #6 of the cents migration: the bound names
// `price.replacement_cents`, and if a future rename moves the field without
// moving the signature, `deno check` stays green while
// `item.price?.replacement_cents` reads `undefined` forever. The `forbidden`
// arm then goes permanently vacuous — a transaction_fee could carry a
// replacement price — and `required_when_stocked` fires on every stocked
// rental. Neither is visible from a positive-case schema test.

Deno.test("checkItemContract: a stocked rental WITHOUT a replacement is rejected", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "rental",
      stock_method: "bulk",
      price: { ...fdwPrice(0, 5), replacement_cents: null },
    }),
    ["price.replacement_cents"],
  );
});

Deno.test("checkItemContract: a stocked rental WITH a replacement is accepted", () => {
  // The half a vacuous bound would break loudly, and the half that keeps the
  // arm above from being satisfiable by a bound that always fires.
  assertEquals(
    issuePaths(checkItemContract, {
      type: "rental",
      stock_method: "bulk",
      price: { ...fdwPrice(0, 5), replacement_cents: 25_000 },
    }),
    [],
  );
});

Deno.test("checkItemContract: an UNSTOCKED rental needs no replacement", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "rental",
      stock_method: "none",
      price: { ...fdwPrice(0, 5), replacement_cents: null },
    }),
    [],
  );
});

Deno.test("checkItemContract: the `forbidden` arm fires — a fee cannot carry a replacement", () => {
  // ⚠️ **This is the assertion a stale structural bound makes impossible to
  // pass.** With the bound reading a field name the schema no longer has, the
  // value below is invisible to it and this arm emits nothing.
  assertEquals(
    issuePaths(checkItemContract, {
      type: "transaction_fee",
      stock_method: "none",
      price: { price_formula: null, rates: [], counts: [], replacement_cents: 10_000 },
    }),
    ["price.replacement_cents"],
  );
});

Deno.test("checkItemContract: a fee WITHOUT a replacement is accepted", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "transaction_fee",
      stock_method: "none",
      price: { price_formula: null, rates: [], counts: [] },
    }),
    [],
  );
});

Deno.test("checkItemContract: a percent-of-total price is refused on a non-fee line", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "sale",
      stock_method: "none",
      price: { price_formula: null, rates: [], counts: [], base_percent: 3 },
    }),
    ["price.base_percent"],
  );
});

// ── checkLinePrice: a formula, or a percentage of the document — exactly one ──
//
// `price.base` once carried two units — a per-unit dollar amount on every line,
// and a PERCENTAGE of the document total on a percent fee — discriminated only
// by a sibling. Since ruling 8 a line prices from a formula snapshot (rates and
// counts) or, only on a fee, from `base_percent`, and this refinement is what
// keeps the two from mixing.

const FDW = { uid: "FiveDayWeekFormu1aAA", name: "Five-day week", basis: "time" as const };

Deno.test("checkLinePrice: a percent fee carries base_percent and NO formula, rates or counts", () => {
  assertEquals(issuePaths(checkLinePrice, { price_formula: null, rates: [], counts: [], base_percent: 2.9 }), []);
  // The exact 100× the split exists to prevent: a percentage beside a rate.
  assertEquals(
    issuePaths(checkLinePrice, { price_formula: null, rates: [{ rate_key: "flat", amount_cents: 290 }], counts: [], base_percent: 2.9 }),
    ["rates"],
  );
  assertEquals(issuePaths(checkLinePrice, { price_formula: FDW, rates: [], counts: [], base_percent: 2.9 }), ["price_formula"]);
});

Deno.test("checkLinePrice: a line priced from itself names its formula", () => {
  assertEquals(issuePaths(checkLinePrice, { price_formula: FDW, rates: [{ rate_key: "week", amount_cents: 10_000 }], counts: [] }), []);
  assertEquals(issuePaths(checkLinePrice, { price_formula: null, rates: [], counts: [], base_percent: null }), ["price_formula"]);
  // An INPUT may omit the formula — the writer resolves it from the product.
  assertEquals(issuePaths(checkLinePriceInput, { rates: [{ rate_key: "week", amount_cents: 1 }] }), []);
});

Deno.test("checkLinePriceInput: two spellings of the formula must name the SAME formula", () => {
  const rates = [{ rate_key: "week", amount_cents: 1 }];
  // A stored-form echo names its formula by the snapshot alone, and that is legal.
  assertEquals(issuePaths(checkLinePriceInput, { price_formula: FDW, rates }), []);
  // Both spellings, agreeing — legal.
  assertEquals(issuePaths(checkLinePriceInput, { uid_price_formula: FDW.uid, price_formula: FDW, rates }), []);
  // Both spellings, disagreeing — one of them is a client bug; refuse rather than pick.
  assertEquals(
    issuePaths(checkLinePriceInput, { uid_price_formula: "FixedPriceFormula000", price_formula: FDW, rates }),
    ["price_formula.uid"],
  );
  // The snapshot spelling still feeds the percent-xor-formula rule.
  assertEquals(issuePaths(checkLinePriceInput, { price_formula: FDW, base_percent: 2.9 }), ["price_formula"]);
});

Deno.test("checkLinePrice: an absent price is not an error", () => {
  // The refinement runs on optional price objects; `null`/`undefined` is the
  // caller's business, not a shape violation.
  assertEquals(issuePaths(checkLinePrice, null), []);
});

