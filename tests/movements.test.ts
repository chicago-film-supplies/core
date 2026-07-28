/**
 * The movement fold — conservation, reversal, and the cost arithmetic.
 *
 * The cost tests check against an exact BigInt rational reference rather than
 * against the previous implementation, because the previous implementation is
 * what they exist to correct: it derived `average_unit_cost` first and
 * multiplied by it, quantizing the per-unit average before scaling it. See the
 * "divide last" test.
 */
import { assertEquals } from "@std/assert";
import {
  allocationSide,
  applyMovementToLedger,
  applyOutOfServiceReason,
  costOfUnits,
  deriveServiceQuantities,
  heldDelta,
  movementHeldDelta,
  negateLines,
} from "../src/utils/movements.ts";
import type { InventoryLedger, MovementLineType } from "../src/schemas/mod.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const LOC_A = "testloc1000000000000";
const LOC_B = "testloc2000000000000";
const OOS = "testoos1000000000000";
const BOOKING = "testordr100000000000:testitem10000000000x:testdest100000000000";

const at = (uid: string) => ({ collection: "locations" as const, uid });
const atOos = { collection: "out-of-service" as const, uid: OOS };
const atBooking = { collection: "bookings" as const, uid: BOOKING };

const line = (
  quantity: number,
  from: MovementLineType["location"]["from"],
  to: MovementLineType["location"]["to"],
): MovementLineType => ({ quantity, location: { from, to } });

const placements = new Map([
  [LOC_A, { uid_store: "teststore10000000000", store_name: "Main", name: "Shelf A", default: true, max: null }],
  [LOC_B, { uid_store: "teststore10000000000", store_name: "Main", name: "Shelf B", default: false, max: null }],
]);

function ledger(over: Partial<InventoryLedger> = {}): InventoryLedger {
  return {
    uid: "testprod100000000000",
    uid_product: "testprod100000000000",
    type: "rental",
    stock_method: "bulk",
    quantity_held: 0,
    quantity_in_service: 0,
    quantity_out_of_service: 0,
    average_unit_cost: 0,
    total_cost_basis: 0,
    out_of_service_breakdown: { cleaning: 0, damaged: 0, maintenance: 0, lost: 0 },
    store_breakdown: [],
    query_by_uid_store: [],
    query_by_uid_location: [],
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

// ── Conservation ────────────────────────────────────────────────────

Deno.test("a line entering ownership adds, leaving subtracts, moving does neither", () => {
  assertEquals(heldDelta(line(3, null, at(LOC_A))), 3, "entered ownership");
  assertEquals(heldDelta(line(3, at(LOC_A), null)), -3, "left ownership");
  assertEquals(heldDelta(line(3, at(LOC_A), at(LOC_B))), 0, "moved within ownership");
  assertEquals(heldDelta(line(3, at(LOC_A), atBooking)), 0, "out on a job is still owned");
  assertEquals(heldDelta(line(3, atBooking, atOos)), 0, "damaged is still owned");
});

Deno.test("a movement's held delta is the sum over its lines, with no cross-line term", () => {
  assertEquals(movementHeldDelta([line(2, at(LOC_A), atBooking), line(1, at(LOC_B), atBooking)]), 0);
  assertEquals(movementHeldDelta([line(2, null, at(LOC_A)), line(1, null, at(LOC_B))]), 3);
});

// ── Reversal ────────────────────────────────────────────────────────

Deno.test("negateLines swaps both sides and is its own inverse", () => {
  const lines = [line(2, at(LOC_A), atBooking), line(1, null, at(LOC_B))];
  const back = negateLines(lines);
  assertEquals(back[0].location.from, atBooking);
  assertEquals(back[0].location.to, at(LOC_A));
  assertEquals(back[1].location.from, at(LOC_B));
  assertEquals(back[1].location.to, null);
  assertEquals(negateLines(back), lines, "reversing a reversal is the original");
});

Deno.test("a reversal exactly cancels the original's held delta", () => {
  const lines = [line(2, null, at(LOC_A)), line(5, at(LOC_B), null)];
  assertEquals(movementHeldDelta(lines) + movementHeldDelta(negateLines(lines)), 0);
});

// ── Allocation direction ────────────────────────────────────────────

Deno.test("allocationSide follows the contract, so the client stays direction-agnostic", () => {
  assertEquals(allocationSide("check_out"), "from", "picked off a shelf");
  assertEquals(allocationSide("check_in"), "to", "put back on a shelf");
  assertEquals(allocationSide("purchase"), "to");
  assertEquals(allocationSide("transfer"), "both");
  assertEquals(allocationSide("prep"), null, "nothing moves");
  assertEquals(allocationSide("mark_damaged"), null, "booking → OOS, no shelf involved");
});

// ── Cost: checked against exact rational arithmetic ─────────────────

/** Exact reference: the true value of basis × quantity / held, half-up, in cents. */
function exactCostOfUnits(basisCents: bigint, held: number, quantity: number): bigint {
  if (held <= 0 || quantity <= 0 || basisCents <= 0n) return 0n;
  const num = basisCents * BigInt(quantity);
  const den = BigInt(held);
  const exact = (2n * num + den) / (2n * den);
  return exact > basisCents ? basisCents : exact;
}

Deno.test("costOfUnits matches exact rational arithmetic over 200k random draws", () => {
  let disagreements = 0;
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 200_000; i++) {
    const basisCents = BigInt(rand(50_000_00));
    const held = rand(500) + 1;
    const quantity = rand(held) + 1;
    if (costOfUnits(basisCents, held, quantity) !== exactCostOfUnits(basisCents, held, quantity)) {
      disagreements++;
    }
  }
  assertEquals(disagreements, 0);
});

Deno.test("cost divides LAST — the old average-then-multiply form loses cents", () => {
  // The predecessor computed average_unit_cost = basis / held (quantized) and
  // then multiplied by quantity. This is the shape where that diverges.
  const basisCents = 100_00n; // $100.00
  const held = 3;
  const quantity = 2;

  // Divide last, on exact cents: 10000 × 2 / 3 = 6666.67 → 6667 cents.
  assertEquals(costOfUnits(basisCents, held, quantity), 6667n);

  // Divide first at 2dp: 100.00/3 = 33.33; × 2 = 66.66 — a cent short.
  const averageFirst = Math.round((100 / 3) * 100) / 100 * quantity;
  assertEquals(Math.round(averageFirst * 100), 6666);
});

Deno.test("a decrease never removes more basis than exists", () => {
  // Rounding up on the last units out would otherwise leave a negative residue.
  assertEquals(costOfUnits(10n, 3, 3), 10n);
  assertEquals(costOfUnits(1n, 1, 1), 1n);
});

Deno.test("costOfUnits is zero for degenerate inputs rather than NaN or Infinity", () => {
  assertEquals(costOfUnits(100n, 0, 5), 0n, "nothing held");
  assertEquals(costOfUnits(100n, 5, 0), 0n, "nothing moved");
  assertEquals(costOfUnits(0n, 5, 2), 0n, "no basis");
});

// ── The fold ────────────────────────────────────────────────────────

Deno.test("a purchase adds basis and units, and lands them on the shelf", () => {
  const { ledger: next, costApplied } = applyMovementToLedger(
    ledger(),
    {
      type: "purchase",
      quantity: 10,
      lines: [line(10, null, at(LOC_A))],
      cost: { amount: 4000, unit_cost: 400, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 10);
  assertEquals(next.total_cost_basis, 4000);
  assertEquals(next.average_unit_cost, 400);
  assertEquals(costApplied, 4000);
  assertEquals(next.store_breakdown[0].locations[0].quantity, 10);
  assertEquals(next.store_breakdown[0].quantity, 10);
  assertEquals(next.query_by_uid_location, [LOC_A]);
});

Deno.test("a sale removes the weighted-average share, not the caller's number", () => {
  // The caller's `amount` here is revenue-shaped ($900 for 2 units bought at
  // $400). Trusting it is what let the basis drift from the quantity.
  const start = ledger({ quantity_held: 10, total_cost_basis: 4000, average_unit_cost: 400 });
  const { ledger: next, costApplied } = applyMovementToLedger(
    start,
    {
      type: "sale",
      quantity: 2,
      lines: [line(2, at(LOC_A), null)],
      cost: { amount: 900, unit_cost: 450, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 8);
  assertEquals(next.total_cost_basis, 3200, "2 × $400 of basis left, not $900");
  assertEquals(costApplied, -800);
  assertEquals(next.average_unit_cost, 400);
});

Deno.test("a transfer leaves the basis exactly where it was (#286 defect 1)", () => {
  const start = ledger({ quantity_held: 4, total_cost_basis: 1600, average_unit_cost: 400 });
  const { ledger: next, costApplied } = applyMovementToLedger(
    start,
    { type: "transfer", quantity: 4, lines: [line(4, at(LOC_A), at(LOC_B))], cost: null },
    placements,
    mockTimestamp,
  );
  assertEquals(next.total_cost_basis, 1600);
  assertEquals(next.average_unit_cost, 400);
  assertEquals(costApplied, 0);
  assertEquals(next.quantity_held, 4);
});

/** A ledger holding `n` units on Shelf A — the physically coherent starting state. */
function ledgerAtShelfA(n: number, over: Partial<InventoryLedger> = {}): InventoryLedger {
  return ledger({
    quantity_held: n,
    quantity_in_service: n,
    store_breakdown: [{
      uid_store: "teststore10000000000",
      name: "Main",
      default: true,
      crms_stock_level_id: null,
      quantity: n,
      locations: [{ uid_location: LOC_A, name: "Shelf A", default: true, max: null, quantity: n }],
    }],
    ...over,
  });
}

Deno.test("a full-quantity transfer through held=0 preserves the basis (#286 defect 2)", () => {
  // Zeroing on held===0 permanently destroyed the basis. A placement-only
  // movement cannot reach the zeroing branch at all now.
  const start = ledgerAtShelfA(4, { total_cost_basis: 1600, average_unit_cost: 400 });
  const { ledger: mid } = applyMovementToLedger(
    start,
    { type: "transfer", quantity: 4, lines: [line(4, at(LOC_A), at(LOC_B))], cost: null },
    placements,
    mockTimestamp,
  );
  assertEquals(mid.total_cost_basis, 1600);
  assertEquals(mid.store_breakdown[0].locations.find((l) => l.uid_location === LOC_A)?.quantity, 0);
  assertEquals(mid.store_breakdown[0].locations.find((l) => l.uid_location === LOC_B)?.quantity, 4);
});

Deno.test("selling the last unit zeroes both basis and average", () => {
  const start = ledger({ quantity_held: 1, total_cost_basis: 400, average_unit_cost: 400 });
  const { ledger: next } = applyMovementToLedger(
    start,
    {
      type: "sale",
      quantity: 1,
      lines: [line(1, at(LOC_A), null)],
      cost: { amount: 0, unit_cost: 0, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 0);
  assertEquals(next.total_cost_basis, 0, "a residue would corrupt the next purchase's average");
  assertEquals(next.average_unit_cost, 0);
});

Deno.test("the fold never mutates its input ledger", () => {
  const start = ledger({ quantity_held: 10, total_cost_basis: 4000, average_unit_cost: 400 });
  const snapshot = JSON.stringify(start);
  applyMovementToLedger(
    start,
    {
      type: "sale",
      quantity: 2,
      lines: [line(2, at(LOC_A), null)],
      cost: { amount: 900, unit_cost: 450, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(JSON.stringify(start), snapshot);
});

Deno.test("a movement into a never-held store creates the entry (#294)", () => {
  // The predecessor used `.find(...)!` and threw a raw TypeError mid-transaction.
  const { ledger: next } = applyMovementToLedger(
    ledger(),
    {
      type: "purchase",
      quantity: 5,
      lines: [line(5, null, at(LOC_B))],
      cost: { amount: 500, unit_cost: 100, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.store_breakdown.length, 1);
  assertEquals(next.store_breakdown[0].locations[0].uid_location, LOC_B);
});

Deno.test("two lines naming the same location sum rather than collide (#287)", () => {
  const { ledger: next } = applyMovementToLedger(
    ledger(),
    {
      type: "purchase",
      quantity: 5,
      lines: [line(3, null, at(LOC_A)), line(2, null, at(LOC_A))],
      cost: { amount: 500, unit_cost: 100, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.store_breakdown[0].locations.length, 1);
  assertEquals(next.store_breakdown[0].locations[0].quantity, 5);
});

// ── The three formerly-vestigial fields ─────────────────────────────

Deno.test("units at an OOS record leave service without leaving ownership", () => {
  const start = ledger({ quantity_held: 10, quantity_in_service: 10 });
  const derived = deriveServiceQuantities(start, [line(3, atBooking, atOos)]);
  assertEquals(derived.quantity_out_of_service, 3);
  assertEquals(derived.quantity_in_service, 7);
});

Deno.test("returning to service restores the in-service count", () => {
  const start = ledger({ quantity_held: 10, quantity_in_service: 7, quantity_out_of_service: 3 });
  const derived = deriveServiceQuantities(start, [line(3, atOos, at(LOC_A))]);
  assertEquals(derived.quantity_out_of_service, 0);
  assertEquals(derived.quantity_in_service, 10);
});

Deno.test("in_service and out_of_service always partition held", () => {
  // Before the journal, in_service moved in lockstep with held so it always
  // EQUALLED it, and out_of_service was written once as zero and never moved —
  // the ledger reported every product as 100% in service.
  const { ledger: next } = applyMovementToLedger(
    ledger({ quantity_held: 10, quantity_in_service: 10 }),
    { type: "mark_damaged", quantity: 4, lines: [line(4, atBooking, atOos)], cost: null },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 10, "damaged units are still owned");
  assertEquals(next.quantity_out_of_service, 4);
  assertEquals(next.quantity_in_service, 6);
  assertEquals(next.quantity_in_service + next.quantity_out_of_service, next.quantity_held);
});

Deno.test("a write-off removes ownership and clears the out-of-service count", () => {
  const { ledger: next } = applyMovementToLedger(
    ledger({ quantity_held: 10, quantity_in_service: 6, quantity_out_of_service: 4, total_cost_basis: 4000 }),
    {
      type: "write_off",
      quantity: 4,
      lines: [line(4, atOos, null)],
      cost: { amount: 0, unit_cost: 0, unit_costs: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 6);
  assertEquals(next.quantity_out_of_service, 0);
  assertEquals(next.quantity_in_service, 6);
  assertEquals(next.total_cost_basis, 2400, "4 units of basis written off at $400");
});

Deno.test("applyOutOfServiceReason clamps at zero and leaves other reasons alone", () => {
  const start = { cleaning: 0, damaged: 2, maintenance: 0, lost: 0 };
  assertEquals(applyOutOfServiceReason(start, "damaged", 3).damaged, 5);
  assertEquals(applyOutOfServiceReason(start, "damaged", -5).damaged, 0);
  assertEquals(applyOutOfServiceReason(start, "lost", 1), {
    cleaning: 0,
    damaged: 2,
    maintenance: 0,
    lost: 1,
  });
});
