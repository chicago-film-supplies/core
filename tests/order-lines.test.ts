import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  componentQuantities,
  buildCustomInvoiceLine,
  buildCustomOrderLine,
  buildOrderComponentLines,
  buildOrderLineFromProduct,
  catalogSlotOf,
  componentQuantityAt,
  deriveLineCatalogFacts,
  quantityPerParentForSlot,
  zeroPricedForSlot,
} from "../src/utils/order-lines.ts";
import { OrderDocLineItem } from "../src/schemas/mod.ts";
import type { ProductDocument, ProductDocumentComponent } from "../src/schemas/typesense/mod.ts";
import { catalogPrice, FDW_REF, FIVE_DAY_WEEK, FIXED, FIXED_REF, FORMULAS } from "./helpers/formulas.ts";

/** A line's (or fact's) first rate — what `base_cents` was. */
const base = (price: { rates: readonly { amount_cents: number }[] }): number => price.rates[0]?.amount_cents ?? 0;

// ── fixtures ────────────────────────────────────────────────────────
//
// Catalog `path` EXCLUDES self and starts at the root product uid — the inverse
// of the doc-item convention. `comp("C", ["A", "B"])` is "C nested under B, which
// is nested under root A".

function comp(
  uid: string,
  path: string[],
  over: Partial<ProductDocumentComponent> = {},
): ProductDocumentComponent {
  return {
    uid,
    path,
    name: uid + " name",
    quantity: 1,
    type: "rental",
    stock_method: "bulk",
    inclusion_type: "default",
    zero_priced: false,
    price: { ...catalogPrice(FIVE_DAY_WEEK, 1000) },
    ...over,
  };
}

function product(over: Partial<ProductDocument> = {}): ProductDocument {
  return {
    id: "A",
    uid: "A",
    name: "Kit A",
    type: "rental",
    stock_method: "bulk",
    active: true,
    component_only: false,
    updated_at: 0,
    price: { ...catalogPrice(FIVE_DAY_WEEK, 10000), replacement_cents: 50000 },
    ...over,
  };
}

// A real 20-char id, so the test that parses a built line against the stored
// schema passes `FirestoreId`. Keyed by type so a test can see which it took.
const DEFAULT_CLASS = "TaxC1assDefau1tAAAAA";
const taxClassForType = (type: string) => (type === "sale" ? "TaxC1assSa1eAAAAAAAA" : DEFAULT_CLASS);
const OPTS = { quantity: 1, formulas: FORMULAS, asOf: null, taxClassForType };

/** The pre-refactor path expression: the catalog chain, concatenated verbatim. */
function catalogConcatPath(
  c: ProductDocumentComponent,
  inheritedAncestry: string[] = [],
): string[] {
  return [...inheritedAncestry, ...(c.path ?? []), c.uid!];
}

// ── buildOrderLineFromProduct ───────────────────────────────────────

// The readable "A"/"B"/"C" uids above keep the path assertions legible, but
// `ItemUid`/`FirestoreId` want real 20-char ids — so the one test that parses the
// output against the stored schema uses those.
const REAL_PRODUCT_UID = "Pr0ductAAAAAAAAAAAAA";
const REAL_ORDER_UID = "Ord3rAAAAAAAAAAAAAAA";

Deno.test("buildOrderLineFromProduct emits a schema-valid line, ancestry-only path", () => {
  const line = buildOrderLineFromProduct(
    product({ uid: REAL_PRODUCT_UID, price: { ...catalogPrice(FIVE_DAY_WEEK, 10000), replacement_cents: 50000 } }),
    { ...OPTS, quantity: 3, uidOrder: REAL_ORDER_UID },
  );

  assertEquals(line.uid, REAL_PRODUCT_UID);
  assertEquals(line.type, "rental");
  assertEquals(line.quantity, 3);
  assertEquals(line.stock_method, "bulk");
  assertEquals(line.uid_order, REAL_ORDER_UID);
  // `path` carries the component ancestry ONLY. `computeItemPaths` appends the
  // item's own uid and the structural prefix — it is the sole author of a stored
  // path, and a builder that appended self here would author one too.
  assertEquals(line.path, []);
  assertEquals(line.inclusion_type, null);
  assertEquals(line.zero_priced, null);
  assertEquals(base(line.price), 10000);
  assertEquals(line.price.replacement_cents, 50000);
  assertEquals(line.price.price_formula, FDW_REF);
  // No counts until the document is priced: `priceDocument` meters them (ruling 8).
  assertEquals(line.price.counts, []);
  // Money fields are zero and taxes empty until the document is priced — the
  // documented contract of this module (api-cloudrun#993).
  assertEquals(line.price.subtotal_cents, 0);
  assertEquals(line.price.total_cents, 0);
  assertEquals(line.price.taxes, []);

  // Structurally a line item as built.
  const parsed = OrderDocLineItem.safeParse(line);
  assert(parsed.success, JSON.stringify(parsed.error?.issues));
});

Deno.test("buildOrderLineFromProduct omits uid_order entirely when not asked for", () => {
  const line = buildOrderLineFromProduct(product(), OPTS);
  // Absent, not `undefined` and not `""`. The `initial` spread this replaced
  // seeded `uid_order: ""` on every invoice-surface line.
  assert(!("uid_order" in line));
});

Deno.test("buildOrderLineFromProduct carries inheritedAncestry and reads its own stock_method", () => {
  const line = buildOrderLineFromProduct(
    product({ uid: "Z", type: "sale", stock_method: "none", description: "" }),
    { ...OPTS, inheritedAncestry: ["parentKit"] },
  );
  assertEquals(line.path, ["parentKit"]);
  assertEquals(line.type, "sale");
  assertEquals(line.stock_method, "none");
  // The line takes the catalog's formula and rates; counts are the pricer's.
  assertEquals(line.price.counts, []);
});

Deno.test("buildOrderLineFromProduct carries a percent-of-total product's rate and no formula or rates", () => {
  // The prod Card Fee shape. Before `base_percent` was copied, this line staged
  // as a percent fee with no rate and priced at $0.
  const line = buildOrderLineFromProduct(
    product({
      uid: REAL_PRODUCT_UID,
      type: "transaction_fee",
      stock_method: "none",
      price: { uid_price_formula: null, rates: [], base_percent: 4 },
    }),
    { ...OPTS, uidOrder: REAL_ORDER_UID },
  );
  assertEquals(line.price.price_formula, null);
  assertEquals(line.price.base_percent, 4);
  assertEquals(line.price.rates, []);
  assertEquals(line.price.counts, []);

  // Stray rates beside a null formula cannot break the biconditional.
  const stray = buildOrderLineFromProduct(
    product({ type: "transaction_fee", price: { uid_price_formula: null, rates: [{ rate_key: "flat", amount_cents: 500 }], base_percent: 4 } }),
    OPTS,
  );
  assertEquals(stray.price.rates, []);
  assertEquals(stray.price.price_formula, null);
  assertEquals(stray.price.base_percent, 4);
});

Deno.test("buildOrderLineFromProduct states base_percent: null on a non-percent price", () => {
  const line = buildOrderLineFromProduct(product(), OPTS);
  assertEquals(line.price.base_percent, null);
  assertEquals(base(line.price), 10000);
});

// ── buildOrderComponentLines: the path seam ─────────────────────────

Deno.test("component doc paths are parent-derived and match the catalog concat on well-formed rows", () => {
  // Depth 3: A → B → C → D, plus a sibling E under B.
  const doc = product({
    components: [
      comp("B", ["A"]),
      comp("C", ["A", "B"]),
      comp("D", ["A", "B", "C"]),
      comp("E", ["A", "B"]),
    ],
  });

  const lines = buildOrderComponentLines(doc, { ...OPTS, inheritedAncestry: ["outerKit"] });
  const byUid = new Map(lines.map((l) => [l.uid, l]));

  // This is the equivalence that makes deriving from the resolved parent a
  // no-op on every well-formed row (164 of prod's 165), and therefore the
  // reason the refactor is safe rather than a behaviour change.
  for (const c of doc.components!) {
    assertEquals(byUid.get(c.uid!)!.path, catalogConcatPath(c, ["outerKit"]));
  }

  // And spelled out, so a change to `catalogConcatPath` cannot make this vacuous.
  assertEquals(byUid.get("B")!.path, ["outerKit", "A", "B"]);
  assertEquals(byUid.get("C")!.path, ["outerKit", "A", "B", "C"]);
  assertEquals(byUid.get("D")!.path, ["outerKit", "A", "B", "C", "D"]);
  assertEquals(byUid.get("E")!.path, ["outerKit", "A", "B", "E"]);
});

Deno.test("emission is depth-first: a parent is followed by its own subtree", () => {
  const doc = product({
    components: [
      comp("B", ["A"]),
      comp("E", ["A"]),
      comp("C", ["A", "B"]),
      comp("D", ["A", "B", "C"]),
    ],
  });
  assertEquals(
    buildOrderComponentLines(doc, OPTS).map((l) => l.uid),
    ["B", "C", "D", "E"],
  );
});

Deno.test("a component whose catalog path names itself still emits under the root", () => {
  // The live prod shape: product F4uPA273BUHa0Qf5ZLVr carried a MANDATORY
  // component whose `path` was its own uid instead of the parent's. Bucketing on
  // `path.at(-1)` put it under itself, `emit` never reached it, and 206 order
  // lines shipped without the power supply the catalog calls mandatory. The data
  // is repaired; this pins the code so one bad row cannot go silent again.
  const doc = product({
    components: [
      comp("B", ["A"]),
      comp("PS", ["PS"], { inclusion_type: "mandatory", zero_priced: true }),
    ],
  });

  const lines = buildOrderComponentLines(doc, OPTS);
  const ps = lines.find((l) => l.uid === "PS");
  assert(ps, "the self-referential row must not be dropped");
  // Parent is `path.at(-2)` — the root, not itself.
  assertEquals(ps.path, ["A", "PS"]);
  assertEquals(ps.path.at(-2), "A");
});

// ── buildOrderComponentLines: quantity ──────────────────────────────

Deno.test("quantities recurse with a per-level effective quantity", () => {
  // A fractional ratio below a direct child — 6 such rows exist in prod, and
  // scaling the whole subtree by one root-level ratio gives a different answer.
  const doc = product({
    components: [
      comp("B", ["A"], { quantity: 2 }),
      comp("C", ["A", "B"], { quantity: 0.5 }),
    ],
  });

  const lines = buildOrderComponentLines(doc, { ...OPTS, quantity: 3 });
  const byUid = new Map(lines.map((l) => [l.uid, l]));

  assertEquals(byUid.get("B")!.quantity, 6); // ceil(2 × 3)
  // ceil(0.5 × 6) = 3 — off B's RESOLVED quantity, not off the root's 3
  // (which would give ceil(0.5 × 3) = 2).
  assertEquals(byUid.get("C")!.quantity, 3);
});

Deno.test("a fractional ratio rounds up, so a kit is never short a component", () => {
  const doc = product({ components: [comp("B", ["A"], { quantity: 0.5 })] });
  assertEquals(buildOrderComponentLines(doc, { ...OPTS, quantity: 1 })[0].quantity, 1);
  assertEquals(buildOrderComponentLines(doc, { ...OPTS, quantity: 3 })[0].quantity, 2);
});

// ── quantity_per_parent: the stamp (core#131 Phase 2) ───────────────

Deno.test("quantityPerParentForSlot: null with no slot, the slot's ratio at 4 dp, 1 when it states none", () => {
  assertEquals(quantityPerParentForSlot(null), null);
  assertEquals(quantityPerParentForSlot({ quantity: 0.5 }), 0.5);
  assertEquals(quantityPerParentForSlot({ quantity: 0 }), 0); // an optional the operator raises
  assertEquals(quantityPerParentForSlot({ quantity: 1.01 }), 1.01);
  assertEquals(quantityPerParentForSlot({ quantity: 0.123456 }), 0.1235);
  // `?? 1`: what the expansion uses for a row stating no quantity.
  assertEquals(quantityPerParentForSlot({}), 1);
});

Deno.test("buildOrderComponentLines stamps each line with its DIRECT parent's ratio", () => {
  const doc = product({
    components: [
      comp("B", ["A"], { quantity: 2 }),
      comp("C", ["A", "B"], { quantity: 0.5 }),
      comp("D", ["A"], { quantity: undefined }),
    ],
  });
  const byUid = new Map(buildOrderComponentLines(doc, { ...OPTS, quantity: 3 }).map((l) => [l.uid, l]));
  assertEquals(byUid.get("B")!.quantity_per_parent, 2);
  assertEquals(byUid.get("C")!.quantity_per_parent, 0.5); // relative to B, not to the root
  assertEquals(byUid.get("D")!.quantity_per_parent, 1);
});

Deno.test("a freshly expanded line reads as NOT hand-edited: componentQuantityAt(stamp, parent) === quantity", () => {
  const doc = product({
    components: [
      comp("B", ["A"], { quantity: 0.25 }),
      comp("C", ["A", "B"], { quantity: 0.07 }),
      comp("E", ["A"], { quantity: 1.01 }),
    ],
  });
  for (const q of [1, 3, 7, 100]) {
    const lines = buildOrderComponentLines(doc, { ...OPTS, quantity: q });
    const qtyOf = new Map(lines.map((l) => [l.uid, l.quantity]));
    for (const l of lines) {
      const parentQty = l.path.length === 2 ? q : qtyOf.get(l.path.at(-2)!)!;
      assertEquals(componentQuantityAt(l.quantity_per_parent!, parentQty), l.quantity, `${l.uid} at ${q}`);
    }
  }
});

Deno.test("a top-level and a custom line state quantity_per_parent: null — they fill no slot", () => {
  assertEquals(buildOrderLineFromProduct(product(), OPTS).quantity_per_parent, null);
  const custom = buildCustomOrderLine({ type: "sale", formula: FIXED, taxes: [], uid_tax_class: "AbCdEfGhIjKlMnOpQrSt" });
  assertEquals(custom.quantity_per_parent, null);
  assert(OrderDocLineItem.safeParse(custom).success);
});

// ── buildOrderComponentLines: filtering + ordering ──────────────────

Deno.test("only mandatory and default components expand", () => {
  const doc = product({
    components: [
      comp("M", ["A"], { inclusion_type: "mandatory" }),
      comp("D", ["A"], { inclusion_type: "default" }),
      comp("O", ["A"], { inclusion_type: "optional" }),
      comp("U", ["A"], { inclusion_type: undefined }),
    ],
  });
  assertEquals(
    buildOrderComponentLines(doc, OPTS).map((l) => l.uid).sort(),
    ["D", "M"],
  );
});

Deno.test("a mandatory/default child of an OPTIONAL parent is deliberately not staged", () => {
  // Not the same thing as the malformed-path drop above, though it looks identical
  // from inside the walk: this parent was deselected, not misfiled. A mandatory
  // accessory is mandatory GIVEN its parent, and the operator has not chosen the
  // parent — prod has 3 such rows (a generator's fuel-tank cap and hose under an
  // optional extension tank; a hand truck under an optional folding chair), and
  // staging them unasked would put a fuel-tank cap on every generator order.
  //
  // This is the test that stops someone "fixing" it by hoisting an unreachable
  // row to the root.
  const doc = product({
    components: [
      comp("tank", ["A"], { inclusion_type: "optional" }),
      comp("cap", ["A", "tank"], { inclusion_type: "mandatory" }),
      comp("hose", ["A", "tank"], { inclusion_type: "mandatory" }),
      comp("kept", ["A"], { inclusion_type: "default" }),
    ],
  });

  const lines = buildOrderComponentLines(doc, OPTS);
  assertEquals(lines.map((l) => l.uid), ["kept"]);
  // Specifically NOT reparented to the root.
  assert(!lines.some((l) => l.path.at(-2) === "A" && l.uid === "cap"));
});

Deno.test("zero-priced components precede priced ones within a parent block", () => {
  const doc = product({
    components: [
      comp("priced1", ["A"], { zero_priced: false }),
      comp("free1", ["A"], { zero_priced: true }),
      comp("priced2", ["A"], { zero_priced: false }),
      comp("free2", ["A"], { zero_priced: true }),
    ],
  });
  // Stable within each band — insertion order preserved.
  assertEquals(
    buildOrderComponentLines(doc, OPTS).map((l) => l.uid),
    ["free1", "free2", "priced1", "priced2"],
  );
});

Deno.test("a zero-priced component prices at 0 regardless of its catalog base", () => {
  const doc = product({
    components: [comp("F", ["A"], { zero_priced: true, price: { ...catalogPrice(FIVE_DAY_WEEK, 9900) } })],
  });
  assertEquals(base(buildOrderComponentLines(doc, OPTS)[0].price), 0);
});

// ── uid_tax_class: the class travels with the hit (api-cloudrun#993) ──

Deno.test("lines built from a hit carry the product's and each component's uid_tax_class", () => {
  // The optimistic reprice resolves tax from the line's class; without the stamp
  // it falls back to the type default, and a bottled-water component would show
  // plain sales tax until the server echo.
  const doc = product({
    uid_tax_class: "classRental",
    components: [
      comp("water", ["A"], { type: "sale", uid_tax_class: "classWater" }),
      comp("plain", ["A"]),
    ],
  });
  assertEquals(buildOrderLineFromProduct(doc, OPTS).uid_tax_class, "classRental");
  const byUid = new Map(buildOrderComponentLines(doc, OPTS).map((l) => [l.uid, l]));
  assertEquals(byUid.get("water")!.uid_tax_class, "classWater");
  // Absent on the row → the type's default class, which is the server's
  // fallback (`stampLineTaxClasses`). A stored line must carry one.
  assertEquals(byUid.get("plain")!.uid_tax_class, DEFAULT_CLASS);
  assertEquals(buildOrderLineFromProduct(product(), OPTS).uid_tax_class, DEFAULT_CLASS);
  assertEquals(buildOrderLineFromProduct(product({ type: "sale" }), OPTS).uid_tax_class, "TaxC1assSa1eAAAAAAAA");
});

// ── buildOrderComponentLines: fields the seed used to invent ────────

Deno.test("component lines read stock_method off the component row, not a seed default", () => {
  // The deleted `getInitialValues(OrderItem)` spread supplied `stock_method:
  // "bulk"` for EVERY component, so a no-stock component rendered availability it
  // does not have until the server echo landed.
  const doc = product({
    components: [
      comp("bulky", ["A"], { stock_method: "bulk" }),
      comp("nostock", ["A"], { stock_method: "none" }),
      comp("serial", ["A"], { stock_method: "serialized" }),
    ],
  });
  const byUid = new Map(buildOrderComponentLines(doc, OPTS).map((l) => [l.uid, l]));
  assertEquals(byUid.get("bulky")!.stock_method, "bulk");
  assertEquals(byUid.get("nostock")!.stock_method, "none");
  assertEquals(byUid.get("serial")!.stock_method, "serialized");
});

Deno.test("component lines carry no order_number — only the server can allocate one", () => {
  const doc = product({ components: [comp("B", ["A"])] });
  const line = buildOrderComponentLines(doc, OPTS)[0];
  // The seed used to supply `order_number: 0`, a real-looking number for a
  // sequence value the API stamps from `counters/{id}` at write time.
  assert(!("order_number" in line));
});

Deno.test("a component with no description gets an empty string, not undefined", () => {
  // 10 of prod's 165 rows omit `description`, while the stored line type
  // promises a `string`.
  const doc = product({ components: [comp("B", ["A"], { description: undefined })] });
  assertEquals(buildOrderComponentLines(doc, OPTS)[0].description, "");
});

Deno.test("emitted items share no mutable references", () => {
  // The `cloneDeep(opts.initial)` this module dropped existed to stop two items
  // sharing a defaults object. Constructing each literal outright must keep that
  // guarantee.
  const doc = product({ components: [comp("B", ["A"]), comp("C", ["A"])] });
  const [first, second] = buildOrderComponentLines(doc, OPTS);
  first.price.rates[0].amount_cents = 12345;
  first.path.push("mutated");
  assert(base(second.price) !== 12345);
  assert(!second.path.includes("mutated"));
});

// ── buildOrderComponentLines: unbuildable rows ──────────────────────

Deno.test("an unbuildable component row throws instead of being dropped", () => {
  // Silently skipping is the exact failure this module exists to prevent.
  assertThrows(
    () => buildOrderComponentLines(product({ components: [comp("B", ["A"], { uid: undefined })] }), OPTS),
    Error,
    "component with no uid",
  );
  assertThrows(
    () => buildOrderComponentLines(product({ components: [comp("B", ["A"], { type: undefined })] }), OPTS),
    Error,
    "has no type",
  );
});

Deno.test("a product with no expandable components returns an empty array", () => {
  assertEquals(buildOrderComponentLines(product(), OPTS), []);
  assertEquals(buildOrderComponentLines(product({ components: [] }), OPTS), []);
  assertEquals(
    buildOrderComponentLines(product({ components: [comp("O", ["A"], { inclusion_type: "optional" })] }), OPTS),
    [],
  );
});

// ── custom lines ────────────────────────────────────────────────────

// ── a line's catalog facts: one author (api-cloudrun#1286) ───────────

Deno.test("zeroPricedForSlot: null with no slot, else a boolean — a component always states one", () => {
  assertEquals(zeroPricedForSlot(null), null);
  assertEquals(zeroPricedForSlot({ zero_priced: true }), true);
  assertEquals(zeroPricedForSlot({ zero_priced: false }), false);
  // A catalog row that says nothing is "billed separately", and `null` on a
  // component is what core's `zero_priced_unstated` refuses (api-cloudrun#1287).
  assertEquals(zeroPricedForSlot({}), false);
});

Deno.test("a component whose catalog row states no zero_priced builds as false, never null", () => {
  const { zero_priced: _omit, ...unstated } = comp("U", ["A"]);
  const [line] = buildOrderComponentLines(product({ components: [unstated] }), OPTS);
  assertEquals(line.zero_priced, false);
  assertEquals(base(line.price), 1000);
});

Deno.test("deriveLineCatalogFacts: the price follows the flag it is given", () => {
  const p = { type: "rental", stock_method: "bulk", price: { ...catalogPrice(FIVE_DAY_WEEK, 2500), replacement_cents: 9000 } };
  assertEquals(base(deriveLineCatalogFacts(p, true, OPTS).price), 0);
  assertEquals(base(deriveLineCatalogFacts(p, false, OPTS).price), 2500);
  assertEquals(base(deriveLineCatalogFacts(p, null, OPTS).price), 2500);
  assertEquals(deriveLineCatalogFacts(p, true, OPTS).zero_priced, true);
  assertEquals(deriveLineCatalogFacts(p, true, OPTS).price.replacement_cents, 9000);
});

Deno.test("deriveLineCatalogFacts: the CATALOG formula is the line's, never the type's", () => {
  // Prod's two Combo Hangers rentals are deliberately on Fixed; a type-derived
  // formula bills them per day (api-cloudrun#1286).
  const hangers = { type: "rental", stock_method: "bulk", price: { ...catalogPrice(FIXED, 3000) } };
  assertEquals(deriveLineCatalogFacts(hangers, null, OPTS).price.price_formula, FIXED_REF);
  // There is no type default to fall back on: a catalog naming no formula, or
  // one the context has not loaded, is refused.
  assertThrows(() => deriveLineCatalogFacts({ type: "rental", price: {} }, null, OPTS), Error, "names no formula");
  assertThrows(
    () => deriveLineCatalogFacts({ type: "rental", price: { uid_price_formula: "NotLoadedFormu1aAAAA" } }, null, OPTS),
    Error,
    "not loaded",
  );
});

Deno.test("deriveLineCatalogFacts: the rates in force at asOf, else the open row", () => {
  const rates = [
    { uid: "a", rate_key: "week", amount_cents: 1000, applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: "2026-06-01T00:00:00.000-05:00" },
    { uid: "b", rate_key: "week", amount_cents: 1200, applied_from: "2026-06-01T00:00:00.000-05:00", applied_to: null },
  ];
  const p = { type: "rental", stock_method: "bulk", price: { uid_price_formula: FIVE_DAY_WEEK.uid, rates } };
  assertEquals(base(deriveLineCatalogFacts(p, null, { formulas: FORMULAS, asOf: "2026-03-01T09:00:00.000-06:00" }).price), 1000);
  assertEquals(base(deriveLineCatalogFacts(p, null, { formulas: FORMULAS, asOf: "2026-07-01T09:00:00.000-05:00" }).price), 1200);
  assertEquals(base(deriveLineCatalogFacts(p, null, OPTS).price), 1200);
});

Deno.test("deriveLineCatalogFacts: a percent-of-total fee states the rate and no formula; others state base_percent null", () => {
  const fee = { type: "transaction_fee", stock_method: "none", price: { uid_price_formula: null, rates: [], base_percent: 3 } };
  assertEquals(deriveLineCatalogFacts(fee, null, OPTS).price, { price_formula: null, rates: [], base_percent: 3, replacement_cents: null });
  const sale = { type: "sale", stock_method: "bulk", price: { ...catalogPrice(FIXED, 500), base_percent: 7 } };
  assertEquals(deriveLineCatalogFacts(sale, null, OPTS).price.base_percent, null);
});

Deno.test("both builders agree with deriveLineCatalogFacts field for field", () => {
  const top = buildOrderLineFromProduct(product({ price: { ...catalogPrice(FIXED, 4200), replacement_cents: 7 } }), OPTS);
  const topFacts = deriveLineCatalogFacts(product({ price: { ...catalogPrice(FIXED, 4200), replacement_cents: 7 } }), null, OPTS);
  assertEquals(
    { type: top.type, stock_method: top.stock_method, zero_priced: top.zero_priced, price_formula: top.price.price_formula, rates: top.price.rates, base_percent: top.price.base_percent, replacement_cents: top.price.replacement_cents },
    { type: topFacts.type, stock_method: topFacts.stock_method, zero_priced: topFacts.zero_priced, ...topFacts.price },
  );
  const c = comp("F", ["A"], { zero_priced: true, price: { ...catalogPrice(FIXED, 9900), replacement_cents: 1 } });
  const [line] = buildOrderComponentLines(product({ components: [c] }), OPTS);
  const facts = deriveLineCatalogFacts(c, zeroPricedForSlot(c), OPTS);
  assertEquals(
    { type: line.type, stock_method: line.stock_method, zero_priced: line.zero_priced, rates: line.price.rates, replacement_cents: line.price.replacement_cents, price_formula: line.price.price_formula },
    { type: facts.type, stock_method: facts.stock_method, zero_priced: facts.zero_priced, rates: facts.price.rates, replacement_cents: facts.price.replacement_cents, price_formula: facts.price.price_formula },
  );
  // A component line keeps its key set: no `base_percent` key.
  assert(!("base_percent" in line.price));
});

Deno.test("catalogSlotOf reads the DIRECT row, never a same-uid grandchild", () => {
  const parent = {
    components: [
      comp("X", ["A"]),
      comp("C", ["A", "X"], { zero_priced: true }), // C as a grandchild, under X
      comp("C", ["A"], { zero_priced: false }), // C as a direct child
    ],
  };
  assertEquals(catalogSlotOf(parent, "C")?.zero_priced, false);
  assertEquals(catalogSlotOf(parent, "nope"), undefined);
  assertEquals(catalogSlotOf(undefined, "C"), undefined);
});

const CUSTOM_TAXES = [{ uid: "tax1", name: "IL", rate: 10, type: "percent" as const }];

Deno.test("buildCustomOrderLine stamps the custom- uid prefix", () => {
  const line = buildCustomOrderLine({
    type: "rental",
    formula: FIVE_DAY_WEEK,
    taxes: CUSTOM_TAXES,
    uid_tax_class: DEFAULT_CLASS,
    uidOrder: "order1",
  });
  // Part of the data contract, not a UI hint: api-cloudrun's `buildOrderLineItem`
  // branches on it to skip the product lookup.
  assert(line.uid.startsWith("custom-"));
  assertEquals(line.name, "Custom Item");
  assertEquals(line.quantity, 1);
  assertEquals(line.stock_method, "none");
  assertEquals(line.crms_id, null);
  assertEquals(line.uid_order, "order1");
  assertEquals(line.price.price_formula, FDW_REF);
  assertEquals(line.price.rates, [{ rate_key: "week", amount_cents: 0 }]);
  assertEquals(line.price.replacement_cents, 0);
  assertEquals(line.price.counts, []);
  // Fully-formed modifiers — the caller resolved them.
  assertEquals(line.price.taxes, [{ uid: "tax1", name: "IL", rate: 10, type: "percent", amount_cents: 0 }]);
});

Deno.test("buildCustomOrderLine takes the caller's formula and defaults replacement by type", () => {
  const sale = buildCustomOrderLine({ type: "sale", formula: FIXED, taxes: [], uid_tax_class: DEFAULT_CLASS });
  assertEquals(sale.price.price_formula, FIXED_REF);
  assertEquals(sale.price.replacement_cents, null);
  assertEquals(sale.price.counts, []);

  const explicit = buildCustomOrderLine({
    type: "sale",
    formula: FIVE_DAY_WEEK,
    rates: [{ rate_key: "week", amount_cents: 700 }],
    taxes: [],
    uid_tax_class: DEFAULT_CLASS,
  });
  assertEquals(explicit.price.price_formula, FDW_REF);
  assertEquals(explicit.price.rates, [{ rate_key: "week", amount_cents: 700 }]);
});

Deno.test("buildCustomOrderLine mints a distinct uid per call", () => {
  const a = buildCustomOrderLine({ type: "rental", formula: FIXED, taxes: [], uid_tax_class: DEFAULT_CLASS });
  const b = buildCustomOrderLine({ type: "rental", formula: FIXED, taxes: [], uid_tax_class: DEFAULT_CLASS });
  assert(a.uid !== b.uid);
});

Deno.test("buildCustomInvoiceLine emits no order-only field", () => {
  const line = buildCustomInvoiceLine({ type: "rental", formula: FIVE_DAY_WEEK, taxes: CUSTOM_TAXES, uid_tax_class: DEFAULT_CLASS });

  // The old docblock claimed it "strips order-only fields" while the `initial`
  // spread put `stock_method: "bulk"`, `order_number: 0` and `uid_order: ""`
  // straight back in. An invoice line arm is a strictObject with none of them.
  for (const key of ["stock_method", "crms_id", "uid_order", "order_number", "inclusion_type"]) {
    assert(!(key in line), `invoice line must not carry ${key}`);
  }
  // `zero_priced` is the exception and is REQUIRED on every stored line: a custom line is
  // never a kit component, so it states `null` rather than leaving the key absent.
  assertEquals(line.zero_priced, null);
  // An invoice does not track replacement value.
  assert(!("replacement" in line.price));
  assertEquals(line.price.counts, []);
  assertEquals(line.price.price_formula, FDW_REF);
  assert(line.uid.startsWith("custom-"));
});

Deno.test("componentQuantities: the movement fan-out walks the same rule as the order expander (api-cloudrun#388)", async (t) => {
  const row = (uid: string, path: string[], quantity: number, inclusion_type: string) => comp(uid, path, { quantity, inclusion_type });
  const comps = [
    row("sides", ["tent"], 4, "mandatory"),
    row("stakes", ["tent", "sides"], 0.5, "default"),
    row("bag", ["tent"], 0.5, "default"),
    row("lights", ["tent"], 2, "optional"),
    row("bulbs", ["tent", "lights"], 3, "mandatory"),
  ];
  await t.step("ceil per level, depth-first, optional subtree dropped", () => {
    const walked = componentQuantities("tent", comps, 3);
    assertEquals(walked.map((w) => [w.component.uid, w.quantity, w.path.join("/")]), [
      ["sides", 12, "tent/sides"],
      ["stakes", 6, "tent/sides/stakes"],
      ["bag", 2, "tent/bag"],
    ]);
  });
  await t.step("agrees with buildOrderComponentLines on the same tree", () => {
    const lines = buildOrderComponentLines(
      product({ uid: "tent", components: comps }),
      { ...OPTS, quantity: 3 },
    );
    assertEquals(lines.map((l) => [l.uid, l.quantity]), componentQuantities("tent", comps, 3).map((w) => [w.component.uid, w.quantity]));
  });
});

// ── raisedQuantity: an operator raises an OPTIONAL component ───────────────
//
// Every expected value below is a literal worked by hand from the fixture, never
// recomputed by the walk under test.

Deno.test("raisedQuantity: an optional the operator raises expands, with its own children, off the typed number", async (t) => {
  // A is the root. `tank` is optional at catalog quantity 0; `cap` (×1) and
  // `hose` (×0.5) are mandatory under it; `jerry` is a nested optional.
  const doc = product({
    components: [
      comp("tank", ["A"], { inclusion_type: "optional", quantity: 0 }),
      comp("cap", ["A", "tank"], { inclusion_type: "mandatory", quantity: 1 }),
      comp("hose", ["A", "tank"], { inclusion_type: "mandatory", quantity: 0.5 }),
      comp("jerry", ["A", "tank"], { inclusion_type: "optional", quantity: 0 }),
      comp("kept", ["A"], { inclusion_type: "default", quantity: 1 }),
    ],
  });
  const raise = (answers: Record<string, number>) => (c: ProductDocumentComponent) => answers[c.uid!];

  await t.step("a raised direct optional emits at the typed quantity and keeps its inclusion_type and ratio", () => {
    const lines = buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: raise({ tank: 3 }) });
    // cap = ceil(1 × 3) = 3, hose = ceil(0.5 × 3) = 2 — scaled off the TYPED 3.
    assertEquals(lines.map((l) => [l.uid, l.quantity]), [["tank", 3], ["cap", 3], ["hose", 2], ["kept", 1]]);
    const tank = lines[0];
    assertEquals(tank.inclusion_type, "optional");
    assertEquals(tank.quantity_per_parent, 0);
    assertEquals(tank.path, ["A", "tank"]);
    assertEquals(lines[1].path, ["A", "tank", "cap"]);
  });

  await t.step("a nested optional emits only when it is raised itself", () => {
    const parentOnly = buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: raise({ tank: 3 }) });
    assertEquals(parentOnly.map((l) => l.uid), ["tank", "cap", "hose", "kept"]);

    const both = buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: raise({ tank: 3, jerry: 2 }) });
    assertEquals(both.map((l) => [l.uid, l.quantity]), [["tank", 3], ["cap", 3], ["hose", 2], ["jerry", 2], ["kept", 1]]);
    assertEquals(both[3].path, ["A", "tank", "jerry"]);
  });

  await t.step("raising a nested optional whose parent is not raised emits nothing — its parent is unreached", () => {
    const lines = buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: raise({ jerry: 2 }) });
    assertEquals(lines.map((l) => l.uid), ["kept"]);
  });

  await t.step("0, undefined and no callback all produce exactly today's output", () => {
    const none = buildOrderComponentLines(doc, OPTS);
    assertEquals(none.map((l) => l.uid), ["kept"]);
    assertEquals(buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: raise({ tank: 0 }) }), none);
    assertEquals(buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: () => undefined }), none);
  });

  await t.step("a raised quantity is ABSOLUTE: the parent changing does not scale it, its children still do", () => {
    const at2 = buildOrderComponentLines(doc, { ...OPTS, quantity: 2, raisedQuantity: raise({ tank: 3 }) });
    const at4 = buildOrderComponentLines(doc, { ...OPTS, quantity: 4, raisedQuantity: raise({ tank: 3 }) });
    assertEquals(at2.map((l) => [l.uid, l.quantity]), [["tank", 3], ["cap", 3], ["hose", 2], ["kept", 2]]);
    assertEquals(at4.map((l) => [l.uid, l.quantity]), [["tank", 3], ["cap", 3], ["hose", 2], ["kept", 4]]);
  });

  await t.step("the callback is ignored for a mandatory or default row", () => {
    const lines = buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: raise({ kept: 9 }) });
    assertEquals(lines.map((l) => [l.uid, l.quantity]), [["kept", 1]]);
  });

  await t.step("paths carry inheritedAncestry", () => {
    const lines = buildOrderComponentLines(doc, { ...OPTS, inheritedAncestry: ["X"], raisedQuantity: raise({ tank: 3 }) });
    assertEquals(lines[0].path, ["X", "A", "tank"]);
    assertEquals(lines[1].path, ["X", "A", "tank", "cap"]);
  });

  await t.step("componentQuantities agrees with buildOrderComponentLines under the same callback", () => {
    const answers = raise({ tank: 3, jerry: 2 });
    const walked = componentQuantities("A", doc.components!, 1, ["A"], answers);
    const lines = buildOrderComponentLines(doc, { ...OPTS, raisedQuantity: answers });
    assertEquals(walked.map((w) => [w.component.uid, w.quantity, w.path.join("/")]), [
      ["tank", 3, "A/tank"],
      ["cap", 3, "A/tank/cap"],
      ["hose", 2, "A/tank/hose"],
      ["jerry", 2, "A/tank/jerry"],
      ["kept", 1, "A/kept"],
    ]);
    assertEquals(lines.map((l) => [l.uid, l.quantity]), walked.map((w) => [w.component.uid, w.quantity]));
  });
});

// ── Posting fields (`LinePostingCore`) ─────────────────────────────────

Deno.test("posting: each line starts at its OWN catalog source's account and category", () => {
  const CAT_KIT = "TrackCatKitAAAAAAAAA";
  const CAT_B = "TrackCatBBBBBBBBBBBB";
  const doc = product({
    uid_tracking_category: CAT_KIT,
    price: { ...catalogPrice(FIVE_DAY_WEEK, 10000), replacement_cents: 50000, coa_revenue: 4000 },
    components: [
      comp("B", ["A"], { uid_tracking_category: CAT_B, price: { ...catalogPrice(FIVE_DAY_WEEK, 1000), coa_revenue: 4100 } }),
      // An entry stamped before the mirror existed carries no category.
      comp("C", ["A"]),
    ],
  });
  const top = buildOrderLineFromProduct(doc, OPTS);
  assertEquals([top.coa_revenue, top.uid_tracking_category], [4000, CAT_KIT]);
  const [b, c] = buildOrderComponentLines(doc, OPTS);
  // A component takes ITS product's posting (the mirror), never the kit's.
  assertEquals([b.coa_revenue, b.uid_tracking_category], [4100, CAT_B]);
  assertEquals([c.coa_revenue, c.uid_tracking_category], [null, null]);
  const custom = buildCustomOrderLine({ type: "sale", formula: FIXED, taxes: [], uid_tax_class: DEFAULT_CLASS });
  assertEquals([custom.coa_revenue, custom.uid_tracking_category], [null, null]);
});
