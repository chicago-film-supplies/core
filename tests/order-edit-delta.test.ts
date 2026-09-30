import { assertEquals } from "@std/assert";
import { FulfillmentLineItem, type FulfillmentItemType, type Order, OrderDocLineItem, OrderSchema } from "../src/schemas/mod.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { hasCustodyHistory } from "../src/utils/bookings.ts";
import { buildBookingIdFromSignature, componentSignatureHash } from "../src/utils/booking-id.ts";
import { type BookingCustodyFacts, bookingIdsByPath, computeOrderEditDelta } from "../src/utils/order-edit-delta.ts";
import { fid, legUid } from "./helpers/ids.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/**
 * `computeOrderEditDelta` is the ONE decision both the api's fulfillment sync
 * and the manager's removal prompt make (api-cloudrun#1147): which previous
 * rows an order edit must keep, at how many units, on which booking. The api's
 * sync suite exercises it end to end; these arms pin the function itself, so a
 * change to it fails here before either consumer.
 */

const ORDER = fid("editdeltaorder");
const A = fid("productA");
const KIT = fid("productKit");
const LEG_1 = legUid("leg-1");
const LEG_2 = legUid("leg-2");
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";

const BASE = getTestDoc(OrderSchema, { uid: ORDER, created_at: mockTimestamp, updated_at: mockTimestamp }, {
  now: mockTimestamp,
});

interface Row {
  uid: string;
  quantity: number;
  leg?: string;
  group?: string;
  /** A product to nest under: a component, whose grain carries a signature. */
  parent?: string;
}

const pathOf = (r: Row): string[] => [
  r.leg ?? LEG_1,
  ...(r.group === undefined ? [] : [r.group]),
  ...(r.parent === undefined ? [] : [r.parent]),
  r.uid,
];

/**
 * An order over `legs`, emitting each leg's divider, then each group divider
 * and kit parent before the first row under it (`groupByDestination` reads the
 * ARRAY, so a row out of place lands on the wrong leg).
 */
function order(rows: Row[], legs: string[] = [LEG_1, LEG_2]): Order {
  const items: Order["items"] = [];
  for (const leg of legs) {
    items.push({ uid: leg, type: "destination", name: "Leg", description: "", path: [leg] });
    const seen = new Set<string>();
    for (const r of rows.filter((x) => (x.leg ?? LEG_1) === leg)) {
      if (r.group !== undefined && !seen.has(r.group)) {
        seen.add(r.group);
        items.push({ uid: r.group, type: "group", name: "Group", description: "", path: [leg, r.group] });
      }
      if (r.parent !== undefined && !seen.has(r.parent)) {
        seen.add(r.parent);
        items.push(line(r.parent, 1, [leg, ...(r.group === undefined ? [] : [r.group]), r.parent]));
      }
      items.push(line(r.uid, r.quantity, pathOf(r)));
    }
  }
  return { ...BASE, destinations: legs.map((uid) => ({ ...BASE.destinations[0], uid })), items };
}

/** A `sale` line: a rental obliges `price.replacement_cents`, which is noise here. */
function line(uid: string, quantity: number, path: string[]): Order["items"][number] {
  return getTestDoc(OrderDocLineItem, { uid, type: "sale", quantity, path, zero_priced: path.length > 2 ? false : null });
}

const breakdown = (b: Partial<BookingCustodyFacts["breakdown"]>): BookingCustodyFacts["breakdown"] => ({
  cleaning: 0,
  maintenance: 0,
  quoted: 0,
  reserved: 0,
  prepped: 0,
  out: 0,
  returned: 0,
  lost: 0,
  damaged: 0,
  ...b,
});

/** A stored rental booking at `(product, leg, signature)`. */
function booking(
  product: string,
  b: Partial<BookingCustodyFacts["breakdown"]>,
  opts: { leg?: string; signature?: string | null; orderUid?: string } = {},
): [string, BookingCustodyFacts] {
  const id = buildBookingIdFromSignature(opts.orderUid ?? ORDER, product, opts.leg ?? LEG_1, opts.signature ?? null);
  return [id, { type: "rental", breakdown: breakdown(b) }];
}

function delta(prev: Order, next: Order, bookings: [string, BookingCustodyFacts][], rows: FulfillmentItemType[] = []) {
  return computeOrderEditDelta({
    orderUid: ORDER,
    prevOrder: prev,
    nextOrder: next,
    fulfillmentRows: rows,
    storedBookings: new Map(bookings),
  });
}

Deno.test("two rows share a prepped grain: removing either keeps nothing, removing both keeps the shortfall", async (t) => {
  const a = { uid: A, quantity: 2, group: G1 };
  const b = { uid: A, quantity: 2, group: G2 };
  const prev = order([a, b]);
  const bookings = [booking(A, { prepped: 2 })];

  await t.step("remove the second: the first still covers the prepped units", () => {
    const d = delta(prev, order([a]), bookings);
    assertEquals(d.keepFor(pathOf(a)), undefined);
    assertEquals(d.keepFor(pathOf(b)), undefined);
  });

  await t.step("remove the first: the second still covers them", () => {
    const d = delta(prev, order([b]), bookings);
    assertEquals(d.keepFor(pathOf(a)), undefined);
    assertEquals(d.keepFor(pathOf(b)), undefined);
  });

  await t.step("remove both: the shortfall lands on the first removed row, naming its booking", () => {
    const d = delta(prev, order([]), bookings);
    assertEquals(d.keepFor(pathOf(a)), { share: 2, sameGrain: false, bookingId: bookings[0][0], live: 2 });
    assertEquals(d.keepFor(pathOf(b)), undefined);
  });
});

Deno.test("a shrink below live custody keeps the difference on the SAME grain", () => {
  const d = delta(order([{ uid: A, quantity: 5 }]), order([{ uid: A, quantity: 1 }]), [booking(A, { out: 3 })]);
  assertEquals(d.keepFor(pathOf({ uid: A, quantity: 5 })), {
    share: 2,
    sameGrain: true,
    bookingId: booking(A, {})[0],
    live: 3,
  });
});

Deno.test("a stored fulfillment quantity is the row's BEFORE, over the previous order's", () => {
  // A picker sent 3 against an order of 2; all 3 are out, and the line is removed.
  const row = { uid: A, quantity: 2 };
  const stored = getTestDoc(FulfillmentLineItem, { uid: A, type: "sale", quantity: 3, path: pathOf(row), zero_priced: null });
  const d = delta(order([row]), order([]), [booking(A, { out: 3 })], [stored]);
  assertEquals(d.keepFor(pathOf(row))?.share, 3);
});

Deno.test("🔴 a row that changes grain keeps its custody at the OLD grain (custody never moves)", async (t) => {
  await t.step("a leg move", () => {
    const prev = order([{ uid: A, quantity: 2, leg: LEG_1 }]);
    const next = order([{ uid: A, quantity: 2, leg: LEG_2 }]);
    const d = delta(prev, next, [booking(A, { prepped: 2 })]);
    assertEquals(d.keepFor(pathOf({ uid: A, quantity: 2, leg: LEG_1 }))?.sameGrain, false);
    assertEquals(d.keepFor(pathOf({ uid: A, quantity: 2, leg: LEG_1 }))?.share, 2);
    // Both legs survive, so no pair is kept on the leg's account.
    assertEquals(d.keptLegUids.size, 0);
  });

  await t.step("a component dragged out of its kit", () => {
    const inKit = { uid: A, quantity: 2, parent: KIT };
    const signature = componentSignatureHash(pathOf(inKit));
    const d = delta(order([inKit]), order([{ uid: A, quantity: 2 }]), [booking(A, { out: 2 }, { signature })]);
    assertEquals(d.keepFor(pathOf(inKit)), {
      share: 2,
      sameGrain: false,
      bookingId: booking(A, {}, { signature })[0],
      live: 2,
    });
  });
});

Deno.test("a row the next order ADDS onto a live grain covers it", async (t) => {
  // The previous row pairs with the leg-2 occurrence (first in document order),
  // so it leaves the leg-1 grain; the added leg-1 row is what covers it.
  const prev = order([{ uid: A, quantity: 2, leg: LEG_1 }]);
  const moved = { uid: A, quantity: 2, leg: LEG_2 };
  const bookings = [booking(A, { prepped: 2 })];

  await t.step("covered: nothing is kept", () => {
    const next = order([moved, { uid: A, quantity: 2, leg: LEG_1 }], [LEG_2, LEG_1]);
    assertEquals(delta(prev, next, bookings).keepFor(pathOf({ uid: A, quantity: 2 })), undefined);
  });

  await t.step("control: without the added row the old row keeps its units", () => {
    const next = order([moved], [LEG_2, LEG_1]);
    assertEquals(delta(prev, next, bookings).keepFor(pathOf({ uid: A, quantity: 2 }))?.share, 2);
  });
});

Deno.test("a removed leg holding live custody is kept; one holding none is not", () => {
  const prev = order([{ uid: A, quantity: 1, leg: LEG_1 }, { uid: A, quantity: 1, leg: LEG_2 }]);
  const next = order([], []);
  const d = delta(prev, next, [booking(A, { out: 1 }, { leg: LEG_1 }), booking(A, { reserved: 1 }, { leg: LEG_2 })]);
  assertEquals([...d.keptLegUids], [LEG_1]);
});

Deno.test("hasLiveCustody asks the stored row's grain, and a row on no order has none", () => {
  const row = { uid: A, quantity: 2 };
  const d = delta(order([row]), order([]), [booking(A, { prepped: 1 })]);
  assertEquals(d.hasLiveCustody({ uid: A, path: pathOf(row) }), true);
  const stray = fid("productStray");
  assertEquals(d.hasLiveCustody({ uid: stray, path: [LEG_1, stray] }), false);
});

Deno.test("history keeps a BOOKING, live custody keeps a ROW", async (t) => {
  const row = { uid: A, quantity: 2 };

  await t.step("all units returned: no row keep, but the booking has history", () => {
    const [id, facts] = booking(A, { returned: 2 });
    assertEquals(delta(order([row]), order([]), [[id, facts]]).keepFor(pathOf(row)), undefined);
    assertEquals(hasCustodyHistory(facts), true);
  });

  await t.step("plan only: no history", () => {
    assertEquals(hasCustodyHistory(booking(A, { quoted: 1, reserved: 2 })[1]), false);
  });

  await t.step("a sale's delivered units are not live", () => {
    const [id] = booking(A, {});
    const d = delta(order([row]), order([]), [[id, { type: "sale", breakdown: breakdown({ out: 2 }) }]]);
    assertEquals(d.keepFor(pathOf(row)), undefined);
  });
});

Deno.test("a booking of another order is ignored", () => {
  const row = { uid: A, quantity: 2 };
  const d = delta(order([row]), order([]), [booking(A, { prepped: 2 }, { orderUid: fid("otherorder") })]);
  assertEquals(d.keepFor(pathOf(row)), undefined);
  assertEquals(d.hasLiveCustody({ uid: A, path: pathOf(row) }), false);
});

Deno.test("bookingIdsByPath: every bookable row and the booking it books into — dividers excluded, components signed", () => {
  const ord = order([
    { uid: A, quantity: 2, group: G1 },
    { uid: A, quantity: 1, group: G2 },
    { uid: A, quantity: 1, parent: KIT, leg: LEG_2 },
  ]);
  const top = buildBookingIdFromSignature(ORDER, A, LEG_1, null);
  const component = buildBookingIdFromSignature(ORDER, A, LEG_2, componentSignatureHash([LEG_2, KIT, A]));
  assertEquals(bookingIdsByPath(ord).map((r) => [r.path.join("/"), r.bookingId]), [
    // Two groups, one leg, one product: ONE grain, so one id on both rows.
    [`${LEG_1}/${G1}/${A}`, top],
    [`${LEG_1}/${G2}/${A}`, top],
    [`${LEG_2}/${KIT}`, buildBookingIdFromSignature(ORDER, KIT, LEG_2, null)],
    [`${LEG_2}/${KIT}/${A}`, component],
  ]);
  // The component's id is the 4-segment form, distinct from the top-level one.
  assertEquals(component === top, false);
});
