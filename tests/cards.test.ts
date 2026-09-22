import { assertEquals } from "@std/assert";
import {
  computeCardActionFromBookings,
  cardPickBucket,
  computeCardStatusFromBookings,
  eventCardUid,
  parseEventCardUid,
  PICK_BUCKET_CUSTOMER_COLLECT,
  type CardSiblingBooking,
} from "../src/utils/cards.ts";
import type { Booking, CardStatus } from "../src/schemas/mod.ts";

const breakdown = (overrides: Partial<Booking["breakdown"]> = {}): Booking["breakdown"] => ({
  quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0,
  ...overrides,
});

const rental = (qty: number, b: Partial<Booking["breakdown"]> = {}): CardSiblingBooking => ({
  type: "rental", quantity: qty, breakdown: breakdown(b),
});

const sale = (qty: number, b: Partial<Booking["breakdown"]> = {}): CardSiblingBooking => ({
  type: "sale", quantity: qty, breakdown: breakdown(b),
});

const service = (qty: number, b: Partial<Booking["breakdown"]> = {}): CardSiblingBooking => ({
  type: "service", quantity: qty, breakdown: breakdown(b),
});

const surcharge = (qty: number, b: Partial<Booking["breakdown"]> = {}): CardSiblingBooking => ({
  type: "surcharge", quantity: qty, breakdown: breakdown(b),
});

// ── start side ─────────────────────────────────────────────────────

Deno.test("start: nothing has moved → planned", () => {
  const siblings = [rental(5, { reserved: 5 }), rental(3, { reserved: 3 })];
  assertEquals(computeCardStatusFromBookings("start", siblings, "planned"), "planned");
});

Deno.test("start: any out > 0 with pre-delivery remaining → active", () => {
  const siblings = [rental(5, { reserved: 4, out: 1 }), rental(3, { reserved: 3 })];
  assertEquals(computeCardStatusFromBookings("start", siblings, "planned"), "active");
});

Deno.test("start: pre_delivery === 0 → complete (everything has at least left)", () => {
  const siblings = [rental(5, { out: 5 }), rental(3, { out: 1, returned: 2 })];
  assertEquals(computeCardStatusFromBookings("start", siblings, "planned"), "complete");
});

Deno.test("start: blocked is preserved against any roll-up", () => {
  const siblings = [rental(5, { reserved: 5 })];
  assertEquals(computeCardStatusFromBookings("start", siblings, "blocked"), "blocked");
});

Deno.test("start: canceled is preserved", () => {
  const siblings = [rental(5, { out: 5 })];
  assertEquals(computeCardStatusFromBookings("start", siblings, "canceled"), "canceled");
});

Deno.test("draft is preserved on both sides — a quote's card never enters the work queue", () => {
  // A quoted order's bookings sit at `quoted`, which the start roll-up would
  // read as `planned` (pre-delivery, nothing out). The card stays `draft` until
  // the writer lets go of it when the order leaves `quoted`.
  const siblings = [rental(5, { quoted: 5 })];
  assertEquals(computeCardStatusFromBookings("start", siblings, "draft"), "draft");
  assertEquals(computeCardStatusFromBookings("end", siblings, "draft"), "draft");
  // …and the SAME siblings from `planned` still roll up, so the keep-list is
  // what decides it, not the bookings.
  assertEquals(computeCardStatusFromBookings("start", siblings, "planned"), "planned");
});

// ── end side ───────────────────────────────────────────────────────

Deno.test("end: nothing returned → planned", () => {
  const siblings = [rental(5, { reserved: 5 }), rental(3, { reserved: 3 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "planned"), "planned");
});

Deno.test("end: still_out > 0 → active even before any return", () => {
  const siblings = [rental(5, { out: 5 }), rental(3, { reserved: 3 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "planned"), "active");
});

Deno.test("end: terminal > 0 → active until all collected", () => {
  const siblings = [rental(5, { returned: 2, reserved: 3 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "planned"), "active");
});

Deno.test("end: terminal === total → complete", () => {
  const siblings = [rental(5, { returned: 5 }), rental(3, { lost: 1, damaged: 1, returned: 1 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "active"), "complete");
});

Deno.test("end: sale-only siblings → complete (no collection event)", () => {
  const siblings = [sale(2, { out: 2 }), sale(1, { out: 1 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "planned"), "complete");
});

Deno.test("end: mixed sale + rental excludes sale from roll-up", () => {
  const siblings = [sale(2, { out: 2 }), rental(3, { returned: 3 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "active"), "complete");
});

Deno.test("end: service line + rentals all returned → complete (service excluded)", () => {
  // Service lines carry a quantity but never produce an `out`/return event;
  // counting them in `total` is what pinned end cards `active` forever (#710 et al).
  const siblings = [service(1, { reserved: 1 }), rental(4, { returned: 4 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "active"), "complete");
});

Deno.test("end: surcharge line + rentals all returned → complete (surcharge excluded)", () => {
  const siblings = [surcharge(1), rental(2, { returned: 2 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "active"), "complete");
});

Deno.test("end: #866-shape — some reserved, rest returned, no out → active (do not over-complete)", () => {
  // Mid-cycle order: units never shipped sit `reserved`, so terminal < total.
  // Must stay active — order isn't done; the fix must not collapse this to complete.
  const siblings = [rental(6, { reserved: 4, returned: 2 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "active"), "active");
});

Deno.test("end: #893-shape — rental still out → active", () => {
  const siblings = [rental(3, { out: 3 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "active"), "active");
});

Deno.test("end: sale + service only (no rentals) → complete (nothing to collect)", () => {
  const siblings = [sale(2, { out: 2 }), service(1, { reserved: 1 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "planned"), "complete");
});

Deno.test("end: blocked preserved", () => {
  const siblings = [rental(5, { returned: 5 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "blocked"), "blocked");
});

// ── computeCardActionFromBookings ──────────────────────────────────

// start side
Deno.test("action start: reserved → prep", () => {
  const siblings = [rental(5, { reserved: 5 }), rental(3, { reserved: 3 })];
  assertEquals(computeCardActionFromBookings("start", siblings, "planned"), {
    source: "fulfillment",
    value: "prep",
  });
});

Deno.test("action start: prepped-only → checkout", () => {
  const siblings = [rental(5, { prepped: 5 })];
  assertEquals(computeCardActionFromBookings("start", siblings, "active"), {
    source: "fulfillment",
    value: "checkout",
  });
});

Deno.test("action start: mixed reserved + prepped → prep (still unprepped quantity)", () => {
  const siblings = [rental(5, { reserved: 2, prepped: 3 })];
  assertEquals(computeCardActionFromBookings("start", siblings, "active"), {
    source: "fulfillment",
    value: "prep",
  });
});

Deno.test("action start: fully out → null", () => {
  const siblings = [rental(5, { out: 5 }), rental(3, { out: 1, returned: 2 })];
  assertEquals(computeCardActionFromBookings("start", siblings, "active"), null);
});

Deno.test("action start: quote-only (nothing reserved/prepped) → null", () => {
  const siblings = [rental(5, { quoted: 5 })];
  assertEquals(computeCardActionFromBookings("start", siblings, "planned"), null);
});

Deno.test("action start: sale lines count (no sale filter on start) → prep", () => {
  const siblings = [sale(2, { reserved: 2 })];
  assertEquals(computeCardActionFromBookings("start", siblings, "planned"), {
    source: "fulfillment",
    value: "prep",
  });
});

// end side
Deno.test("action end: out > 0 → return", () => {
  const siblings = [rental(5, { out: 5 })];
  assertEquals(computeCardActionFromBookings("end", siblings, "active"), {
    source: "fulfillment",
    value: "return",
  });
});

Deno.test("action end: nothing out yet → null", () => {
  const siblings = [rental(5, { reserved: 5 })];
  assertEquals(computeCardActionFromBookings("end", siblings, "planned"), null);
});

Deno.test("action end: all returned → null", () => {
  const siblings = [rental(5, { returned: 5 })];
  assertEquals(computeCardActionFromBookings("end", siblings, "active"), null);
});

Deno.test("action end: sale-only out → null (sales excluded from end)", () => {
  const siblings = [sale(2, { out: 2 }), sale(1, { out: 1 })];
  assertEquals(computeCardActionFromBookings("end", siblings, "planned"), null);
});

Deno.test("action end: mixed sale(out) + rental(out) → return (rental drives)", () => {
  const siblings = [sale(2, { out: 2 }), rental(3, { out: 3 })];
  assertEquals(computeCardActionFromBookings("end", siblings, "active"), {
    source: "fulfillment",
    value: "return",
  });
});

Deno.test("action end: service/surcharge only → null (non-rental excluded from gate)", () => {
  const siblings = [service(1, { reserved: 1 }), surcharge(1)];
  assertEquals(computeCardActionFromBookings("end", siblings, "active"), null);
});

// terminal / non-actionable statuses → null on either side
for (const current of ["blocked", "canceled", "complete", "draft"] as CardStatus[]) {
  Deno.test(`action: ${current} start with reserved → null`, () => {
    const siblings = [rental(5, { reserved: 5 })];
    assertEquals(computeCardActionFromBookings("start", siblings, current), null);
  });
  Deno.test(`action: ${current} end with out → null`, () => {
    const siblings = [rental(5, { out: 5 })];
    assertEquals(computeCardActionFromBookings("end", siblings, current), null);
  });
}

// ── cardPickBucket ───────────────────────────────────────────────────

const dest = (uid: string | null) => ({ uid, address: null, instructions: null, contact: null });

Deno.test("cardPickBucket: a :start leg the customer COLLECTS is customer-collect", () => {
  assertEquals(
    cardPickBucket({ destination: dest("store0000000000000000"), fulfillments: { leg: "start", customer_collecting: true } }),
    PICK_BUCKET_CUSTOMER_COLLECT,
  );
});

Deno.test("cardPickBucket: a :start leg we DELIVER is its destination uid", () => {
  assertEquals(
    cardPickBucket({ destination: dest("dest1000000000000000"), fulfillments: { leg: "start", customer_collecting: false } }),
    "dest1000000000000000",
  );
});

Deno.test("cardPickBucket: an :end leg reads customer_RETURNING, not collecting", () => {
  // Both polarities of the end arm, so a helper that read the start flag for
  // every leg (it has none here) cannot pass.
  assertEquals(
    cardPickBucket({ destination: dest("store0000000000000000"), fulfillments: { leg: "end", customer_returning: true } }),
    PICK_BUCKET_CUSTOMER_COLLECT,
  );
  assertEquals(
    cardPickBucket({ destination: dest("dest1000000000000000"), fulfillments: { leg: "end", customer_returning: false } }),
    "dest1000000000000000",
  );
});

Deno.test("cardPickBucket: no fulfillments payload is null, never a guess from destination.uid", () => {
  assertEquals(cardPickBucket({ destination: dest("store0000000000000000") }), null);
});

Deno.test("cardPickBucket: a delivered leg with no destination uid is null", () => {
  assertEquals(cardPickBucket({ destination: dest(null), fulfillments: { leg: "start", customer_collecting: false } }), null);
  assertEquals(cardPickBucket({ destination: null, fulfillments: { leg: "start", customer_collecting: false } }), null);
});

// ── eventCardUid / parseEventCardUid ────────────────────────────────

const PAIR = "e005eda3-42f3-4dde-add2-7fb96f632984";

Deno.test("eventCardUid — fulfillment, pair, side", () => {
  assertEquals(eventCardUid("xbuHnaf17Ixrnv2YIC9E", PAIR, "end"), `xbuHnaf17Ixrnv2YIC9E:${PAIR}:end`);
});

Deno.test("parseEventCardUid — reads back what eventCardUid wrote, both sides", () => {
  for (const side of ["start", "end"] as const) {
    assertEquals(parseEventCardUid(eventCardUid("ord1", PAIR, side)), { fulfillmentUid: "ord1", pairUid: PAIR, side });
  }
});

Deno.test("parseEventCardUid — null for anything that is not an event card id", () => {
  // An address-keyed id from before the pair re-key names no leg.
  assertEquals(parseEventCardUid("ord1:vTn8CTAwwJHEJZLBzsOw:end"), null);
  assertEquals(parseEventCardUid(`ord1:${PAIR}:middle`), null);
  assertEquals(parseEventCardUid(`:${PAIR}:start`), null);
  assertEquals(parseEventCardUid(`ord1:${PAIR}:start:extra`), null);
  // A to-do card's auto-id.
  assertEquals(parseEventCardUid("Zq3kP0aLmN8rT2vW4xYz"), null);
});
