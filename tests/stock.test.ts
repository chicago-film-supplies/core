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
  type AvailabilityWindow,
  boundMs,
  bookingHoldsStock,
  computeStockAvailability,
  heldByBooking,
  intervalsOverlap,
  oosConsumes,
  peakStockConsumption,
  type StockBookingSource,
  type StockOOSSource,
  TERMINAL_OOS_STATUSES,
  unavailableFromBooking,
  unavailableFromOOS,
  unitsClaimedOnShelves,
} from "../src/utils/stock.ts";
import type {
  BookingBreakdown,
  ComponentTypeType,
  StockUnavailableEntry,
} from "../src/schemas/mod.ts";

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

// ── The reducers: source document → pre-reduced interval ────────────────────

const D1 = "2026-06-01T00:00:00.000-05:00";
const D3 = "2026-06-03T00:00:00.000-05:00";
const D5 = "2026-06-05T00:00:00.000-05:00";

const src = (
  type: ComponentTypeType,
  b: Partial<BookingBreakdown>,
  status: StockBookingSource["status"] = "reserved",
  dates: StockBookingSource["dates"] = { start: D1, end: D5 },
): StockBookingSource => ({ type, breakdown: bd(b), status, dates });

Deno.test("unavailableFromBooking: one null covers BOTH exits — not live, and holds nothing", () => {
  assertEquals(
    unavailableFromBooking(src("rental", { reserved: 2 }, "complete")),
    null,
    "a completed booking has left the live set",
  );
  assertEquals(
    unavailableFromBooking(src("rental", { quoted: 9 })),
    null,
    "a quoted booking is live but holds no units",
  );
  assertEquals(
    unavailableFromBooking(src("sale", { out: 4 })),
    null,
    "a fully-out SALE consumes nothing — the sale movement already dropped quantity_held",
  );

  assertEquals(unavailableFromBooking(src("rental", { reserved: 2, out: 3 })), {
    start: D1,
    end: D5,
    quantity: 5,
    kind: "booking",
  });
});

Deno.test("⚠️ unavailableFromBooking carries the sale rule — the same booking reduces differently by type", () => {
  // The one shape that separates them, mirrored from the disagreement test
  // above: identical breakdowns, different `type`, different stored quantity.
  // Availability's answer must follow `heldByBooking`, never the shelf gate.
  const b = { reserved: 1, out: 3 };
  assertEquals(unavailableFromBooking(src("rental", b))?.quantity, 4);
  assertEquals(unavailableFromBooking(src("sale", b))?.quantity, 1);
});

Deno.test("unavailableFromBooking: a null bound is preserved, never coerced to a point", () => {
  // A pending sale has no end date. Coercing `end: null` to `end = start` hands
  // the units back as available the day after the sale — a live oversell.
  const pendingSale = unavailableFromBooking(
    src("sale", { reserved: 2 }, "reserved", { start: D1, end: null }),
  );
  assertEquals(pendingSale, { start: D1, end: null, quantity: 2, kind: "booking" });
});

Deno.test("unavailableFromOOS: FULL quantity until terminal, and no breakdown reaches it", () => {
  assertEquals(unavailableFromOOS({ status: "active", quantity: 5, dates: { start: D1, end: D5 } }), {
    start: D1,
    end: D5,
    quantity: 5,
    kind: "oos",
  });
  for (const status of ["complete", "canceled"] as const) {
    assertEquals(
      unavailableFromOOS({ status, quantity: 5, dates: { start: D1, end: D5 } }),
      null,
      `${status} holds no units`,
    );
  }
  // The oversell trap again, at the reducer: 5 out of service with 3 returned to
  // service still claims 5. `StockOOSSource` has no `breakdown` field at all, so
  // this asserts the number rather than the absence of a parameter.
  assertEquals(
    unavailableFromOOS(
      { status: "active", quantity: 5, breakdown: { returned_to_service: 3 }, dates: { start: D1, end: D5 } } as never,
    )?.quantity,
    5,
  );
});

// ── The fold ───────────────────────────────────────────────────────────────

const stock = (quantity_held: number, unavailable: StockUnavailableEntry[]) => ({
  quantity_held,
  unavailable,
});

const iv = (
  start: string | null,
  end: string | null,
  quantity: number,
  kind: StockUnavailableEntry["kind"] = "booking",
): StockUnavailableEntry => ({ start, end, quantity, kind });

/** A whole Chicago day, the form a caller actually passes. */
const win = (start: string, end: string): AvailabilityWindow => ({
  start: start + "T12:00:00.000-05:00",
  end: end + "T12:00:00.000-05:00",
});

Deno.test("computeStockAvailability: a span is NOT the min over its days", () => {
  // held = 2, one unit occupied on days 1–2 and another on days 4–5. Per day one
  // unit is free, so a min-over-days curve answers 1 — but no SINGLE unit is free
  // for the whole span, and the true answer is 0. Answering 1 oversells. This is
  // the reason the document stores intervals and the fold filters by overlap.
  const s = stock(2, [
    iv("2026-06-01T00:00:00.000-05:00", "2026-06-02T23:59:59.999-05:00", 1),
    iv("2026-06-04T00:00:00.000-05:00", "2026-06-05T23:59:59.999-05:00", 1),
  ]);
  assertEquals(computeStockAvailability(s, win("2026-06-01", "2026-06-05")).quantity_available, 0);
  // …and each sub-window still answers 1, which is what makes the daily curve tempting.
  assertEquals(computeStockAvailability(s, win("2026-06-01", "2026-06-02")).quantity_available, 1);
  assertEquals(computeStockAvailability(s, win("2026-06-04", "2026-06-05")).quantity_available, 1);
});

Deno.test("computeStockAvailability: `kind` splits the two counts, and only overlaps count", () => {
  const s = stock(10, [
    iv(D1, D5, 3, "booking"),
    iv(D1, D5, 2, "oos"),
    iv("2026-09-01T00:00:00.000-05:00", "2026-09-05T00:00:00.000-05:00", 6, "booking"),
  ]);
  assertEquals(computeStockAvailability(s, win("2026-06-01", "2026-06-05")), {
    quantity_held: 10,
    quantity_booked: 3,
    quantity_out_of_service: 2,
    quantity_available: 5,
  });
});

Deno.test("computeStockAvailability: an oversell stays visibly negative, never clamped", () => {
  const s = stock(2, [iv(D1, D5, 5)]);
  assertEquals(computeStockAvailability(s, win("2026-06-01", "2026-06-05")).quantity_available, -3);
});

Deno.test("computeStockAvailability: the window is Chicago wall clock whoever asks", () => {
  const s = stock(2, [iv(D1, D5, 1)]);
  const answers = [
    computeStockAvailability(s, { start: "2026-06-01T00:00:00.000-08:00", end: "2026-06-05T23:00:00.000-08:00" }),
    computeStockAvailability(s, { start: "2026-06-01T12:00:00.000Z", end: "2026-06-05T12:00:00.000Z" }),
    computeStockAvailability(s, win("2026-06-01", "2026-06-05")),
  ];
  for (const a of answers) assertEquals(a, answers[0]);
});

// ── The peak instant ────────────────────────────────────────────────────────

Deno.test("⚠️ peakStockConsumption is NOT the worst window — the inequality runs the other way", () => {
  // The same fixture that forbids a per-day rollup, read the other direction.
  // Window [1,5] sums BOTH bookings because both overlap it, and answers 0 —
  // correct, because no single unit is free for the whole span. The peak sums
  // only what is live at one instant, and answers 1 — also correct, because the
  // shop never has more than one unit out at a time.
  //
  // Asserting the two DIFFER is the point: this is what fails if someone
  // "simplifies" the peak into `computeStockAvailability` over the widest window,
  // which would report every busy product as physically oversold.
  const s = stock(2, [
    iv("2026-06-01T00:00:00.000-05:00", "2026-06-02T23:59:59.999-05:00", 1),
    iv("2026-06-04T00:00:00.000-05:00", "2026-06-05T23:59:59.999-05:00", 1),
  ]);
  assertEquals(computeStockAvailability(s, win("2026-06-01", "2026-06-05")).quantity_available, 0);
  assertEquals(peakStockConsumption(s).quantity_available, 1);
});

Deno.test("peakStockConsumption: the peak is the overlap, and `since` names where it opens", () => {
  const s = stock(10, [
    iv(D1, D5, 3, "booking"),
    // Opens on D3, inside the first — 3 + 4 = 7 out at once from D3.
    iv(D3, D5, 4, "booking"),
    iv(D3, D5, 2, "oos"),
  ]);
  assertEquals(peakStockConsumption(s), {
    quantity_held: 10,
    quantity_booked: 7,
    quantity_out_of_service: 2,
    quantity_available: 1,
    since: D3,
  });
});

Deno.test("peakStockConsumption: a physical oversell is negative, and that is the alert", () => {
  const s = stock(2, [iv(D1, D5, 5)]);
  const peak = peakStockConsumption(s);
  assertEquals(peak.quantity_available, -3);
  assertEquals(peak.since, D1);
});

Deno.test("peakStockConsumption: an open-ended entry carries the peak, and `since` is null for it", () => {
  // A pending SALE — `end: null`, no start either once it is open on both sides.
  // The peak is reached before any dated entry opens, so there is no ISO to name.
  const s = stock(4, [iv(null, null, 5, "booking")]);
  assertEquals(peakStockConsumption(s), {
    quantity_held: 4,
    quantity_booked: 5,
    quantity_out_of_service: 0,
    quantity_available: -1,
    since: null,
  });
});

Deno.test("peakStockConsumption: an open-ended sale keeps consuming AFTER its start", () => {
  // `end: null` is +∞, so the sale is live at every later entry's start too — the
  // peak must be 3 + 2, not 3. Collapsing a null end to a point would answer 3.
  const s = stock(10, [
    iv(D1, null, 3, "booking"),
    iv(D3, D5, 2, "booking"),
  ]);
  assertEquals(peakStockConsumption(s).quantity_booked, 5);
  assertEquals(peakStockConsumption(s).since, D3);
});

Deno.test("peakStockConsumption: nothing unavailable means held, everywhere", () => {
  assertEquals(peakStockConsumption(stock(7, [])), {
    quantity_held: 7,
    quantity_booked: 0,
    quantity_out_of_service: 0,
    quantity_available: 7,
    since: null,
  });
});

Deno.test("peakStockConsumption: the ALL-TIME window is never more available than the peak", () => {
  // The direction that does hold, swept — and stated over the all-time window
  // specifically, because the general claim is FALSE and it is the tempting one
  // to write. A window that misses the peak entirely reports MORE availability
  // than the peak does (held = 10, two 5-unit bookings on days 1–2, window
  // [10, 11] → 10 available against the peak's 0). What holds is the special
  // case that matters: every entry overlaps the all-time window, so its sum is
  // an upper bound on any instant's.
  //
  // That special case is exactly the substitution this function exists to
  // prevent — "just call computeStockAvailability over the widest window" — so
  // pinning the inequality pins the direction of the error it would introduce:
  // over-reporting oversells, never missing one.
  const rand = prng(0x5eed);
  for (let i = 0; i < 2_000; i++) {
    const entries: StockUnavailableEntry[] = [];
    let lo = 28;
    let hi = 1;
    const n = 1 + rand(6);
    for (let k = 0; k < n; k++) {
      const s0 = 1 + rand(20);
      const e0 = s0 + rand(8);
      lo = Math.min(lo, s0);
      hi = Math.max(hi, e0);
      entries.push(iv(dayIso(s0), rand(7) === 0 ? null : dayIso(e0), 1 + rand(3)));
    }
    const s = stock(10, entries);
    const peak = peakStockConsumption(s);
    // `end: null` reaches past any finite window, so extend to cover it.
    const all = computeStockAvailability(s, win(dayNum(lo), dayNum(Math.min(28, hi + 1))));
    assert(
      all.quantity_available <= peak.quantity_available,
      `all-time window [${lo},${hi}] reported ${all.quantity_available} available, ABOVE ` +
        `the peak's ${peak.quantity_available}. The peak is the LEAST pessimistic of the ` +
        `two, so this means one of the folds is wrong. entries=${JSON.stringify(entries)}`,
    );
  }
});

/** mulberry32, for the sweep above. Same `Math.imul` requirement as `randomCase`. */
function prng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
  };
}

/** `2026-06-DD`, clamped into June, for the sweep above. */
function dayNum(d: number): string {
  return `2026-06-${String(Math.min(28, Math.max(1, d))).padStart(2, "0")}`;
}
function dayIso(d: number): string {
  return dayNum(d) + "T00:00:00.000-05:00";
}

// ── The random corpus, and the canary that keeps it honest ─────────────────

/**
 * A deterministic random case: a product's live booking and OOS sources plus a
 * query window.
 *
 * It was built for the migration's equivalence sweep, which compared reduce-then-
 * fold against the legacy `computeAvailability`. That engine is deleted, so the
 * sweep is too — but the generator survives, because the canary below still needs
 * a corpus that genuinely exercises the sale rule.
 */
function randomCase(seed: number) {
  // Deterministic mulberry32 — no Math.random, so a failure is reproducible from
  // the seed printed in the assertion message.
  //
  // ⚠️ **It has to be `Math.imul`, and the fail-closed companion is what proved
  // it.** The first version was a textbook 32-bit LCG written as
  // `s = (s * 1103515245 + 12345) >>> 0`, which is exact in C and NOT in JS: the
  // product exceeds 2^53, the low bits are lost to rounding, and `% 2` / `% 4`
  // then return 0 forever. Every one of 8,123 generated bookings came out
  // `rental` with `out: 0` — so the corpus contained not one sale, the sweep
  // above passed, and it was proving nothing about the rule it exists to protect.
  // A green property sweep over a degenerate corpus is indistinguishable from a
  // green one over a real corpus; only the companion can tell them apart.
  let s = seed >>> 0;
  const next = (n: number) => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
  };

  const dayIso = (d: number) =>
    `2026-06-${String(1 + (d % 28)).padStart(2, "0")}T00:00:00.000-05:00`;

  const bookings: StockBookingSource[] = [];
  const bookingCount = next(6);
  for (let i = 0; i < bookingCount; i++) {
    const type: ComponentTypeType = next(2) === 0 ? "rental" : "sale";
    const status = (["quoted", "reserved", "prepped", "active", "complete"] as const)[next(5)];
    const breakdown = bd({ quoted: next(3), reserved: next(4), prepped: next(3), out: next(4) });
    const start = next(5) === 0 ? null : dayIso(next(28));
    const end = next(5) === 0 ? null : dayIso(next(28));
    bookings.push({ type, status, breakdown, dates: { start, end } });
  }

  const oosSources: StockOOSSource[] = [];
  const oosCount = next(4);
  for (let i = 0; i < oosCount; i++) {
    const status = (["active", "planned", "complete", "canceled"] as const)[next(4)];
    const quantity = next(5);
    const start = next(5) === 0 ? null : dayIso(next(28));
    const end = next(5) === 0 ? null : dayIso(next(28));
    oosSources.push({ status, quantity, dates: { start, end } });
  }

  const quantity_held = next(20);
  const window = win(`2026-06-${String(1 + next(20)).padStart(2, "0")}`, `2026-06-28`);

  return { bookings, oosSources, quantity_held, window };
}

/** Reduce a case's sources the way the rebuild will. */
function reduce(
  c: ReturnType<typeof randomCase>,
  reducer: (b: StockBookingSource) => StockUnavailableEntry | null = unavailableFromBooking,
) {
  const unavailable: StockUnavailableEntry[] = [];
  for (const b of c.bookings) {
    const e = reducer(b);
    if (e) unavailable.push(e);
  }
  for (const o of c.oosSources) {
    const e = unavailableFromOOS(o);
    if (e) unavailable.push(e);
  }
  return stock(c.quantity_held, unavailable);
}

Deno.test("corpus canary: the shelf-definition reducer DISAGREES with the real one", () => {
  // ⚠️ **What is left of the migration's equivalence sweep, and why only this
  // half survives.** Until the legacy pair was deleted this file ran two sweeps:
  // `reduce-then-fold agrees with computeAvailability over 5,000 cases`, and this
  // companion. The first one's oracle WAS `computeAvailability` — the engine over
  // `stock-summaries` — so deleting that engine deletes the sweep: there is
  // nothing left for the fold to be equivalent to, and re-pointing it at the fold
  // itself would make it a restatement of its own implementation, which passes
  // forever and proves nothing.
  //
  // The companion needs no legacy engine, because its claim was never "the old
  // engine agrees". Its claim is **the corpus is not degenerate** — that these
  // 5,000 generated cases actually exercise the sale rule, so the direct
  // assertions above are testing something. Stated against the wrong reducer
  // instead of against the deleted one, it keeps exactly that guarantee.
  //
  // The wrong reducer is the single most plausible mistake: the SHELF definition,
  // which counts a sale's `out` units. Those units left ownership at the sale
  // movement, which already dropped `quantity_held`, so counting them again
  // double-subtracts — the defect `unavailableFromBooking` exists to prevent.
  const wrong = (b: StockBookingSource): StockUnavailableEntry | null => {
    if (b.status === "complete") return null;
    const quantity = unitsClaimedOnShelves(b);
    if (quantity <= 0) return null;
    return { start: b.dates.start, end: b.dates.end, quantity, kind: "booking" };
  };

  let disagreements = 0;
  for (let seed = 1; seed <= 5_000; seed++) {
    const c = randomCase(seed);
    const right = computeStockAvailability(reduce(c), c.window).quantity_available;
    if (computeStockAvailability(reduce(c, wrong), c.window).quantity_available !== right) {
      disagreements++;
    }
  }
  assert(
    disagreements > 0,
    "the shelf-definition reducer agreed on every case — the corpus no longer exercises the " +
      "sale rule, so every sale assertion in this file is vacuous",
  );
  // REPORTED, never asserted as a floor: pinning a remembered count means tuning
  // the corpus until it reproduces that number, which is fitting rather than
  // testing.
  console.log(`  corpus canary: the shelf-definition reducer is wrong on ${disagreements} of 5,000 cases`);
});
