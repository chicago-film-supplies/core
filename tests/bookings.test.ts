import { assertEquals } from "@std/assert";
import {
  applyBookingBreakdownDelta,
  calculateBookingBreakdown,
  emptyBookingsBreakdown,
  isBookingClosed,
  isOrderBookingsClosed,
  mergeBookingBreakdown,
  sumBookingBreakdown,
  sumBookingsBreakdown,
} from "../src/utils/bookings.ts";
import type { Booking, OrderStatusType } from "../src/schemas/mod.ts";

const sample = (overrides: Partial<Booking["breakdown"]> = {}): Booking["breakdown"] => ({
  quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0,
  ...overrides,
});

const booking = (
  type: Booking["type"],
  breakdownOverrides: Partial<Booking["breakdown"]> = {},
): Pick<Booking, "type" | "breakdown"> => ({
  type,
  breakdown: sample(breakdownOverrides),
});

Deno.test("emptyBookingsBreakdown returns all-zero shape", () => {
  assertEquals(emptyBookingsBreakdown(), {
    quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0,
  });
});

Deno.test("sumBookingBreakdown sums seven values", () => {
  assertEquals(sumBookingBreakdown(sample({ out: 3, returned: 2 })), 5);
  assertEquals(sumBookingBreakdown(sample()), 0);
  assertEquals(
    sumBookingBreakdown({ quoted: 1, reserved: 1, prepped: 1, out: 1, returned: 1, lost: 1, damaged: 1 }),
    7,
  );
});

Deno.test("mergeBookingBreakdown applies patch over current", () => {
  const current = sample({ out: 5 });
  const merged = mergeBookingBreakdown(current, { out: 3, returned: 2 });
  assertEquals(merged.out, 3);
  assertEquals(merged.returned, 2);
  // Untouched keys preserved
  assertEquals(merged.quoted, 0);
});

Deno.test("mergeBookingBreakdown clones when patch is undefined", () => {
  const current = sample({ out: 5 });
  const merged = mergeBookingBreakdown(current, undefined);
  assertEquals(merged, current);
  assertEquals(merged === current, false); // fresh object
});

Deno.test("sumBookingsBreakdown rolls up across bookings", () => {
  const bookings = [
    { breakdown: sample({ out: 3 }) },
    { breakdown: sample({ out: 2, returned: 1 }) },
    { breakdown: sample({ damaged: 1 }) },
  ];
  assertEquals(sumBookingsBreakdown(bookings), {
    quoted: 0, reserved: 0, prepped: 0, out: 5, returned: 1, lost: 0, damaged: 1,
  });
});

Deno.test("applyBookingBreakdownDelta mutates roll-up by next - prev", () => {
  const orderRollup = { quoted: 0, reserved: 0, prepped: 0, out: 5, returned: 0, lost: 0, damaged: 0 };
  const prev = sample({ out: 5 });
  const next = sample({ out: 2, returned: 2, lost: 1 });
  applyBookingBreakdownDelta(orderRollup, prev, next);
  assertEquals(orderRollup, { quoted: 0, reserved: 0, prepped: 0, out: 2, returned: 2, lost: 1, damaged: 0 });
});

Deno.test("isBookingClosed: rental requires out === 0", () => {
  assertEquals(isBookingClosed(booking("rental", { returned: 5 })), true);
  assertEquals(isBookingClosed(booking("rental", { out: 1, returned: 4 })), false);
  assertEquals(isBookingClosed(booking("rental", { returned: 3, lost: 1, damaged: 1 })), true);
});

Deno.test("isBookingClosed: sale treats out as terminal", () => {
  assertEquals(isBookingClosed(booking("sale", { out: 5 })), true);
  assertEquals(isBookingClosed(booking("sale", { out: 3, returned: 2 })), true);
  assertEquals(isBookingClosed(booking("sale", { reserved: 1, out: 4 })), false);
});

Deno.test("isBookingClosed: service/surcharge treat out as terminal (defensive)", () => {
  assertEquals(isBookingClosed(booking("service", { out: 5 })), true);
  assertEquals(isBookingClosed(booking("surcharge", { out: 5 })), true);
});

Deno.test("isBookingClosed: any quoted/reserved/prepped blocks closure", () => {
  assertEquals(isBookingClosed(booking("rental", { quoted: 1, returned: 4 })), false);
  assertEquals(isBookingClosed(booking("rental", { reserved: 1, returned: 4 })), false);
  assertEquals(isBookingClosed(booking("rental", { prepped: 1, returned: 4 })), false);
  assertEquals(isBookingClosed(booking("sale", { quoted: 1, out: 4 })), false);
});

Deno.test("isOrderBookingsClosed: all-sale, all out → closed", () => {
  assertEquals(
    isOrderBookingsClosed([
      booking("sale", { out: 3 }),
      booking("sale", { out: 1 }),
    ]),
    true,
  );
});

Deno.test("isOrderBookingsClosed: all-rental, all out → not closed", () => {
  assertEquals(
    isOrderBookingsClosed([
      booking("rental", { out: 3 }),
      booking("rental", { out: 1 }),
    ]),
    false,
  );
});

Deno.test("isOrderBookingsClosed: mixed, sales out + rentals out → not closed", () => {
  assertEquals(
    isOrderBookingsClosed([
      booking("sale", { out: 2 }),
      booking("rental", { out: 3 }),
    ]),
    false,
  );
});

Deno.test("isOrderBookingsClosed: mixed, sales out + rentals all returned → closed", () => {
  assertEquals(
    isOrderBookingsClosed([
      booking("sale", { out: 2 }),
      booking("rental", { returned: 3 }),
      booking("rental", { returned: 2, lost: 1 }),
    ]),
    true,
  );
});

Deno.test("isOrderBookingsClosed: all-sale, mix of out + returned + damaged → closed", () => {
  assertEquals(
    isOrderBookingsClosed([
      booking("sale", { out: 2, returned: 1, damaged: 1 }),
      booking("sale", { out: 3 }),
    ]),
    true,
  );
});

Deno.test("isOrderBookingsClosed: empty bookings → false", () => {
  assertEquals(isOrderBookingsClosed([]), false);
});

Deno.test("calculateBookingBreakdown: draft/canceled → all zeros", () => {
  const prev = sample({ reserved: 5, prepped: 5 });
  assertEquals(calculateBookingBreakdown("draft", "rental", 10, prev), emptyBookingsBreakdown());
  assertEquals(calculateBookingBreakdown("canceled", "rental", 10, prev), emptyBookingsBreakdown());
});

Deno.test("calculateBookingBreakdown: quoted from fresh", () => {
  assertEquals(
    calculateBookingBreakdown("quoted", "rental", 10),
    sample({ quoted: 10 }),
  );
});

Deno.test("calculateBookingBreakdown: reserved from fresh", () => {
  assertEquals(
    calculateBookingBreakdown("reserved", "rental", 10),
    sample({ reserved: 10 }),
  );
});

Deno.test("calculateBookingBreakdown: active behaves like reserved", () => {
  assertEquals(
    calculateBookingBreakdown("active", "rental", 10),
    sample({ reserved: 10 }),
  );
});

Deno.test("calculateBookingBreakdown: quoted → reserved drops the previous quoted bucket", () => {
  // The bug fix — previously quoted=10 would persist into the reserved-state breakdown.
  const prev = sample({ quoted: 10 });
  const next = calculateBookingBreakdown("reserved", "rental", 10, prev);
  assertEquals(next, sample({ reserved: 10 }));
  assertEquals(sumBookingBreakdown(next), 10);
});

Deno.test("calculateBookingBreakdown: reserved → quoted drops the previous reserved bucket", () => {
  const prev = sample({ reserved: 10 });
  const next = calculateBookingBreakdown("quoted", "rental", 10, prev);
  assertEquals(next, sample({ quoted: 10 }));
});

Deno.test("calculateBookingBreakdown: reserved preserves in-flight progress", () => {
  const prev = sample({ reserved: 0, prepped: 3, out: 2, returned: 1, lost: 1, damaged: 1 });
  const next = calculateBookingBreakdown("reserved", "rental", 10, prev);
  assertEquals(next, {
    quoted: 0, reserved: 2, prepped: 3, out: 2, returned: 1, lost: 1, damaged: 1,
  });
  assertEquals(sumBookingBreakdown(next), 10);
});

Deno.test("calculateBookingBreakdown: complete rental → returned + lost + damaged sum to quantity", () => {
  const prev = sample({ out: 8, lost: 1, damaged: 1 });
  const next = calculateBookingBreakdown("complete", "rental", 10, prev);
  assertEquals(next, sample({ returned: 8, lost: 1, damaged: 1 }));
  assertEquals(sumBookingBreakdown(next), 10);
});

Deno.test("calculateBookingBreakdown: complete sale → all qty in out", () => {
  const prev = sample({ reserved: 5 });
  const next = calculateBookingBreakdown("complete", "sale", 5, prev);
  assertEquals(next, sample({ out: 5 }));
});

Deno.test("calculateBookingBreakdown: complete service/surcharge → all zeros, NOT quantity", () => {
  // Load-bearing, and until this test existed nothing pinned it despite ~439
  // prod bookings riding the branch. `complete-stale-bookings.ts` computes
  // `expectedSum = isService ? 0 : quantity` and THROWS when the projection
  // disagrees — so a `complete` arm that gave service the rental or sale
  // treatment would brick that script on every service booking.
  const prev = sample({ reserved: 4 });
  assertEquals(calculateBookingBreakdown("complete", "service", 4, prev), emptyBookingsBreakdown());
  assertEquals(calculateBookingBreakdown("complete", "surcharge", 4, prev), emptyBookingsBreakdown());
  assertEquals(sumBookingBreakdown(calculateBookingBreakdown("complete", "service", 4, prev)), 0);
});

Deno.test("calculateBookingBreakdown: an out-of-vocabulary status returns zeros, never undefined", () => {
  // `template-helpers.generated.ts` exposes this to Eta templates, which pass
  // runtime-unchecked arguments — so the lookup is indexed defensively. The cast
  // is the point of the test: it reproduces what an Eta caller can actually do.
  const bogus = "part-prepped" as OrderStatusType; // a BOOKING status, not an order one
  assertEquals(calculateBookingBreakdown(bogus, "rental", 10, sample({ reserved: 10 })), emptyBookingsBreakdown());
});

Deno.test("calculateBookingBreakdown: each call returns a fresh object", () => {
  // `applyBookingBreakdownDelta` mutates its target in place, so a shared frozen
  // `base` behind the zero-returning arms would be a cross-booking aliasing bug.
  const a = calculateBookingBreakdown("draft", "rental", 10);
  const b = calculateBookingBreakdown("draft", "rental", 10);
  assertEquals(a, b);
  a.reserved = 99;
  assertEquals(b.reserved, 0);
});

Deno.test("calculateBookingBreakdown: repairs corrupt double-bucket from buggy webhook", () => {
  // Real-world corrupt state: quantity=30 but breakdown sums to 60 because
  // a quoted→reserved transition left both buckets populated.
  const corrupt = sample({ quoted: 30, reserved: 30 });
  assertEquals(sumBookingBreakdown(corrupt), 60);

  const repaired = calculateBookingBreakdown("reserved", "rental", 30, corrupt);
  assertEquals(repaired, sample({ reserved: 30 }));
  assertEquals(sumBookingBreakdown(repaired), 30);
});
