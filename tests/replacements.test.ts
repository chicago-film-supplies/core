import { assertEquals } from "@std/assert";
import {
  billedOutOfService,
  overbilledOutOfService,
  type ReplacementBillingInvoice,
  type ReplacementSourceProduct,
  type ReplacementSourceRecord,
  seedReplacementLines,
} from "../src/utils/replacements.ts";

const ORDER = "Order000000000000001";
const PAIR = "00000000-0000-4000-8000-0000000de501";
const VEST_LINE = "Item0000000000000001";
const CONE_LINE = "Item0000000000000002";

const order = {
  uid: ORDER,
  items: [
    { uid: PAIR, type: "destination", path: [PAIR] },
    { uid: VEST_LINE, type: "rental", path: [PAIR, VEST_LINE], price: { replacement_cents: 2500 } },
    { uid: CONE_LINE, type: "rental", path: [PAIR, CONE_LINE], price: { replacement_cents: 0 } },
  ],
};

const products = new Map<string, ReplacementSourceProduct>([
  ["vest", { uid: "vest", name: "Safety Vest", uid_linked_replacement: "vest-r" }],
  ["vest-r", { uid: "vest-r", name: "Replacement: Safety Vest", price: { base_cents: 3000 } }],
  ["cone", { uid: "cone", name: "Traffic Cone", uid_linked_replacement: "cone-r" }],
  ["cone-r", { uid: "cone-r", name: "Replacement: Traffic Cone", price: { base_cents: 4500 } }],
  ["legacy", { uid: "legacy", name: "Old Stand", uid_linked_replacement: null }],
]);

function record(uid: string, product: string, line: string, quantity: number, extra: Partial<ReplacementSourceRecord> = {}): ReplacementSourceRecord {
  return {
    uid,
    uid_product: product,
    reason: "lost",
    status: "active",
    quantity,
    query_by_sources: [`bookings:${ORDER}:${line}:${PAIR}`, `orders:${ORDER}`],
    ...extra,
  };
}

const vests = record("oosVest", "vest", VEST_LINE, 7);
const cone = record("oosCone", "cone", CONE_LINE, 1);

function invoice(uid: string, status: string, lines: Array<[string, number]>): ReplacementBillingInvoice {
  return { uid, status, items: lines.map(([u, q]) => ({ type: "replacement", quantity: q, uid_out_of_service: u })) };
}

Deno.test("seed: 7 vests + 1 cone, at the quoted value and else the twin's price", () => {
  const seeds = seedReplacementLines(order, [vests, cone], [], products);
  assertEquals(seeds.map((s) => [s.name, s.quantity, s.base_cents, s.uid_pair, s.uid_product]), [
    ["Replacement: Safety Vest", 7, 2500, PAIR, "vest-r"],
    // The cone line quoted 0, which says nothing — fall back to the twin.
    ["Replacement: Traffic Cone", 1, 4500, PAIR, "cone-r"],
  ]);
});

Deno.test("seed: billed units are subtracted, and a void invoice bills nothing", () => {
  const partly = invoice("inv1", "authorised", [["oosVest", 5]]);
  const voided = invoice("inv2", "void", [["oosVest", 2], ["oosCone", 1]]);
  const seeds = seedReplacementLines(order, [vests, cone], [partly, voided], products);
  assertEquals(seeds.map((s) => [s.uid_out_of_service, s.quantity]), [["oosVest", 2], ["oosCone", 1]]);

  const fully = invoice("inv3", "draft", [["oosVest", 2], ["oosCone", 1]]);
  assertEquals(seedReplacementLines(order, [vests, cone], [partly, voided, fully], products), []);
});

Deno.test("seed: skips canceled records, non-billable reasons and other orders' records", () => {
  const canceled = record("a", "vest", VEST_LINE, 1, { status: "canceled" });
  const cleaning = record("b", "vest", VEST_LINE, 1, { reason: "cleaning" });
  const elsewhere = record("c", "vest", VEST_LINE, 1, { query_by_sources: ["orders:Order000000000000009"] });
  assertEquals(seedReplacementLines(order, [canceled, cleaning, elsewhere], [], products), []);
});

Deno.test("seed: a rental with no twin is offered as a custom line with a warning, never dropped", () => {
  const stand = record("oosStand", "legacy", VEST_LINE, 1, { query_by_sources: [`orders:${ORDER}`] });
  const [seed] = seedReplacementLines(order, [stand], [], products);
  assertEquals(seed.uid_product, null);
  assertEquals(seed.name, "Replacement: Old Stand");
  assertEquals(seed.uid_pair, null);
  assertEquals(seed.base_cents, 0);
  assertEquals(typeof seed.warning, "string");
});

Deno.test("billed sum excludes the invoice being rewritten", () => {
  const inv = invoice("inv1", "authorised", [["oosVest", 5]]);
  assertEquals(billedOutOfService([inv]).get("oosVest"), 5);
  assertEquals(billedOutOfService([inv], "inv1").get("oosVest"), undefined);
});

Deno.test("overbilled: refuses past the record's quantity, counting other invoices", () => {
  const other = invoice("inv1", "authorised", [["oosVest", 5]]);
  assertEquals(overbilledOutOfService([{ quantity: 2, uid_out_of_service: "oosVest" }], [vests], [other], "inv2"), []);
  assertEquals(
    overbilledOutOfService([{ quantity: 3, uid_out_of_service: "oosVest" }], [vests], [other], "inv2"),
    [{ uid_out_of_service: "oosVest", quantity: 7, billed_elsewhere: 5, billing_here: 3 }],
  );
  // Rewriting inv1 itself: its stored 5 is replaced by the new lines, not added.
  assertEquals(overbilledOutOfService([{ quantity: 7, uid_out_of_service: "oosVest" }], [vests], [other], "inv1"), []);
  // A record that does not exist holds 0.
  assertEquals(overbilledOutOfService([{ quantity: 1, uid_out_of_service: "ghost" }], [], [], "x").length, 1);
});
