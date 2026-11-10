import { assertEquals, assertThrows } from "@std/assert";
import {
  billedOutOfService,
  billsOutOfService,
  fitOutOfServiceEntries,
  mergeOutOfServiceEntries,
  outOfServiceEntries,
  splitOutOfServiceEntries,
  BILLABLE_OOS_REASONS,
  isBillableOutOfService,
  isOnRequestBillableOutOfService,
  OOS_BILLING_POLICY,
  oosLineTypeFor,
  overbilledOutOfService,
  type ReplacementBillingInvoice,
  type ReplacementSourceProduct,
  type ReplacementSourceRecord,
  type ReplacementSourceUnit,
  seedOnRequestLines,
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
  ["vest-r", { uid: "vest-r", name: "Replacement: Safety Vest", price: { rates: [{ rate_key: "flat", amount_cents: 3000 }] } }],
  ["cone", { uid: "cone", name: "Traffic Cone", uid_linked_replacement: "cone-r" }],
  ["cone-r", { uid: "cone-r", name: "Replacement: Traffic Cone", price: { rates: [{ rate_key: "flat", amount_cents: 4500 }] } }],
  ["legacy", { uid: "legacy", name: "Old Stand" }],
]);

function record(uid: string, product: string, line: string, quantity: number, extra: Partial<ReplacementSourceRecord> = {}): ReplacementSourceRecord {
  return {
    uid,
    uid_product: product,
    reason: "lost",
    status: "active",
    quantity,
    query_by_sources: [`bookings:${ORDER}:${line}:${PAIR}`, `orders:${ORDER}`],
    units: null,
    dates: { start: "2026-03-02T10:00:00.000-06:00" },
    ...extra,
  };
}

const noUnits = new Map<number, ReplacementSourceUnit>();

function unitWith(number: number, entries: Array<[string, string, string | null, "initial" | "replaced" | "corrected"]>): ReplacementSourceUnit {
  return {
    number,
    serial_history: entries.map(([serial_number, start, end, reason]) => ({
      serial_number, start, end, reason, supplier: null, uid_movement: null, notes: "", changed_by: { uid: "u1", name: "Op" },
    })),
  };
}

const vests = record("oosVest", "vest", VEST_LINE, 7);
const cone = record("oosCone", "cone", CONE_LINE, 1);

function invoice(uid: string, status: string, lines: Array<[string, number]>): ReplacementBillingInvoice {
  return { uid, status, items: lines.map(([u, q]) => ({ type: "replacement", quantity: q, uid_out_of_service: u })) };
}

Deno.test("seed: 7 vests + 1 cone, at the quoted value and else the twin's price", () => {
  const seeds = seedReplacementLines(order, [vests, cone], [], products, noUnits);
  assertEquals(seeds.map((s) => [s.name, s.quantity, s.base_cents, s.uid_pair, s.uid_product]), [
    ["Replacement: Safety Vest", 7, 2500, PAIR, "vest-r"],
    // The cone line quoted 0, which says nothing — fall back to the twin.
    ["Replacement: Traffic Cone", 1, 4500, PAIR, "cone-r"],
  ]);
});

Deno.test("seed: billed units are subtracted, and a void invoice bills nothing", () => {
  const partly = invoice("inv1", "authorised", [["oosVest", 5]]);
  const voided = invoice("inv2", "void", [["oosVest", 2], ["oosCone", 1]]);
  const seeds = seedReplacementLines(order, [vests, cone], [partly, voided], products, noUnits);
  assertEquals(seeds.map((s) => [s.uid_out_of_service, s.quantity]), [["oosVest", 2], ["oosCone", 1]]);

  const fully = invoice("inv3", "draft", [["oosVest", 2], ["oosCone", 1]]);
  assertEquals(seedReplacementLines(order, [vests, cone], [partly, voided, fully], products, noUnits), []);
});

Deno.test("seed: skips canceled records, non-billable reasons and other orders' records", () => {
  const canceled = record("a", "vest", VEST_LINE, 1, { status: "canceled" });
  const cleaning = record("b", "vest", VEST_LINE, 1, { reason: "cleaning" });
  const elsewhere = record("c", "vest", VEST_LINE, 1, { query_by_sources: ["orders:Order000000000000009"] });
  assertEquals(seedReplacementLines(order, [canceled, cleaning, elsewhere], [], products, noUnits), []);
});

Deno.test("seed: a rental with no twin is offered as a custom line with a warning, never dropped", () => {
  const stand = record("oosStand", "legacy", VEST_LINE, 1, { query_by_sources: [`orders:${ORDER}`] });
  const [seed] = seedReplacementLines(order, [stand], [], products, noUnits);
  assertEquals(seed.uid_product, null);
  assertEquals(seed.name, "Replacement: Old Stand");
  assertEquals(seed.uid_pair, null);
  assertEquals(seed.base_cents, 0);
  assertEquals(typeof seed.warning, "string");
});

Deno.test("seed: the description names each unit with the serial it carried at the loss", () => {
  const units = new Map<number, ReplacementSourceUnit>([
    [1017, unitWith(1017, [["902ZAE5968", "2024-01-05T09:00:00.000-06:00", "2026-04-01T09:00:00.000-05:00", "initial"], ["902EBQP559", "2026-04-01T09:00:00.000-05:00", null, "replaced"]])],
    [1042, unitWith(1042, [])],
  ]);
  const lost = record("oosVest", "vest", VEST_LINE, 2, {
    units: { away: [1042, 1017].sort((a, b) => a - b), flagged: [], returned_to_service: [], returned_to_supplier: [], written_off: [] },
  });
  const [seed] = seedReplacementLines(order, [lost], [], products, units);
  assertEquals(seed.units, [1017, 1042]);
  // 1017's number now carries a replacement radio; the line names the one lost.
  assertEquals(seed.description, "Units 1017 (S/N 902ZAE5968), 1042");
});

Deno.test("seed: with no serial to name, the description is the ranges; with nothing at all, the reason", () => {
  const damaged = record("oosVest", "vest", VEST_LINE, 4, {
    reason: "damaged",
    units: { away: [], flagged: [1017, 1018], returned_to_service: [1019], returned_to_supplier: [], written_off: [1030] },
  });
  const [ranged] = seedReplacementLines(order, [damaged], [], products, noUnits);
  assertEquals(ranged.description, "Units 1017–1019, 1030");

  const [one] = seedReplacementLines(order, [record("oosVest", "vest", VEST_LINE, 1, {
    units: { away: [1017], flagged: [], returned_to_service: [], returned_to_supplier: [], written_off: [] },
  })], [], products, noUnits);
  assertEquals(one.description, "Unit 1017");

  const [bulk] = seedReplacementLines(order, [vests], [], products, noUnits);
  assertEquals([bulk.units, bulk.description], [[], "Lost"]);
});

Deno.test("seed: the description opens with the replacement twin's description, never the rental's", () => {
  const described = new Map(products);
  described.set("vest", { uid: "vest", name: "Safety Vest", uid_linked_replacement: "vest-r", description: "Rental vest — not this" });
  described.set("vest-r", { uid: "vest-r", name: "Replacement: Safety Vest", price: { rates: [{ rate_key: "flat", amount_cents: 3000 }] }, description: "Otto Two Wire Surveillance Kit - V1-10176" });

  // No units (invoice 2462's shape): the twin's description alone, no "Lost".
  const [bulk] = seedReplacementLines(order, [vests], [], described, noUnits);
  assertEquals(bulk.description, "Otto Two Wire Surveillance Kit - V1-10176");

  const units = new Map<number, ReplacementSourceUnit>([
    [1017, unitWith(1017, [["902ZAE5968", "2024-01-05T09:00:00.000-06:00", null, "initial"]])],
  ]);
  const [named] = seedReplacementLines(order, [record("oosVest", "vest", VEST_LINE, 2, {
    units: { away: [1017, 1042], flagged: [], returned_to_service: [], returned_to_supplier: [], written_off: [] },
  })], [], described, units);
  assertEquals(named.description, "Otto Two Wire Surveillance Kit - V1-10176\nUnits 1017 (S/N 902ZAE5968), 1042");
});

Deno.test("seed: a custom line (no twin) has no product description to carry", () => {
  const stand = record("oosStand", "legacy", VEST_LINE, 1, { query_by_sources: [`orders:${ORDER}`] });
  assertEquals(seedReplacementLines(order, [stand], [], products, noUnits)[0].description, "Lost");
  const counted = record("oosStand", "legacy", VEST_LINE, 1, {
    query_by_sources: [`orders:${ORDER}`],
    units: { away: [7], flagged: [], returned_to_service: [], returned_to_supplier: [], written_off: [] },
  });
  assertEquals(seedReplacementLines(order, [counted], [], products, noUnits)[0].description, "Unit 7");
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

Deno.test("OOS_BILLING_POLICY: lost/damaged bill as replacement by default, cleaning/maintenance as service on request", () => {
  assertEquals(OOS_BILLING_POLICY, {
    lost: { line_type: "replacement", offer: "default" },
    damaged: { line_type: "replacement", offer: "default" },
    cleaning: { line_type: "service", offer: "on_request" },
    maintenance: { line_type: "service", offer: "on_request" },
  });
  assertEquals(oosLineTypeFor("damaged"), "replacement");
  assertEquals(oosLineTypeFor("cleaning"), "service");
});

Deno.test("the default-offered set is exactly the policy's `default` reasons", () => {
  // BILLABLE_OOS_REASONS drives the offer and the diff's "not invoiced" flag, so
  // it must not drift from the policy it is a view of.
  const defaults = Object.entries(OOS_BILLING_POLICY).filter(([, p]) => p.offer === "default").map(([r]) => r).sort();
  assertEquals([...BILLABLE_OOS_REASONS].sort(), defaults);
});

Deno.test("isOnRequestBillableOutOfService: cleaning/maintenance only, never canceled, never the default set", () => {
  assertEquals(isOnRequestBillableOutOfService({ reason: "cleaning", status: "active" }), true);
  assertEquals(isOnRequestBillableOutOfService({ reason: "maintenance", status: "active" }), true);
  assertEquals(isOnRequestBillableOutOfService({ reason: "cleaning", status: "canceled" }), false);
  assertEquals(isOnRequestBillableOutOfService({ reason: "lost", status: "active" }), false);
  assertEquals(isOnRequestBillableOutOfService({ reason: "nonsense", status: "active" }), false);
  // The two predicates partition the reasons: no record is in both.
  for (const reason of Object.keys(OOS_BILLING_POLICY)) {
    const r = { reason, status: "active" };
    assertEquals(isBillableOutOfService(r) && isOnRequestBillableOutOfService(r), false, reason);
  }
});

Deno.test("a service line billing a cleaning record is counted by billedOutOfService", () => {
  const billed = billedOutOfService([
    { uid: "inv1", status: "issued", items: [{ type: "service", quantity: 2, uid_out_of_service: "oos-clean" }] },
    { uid: "inv2", status: "void", items: [{ type: "service", quantity: 5, uid_out_of_service: "oos-clean" }] },
  ]);
  assertEquals(billed.get("oos-clean"), 2);
});

// ── seedOnRequestLines (api-cloudrun#1163) ───────────────────────────

const CLEANING = "cleaning-product";
const MAINTENANCE = "maintenance-product";
const chargeProducts = new Map<string, ReplacementSourceProduct>([
  ...products,
  [CLEANING, { uid: CLEANING, name: "Cleaning" }],
  [MAINTENANCE, { uid: MAINTENANCE, name: "Maintenance" }],
]);
const both = { cleaning: CLEANING, maintenance: MAINTENANCE };
const cleaned = record("oosClean", "vest", VEST_LINE, 3, { reason: "cleaning" });
const serviced = record("oosMaint", "cone", CONE_LINE, 1, { reason: "maintenance" });

function serviceInvoice(uid: string, status: string, lines: Array<[string, number]>): ReplacementBillingInvoice {
  return { uid, status, items: lines.map(([u, q]) => ({ type: "service", quantity: q, uid_out_of_service: u })) };
}

Deno.test("on-request seed: one $0 service line per cleaning/maintenance record, under its leg", () => {
  const seeds = seedOnRequestLines(order, [cleaned, serviced], [], both, chargeProducts);
  assertEquals(
    seeds.map((s) => [s.uid_out_of_service, s.uid_product, s.name, s.rental_name, s.quantity, s.base_cents, s.uid_pair]),
    [
      ["oosClean", CLEANING, "Cleaning", "Safety Vest", 3, 0, PAIR],
      ["oosMaint", MAINTENANCE, "Maintenance", "Traffic Cone", 1, 0, PAIR],
    ],
  );
});

Deno.test("on-request seed: an unset or unknown product hides that reason, and only that reason", () => {
  assertEquals(
    seedOnRequestLines(order, [cleaned, serviced], [], { cleaning: null, maintenance: MAINTENANCE }, chargeProducts)
      .map((s) => s.uid_out_of_service),
    ["oosMaint"],
  );
  // A uid that resolves to no product is the same as unset — never an invoice failure.
  assertEquals(
    seedOnRequestLines(order, [cleaned, serviced], [], { cleaning: "deleted-product", maintenance: null }, chargeProducts),
    [],
  );
  assertEquals(seedOnRequestLines(order, [cleaned, serviced], [], { cleaning: null, maintenance: null }, chargeProducts), []);
});

Deno.test("on-request seed: never offers lost/damaged, canceled or other orders' records", () => {
  const lost = record("a", "vest", VEST_LINE, 1);
  const damaged = record("b", "vest", VEST_LINE, 1, { reason: "damaged" });
  const canceled = record("c", "vest", VEST_LINE, 1, { reason: "cleaning", status: "canceled" });
  const elsewhere = record("d", "vest", VEST_LINE, 1, { reason: "cleaning", query_by_sources: ["orders:Order000000000000009"] });
  assertEquals(seedOnRequestLines(order, [lost, damaged, canceled, elsewhere], [], both, chargeProducts), []);
  // ...and the default seed never offers the on-request ones: the two partition the reasons.
  assertEquals(seedReplacementLines(order, [cleaned, serviced], [], products, noUnits), []);
});

Deno.test("on-request seed: billed units are subtracted across service lines, and a void bills nothing", () => {
  const partly = serviceInvoice("inv1", "issued", [["oosClean", 2]]);
  const voided = serviceInvoice("inv2", "void", [["oosClean", 1], ["oosMaint", 1]]);
  assertEquals(
    seedOnRequestLines(order, [cleaned, serviced], [partly, voided], both, chargeProducts).map((s) => [s.uid_out_of_service, s.quantity]),
    [["oosClean", 1], ["oosMaint", 1]],
  );
  const fully = serviceInvoice("inv3", "draft", [["oosClean", 1], ["oosMaint", 1]]);
  assertEquals(seedOnRequestLines(order, [cleaned, serviced], [partly, voided, fully], both, chargeProducts), []);
});

Deno.test("on-request seed: a record with no booking sits at the order level, and the product name falls back to the uid", () => {
  const attached = record("oosAttached", "ghost", VEST_LINE, 1, { reason: "cleaning", query_by_sources: [`orders:${ORDER}`] });
  const [seed] = seedOnRequestLines(order, [attached], [], both, chargeProducts);
  assertEquals(seed.uid_pair, null);
  assertEquals(seed.rental_name, "ghost");
});

// ── W4R: a line bills a LIST of records (owner ruling 16, 2026-11-10) ──

Deno.test("W4R outOfServiceEntries: the pre-W4R single link and its migrated list read identically", () => {
  const before = { quantity: 3, uid_out_of_service: "oosVest" };
  const after = { quantity: 3, out_of_service: [{ uid: "oosVest", quantity: 3 }] };
  assertEquals(outOfServiceEntries(before), outOfServiceEntries(after));
  assertEquals(outOfServiceEntries({ quantity: 3 }), []);
  assertEquals(outOfServiceEntries({ quantity: 3, uid_out_of_service: null }), []);
  assertEquals([billsOutOfService(before), billsOutOfService(after), billsOutOfService({ quantity: 1 })], [true, true, false]);
  // And through the billed sum, which is what the offer and the advisory read.
  const inv = (items: Record<string, unknown>[]) => [{ uid: "inv1", status: "issued", items: items.map((i) => ({ type: "replacement", ...i })) }];
  assertEquals(billedOutOfService(inv([before])), billedOutOfService(inv([after])));
});

Deno.test("W4R: a line merging two records bills EACH its own share — no re-offer, no over-bill", () => {
  const vests = { uid: "oosVest", quantity: 2 };
  const cones = { uid: "oosCone", quantity: 1 };
  const merged = { type: "replacement", quantity: 3, out_of_service: [{ uid: "oosVest", quantity: 2 }, { uid: "oosCone", quantity: 1 }] };
  const billed = billedOutOfService([{ uid: "inv1", status: "issued", items: [merged] }]);
  assertEquals([billed.get("oosVest"), billed.get("oosCone")], [2, 1]);
  // Read by the pre-W4R rule (the line's whole quantity per record named) it would be 3 and 3.
  assertEquals(overbilledOutOfService([merged], [vests, cones], [], "inv1"), []);
  // A void invoice bills nothing, list or not.
  assertEquals(billedOutOfService([{ uid: "inv1", status: "void", items: [merged] }]).size, 0);
  // One unit past the vest record is reported for the vest alone.
  const past = { ...merged, quantity: 4, out_of_service: [{ uid: "oosVest", quantity: 3 }, { uid: "oosCone", quantity: 1 }] };
  assertEquals(overbilledOutOfService([past], [vests, cones], [], "inv1"), [
    { uid_out_of_service: "oosVest", quantity: 2, billed_elsewhere: 0, billing_here: 3 },
  ]);
});

Deno.test("W4R mergeOutOfServiceEntries: accumulates by record, first appearance first", () => {
  assertEquals(
    mergeOutOfServiceEntries([{ uid: "a", quantity: 1 }, { uid: "b", quantity: 2 }], [{ uid: "c", quantity: 1 }, { uid: "a", quantity: 3 }]),
    [{ uid: "a", quantity: 4 }, { uid: "b", quantity: 2 }, { uid: "c", quantity: 1 }],
  );
});

Deno.test("W4R fitOutOfServiceEntries: re-shares a quantity first-come, pads the LAST entry, never drops one", () => {
  const two = [{ uid: "a", quantity: 2 }, { uid: "b", quantity: 2 }];
  assertEquals(fitOutOfServiceEntries(two, 4), two, "unchanged quantity: equal entries");
  assertEquals(fitOutOfServiceEntries(two, 3), [{ uid: "a", quantity: 2 }, { uid: "b", quantity: 1 }]);
  assertEquals(fitOutOfServiceEntries(two, 1), [{ uid: "a", quantity: 1 }, { uid: "b", quantity: 0 }]);
  assertEquals(fitOutOfServiceEntries(two, 0), [{ uid: "a", quantity: 0 }, { uid: "b", quantity: 0 }], "a close to 0 keeps naming both");
  assertEquals(fitOutOfServiceEntries(two, 6), [{ uid: "a", quantity: 2 }, { uid: "b", quantity: 4 }], "excess lands on the last");
  for (const q of [0, 1, 3, 4, 9]) {
    assertEquals(fitOutOfServiceEntries(two, q).reduce((s, e) => s + e.quantity, 0), q);
  }
  assertThrows(() => fitOutOfServiceEntries([], 1));
});

Deno.test("W4R splitOutOfServiceEntries: both sides sum to their units, and each names at least one record", () => {
  const two = [{ uid: "a", quantity: 2 }, { uid: "b", quantity: 2 }];
  assertEquals(splitOutOfServiceEntries(two, 1), { moved: [{ uid: "a", quantity: 1 }], kept: [{ uid: "a", quantity: 1 }, { uid: "b", quantity: 2 }] });
  assertEquals(splitOutOfServiceEntries(two, 2), { moved: [{ uid: "a", quantity: 2 }], kept: [{ uid: "b", quantity: 2 }] });
  assertEquals(splitOutOfServiceEntries(two, 3), { moved: [{ uid: "a", quantity: 2 }, { uid: "b", quantity: 1 }], kept: [{ uid: "b", quantity: 1 }] });
  // One record split in two: both sides name it.
  assertEquals(splitOutOfServiceEntries([{ uid: "a", quantity: 5 }], 2), { moved: [{ uid: "a", quantity: 2 }], kept: [{ uid: "a", quantity: 3 }] });
  assertThrows(() => splitOutOfServiceEntries(two, 0));
  assertThrows(() => splitOutOfServiceEntries(two, 4));
});
