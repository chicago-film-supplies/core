import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  buildCustomInvoiceLine,
  buildCustomOrderLine,
  buildOrderComponentLines,
  buildOrderLineFromProduct,
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
    price: { base_cents: 1000, formula: "five_day_week", taxes: [{ uid: "tax1" }] },
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
    price: { base_cents: 10000, replacement_cents: 50000, formula: "five_day_week", taxes: [{ uid: "tax1" }] },
    ...over,
  };
}

const OPTS = { quantity: 1, chargeDays: 5 };

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
const REAL_TAX_UID = "Tax1AAAAAAAAAAAAAAAA";

Deno.test("buildOrderLineFromProduct emits a schema-valid line, ancestry-only path", () => {
  const line = buildOrderLineFromProduct(
    product({ uid: REAL_PRODUCT_UID, price: { base_cents: 10000, replacement_cents: 50000, formula: "five_day_week", taxes: [{ uid: REAL_TAX_UID }] } }),
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
  // Money fields are zero and taxes are bare uid refs until `calculateItemPrice`
  // runs — the documented contract of this module.
  assertEquals(line.price.subtotal_cents, 0);
  assertEquals(line.price.total_cents, 0);
  assertEquals(line.price.taxes, [{ uid: REAL_TAX_UID }] as typeof line.price.taxes);

  // Structurally a line item, modulo the unpriced taxes the contract allows.
  const parsed = OrderDocLineItem.safeParse({
    ...line,
    price: { ...line.price, taxes: [{ uid: REAL_TAX_UID, name: "T", rate: 0, type: "percent", amount_cents: 0 }] },
  });
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

const CUSTOM_TAXES = [{ uid: "tax1", name: "IL", rate: 10, type: "percent" as const }];

Deno.test("buildCustomOrderLine stamps the custom- uid prefix", () => {
  const line = buildCustomOrderLine({
    type: "rental",
    chargeDays: 5,
    taxes: CUSTOM_TAXES,
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
  const sale = buildCustomOrderLine({ type: "sale", chargeDays: 5, taxes: [] });
  assertEquals(sale.price.formula, "fixed");
  assertEquals(sale.price.replacement_cents, null);
  assertEquals(sale.price.chargeable_days, null);

  const explicit = buildCustomOrderLine({ type: "sale", chargeDays: null, taxes: [], formula: "five_day_week" });
  assertEquals(explicit.price.formula, "five_day_week");
});

Deno.test("buildCustomOrderLine mints a distinct uid per call", () => {
  const a = buildCustomOrderLine({ type: "rental", chargeDays: null, taxes: [] });
  const b = buildCustomOrderLine({ type: "rental", chargeDays: null, taxes: [] });
  assert(a.uid !== b.uid);
});

Deno.test("buildCustomInvoiceLine emits no order-only field", () => {
  const line = buildCustomInvoiceLine({ type: "rental", chargeDays: 5, taxes: CUSTOM_TAXES });

  // The old docblock claimed it "strips order-only fields" while the `initial`
  // spread put `stock_method: "bulk"`, `order_number: 0` and `uid_order: ""`
  // straight back in. An invoice line arm is a strictObject with none of them.
  for (const key of ["stock_method", "crms_id", "uid_order", "order_number", "inclusion_type", "zero_priced"]) {
    assert(!(key in line), `invoice line must not carry ${key}`);
  }
  // An invoice does not track replacement value.
  assert(!("replacement" in line.price));
  assertEquals(line.price.chargeable_days, 5);
  assertEquals(line.price.formula, "five_day_week");
  assert(line.uid.startsWith("custom-"));
});
