/**
 * `src/utils/allocation.ts` had **no test file** — 247 lines and zero coverage,
 * one of only two `core/src/utils` modules without one. It is also the module
 * whose in-batch netting bug was #171: two overlapping bookings of a 5-stock
 * product both pointed pickers at the same physical unit.
 *
 * These are properties, not examples, for a specific reason: the failure #171
 * describes is not a wrong number on one input, it is a *relationship between
 * successive calls* that no single hand-written case can express. Conservation,
 * no-over-draw and netting monotonicity are swept with a seeded LCG (so a run is
 * reproducible); the order/bounds/projection rules are pinned with fixtures,
 * because those have exact expected values rather than an invariant.
 */
import { assert, assertEquals } from "@std/assert";
import {
  addAllocationToReserved,
  allocateBookingNetted,
  allocateBookingToStores,
  allocateBookingWithNetting,
  buildReservedByLocation,
  type ReservedByLocation,
  type ReservingBooking,
} from "../src/utils/allocation.ts";
import { BookingSchema, resolveZodField } from "../src/schemas/mod.ts";
import type { BookingStore, StoreBreakdownEntry } from "../src/schemas/mod.ts";

// ── Fixtures ─────────────────────────────────────────────────────

/** A 20-char alphanumeric id — `FirestoreId` rejects anything else, and the
 * projection test below parses against the real schema. */
const id = (label: string) => (label + "x".repeat(20)).slice(0, 20);

function store(
  name: string,
  isDefault: boolean,
  locations: Array<{ name: string; quantity: number; default?: boolean; max?: number | null }>,
): StoreBreakdownEntry {
  const locs = locations.map((l) => ({
    uid_location: id(name + l.name),
    name: l.name,
    quantity: l.quantity,
    default: l.default ?? false,
    max: l.max ?? null,
  }));
  return {
    uid_store: id(name),
    name,
    default: isDefault,
    crms_stock_level_id: 42,
    quantity: locs.reduce((s, l) => s + l.quantity, 0),
    locations: locs,
  };
}

const totalAllocated = (stores: BookingStore[]) =>
  stores.reduce((sum, s) => sum + s.locations.reduce((t, l) => t + l.quantity, 0), 0);

const heldBreakdown = (reserved: number): ReservingBooking["breakdown"] => ({
  damaged: 0,
  lost: 0,
  out: 0,
  prepped: 0,
  quoted: 0,
  reserved,
  returned: 0,
});

// ── Properties 1, 2, 7: conservation, no over-draw, shortage ─────

Deno.test("allocateBookingToStores: Σ allocated + shortage === requested, and no location over-draws", () => {
  let seed = 24_681_012;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  for (let i = 0; i < 20_000; i++) {
    const breakdown: StoreBreakdownEntry[] = [];
    for (let s = 0; s < rand(4); s++) {
      const locations = [];
      for (let l = 0; l < rand(4) + 1; l++) {
        locations.push({ name: `L${l}`, quantity: rand(12), default: l === 0 });
      }
      breakdown.push(store(`S${s}`, s === 0, locations));
    }
    // Deliberately asks for more than exists a good fraction of the time —
    // overbooking must surface as `shortage`, never as a silent truncation.
    const want = rand(40);
    const result = allocateBookingToStores(breakdown, want);

    assertEquals(
      totalAllocated(result.stores) + result.shortage,
      want,
      `conservation broke at i=${i}`,
    );

    const capacity = new Map<string, number>();
    for (const s of breakdown) {
      for (const l of s.locations) capacity.set(l.uid_location, l.quantity);
    }
    for (const s of result.stores) {
      for (const l of s.locations) {
        assert(
          l.quantity <= (capacity.get(l.uid_location) ?? 0),
          `over-drew ${l.uid_location}: ${l.quantity} > ${capacity.get(l.uid_location)}`,
        );
      }
    }
    assert(result.shortage >= 0, "shortage went negative");
  }
});

Deno.test("allocateBookingToStores: overbooking surfaces as shortage, it is not clamped", () => {
  const breakdown = [store("Main", true, [{ name: "A", quantity: 3, default: true }])];
  const result = allocateBookingToStores(breakdown, 10);
  assertEquals(totalAllocated(result.stores), 3);
  assertEquals(result.shortage, 7);
});

Deno.test("allocateBookingToStores: an empty breakdown is all shortage, not an error", () => {
  const result = allocateBookingToStores([], 5);
  assertEquals(result.stores, []);
  assertEquals(result.shortage, 5);
  assertEquals(result.query_by_uid_store, []);
  assertEquals(result.query_by_uid_location, []);
});

// ── Property 3: priority order ───────────────────────────────────

Deno.test("allocateBookingToStores: default store first, then localeCompare by name", () => {
  const breakdown = [
    store("Zulu", false, [{ name: "A", quantity: 5 }]),
    store("Alpha", false, [{ name: "A", quantity: 5 }]),
    store("Main", true, [{ name: "A", quantity: 5 }]),
  ];
  // Ask for 11 so all three are visited and the ORDER is observable in the
  // partial draw on the last one.
  const result = allocateBookingToStores(breakdown, 11);
  assertEquals(result.stores.map((s) => s.name), ["Main", "Alpha", "Zulu"]);
  assertEquals(result.stores.map((s) => s.quantity), [5, 5, 1]);
});

Deno.test("allocateBookingToStores: default location first, then DESCENDING quantity", () => {
  const breakdown = [
    store("Main", true, [
      { name: "Small", quantity: 1 },
      { name: "Big", quantity: 9 },
      { name: "Default", quantity: 2, default: true },
    ]),
  ];
  const result = allocateBookingToStores(breakdown, 12);
  assertEquals(result.stores[0].locations.map((l) => l.name), ["Default", "Big", "Small"]);
  assertEquals(result.stores[0].locations.map((l) => l.quantity), [2, 9, 1]);
});

Deno.test("allocateBookingToStores: a zero-quantity location is skipped, not emitted empty", () => {
  const breakdown = [
    store("Main", true, [{ name: "Empty", quantity: 0, default: true }, { name: "Has", quantity: 4 }]),
  ];
  const result = allocateBookingToStores(breakdown, 2);
  assertEquals(result.stores[0].locations.map((l) => l.name), ["Has"]);
});

// ── Property 6: projection fidelity ──────────────────────────────

Deno.test("allocateBookingToStores: the result parses as Booking['stores'] — strict schema, dropped fields", () => {
  // The ledger entry carries `crms_stock_level_id` and `locations[].max`;
  // `BookingStoreSchema` is `z.strictObject` and has neither, so a leak is a
  // parse failure rather than a field that quietly rides along into the booking.
  const breakdown = [store("Main", true, [{ name: "A", quantity: 5, default: true, max: 99 }])];
  const result = allocateBookingToStores(breakdown, 3);

  const storesField = resolveZodField(BookingSchema, "stores", { unwrap: false });
  assert(storesField, "Booking.stores did not resolve — the schema moved");
  const parsed = storesField.safeParse(result.stores);
  assert(parsed.success, `projection did not parse: ${JSON.stringify(parsed.error?.issues)}`);

  // `Object.hasOwn`, not a cast to `Record<string, unknown>` — that cast is
  // TS2352 here, because a TypeScript `interface` carries no implicit index
  // signature under any relation. (Worth knowing: it is the same premise Item
  // 7B-1's 41-breakage estimate rests on, confirmed by the compiler in passing.)
  assert(!Object.hasOwn(result.stores[0], "crms_stock_level_id"), "crms_stock_level_id leaked");
  assert(!Object.hasOwn(result.stores[0].locations[0], "max"), "max leaked into the booking");
});

// ── buildReservedByLocation ──────────────────────────────────────

Deno.test("buildReservedByLocation: only bookings that actually hold stock contribute", () => {
  const stores: BookingStore[] = [{
    uid_store: id("S"),
    name: "S",
    default: true,
    quantity: 3,
    locations: [{ uid_location: id("SL"), name: "L", quantity: 3, default: true }],
  }];
  // A returned booking can keep a stale `stores` array; `reserved+prepped+out`
  // is the same definition `quantity_booked` uses, so it must contribute 0.
  const returned: ReservingBooking["breakdown"] = { ...heldBreakdown(0), returned: 3 };
  assertEquals(buildReservedByLocation([{ breakdown: returned, stores }]).size, 0);
  assertEquals(
    buildReservedByLocation([{ breakdown: heldBreakdown(3), stores }]).get(id("SL")),
    3,
  );
});

Deno.test("addAllocationToReserved: accumulates rather than overwrites", () => {
  const reserved: ReservedByLocation = new Map();
  const stores: BookingStore[] = [{
    uid_store: id("S"),
    name: "S",
    default: true,
    quantity: 2,
    locations: [{ uid_location: id("SL"), name: "L", quantity: 2, default: true }],
  }];
  addAllocationToReserved(reserved, stores);
  addAllocationToReserved(reserved, stores);
  assertEquals(reserved.get(id("SL")), 4);
});

Deno.test("allocateBookingNetted: subtracts reserved units, clamped at zero", () => {
  const breakdown = [store("Main", true, [{ name: "A", quantity: 5, default: true }])];
  const reserved: ReservedByLocation = new Map([[id("MainA"), 4]]);
  const result = allocateBookingNetted(breakdown, 3, reserved);
  assertEquals(totalAllocated(result.stores), 1);
  assertEquals(result.shortage, 2);

  // Over-reserved past the shelf count must not produce a negative capacity.
  const over: ReservedByLocation = new Map([[id("MainA"), 99]]);
  const none = allocateBookingNetted(breakdown, 3, over);
  assertEquals(totalAllocated(none.stores), 0);
  assertEquals(none.shortage, 3);
});

// ── Property 4: netting monotonicity — the #171 regression ───────

Deno.test("allocateBookingWithNetting: N sequential bookings never exceed the physical stock (#171)", () => {
  // The bug: each booking allocated against the GROSS breakdown, so five
  // bookings of one unit each against a 5-unit product all pointed at the same
  // shelf. `allocateBookingWithNetting` folds its own result back into
  // `inBatchReserved`, so this is the property that must hold.
  let seed = 13_579;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  for (let trial = 0; trial < 2_000; trial++) {
    const held = rand(9) + 1;
    const breakdown = [store("Main", true, [{ name: "A", quantity: held, default: true }])];
    const inBatch: ReservedByLocation = new Map();
    let allocated = 0;
    const bookings = rand(6) + 1;
    for (let b = 0; b < bookings; b++) {
      const result = allocateBookingWithNetting(
        breakdown,
        rand(4) + 1,
        [],
        null,
        null,
        inBatch,
      );
      allocated += totalAllocated(result.stores);
    }
    assert(
      allocated <= held,
      `allocated ${allocated} of a ${held}-unit product across ${bookings} bookings`,
    );
  }
});

Deno.test("allocateBookingWithNetting: the second booking sees the first one's draw", () => {
  const breakdown = [store("Main", true, [{ name: "A", quantity: 5, default: true }])];
  const inBatch: ReservedByLocation = new Map();
  const first = allocateBookingWithNetting(breakdown, 3, [], null, null, inBatch);
  const second = allocateBookingWithNetting(breakdown, 3, [], null, null, inBatch);
  assertEquals(totalAllocated(first.stores), 3);
  assertEquals(totalAllocated(second.stores), 2);
  assertEquals(second.shortage, 1);
});

// ── Property 5: overlap bounds are inclusive; null is open-ended ──

/** One reserving booking holding `qty` at Main/A over [startMs, endMs]. */
const reserving = (qty: number, startMs: number | null, endMs: number | null): ReservingBooking => ({
  breakdown: heldBreakdown(qty),
  stores: [{
    uid_store: id("Main"),
    name: "Main",
    default: true,
    quantity: qty,
    locations: [{ uid_location: id("MainA"), name: "A", quantity: qty, default: true }],
  }],
  startMs,
  endMs,
});

Deno.test("allocateBookingWithNetting: the overlap filter is INCLUSIVE on both bounds", () => {
  // Touching at a single instant counts as overlapping. This must agree with the
  // availability engine's window rule — a disagreement between the two is a live
  // oversell, since availability would report a unit free that allocation has
  // already handed to a picker.
  const breakdown = [store("Main", true, [{ name: "A", quantity: 5, default: true }])];
  const window = { start: 1_000, end: 2_000 };

  // Ends exactly at our start → overlaps.
  const touchingStart = allocateBookingWithNetting(
    breakdown, 5, [reserving(2, 0, window.start)], window.start, window.end, new Map(),
  );
  assertEquals(totalAllocated(touchingStart.stores), 3);

  // Starts exactly at our end → overlaps.
  const touchingEnd = allocateBookingWithNetting(
    breakdown, 5, [reserving(2, window.end, 9_999)], window.start, window.end, new Map(),
  );
  assertEquals(totalAllocated(touchingEnd.stores), 3);

  // Strictly before → does not overlap, nets nothing.
  const before = allocateBookingWithNetting(
    breakdown, 5, [reserving(2, 0, window.start - 1)], window.start, window.end, new Map(),
  );
  assertEquals(totalAllocated(before.stores), 5);
});

Deno.test("allocateBookingWithNetting: a null bound is open-ended and nets against every window", () => {
  // Load-bearing for SALE bookings, which carry `end: null` because a sold unit
  // does not come back. Treating that as a point event hands the units back as
  // available the day after the sale.
  const breakdown = [store("Main", true, [{ name: "A", quantity: 5, default: true }])];

  const openEnded = allocateBookingWithNetting(
    breakdown, 5, [reserving(2, null, null)], 1_000, 2_000, new Map(),
  );
  assertEquals(totalAllocated(openEnded.stores), 3);

  const soldLongAgo = allocateBookingWithNetting(
    breakdown, 5, [reserving(2, 0, null)], 9_000_000, 9_999_999, new Map(),
  );
  assertEquals(totalAllocated(soldLongAgo.stores), 3, "an open-ended sale stopped consuming stock");
});

Deno.test("allocateBookingWithNetting: a null WINDOW skips overlap netting but still nets in-batch", () => {
  // `windowStartMs`/`windowEndMs` null means the caller has no window to filter
  // on, so the pre-fetched reserving set is skipped entirely — but the in-batch
  // map is still honoured, which is what keeps the #171 guarantee unconditional.
  const breakdown = [store("Main", true, [{ name: "A", quantity: 5, default: true }])];
  const inBatch: ReservedByLocation = new Map();

  const first = allocateBookingWithNetting(breakdown, 4, [reserving(5, 0, 1)], null, null, inBatch);
  assertEquals(totalAllocated(first.stores), 4, "the windowless call netted the pre-fetched set");

  const second = allocateBookingWithNetting(breakdown, 4, [reserving(5, 0, 1)], null, null, inBatch);
  assertEquals(totalAllocated(second.stores), 1, "in-batch netting was skipped");
});
