import { assert, assertEquals } from "@std/assert";
import { DOC_LINE_ITEM_TYPES } from "../src/schemas/common.ts";
import {
  PriceFormulaDefaultsSchema,
  PricingSettingsSchema,
  UpdatePricingSettingsInputSchema,
} from "../src/schemas/pricing-settings.ts";
import { schemas } from "../src/schemas/mod.ts";
import { defaultPriceFormulaFor } from "../src/utils/price-formulas.ts";
import { FIXED, VISION } from "./helpers/formulas.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const actor = { uid: "manager-bot", name: "Manager Bot" };
const defaults = {
  rental: VISION.uid,
  replacement: FIXED.uid,
  sale: FIXED.uid,
  service: FIXED.uid,
  surcharge: FIXED.uid,
  transaction_fee: null,
};
const doc = {
  uid: "pricing",
  price_formula_defaults: defaults,
  version: 0,
  created_by: actor,
  updated_by: actor,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};
const billing = { ...doc, uid: "billing", oos_charge_products: { cleaning: null, maintenance: null } };
delete (billing as Record<string, unknown>).price_formula_defaults;

Deno.test("PricingSettingsSchema: the singleton, every line type a key, a default may be null", () => {
  assertEquals(PricingSettingsSchema.safeParse(doc).success, true);
  assertEquals(PricingSettingsSchema.safeParse({ ...doc, uid: "billing" }).success, false);
  const { surcharge: _, ...missing } = defaults;
  assertEquals(PricingSettingsSchema.safeParse({ ...doc, price_formula_defaults: missing }).success, false, "every type is stated");
  assertEquals(PricingSettingsSchema.safeParse({ ...doc, price_formula_defaults: { ...defaults, kit: null } }).success, false);
  assertEquals(PricingSettingsSchema.safeParse({ ...doc, price_formula_defaults: { ...defaults, rental: "short" } }).success, false);
});

Deno.test("PriceFormulaDefaultsSchema's keys are exactly DOC_LINE_ITEM_TYPES — a seventh type cannot go unset silently", () => {
  const all = Object.fromEntries(DOC_LINE_ITEM_TYPES.map((t) => [t, null]));
  assertEquals(PriceFormulaDefaultsSchema.safeParse(all).success, true);
  for (const t of DOC_LINE_ITEM_TYPES) {
    const { [t]: _, ...less } = all;
    assertEquals(PriceFormulaDefaultsSchema.safeParse(less).success, false, `${t} is required`);
  }
});

Deno.test("the settings registry entry is the union: billing and pricing each parse, a hybrid does not", () => {
  assert(schemas.settings.safeParse(doc).success);
  assert(schemas.settings.safeParse(billing).success);
  assert(!schemas.settings.safeParse({ ...doc, oos_charge_products: { cleaning: null, maintenance: null } }).success);
  assert(!schemas.settings.safeParse({ ...billing, uid: "pricing" }).success);
});

Deno.test("UpdatePricingSettingsInputSchema carries the version and refuses stored-only fields", () => {
  assert(UpdatePricingSettingsInputSchema.safeParse({ price_formula_defaults: defaults, version: 0 }).success);
  assert(!UpdatePricingSettingsInputSchema.safeParse({ price_formula_defaults: defaults, version: 0, uid: "pricing" }).success);
});

Deno.test("defaultPriceFormulaFor: the named, loaded, active formula — else null, never a throw", () => {
  const formulas = new Map([[VISION.uid, { ...VISION, active: true }], [FIXED.uid, { ...FIXED, active: true }]]);
  assertEquals(defaultPriceFormulaFor(doc, formulas, "rental")?.uid, VISION.uid);
  assertEquals(defaultPriceFormulaFor(doc, formulas, "sale")?.uid, FIXED.uid);
  assertEquals(defaultPriceFormulaFor(doc, formulas, "transaction_fee"), null, "a null default");
  assertEquals(defaultPriceFormulaFor(null, formulas, "rental"), null, "no settings document");
  assertEquals(defaultPriceFormulaFor(doc, new Map(), "rental"), null, "a formula the caller did not load");
  const retired = new Map([[VISION.uid, { ...VISION, active: false }]]);
  assertEquals(defaultPriceFormulaFor(doc, retired, "rental"), null, "a retired formula is no default");
});
