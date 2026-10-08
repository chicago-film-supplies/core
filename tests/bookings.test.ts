import { assertEquals, assertThrows } from "@std/assert";
import {
  apportionBreakdown,
  applyBookingBreakdownDelta,
  calculateBookingBreakdown,
  cancelRefusal,
  deriveOrderStatus,
  isKeptBooking,
  emptyBookingsBreakdown,
  grainKeep,
  hasCustodyHistory,
  isBookingClosed,
  isOrderBookingsClosed,
  liveCustody,
  mergeBookingBreakdown,
  sumBookingBreakdown,
  sumBookingsBreakdown,
  sumBreakdownKeys,
  terminalQuantity,
  BOOKING_BREAKDOWN_KEYS,
} from "../src/utils/bookings.ts";
import type { Booking, OrderStatusType } from "../src/schemas/mod.ts";

/** A stored breakdown: every key stated, `cleaning`/`maintenance` included. */
const sample = (overrides: Partial<Booking["breakdown"]> = {}): Booking["breakdown"] => ({
  ...emptyBookingsBreakdown(),
  ...overrides,
});
const full = sample;

const booking = (
  type: Booking["type"],
  breakdownOverrides: Partial<Booking["breakdown"]> = {},
): Pick<Booking, "type" | "breakdown"> => ({
  type,
  breakdown: sample(breakdownOverrides),
});

Deno.test("emptyBookingsBreakdown returns all-zero shape", () => {
  assertEquals(emptyBookingsBreakdown(), {
    quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0, cleaning: 0, maintenance: 0,
  });
});

Deno.test("sumBookingBreakdown sums every key, a PARTIAL map's absent one as 0", () => {
  assertEquals(sumBookingBreakdown(sample({ out: 3, returned: 2 })), 5);
  assertEquals(sumBookingBreakdown(sample()), 0);
  assertEquals(
    sumBookingBreakdown({ quoted: 1, reserved: 1, prepped: 1, out: 1, returned: 1, lost: 1, damaged: 1 }),
    7,
  );
  assertEquals(
    sumBookingBreakdown({
      quoted: 1, reserved: 1, prepped: 1, out: 1, returned: 1, lost: 1, damaged: 1, cleaning: 1, maintenance: 1,
    }),
    9,
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
    quoted: 0, reserved: 0, prepped: 0, out: 5, returned: 1, lost: 0, damaged: 1, cleaning: 0, maintenance: 0,
  });
});

Deno.test("applyBookingBreakdownDelta mutates roll-up by next - prev", () => {
  const orderRollup = sample({ out: 5 });
  const prev = sample({ out: 5 });
  const next = sample({ out: 2, returned: 2, lost: 1 });
  applyBookingBreakdownDelta(orderRollup, prev, next);
  assertEquals(orderRollup, sample({ out: 2, returned: 2, lost: 1 }));
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
    full({ quoted: 10 }),
  );
});

Deno.test("calculateBookingBreakdown: reserved from fresh", () => {
  assertEquals(
    calculateBookingBreakdown("reserved", "rental", 10),
    full({ reserved: 10 }),
  );
});

Deno.test("calculateBookingBreakdown: active behaves like reserved", () => {
  assertEquals(
    calculateBookingBreakdown("active", "rental", 10),
    full({ reserved: 10 }),
  );
});

Deno.test("calculateBookingBreakdown: quoted → reserved drops the previous quoted bucket", () => {
  // The bug fix — previously quoted=10 would persist into the reserved-state breakdown.
  const prev = sample({ quoted: 10 });
  const next = calculateBookingBreakdown("reserved", "rental", 10, prev);
  assertEquals(next, full({ reserved: 10 }));
  assertEquals(sumBookingBreakdown(next), 10);
});

Deno.test("calculateBookingBreakdown: reserved → quoted drops the previous reserved bucket", () => {
  const prev = sample({ reserved: 10 });
  const next = calculateBookingBreakdown("quoted", "rental", 10, prev);
  assertEquals(next, full({ quoted: 10 }));
});

Deno.test("calculateBookingBreakdown: reserved preserves in-flight progress", () => {
  const prev = sample({ reserved: 0, prepped: 3, out: 2, returned: 1, lost: 1, damaged: 1 });
  const next = calculateBookingBreakdown("reserved", "rental", 10, prev);
  assertEquals(next, {
    quoted: 0, reserved: 2, prepped: 3, out: 2, returned: 1, lost: 1, damaged: 1, cleaning: 0, maintenance: 0,
  });
  assertEquals(sumBookingBreakdown(next), 10);
});

Deno.test("calculateBookingBreakdown: the open bucket floors at zero — it never goes negative", () => {
  // The order shrinks to 3 while the warehouse already holds 5 prepped.
  const prev = sample({ prepped: 5 });
  const next = calculateBookingBreakdown("reserved", "rental", 3, prev);

  // Before the floor this was `{prepped: 5, reserved: -2}` — whose sum is 3, so
  // every `sum(breakdown) === quantity` check passed on it while two physically
  // prepped units came off the shelf's unavailable total.
  assertEquals(next, full({ prepped: 5, reserved: 0 }));
  assertEquals(sumBookingBreakdown(next), 5);
});

Deno.test("calculateBookingBreakdown: the floor covers every carry bucket, not just prepped", () => {
  for (const key of ["prepped", "out", "returned", "lost", "damaged", "cleaning", "maintenance"] as const) {
    const next = calculateBookingBreakdown("reserved", "rental", 1, sample({ [key]: 4 }));
    assertEquals(next.reserved, 0, `${key} must not mint a negative open bucket`);
    assertEquals(sumBookingBreakdown(next), 4, `${key} carry must survive the shrink`);
  }
});

Deno.test("calculateBookingBreakdown: a shrink to exactly the carry still empties the open bucket", () => {
  const next = calculateBookingBreakdown("quoted", "rental", 4, sample({ out: 4 }));
  assertEquals(next, full({ out: 4 }));
  assertEquals(sumBookingBreakdown(next), 4);
});

Deno.test("calculateBookingBreakdown: complete rental → returned + the out-of-service keys sum to quantity", () => {
  const prev = sample({ out: 8, lost: 1, damaged: 1 });
  const next = calculateBookingBreakdown("complete", "rental", 10, prev);
  assertEquals(next, full({ returned: 8, lost: 1, damaged: 1 }));
  assertEquals(sumBookingBreakdown(next), 10);
});

Deno.test("calculateBookingBreakdown: complete sale → all qty in out", () => {
  const prev = sample({ reserved: 5 });
  const next = calculateBookingBreakdown("complete", "sale", 5, prev);
  assertEquals(next, full({ out: 5 }));
});

Deno.test("calculateBookingBreakdown: complete service/surcharge → all zeros, NOT quantity", () => {
  // Load-bearing, and until this test existed nothing pinned it despite ~439
  // prod bookings riding the branch. `api-cloudrun/scripts/repair-booking-breakdowns.ts`
  // derives `expectedSumAfter` from this rule and ABORTS its run when the
  // projection disagrees — so a `complete` arm that gave service the rental or
  // sale treatment would brick that script on every service booking. (It named
  // `complete-stale-bookings.ts` until that script was deleted on 2026-08-30;
  // this test is what pins the rule independently of either.)
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
  assertEquals(repaired, full({ reserved: 30 }));
  assertEquals(sumBookingBreakdown(repaired), 30);
});

Deno.test("liveCustody — prepped always, out only on a rental", () => {
  const b = sample({ reserved: 4, prepped: 2, out: 3, returned: 5, lost: 1, damaged: 1 });
  assertEquals(liveCustody({ type: "rental", breakdown: b }), 5);
  assertEquals(liveCustody({ type: "sale", breakdown: b }), 2);
  assertEquals(liveCustody({ type: "rental", breakdown: sample({ returned: 3 }) }), 0);
});

Deno.test("grainKeep — decision 3 cases", async (t) => {
  await t.step("two groups on one leg, A prepped: removing B keeps nothing", () => {
    const k = grainKeep(2, [{ key: "A", before: 2, after: 2 }, { key: "B", before: 3, after: 0 }]);
    assertEquals(k.kept, 0);
    assertEquals(k.byRow.size, 0);
  });
  await t.step("removing A keeps nothing: B's order still covers the prepped units", () => {
    const k = grainKeep(2, [{ key: "A", before: 2, after: 0 }, { key: "B", before: 3, after: 3 }]);
    assertEquals(k.kept, 0);
  });
  await t.step("removing both: the shortfall lands on the removed rows in order", () => {
    const k = grainKeep(4, [{ key: "A", before: 2, after: 0 }, { key: "B", before: 3, after: 0 }]);
    assertEquals(k.kept, 4);
    assertEquals([...k.byRow], [["A", 2], ["B", 2]]);
  });
  await t.step("shrink 5 → 1 with live 3: that row keeps 2", () => {
    const k = grainKeep(3, [{ key: "A", before: 5, after: 1 }]);
    assertEquals(k.kept, 2);
    assertEquals(k.byRow.get("A"), 2);
  });
  await t.step("a remainder beyond every decrease goes to the last decreasing row", () => {
    const k = grainKeep(6, [{ key: "A", before: 2, after: 0 }, { key: "B", before: 1, after: 0 }]);
    assertEquals([...k.byRow], [["A", 2], ["B", 4]]);
  });
  await t.step("no decreasing row: kept is reported, nothing is allocated", () => {
    const k = grainKeep(3, [{ key: "A", before: 1, after: 1 }]);
    assertEquals(k.kept, 2);
    assertEquals(k.byRow.size, 0);
  });
});

// ── cleaning / maintenance (custody-actions P2b) ────────────────────

Deno.test("P2b: a stored breakdown with no cleaning/maintenance key reads them as 0", () => {
  // Every booking stored before the keys existed; `sample` states only seven.
  assertEquals(sumBookingBreakdown(sample({ returned: 3 })), 3);
  assertEquals(isBookingClosed(booking("rental", { returned: 3 })), true);
});

Deno.test("P2b: calculateBookingBreakdown carries cleaning and maintenance forward, never into returned", () => {
  const prev = full({ returned: 2, cleaning: 3, maintenance: 1 });
  // An order edit re-projecting a live booking must keep the condition history.
  assertEquals(
    calculateBookingBreakdown("reserved", "rental", 6, prev),
    full({ returned: 2, cleaning: 3, maintenance: 1 }),
  );
  // Completion keeps every out-of-service key and gives `returned` only the rest.
  assertEquals(
    calculateBookingBreakdown("complete", "rental", 10, full({ out: 4, cleaning: 3, maintenance: 1, lost: 2 })),
    full({ returned: 4, cleaning: 3, maintenance: 1, lost: 2 }),
  );
});

Deno.test("P2b: a cleaning-only booking has custody history, so an order edit keeps it", () => {
  assertEquals(hasCustodyHistory({ breakdown: full({ cleaning: 1 }) }), true);
  assertEquals(hasCustodyHistory({ breakdown: full({ maintenance: 1 }) }), true);
  assertEquals(hasCustodyHistory({ breakdown: full({ quoted: 2, reserved: 1 }) }), false);
});

Deno.test("P2b: a rental whose units came back dirty is closed", () => {
  assertEquals(isBookingClosed(booking("rental", { cleaning: 2, maintenance: 1, returned: 2 })), true);
});

Deno.test("P2b: sums and deltas reach the new keys", () => {
  assertEquals(sumBookingsBreakdown([{ breakdown: sample() }, { breakdown: full({ cleaning: 2 }) }]).cleaning, 2);
  const rollup = sample({ out: 3 });
  applyBookingBreakdownDelta(rollup, sample({ out: 3 }), sample({ out: 1, returned: 2 }));
  assertEquals(rollup, sample({ out: 1, returned: 2 }));
  applyBookingBreakdownDelta(rollup, sample({ out: 1 }), full({ cleaning: 1 }));
  assertEquals(rollup, sample({ returned: 2, cleaning: 1 }));
  assertEquals(mergeBookingBreakdown(sample({ out: 2 }), { maintenance: 2, out: 0 }).maintenance, 2);
});

Deno.test("P2b: terminalQuantity and sumBreakdownKeys reach every terminal key", () => {
  assertEquals(terminalQuantity(sample({ returned: 1, lost: 1, damaged: 1 })), 3);
  assertEquals(terminalQuantity(full({ returned: 1, cleaning: 2, maintenance: 3 })), 6);
  assertEquals(sumBreakdownKeys(sample(), ["cleaning", "maintenance"]), 0);
});

// ── apportionBreakdown (api-cloudrun#1204) ──

/** Seeded LCG — deterministic, never `Math.random()`. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** A random breakdown over a random subset of buckets, and quantities summing to it. */
function draw(rand: () => number): { breakdown: Booking["breakdown"]; quantities: number[] } {
  const recipients = 1 + Math.floor(rand() * 5);
  const quantities = Array.from({ length: recipients }, () => 1 + Math.floor(rand() * (rand() < 0.5 ? 5 : 120)));
  const total = quantities.reduce((n, q) => n + q, 0);
  const buckets = BOOKING_BREAKDOWN_KEYS.filter(() => rand() < 0.4);
  if (buckets.length === 0) buckets.push("returned");
  const breakdown = sample();
  let left = total;
  buckets.forEach((key, i) => {
    const n = i === buckets.length - 1 ? left : Math.floor(rand() * (left + 1));
    breakdown[key] = n;
    left -= n;
  });
  return { breakdown, quantities };
}

/**
 * Per-bucket largest remainder with NO regard for the recipients — the obvious
 * implementation, and the one this function exists to not be.
 */
function naivePerBucket(breakdown: Booking["breakdown"], quantities: number[]): Booking["breakdown"][] {
  const total = quantities.reduce((n, q) => n + q, 0);
  const out = quantities.map(() => sample());
  for (const key of BOOKING_BREAKDOWN_KEYS) {
    const shares = quantities.map((q, j) => ({ j, floor: Math.floor(breakdown[key] * q / total), rem: (breakdown[key] * q) % total }));
    let left = breakdown[key] - shares.reduce((n, s) => n + s.floor, 0);
    for (const s of shares) out[s.j][key] = s.floor;
    for (const s of [...shares].sort((a, b) => b.rem - a.rem || a.j - b.j)) {
      if (left-- <= 0) break;
      out[s.j][key] += 1;
    }
  }
  return out;
}

Deno.test("apportionBreakdown: the #1204 shape — 96 returned + 4 lost over 64/36", () => {
  const [a, b] = apportionBreakdown(sample({ returned: 96, lost: 4 }), [64, 36]);
  assertEquals(a, sample({ returned: 61, lost: 3 }));
  assertEquals(b, sample({ returned: 35, lost: 1 }));
});

Deno.test("apportionBreakdown: the tie that breaks per-bucket rounding", () => {
  const input = sample({ returned: 1, lost: 1 });
  // The naive pass gives both units to recipient 0: a booking of 1 holding 2.
  assertEquals(naivePerBucket(input, [1, 1]).map(sumBookingBreakdown), [2, 0]);
  const out = apportionBreakdown(input, [1, 1]);
  assertEquals(out.map(sumBookingBreakdown), [1, 1]);
  assertEquals(sumBookingsBreakdown(out.map((breakdown) => ({ breakdown }))), input);
});

Deno.test("apportionBreakdown: the greedy pass strands a unit and the repair re-routes it", () => {
  // Every cell is ⅔ and every remainder ties. Largest-remainder-with-capacity
  // fills recipients 0 and 1 with returned + lost and leaves damaged two units
  // and one recipient — the smallest such case (searched exhaustively to 8
  // units). Only the augmenting path finishes it.
  const out = apportionBreakdown(sample({ returned: 2, lost: 2, damaged: 2 }), [2, 2, 2]);
  assertEquals(out, [sample({ lost: 1, damaged: 1 }), sample({ returned: 1, lost: 1 }), sample({ returned: 1, damaged: 1 })]);
});

Deno.test("apportionBreakdown: one recipient takes the whole breakdown", () => {
  const input = sample({ returned: 7, lost: 2, damaged: 1 });
  assertEquals(apportionBreakdown(input, [10]), [input]);
});

Deno.test("apportionBreakdown: refuses what cannot be conserved", () => {
  assertThrows(() => apportionBreakdown(sample({ returned: 5 }), []), RangeError, "at least one");
  assertThrows(() => apportionBreakdown(sample({ returned: 5 }), [5, 0]), RangeError, "positive integer");
  assertThrows(() => apportionBreakdown(sample({ returned: 5 }), [2.5, 2.5]), RangeError, "positive integer");
  assertThrows(() => apportionBreakdown(sample({ returned: 5 }), [3, 3]), RangeError, "no split conserves both");
  assertThrows(() => apportionBreakdown(sample({ returned: 6, lost: -1 }), [5]), RangeError, "non-negative");
  assertThrows(() => apportionBreakdown(sample({ returned: 4.5, lost: 0.5 }), [5]), RangeError, "non-negative integer");
});

Deno.test("apportionBreakdown: 100k draws — every bucket conserved, every recipient sums, every cell within floor/ceil", () => {
  const rand = lcg(20261007);
  let checked = 0, multiBucketMultiRecipient = 0, naiveBroken = 0;
  for (let i = 0; i < 100_000; i++) {
    const { breakdown, quantities } = draw(rand);
    const total = quantities.reduce((n, q) => n + q, 0);
    const out = apportionBreakdown(breakdown, quantities);
    assertEquals(out.length, quantities.length);
    // Conservation per bucket, summed independently of the implementation.
    for (const key of BOOKING_BREAKDOWN_KEYS) {
      assertEquals(out.reduce((n, b) => n + b[key], 0), breakdown[key], `draw ${i} bucket ${key}`);
    }
    out.forEach((b, j) => {
      assertEquals(sumBookingBreakdown(b), quantities[j], `draw ${i} recipient ${j}`);
      for (const key of BOOKING_BREAKDOWN_KEYS) {
        // By the definition: |cell − bucket·q/total| < 1, cross-multiplied.
        const ideal = breakdown[key] * quantities[j];
        assertEquals(Number.isInteger(b[key]) && b[key] >= 0, true);
        assertEquals(Math.abs(b[key] * total - ideal) < total, true, `draw ${i} cell ${key}/${j}`);
      }
    });
    assertEquals(apportionBreakdown(breakdown, quantities), out, `draw ${i} deterministic`);
    checked++;
    const nonEmpty = BOOKING_BREAKDOWN_KEYS.filter((k) => breakdown[k] > 0).length;
    if (nonEmpty >= 2 && quantities.length >= 2) multiBucketMultiRecipient++;
    const naive = naivePerBucket(breakdown, quantities);
    if (naive.some((b, j) => sumBookingBreakdown(b) !== quantities[j])) naiveBroken++;
  }
  assertEquals(checked, 100_000);
  // The domain was exercised: most draws split several buckets several ways…
  assertEquals(multiBucketMultiRecipient > 30_000, true, `only ${multiBucketMultiRecipient} hard draws`);
  // …and the companion bites: the per-bucket pass breaks a recipient on some of
  // them, every one of which the sweep above passed. Reported, not floored.
  console.log(`apportionBreakdown sweep: ${multiBucketMultiRecipient} multi/multi draws, naive per-bucket broke ${naiveBroken}`);
  assertEquals(naiveBroken > 0, true, "the companion never fired — the corpus does not discriminate");
});

// ── deriveOrderStatus / cancelRefusal (stock campaign P1, decisions 2 and 13) ──

const orderBk = (
  b: Partial<Booking["breakdown"]>,
  quantity_ordered: number,
  type: Booking["type"] = "rental",
  uid = "o:i:d",
): Pick<Booking, "uid" | "type" | "breakdown" | "quantity_ordered"> => ({
  uid,
  type,
  quantity_ordered,
  breakdown: { ...emptyBookingsBreakdown(), ...b },
});

Deno.test("deriveOrderStatus: the authored statuses are never overridden by the bookings", () => {
  for (const s of ["draft", "quoted", "canceled"] as const) {
    assertEquals(deriveOrderStatus(s, [orderBk({ returned: 1 }, 1)]), s);
    assertEquals(deriveOrderStatus(s, [orderBk({ out: 1 }, 1)]), s);
  }
});

Deno.test("deriveOrderStatus: reserved, active and complete are read off the bookings", () => {
  for (const s of ["reserved", "active", "complete"] as const) {
    assertEquals(deriveOrderStatus(s, [orderBk({ reserved: 2 }, 2)]), "reserved", s);
    assertEquals(deriveOrderStatus(s, [orderBk({ prepped: 2 }, 2)]), "reserved", s);
    assertEquals(deriveOrderStatus(s, [orderBk({ out: 1, reserved: 1 }, 2)]), "active", s);
    assertEquals(deriveOrderStatus(s, [orderBk({ returned: 1, reserved: 1 }, 2)]), "active", s);
    assertEquals(deriveOrderStatus(s, [orderBk({ returned: 2 }, 2)]), "complete", s);
  }
  // A complete order reopens when an edit raises a line, and re-completes when lowered.
  assertEquals(deriveOrderStatus("complete", [orderBk({ returned: 2, reserved: 1 }, 3)]), "active");
  // A fully-out sale is closed (decision 9).
  assertEquals(deriveOrderStatus("reserved", [orderBk({ out: 2 }, 2, "sale")]), "complete");
});

Deno.test("deriveOrderStatus: kept bookings — the api's bookingsCompleteOrder cases, carried over", () => {
  // History alone is not work.
  assertEquals(deriveOrderStatus("active", [orderBk({ returned: 1 }, 0)]), "active");
  // An OPEN kept booking still holds the order open; a closed one does not.
  assertEquals(deriveOrderStatus("active", [orderBk({ returned: 2 }, 2), orderBk({ out: 1 }, 0)]), "active");
  assertEquals(deriveOrderStatus("active", [orderBk({ returned: 2 }, 2), orderBk({ returned: 1 }, 0)]), "complete");
  // A canceled order whose kept bookings closed stays canceled.
  assertEquals(deriveOrderStatus("canceled", [orderBk({ returned: 1 }, 0)]), "canceled");
});

Deno.test("deriveOrderStatus: an order with no booking it asks for keeps its stored status", () => {
  // An order of only service lines books nothing; it must not reopen on a save.
  assertEquals(deriveOrderStatus("complete", []), "complete");
  assertEquals(deriveOrderStatus("active", []), "active");
  assertEquals(deriveOrderStatus("complete", [orderBk({ returned: 1 }, 0)]), "complete");
});

Deno.test("isKeptBooking is quantity_ordered === 0", () => {
  assertEquals(isKeptBooking({ quantity_ordered: 0 }), true);
  assertEquals(isKeptBooking({ quantity_ordered: 1 }), false);
});

Deno.test("cancelRefusal: refused while any booking holds prepped or owned out, naming each (decision 13)", () => {
  assertEquals(cancelRefusal([orderBk({ reserved: 2 }, 2), orderBk({ returned: 2 }, 2)]), null);
  // A sale's out is the customer's, so it does not block.
  assertEquals(cancelRefusal([orderBk({ out: 2 }, 2, "sale")]), null);
  const r = cancelRefusal([
    orderBk({ out: 1, returned: 1 }, 2, "rental", "a"),
    orderBk({ prepped: 2 }, 2, "sale", "b"),
    orderBk({ reserved: 3 }, 3, "rental", "c"),
  ]);
  assertEquals(r?.bookings, [{ uid: "a", prepped: 0, out: 1 }, { uid: "b", prepped: 2, out: 0 }]);
  assertEquals(r?.message.includes("3 unit(s) on 2 booking(s)"), true);
});
