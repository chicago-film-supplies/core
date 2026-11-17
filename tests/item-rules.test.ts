/**
 * `itemArrayIssues` — the one composition of the items-array rules.
 *
 * Each rule is planted once per grain it applies to, on a document that is
 * otherwise clean, and the per-grain rule set is written out by hand: a rule
 * dropped from the composition, or applied to the wrong grain, fails here.
 */
import { assert, assertEquals } from "@std/assert";
import { type ItemArrayDoc, type ItemArrayGrain, itemArrayIssues, type ItemArrayRule } from "../src/utils/item-rules.ts";

const ORDER = "Order000000000000777";
const D = "00000000-0000-4000-8000-0000000000d1";
const G = "00000000-0000-4000-8000-0000000000a1";
const G2 = "00000000-0000-4000-8000-0000000000a2";
const KIT = "LightKit";
const LAMP = "LampHead";

// deno-lint-ignore no-explicit-any
type Row = any;

/** A clean document of `grain`: one leg, one group, a kit and its component. */
function clean(grain: ItemArrayGrain): ItemArrayDoc & { items: Row[] } {
  const pre = grain === "invoice" || grain === "purchase_document" || grain === "credit_note" ? [ORDER] : [];
  const scope = grain === "invoice" || grain === "credit_note" ? "order" : "purchase";
  const items: Row[] = [
    ...(pre.length > 0 ? [{ uid: ORDER, type: scope, name: "Scope", path: [ORDER] }] : []),
    { uid: D, type: "destination", name: "Leg", path: [...pre, D] },
    { uid: G, type: "group", name: "Group", path: [...pre, D, G] },
    { uid: KIT, type: "rental", name: "Kit", quantity: 1, zero_priced: null, path: [...pre, D, G, KIT] },
    { uid: LAMP, type: "rental", name: "Lamp", quantity: 2, zero_priced: true, path: [...pre, D, G, KIT, LAMP] },
  ];
  return {
    items,
    destinations: [{ uid: D }],
    ...(grain === "invoice" ? { query_by_orders: [ORDER] } : {}),
    ...(grain === "purchase_document" ? { query_by_purchases: [ORDER] } : {}),
  };
}

const at = (doc: { items: Row[] }, uid: string) => doc.items.find((i) => i.uid === uid);
const pre = (grain: ItemArrayGrain) => (grain === "invoice" || grain === "purchase_document" ? [ORDER] : []);

/** Each rule's plant: a minimal edit to a clean document that breaks that rule. */
const PLANTS: Record<ItemArrayRule, (doc: ItemArrayDoc & { items: Row[] }, grain: ItemArrayGrain) => void> = {
  leading_divider: (doc) => {
    doc.items.unshift({ uid: "Stray", type: "rental", name: "Stray", quantity: 1, zero_priced: null, path: ["Stray"] });
  },
  destination_join: (doc) => {
    doc.destinations = [];
  },
  parentage: (doc, grain) => {
    doc.items.push({ uid: G2, type: "group", name: "Nested", path: [...pre(grain), D, G, KIT, G2] });
  },
  uniqueness: (doc) => {
    doc.items.push({ ...at(doc, LAMP) });
  },
  path_empty: (doc) => {
    at(doc, LAMP).path = [];
  },
  path_not_self: (doc, grain) => {
    at(doc, LAMP).path = [...pre(grain), D, G, KIT, "NotTheLamp"];
  },
  path_fixed_point: (doc, grain) => {
    at(doc, KIT).path = [...pre(grain), D, KIT]; // skips its group
  },
  zero_priced_non_component: (doc) => {
    at(doc, KIT).zero_priced = true;
  },
  zero_priced_unstated: (doc) => {
    at(doc, LAMP).zero_priced = null;
  },
  zero_quantity_component: (doc) => {
    at(doc, LAMP).quantity = 0;
  },
  mixed_booking_grain: (doc, grain) => {
    doc.items.push(
      { uid: G2, type: "group", name: "Other", path: [...pre(grain), D, G2] },
      { uid: KIT, type: "sale", name: "Kit", quantity: 1, zero_priced: null, path: [...pre(grain), D, G2, KIT] },
    );
  },
  exchanged_for: (doc, grain) => {
    at(doc, LAMP).exchanged_for = [{ path: [...pre(grain), D, G, KIT, LAMP], quantity: 1, reason: "damaged" }];
  },
};

/** Which rules each grain applies — written by hand, never derived. */
const RULES_BY_GRAIN: Record<ItemArrayGrain, ItemArrayRule[]> = {
  order: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated", "zero_quantity_component",
    "mixed_booking_grain", "exchanged_for",
  ],
  fulfillment: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated", "exchanged_for",
  ],
  invoice: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated", "exchanged_for",
  ],
  // The payable grains (one-document-model Phase 3): a purchase and its receipt at
  // order depth, a bill or credit at invoice depth under a `purchase` divider. A
  // payable pair carries an exchange leg since ruling 81 (7a, C16), so each runs
  // the `exchanged_for` arm of its role; no booking-grain rule until Phase 7b.
  purchase: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated", "exchanged_for",
  ],
  purchase_receipt: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated", "exchanged_for",
  ],
  purchase_document: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated", "exchanged_for",
  ],
  // The AR credit note (ruling 34 item 2): the invoice's structural rules at
  // `CREDIT_NOTE_ITEM_LEVELS`. No `exchanged_for` arm: a credit copies its
  // billing row's list and takes nothing back of its own.
  credit_note: [
    "leading_divider", "destination_join", "parentage", "uniqueness", "path_empty", "path_not_self",
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated",
  ],
};

const GRAINS: ItemArrayGrain[] = ["order", "fulfillment", "invoice", "purchase", "purchase_receipt", "purchase_document", "credit_note"];

for (const grain of GRAINS) {
  Deno.test(`itemArrayIssues(${grain}): a clean document has no issues`, () => {
    assertEquals(itemArrayIssues(clean(grain), grain), []);
  });

  for (const rule of RULES_BY_GRAIN[grain]) {
    Deno.test(`itemArrayIssues(${grain}): ${rule} is reported`, () => {
      const doc = clean(grain);
      PLANTS[rule](doc, grain);
      const rules = itemArrayIssues(doc, grain).map((i) => i.rule);
      assert(rules.includes(rule), `expected ${rule}, got ${JSON.stringify(rules)}`);
    });
  }

  Deno.test(`itemArrayIssues(${grain}): applies exactly its own rules`, () => {
    // Plant every rule, applicable or not; the set reported must be the grain's.
    const reported = new Set<ItemArrayRule>();
    for (const rule of Object.keys(PLANTS) as ItemArrayRule[]) {
      const doc = clean(grain);
      PLANTS[rule](doc, grain);
      for (const i of itemArrayIssues(doc, grain)) reported.add(i.rule);
    }
    assertEquals([...reported].sort(), [...RULES_BY_GRAIN[grain]].sort());
  });

  Deno.test(`itemArrayIssues(${grain}): recompute repairs a stale path before judging it`, () => {
    const doc = clean(grain);
    PLANTS.path_fixed_point(doc, grain);
    assertEquals(itemArrayIssues(doc, grain, { recompute: true }), []);
  });
}

Deno.test("itemArrayIssues: a hand-correct document with one kit twice in a group is a fixed point", () => {
  // core#129's shape: the lamp's kit standalone, and nested in a bigger kit.
  const BIG = "BigRig";
  const doc = clean("order");
  doc.items.push(
    { uid: BIG, type: "rental", name: "Rig", quantity: 1, zero_priced: null, path: [D, G, BIG] },
    { uid: KIT, type: "rental", name: "Kit", quantity: 1, zero_priced: true, path: [D, G, BIG, KIT] },
    { uid: LAMP, type: "rental", name: "Lamp", quantity: 2, zero_priced: true, path: [D, G, BIG, KIT, LAMP] },
  );
  assertEquals(itemArrayIssues(doc, "order"), []);
});

Deno.test("itemArrayIssues: an exchanged_for issue carries the refinement's own message", () => {
  const doc = clean("order");
  PLANTS.exchanged_for(doc, "order");
  const issue = itemArrayIssues(doc, "order").find((i) => i.rule === "exchanged_for");
  assertEquals(issue, {
    rule: "exchanged_for",
    index: 3,
    entry: null,
    field: "exchanged_for",
    message: "exchanged_for is valid only on a row under a destination pair marked as an exchange",
  });
});

// ── The credit role's billing level (one-document-model ruling 107) ──────────

const INV_A = "InvoiceA000000000001";
const INV_B = "InvoiceB000000000002";
const LINE = "SaleLine";

/** A credit crediting ONE order line billed by two invoices: a deposit and a final. */
function twoInvoiceCredit(): ItemArrayDoc & { items: Row[] } {
  const under = (inv: string): Row[] => [
    { uid: inv, type: "billing", name: `Invoice ${inv}`, path: [inv] },
    { uid: ORDER, type: "order", name: "Order #777", path: [inv, ORDER] },
    { uid: D, type: "destination", name: "Leg", path: [inv, ORDER, D] },
    { uid: LINE, type: "sale", name: "Tape", quantity: 1, zero_priced: null, path: [inv, ORDER, D, LINE] },
  ];
  return { items: [...under(INV_A), ...under(INV_B)] };
}

Deno.test("itemArrayIssues(credit_note): two invoices billing one order line do not collide under their billing dividers", () => {
  assertEquals(itemArrayIssues(twoInvoiceCredit(), "credit_note"), []);
  // Without the billing level the two rows are one path: the collision ruling 107 removes.
  const flattened = { items: twoInvoiceCredit().items.filter((r) => r.type !== "billing").map((r) => ({ ...r, path: r.path.slice(1) })) };
  assert(itemArrayIssues(flattened, "credit_note").some((i) => i.rule === "uniqueness"));
});

Deno.test("itemArrayIssues(credit_note): a flat historic note is legal, a divided one leads with a billing or order divider", () => {
  const flat: { items: Row[] } = { items: [{ uid: LINE, type: "sale", name: "Tape", quantity: 1, zero_priced: null, path: [LINE] }] };
  // Its `sources` name orders, and still no leading divider is owed (ruling 53).
  assertEquals(itemArrayIssues({ ...flat, sources: [{ collection: "orders" }] }, "credit_note"), []);
  const leadsWithLine = { items: [...flat.items, ...twoInvoiceCredit().items] };
  assert(itemArrayIssues(leadsWithLine, "credit_note").some((i) => i.rule === "leading_divider"), "a divided note leads with a divider");
});

Deno.test("itemArrayIssues(credit_note): an unpointed line written AFTER a billing divider nests under it, so it goes first", () => {
  const rows = twoInvoiceCredit().items;
  const goodwill: Row = { uid: "Goodwill", type: "service", name: "Goodwill", quantity: 1, zero_priced: null, path: ["Goodwill"] };
  assert(itemArrayIssues({ items: [...rows, goodwill] }, "credit_note").some((i) => i.rule === "path_fixed_point"));
});

Deno.test("itemArrayIssues(purchase_document): a supplier credit holds one purchase divider per bill it credits", () => {
  const P = ORDER;
  const under = (bill: string): Row[] => [
    { uid: bill, type: "billing", name: `Bill ${bill}`, path: [bill] },
    { uid: P, type: "purchase", name: "PO-1", path: [bill, P] },
    { uid: D, type: "destination", name: "Leg", path: [bill, P, D] },
    { uid: LINE, type: "sale", name: "Tape", quantity: 1, zero_priced: null, path: [bill, P, D, LINE] },
  ];
  assertEquals(itemArrayIssues({ items: [...under(INV_A), ...under(INV_B)], destinations: [{ uid: D }] }, "purchase_document"), []);
  // A bill's paths do not move: no billing row, nothing above the purchase.
  assertEquals(itemArrayIssues(clean("purchase_document"), "purchase_document"), []);
});
