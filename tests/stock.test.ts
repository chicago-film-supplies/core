/**
 * The stock primitives, and above all the property that the two consumption
 * definitions **must not agree**.
 *
 * The headline test here is deliberately shaped as a DISAGREEMENT assertion
 * rather than as two independent value checks. The defect this module exists to
 * prevent is someone noticing that `heldByBooking` and `unitsClaimedOnShelves`
 * both sum a booking's breakdown and "single-sourcing" them — which compiles,
 * passes every value test written about either one alone, and silently makes the
 * allocator under-net for rentals (two pickers, one unit) or availability
 * double-subtract a sale. Asserting that they diverge on a specific booking is
 * the only shape that fails on that refactor.
 */
import { assert, assertEquals } from "@std/assert";

import {
  boundMs,
  bookingHoldsStock,
  heldByBooking,
  intervalsOverlap,
  oosConsumes,
  TERMINAL_OOS_STATUSES,
  unitsClaimedOnShelves,
} from "../src/utils/stock.ts";
import type { BookingBreakdown, ComponentTypeType } from "../src/schemas/mod.ts";

function bd(p: Partial<BookingBreakdown> = {}): BookingBreakdown {
  return {
    quoted: 0,
    reserved: 0,
    prepped: 0,
    out: 0,
    returned: 0,
    lost: 0,
    damaged: 0,
    ...p,
  } as BookingBreakdown;
}

const booking = (type: ComponentTypeType, b: Partial<BookingBreakdown>) => ({
  type,
  breakdown: bd(b),
});

Deno.test("heldByBooking: reserved + prepped, plus out for a rental", () => {
  assertEquals(heldByBooking(booking("rental", { reserved: 2, prepped: 1, out: 3 })), 6);
  // quoted and the terminal buckets never count
  assertEquals(
    heldByBooking(booking("rental", { quoted: 9, returned: 4, lost: 2, damaged: 1 })),
    0,
  );
});

Deno.test("heldByBooking: a SALE's out units are excluded — the movement already dropped quantity_held", () => {
  assertEquals(heldByBooking(booking("sale", { reserved: 2, prepped: 1, out: 3 })), 3);
  // …and only `out` is excluded, never the whole entry: 5 sold, 2 checked out,
  // the other 3 must keep consuming or they are handed back as available.
  assertEquals(heldByBooking(booking("sale", { reserved: 3, out: 2 })), 3);
});

Deno.test("unitsClaimedOnShelves: type-blind, and always includes out", () => {
  assertEquals(unitsClaimedOnShelves(booking("rental", { reserved: 2, prepped: 1, out: 3 })), 6);
  assertEquals(unitsClaimedOnShelves(booking("sale", { reserved: 2, prepped: 1, out: 3 })), 6);
});

Deno.test("⚠️ the two definitions DISAGREE on a fully-out sale — do not unify them", () => {
  // The exact booking that separates them. If this ever passes with the two
  // equal, someone has merged them and one of the two consumers is now wrong.
  const fullyOutSale = booking("sale", { out: 4 });

  assertEquals(heldByBooking(fullyOutSale), 0, "availability: the sale already dropped quantity_held");
  assertEquals(unitsClaimedOnShelves(fullyOutSale), 4, "allocator: the gate is type-blind");
  assert(
    heldByBooking(fullyOutSale) !== unitsClaimedOnShelves(fullyOutSale),
    "heldByBooking and unitsClaimedOnShelves must NOT agree — they are subtracted " +
      "from different denominators (quantity_held vs store_breakdown). See utils/stock.ts.",
  );

  // They agree wherever `out` is 0 or the booking is a rental, which is why the
  // divergence is easy to miss: it needs BOTH a sale AND checked-out units.
  for (
    const b of [
      booking("rental", { reserved: 2, prepped: 1, out: 3 }),
      booking("sale", { reserved: 2, prepped: 1 }),
    ]
  ) {
    assertEquals(heldByBooking(b), unitsClaimedOnShelves(b));
  }
});

Deno.test("bookingHoldsStock: the shelf-side liveness gate", () => {
  assert(bookingHoldsStock(booking("rental", { reserved: 1 })));
  assert(bookingHoldsStock(booking("sale", { out: 1 })), "a fully-out sale is still physically live");
  assert(!bookingHoldsStock(booking("rental", { quoted: 5, returned: 3, lost: 1 })));
});

Deno.test("oosConsumes: FULL quantity until terminal, never reduced by returned_to_service", () => {
  assertEquals(oosConsumes({ status: "active", quantity: 5 }), 5);
  assertEquals(oosConsumes({ status: "draft", quantity: 5 }), 5);
  assertEquals(oosConsumes({ status: "planned", quantity: 5 }), 5);
  assertEquals(oosConsumes({ status: "blocked", quantity: 5 }), 5);
  assertEquals(oosConsumes({ status: "complete", quantity: 5 }), 0);
  assertEquals(oosConsumes({ status: "canceled", quantity: 5 }), 0);

  // The trap, stated as a test: a 5-unit record with 3 returned to service still
  // holds 5. Reducing from `breakdown.returned_to_service` looks like a cleanup
  // and is a live oversell — so the function takes no breakdown at all, and this
  // asserts the resulting number rather than the absence of a parameter.
  assertEquals(
    oosConsumes({ status: "active", quantity: 5, breakdown: { returned_to_service: 3 } } as never),
    5,
  );

  assertEquals([...TERMINAL_OOS_STATUSES].sort(), ["canceled", "complete"]);
});

Deno.test("intervalsOverlap: a null bound is open-ended, not a point", () => {
  const W0 = 1_000, W1 = 2_000;

  assert(intervalsOverlap(1_500, 1_600, W0, W1), "wholly inside");
  assert(intervalsOverlap(500, 1_500, W0, W1), "straddles the start");
  assert(intervalsOverlap(1_500, 2_500, W0, W1), "straddles the end");
  assert(intervalsOverlap(500, 2_500, W0, W1), "encloses");
  assert(!intervalsOverlap(2_500, 3_000, W0, W1), "wholly after");
  assert(!intervalsOverlap(100, 900, W0, W1), "wholly before");

  // Touching counts — an interval ending exactly at the window start overlaps.
  assert(intervalsOverlap(500, W0, W0, W1));
  assert(intervalsOverlap(W1, 3_000, W0, W1));

  // The load-bearing case: a pending SALE has no end date. It must consume in
  // every window after its sale date, forever, or the units are handed back the
  // day after the sale.
  assert(intervalsOverlap(500, null, W0, W1), "open-ended end = +infinity");
  assert(intervalsOverlap(500, null, 9_000_000, 9_000_001), "…including far-future windows");
  assert(!intervalsOverlap(5_000, null, W0, W1), "but not before it starts");

  assert(intervalsOverlap(null, 1_500, W0, W1), "open-ended start = -infinity");
  assert(intervalsOverlap(null, null, W0, W1), "open on both sides always overlaps");
});

Deno.test("boundMs: prefers the _fs twin, falls back to the ISO string, else null", () => {
  const fs = { toMillis: () => 12_345 } as never;
  assertEquals(boundMs(fs, "2026-08-13T00:00:00.000-05:00"), 12_345, "_fs wins");
  assertEquals(boundMs(null, "2026-08-13T00:00:00.000-05:00"), Date.parse("2026-08-13T00:00:00.000-05:00"));
  assertEquals(boundMs(null, null), null);
  assertEquals(boundMs(null, "not a date"), null, "an unparseable ISO is open-ended, not NaN");
  // A write-time sentinel is not a Timestamp — it has no toMillis, so it must
  // fall through to the ISO twin rather than throwing.
  assertEquals(boundMs({ isEqual: () => false } as never, "2026-08-13T00:00:00.000-05:00"), Date.parse("2026-08-13T00:00:00.000-05:00"));
});
