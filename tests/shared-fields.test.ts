import { assert, assertEquals } from "@std/assert";
import {
  FulfillmentSchema,
  getInitialValues,
  type InvoiceDocLineItemType,
  InvoiceSchema,
  OrderDocLineItem,
  OrderSchema,
} from "../src/schemas/mod.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type PriceDocumentContext, priceDocument } from "../src/utils/price-document.ts";
import { projectOrderItemToInvoiceItem } from "../src/utils/invoices.ts";
import {
  classifySharedFields,
  fieldsUnder,
  mergeSharedFields,
  orderFulfillmentSharedFields,
  resolveMergedPairDates,
  type SharedField,
  type SharedFieldClassification,
} from "../src/utils/shared-fields.ts";
import { canonicalChargeWindows, getDuration } from "../src/utils/dates.ts";
import type { TaxCatalog } from "../src/utils/tax-classes.ts";
import { type LegacyTax, type LegacyTaxRow, migrateLegacyTaxCatalog } from "./helpers/legacyTaxCatalog.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const render = (c: SharedFieldClassification) => c.fields.map((f) => `${f.kind} ${f.path}`);

/** An order line built from the schema seed, with explicit overrides. */
function line(over: Partial<LineItem>, price: Partial<NonNullable<LineItem["price"]>>): LineItem {
  const seed = getInitialValues(OrderDocLineItem) as LineItem;
  return {
    ...seed,
    uid: "line-1",
    type: "rental",
    name: "Chair",
    quantity: 3,
    path: ["line-1"],
    uid_tax_class: "class-rental",
    ...over,
    price: { ...seed.price, base_cents: 10000, base_percent: null, chargeable_days: 5, formula: "five_day_week", taxes: [], ...price },
  } as LineItem;
}

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
  "derived destinations[].dates.charge_start",
  "derived destinations[].dates.charge_start_fs",
  "derived destinations[].dates.charge_end",
  "derived destinations[].dates.charge_end_fs",
  "derived destinations[].dates.days_active",
  "derived destinations[].dates.days_charged",
  "propagated destinations[].dates.charge_windows",
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
    "derived items[].price.chargeable_days",
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

Deno.test("orderFulfillmentSharedFields: classified once, grouped by merge unit", () => {
  const a = orderFulfillmentSharedFields();
  assert(a === orderFulfillmentSharedFields(), "memoized");
  assert(a.line.some((f) => f.path === "quantity" && f.kind === "propagated"));
  assert(a.pair.some((f) => f.path === "dates.delivery_start" && f.kind === "propagated"));
  assert(a.pair.some((f) => f.path === "jurisdiction" && f.kind === "propagated"));
  assert(a.doc.some((f) => f.path === "organization" && f.kind === "atom"));
  assert(a.doc.some((f) => f.path === "subject" && f.kind === "propagated"));
  assert(a.doc.some((f) => f.path === "reference" && f.kind === "propagated"));

  // 🔴 The fields the caller must keep copying UNCONDITIONALLY are exactly the
  // ones the merge refuses, and the two lists have to be read together or a
  // fulfillment silently stops tracking its order's number or status. Stated as
  // a set so a newly-tagged homonym fails here rather than going stale.
  assertEquals(
    a.doc.filter((f) => f.kind !== "propagated" && f.kind !== "atom").map((f) => `${f.kind} ${f.path}`),
    [
      "homonym uid",
      "homonym number",
      "homonym status",
      "derived query_by_items",
      "derived query_by_contacts",
      "derived query_by_dates",
      "homonym version",
      "homonym created_at",
      "homonym updated_at",
    ],
  );
});

// 🔴 A fulfillment pair needs NO projection, and that is a schema fact worth a
// test rather than a comment: `Fulfillment.destinations` is the order's own
// `DocDestination`, so all three arguments to `mergeSharedFields` are already in
// the downstream shape. If that ever stops being true, the merge silently starts
// comparing an order-shaped pair against a fulfillment-shaped one — core#52's
// `stock_method` class, where a key one shape cannot carry reads as an override.
Deno.test("order → fulfillment: the pair schemas are the SAME node, so no projection is needed", () => {
  const shapeOf = (s: unknown) =>
    ((s as { _zod: { def: { shape: Record<string, unknown> } } })._zod.def.shape);
  const order = shapeOf(OrderSchema).destinations;
  const fulfillment = shapeOf(FulfillmentSchema).destinations;
  const elementOf = (n: unknown) => (n as { _zod: { def: { element?: unknown } } })._zod.def.element;
  // Both halves resolve, so the identity below is a real comparison and not
  // `undefined === undefined`.
  assert(elementOf(order) !== undefined && elementOf(fulfillment) !== undefined, "both elements resolve");
  assert(
    elementOf(order) === elementOf(fulfillment),
    "Fulfillment.destinations must stay z.array(DocDestination) — the order's own pair schema",
  );
  // Companion: the invoice is the case this probe must be able to REJECT. Its
  // pair is a distinct schema, which is exactly why the invoice arm needs
  // `toInvoiceDestinationPair` and this one does not.
  assert(
    elementOf(order) !== elementOf(shapeOf(InvoiceSchema).destinations),
    "the probe must distinguish a genuinely different pair schema",
  );
});

// ── resolveMergedPairDates: the four cases, directly ─────────────────────────
//
// It is reached through `mergePair` by the invoice suite, which is what proves
// the extraction faithful. These exercise it as the public API it now is — the
// invoice path covers three of the four cases incidentally and the invalid one
// only through a whole-sync fixture, so the `null` contract is asserted here
// where a caller can actually see it.

const FS = (iso: string) => ({ seconds: Math.floor(Date.parse(iso) / 1000), nanoseconds: 0 });

/** A pair's `dates`, with each boundary's `_fs` mirror tagged by side. */
function pairDates(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delivery_start: "2026-05-01T09:00:00.000-05:00",
    delivery_start_fs: FS("2026-05-01T09:00:00-05:00"),
    delivery_end: "2026-05-01T09:00:00.000-05:00",
    delivery_end_fs: FS("2026-05-01T09:00:00-05:00"),
    collection_start: "2026-05-10T15:00:00.000-05:00",
    collection_start_fs: FS("2026-05-10T15:00:00-05:00"),
    collection_end: "2026-05-10T15:00:00.000-05:00",
    collection_end_fs: FS("2026-05-10T15:00:00-05:00"),
    charge_start: null,
    charge_start_fs: null,
    charge_end: null,
    charge_end_fs: null,
    days_active: 8,
    days_charged: 6,
    ...windowOver(over),
  };
}

/** `over`, plus one window over its possession (the default's when unstated) unless it states windows. */
function windowOver(over: Record<string, unknown>): Record<string, unknown> {
  if ("charge_windows" in over) return over;
  const start = (over.delivery_start ?? "2026-05-01T09:00:00.000-05:00") as string;
  const end = (over.collection_start ?? "2026-05-10T15:00:00.000-05:00") as string;
  return { ...over, charge_windows: [{ start, end, days: (over.days_charged ?? 6) as number }] };
}

const resolve4 = (merged: Record<string, unknown>, source: Record<string, unknown>, downstream: Record<string, unknown>) =>
  resolveMergedPairDates(merged, source, downstream, [], canonicalChargeWindows);

Deno.test("resolveMergedPairDates: a window unchanged from the downstream's is returned as-is", () => {
  const downstream = pairDates();
  const source = pairDates({ collection_start: "2026-06-20T15:00:00.000-05:00" });
  // The merge kept the downstream's window, so nothing is recomputed.
  const out = resolve4(pairDates(), source, downstream);
  assertEquals(out, pairDates());
});

Deno.test("resolveMergedPairDates: a window equal to the SOURCE's takes the source's dates whole", () => {
  const downstream = pairDates();
  const source = pairDates({
    collection_start: "2026-06-20T15:00:00.000-05:00",
    collection_start_fs: FS("2026-06-20T15:00:00-05:00"),
    days_active: 36,
    days_charged: 27,
  });
  const merged = pairDates({ collection_start: "2026-06-20T15:00:00.000-05:00" });
  // Identity, not equality: the source's own derived fields were computed from
  // exactly these boundaries, so they are taken rather than recomputed.
  assert(resolve4(merged, source, downstream) === source);
});

Deno.test("🔴 resolveMergedPairDates: a MIXED window takes each _fs from its own side and recomputes the days", () => {
  const downstream = pairDates({
    delivery_start: "2026-05-04T09:00:00.000-05:00",
    delivery_start_fs: FS("2026-05-04T09:00:00-05:00"),
  });
  const source = pairDates({
    collection_start: "2026-05-14T15:00:00.000-05:00",
    collection_start_fs: FS("2026-05-14T15:00:00-05:00"),
  });
  // Delivery from the downstream, collection from the source — what an operator
  // moving ONE endpoint in the pair editor produces.
  const merged = pairDates({
    delivery_start: "2026-05-04T09:00:00.000-05:00",
    collection_start: "2026-05-14T15:00:00.000-05:00",
  });

  const out = resolve4(merged, source, downstream) as Record<string, unknown>;
  assertEquals(out.delivery_start_fs, downstream.delivery_start_fs, "_fs follows its own boundary's side");
  assertEquals(out.collection_start_fs, source.collection_start_fs, "_fs follows its own boundary's side");
  // Recomputed against the merged window, so neither input's stale count survives.
  const expected = getDuration(
    { delivery_start: "2026-05-04T09:00:00.000-05:00", collection_start: "2026-05-14T15:00:00.000-05:00" },
    [],
  );
  assertEquals(out.days_active, expected.activeDays);
  assertEquals("days_charged" in out, false, "a recount drops the legacy fields");
  assert(out.days_active !== pairDates().days_active, "the stale count did not simply survive");
});

Deno.test("🔴 resolveMergedPairDates: an INVALID mix returns null — the caller keeps the downstream's whole dates", () => {
  // The downstream moved delivery LATER while the source moved collection
  // EARLIER, so the merged window does not terminate. Never written.
  const downstream = pairDates({ delivery_start: "2026-06-01T09:00:00.000-05:00" });
  const source = pairDates({ collection_start: "2026-05-02T15:00:00.000-05:00" });
  const merged = pairDates({
    delivery_start: "2026-06-01T09:00:00.000-05:00",
    collection_start: "2026-05-02T15:00:00.000-05:00",
  });
  assertEquals(resolve4(merged, source, downstream), null);
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
  document: { kind: "order", status: "draft" },
  // Two windows (3 + 4 days) under every path, so the derived `chargeable_days`
  // moves off the sentinel's 5 and the tag check sees the pricer write it.
  charge_windows: [{ divider_path: [], days: [3, 4] }],
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

// ── mergeSharedFields: the three-way rule on one matched row ─────────────────

const INVOICE_CLASS = classifySharedFields(OrderSchema, InvoiceSchema);
const LINE_FIELDS = fieldsUnder(INVOICE_CLASS, "items[]");
const PAIR_FIELDS = fieldsUnder(INVOICE_CLASS, "destinations[]");
const DOC_FIELDS = fieldsUnder(INVOICE_CLASS, "");

/** Seeded LCG — never Math.random. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

// The merge addresses fields by runtime path strings, so these two helpers are the
// one place the test reads and writes by path; everything else is typed.
const get = (o: object, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v !== null && typeof v === "object" ? (v as { [k: string]: unknown })[k] : undefined), o);

function set(o: object, path: string, value: unknown): void {
  const segs = path.split(".");
  const parent = get(o, segs.slice(0, -1).join(".")) ?? o;
  (segs.length === 1 ? o : parent as object as { [k: string]: unknown })[segs[segs.length - 1] as never] = value as never;
}

/** A different value of the same type, or undefined when the leaf cannot be varied. */
function vary(v: unknown, r: () => number): unknown {
  if (typeof v === "number") return v + 1 + Math.floor(r() * 50);
  if (typeof v === "string") return `${v}~${Math.floor(r() * 1000)}`;
  if (typeof v === "boolean") return !v;
  return undefined;
}

/** An invoice line with a non-null discount, so its leaves are mergeable. */
function invoiceLine(r: () => number): InvoiceDocLineItemType {
  const projected = projectOrderItemToInvoiceItem(
    line(
      { name: `Chair ${Math.floor(r() * 100)}`, description: "folding", quantity: 1 + Math.floor(r() * 9), zero_priced: false, path: ["dest-1", "line-1"] },
      { base_cents: 1000 + Math.floor(r() * 9000), chargeable_days: 1 + Math.floor(r() * 10), discount: { type: "percent", rate: Math.floor(r() * 50), amount_cents: 0 } },
    ),
    "order-1",
  ) as InvoiceDocLineItemType;
  return { ...projected, coa_revenue: 4000, xero_id: "inv-line-xero", crms_id: 77 };
}

/** The mergeable leaf paths: propagated, and holding a value on the row. */
const mergeableLeaves = (fields: readonly SharedField[], row: object) =>
  fields.filter((f) => f.kind === "propagated" && vary(get(row, f.path), () => 0) !== undefined).map((f) => f.path);

Deno.test("mergeSharedFields: an unedited line takes every propagating field from the new order line", () => {
  const r = lcg(1);
  for (let i = 0; i < 500; i++) {
    const prev = invoiceLine(r);
    const next = structuredClone(prev);
    for (const path of mergeableLeaves(LINE_FIELDS, prev)) if (r() < 0.5) set(next, path, vary(get(prev, path), r));
    const down: InvoiceDocLineItemType = { ...structuredClone(prev), xero_id: "kept", tracking_category: "kept" };

    const { merged, overridden } = mergeSharedFields(LINE_FIELDS, prev, next, down);
    assertEquals(overridden, []);
    for (const f of LINE_FIELDS) {
      const want = f.kind === "propagated" || f.kind === "atom" ? get(next, f.path) : get(down, f.path);
      assertEquals(get(merged, f.path), want, f.path);
    }
    // Downstream-only keys are never touched.
    assertEquals([merged.xero_id, merged.tracking_category], ["kept", "kept"]);
  }
});

Deno.test("mergeSharedFields: an override on ONE field keeps that field and lets every other field follow", () => {
  const r = lcg(2);
  const overriddenFields = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const prev = invoiceLine(r);
    const leaves = mergeableLeaves(LINE_FIELDS, prev);
    const pick = leaves[Math.floor(r() * leaves.length)];

    const next = structuredClone(prev);
    for (const path of leaves) set(next, path, vary(get(prev, path), r));
    const down = structuredClone(prev);
    set(down, pick, vary(get(prev, pick), r));

    const { merged, overridden } = mergeSharedFields(LINE_FIELDS, prev, next, down);
    assertEquals(overridden, [pick]);
    assertEquals(get(merged, pick), get(down, pick), `the override on ${pick} is kept`);
    for (const path of leaves) {
      if (path !== pick) assertEquals(get(merged, path), get(next, path), `${path} follows the order despite ${pick}`);
    }
    // Derived money is left for the reprice, never taken from the order.
    assertEquals(merged.price.total_cents, down.price.total_cents);
    overriddenFields.add(pick);
  }
  // Anti-vacuity: the sweep overrode quantity, a price input, a label and a nested leaf.
  for (const f of ["quantity", "price.base_cents", "name", "price.discount.rate"]) {
    assert(overriddenFields.has(f), `never overrode ${f}: ${[...overriddenFields]}`);
  }
});

Deno.test("mergeSharedFields: when the order did not change, the row comes back byte-identical", () => {
  const r = lcg(3);
  for (let i = 0; i < 500; i++) {
    const prev = invoiceLine(r);
    const down = structuredClone(prev);
    for (const path of mergeableLeaves(LINE_FIELDS, prev)) if (r() < 0.3) set(down, path, vary(get(prev, path), r));
    // The order spells "nothing" as an absent key where the invoice stores null.
    const prevSparse = structuredClone(prev);
    delete prevSparse.price.base_percent;
    const { merged } = mergeSharedFields(LINE_FIELDS, prevSparse, structuredClone(prevSparse), down);
    assertEquals(merged, down);
    assertEquals(Object.keys(merged.price).sort(), Object.keys(down.price).sort());
  }
});

Deno.test("mergeSharedFields: a null value object is one unit — removed or kept whole", () => {
  const prev = invoiceLine(lcg(4));

  // The operator removed the discount; the order changes its rate. Kept as null.
  const edited = structuredClone(prev);
  edited.price.discount = null;
  const rateMoved = structuredClone(prev);
  rateMoved.price.discount = { type: "percent", rate: 42, amount_cents: 0 };
  const kept = mergeSharedFields(LINE_FIELDS, prev, rateMoved, edited);
  assertEquals(kept.overridden, ["price.discount"]);
  assertEquals(kept.merged.price.discount, null);

  // The order removes the discount; an unedited line follows.
  const removed = structuredClone(prev);
  removed.price.discount = null;
  const followed = mergeSharedFields(LINE_FIELDS, prev, removed, structuredClone(prev));
  assertEquals(followed.overridden, []);
  assertEquals(followed.merged.price.discount, null);
});

Deno.test("mergeSharedFields: a snapshot atom is taken or kept WHOLE, never leaf by leaf", () => {
  const org = (uid: string, exempt: boolean) => ({ uid, path: [{ uid, name: uid }], tax_exempt: exempt });
  const prev = { subject: "Shoot", organization: org("root", false) };
  const next = { subject: "Shoot", organization: org("dept", true) };

  // An invoice moved to another org whose tax_exempt happens to match the old one.
  const moved = { subject: "Shoot", organization: org("other", false) };
  const kept = mergeSharedFields(DOC_FIELDS, prev, next, moved);
  assertEquals(kept.overridden, ["organization"]);
  assertEquals(kept.merged.organization, org("other", false), "no chimera of other's uid and dept's axes");

  const unedited = mergeSharedFields(DOC_FIELDS, prev, next, structuredClone(prev));
  assertEquals(unedited.merged.organization, org("dept", true));
});

Deno.test("mergeSharedFields: pair dates merge per leaf and never touch the derived day counts", () => {
  const dates = (d: string, c: string, days: number) => ({
    delivery_start: d, delivery_start_fs: null, delivery_end: d, delivery_end_fs: null,
    collection_start: c, collection_start_fs: null, collection_end: c, collection_end_fs: null,
    charge_start: null, charge_start_fs: null, charge_end: null, charge_end_fs: null,
    days_active: days, days_charged: days,
  });
  const pair = (dd: ReturnType<typeof dates>) => ({ uid: "dest-1", uid_order: "order-1", dates: dd, delivery: null, collection: null, customer_collecting: false, customer_returning: false, jurisdiction: null });
  const prev = pair(dates("2026-10-01T00:00:00.000-05:00", "2026-10-05T00:00:00.000-05:00", 4));
  const next = pair(dates("2026-10-03T00:00:00.000-05:00", "2026-10-07T00:00:00.000-05:00", 4));
  // The invoice extended collection only.
  const down = pair({ ...prev.dates, collection_start: "2026-10-09T00:00:00.000-05:00", collection_end: "2026-10-09T00:00:00.000-05:00", days_charged: 6 });

  const { merged, overridden } = mergeSharedFields(PAIR_FIELDS, prev, next, down);
  assertEquals(overridden, ["dates.collection_end", "dates.collection_start"]);
  assertEquals(merged.dates.delivery_start, "2026-10-03T00:00:00.000-05:00");
  assertEquals(merged.dates.collection_start, "2026-10-09T00:00:00.000-05:00");
  assertEquals(merged.dates.days_charged, 6, "derived, left for the day count to recompute");
});
