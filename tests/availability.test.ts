import { assertEquals } from "@std/assert";
import {
  computeAvailability,
  computePublicAvailability,
  toPublicStockSummary,
} from "../src/utils/availability.ts";
import { toChicagoEndOfDay, toChicagoStartOfDay } from "../src/utils/dates.ts";
import type { StockSummary, StockSummaryBookingEntry } from "../src/schemas/mod.ts";
import { mockTimestamp, tsAt } from "./helpers/timestamp.ts";

const PRODUCT = "testprod100000000000";
const bid = (n: number) =>
  `testorder1000000000${n}:testprod100000000000:testdest100000000000`;

/** A booking entry holding `held` units over [start, end]. `end: null` = open-ended. */
function booking(
  n: number,
  start: string | null,
  end: string | null,
  held: number,
  extra: Partial<StockSummaryBookingEntry["breakdown"]> = {},
  type: StockSummaryBookingEntry["type"] = "rental",
): StockSummaryBookingEntry {
  return {
    uid: bid(n),
    number: n,
    type,
    start,
    start_fs: start ? tsAt(start) : null,
    end,
    end_fs: end ? tsAt(end) : null,
    breakdown: {
      quoted: 0,
      reserved: held,
      prepped: 0,
      out: 0,
      returned: 0,
      lost: 0,
      damaged: 0,
      ...extra,
    },
  };
}

function oos(
  uid: string,
  start: string | null,
  end: string | null,
  quantity: number,
  status: StockSummary["out_of_service"][number]["status"] = "active",
): StockSummary["out_of_service"][number] {
  return {
    uid,
    start,
    start_fs: start ? tsAt(start) : null,
    end,
    end_fs: end ? tsAt(end) : null,
    quantity,
    reason: "damaged",
    status,
  };
}

function summary(
  quantity_held: number,
  bookings: StockSummary["bookings"] = [],
  out_of_service: StockSummary["out_of_service"] = [],
): StockSummary {
  return {
    uid: PRODUCT,
    uid_product: PRODUCT,
    type: "rental",
    quantity_held,
    bookings,
    out_of_service,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  };
}

/** A Chicago-anchored day boundary, the form a caller actually passes. */
const day = (d: string) => toChicagoStartOfDay(d + "T12:00:00.000-06:00");

// ── The load-bearing case: intervals do not decompose to a daily curve ──

Deno.test("computeAvailability: a span is NOT the min over its days", () => {
  // held = 2. One booking occupies a unit on days 1–2, another on days 4–5.
  // Per-day, one unit is free every day, so a min-over-days curve would answer 1.
  // But no SINGLE unit is free for the whole span [1,5] — the true answer is 0.
  // Answering 1 here would oversell. This is why the doc stores intervals and the
  // engine must never be "optimized" into a per-day rollup.
  const s = summary(2, [
    booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-02T12:00:00.000-05:00"), 1),
    booking(2, day("2026-06-04"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 1),
  ]);

  const span = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(span.quantity_booked, 2);
  assertEquals(span.quantity_available, 0);

  // ...and each individual day really does have one unit free, which is what
  // makes the naive decomposition so tempting.
  const d1 = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-01") });
  assertEquals(d1.quantity_available, 1);
  const d3 = computeAvailability(s, { start: day("2026-06-03"), end: day("2026-06-03") });
  assertEquals(d3.quantity_available, 2);
});

// ── Overlap semantics ────────────────────────────────────────────

Deno.test("computeAvailability: a booking outside the window is ignored", () => {
  const s = summary(5, [
    booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-02T12:00:00.000-05:00"), 3),
  ]);
  const after = computeAvailability(s, { start: day("2026-06-10"), end: day("2026-06-12") });
  assertEquals(after.quantity_booked, 0);
  assertEquals(after.quantity_available, 5);
  assertEquals(after.bookings.length, 0);
});

Deno.test("computeAvailability: a booking touching the window edge overlaps", () => {
  const s = summary(5, [
    booking(1, day("2026-06-05"), toChicagoEndOfDay("2026-06-10T12:00:00.000-05:00"), 3),
  ]);
  // Window ends the very day the booking starts.
  const edge = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(edge.quantity_booked, 3);
  assertEquals(edge.quantity_available, 2);
});

Deno.test("computeAvailability: a booking ending 23:00 Chicago still overlaps that day", () => {
  // The window's end is normalized to 23:59:59.999 Chicago, so a booking that
  // ends late on the final day must still be counted.
  const s = summary(5, [
    booking(1, day("2026-06-01"), "2026-06-05T23:00:00.000-05:00", 2),
  ]);
  const w = computeAvailability(s, { start: day("2026-06-05"), end: day("2026-06-05") });
  assertEquals(w.quantity_booked, 2);
});

// ── The sale case: an open-ended booking never gives its units back ──

Deno.test("computeAvailability: an open-ended (sale) booking blocks every later window", () => {
  // A pending sale booking has end: null — the unit walks out the door and does
  // not come back. It must keep consuming stock in windows AFTER its sale date,
  // until the booking completes and an operator's `sale` transaction drops
  // quantity_held. Collapsing end:null to a point (end = start) would hand the
  // unit back as "available" the day after the sale — a live oversell.
  const s = summary(3, [booking(1, day("2026-06-05"), null, 1)]);

  const onSaleDay = computeAvailability(s, { start: day("2026-06-05"), end: day("2026-06-05") });
  assertEquals(onSaleDay.quantity_available, 2);

  const longAfter = computeAvailability(s, { start: day("2026-09-20"), end: day("2026-09-25") });
  assertEquals(longAfter.quantity_booked, 1);
  assertEquals(longAfter.quantity_available, 2, "the sold unit must NOT come back");

  // Before the sale date, though, the unit is still on the shelf.
  const before = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-02") });
  assertEquals(before.quantity_available, 3);
});

Deno.test("computeAvailability: a null start is open-ended backwards", () => {
  const s = summary(4, [booking(1, null, toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 2)]);
  const early = computeAvailability(s, { start: day("2020-01-01"), end: day("2020-01-02") });
  assertEquals(early.quantity_booked, 2);
});

// ── Out of service ───────────────────────────────────────────────

Deno.test("computeAvailability: an open-ended OOS record reduces every later window", () => {
  const s = summary(10, [], [oos("testoos1000000000000", day("2026-06-01"), null, 3)]);
  const w = computeAvailability(s, { start: day("2026-08-01"), end: day("2026-08-05") });
  assertEquals(w.quantity_out_of_service, 3);
  assertEquals(w.quantity_in_service, 7);
  assertEquals(w.quantity_available, 7);
  assertEquals(w.out_of_service_breakdown.damaged, 3);
});

Deno.test("computeAvailability: terminal OOS records hold no units", () => {
  const s = summary(10, [], [
    oos("testoos1000000000000", day("2026-06-01"), null, 3, "complete"),
    oos("testoos2000000000000", day("2026-06-01"), null, 4, "canceled"),
    oos("testoos3000000000000", day("2026-06-01"), null, 1, "active"),
  ]);
  const w = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(w.quantity_out_of_service, 1);
  assertEquals(w.quantity_available, 9);
});

Deno.test("computeAvailability: bookings and OOS both subtract", () => {
  const s = summary(
    10,
    [booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 4)],
    [oos("testoos1000000000000", day("2026-06-02"), null, 3)],
  );
  const w = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(w.quantity_booked, 4);
  assertEquals(w.quantity_out_of_service, 3);
  assertEquals(w.quantity_available, 3);
});

// ── quantity_booked definition ───────────────────────────────────

Deno.test("computeAvailability: only reserved+prepped+out hold stock", () => {
  // `quoted` has claimed nothing; returned/lost/damaged have already given the
  // units back or written them off.
  const s = summary(10, [
    booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 0, {
      quoted: 5,
      reserved: 1,
      prepped: 1,
      out: 1,
      returned: 2,
      lost: 1,
      damaged: 1,
    }),
  ]);
  const w = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(w.quantity_booked, 3, "reserved 1 + prepped 1 + out 1");
  assertEquals(w.quantity_available, 7);
  assertEquals(w.bookings_breakdown.quoted, 5, "the full breakdown is still reported");
  assertEquals(w.bookings_breakdown.returned, 2);
});

// ── Degenerate + edge inputs ─────────────────────────────────────

Deno.test("computeAvailability: an empty summary is fully available", () => {
  const w = computeAvailability(summary(7), { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(w.quantity_available, 7);
  assertEquals(w.quantity_booked, 0);
  assertEquals(w.quantity_out_of_service, 0);
});

Deno.test("computeAvailability: overbooking stays negative, never clamped", () => {
  // An oversold product must remain visibly oversold.
  const s = summary(2, [
    booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 3),
    booking(2, day("2026-06-02"), toChicagoEndOfDay("2026-06-03T12:00:00.000-05:00"), 2),
  ]);
  const w = computeAvailability(s, { start: day("2026-06-01"), end: day("2026-06-05") });
  assertEquals(w.quantity_booked, 5);
  assertEquals(w.quantity_available, -3);
});

// ── Chicago wall clock: the answer must not depend on the caller's offset ──

Deno.test("computeAvailability: identical numbers from California, UTC and Chicago", () => {
  const s = summary(5, [
    booking(1, day("2026-06-03"), toChicagoEndOfDay("2026-06-04T12:00:00.000-05:00"), 2),
  ]);

  // The same two Chicago calendar days, spelled from three different offsets.
  // June 1 in Chicago starts at 05:00Z / 22:00 (May 31) Pacific.
  const chicago = computeAvailability(s, {
    start: "2026-06-01T00:00:00.000-05:00",
    end: "2026-06-05T00:00:00.000-05:00",
  });
  const utc = computeAvailability(s, {
    start: "2026-06-01T05:00:00.000Z",
    end: "2026-06-05T05:00:00.000Z",
  });
  const california = computeAvailability(s, {
    start: "2026-05-31T22:00:00.000-07:00",
    end: "2026-06-04T22:00:00.000-07:00",
  });

  assertEquals(chicago.quantity_available, 3);
  assertEquals(utc.quantity_available, chicago.quantity_available);
  assertEquals(california.quantity_available, chicago.quantity_available);
  assertEquals(utc.quantity_booked, chicago.quantity_booked);
  assertEquals(california.quantity_booked, chicago.quantity_booked);
});

// ── The public projection ────────────────────────────────────────

Deno.test("toPublicStockSummary: merges bookings + OOS into one anonymous list", () => {
  const s = summary(
    10,
    [booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 4)],
    [oos("testoos1000000000000", day("2026-06-02"), null, 3)],
  );
  const pub = toPublicStockSummary(s);

  assertEquals(pub.uid, PRODUCT);
  assertEquals(pub.quantity_held, 10);
  assertEquals(pub.unavailable.length, 2);
  assertEquals(pub.unavailable.map((u) => u.quantity).sort(), [3, 4]);
  // Nothing identifying survives the projection.
  for (const u of pub.unavailable) {
    assertEquals("uid" in u, false);
    assertEquals("reason" in u, false);
    assertEquals("number" in u, false);
  }
});

Deno.test("toPublicStockSummary: drops entries that consume no stock", () => {
  // A quoted-only booking holds nothing — publishing it would leak the existence
  // of a booking while changing no answer.
  const s = summary(10, [
    booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 0, {
      quoted: 4,
    }),
  ], [
    oos("testoos1000000000000", day("2026-06-01"), null, 2, "complete"),
  ]);
  assertEquals(toPublicStockSummary(s).unavailable, []);
});

Deno.test("computePublicAvailability agrees with computeAvailability exactly", () => {
  const s = summary(
    10,
    [
      booking(1, day("2026-06-01"), toChicagoEndOfDay("2026-06-05T12:00:00.000-05:00"), 4),
      booking(2, day("2026-06-20"), null, 1), // an open-ended sale
      booking(3, day("2026-06-02"), toChicagoEndOfDay("2026-06-03T12:00:00.000-05:00"), 0, {
        quoted: 9,
      }),
    ],
    [oos("testoos1000000000000", day("2026-06-02"), null, 3)],
  );

  for (
    const w of [
      { start: day("2026-06-01"), end: day("2026-06-05") },
      { start: day("2026-06-25"), end: day("2026-06-26") },
      { start: day("2026-01-01"), end: day("2026-01-02") },
    ]
  ) {
    const priv = computeAvailability(s, w);
    const pub = computePublicAvailability(toPublicStockSummary(s), w);
    assertEquals(
      pub.quantity_available,
      priv.quantity_available,
      "public and internal answers must never diverge for window " + w.start,
    );
    assertEquals(pub.quantity_unavailable, priv.quantity_booked + priv.quantity_out_of_service);
  }
});

// ── Sale bookings: `out` has already left ownership ───────────────

Deno.test("a sale booking's `out` units do not consume stock a second time", () => {
  // At sale_out the movement drops quantity_held. Counting the booking's `out`
  // as well would subtract the same units twice.
  const rental = summary(10, [booking(1, day("2026-06-01"), null, 0, { out: 4 }, "rental")]);
  const sale = summary(10, [booking(1, day("2026-06-01"), null, 0, { out: 4 }, "sale")]);
  const w = { start: day("2026-06-10"), end: day("2026-06-12") };

  assertEquals(computeAvailability(rental, w).quantity_booked, 4, "a rental's out still consumes");
  assertEquals(computeAvailability(sale, w).quantity_booked, 0, "a sale's out does not");
  // held already dropped by 4 for the sale, so 6 remain — not 10.
  assertEquals(computeAvailability(sale, w).quantity_available, 10, "held is the caller's input");
});

Deno.test("a partially checked-out sale booking still consumes for the rest", () => {
  // The load-bearing case: excluding the whole ENTRY (rather than `out` alone)
  // would stop counting the 3 still reserved and oversell the remainder.
  const s = summary(10, [
    booking(1, day("2026-06-01"), null, 0, { reserved: 3, out: 2 }, "sale"),
  ]);
  const w = computeAvailability(s, { start: day("2026-06-10"), end: day("2026-06-12") });
  assertEquals(w.quantity_booked, 3, "reserved 3 still held; out 2 already sold");
  assertEquals(w.quantity_available, 7);
});

Deno.test("a sale booking's units are not handed back before the sale lands", () => {
  // Before check-out the units sit in reserved/prepped and must consume in full.
  const s = summary(5, [
    booking(1, day("2026-06-01"), null, 0, { reserved: 2, prepped: 3 }, "sale"),
  ]);
  const w = computeAvailability(s, { start: day("2026-06-10"), end: day("2026-06-12") });
  assertEquals(w.quantity_booked, 5);
  assertEquals(w.quantity_available, 0, "nothing free until the sale actually moves them");
});

Deno.test("the full breakdown is still reported for a sale booking", () => {
  // Only quantity_booked changes — the entry stays in the summary and its
  // breakdown is reported verbatim, so the picker still sees the `out` units.
  const s = summary(10, [booking(1, day("2026-06-01"), null, 0, { reserved: 1, out: 4 }, "sale")]);
  const w = computeAvailability(s, { start: day("2026-06-10"), end: day("2026-06-12") });
  assertEquals(w.bookings_breakdown.out, 4);
  assertEquals(w.bookings.length, 1);
});

Deno.test("toPublicStockSummary applies the same sale rule as computeAvailability", () => {
  // Two engines, one rule — the storefront and the manager cannot disagree.
  const s = summary(10, [
    booking(1, day("2026-06-01"), null, 0, { reserved: 3, out: 2 }, "sale"),
  ]);
  const pub = toPublicStockSummary(s);
  assertEquals(pub.unavailable.length, 1);
  assertEquals(pub.unavailable[0].quantity, 3, "the same 3 computeAvailability counts");
});

Deno.test("a fully checked-out sale booking leaks nothing to the storefront", () => {
  const s = summary(10, [booking(1, day("2026-06-01"), null, 0, { out: 4 }, "sale")]);
  assertEquals(toPublicStockSummary(s).unavailable.length, 0, "zero-quantity entries are dropped");
});
