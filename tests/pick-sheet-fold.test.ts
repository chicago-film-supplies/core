/**
 * The pick-sheet fold (`src/utils/pick-sheet-fold.ts`).
 *
 * 🔴 **Moved here from `api-cloudrun/tests/unit/pickSheetFold.test.ts` with the
 * fold itself.** The rule had two homes — the wire document's and the manager
 * screen's — and this file is what proves the surviving one still answers every
 * question both used to. The PAGING half stayed behind: it clips against
 * api-cloudrun's response budget, which is that service's transport rather than
 * a property of a pick sheet.
 *
 * ⚠️ **The fixture is a REAL `Fulfillment` and REAL `Booking`s, built with no
 * cast**, for the reason `bookingWriteNoOp.test.ts` states: a document laundered
 * through `as unknown as T` lets a field the schema GAINS be silently absent
 * from every case here while production sees it. `typeEscapeRatchet` bans that
 * shape.
 *
 * 🔴 **The order is TWO-DESTINATION, and it is kept.** 1,000 of 1,000 prod
 * orders carry exactly one destination — a fact about CRMS, the only writer,
 * never about the domain. Every fold, every gate and every scope narrowing looks
 * correct indefinitely against a one-leg corpus and fails the first time a
 * second destination appears, so the case the corpus cannot produce is the case
 * this file is built around.
 *
 * Hermetic — the fold is pure and imports no `db` (#279).
 */
import { assert, assertEquals } from "@std/assert";
import type {
  Booking,
  DocDestinationType,
  Fulfillment,
  FulfillmentItemType,
  OrderDocDatesType,
  PickSheetScope,
} from "../src/schemas/mod.ts";
import { pickSheetItemOwnsBooking } from "../src/schemas/mod.ts";
import {
  chooseBookingOwner,
  compareSheetOrders,
  foldPickSheet,
  orderDueAt,
  sheetDestinationCount,
  sheetOrganizations,
  sheetQuantity,
} from "../src/utils/pick-sheet-fold.ts";
import { pickSheetLineBooking } from "../src/utils/pickSheets.ts";
import { tsAt } from "./helpers/timestamp.ts";

const TS = tsAt("2023-11-14T22:13:20.000Z");

const ORDER = "o".repeat(20);
const ORDER_B = "p".repeat(20);
const ORG = "g".repeat(20);
const ORG_B = "h".repeat(20);
/** The two `destinations/{uid}` ADDRESS-BOOK rows — never divider uids. */
const STAGE = "s".repeat(20);
const LOT = "l".repeat(20);
/** Our own counter, where a `customer_collecting` leg's delivery endpoint points. */
const STORE = "w".repeat(20);

const CAMERA = "c".repeat(20);
const TRIPOD = "t".repeat(20);
const DELIVERY_FEE = "f".repeat(20);

/** Divider uids are UUIDs — `DocDestination.uid` is `z.uuid()`. */
const LEG_1 = "11111111-1111-4111-8111-111111111111";
const LEG_2 = "22222222-2222-4222-8222-222222222222";
const GROUP_1 = "33333333-3333-4333-8333-333333333333";

function dates(deliveryStart: string | null, collectionStart: string | null): OrderDocDatesType {
  return {
    delivery_start: deliveryStart,
    delivery_start_fs: null,
    delivery_end: null,
    delivery_end_fs: null,
    collection_start: collectionStart,
    collection_start_fs: null,
    collection_end: null,
    collection_end_fs: null,
    charge_start: null,
    charge_start_fs: null,
    charge_end: null,
    charge_end_fs: null,
    days_active: null,
    days_charged: null,
  };
}

interface PairOpts {
  collecting?: boolean;
  returning?: boolean;
  deliveryStart?: string | null;
  collectionStart?: string | null;
}

function pair(uid: string, deliveryUid: string | null, opts: PairOpts = {}): DocDestinationType {
  return {
    uid,
    // ⚠️ `??` would swallow an explicit `null`, which is exactly the case the
    // undated-leg test exists to exercise — so the default is keyed on absence.
    dates: dates(
      opts.deliveryStart === undefined ? "2026-09-01T09:00:00.000-05:00" : opts.deliveryStart,
      opts.collectionStart === undefined ? null : opts.collectionStart,
    ),
    delivery: { uid: deliveryUid, address: null, instructions: null, contact: null },
    collection: { uid: deliveryUid, address: null, instructions: null, contact: null },
    customer_collecting: opts.collecting ?? false,
    customer_returning: opts.returning ?? false,
  };
}

function divider(uid: string, name: string): FulfillmentItemType {
  return { uid, type: "destination", name, path: [uid], description: "" };
}

function group(uid: string, name: string, path: string[]): FulfillmentItemType {
  return { uid, type: "group", name, path, description: "" };
}

function line(
  uid: string,
  name: string,
  quantity: number,
  path: string[],
  type: "rental" | "sale" | "service" = "rental",
): FulfillmentItemType {
  return { uid, type, name, description: "", quantity, path };
}

function fulfillment(overrides: Partial<Fulfillment> = {}): Fulfillment {
  return {
    uid: ORDER,
    number: 851,
    status: "reserved",
    organization: { uid: ORG, path: [{ uid: ORG, name: "20th Television › Pilot", derived: false }] },
    destinations: [pair(LEG_1, STAGE)],
    items: [divider(LEG_1, "Stage 4"), line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA])],
    subject: "Ep 101",
    reference: null,
    query_by_items: [],
    query_by_contacts: [],
    query_by_dates: [],
    version: 3,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

interface BookingOpts {
  orderUid?: string;
  type?: Booking["type"];
  status?: Booking["status"];
  quantity?: number;
  reserved?: number;
  prepped?: number;
  out?: number;
  returned?: number;
  orgUid?: string;
}

function booking(productUid: string, deliveryUid: string, opts: BookingOpts = {}): Booking {
  const orderUid = opts.orderUid ?? ORDER;
  const quantity = opts.quantity ?? 2;
  return {
    uid: `${orderUid}:${productUid}:${deliveryUid}`,
    uid_order: orderUid,
    uid_product: productUid,
    name: productUid === CAMERA ? "Alexa 35" : "Sachtler",
    number: 1,
    type: opts.type ?? "rental",
    status: opts.status ?? "reserved",
    quantity,
    shortage: 0,
    subject: "Ep 101",
    breakdown: {
      damaged: 0,
      lost: 0,
      out: opts.out ?? 0,
      prepped: opts.prepped ?? 0,
      quoted: 0,
      reserved: opts.reserved ?? (opts.prepped || opts.out || opts.returned ? 0 : quantity),
      returned: opts.returned ?? 0,
    },
    dates: {
      start: null,
      start_fs: null,
      end: null,
      end_fs: null,
      charge_start: null,
      charge_start_fs: null,
      charge_end: null,
      charge_end_fs: null,
    },
    destinations: {
      delivery: { uid: deliveryUid, address: null },
      collection: { uid: deliveryUid, address: null },
    },
    organization: {
      uid: opts.orgUid ?? ORG,
      path: [{ uid: opts.orgUid ?? ORG, name: "20th Television › Pilot", derived: false }],
      crms_id: null,
    },
    stores: [],
    query_by_uid_store: [],
    query_by_uid_location: [],
    uid_destination_delivery: deliveryUid,
    uid_destination_collection: deliveryUid,
    version: 1,
    created_at: TS,
    updated_at: TS,
  };
}

function docs(...fs: Fulfillment[]): Map<string, Fulfillment> {
  return new Map(fs.map((f) => [f.uid, f]));
}

const DESTINATION_SCOPE: PickSheetScope = { kind: "destination", uid: STAGE, name: "Stage 4", uids: [STAGE] };
const ORG_SCOPE: PickSheetScope = { kind: "organization", uid: ORG, name: "20th Television", uids: [ORG] };

// ── Membership and scope narrowing ──────────────────────────────────

Deno.test("fold: a destination scope keeps only the legs delivering THERE", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE), pair(LEG_2, LOT)],
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      divider(LEG_2, "Back Lot"),
      line(TRIPOD, "Sachtler", 1, [LEG_2, TRIPOD]),
    ],
  });
  // Both legs' bookings are open; only the membership query narrows, and the
  // fold must narrow again by LEG or the second leg rides in on the first.
  const bookings = [booking(CAMERA, STAGE), booking(TRIPOD, LOT, { quantity: 1 })];

  const { orders } = foldPickSheet({ scope: DESTINATION_SCOPE, gate: "all", leg: null, bookings, fulfillments: docs(f) });
  assertEquals(orders.length, 1);
  assertEquals(orders[0].destinations.map((d) => d.uid), [LEG_1]);
  assertEquals(sheetQuantity(orders), 2);
});

Deno.test("fold: an ORGANIZATION scope keeps BOTH legs of the same order", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE), pair(LEG_2, LOT)],
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      divider(LEG_2, "Back Lot"),
      line(TRIPOD, "Sachtler", 1, [LEG_2, TRIPOD]),
    ],
  });
  const bookings = [booking(CAMERA, STAGE), booking(TRIPOD, LOT, { quantity: 1 })];

  const { orders } = foldPickSheet({ scope: ORG_SCOPE, gate: "all", leg: null, bookings, fulfillments: docs(f) });
  assertEquals(orders.length, 1);
  assertEquals(orders[0].destinations.map((d) => d.uid), [LEG_1, LEG_2]);
  assertEquals(sheetDestinationCount(orders), 2);
  assertEquals(sheetQuantity(orders), 3);
});

Deno.test("fold: the gate drops a customer-collect leg from a crew sheet", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STORE, { collecting: true })],
    items: [divider(LEG_1, "Will call"), line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA])],
  });
  const bookings = [booking(CAMERA, STORE)];
  const scope: PickSheetScope = { kind: "destination", uid: STORE, name: "CFS", uids: [STORE] };

  assertEquals(foldPickSheet({ scope, gate: "crew", leg: null, bookings, fulfillments: docs(f) }).orders.length, 0);
  assertEquals(foldPickSheet({ scope, gate: "counter", leg: null, bookings, fulfillments: docs(f) }).orders.length, 1);
  assertEquals(foldPickSheet({ scope, gate: "all", leg: null, bookings, fulfillments: docs(f) }).orders.length, 1);
});

// ── Rows ────────────────────────────────────────────────────────────

/**
 * 🔴 The property the whole "rows come from `fulfillments`" decision rests on.
 *
 * A `service` line has no booking row at all. A bookings-derived sheet would be
 * silently short by exactly this line — and short in the direction nobody
 * notices, because what is missing is not on the page to be missed.
 */
Deno.test("fold: a line with NO booking is still a row — bookings cannot be the row source", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      line(DELIVERY_FEE, "Delivery", 1, [LEG_1, DELIVERY_FEE], "service"),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE)],
    fulfillments: docs(f),
  });
  const leg = orders[0].destinations[0];
  assertEquals(leg.items.length, 2, "the service line is on the sheet");
  assertEquals(leg.items[1].item.uid, DELIVERY_FEE);
  assertEquals(leg.items[1].uid_booking, null, "and it honestly names no booking");
  assertEquals(leg.bookings.length, 1);
});

Deno.test("fold: a group divider is a row, and its children come with it", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      group(GROUP_1, "Camera package", [LEG_1, GROUP_1]),
      line(CAMERA, "Alexa 35", 2, [LEG_1, GROUP_1, CAMERA]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE)],
    fulfillments: docs(f),
  });
  assertEquals(orders[0].destinations[0].items.map((i) => i.item.uid), [GROUP_1, CAMERA]);
});

/**
 * 🔴 Every `items[].path` is byte-identical to its own document's.
 *
 * Asserted DIRECTLY against the fixture, never against a recompute. A
 * fixed-point check against the normalizer once certified 79 provably-wrong
 * items as clean corpus-wide; a guard that can only consult its own oracle is
 * not a guard.
 */
Deno.test("fold: paths are carried VERBATIM — the fold mints none", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE), pair(LEG_2, LOT)],
    items: [
      divider(LEG_1, "Stage 4"),
      group(GROUP_1, "Camera package", [LEG_1, GROUP_1]),
      line(CAMERA, "Alexa 35", 2, [LEG_1, GROUP_1, CAMERA]),
      divider(LEG_2, "Back Lot"),
      line(TRIPOD, "Sachtler", 1, [LEG_2, TRIPOD]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: ORG_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE), booking(TRIPOD, LOT, { quantity: 1 })],
    fulfillments: docs(f),
  });
  const [legOne, legTwo] = orders[0].destinations;
  assertEquals(legOne.items.map((i) => i.item.path), [[LEG_1, GROUP_1], [LEG_1, GROUP_1, CAMERA]]);
  assertEquals(legTwo.items.map((i) => i.item.path), [[LEG_2, TRIPOD]]);
  // And the second leg's lines were not re-parented onto the first divider —
  // the failure a naive concat produces on any document with two destinations.
  assert(legTwo.items.every((i) => i.item.path[0] === LEG_2));
});

/**
 * 🔴 A booking is aggregate per `(order, product, destination)`, and the same
 * product may legally repeat in one leg. Counting it once per LINE is the N×
 * defect the manager's owner rule exists to stop on a table; this document
 * states the aggregate once and lets every line point at it.
 */
Deno.test("fold: two lines on one aggregate booking count its units ONCE", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      // A priced principal, and the same product again as a zero-priced
      // accessory inside a kit — both resolve to the same booking uid.
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      group(GROUP_1, "B camera", [LEG_1, GROUP_1]),
      line(CAMERA, "Alexa 35", 0, [LEG_1, GROUP_1, CAMERA]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE)],
    fulfillments: docs(f),
  });
  const leg = orders[0].destinations[0];
  assertEquals(leg.items.length, 3);
  assertEquals(
    leg.items.filter((i) => i.uid_booking !== null).length,
    2,
    "both occurrences name the booking — that is the truth, not a display choice",
  );
  assertEquals(leg.bookings.length, 1, "and it is stated once");
  assertEquals(leg.quantity, 2, "N× would read 4");
  assertEquals(leg.breakdown.reserved, 2);
});

Deno.test("fold: a booking outside the open slice reads as NO booking, not a closed one", () => {
  const f = fulfillment();
  // The membership query bands on `status != complete`, so a finished line's
  // booking never arrives. The row must still render, naming nothing.
  const { orders } = foldPickSheet({
    scope: ORG_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(TRIPOD, STAGE, { quantity: 1 })],
    fulfillments: docs(f),
  });
  // The order's only line is the camera, whose booking is absent; the tripod
  // booking names a line this document does not carry, so no leg has work.
  assertEquals(orders.length, 0);
});

Deno.test("fold: a leg whose pair names no delivery endpoint carries no booking", () => {
  const f = fulfillment({ destinations: [pair(LEG_1, null)] });
  const { orders } = foldPickSheet({
    scope: ORG_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE)],
    fulfillments: docs(f),
  });
  assertEquals(orders.length, 0, "nothing is addressable there");
});

// ── Findings ────────────────────────────────────────────────────────

/**
 * 🔴 A pick sheet that is silently short is the one failure this surface
 * refuses. An order in the membership slice with no readable projection means
 * `bookings` and `fulfillments` disagree — a finding, not a display problem.
 */
Deno.test("fold: an order with no fulfillment document is SURFACED, never dropped", () => {
  const { orders, missingOrderUids } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE), booking(CAMERA, STAGE, { orderUid: ORDER_B })],
    fulfillments: docs(fulfillment()),
  });
  assertEquals(orders.length, 1);
  assertEquals(missingOrderUids, [ORDER_B]);
});

// ── Dates and order ─────────────────────────────────────────────────

Deno.test("leg: a `collection` sheet drops a leg still waiting to go out", () => {
  const f = fulfillment({ destinations: [pair(LEG_1, STAGE)] });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: "collection",
    bookings: [booking(CAMERA, STAGE, { reserved: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders.length, 0, "a leg with outbound work is not on a collection sheet");
});

Deno.test("leg: a `delivery` sheet keeps that same leg", () => {
  const f = fulfillment({ destinations: [pair(LEG_1, STAGE)] });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: "delivery",
    bookings: [booking(CAMERA, STAGE, { reserved: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders[0].destinations.map((d) => d.uid), [LEG_1]);
});

Deno.test("leg: the two directions PARTITION one sheet, and `null` keeps both", () => {
  // ⭐ The case a packing list exists for: one place, one order, work going both
  // ways at once. `null` is the screen's answer; a printed document names one.
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE), pair(LEG_2, LOT)],
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      divider(LEG_2, "Back Lot"),
      line(TRIPOD, "Sachtler", 1, [LEG_2, TRIPOD]),
    ],
  });
  // LEG_1 is still going out; LEG_2 is in flight and therefore coming back.
  const bookings = [
    booking(CAMERA, STAGE, { reserved: 2 }),
    booking(TRIPOD, LOT, { quantity: 1, status: "active", out: 1 }),
  ];
  const all = foldPickSheet({ scope: ORG_SCOPE, gate: "all", leg: null, bookings, fulfillments: docs(f) });
  assertEquals(all.orders[0].destinations.map((d) => d.uid), [LEG_1, LEG_2]);

  const out = foldPickSheet({ scope: ORG_SCOPE, gate: "all", leg: "delivery", bookings, fulfillments: docs(f) });
  assertEquals(out.orders[0].destinations.map((d) => d.uid), [LEG_1]);

  const back = foldPickSheet({ scope: ORG_SCOPE, gate: "all", leg: "collection", bookings, fulfillments: docs(f) });
  assertEquals(back.orders[0].destinations.map((d) => d.uid), [LEG_2]);
});

Deno.test("leg: an order left with NO admitted leg drops off the sheet entirely", () => {
  // The filter sits below the gate's and above the `legs.length === 0` check, so
  // an order whose every leg is the wrong direction must not arrive as an empty
  // header rather than being absent.
  const f = fulfillment({ destinations: [pair(LEG_1, STAGE)] });
  const { orders, missingOrderUids } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: "collection",
    bookings: [booking(CAMERA, STAGE, { reserved: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders, []);
  assertEquals(missingOrderUids, [], "a filtered-out order is not a MISSING one");
});

Deno.test("due_at: a pending leg waits on its DELIVERY date", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE, {
      deliveryStart: "2026-09-01T09:00:00.000-05:00",
      collectionStart: "2026-09-10T09:00:00.000-05:00",
    })],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE, { reserved: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders[0].destinations[0].due_at, "2026-09-01T09:00:00.000-05:00");
});

Deno.test("due_at: a leg fully in flight waits on its COLLECTION date", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE, {
      deliveryStart: "2026-09-01T09:00:00.000-05:00",
      collectionStart: "2026-09-10T09:00:00.000-05:00",
    })],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE, { status: "active", out: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders[0].destinations[0].due_at, "2026-09-10T09:00:00.000-05:00");
});

/**
 * 🔴 A SALE's `out` is terminal — checkout IS delivery and the units do not come
 * back — so it must not pull the leg onto a collection date that will never
 * arrive. Measured on prod: all 380 bookings with a terminal `out > 0` were
 * sales, and complete rentals with `out > 0` numbered 0.
 */
Deno.test("due_at: a SALE sitting in `out` is not waiting on a collection", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE, {
      deliveryStart: "2026-09-01T09:00:00.000-05:00",
      collectionStart: "2026-09-10T09:00:00.000-05:00",
    })],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE, { type: "sale", status: "active", out: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders[0].destinations[0].due_at, "2026-09-01T09:00:00.000-05:00");
});

Deno.test("due_at: a partially prepped leg is still waiting to go OUT", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE, {
      deliveryStart: "2026-09-01T09:00:00.000-05:00",
      collectionStart: "2026-09-10T09:00:00.000-05:00",
    })],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE, { status: "part-prepped", prepped: 1, out: 1, quantity: 2 })],
    fulfillments: docs(f),
  });
  assertEquals(orders[0].destinations[0].due_at, "2026-09-01T09:00:00.000-05:00");
});

/**
 * ⚠️ ISO strings compare lexically and `null` is not a string, so the naive
 * comparator puts every unscheduled leg above the one going out this morning.
 */
Deno.test("sort: an undated order sorts LAST, not first", () => {
  const soon = fulfillment({
    destinations: [pair(LEG_1, STAGE, { deliveryStart: "2026-09-01T09:00:00.000-05:00" })],
  });
  const undated = fulfillment({
    uid: ORDER_B,
    number: 852,
    destinations: [pair(LEG_1, STAGE, { deliveryStart: null, collectionStart: null })],
    items: [divider(LEG_1, "Stage 4"), line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA])],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [
      booking(CAMERA, STAGE, { orderUid: ORDER_B }),
      booking(CAMERA, STAGE),
    ],
    fulfillments: docs(soon, undated),
  });
  assertEquals(orders.map((o) => o.uid), [ORDER, ORDER_B]);
  assertEquals(orderDueAt(orders[1]), null);
  // Total, so a page boundary cannot wander between two calls.
  assert(compareSheetOrders(orders[0], orders[1]) < 0);
  assert(compareSheetOrders(orders[1], orders[0]) > 0);
  assertEquals(compareSheetOrders(orders[0], orders[0]), 0);
});

Deno.test("sort: an order's own due date is its EARLIEST leg's", () => {
  const f = fulfillment({
    destinations: [
      pair(LEG_1, STAGE, { deliveryStart: "2026-09-20T09:00:00.000-05:00" }),
      pair(LEG_2, LOT, { deliveryStart: "2026-09-02T09:00:00.000-05:00" }),
    ],
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      divider(LEG_2, "Back Lot"),
      line(TRIPOD, "Sachtler", 1, [LEG_2, TRIPOD]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: ORG_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE), booking(TRIPOD, LOT, { quantity: 1 })],
    fulfillments: docs(f),
  });
  assertEquals(orderDueAt(orders[0]), "2026-09-02T09:00:00.000-05:00");
  assertEquals(orders[0].destinations.map((d) => d.uid), [LEG_2, LEG_1], "soonest leg first within the order");
});

// ── Page summary ────────────────────────────────────────────────────

Deno.test("organizations: a sheet spanning two customers names both", () => {
  const a = fulfillment();
  const b = fulfillment({
    uid: ORDER_B,
    number: 852,
    organization: { uid: ORG_B, path: [{ uid: ORG_B, name: "Free Spirit Media", derived: false }] },
    items: [divider(LEG_1, "Stage 4"), line(CAMERA, "Alexa 35", 1, [LEG_1, CAMERA])],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [
      booking(CAMERA, STAGE),
      booking(CAMERA, STAGE, { orderUid: ORDER_B, quantity: 1, orgUid: ORG_B }),
    ],
    fulfillments: docs(a, b),
  });
  assertEquals(sheetOrganizations(orders).map((o) => o.uid).sort(), [ORG, ORG_B].sort());
  assertEquals(sheetQuantity(orders), 3);
  assertEquals(sheetDestinationCount(orders), 2);
});


// ── The owner stamp ─────────────────────────────────────────────────

/**
 * 🔴 **The arm the whole `owner_path` field exists for, and it is measured
 * rather than hypothetical:** on prod, **384 legs carry a booking that stands
 * for 2 or more lines**. A booking is aggregate per
 * `(order, product, destination)`, so drawing its seven buckets on every line
 * that names it states its units N times.
 *
 * ⚠️ **Assert the OWNER, not merely that one exists.** "Exactly one owns" passes
 * against a fold that picks arbitrarily, and picking arbitrarily is the defect
 * that put prod order 961's milk crates in the wrong pane — see the quantity arm
 * below.
 */
Deno.test("owner: two lines on one booking — exactly one OWNS, and the others name it", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      // A priced principal parented by the divider, and the same product again
      // as a zero-priced accessory inside another PRODUCT. Both resolve to one
      // booking. ⚠️ The accessory hangs off the tripod rather than off a
      // `group`: a group divider IS structural parentage, so a group-parented
      // copy would tie on rule 1 and be decided by quantity instead — which is
      // the distinction the next arm is about.
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      line(TRIPOD, "Sachtler", 1, [LEG_1, TRIPOD]),
      line(CAMERA, "Alexa 35", 0, [LEG_1, TRIPOD, CAMERA]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE), booking(TRIPOD, STAGE, { quantity: 1 })],
    fulfillments: docs(f),
  });
  const items = orders[0].destinations[0].items;

  const owners = items.filter((i) => i.item.uid === CAMERA).filter(pickSheetItemOwnsBooking);
  assertEquals(owners.length, 1, "one booking, one owner — N owners is N× the units");
  assertEquals(owners[0].item.path, [LEG_1, CAMERA], "the structurally-parented occurrence owns");

  const nonOwner = items.find((i) => i.item.path.length === 3)!;
  assertEquals(nonOwner.uid_booking, owners[0].uid_booking, "it names the same booking");
  assertEquals(
    nonOwner.owner_path,
    [LEG_1, CAMERA],
    "and points at the owner's own path, so it can say WHERE its units are counted",
  );
  assertEquals(pickSheetItemOwnsBooking(nonOwner), false);
});

/**
 * 🔴 **Structural parentage is a strict OVERRIDE, not a tiebreak** — it wins
 * even against a larger quantity.
 *
 * A booking-less structurally-parented row is precisely the one the manager's
 * row classifier cannot rescue through a product ancestor: it has none. It still
 * classifies, but only because SOME occurrence owns, so the structural class has
 * to win outright whenever it is non-empty.
 */
Deno.test("owner: structural parentage beats a LARGER component-parented quantity", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 1, [LEG_1, CAMERA]),
      line(TRIPOD, "Sachtler", 1, [LEG_1, TRIPOD]),
      line(CAMERA, "Alexa 35", 9, [LEG_1, TRIPOD, CAMERA]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE, { quantity: 10 }), booking(TRIPOD, STAGE, { quantity: 1 })],
    fulfillments: docs(f),
  });
  const owners = orders[0].destinations[0].items
    .filter((i) => i.item.uid === CAMERA)
    .filter(pickSheetItemOwnsBooking);
  assertEquals(owners.length, 1);
  assertEquals(owners[0].item.path, [LEG_1, CAMERA], "quantity 1 still outranks quantity 9");
});

/**
 * ⭐ **Prod order 961, restated as a fixture.** A Long Milk Crate sat at four
 * component-parented occurrences — qty 1 / 1 / 2 / 1 — under a steamer, two
 * tents and an extension cord. **Document order handed all five units to the
 * steamer's copy**, so the crates were prepped from inside *Wardrobe*, and
 * dragged the steamer — itself fully checked out — back into the *Reserved*
 * pane as the ancestor shell needed to place its owner child.
 *
 * ⚠️ The fail-closed half: document order alone would pick the FIRST occurrence,
 * so this fixture puts the largest quantity third. An arm whose expected value
 * happens to be the first row cannot tell the two rules apart.
 */
Deno.test("owner: among component-parented occurrences the LARGEST ordered quantity owns", () => {
  const STEAMER = "e".repeat(20);
  const TENT = "n".repeat(20);
  const CORD = "d".repeat(20);
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      line(STEAMER, "Steamer", 1, [LEG_1, STEAMER]),
      line(TRIPOD, "Long Milk Crate", 1, [LEG_1, STEAMER, TRIPOD]),
      line(TENT, "Tent", 1, [LEG_1, TENT]),
      line(TRIPOD, "Long Milk Crate", 2, [LEG_1, TENT, TRIPOD]),
      line(CORD, "Extension cord", 1, [LEG_1, CORD]),
      line(TRIPOD, "Long Milk Crate", 1, [LEG_1, CORD, TRIPOD]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [
      booking(STEAMER, STAGE, { quantity: 1 }),
      booking(TENT, STAGE, { quantity: 1 }),
      booking(CORD, STAGE, { quantity: 1 }),
      booking(TRIPOD, STAGE, { quantity: 4 }),
    ],
    fulfillments: docs(f),
  });
  const items = orders[0].destinations[0].items;
  const crateOwner = items.filter((i) => i.item.uid === TRIPOD).filter(pickSheetItemOwnsBooking);
  assertEquals(crateOwner.length, 1);
  assertEquals(
    crateOwner[0].item.path,
    [LEG_1, TENT, TRIPOD],
    "the qty-2 occurrence owns — not the first one in document order",
  );

  // The population assertion beside the rule: every booking on the leg has
  // exactly one owner, so this stays a statement about ALL of them rather than
  // about the one the fixture was built around.
  const leg = orders[0].destinations[0];
  assertEquals(leg.bookings.length, 4);
  assertEquals(items.filter(pickSheetItemOwnsBooking).length, 4);
});

/**
 * 🔴 **The fail-closed companion.** `owner_path === null` is NOT ownership —
 * every divider, every `group` and every non-stock line also carries `null`
 * there, and reading the pointer alone would make each of them an owner of
 * nothing. That renders as a row with blank quantity cells where the sheet meant
 * to draw no cells at all.
 */
Deno.test("owner: a divider, a group and a service line own NOTHING and point at nothing", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      group(GROUP_1, "Camera package", [LEG_1, GROUP_1]),
      line(CAMERA, "Alexa 35", 2, [LEG_1, GROUP_1, CAMERA]),
      line(DELIVERY_FEE, "Delivery", 1, [LEG_1, DELIVERY_FEE], "service"),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE)],
    fulfillments: docs(f),
  });
  const items = orders[0].destinations[0].items;
  const byUid = (uid: string) => items.find((i) => i.item.uid === uid)!;

  for (const uid of [GROUP_1, DELIVERY_FEE]) {
    assertEquals(byUid(uid).uid_booking, null);
    assertEquals(byUid(uid).owner_path, null);
    assertEquals(pickSheetItemOwnsBooking(byUid(uid)), false, `${uid} owns nothing`);
  }
  // …and the one line that DOES resolve is an owner, so the arm above cannot go
  // vacuous by the fold simply never stamping anything.
  assertEquals(pickSheetItemOwnsBooking(byUid(CAMERA)), true);
});

/**
 * 🔴 **Two destination pairs on ONE address-book row stay TWO legs**, and this
 * fixture exists because no corpus can produce it: all 2,980 prod destination
 * dividers are 1:1 with their `delivery.uid`.
 *
 * `destinations/{uid}` is globally deduped by `findOrCreateDestination`, so two
 * legs of one order delivering to one place legitimately SHARE a
 * `delivery.uid`. The fold keys sections on the DIVIDER uid; keying them on the
 * endpoint would merge these two into one and silently drop a leg — reporting
 * clean right up to the first instance.
 *
 * ⚠️ **The over-count below is REAL and is not what this arm is asserting.** A
 * booking's document id is `{order}:{product}:{delivery.uid}` and carries no leg
 * segment, so one booking genuinely spans both legs — and `quantity` /
 * `sheetQuantity` therefore state its units once per leg. That is a limit of the
 * booking id rather than of this fold (api-cloudrun#933); it is pinned here so
 * the repair has a place to land and cannot arrive unnoticed.
 */
Deno.test("scope: two pairs sharing one delivery uid are TWO legs, never merged", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE), pair(LEG_2, STAGE)],
    items: [
      divider(LEG_1, "Stage 4 — day 1"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      divider(LEG_2, "Stage 4 — day 2"),
      line(CAMERA, "Alexa 35", 3, [LEG_2, CAMERA]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE, { quantity: 5 })],
    fulfillments: docs(f),
  });

  assertEquals(orders.length, 1);
  assertEquals(
    orders[0].destinations.map((d) => d.uid),
    [LEG_1, LEG_2],
    "both legs survive — the section key is the divider, not the address",
  );
  assertEquals(sheetDestinationCount(orders), 2);
  // Each leg owns its own copy of the line, independently.
  for (const leg of orders[0].destinations) {
    assertEquals(leg.items.filter(pickSheetItemOwnsBooking).length, 1);
  }
  // The known over-count, stated rather than hidden: 5 units, counted twice.
  assertEquals(sheetQuantity(orders), 10, "api-cloudrun#933 — one booking, two legs");
});

// ── The template's door onto a row's numbers ────────────────────────

/**
 * 🔴 **`pickSheetLineBooking` is the only safe way to put a NUMBER on a
 * pick-sheet row**, and this arm is what stops it becoming the N× defect it
 * exists to prevent. A packing list with seven state columns asks per-row; the
 * section totals cannot answer per-row; the naive lookup
 * (`bookings.find(b => b.uid === row.uid_booking)`) answers on EVERY occurrence
 * and states the booking's units once per line.
 *
 * ⚠️ **Paired with a negative control on purpose.** "The owner gets its booking"
 * would pass just as happily against the naive lookup — only the non-owner's
 * `null` tells the two apart.
 */
Deno.test("helper: pickSheetLineBooking answers for the OWNER and null for every other occurrence", () => {
  const f = fulfillment({
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      line(TRIPOD, "Sachtler", 1, [LEG_1, TRIPOD]),
      line(CAMERA, "Alexa 35", 0, [LEG_1, TRIPOD, CAMERA]),
      line(DELIVERY_FEE, "Delivery", 1, [LEG_1, DELIVERY_FEE], "service"),
    ],
  });
  const { orders } = foldPickSheet({
    scope: DESTINATION_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE), booking(TRIPOD, STAGE, { quantity: 1 })],
    fulfillments: docs(f),
  });
  const leg = orders[0].destinations[0];
  const row = (path: string[]) =>
    leg.items.find((i) => i.item.path.length === path.length && i.item.path.every((s, k) => s === path[k]))!;

  const owner = pickSheetLineBooking(leg, row([LEG_1, CAMERA]));
  assertEquals(owner?.quantity, 2, "the owner states the booking's units");

  assertEquals(
    pickSheetLineBooking(leg, row([LEG_1, TRIPOD, CAMERA])),
    null,
    "the second occurrence states NOTHING — a naive uid lookup would state 2 here too",
  );
  assertEquals(pickSheetLineBooking(leg, row([LEG_1, DELIVERY_FEE])), null, "a service line has no booking");

  // The property that makes the sheet add up: summing what the helper hands back
  // over every row equals the leg's own total, with no double count.
  const summed = leg.items.reduce((n, i) => n + (pickSheetLineBooking(leg, i)?.quantity ?? 0), 0);
  assertEquals(summed, leg.quantity, "row-by-row and section total agree");
  assertEquals(leg.quantity, 3);
});

/**
 * ⚠️ **Handed the wrong leg it returns `null`, never another leg's number.**
 * The failing-safe direction: a blank cell is a visible absence, a wrong
 * quantity is not.
 */
Deno.test("helper: pickSheetLineBooking refuses a row from a DIFFERENT leg", () => {
  const f = fulfillment({
    destinations: [pair(LEG_1, STAGE), pair(LEG_2, LOT)],
    items: [
      divider(LEG_1, "Stage 4"),
      line(CAMERA, "Alexa 35", 2, [LEG_1, CAMERA]),
      divider(LEG_2, "Back Lot"),
      line(TRIPOD, "Sachtler", 1, [LEG_2, TRIPOD]),
    ],
  });
  const { orders } = foldPickSheet({
    scope: ORG_SCOPE,
    gate: "all",
    leg: null,
    bookings: [booking(CAMERA, STAGE), booking(TRIPOD, LOT, { quantity: 1 })],
    fulfillments: docs(f),
  });
  const [legOne, legTwo] = orders[0].destinations;
  assertEquals(pickSheetLineBooking(legOne, legOne.items[0])?.uid_product, CAMERA);
  assertEquals(pickSheetLineBooking(legTwo, legOne.items[0]), null);
});

// ── The owner rule, asked directly ──────────────────────────────────

/**
 * 🔴 **`chooseBookingOwner` has TWO callers and this is where the rule is
 * pinned**, rather than only through the fold. The other caller is
 * `manager/src/utils/orderBookingJoin.ts`, which walks a whole order — including
 * the legs the fold drops for having nothing open — so a rule tested only
 * through `foldPickSheet` is a rule half its callers exercise.
 *
 * ⚠️ Every arm names the OCCURRENCE that wins, never merely "one wins". Picking
 * arbitrarily satisfies the weaker claim and is the defect prod order 961
 * recorded.
 */
Deno.test("chooseBookingOwner: structural parentage is a strict override", () => {
  const structural = { path: ["d", "p"], isStructural: true, quantity: 1 };
  const component = { path: ["d", "k", "p"], isStructural: false, quantity: 99 };
  assertEquals(chooseBookingOwner([structural, component]), structural);
  assertEquals(chooseBookingOwner([component, structural]), structural, "and order-independently");
});

Deno.test("chooseBookingOwner: within one class, the largest quantity wins", () => {
  const small = { path: ["d", "a", "p"], isStructural: false, quantity: 1 };
  const large = { path: ["d", "b", "p"], isStructural: false, quantity: 2 };
  const alsoSmall = { path: ["d", "c", "p"], isStructural: false, quantity: 1 };
  assertEquals(chooseBookingOwner([small, alsoSmall, large]), large, "not the first in document order");
});

Deno.test("chooseBookingOwner: a tie keeps the EARLIEST — document order is the third key", () => {
  const first = { path: ["d", "a", "p"], isStructural: false, quantity: 2 };
  const second = { path: ["d", "b", "p"], isStructural: false, quantity: 2 };
  assertEquals(chooseBookingOwner([first, second]), first);
  assertEquals(chooseBookingOwner([second, first]), second, "…which is a fact about the INPUT order");
});

/**
 * ⚠️ The fail-closed companion: no occurrences means no owner, not an invented
 * one. A booking whose lines are all outside this leg has nothing here to carry
 * its quantities, and returning a fabricated row would draw them on nothing.
 */
Deno.test("chooseBookingOwner: an empty list has no owner", () => {
  assertEquals(chooseBookingOwner([]), null);
});
