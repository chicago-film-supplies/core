import { assertEquals } from "@std/assert";
import { computeCardStatusFromBookings, type CardSiblingBooking } from "../src/cards.ts";
import type { Booking } from "@cfs/schemas";

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

Deno.test("end: blocked preserved", () => {
  const siblings = [rental(5, { returned: 5 })];
  assertEquals(computeCardStatusFromBookings("end", siblings, "blocked"), "blocked");
});
