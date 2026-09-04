/**
 * The pick sheet's schema and the one rule that lives with it.
 *
 * The gate is the interesting half. `customer_collecting` and
 * `customer_returning` are independent flags on the destination pair, and the
 * defect this predicate replaces was an `||` over the two — so the table below
 * enumerates all four combinations against all three gates rather than probing
 * the cases that happen to occur in the corpus.
 */
import { assert, assertEquals } from "@std/assert";
import {
  PICK_SHEET_GATES,
  PICK_SHEET_LEGS,
  type PickSheet,
  type PickSheetGatePair,
  type PickSheetGateType,
  pickSheetGateAdmits,
  type PickSheetLegCustody,
  pickSheetLegAdmits,
  pickSheetLegDirection,
  type PickSheetLegType,
  PickSheetSchema,
} from "../src/schemas/pick-sheet.ts";

/** A leg's custody, spelled as the seven buckets so a zero is stated. */
function custody(
  type: "rental" | "sale",
  over: Partial<Record<"damaged" | "lost" | "out" | "prepped" | "quoted" | "reserved" | "returned", number>>,
): PickSheetLegCustody {
  return {
    type,
    breakdown: {
      damaged: 0, lost: 0, out: 0, prepped: 0, quoted: 0, reserved: 0, returned: 0,
      ...over,
    },
  };
}

function pair(collecting: boolean, returning: boolean): PickSheetGatePair {
  return { customer_collecting: collecting, customer_returning: returning };
}

// ── The gate ────────────────────────────────────────────────────────

Deno.test("gate: `all` admits every combination of the two flags", () => {
  for (const c of [false, true]) {
    for (const r of [false, true]) {
      assert(pickSheetGateAdmits(pair(c, r), "all"), `all rejected (${c}, ${r})`);
    }
  }
});

Deno.test("gate: `crew` reads the DELIVERY flag alone", () => {
  // We deliver — crew work at the address — regardless of who returns it.
  assert(pickSheetGateAdmits(pair(false, false), "crew"));
  assert(pickSheetGateAdmits(pair(false, true), "crew"));
  // The customer collects: there is no crew job at this leg's delivery endpoint,
  // which by then is our own store.
  assertEquals(pickSheetGateAdmits(pair(true, false), "crew"), false);
  assertEquals(pickSheetGateAdmits(pair(true, true), "crew"), false);
});

Deno.test("gate: `counter` admits a leg with counter work in EITHER direction", () => {
  assertEquals(pickSheetGateAdmits(pair(false, false), "counter"), false);
  assert(pickSheetGateAdmits(pair(false, true), "counter"));
  assert(pickSheetGateAdmits(pair(true, false), "counter"));
  assert(pickSheetGateAdmits(pair(true, true), "counter"));
});

/**
 * 🔴 The regression this predicate exists to stop, named so it cannot be
 * "simplified" back.
 *
 * A leg we DELIVER and the customer RETURNS has a real delivery endpoint — a
 * film set — and belongs on the crew sheet. Under `customer_collecting ||
 * customer_returning` as a single "customer handles it" boolean, it was
 * suppressed, and a crew standing at that address was told nothing was out
 * there.
 */
Deno.test("gate: a delivered-and-customer-returned leg is CREW work, not suppressed", () => {
  const delivered = pair(false, true);
  assert(pickSheetGateAdmits(delivered, "crew"), "the || defect, reintroduced");
  assert(pickSheetGateAdmits(delivered, "counter"), "and it has counter work too");
});

/**
 * ⭐ The two working gates OVERLAP by design. A partition would have to pick one
 * side of a leg we deliver and the customer returns, and be wrong for the other.
 */
Deno.test("gate: `crew` and `counter` overlap rather than partition", () => {
  const combos = [pair(false, false), pair(false, true), pair(true, false), pair(true, true)];
  const both = combos.filter((p) => pickSheetGateAdmits(p, "crew") && pickSheetGateAdmits(p, "counter"));
  const neither = combos.filter((p) => !pickSheetGateAdmits(p, "crew") && !pickSheetGateAdmits(p, "counter"));
  assertEquals(both.length, 1, "exactly the delivered/customer-returned leg is on both sheets");
  assertEquals(both[0], pair(false, true));
  assertEquals(neither.length, 0, "no leg falls off both sheets");
});

Deno.test("gate: the vocabulary is closed and every member is decidable", () => {
  assertEquals([...PICK_SHEET_GATES], ["all", "crew", "counter"]);
  for (const gate of PICK_SHEET_GATES) {
    assertEquals(typeof pickSheetGateAdmits(pair(false, false), gate), "boolean");
  }
  // The enum and the predicate's parameter type cannot drift: this only
  // compiles while every member is accepted.
  const _exhaustive: PickSheetGateType[] = [...PICK_SHEET_GATES];
  assertEquals(_exhaustive.length, 3);
});

// ── The document ────────────────────────────────────────────────────

/** The smallest sheet that is a valid answer: a scope, a gate, and nothing out. */
function emptySheet(): unknown {
  return {
    scope: { kind: "destination", uid: "aaaaaaaaaaaaaaaaaaaa", name: "Stage 4", uids: ["aaaaaaaaaaaaaaaaaaaa"] },
    gate: "crew",
    leg: null,
    orders: [],
    order_count: 0,
    destination_count: 0,
    quantity: 0,
    organizations: [],
    missing_order_uids: [],
    next_cursor: null,
    notice: null,
  };
}

Deno.test("leg: nothing open reads as a DELIVERY, not an empty answer", () => {
  // The sheet only carries legs with open bookings, but the predicate must be
  // total — and "not yet in flight" is the delivery side by construction.
  assertEquals(pickSheetLegDirection([]), "delivery");
});

Deno.test("leg: a rental holding `out` with nothing earlier is a COLLECTION", () => {
  assertEquals(pickSheetLegDirection([custody("rental", { out: 3 })]), "collection");
});

Deno.test("leg: anything `reserved` or `prepped` pulls it back to DELIVERY", () => {
  // "In flight" is the whole leg's state, not any one line's: a part-shipped leg
  // still has outbound work, so the earlier stage wins.
  assertEquals(
    pickSheetLegDirection([custody("rental", { out: 3 }), custody("rental", { reserved: 1 })]),
    "delivery",
  );
  assertEquals(
    pickSheetLegDirection([custody("rental", { out: 3 }), custody("rental", { prepped: 1 })]),
    "delivery",
  );
});

Deno.test("leg: a NON-rental `out` is terminal — checkout IS delivery for a sale", () => {
  // 🔴 The subtle one. A sold unit never comes back, so a sale sitting `out`
  // must not pull the leg onto a collection that will never happen. This is the
  // case a naive `breakdown.out > 0` gets wrong.
  assertEquals(pickSheetLegDirection([custody("sale", { out: 5 })]), "delivery");
  // …and it must not mask a real collection alongside it.
  assertEquals(
    pickSheetLegDirection([custody("sale", { out: 5 }), custody("rental", { out: 2 })]),
    "collection",
  );
});

Deno.test("leg: `quoted` and the terminal buckets do not make a leg in-flight", () => {
  for (const bucket of ["quoted", "returned", "damaged", "lost"] as const) {
    assertEquals(
      pickSheetLegDirection([custody("rental", { [bucket]: 4 })]),
      "delivery",
      `${bucket} must not read as in flight`,
    );
  }
});

Deno.test("leg: a null filter admits both directions", () => {
  const outbound = [custody("rental", { reserved: 2 })];
  const inbound = [custody("rental", { out: 2 })];
  assert(pickSheetLegAdmits(outbound, null));
  assert(pickSheetLegAdmits(inbound, null));
  assert(pickSheetLegAdmits(outbound, "delivery"));
  assert(!pickSheetLegAdmits(outbound, "collection"));
  assert(pickSheetLegAdmits(inbound, "collection"));
  assert(!pickSheetLegAdmits(inbound, "delivery"));
});

Deno.test("leg: the vocabulary is closed, two-valued, and every member is decidable", () => {
  // ⚠️ Exactly two — no `all`. A direction is COMPUTED, so a third member would
  // be one `pickSheetLegDirection` can never return; "both" is `null`, the
  // absence of a filter. This is the deliberate asymmetry with PICK_SHEET_GATES.
  assertEquals([...PICK_SHEET_LEGS], ["delivery", "collection"]);
  const produced = new Set<PickSheetLegType>([
    pickSheetLegDirection([custody("rental", { reserved: 1 })]),
    pickSheetLegDirection([custody("rental", { out: 1 })]),
  ]);
  assertEquals(produced.size, PICK_SHEET_LEGS.length, "every member must be reachable");
});

Deno.test("schema: `leg` is a required key, so `null` is a STATED both-directions", () => {
  const withoutLeg = emptySheet() as Record<string, unknown>;
  delete withoutLeg.leg;
  assertEquals(
    PickSheetSchema.safeParse(withoutLeg).success,
    false,
    "an absent leg must not silently mean both",
  );
});

Deno.test("schema: an empty sheet is a valid answer, not an error", () => {
  const parsed = PickSheetSchema.parse(emptySheet()) as PickSheet;
  assertEquals(parsed.orders, []);
  assertEquals(parsed.next_cursor, null);
});

Deno.test("schema: `next_cursor` and `notice` are required keys, so absence is stated", () => {
  const withoutCursor = emptySheet() as Record<string, unknown>;
  delete withoutCursor.next_cursor;
  assertEquals(PickSheetSchema.safeParse(withoutCursor).success, false);
});

Deno.test("schema: `missing_order_uids` survives a round trip — it is a finding, not a display detail", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.missing_order_uids = ["bbbbbbbbbbbbbbbbbbbb"];
  const parsed = PickSheetSchema.parse(sheet) as PickSheet;
  assertEquals(parsed.missing_order_uids, ["bbbbbbbbbbbbbbbbbbbb"]);
});

Deno.test("schema: an unknown top-level key is refused", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.sections = [];
  assertEquals(PickSheetSchema.safeParse(sheet).success, false);
});

/**
 * 🔴 The cursor is the whole SORT KEY, not the last order's uid.
 *
 * A bare uid could only be resumed from by finding that order again, and the
 * order it names may legitimately have left the sheet by the next call — checked
 * in, or completed. Typing this field as a document id is the tightening that
 * would force that back, so it is asserted directly.
 */
Deno.test("schema: `next_cursor` is an opaque key, not a document id", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.next_cursor = "2026-09-29T09:00:00.000-05:00|cccccccccccccccccccc";
  const parsed = PickSheetSchema.parse(sheet) as PickSheet;
  assertEquals(parsed.next_cursor, "2026-09-29T09:00:00.000-05:00|cccccccccccccccccccc");
});

/**
 * The four counts describe the SCOPE, not the page — so a one-order page of a
 * twelve-order sheet says twelve, and `orders.length` says one. Asserted because
 * the natural mistake is to make them agree.
 */
Deno.test("schema: the counts are scope totals and outlive the page they arrive on", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.order_count = 12;
  sheet.destination_count = 14;
  sheet.quantity = 312;
  sheet.next_cursor = "|dddddddddddddddddddd";
  const parsed = PickSheetSchema.parse(sheet) as PickSheet;
  assertEquals(parsed.orders.length, 0);
  assertEquals(parsed.order_count, 12);
  assert(parsed.next_cursor !== null, "more pages remain, so the totals exceed this page");
});

Deno.test("schema: the gate is the closed vocabulary, not a free string", () => {
  const sheet = emptySheet() as Record<string, unknown>;
  sheet.gate = "outbound";
  assertEquals(PickSheetSchema.safeParse(sheet).success, false);
});
