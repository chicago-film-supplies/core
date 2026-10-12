import { assert, assertEquals, assertStrictEquals } from "@std/assert";

import {
  fulfillmentSourceOfComponent,
  projectFulfillmentLine,
  substitutionRootZeroPriced,
} from "../src/utils/fulfillment-items.ts";
import { catalogComponentAt, retypedLinePrice } from "../src/utils/order-lines.ts";
import type { PriceFormulaType } from "../src/schemas/mod.ts";

type RetypeFixture = {
  formula: PriceFormulaType;
  chargeable_days: number | null;
  replacement_cents?: number | null;
  taxes: unknown[];
  base_cents: number;
};

/**
 * The ONE fulfillment line projector, moved from api-cloudrun
 * `src/lib/fulfillmentLine.ts` (api-cloudrun#1287) so the manager's optimistic
 * substitution and the server build the same row. The key sets are FROZEN
 * LITERALS, not derived from the builder's own output — an expectation computed
 * by the code under test can only agree with it.
 */
const sortedKeys = (o: object) => Object.keys(o).sort();

Deno.test("projectFulfillmentLine: every optional key present — the full key set", () => {
  const line = projectFulfillmentLine(
    { uid: "p", type: "rental", name: "P", description: "d", stock_method: "bulk", zero_priced: false },
    2,
    ["dest", "p"],
    { order_number: 1043, uid_order: "ord", quantity_ordered: 2 },
  );
  assertEquals(sortedKeys(line), [
    "description",
    "name",
    "order_number",
    "path",
    "quantity",
    "quantity_ordered",
    "stock_method",
    "type",
    "uid",
    "uid_order",
    "zero_priced",
  ]);
});

/**
 * 🔴 The arm that pins the property the order-side merge depends on: a key whose
 * PRESENCE moved with its VALUE would make a catalog edit a permanent diff. So
 * `zero_priced` is there when the source says nothing — as `null` — and the three
 * genuinely optional keys are not. `quantity_ordered` is REQUIRED on a stored line
 * (core `beta.582`, decision 19), so a row no order line backs states `null`.
 */
Deno.test("projectFulfillmentLine: a bare source still states zero_priced and quantity_ordered, and omits the optional three", () => {
  const line = projectFulfillmentLine({ uid: "p", type: "rental", name: "P" }, 1, ["dest", "p"]);
  assertEquals(sortedKeys(line), [
    "description",
    "name",
    "path",
    "quantity",
    "quantity_ordered",
    "type",
    "uid",
    "zero_priced",
  ]);
  assertStrictEquals(line.zero_priced, null);
  assertStrictEquals(line.quantity_ordered, null);
  assertStrictEquals(line.description, "");
});

Deno.test("projectFulfillmentLine: an undefined source key is omitted, not stored as undefined", () => {
  const line = projectFulfillmentLine(
    { uid: "p", type: "rental", name: "P", stock_method: undefined },
    1,
    ["dest", "p"],
    { order_number: undefined, uid_order: undefined },
  );
  assertEquals("stock_method" in line, false);
  assertEquals("order_number" in line, false);
  assertEquals("uid_order" in line, false);
});

Deno.test("projectFulfillmentLine: an exchange's `exchanged_for` is carried as a COPY, and omitted when absent", () => {
  // api-cloudrun#1114 — the order line states it; the projection must carry it
  // or the checkout rider marks nothing damaged.
  const exchanged_for = [{ path: ["parent", "x"], quantity: 1, reason: "damaged" as const }];
  const line = projectFulfillmentLine({ uid: "y", type: "rental", name: "Y" }, 1, ["exchange", "y"], { exchanged_for });
  assertEquals(line.exchanged_for, exchanged_for);
  exchanged_for[0].path.push("mutated");
  assertEquals(line.exchanged_for?.[0].path, ["parent", "x"], "the stored row must not alias the order's array");
  const bare = projectFulfillmentLine({ uid: "y", type: "rental", name: "Y" }, 1, ["exchange", "y"], {});
  assertEquals("exchanged_for" in bare, false);
});

// api-cloudrun#1055 — the three answers a replacement root can need, each a
// different non-omission: a kit component's slot states a boolean (core#100
// refuses anything else), a top-level slot states `null`, and a flagged slot
// hands its `true` to the replacement.
Deno.test("substitutionRootZeroPriced: the replacement takes the slot's answer", () => {
  assertStrictEquals(substitutionRootZeroPriced({ zero_priced: true }), true);
  assertStrictEquals(substitutionRootZeroPriced({ zero_priced: false }), false);
  assertStrictEquals(substitutionRootZeroPriced({ zero_priced: null }), null);
  assertStrictEquals(substitutionRootZeroPriced({}), null);
});

Deno.test("fulfillmentSourceOfComponent: a catalog row that says nothing is billed — a boolean, never null", () => {
  const row = { uid: "c", name: "C", type: "rental", stock_method: "bulk" };
  assertStrictEquals(fulfillmentSourceOfComponent(row).zero_priced, false);
  assertStrictEquals(fulfillmentSourceOfComponent({ ...row, zero_priced: true }).zero_priced, true);
  assertEquals(fulfillmentSourceOfComponent({ ...row, description: "d" }), {
    uid: "c",
    type: "rental",
    name: "C",
    description: "d",
    stock_method: "bulk",
    zero_priced: false,
  });
});

// A kit listing one product under TWO parents — included free under X, charged
// directly — is the case a first-uid lookup gets wrong (api-cloudrun#1287 item 2).
const KIT = {
  uid: "K",
  components: [
    { uid: "X", path: ["K"], zero_priced: false },
    { uid: "C", path: ["K", "X"], zero_priced: true },
    { uid: "C", path: ["K"], zero_priced: false },
  ],
};

Deno.test("catalogComponentAt resolves BY PATH, never by first uid", () => {
  assertStrictEquals(catalogComponentAt(KIT, ["X"], "C")?.zero_priced, true);
  assertStrictEquals(catalogComponentAt(KIT, [], "C")?.zero_priced, false);
  assertStrictEquals(catalogComponentAt(KIT, ["Z"], "C"), undefined);
  assertStrictEquals(catalogComponentAt(KIT, ["X", "C"], "C"), undefined);
});

Deno.test("retypedLinePrice: formula and chargeable days follow the type; replacement only where the key exists", () => {
  const order: RetypeFixture = { formula: "fixed", chargeable_days: null, replacement_cents: null, taxes: [{ x: 1 }], base_cents: 500 };
  assertEquals(retypedLinePrice(order, "rental", 3), { formula: "five_day_week", chargeable_days: 3, replacement_cents: 0, taxes: [], base_cents: 500 });
  const rental: RetypeFixture = { formula: "five_day_week", chargeable_days: 3, replacement_cents: 0, taxes: [], base_cents: 500 };
  assertEquals(retypedLinePrice(rental, "sale", 3), { formula: "fixed", chargeable_days: null, replacement_cents: null, taxes: [], base_cents: 500 });
  // An invoice line has no `replacement_cents`, and retyping must not add one.
  const invoice: RetypeFixture = { formula: "fixed", chargeable_days: null, taxes: [], base_cents: 500 };
  assert(!("replacement_cents" in retypedLinePrice(invoice, "rental", null)));
});
