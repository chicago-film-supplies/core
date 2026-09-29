import { assertEquals } from "@std/assert";
import {
  CreateOrderInput,
  destinationJoinViolations,
  FulfillmentLineItem,
  FulfillmentSchema,
  InvoiceDocDestination,
  InvoiceDocLineItem,
  InvoiceSchema,
  leadingDividerViolations,
  mixedBookingGrains,
  OrderDocLineItem,
  OrderItemLine,
  OrderSchema,
  UpdateOrderInput,
  zeroQuantityComponents,
} from "../src/schemas/mod.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { normalizeCollectionLegs } from "../src/utils/orders.ts";
import { deriveProjectionCollection, type ProjectionCollectionPair } from "../src/utils/shared-fields.ts";
import { bookingCollectionFor } from "../src/utils/bookings.ts";
import { applyDateEdit, type ChargeDates, toChicagoYmd } from "../src/utils/dates.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/**
 * The two S8 refinements of the order-edit-custody campaign (core#119):
 *
 * 1. **divider ↔ pair** on the order and the fulfillment — never the invoice;
 * 2. **a component line never has `quantity: 0`** on the order, stored and input.
 *
 * Every arm asserts a REFUSAL at a named `path`, and its matching ACCEPTANCE, so a
 * document failing for some unrelated reason cannot satisfy it.
 */

const DIV_A = "11111111-1111-4111-8111-111111111111";
const DIV_B = "22222222-2222-4222-8222-222222222222";
const PARENT = "33333333-3333-4333-8333-333333333333";
const CHILD = "44444444-4444-4444-8444-444444444444";
const NOW = { now: mockTimestamp };
const stamps = { created_at: mockTimestamp, updated_at: mockTimestamp };

const divider = (uid: string) => ({ uid, type: "destination" as const, name: "Site", description: "", path: [uid] });

/** A parsed fixture with its pairs renamed to `uids`, one pair per uid. */
function withPairs<D extends { destinations: { uid: string }[] }>(doc: D, uids: string[]): D {
  const proto = doc.destinations[0];
  return { ...doc, destinations: uids.map((uid) => ({ ...proto, uid })) };
}

const order = () => getTestDoc(OrderSchema, { uid: "testorder00000000001", ...stamps }, NOW);
const fulfillment = () => getTestDoc(FulfillmentSchema, { uid: "testfulfillment00001", ...stamps }, NOW);
const invoice = () => getTestDoc(InvoiceSchema, { uid: "testinvoice000000001", ...stamps }, NOW);
/** `getTestDoc` gives an invoice NO pairs (the array may be empty), so the invoice arms build real ones. */
const invoicePairs = (uids: string[]) => uids.map((uid) => getTestDoc(InvoiceDocDestination, { uid }, NOW));

/** Did the parse fail with an issue at `path`? */
function refusedAt(
  result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } },
  path: PropertyKey[],
): boolean {
  if (result.success) return false;
  return (result.error?.issues ?? []).some((i) =>
    i.path.length === path.length && i.path.every((seg, k) => seg === path[k])
  );
}

Deno.test("destinationJoinViolations: the biconditional, with no exemption", async (t) => {
  await t.step("joined 2:2 is clean", () => {
    assertEquals(
      destinationJoinViolations([divider(DIV_A), divider(DIV_B)], [{ uid: DIV_A }, { uid: DIV_B }]),
      [],
    );
  });

  await t.step("a divider no pair answers is reported by its uid", () => {
    assertEquals(
      destinationJoinViolations([divider(DIV_A), divider(DIV_B)], [{ uid: DIV_A }]),
      [{ kind: "divider_without_pair", uid: DIV_B }],
    );
  });

  await t.step("a pair naming no divider is reported at its index", () => {
    assertEquals(
      destinationJoinViolations([divider(DIV_A)], [{ uid: DIV_A }, { uid: DIV_B }]),
      [{ kind: "pair_without_divider", uid: DIV_B, index: 1 }],
    );
  });

  await t.step("no dividers and ONE pair is a violation — the single-entry deduction is gone", () => {
    // api-cloudrun#1154: this shape used to be exempt. It is reported now, and
    // `items.min(1)` + the leading divider make it unrepresentable on a stored
    // order or fulfillment anyway.
    assertEquals(destinationJoinViolations([], [{ uid: DIV_A }]), [
      { kind: "pair_without_divider", uid: DIV_A, index: 0 },
    ]);
  });

  await t.step("…as are no dividers beside TWO pairs, and one divider beside an unrelated pair", () => {
    assertEquals(destinationJoinViolations([], [{ uid: DIV_A }, { uid: DIV_B }]).length, 2);
    assertEquals(destinationJoinViolations([divider(DIV_A)], [{ uid: DIV_B }]).length, 2);
  });

  await t.step("a row with a non-string uid is left to the schema parse", () => {
    // The malformed divider is not reported (the parse owns it); the pair it
    // cannot answer still is — there is no longer a divider-less exemption to
    // hide it behind.
    assertEquals(destinationJoinViolations([{ type: "destination", uid: 7 }], [{ uid: DIV_A }]), [
      { kind: "pair_without_divider", uid: DIV_A, index: 0 },
    ]);
  });
});

Deno.test("checkDestinationJoin: wired on the order and the fulfillment, NOT the invoice", async (t) => {
  for (
    const [name, schema, make] of [
      ["order", OrderSchema, order],
      ["fulfillment", FulfillmentSchema, fulfillment],
    ] as const
  ) {
    await t.step(`${name}: the joined document is accepted (control)`, () => {
      const doc = { ...withPairs(make(), [DIV_A]), items: [divider(DIV_A)] };
      assertEquals(schema.safeParse(doc).success, true);
    });

    await t.step(`${name}: a divider with no pair is refused, at items`, () => {
      const doc = { ...withPairs(make(), [DIV_A]), items: [divider(DIV_A), divider(DIV_B)] };
      assertEquals(refusedAt(schema.safeParse(doc), ["items"]), true);
    });

    await t.step(`${name}: a pair with no divider is refused, at that pair's uid`, () => {
      const doc = { ...withPairs(make(), [DIV_A, DIV_B]), items: [divider(DIV_A)] };
      assertEquals(refusedAt(schema.safeParse(doc), ["destinations", 1, "uid"]), true);
    });

    await t.step(`${name}: no dividers and one pair is REFUSED — empty items and the unjoined pair`, () => {
      const doc = { ...withPairs(make(), [DIV_A]), items: [] };
      const result = schema.safeParse(doc);
      assertEquals(refusedAt(result, ["items"]), true, "items.min(1)");
      assertEquals(refusedAt(result, ["destinations", 0, "uid"]), true, "the pair names no divider");
    });
  }

  await t.step("invoice: the SAME divider-less mismatch is NOT refused by the schema", () => {
    // Invoices are excluded on purpose — scoped to what they bill. The API's
    // write guard applies the shared function to them at write time instead.
    const doc = { ...invoice(), destinations: invoicePairs([DIV_A, DIV_B]), items: [divider(DIV_A)] };
    const result = InvoiceSchema.safeParse(doc);
    assertEquals(result.success, true, JSON.stringify(result.error?.issues));
  });
});

/** A stored order line at `path` with an explicit quantity (`getTestDoc` mints 0). */
const line = (uid: string, path: string[], quantity: number, zero_priced: boolean | null = null) =>
  getTestDoc(OrderDocLineItem, { uid, type: "sale", path, quantity, zero_priced });

Deno.test("zeroQuantityComponents: only a COMPONENT at quantity 0", async (t) => {
  const parent = line(PARENT, [DIV_A, PARENT], 1);

  await t.step("a component at 0 is reported at its index", () => {
    const found = zeroQuantityComponents([divider(DIV_A), parent, line(CHILD, [DIV_A, PARENT, CHILD], 0)]);
    assertEquals(found.map((f) => [f.index, f.uid, f.parentType]), [[2, CHILD, "sale"]]);
  });

  await t.step("the same component at 1 is not (control)", () => {
    assertEquals(zeroQuantityComponents([divider(DIV_A), parent, line(CHILD, [DIV_A, PARENT, CHILD], 1)]), []);
  });

  await t.step("a TOP-LEVEL line at 0 is not a component and is not reported", () => {
    assertEquals(zeroQuantityComponents([divider(DIV_A), line(PARENT, [DIV_A, PARENT], 0)]), []);
  });

  await t.step("a line whose parent resolves to nothing is left to the parentage check", () => {
    assertEquals(zeroQuantityComponents([line(CHILD, [DIV_A, PARENT, CHILD], 0)]), []);
  });
});

Deno.test("checkZeroQuantityComponents: the stored order and BOTH inputs refuse it; fulfillment and invoice do not", async (t) => {
  const items = (childQty: number) => [
    divider(DIV_A),
    line(PARENT, [DIV_A, PARENT], 1),
    line(CHILD, [DIV_A, PARENT, CHILD], childQty, false), // a component must STATE the flag (core#100)
  ];

  await t.step("stored order: refused at the component's quantity, accepted at 1 (control)", () => {
    const base = withPairs(order(), [DIV_A]);
    assertEquals(OrderSchema.safeParse({ ...base, items: items(1) }).success, true);
    assertEquals(refusedAt(OrderSchema.safeParse({ ...base, items: items(0) }), ["items", 2, "quantity"]), true);
  });

  // Input lines: the stored line minus its computed keys is not needed — the
  // input line arm is non-strict, so a stored line parses through it.
  const inputItems = (childQty: number) => items(childQty).map((i) => i.type === "destination" ? i : OrderItemLine.parse(i));

  await t.step("CreateOrderInput and UpdateOrderInput: refused at 0, accepted at 1", () => {
    const create = (childQty: number) =>
      CreateOrderInput.safeParse({
        uid: "testorder00000000001",
        organization: { uid: "testorg0000000000001" },
        status: "draft",
        destinations: [{ ...getTestDoc(OrderSchema, { uid: "x0000000000000000001", ...stamps }, NOW).destinations[0], uid: DIV_A }],
        items: inputItems(childQty),
      });
    assertEquals(create(1).success, true, JSON.stringify(create(1).error?.issues));
    assertEquals(refusedAt(create(0), ["items", 2, "quantity"]), true);

    const update = (childQty: number) => UpdateOrderInput.safeParse({ version: 0, items: inputItems(childQty) });
    assertEquals(update(1).success, true);
    assertEquals(refusedAt(update(0), ["items", 2, "quantity"]), true);
  });

  await t.step("the fulfillment and the invoice keep their zero-quantity components (kept ancestors)", () => {
    // A kept kit ancestor sits at quantity 0 and can itself be a component, so
    // the fulfillment must not carry the refinement — pinned so it is not added.
    const rows = <T>(mk: (uid: string, path: string[], quantity: number, zero_priced: boolean | null) => T) => [
      divider(DIV_A),
      mk(PARENT, [DIV_A, PARENT], 1, null),
      mk(CHILD, [DIV_A, PARENT, CHILD], 0, false),
    ];
    const fulfillmentItems = rows((uid, path, quantity, zero_priced) =>
      getTestDoc(FulfillmentLineItem, { uid, type: "sale", path, quantity, zero_priced })
    );
    const invoiceItems = rows((uid, path, quantity, zero_priced) =>
      getTestDoc(InvoiceDocLineItem, { uid, type: "sale", path, quantity, zero_priced })
    );
    const f = FulfillmentSchema.safeParse({ ...withPairs(fulfillment(), [DIV_A]), items: fulfillmentItems });
    assertEquals(f.success, true, JSON.stringify(f.error?.issues));
    const i = InvoiceSchema.safeParse({ ...invoice(), destinations: invoicePairs([DIV_A]), items: invoiceItems });
    assertEquals(i.success, true, JSON.stringify(i.error?.issues));
  });
});

// ── api-cloudrun#1154: the leading divider, the null collection leg ─────────

const group = (uid: string) => ({ uid, type: "group" as const, name: "G", description: "", path: [DIV_A, uid] });
const GROUP = "55555555-5555-4555-8555-555555555555";
const ORDER_UID = "testorder00000000001";
const orderDivider = () => ({ uid: ORDER_UID, type: "order" as const, name: "Order #1", description: "", path: [ORDER_UID] });

Deno.test("leadingDividerViolations: the first row is the grain's top divider", async (t) => {
  await t.step("order and fulfillment lead with a destination", () => {
    for (const grain of ["order", "fulfillment"] as const) {
      assertEquals(leadingDividerViolations([divider(DIV_A)], grain, false), []);
      assertEquals(leadingDividerViolations([group(GROUP), divider(DIV_A)], grain, false), [
        { expected: "destination", found: "group" },
      ]);
      assertEquals(leadingDividerViolations([{ type: "rental" }], grain, false), [
        { expected: "destination", found: "rental" },
      ]);
    }
  });

  await t.step("an order-linked invoice leads with an order divider", () => {
    assertEquals(leadingDividerViolations([orderDivider(), divider(DIV_A)], "invoice", true), []);
    // An order-level line between the order divider and the first destination is legal.
    assertEquals(leadingDividerViolations([orderDivider(), { type: "transaction_fee" }, divider(DIV_A)], "invoice", true), []);
    assertEquals(leadingDividerViolations([divider(DIV_A)], "invoice", true), [{ expected: "order", found: "destination" }]);
    assertEquals(leadingDividerViolations([{ type: "sale" }], "invoice", true), [{ expected: "order", found: "sale" }]);
  });

  await t.step("an order-less invoice is unruled", () => {
    assertEquals(leadingDividerViolations([{ type: "sale" }], "invoice", false), []);
  });

  await t.step("empty items is min(1)'s error, not this function's", () => {
    for (const grain of ["order", "fulfillment", "invoice"] as const) {
      assertEquals(leadingDividerViolations([], grain, true), []);
    }
  });

  await t.step("a row with no string type reports found: null", () => {
    assertEquals(leadingDividerViolations([{ type: 7 }], "order", false), [{ expected: "destination", found: null }]);
  });
});

Deno.test("checkLeadingDivider: wired on the order, the fulfillment and the invoice", async (t) => {
  for (
    const [name, schema, make] of [
      ["order", OrderSchema, order],
      ["fulfillment", FulfillmentSchema, fulfillment],
    ] as const
  ) {
    await t.step(`${name}: a group first is refused at items.0.type; divider first is accepted (control)`, () => {
      const base = withPairs(make(), [DIV_A]);
      assertEquals(schema.safeParse({ ...base, items: [divider(DIV_A), group(GROUP)] }).success, true);
      const result = schema.safeParse({ ...base, items: [group(GROUP), divider(DIV_A)] });
      assertEquals(refusedAt(result, ["items", 0, "type"]), true, JSON.stringify(result.error?.issues));
    });
  }

  await t.step("invoice: order-linked with no order divider first is refused", () => {
    const base = { ...invoice(), destinations: invoicePairs([DIV_A]).map((p) => ({ ...p, uid_order: ORDER_UID })) };
    const linked = { ...base, query_by_orders: [ORDER_UID] };
    const good = InvoiceSchema.safeParse({ ...linked, items: [orderDivider(), { ...divider(DIV_A), path: [ORDER_UID, DIV_A] }] });
    assertEquals(good.success, true, JSON.stringify(good.error?.issues));
    const bad = InvoiceSchema.safeParse({ ...linked, items: [{ ...divider(DIV_A), path: [DIV_A] }] });
    assertEquals(refusedAt(bad, ["items", 0, "type"]), true, JSON.stringify(bad.error?.issues));
  });

  await t.step("invoice: an order-less invoice may lead with a bare line (control)", () => {
    const line = getTestDoc(InvoiceDocLineItem, { uid: CHILD, type: "sale", path: [CHILD], quantity: 1 });
    const result = InvoiceSchema.safeParse({ ...invoice(), query_by_orders: [], items: [line] });
    assertEquals(result.success, true, JSON.stringify(result.error?.issues));
  });
});

Deno.test("CreateOrderInput / UpdateOrderInput: an explicit empty items array is refused", () => {
  assertEquals(refusedAt(UpdateOrderInput.safeParse({ version: 0, items: [] }), ["items"]), true);
  // Absent is still legal — `createOrder` seeds the divider, `updateOrder` keeps the stored rows.
  assertEquals(UpdateOrderInput.safeParse({ version: 0 }).success, true);
});

/** Placed-leg dates for a pair, Monday delivery → Friday collection, one window. */
const MON = "2026-10-05T09:00:00.000-05:00";
const FRI = "2026-10-09T15:00:00.000-05:00";
const placedDates = () => ({
  delivery_start: MON,
  delivery_start_fs: mockTimestamp,
  delivery_end: MON,
  delivery_end_fs: mockTimestamp,
  collection_start: FRI,
  collection_start_fs: mockTimestamp,
  collection_end: FRI,
  collection_end_fs: mockTimestamp,
  days_active: 5,
  charge_windows: [{ start: MON, end: FRI, days: 5 }],
});
/** The same pair after it stops collecting: no leg dates, no windows. */
const droppedDates = () => ({
  ...placedDates(),
  collection_start: null,
  collection_start_fs: null,
  collection_end: null,
  collection_end_fs: null,
  days_active: null,
  charge_windows: null,
});
const rentalLine = (uid: string) => getTestDoc(OrderDocLineItem, { uid, type: "rental", path: [DIV_A, uid], quantity: 1 });
const saleLine = (uid: string) => getTestDoc(OrderDocLineItem, { uid, type: "sale", path: [DIV_A, uid], quantity: 1 });

/** An order with one pair at DIV_A, a placed leg on it, and `lines` under it. */
function orderWith(status: string, lines: unknown[], pairOverrides: Record<string, unknown> = {}) {
  const base = withPairs(order(), [DIV_A]);
  // A PLACED endpoint: past draft, `checkStoredEndpoints` needs a uid and an address.
  const leg = {
    uid: "destdelivery00000001",
    address: {
      city: "Chicago",
      country_name: "United States",
      full: "3100 W Fillmore St, Chicago, IL, 60612, United States",
      name: "",
      postcode: "60612",
      region: "IL",
      street: "3100 W Fillmore St",
      street2: "",
      address_coordinates: { latitude: 41.8708, longitude: -87.7036 },
    },
    instructions: null,
    contact: null,
  };
  return {
    ...base,
    status,
    items: [divider(DIV_A), ...lines],
    destinations: [{
      ...base.destinations[0],
      delivery: leg,
      collection: leg,
      customer_returning: false,
      dates: placedDates(),
      ...pairOverrides,
    }],
  };
}

Deno.test("checkCollectionLegs: the order's leg, flag, dates and windows agree", async (t) => {
  await t.step("controls: a placed rental order, and a dropped sales-only order, are accepted", () => {
    const placed = OrderSchema.safeParse(orderWith("reserved", [rentalLine(PARENT)]));
    assertEquals(placed.success, true, JSON.stringify(placed.error?.issues));
    const dropped = OrderSchema.safeParse(
      orderWith("reserved", [saleLine(PARENT)], { collection: null, customer_returning: null, dates: droppedDates() }),
    );
    assertEquals(dropped.success, true, JSON.stringify(dropped.error?.issues));
  });

  await t.step("a null leg with a flag is refused at the flag", () => {
    const r = OrderSchema.safeParse(
      orderWith("reserved", [saleLine(PARENT)], { collection: null, customer_returning: true, dates: droppedDates() }),
    );
    assertEquals(refusedAt(r, ["destinations", 0, "customer_returning"]), true);
  });

  await t.step("a placed leg with a null flag is refused at the flag", () => {
    const r = OrderSchema.safeParse(orderWith("reserved", [rentalLine(PARENT)], { customer_returning: null }));
    assertEquals(refusedAt(r, ["destinations", 0, "customer_returning"]), true);
  });

  await t.step("a null leg keeping a collection date is refused at that date", () => {
    for (const key of ["collection_start", "collection_end", "days_active"] as const) {
      const dates = { ...droppedDates(), [key]: key === "days_active" ? 5 : FRI };
      const r = OrderSchema.safeParse(
        orderWith("reserved", [saleLine(PARENT)], { collection: null, customer_returning: null, dates }),
      );
      assertEquals(refusedAt(r, ["destinations", 0, "dates", key]), true, key);
    }
  });

  await t.step("a rental with null windows is refused at the windows", () => {
    const r = OrderSchema.safeParse(
      orderWith("reserved", [rentalLine(PARENT)], { dates: { ...placedDates(), charge_windows: null } }),
    );
    assertEquals(refusedAt(r, ["destinations", 0, "charge_windows"]) || refusedAt(r, ["destinations", 0, "dates", "charge_windows"]), true);
  });

  await t.step("a sales-only order past draft holding a placed leg and windows is refused at both", () => {
    for (const status of ["quoted", "reserved", "active", "complete", "canceled"]) {
      const r = OrderSchema.safeParse(orderWith(status, [saleLine(PARENT)]));
      assertEquals(refusedAt(r, ["destinations", 0, "collection"]), true, status);
      assertEquals(refusedAt(r, ["destinations", 0, "dates", "charge_windows"]), true, status);
    }
  });

  await t.step("…and at the windows alone, when only they survived", () => {
    const r = OrderSchema.safeParse(
      orderWith("reserved", [saleLine(PARENT)], {
        collection: null,
        customer_returning: null,
        dates: { ...droppedDates(), charge_windows: placedDates().charge_windows },
      }),
    );
    assertEquals(refusedAt(r, ["destinations", 0, "collection"]), false);
    assertEquals(refusedAt(r, ["destinations", 0, "dates", "charge_windows"]), true);
  });

  await t.step("control: a DRAFT sales-only order keeps what the operator placed", () => {
    const r = OrderSchema.safeParse(orderWith("draft", [saleLine(PARENT)]));
    assertEquals(r.success, true, JSON.stringify(r.error?.issues));
  });

  await t.step("the fulfillment does not carry it — the sync derives it there", () => {
    const f = fulfillment();
    const r = FulfillmentSchema.safeParse({
      ...f,
      destinations: [{ ...f.destinations[0], collection: null, customer_returning: true }],
    });
    assertEquals(refusedAt(r, ["destinations", 0, "customer_returning"]), false);
  });
});

Deno.test("checkStoredEndpoints: a null collection leg is refused past draft only when a rental needs it", async (t) => {
  const nullLeg = { collection: null, customer_returning: null, dates: droppedDates() };
  await t.step("sales-only, reserved: accepted", () => {
    const r = OrderSchema.safeParse(orderWith("reserved", [saleLine(PARENT)], nullLeg));
    assertEquals(refusedAt(r, ["destinations", 0, "collection"]), false, JSON.stringify(r.error?.issues));
  });
  await t.step("a rental, reserved: refused at the collection leg", () => {
    const r = OrderSchema.safeParse(orderWith("reserved", [rentalLine(PARENT)], { ...nullLeg, dates: { ...droppedDates(), charge_windows: placedDates().charge_windows } }));
    assertEquals(refusedAt(r, ["destinations", 0, "collection"]), true);
  });
  await t.step("a rental, draft: accepted (a draft is still being built)", () => {
    const r = OrderSchema.safeParse(orderWith("draft", [rentalLine(PARENT)], { ...nullLeg, dates: { ...droppedDates(), charge_windows: placedDates().charge_windows } }));
    assertEquals(refusedAt(r, ["destinations", 0, "collection"]), false, JSON.stringify(r.error?.issues));
  });
});

Deno.test("mixedBookingGrains: one product in one leg is one booking, so it has one type", async (t) => {
  const G1 = "66666666-6666-4666-8666-666666666666";
  const G2 = "77777777-7777-4777-8777-777777777777";
  const PRODUCT = "prodaaaaaaaaaaaaaaaa";
  const inGroup = (group: string, type: "rental" | "sale") =>
    getTestDoc(OrderDocLineItem, { uid: PRODUCT, type, path: [DIV_A, group, PRODUCT], quantity: 1 });
  const groupRow = (uid: string) => ({ uid, type: "group" as const, name: "G", description: "", path: [DIV_A, uid] });

  await t.step("rental in one group and sale in another, same leg: reported, and the order refuses it", () => {
    const items = [divider(DIV_A), groupRow(G1), inGroup(G1, "rental"), groupRow(G2), inGroup(G2, "sale")];
    assertEquals(mixedBookingGrains(items).map((m) => [m.index, m.types]), [[4, ["rental", "sale"]]]);
    const r = OrderSchema.safeParse({ ...withPairs(order(), [DIV_A]), items });
    assertEquals(refusedAt(r, ["items", 4, "type"]), true);
  });

  await t.step("controls: same type in two groups, and different types in two LEGS, are not", () => {
    assertEquals(mixedBookingGrains([divider(DIV_A), groupRow(G1), inGroup(G1, "rental"), groupRow(G2), inGroup(G2, "rental")]), []);
    const otherLeg = getTestDoc(OrderDocLineItem, { uid: PRODUCT, type: "sale", path: [DIV_B, PRODUCT], quantity: 1 });
    assertEquals(mixedBookingGrains([divider(DIV_A), inGroup(G1, "rental"), divider(DIV_B), otherLeg]), []);
  });

  await t.step("control: a component of a kit is its own grain", () => {
    const KIT = "kitaaaaaaaaaaaaaaaaa";
    const component = getTestDoc(OrderDocLineItem, { uid: PRODUCT, type: "sale", path: [DIV_A, KIT, PRODUCT], quantity: 1 });
    assertEquals(mixedBookingGrains([divider(DIV_A), inGroup(G1, "rental"), component]), []);
  });
});

Deno.test("applyDateEdit seed_collection and copy_from — the dates half of the leg", async (t) => {
  await t.step("seed_collection: 5 business days on from delivery at 15:00, one window over possession", () => {
    const r = applyDateEdit(droppedDates() as ChargeDates, { type: "seed_collection" }, { holidays: [] });
    if (!("dates" in r)) throw new Error(r.error);
    assertEquals(toChicagoYmd(r.dates.collection_start!), "2026-10-09");
    assertEquals(r.dates.collection_start, FRI);
    assertEquals(r.dates.charge_windows?.map((w: { start: string; end: string; days: number }) => [w.start, w.end, w.days]), [[MON, FRI, 5]]);
  });
  await t.step("seed_collection counts holidays", () => {
    const r = applyDateEdit(droppedDates() as ChargeDates, { type: "seed_collection" }, { holidays: ["2026-10-07"] });
    if (!("dates" in r)) throw new Error(r.error);
    assertEquals(toChicagoYmd(r.dates.collection_start!), "2026-10-12");
  });
  await t.step("seed_collection with no delivery start is missing_dates", () => {
    const r = applyDateEdit({ ...droppedDates(), delivery_start: null } as ChargeDates, { type: "seed_collection" }, { holidays: [] });
    assertEquals(r, { error: "missing_dates" });
  });
  await t.step("copy_from a pair that bills no days hands over null, not the target's stale windows", () => {
    const r = applyDateEdit(placedDates() as ChargeDates, { type: "copy_from", dates: droppedDates() }, { holidays: [] });
    if (!("dates" in r)) throw new Error(r.error);
    assertEquals(r.dates.charge_windows, null);
    assertEquals(r.dates.collection_start, null);
  });
});

Deno.test("normalizeCollectionLegs: the one author of an order's collection legs", async (t) => {
  type Leg = { uid: string; address: null; instructions: string | null; contact: null };
  const leg: Leg = { uid: "destdelivery00000001", address: null, instructions: "gate code", contact: null };
  const other: Leg = { uid: "destcollection000001", address: null, instructions: null, contact: null };
  const pair = (
    collection: Leg | null,
    customer_collecting: boolean,
    customer_returning: boolean | null,
    dates: Record<string, unknown> = collection === null ? droppedDates() : placedDates(),
  ) => ({ delivery: leg, collection, customer_collecting, customer_returning, dates });
  const doc = (status: string, types: string[], pairs: ReturnType<typeof pair>[]) => ({
    status,
    items: types.map((type) => ({ type })),
    destinations: pairs,
  });

  await t.step("past draft, no rental: leg, flag, collection dates and windows are all nulled", () => {
    const out = normalizeCollectionLegs(doc("reserved", ["destination", "sale"], [pair(other, false, false), pair(other, true, true)]), []);
    assertEquals(out.destinations.map((p) => [p.collection, p.customer_returning]), [[null, null], [null, null]]);
    assertEquals(out.destinations[0].dates, droppedDates());
  });

  await t.step("…and it needs no holidays to do it", () => {
    const out = normalizeCollectionLegs(doc("reserved", ["destination", "sale"], [pair(other, false, false)]), null);
    assertEquals(out.destinations[0].collection, null);
  });

  await t.step("a rental on a null leg re-seeds the leg from delivery and the dates via seed_collection", () => {
    const out = normalizeCollectionLegs(doc("reserved", ["destination", "rental"], [pair(null, false, null), pair(null, true, null)]), []);
    // delivered → Same As Delivery, we collect; in-store pickup → in-store return.
    assertEquals(out.destinations.map((p) => [p.collection, p.customer_returning]), [[leg, false], [leg, true]]);
    // A copy, never the delivery object itself — an edit to one must not move the other.
    assertEquals(out.destinations[0].collection === leg, false);
    assertEquals(out.destinations[0].dates.collection_start, FRI);
    assertEquals(
      (out.destinations[0].dates.charge_windows as { start: string; end: string }[]).map((w) => [w.start, w.end]),
      [[MON, FRI]],
    );
  });

  await t.step("…but DEFERS while holidays have not loaded: the pair is left exactly as it is", () => {
    const input = doc("reserved", ["destination", "rental"], [pair(null, false, null)]);
    assertEquals(normalizeCollectionLegs(input, null) === input, true);
  });

  await t.step("half-states are repaired from the leg", () => {
    const out = normalizeCollectionLegs(doc("draft", ["destination"], [pair(other, true, null), pair(null, false, true)]), []);
    assertEquals(out.destinations.map((p) => [p.collection, p.customer_returning]), [[other, true], [null, null]]);
  });

  await t.step("a draft with no rental keeps its placed leg, dates and windows", () => {
    const input = doc("draft", ["destination", "sale"], [pair(other, false, false)]);
    assertEquals(normalizeCollectionLegs(input, []) === input, true);
  });

  await t.step("nothing to change returns the SAME object", () => {
    const placed = doc("reserved", ["destination", "rental"], [pair(other, false, false)]);
    assertEquals(normalizeCollectionLegs(placed, []) === placed, true);
    const dropped = doc("reserved", ["destination", "sale"], [pair(null, false, null)]);
    assertEquals(normalizeCollectionLegs(dropped, []) === dropped, true);
  });

  await t.step("its output satisfies the stored order schema, past draft, both ways", () => {
    for (const [line, expectLeg] of [[saleLine(PARENT), false], [rentalLine(PARENT), true]] as const) {
      const input = orderWith("reserved", [line], { collection: null, customer_returning: null, dates: droppedDates() });
      const out = normalizeCollectionLegs(input, []);
      assertEquals(out.destinations[0].collection !== null, expectLeg);
      const r = OrderSchema.safeParse(out);
      assertEquals(r.success, true, JSON.stringify(r.error?.issues));
    }
  });
});

Deno.test("deriveProjectionCollection: a projection keeps the leg its own items still need", async (t) => {
  // A concrete pair type, not the generic BOUND: the bound's `dates` is `object`
  // so a hand-written interface such as `OrderDocDatesType` satisfies it, which
  // means it names no date key for a test to read back.
  type Pair = ProjectionCollectionPair & { dates: Record<string, unknown> };
  const leg = { uid: "destcollection000001", address: null };
  const stored: Pair = { collection: leg, customer_collecting: false, customer_returning: false, dates: placedDates() };
  const nulled: Pair = { collection: null, customer_collecting: false, customer_returning: false, dates: droppedDates() };

  await t.step("KEEP: the order dropped its leg, but the projection still holds a rental", () => {
    const out = deriveProjectionCollection(nulled, stored, [{ type: "rental" }]);
    assertEquals(out.collection, leg);
    assertEquals(out.customer_returning, false);
    assertEquals(out.dates.collection_start, FRI);
    assertEquals(out.dates.charge_windows, placedDates().charge_windows);
  });

  await t.step("DERIVE: no rental left — the null leg takes a null flag and no collection dates", () => {
    const merged: Pair = { ...nulled, customer_returning: true, dates: { ...droppedDates(), collection_start: FRI } };
    const out = deriveProjectionCollection(merged, stored, [{ type: "sale" }]);
    assertEquals([out.collection, out.customer_returning, out.dates.collection_start], [null, null, null]);
  });

  await t.step("DERIVE: a placed leg with a null flag takes customer_collecting", () => {
    const merged: Pair = { ...stored, customer_collecting: true, customer_returning: null };
    assertEquals(deriveProjectionCollection(merged, stored, [{ type: "rental" }]).customer_returning, true);
  });

  await t.step("never invents a leg: a new pair with a rental and no stored leg is left as merged", () => {
    const merged: Pair = { ...nulled, customer_returning: null };
    const out = deriveProjectionCollection(merged, undefined, [{ type: "rental" }]);
    assertEquals(out === merged, true);
  });
});

Deno.test("bookingCollectionFor: a booking's collection is its OWN type's", async (t) => {
  const pair = {
    delivery: { uid: "destdelivery00000001", address: null },
    collection: { uid: "destcollection000001", address: null },
  };
  await t.step("rental → the pair's leg", () => {
    assertEquals(bookingCollectionFor("rental", pair), {
      collection: { uid: "destcollection000001", address: null },
      uid_destination_collection: "destcollection000001",
    });
  });
  await t.step("sale → null on both fields, even beside a placed leg", () => {
    assertEquals(bookingCollectionFor("sale", pair), { collection: null, uid_destination_collection: null });
  });
  await t.step("rental on an unplaced leg takes the delivery address", () => {
    assertEquals(
      bookingCollectionFor("rental", { ...pair, collection: { uid: null, address: null } }).uid_destination_collection,
      "destdelivery00000001",
    );
  });
  await t.step("rental with no leg throws — the order normalizer was skipped", () => {
    let threw = false;
    try {
      bookingCollectionFor("rental", { ...pair, collection: null });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  });
});
