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
  const pre = grain === "invoice" ? [ORDER] : [];
  const items: Row[] = [
    ...(grain === "invoice" ? [{ uid: ORDER, type: "order", name: "Order", path: [ORDER] }] : []),
    { uid: D, type: "destination", name: "Leg", path: [...pre, D] },
    { uid: G, type: "group", name: "Group", path: [...pre, D, G] },
    { uid: KIT, type: "rental", name: "Kit", quantity: 1, zero_priced: null, path: [...pre, D, G, KIT] },
    { uid: LAMP, type: "rental", name: "Lamp", quantity: 2, zero_priced: true, path: [...pre, D, G, KIT, LAMP] },
  ];
  return { items, destinations: [{ uid: D }], ...(grain === "invoice" ? { query_by_orders: [ORDER] } : {}) };
}

const at = (doc: { items: Row[] }, uid: string) => doc.items.find((i) => i.uid === uid);
const pre = (grain: ItemArrayGrain) => (grain === "invoice" ? [ORDER] : []);

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
    "path_fixed_point", "zero_priced_non_component", "zero_priced_unstated",
  ],
};

const GRAINS: ItemArrayGrain[] = ["order", "fulfillment", "invoice"];

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
