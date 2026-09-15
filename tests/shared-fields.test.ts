import { assert, assertEquals } from "@std/assert";
import { FulfillmentSchema, getInitialValues, InvoiceSchema, OrderDocLineItem, OrderSchema } from "../src/schemas/mod.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type PriceDocumentContext, priceDocument } from "../src/utils/price-document.ts";
import { classifySharedFields, type SharedFieldClassification } from "../src/utils/shared-fields.ts";
import type { TaxCatalog } from "../src/utils/tax-classes.ts";
import { type LegacyTax, type LegacyTaxRow, migrateLegacyTaxCatalog } from "./helpers/legacyTaxCatalog.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const render = (c: SharedFieldClassification) => c.fields.map((f) => `${f.kind} ${f.path}`);

// ── The snapshot: every key the order shares, and how it propagates ──────────
//
// 🔴 This is the guard `propagate: false` needs. That tag has the unsafe default:
// an untagged new HOMONYM (same key, different meaning) reads `propagated`, and
// the sync would copy the order's value into it. So any new shared key, at any
// level, fails here until someone decides which kind it is — tag the schema
// field, then update the literal.

const DATES = [
  "propagated destinations[].dates.delivery_start",
  "derived destinations[].dates.delivery_start_fs",
  "propagated destinations[].dates.delivery_end",
  "derived destinations[].dates.delivery_end_fs",
  "propagated destinations[].dates.collection_start",
  "derived destinations[].dates.collection_start_fs",
  "propagated destinations[].dates.collection_end",
  "derived destinations[].dates.collection_end_fs",
  "propagated destinations[].dates.charge_start",
  "derived destinations[].dates.charge_start_fs",
  "propagated destinations[].dates.charge_end",
  "derived destinations[].dates.charge_end_fs",
  "derived destinations[].dates.days_active",
  "derived destinations[].dates.days_charged",
  "atom destinations[].delivery",
  "atom destinations[].collection",
  "propagated destinations[].customer_collecting",
  "propagated destinations[].customer_returning",
  "propagated destinations[].jurisdiction",
];

Deno.test("classifySharedFields: order → invoice, every shared key and its kind", () => {
  const c = classifySharedFields(OrderSchema, InvoiceSchema);
  assertEquals(c.unhandled, []);
  assertEquals(c.rows, ["destinations[]", "items[]"]);
  assertEquals(render(c), [
    "homonym uid",
    "homonym number",
    "homonym status",
    "atom organization",
    ...DATES,
    "propagated items[].type",
    "propagated items[].name",
    "propagated items[].description",
    "propagated items[].quantity",
    "propagated items[].zero_priced",
    "propagated items[].price.base_cents",
    "propagated items[].price.base_percent",
    "propagated items[].price.chargeable_days",
    "propagated items[].price.formula",
    "derived items[].price.subtotal_cents",
    "derived items[].price.subtotal_discounted_cents",
    "propagated items[].price.discount.rate",
    "propagated items[].price.discount.type",
    "derived items[].price.discount.amount_cents",
    "derived items[].price.taxes",
    "derived items[].price.taxes_base",
    "derived items[].price.total_cents",
    "homonym items[].crms_id",
    "propagated items[].coa_revenue",
    "propagated items[].uid_tax_class",
    "propagated items[].uid_tax_class_override",
    "propagated tax_exempt",
    "propagated uid_store",
    "derived totals",
    "homonym crms_id",
    "propagated subject",
    "propagated reference",
    "homonym xero_id",
    "homonym uid_thread",
    "homonym version",
    "homonym created_by",
    "homonym updated_by",
    "homonym created_at",
    "homonym updated_at",
  ]);
});

Deno.test("classifySharedFields: order → fulfillment, every shared key and its kind", () => {
  const c = classifySharedFields(OrderSchema, FulfillmentSchema);
  assertEquals(c.unhandled, []);
  assertEquals(c.rows, ["destinations[]", "items[]"]);
  assertEquals(render(c), [
    "homonym uid",
    "homonym number",
    "homonym status",
    "atom organization",
    ...DATES,
    "propagated items[].type",
    "propagated items[].name",
    "propagated items[].description",
    "propagated items[].quantity",
    "propagated items[].zero_priced",
    "propagated items[].stock_method",
    "propagated items[].order_number",
    "propagated items[].uid_order",
    "derived query_by_items",
    "derived query_by_contacts",
    "derived query_by_dates",
    "propagated subject",
    "propagated reference",
    "homonym version",
    "homonym created_at",
    "homonym updated_at",
  ]);
});

// ── The derived tags match what the pricer writes ────────────────────────────
//
// A `derived` tag is a claim that a derivation WRITES the key. Declared by hand,
// it could drift from the code in two directions, and both are silent:
//   - a tagged key the pricer does not write is never compared and never
//     recomputed, so an operator's edit to it is lost;
//   - an untagged key the pricer does write is compared, and the invoice's own
//     tax context makes it read as an override forever (G2).
// So price a line whose every leaf holds a sentinel, and require the set of
// price leaves that changed to EQUAL the tagged set.

const CAT: TaxCatalog = (() => {
  const rows: LegacyTax[] = [
    { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", jurisdiction: "chicago", item_types: ["rental"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: null },
  ];
  let n = 0;
  return migrateLegacyTaxCatalog(
    rows.map((t) => ({ crms_id: null, effective_from: null, applied_from_fs: mockTimestamp, applied_to_fs: null, xero_components: [], xero_tax_type: null, xero_account_code: null, xero_item_code: null, version: 0, ...t }) as unknown as LegacyTaxRow),
    { codes: [], rates: [], classes: [] },
    { actor: { uid: "testuser100000000000", name: "Test User" }, now: mockTimestamp, mintUid: () => `fixture${String(++n).padStart(13, "0")}` },
  );
})();

const ctx: PriceDocumentContext = {
  document: { kind: "order" },
  tax: {
    destinations: [{ uid: null, jurisdiction: undefined, delivery: { uid: null, address: { city: "Chicago", region: "IL" } } }],
    origin: "chicago",
    exempt: false,
    catalog: CAT,
    asOf: "2026-07-02T00:00:00.000-05:00",
  },
};

/** Flatten an object to `a.b.c` leaves; arrays are one value. */
function leaves(v: unknown, base = "", out = new Map<string, string>()): Map<string, string> {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) leaves(x, base ? `${base}.${k}` : k, out);
  } else {
    out.set(base, JSON.stringify(v));
  }
  return out;
}

/** The derived price leaves the classification claims, relative to `price`. */
function taggedPriceLeaves(c: SharedFieldClassification): Set<string> {
  const prefix = "items[].price.";
  return new Set(c.fields.filter((f) => f.kind === "derived" && f.path.startsWith(prefix)).map((f) => f.path.slice(prefix.length)));
}

/** Keys the pricer changed that the tags do not claim, and tags it did not write. */
function derivedMismatches(tagged: ReadonlySet<string>): { untagged: string[]; unwritten: string[] } {
  const SENTINEL = -777;
  const lineBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
  const input = {
    ...lineBase,
    uid: "line-1",
    name: "Chair",
    type: "rental",
    quantity: 3,
    path: ["line-1"],
    price: {
      ...(lineBase.price as Record<string, unknown>),
      base_cents: 10000,
      base_percent: null,
      chargeable_days: 5,
      formula: "five_day_week",
      discount: { type: "percent", rate: 10, amount_cents: SENTINEL },
      subtotal_cents: SENTINEL,
      subtotal_discounted_cents: SENTINEL,
      taxes: [{ uid: "sentinel", name: "Sentinel", rate: 1, type: "percent", amount_cents: SENTINEL }],
      taxes_base: [{ uid: "sentinel", name: "Sentinel", rate: 1, type: "percent" }],
      total_cents: SENTINEL,
    },
  } as unknown as LineItem;

  const before = leaves(input.price);
  const after = leaves(priceDocument([input], ctx).items[0].price);
  const changed = new Set([...after.keys()].filter((k) => before.get(k) !== after.get(k)));
  for (const k of before.keys()) if (!after.has(k)) changed.add(k);

  // Everything outside `price` must be untouched — this pricer writes nothing else.
  const outsideBefore = leaves({ ...input, price: null });
  const outsideAfter = leaves({ ...priceDocument([input], ctx).items[0], price: null });
  for (const [k, v] of outsideAfter) if (outsideBefore.get(k) !== v) changed.add(`<outside price> ${k}`);

  return {
    untagged: [...changed].filter((k) => !tagged.has(k)).sort(),
    unwritten: [...tagged].filter((k) => !changed.has(k)).sort(),
  };
}

Deno.test("classifySharedFields: the derived price tags are EXACTLY what priceDocument writes", () => {
  const tagged = taggedPriceLeaves(classifySharedFields(OrderSchema, InvoiceSchema));
  // Anti-vacuity: the check has something to compare.
  assert(tagged.size >= 5, `expected the price money tags, got ${[...tagged]}`);
  assertEquals(derivedMismatches(tagged), { untagged: [], unwritten: [] });
});

Deno.test("classifySharedFields: companion — the derived check FAILS when a tag is missing or extra", () => {
  const tagged = taggedPriceLeaves(classifySharedFields(OrderSchema, InvoiceSchema));

  const missing = new Set(tagged);
  missing.delete("total_cents");
  assertEquals(derivedMismatches(missing).untagged, ["total_cents"]);

  const extra = new Set(tagged).add("base_cents");
  assertEquals(derivedMismatches(extra).unwritten, ["base_cents"]);
});
