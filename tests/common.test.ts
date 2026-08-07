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
import { z } from "zod";
import { checkItemContract, checkPriceBaseUnit } from "../src/schemas/common.ts";

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
      price: { formula: "five_day_week", replacement_cents: null },
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
      price: { formula: "five_day_week", replacement_cents: 25_000 },
    }),
    [],
  );
});

Deno.test("checkItemContract: an UNSTOCKED rental needs no replacement", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "rental",
      stock_method: "none",
      price: { formula: "five_day_week", replacement_cents: null },
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
      price: { formula: "percent_of_total", replacement_cents: 10_000 },
    }),
    ["price.replacement_cents"],
  );
});

Deno.test("checkItemContract: a fee WITHOUT a replacement is accepted", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "transaction_fee",
      stock_method: "none",
      price: { formula: "percent_of_total" },
    }),
    [],
  );
});

Deno.test("checkItemContract: percent_of_total is refused on a non-fee line", () => {
  assertEquals(
    issuePaths(checkItemContract, {
      type: "sale",
      stock_method: "none",
      price: { formula: "percent_of_total" },
    }),
    ["price.formula"],
  );
});

// ── checkPriceBaseUnit: D1's exactly-one-of ─────────────────────────
//
// `price.base` used to carry two units — a per-unit dollar amount on every
// line, and a PERCENTAGE of the document total on a `percent_of_total` fee.
// One field, two units, discriminated only by a sibling. The split puts the
// unit in the name; this is what makes the split enforceable rather than a
// convention.

Deno.test("checkPriceBaseUnit: a percent_of_total price REQUIRES base_percent", () => {
  assertEquals(
    issuePaths(checkPriceBaseUnit, { formula: "percent_of_total", base_cents: 0 }),
    ["base_percent"],
  );
});

Deno.test("checkPriceBaseUnit: a percent_of_total price must NOT carry money in base_cents", () => {
  // The exact 100× D1 exists to prevent: 2.9 stored as `base_cents: 290` and
  // read back as $2.90 instead of 2.9%.
  assertEquals(
    issuePaths(checkPriceBaseUnit, {
      formula: "percent_of_total",
      base_cents: 290,
      base_percent: 2.9,
    }),
    ["base_cents"],
  );
});

Deno.test("checkPriceBaseUnit: a well-formed percent fee is accepted", () => {
  assertEquals(
    issuePaths(checkPriceBaseUnit, {
      formula: "percent_of_total",
      base_cents: 0,
      base_percent: 2.9,
    }),
    [],
  );
});

Deno.test("checkPriceBaseUnit: base_percent is refused on every other formula", () => {
  // The converse direction, and the one a one-sided check would miss: a stray
  // percentage sitting on an ordinary line is exactly as ambiguous as the
  // original overload was.
  for (const formula of ["five_day_week", "fixed"]) {
    assertEquals(
      issuePaths(checkPriceBaseUnit, { formula, base_cents: 10_000, base_percent: 2.9 }),
      ["base_percent"],
      `base_percent should be refused on "${formula}"`,
    );
  }
});

Deno.test("checkPriceBaseUnit: an ordinary priced line is accepted", () => {
  for (const formula of ["five_day_week", "fixed"]) {
    assertEquals(
      issuePaths(checkPriceBaseUnit, { formula, base_cents: 10_000 }),
      [],
      `an ordinary "${formula}" line should pass`,
    );
  }
});

Deno.test("checkPriceBaseUnit: an absent price is not an error", () => {
  // The refinement runs on optional price objects; `null`/`undefined` is the
  // caller's business, not a unit violation.
  assertEquals(issuePaths(checkPriceBaseUnit, null), []);
  assertEquals(issuePaths(checkPriceBaseUnit, undefined), []);
});
