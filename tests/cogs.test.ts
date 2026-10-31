/**
 * The cost model (`utils/cogs.ts`): the derived sale default, and the
 * activation entries — a formula reference plus dated rates
 * (purchases-as-documents D4). The period cut these tests used to pin retired
 * with `billablePeriods`; the formula engine's own sweeps are
 * `tests/price-formulas.test.ts`.
 */
import { assert, assertEquals } from "@std/assert";
import {
  cogsActivationEntriesByProvider,
  cogsActivationEntry,
  DEFAULT_SALE_COA_COST,
  effectiveCogs,
} from "../src/utils/cogs.ts";
import { type CogsActivationEntryType, CogsEntry, ProductSchema, UpdateProductInput } from "../src/schemas/mod.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const FEB_2025 = "2025-02-01T00:00:00.000-06:00";
const WEEK: CogsActivationEntryType = {
  trigger: "activation",
  uid: "5f1d1b62-2c1a-4e8b-9d0e-7a6b5c4d3e2f",
  label: "Vision hotspot line",
  coa_cost: 5100,
  provider: { uid: "VisionComms000000000", name: "Vision Communications" },
  ownership: "supplier",
  uid_price_formula: "VisionWeeklyFormula0",
  // Vision's three rows (D4): `week` open; `month` $135 to 2025-02, $157.50 from.
  rates: [
    { uid: "0f1e2d3c-4b5a-4968-8776-655443322110", rate_key: "week", amount_cents: 4500, applied_from: "2023-01-01T00:00:00.000-06:00", applied_to: null },
    { uid: "1f1e2d3c-4b5a-4968-8776-655443322110", rate_key: "month", amount_cents: 13500, applied_from: "2023-01-01T00:00:00.000-06:00", applied_to: FEB_2025 },
    { uid: "2f1e2d3c-4b5a-4968-8776-655443322110", rate_key: "month", amount_cents: 15750, applied_from: FEB_2025, applied_to: null },
  ],
};
const MONTH: CogsActivationEntryType = {
  ...WEEK,
  uid: "8a7b6c5d-4e3f-4a1b-9c2d-1e0f9a8b7c6d",
  label: "Verizon line",
  coa_cost: 5150,
  provider: { uid: "Verizon0000000000000", name: "Verizon" },
  ownership: "cfs",
  uid_price_formula: "VerizonMonthlyFormul",
  rates: [
    { uid: "3f1e2d3c-4b5a-4968-8776-655443322110", rate_key: "month", amount_cents: 8000, applied_from: "2024-01-01T00:00:00.000-06:00", applied_to: null },
  ],
};

// ── effectiveCogs ────────────────────────────────────────────────────

Deno.test("effectiveCogs: a sale product with no sale entry relieves to the derived 5000 default", () => {
  const got = effectiveCogs({ type: "sale" });
  assertEquals(got, [{ trigger: "sale", formula: "average_cost", label: "Inventory relief", coa_cost: DEFAULT_SALE_COA_COST }]);
  assertEquals(DEFAULT_SALE_COA_COST, 5000, "byte-identical to the literal the Xero item body sent");
});

Deno.test("effectiveCogs: a stored sale entry wins; a rental gets no sale default; activation entries pass through", () => {
  const own = { trigger: "sale" as const, formula: "average_cost" as const, label: "Packaging", coa_cost: 5600 as const };
  assertEquals(effectiveCogs({ type: "sale", cogs: [own] }), [own]);
  assertEquals(effectiveCogs({ type: "rental" }), []);
  assertEquals(effectiveCogs({ type: "rental", cogs: [WEEK] }), [WEEK]);
  assertEquals(effectiveCogs({ type: "sale", cogs: [WEEK] }).map((e) => e.trigger), ["sale", "activation"]);
});

Deno.test("cogsActivationEntry: finds by uid, never a sale entry", () => {
  assertEquals(cogsActivationEntry({ cogs: [WEEK, MONTH] }, MONTH.uid), MONTH);
  assertEquals(cogsActivationEntry({ cogs: [WEEK] }, MONTH.uid), undefined);
  assertEquals(cogsActivationEntry({}, WEEK.uid), undefined);
});

// ── the schema ───────────────────────────────────────────────────────

Deno.test("CogsEntry: the union makes provider, ownership, formula, rates and uid required on activation and absent on sale", () => {
  assert(CogsEntry.safeParse(WEEK).success);
  assert(CogsEntry.safeParse({ trigger: "sale", formula: "average_cost", label: "Relief", coa_cost: 5000 }).success);
  const { rates: _r, ...noRates } = WEEK;
  assert(!CogsEntry.safeParse(noRates).success, "an activation entry states its rates");
  assert(!CogsEntry.safeParse({ ...WEEK, rates: [] }).success, "at least one rate");
  const { uid_price_formula: _f, ...noFormula } = WEEK;
  assert(!CogsEntry.safeParse(noFormula).success, "an activation entry names its formula");
  assert(!CogsEntry.safeParse({ trigger: "sale", formula: "average_cost", label: "R", coa_cost: 5000, provider: WEEK.provider }).success);
  assert(!CogsEntry.safeParse({ ...WEEK, coa_cost: 6201 }).success, "6201 is not a Direct Costs account");
  assert(!CogsEntry.safeParse({ ...WEEK, rate_cents: 4500 }).success, "the retired rate_cents key is refused");
});

Deno.test("CogsEntry: dated rates per key leave no gap, never overlap, and only the last may be open", () => {
  const [week, month1, month2] = WEEK.rates;
  const paths = (rates: unknown[]) => {
    const r = CogsEntry.safeParse({ ...WEEK, rates });
    return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
  };
  assertEquals(paths([month2, week, month1]), [], "rows need not be stored in date order");
  assertEquals(paths([week, { ...month1, applied_to: null }, month2]), ["rates.1.applied_to"], "an earlier open row");
  assertEquals(paths([week, { ...month1, applied_to: "2025-01-15T00:00:00.000-06:00" }, month2]), ["rates.2.applied_from"], "a gap");
  assertEquals(paths([week, { ...month1, applied_to: "2025-03-01T00:00:00.000-06:00" }, month2]), ["rates.2.applied_from"], "an overlap");
  assertEquals(paths([week, { ...month1, applied_to: month1.applied_from }]), ["rates.1.applied_to"], "a row ends after it starts");
  assertEquals(paths([week, { ...month1, uid: week.uid }, month2]), ["rates.1.uid"]);
});

Deno.test("cogsActivationEntriesByProvider: the entries naming that supplier as provider (D5 auto-link)", () => {
  assertEquals(cogsActivationEntriesByProvider({ cogs: [WEEK, MONTH] }, "Verizon0000000000000"), [MONTH]);
  assertEquals(cogsActivationEntriesByProvider({ cogs: [WEEK] }, "Verizon0000000000000"), []);
  assertEquals(cogsActivationEntriesByProvider({}, "Verizon0000000000000"), []);
});

Deno.test("Product.cogs: absent-only, one sale entry at most, activation uids unique", () => {
  const product = getTestDoc(ProductSchema, {}, { now: mockTimestamp });
  assertEquals("cogs" in product, false, "a fixture states no cost rules");
  assert(ProductSchema.safeParse({ ...product, cogs: [WEEK, MONTH] }).success);
  const sale = { trigger: "sale", formula: "average_cost", label: "R", coa_cost: 5000 };
  assert(!ProductSchema.safeParse({ ...product, cogs: [sale, sale] }).success);
  assert(!ProductSchema.safeParse({ ...product, cogs: [WEEK, { ...MONTH, uid: WEEK.uid }] }).success);
  assert(!ProductSchema.safeParse({ ...product, cogs: null }).success, "storage never holds null");
});

Deno.test("Product.uid_superseded_by: absent-only, and never itself", () => {
  const product = getTestDoc(ProductSchema, {}, { now: mockTimestamp });
  assert(ProductSchema.safeParse({ ...product, uid_superseded_by: "SurvivorProduct00000" }).success);
  const self = ProductSchema.safeParse({ ...product, uid_superseded_by: product.uid });
  assert(!self.success);
  assertEquals(self.error.issues.map((i) => i.path.join(".")), ["uid_superseded_by"]);
});

Deno.test("UpdateProductInput: null clears cogs and the supersession pointer; self-reference is refused", () => {
  const base = { uid: "ProductUid0000000000", version: 1 };
  assert(UpdateProductInput.safeParse({ ...base, cogs: null, uid_superseded_by: null }).success);
  assert(UpdateProductInput.safeParse({ ...base, cogs: [{ ...WEEK, stray: 1 }] }).success, "an input strips unknown keys");
  assert(!UpdateProductInput.safeParse({ ...base, uid_superseded_by: base.uid }).success);
});
