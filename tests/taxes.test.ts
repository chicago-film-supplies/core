import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues, OrderDocLineItem } from "../src/schemas/mod.ts";
import {
  findTaxAt,
  getEffectiveProfileTax,
  overrideItemTaxesForProfile,
} from "../src/utils/taxes.ts";
import type { LineItem, Tax } from "../src/utils/orders.ts";

const lineItemBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
const priceBase = lineItemBase.price as Record<string, unknown>;

// Catalog carrying the validity window (findTaxAt needs it); other fields
// intentionally omitted to exercise the widened optional Tax type.
const CATALOG: Tax[] = [
  {
    uid: "frankfort-tax",
    name: "Frankfort Sales Tax",
    rate: 8,
    type: "percent",
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
  },
  {
    uid: "rantoul-tax",
    name: "Rantoul Sales Tax",
    rate: 9,
    type: "percent",
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
  },
];

const AS_OF = "2026-07-02T00:00:00.000-05:00";

function makeItem(
  overrides: Partial<LineItem> = {},
  priceOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    ...lineItemBase,
    name: "Test Item",
    type: "rental",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      base: 100,
      chargeable_days: 5,
      subtotal: 100,
      subtotal_discounted: 100,
      total: 115,
      taxes: [{
        uid: "chi-rental-tax",
        name: "Chicago Rental Tax",
        rate: 15,
        type: "percent",
        amount: 15,
      }],
      ...priceOverrides,
    },
  } as LineItem;
}

// ── findTaxAt ────────────────────────────────────────────────────

Deno.test("findTaxAt resolves by name within the validity window", () => {
  const tax = findTaxAt(CATALOG, "Frankfort Sales Tax", AS_OF);
  assertEquals(tax?.uid, "frankfort-tax");
});

Deno.test("findTaxAt returns null when asOf precedes valid_from", () => {
  assertEquals(findTaxAt(CATALOG, "Frankfort Sales Tax", "2025-06-01T00:00:00.000-05:00"), null);
});

Deno.test("findTaxAt treats null valid_to as open-ended", () => {
  const tax = findTaxAt(CATALOG, "Frankfort Sales Tax", "2030-01-01T00:00:00.000-06:00");
  assertEquals(tax?.uid, "frankfort-tax");
});

Deno.test("findTaxAt throws on catalog drift (two same-name docs bracket asOf)", () => {
  const drifted: Tax[] = [
    ...CATALOG,
    { uid: "frankfort-dupe", name: "Frankfort Sales Tax", rate: 8, type: "percent", valid_from: "2026-01-01T00:00:00.000-06:00", valid_to: null },
  ];
  assertThrows(() => findTaxAt(drifted, "Frankfort Sales Tax", AS_OF), Error, "drift");
});

// ── getEffectiveProfileTax (precedence) ──────────────────────────

Deno.test("getEffectiveProfileTax: tax_exempt wins over a location profile", () => {
  assertEquals(getEffectiveProfileTax("tax_rantoul", "tax_exempt", CATALOG, AS_OF), "exempt");
});

Deno.test("getEffectiveProfileTax: doc-level tax_frankfort resolves the Frankfort tax", () => {
  const r = getEffectiveProfileTax("tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(typeof r === "object" && r?.uid, "frankfort-tax");
});

Deno.test("getEffectiveProfileTax: org-level tax_rantoul resolves the Rantoul tax", () => {
  const r = getEffectiveProfileTax("tax_rantoul", "tax_applied", CATALOG, AS_OF);
  assertEquals(typeof r === "object" && r?.uid, "rantoul-tax");
});

Deno.test("getEffectiveProfileTax: tax_applied → null (no override)", () => {
  assertEquals(getEffectiveProfileTax("tax_applied", "tax_applied", CATALOG, AS_OF), null);
});

// ── overrideItemTaxesForProfile ──────────────────────────────────

// LineItem.price is a union (priceable vs transaction-fee); narrow for asserts.
const px = (it: LineItem) =>
  it.price as {
    taxes: Array<{ uid: string; name: string; rate: number; type: string; amount: number }>;
    total: number;
  };

Deno.test("override tax_frankfort replaces item tax with 8% Frankfort + updates total", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, [{
    uid: "frankfort-tax",
    name: "Frankfort Sales Tax",
    rate: 8,
    type: "percent",
    amount: 8,
  }]);
  assertEquals(px(items[0]).total, 108);
});

Deno.test("override tax_exempt empties taxes and sets total to subtotal_discounted", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_exempt", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total, 100);
});

Deno.test("override tax_applied leaves the item untouched (Chicago default kept)", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].uid, "chi-rental-tax");
  assertEquals(px(items[0]).total, 115);
});

Deno.test("override skips non-priceable (group) items", () => {
  const group = { ...lineItemBase, type: "group", name: "Section", uid: "grp-1" } as unknown as LineItem;
  const items = [group, makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals((items[0] as LineItem).type, "group");
  assertEquals(px(items[1]).taxes[0].uid, "frankfort-tax");
});

// ── COA gate on the profile-override path ────────────────────────
//
// `overrideItemTaxesForProfile` was the SECOND place the taxability rule was
// missing. Clean A/B from prod: #1647 (`tax_applied`) held a Delivery line with
// `taxes: []`, while #2051 (`tax_rantoul`) carried the same product at the same
// COA with a 9% tax — so the location override re-taxed exactly the lines the
// Xero push then stripped to `NONE`.

Deno.test("override does NOT re-tax a non-revenue COA under a location profile", () => {
  const items = [makeItem({ coa_revenue: 4100 })];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total, 100, "total is the untaxed subtotal");
});

Deno.test("override still applies the location profile on a revenue COA", () => {
  // The discriminating half: same profile, same line, only `coa_revenue` differs.
  // Without it the test above would pass against a function that taxed nothing.
  const items = [makeItem({ coa_revenue: 4000 })];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes.length, 1);
  assertEquals(px(items[0]).total, 108);
});

Deno.test("override leaves an absent COA taxable (order lines carry none)", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes.length, 1);
});
