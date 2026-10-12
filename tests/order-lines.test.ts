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
    price: { base_cents: 1000, formula: "five_day_week" },
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
    price: { base_cents: 10000, replacement_cents: 50000, formula: "five_day_week" },
    ...over,
  };
}

// A real 20-char id, so the test that parses a built line against the stored
// schema passes `FirestoreId`. Keyed by type so a test can see which it took.
const DEFAULT_CLASS = "TaxC1assDefau1tAAAAA";
const taxClassForType = (type: string) => (type === "sale" ? "TaxC1assSa1eAAAAAAAA" : DEFAULT_CLASS);
const OPTS = { quantity: 1, chargeDays: 5, taxClassForType };

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
    product({ uid: REAL_PRODUCT_UID, price: { base_cents: 10000, replacement_cents: 50000, formula: "five_day_week" } }),
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
  assertEquals(line.price.base_cents, 10000);
  assertEquals(line.price.replacement_cents, 50000);
  assertEquals(line.price.chargeable_days, 5);
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
  // A sale line takes no chargeable_days — only a rental does.
  assertEquals(line.price.chargeable_days, null);
});

Deno.test("buildOrderLineFromProduct carries a percent_of_total product's rate and zeroes base_cents", () => {
  // The prod Card Fee shape. Before `base_percent` was copied, this line staged
  // as a percent fee with no rate and priced at $0.
  const line = buildOrderLineFromProduct(
    product({
      uid: REAL_PRODUCT_UID,
      type: "transaction_fee",
      stock_method: "none",
      price: { base_cents: 0, base_percent: 4, formula: "percent_of_total" },
    }),
    { ...OPTS, uidOrder: REAL_ORDER_UID },
  );
  assertEquals(line.price.formula, "percent_of_total");
  assertEquals(line.price.base_percent, 4);
  assertEquals(line.price.base_cents, 0);
  assertEquals(line.price.chargeable_days, null);

  // A stray base_cents on the catalog doc cannot break the biconditional.
  const stray = buildOrderLineFromProduct(
    product({ type: "transaction_fee", price: { base_cents: 500, base_percent: 4, formula: "percent_of_total" } }),
    OPTS,
  );
  assertEquals(stray.price.base_cents, 0);
  assertEquals(stray.price.base_percent, 4);
});

Deno.test("buildOrderLineFromProduct states base_percent: null on a non-percent price", () => {
  const line = buildOrderLineFromProduct(product(), OPTS);
  assertEquals(line.price.base_percent, null);
  assertEquals(line.price.base_cents, 10000);
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
  const custom = buildCustomOrderLine({ type: "sale", chargeDays: null, taxes: [], uid_tax_class: "AbCdEfGhIjKlMnOpQrSt" });
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
    components: [comp("F", ["A"], { zero_priced: true, price: { base_cents: 9900 } })],
  });
  assertEquals(buildOrderComponentLines(doc, OPTS)[0].price.base_cents, 0);
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
  first.price.base_cents = 12345;
  first.path.push("mutated");
  assert(second.price.base_cents !== 12345);
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
  assertEquals(line.price.base_cents, 1000);
});

Deno.test("deriveLineCatalogFacts: the price follows the flag it is given", () => {
  const p = { type: "rental", stock_method: "bulk", price: { base_cents: 2500, replacement_cents: 9000, formula: "five_day_week" } };
  assertEquals(deriveLineCatalogFacts(p, true).price.base_cents, 0);
  assertEquals(deriveLineCatalogFacts(p, false).price.base_cents, 2500);
  assertEquals(deriveLineCatalogFacts(p, null).price.base_cents, 2500);
  assertEquals(deriveLineCatalogFacts(p, true).zero_priced, true);
  assertEquals(deriveLineCatalogFacts(p, true).price.replacement_cents, 9000);
});

Deno.test("deriveLineCatalogFacts: the CATALOG formula wins over the type default", () => {
  // Prod's two Combo Hangers rentals are deliberately `fixed`; a type-derived
  // formula bills them per day (api-cloudrun#1286).
  const hangers = { type: "rental", stock_method: "bulk", price: { base_cents: 3000, formula: "fixed" } };
  assertEquals(deriveLineCatalogFacts(hangers, null).price.formula, "fixed");
  // Only a catalog that states nothing takes the type's default.
  assertEquals(deriveLineCatalogFacts({ type: "rental", price: {} }, null).price.formula, "five_day_week");
  assertEquals(deriveLineCatalogFacts({ type: "sale", price: {} }, null).price.formula, "fixed");
  assertEquals(deriveLineCatalogFacts({ type: "sale" }, null).price.formula, "fixed");
});

Deno.test("deriveLineCatalogFacts: percent_of_total states base 0 and the rate; others state base_percent null", () => {
  const fee = { type: "transaction_fee", stock_method: "none", price: { base_cents: 999, base_percent: 3, formula: "percent_of_total" } };
  assertEquals(deriveLineCatalogFacts(fee, null).price, { base_cents: 0, base_percent: 3, replacement_cents: null, formula: "percent_of_total" });
  const sale = { type: "sale", stock_method: "bulk", price: { base_cents: 500, base_percent: 7, formula: "fixed" } };
  assertEquals(deriveLineCatalogFacts(sale, null).price.base_percent, null);
});

Deno.test("both builders agree with deriveLineCatalogFacts field for field", () => {
  const top = buildOrderLineFromProduct(product({ price: { base_cents: 4200, replacement_cents: 7, formula: "fixed" } }), OPTS);
  const topFacts = deriveLineCatalogFacts(product({ price: { base_cents: 4200, replacement_cents: 7, formula: "fixed" } }), null);
  assertEquals(
    { type: top.type, stock_method: top.stock_method, zero_priced: top.zero_priced, base_cents: top.price.base_cents, base_percent: top.price.base_percent, replacement_cents: top.price.replacement_cents, formula: top.price.formula },
    { type: topFacts.type, stock_method: topFacts.stock_method, zero_priced: topFacts.zero_priced, ...topFacts.price },
  );
  const c = comp("F", ["A"], { zero_priced: true, price: { base_cents: 9900, replacement_cents: 1, formula: "fixed" } });
  const [line] = buildOrderComponentLines(product({ components: [c] }), OPTS);
  const facts = deriveLineCatalogFacts(c, zeroPricedForSlot(c));
  assertEquals(
    { type: line.type, stock_method: line.stock_method, zero_priced: line.zero_priced, base_cents: line.price.base_cents, replacement_cents: line.price.replacement_cents, formula: line.price.formula },
    { type: facts.type, stock_method: facts.stock_method, zero_priced: facts.zero_priced, base_cents: facts.price.base_cents, replacement_cents: facts.price.replacement_cents, formula: facts.price.formula },
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
    chargeDays: 5,
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
  assertEquals(line.price.formula, "five_day_week");
  assertEquals(line.price.replacement_cents, 0);
  assertEquals(line.price.chargeable_days, 5);
  // Fully-formed modifiers — the caller resolved them.
  assertEquals(line.price.taxes, [{ uid: "tax1", name: "IL", rate: 10, type: "percent", amount_cents: 0 }]);
});

Deno.test("buildCustomOrderLine defaults formula and replacement by type", () => {
  const sale = buildCustomOrderLine({ type: "sale", chargeDays: 5, taxes: [], uid_tax_class: DEFAULT_CLASS });
  assertEquals(sale.price.formula, "fixed");
  assertEquals(sale.price.replacement_cents, null);
  assertEquals(sale.price.chargeable_days, null);

  const explicit = buildCustomOrderLine({ type: "sale", chargeDays: null, taxes: [], uid_tax_class: DEFAULT_CLASS, formula: "five_day_week" });
  assertEquals(explicit.price.formula, "five_day_week");
});

Deno.test("buildCustomOrderLine mints a distinct uid per call", () => {
  const a = buildCustomOrderLine({ type: "rental", chargeDays: null, taxes: [], uid_tax_class: DEFAULT_CLASS });
  const b = buildCustomOrderLine({ type: "rental", chargeDays: null, taxes: [], uid_tax_class: DEFAULT_CLASS });
  assert(a.uid !== b.uid);
});

Deno.test("buildCustomInvoiceLine emits no order-only field", () => {
  const line = buildCustomInvoiceLine({ type: "rental", chargeDays: 5, taxes: CUSTOM_TAXES, uid_tax_class: DEFAULT_CLASS });

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
  assertEquals(line.price.chargeable_days, 5);
  assertEquals(line.price.formula, "five_day_week");
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
