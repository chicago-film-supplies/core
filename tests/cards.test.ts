import { assertEquals } from "@std/assert";
import {
  computeCardActionFromBookings,
  computeCardStatusFromBookings,
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
