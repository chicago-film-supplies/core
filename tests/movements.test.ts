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
import { MOVEMENT_CONTRACTS, MOVEMENT_TYPES } from "../src/schemas/mod.ts";
import type { InventoryLedger, MovementContract, MovementLineType } from "../src/schemas/mod.ts";
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
  [LOC_A, { uid_store: "teststore10000000000", store_name: "Main", store_default: true, name: "Shelf A", default: true, max: null }],
  [LOC_B, { uid_store: "teststore10000000000", store_name: "Main", store_default: true, name: "Shelf B", default: false, max: null }],
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
    total_cost_basis_cents: 0,
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
  // 🔴 These three ARE the place-model change, read through the one function the
  // client uses to decide which side it is picking. A damaged return names a
  // destination shelf exactly as a clean return does; a shelf-discovered loss
  // names the source shelf it is going missing from; and a found unit names the
  // shelf it comes back to. All three were `null` — "no shelf involved" — when
  // `damaged` and `lost` both meant "somewhere out of service".
  assertEquals(allocationSide("mark_damaged"), "to", "booking → shelf, same as check_in");
  assertEquals(allocationSide("mark_lost"), "from", "off a shelf, pending a resolution");
  assertEquals(allocationSide("return_to_service"), "to", "found, and back on a shelf");
});

// ── Cost: checked against exact rational arithmetic ─────────────────
//
// **This sweep was not a guard until 2026-08-01 (core#48), in two ways**, and
// recording both matters more than the green tick:
//
//   1. Its oracle was `costOfUnits` inlined — same guards, same
//      `(2n·num + den) / (2n·den)`, same clamp — so it could not disagree by
//      construction. The repair applied to `orders.test.ts` was never
//      back-ported to the file it had been copied FROM.
//   2. Its "fail-closed companion" was three hand-picked values, not a sweep
//      asserting a disagreement count.
//
// And the domain had a third hole nothing named: `quantity = rand(held) + 1`
// never exceeds `held`, and at `quantity === held` the draw lands on exactly
// `basisCents`, so **the clamp never executed in 200k draws**. It does now.
//
// The oracle below rounds by the DEFINITION — floor, then compare twice the
// remainder against the denominator — rather than by the implementation's
// `(2n + d) / 2d` identity. Same idiom as `calculateTransactionFeeAmount`'s
// reference in `orders.test.ts`: provably equal, structurally distinct, so a
// change to either arithmetic shows up as a disagreement.

/**
 * Exact reference: the true value of `basis × quantity / held`, half-up, in
 * cents, clamped to the basis.
 *
 * The guards and the clamp ARE the contract, so the oracle keeps them; what it
 * must not share is the arithmetic, and it does not.
 */
function exactCostOfUnits(basisCents: bigint, held: number, quantity: number): bigint {
  if (held <= 0 || quantity <= 0 || basisCents <= 0n) return 0n;
  const num = basisCents * BigInt(quantity);
  const den = BigInt(held);
  const floor = num / den; // non-negative, so truncation IS floor
  const remainder = num % den;
  const exact = 2n * remainder >= den ? floor + 1n : floor;
  return exact > basisCents ? basisCents : exact;
}

/**
 * The predecessor's shape, and the reason `costOfUnits` exists: derive the
 * per-unit average FIRST — quantizing it — then scale by the quantity.
 *
 * `applyMovementToLedger` used to read the stored (already-rounded)
 * `average_unit_cost` and multiply. The error is one of operation order, not
 * precision: a half-cent dropped from the average is multiplied up by every
 * unit drawn.
 */
function averageThenMultiply(basisCents: bigint, held: number, quantity: number): bigint {
  if (held <= 0 || quantity <= 0 || basisCents <= 0n) return 0n;
  const heldBig = BigInt(held);
  const average = (2n * basisCents + heldBig) / (2n * heldBig); // quantized here — the defect
  const drawn = average * BigInt(quantity);
  return drawn > basisCents ? basisCents : drawn;
}

interface CostDraw {
  basisCents: bigint;
  held: number;
  quantity: number;
}

/** Seeded LCG — same generator as `orders.test.ts`, so runs are reproducible. */
function sweepDraws(count: number): CostDraw[] {
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const draws: CostDraw[] = [];
  for (let i = 0; i < count; i++) {
    const held = rand(500) + 1;
    // One draw in eight OVER-draws, so the clamp is exercised. A draw of exactly
    // `held` lands on `basisCents` and slips past it.
    const quantity = rand(8) === 0 ? held + rand(10) + 1 : rand(held) + 1;
    draws.push({ basisCents: BigInt(rand(50_000_00)), held, quantity });
  }
  return draws;
}

const COST_SWEEP = sweepDraws(200_000);

Deno.test("costOfUnits matches exact rational arithmetic over 200k random draws", () => {
  let disagreements = 0;
  let first: string | null = null;
  for (const d of COST_SWEEP) {
    const got = costOfUnits(d.basisCents, d.held, d.quantity);
    const want = exactCostOfUnits(d.basisCents, d.held, d.quantity);
    if (got !== want) {
      disagreements++;
      first ??= `basis=${d.basisCents}c held=${d.held} qty=${d.quantity} → got ${got}, want ${want}`;
    }
  }
  assertEquals(disagreements, 0, first ?? "");
});

Deno.test("…and an average-then-multiply implementation DOES disagree — the sweep can fail", () => {
  // Fail-closed companion, and the reason to trust the test above. Without it an
  // oracle that had drifted into a restatement of the implementation would pass
  // forever and prove nothing — which is precisely what this file shipped until
  // core#48. A guard never seen to fail is not known to be a guard.
  let disagreements = 0;
  for (const d of COST_SWEEP) {
    if (
      averageThenMultiply(d.basisCents, d.held, d.quantity) !==
        exactCostOfUnits(d.basisCents, d.held, d.quantity)
    ) disagreements++;
  }
  assertEquals(
    disagreements > 0,
    true,
    "the average-then-multiply form agreed on all 200k draws — the oracle has stopped discriminating",
  );
  console.log(
    `  average-then-multiply mis-costs ${disagreements} of ${COST_SWEEP.length} draws ` +
      `(1 in ${Math.round(COST_SWEEP.length / disagreements)})`,
  );
});

Deno.test("the cost sweep exercises the over-draw clamp", () => {
  // The hole core#48 did not name: without over-draws the clamp is dead code in
  // the sweep, so a regression that removed it would still pass 200k draws.
  const clamped = COST_SWEEP.filter((d) =>
    d.basisCents > 0n && d.quantity > d.held &&
    exactCostOfUnits(d.basisCents, d.held, d.quantity) === d.basisCents
  );
  assertEquals(clamped.length > 1000, true, `only ${clamped.length} draws reach the clamp`);
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
  const { ledger: next, costAppliedCents } = applyMovementToLedger(
    ledger(),
    {
      reverses: null,
      type: "purchase",
      custody: null,
      quantity: 10,
      lines: [line(10, null, at(LOC_A))],
      cost: { amount_cents: 400000, unit_cost: 400, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 10);
  assertEquals(next.total_cost_basis_cents, 400000);
  assertEquals(next.average_unit_cost, 400);
  assertEquals(costAppliedCents, 400000);
  assertEquals(next.store_breakdown[0].locations[0].quantity, 10);
  assertEquals(next.store_breakdown[0].quantity, 10);
  assertEquals(next.query_by_uid_location, [LOC_A]);
});

Deno.test("a purchase reports its unit cost as a 4dp RATE, not cent-quantized money", () => {
  // The case the whole suite was blind to until 2026-08-03: every fixture
  // divided evenly, so the applier could switch between the cent form and the
  // 4dp form with nothing going red. 100 units for $6.39 is $0.0639/unit, and
  // reporting $0.06 is a 6% error on a figure that is only ever displayed.
  const { ledger: next, unitCost, costAppliedCents } = applyMovementToLedger(
    ledger(),
    {
      reverses: null,
      type: "purchase",
      custody: null,
      quantity: 100,
      lines: [line(100, null, at(LOC_A))],
      cost: { amount_cents: 639, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(unitCost, 0.0639);
  assertEquals(next.average_unit_cost, 0.0639);
  // The BASIS is money and stays at the cent — the rate got finer, the money
  // did not move.
  assertEquals(costAppliedCents, 639);
  assertEquals(next.total_cost_basis_cents, 639);
  assertEquals(next.quantity_held, 100);
});

Deno.test("a cost-bearing decrease reports its unit cost at 4dp too", () => {
  // The out-leg reads the weighted-average share, so it has the same rounding
  // decision and must make it the same way.
  const start = ledger({ quantity_held: 100, total_cost_basis_cents: 639, average_unit_cost: 0.0639 });
  const { ledger: next, unitCost } = applyMovementToLedger(
    start,
    {
      reverses: null,
      type: "sale",
      custody: null,
      quantity: 30,
      lines: [line(30, at(LOC_A), null)],
      cost: { amount_cents: 0, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  // 639 cents × 30 / 100 = 191.7 → 192 cents out; 192 / 30 = $0.064 per unit.
  assertEquals(unitCost, 0.064);
  assertEquals(next.quantity_held, 70);
  // Basis still money: $6.39 − $1.92.
  assertEquals(next.total_cost_basis_cents, 447);
  // And the ledger's average follows the same rule: 447 / 70 = $0.0639.
  assertEquals(next.average_unit_cost, 0.0639);
});

Deno.test("a placement stamps the store's and the location's identity, on create AND on refresh", () => {
  // `allocateBookingToStores` sorts on store.default, store.name and
  // location.default, so a fold that left them at ""/false would silently cost
  // the allocator its default-store-first and default-location-first ordering —
  // and the ledger is the only place those flags are denormalized.
  const { ledger: created } = applyMovementToLedger(
    ledger(),
    { reverses: null, type: "purchase", custody: null, quantity: 4, lines: [line(4, null, at(LOC_A))], cost: { amount_cents: 0, unit_cost: 0, unit_costs_cents: [] } },
    placements,
    mockTimestamp,
  );
  const store = created.store_breakdown[0];
  assertEquals(store.name, "Main", "a store new to the ledger carries its real name");
  assertEquals(store.default, true, "…and its real default flag");
  assertEquals(store.locations[0].name, "Shelf A");
  assertEquals(store.locations[0].default, true);

  // A ledger carrying a stale store name and a cleared default self-heals on the
  // next movement rather than needing a rename cascade of its own.
  const stale = ledger({
    quantity_held: 4,
    store_breakdown: [{
      uid_store: "teststore10000000000",
      name: "",
      default: false,
      crms_stock_level_id: null,
      quantity: 4,
      locations: [{ uid_location: LOC_A, name: "", default: false, max: null, quantity: 4 }],
    }],
  });
  const { ledger: healed } = applyMovementToLedger(
    stale,
    { reverses: null, type: "transfer", custody: null, quantity: 1, lines: [line(1, at(LOC_A), at(LOC_B))], cost: null },
    placements,
    mockTimestamp,
  );
  assertEquals(healed.store_breakdown[0].name, "Main");
  assertEquals(healed.store_breakdown[0].default, true);
  assertEquals(healed.store_breakdown[0].locations[0].name, "Shelf A");
  assertEquals(healed.store_breakdown[0].locations[0].default, true);
});

Deno.test("a sale removes the weighted-average share, not the caller's number", () => {
  // The caller's `amount` here is revenue-shaped ($900 for 2 units bought at
  // $400). Trusting it is what let the basis drift from the quantity.
  const start = ledger({ quantity_held: 10, total_cost_basis_cents: 400000, average_unit_cost: 400 });
  const { ledger: next, costAppliedCents } = applyMovementToLedger(
    start,
    {
      reverses: null,
      type: "sale",
      custody: null,
      quantity: 2,
      lines: [line(2, at(LOC_A), null)],
      cost: { amount_cents: 90000, unit_cost: 450, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 8);
  assertEquals(next.total_cost_basis_cents, 320000, "2 × $400 of basis left, not $900");
  assertEquals(costAppliedCents, -80000);
  assertEquals(next.average_unit_cost, 400);
});

// ── The cost-only shape: inert in the fold, and unwritable (core#75) ─
//
// The depreciation roadmap note in `schemas/transaction.ts` used to claim the
// movement shape for a cost-only event already existed — `lines: []` beside a
// `cost`. It does not, for two INDEPENDENT reasons, and each of these two tests
// pins one. Whoever teaches the system depreciation has to repeal both in one
// change, and repealing either alone leaves the other silently in force:
// relaxing the contract without extending the fold writes a document that moves
// no money, and extending the fold without the contract writes nothing at all.

Deno.test("a cost-only fold is inert: `lines: []` beside a cost moves no basis", () => {
  // ⚠️ This object is deliberately NOT a legal document — `MovementSchema`
  // rejects `lines: []` on every cost-bearing type (the companion test below is
  // why). It is called directly because inertness is a property of the fold,
  // which is pure, and holds regardless of what can currently reach it.
  const start = ledger({ quantity_held: 100, quantity_in_service: 100 });
  const cost = { amount_cents: 50000, unit_cost: 0, unit_costs_cents: [] };

  const { ledger: inert, costAppliedCents: none } = applyMovementToLedger(
    start,
    { reverses: null, type: "purchase", custody: null, quantity: 0, lines: [], cost },
    placements,
    mockTimestamp,
  );
  assertEquals(movementHeldDelta([]), 0, "no lines, no delta");
  assertEquals(inert.total_cost_basis_cents, 0, "delta === 0 falls through both cost branches");
  assertEquals(none, 0, "nothing was applied, so nothing is there for a reversal to restore");
  assertEquals(inert.quantity_held, 100);

  // Fail-closed companion: the SAME ledger and the SAME cost DO move the basis
  // the moment one line carries units, so the zeros above are the `delta === 0`
  // fall-through and not a fixture that could never have moved anything.
  const { ledger: moved, costAppliedCents: applied } = applyMovementToLedger(
    start,
    { reverses: null, type: "purchase", custody: null, quantity: 10, lines: [line(10, null, at(LOC_A))], cost },
    placements,
    mockTimestamp,
  );
  assertEquals(moved.total_cost_basis_cents, 50000);
  assertEquals(applied, 50000);
  assertEquals(moved.quantity_held, 110);
});

Deno.test("no contract pairs `places: null` with a required cost — the fold could not fold it", () => {
  // `places: null` ⇒ lines must be empty, so this pairing IS the cost-only
  // shape, expressed in the one table that decides what a document may carry.
  const costOnly = (c: MovementContract) => c.places === null && c.cost === "required";

  for (const type of MOVEMENT_TYPES) {
    assertEquals(
      costOnly(MOVEMENT_CONTRACTS[type]),
      false,
      `${type} would be a cost-only movement, and the fold above ignores those`,
    );
  }

  // Self-verifying: the loop only ever reports the ABSENCE of a member, which a
  // predicate that can never return true reports just as cleanly. Plant the
  // depreciation-shaped contract this exists to catch and assert it is caught.
  assertEquals(
    costOnly({ custody: "forbidden", cost: "required", places: null, booking: "forbidden" }),
    true,
    "a planted cost-only contract must be caught",
  );
});

Deno.test("a transfer leaves the basis exactly where it was (#286 defect 1)", () => {
  const start = ledger({ quantity_held: 4, total_cost_basis_cents: 160000, average_unit_cost: 400 });
  const { ledger: next, costAppliedCents } = applyMovementToLedger(
    start,
    { reverses: null, type: "transfer", custody: null, quantity: 4, lines: [line(4, at(LOC_A), at(LOC_B))], cost: null },
    placements,
    mockTimestamp,
  );
  assertEquals(next.total_cost_basis_cents, 160000);
  assertEquals(next.average_unit_cost, 400);
  assertEquals(costAppliedCents, 0);
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
  const start = ledgerAtShelfA(4, { total_cost_basis_cents: 160000, average_unit_cost: 400 });
  const { ledger: mid } = applyMovementToLedger(
    start,
    { reverses: null, type: "transfer", custody: null, quantity: 4, lines: [line(4, at(LOC_A), at(LOC_B))], cost: null },
    placements,
    mockTimestamp,
  );
  assertEquals(mid.total_cost_basis_cents, 160000);
  assertEquals(mid.store_breakdown[0].locations.find((l) => l.uid_location === LOC_A)?.quantity, 0);
  assertEquals(mid.store_breakdown[0].locations.find((l) => l.uid_location === LOC_B)?.quantity, 4);
});

Deno.test("selling the last unit zeroes both basis and average", () => {
  const start = ledger({ quantity_held: 1, total_cost_basis_cents: 40000, average_unit_cost: 400 });
  const { ledger: next } = applyMovementToLedger(
    start,
    {
      reverses: null,
      type: "sale",
      custody: null,
      quantity: 1,
      lines: [line(1, at(LOC_A), null)],
      cost: { amount_cents: 0, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 0);
  assertEquals(next.total_cost_basis_cents, 0, "a residue would corrupt the next purchase's average");
  assertEquals(next.average_unit_cost, 0);
});

Deno.test("the fold never mutates its input ledger", () => {
  const start = ledger({ quantity_held: 10, total_cost_basis_cents: 400000, average_unit_cost: 400 });
  const snapshot = JSON.stringify(start);
  applyMovementToLedger(
    start,
    {
      reverses: null,
      type: "sale",
      custody: null,
      quantity: 2,
      lines: [line(2, at(LOC_A), null)],
      cost: { amount_cents: 90000, unit_cost: 450, unit_costs_cents: [] },
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
      reverses: null,
      type: "purchase",
      custody: null,
      quantity: 5,
      lines: [line(5, null, at(LOC_B))],
      cost: { amount_cents: 50000, unit_cost: 100, unit_costs_cents: [] },
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
      reverses: null,
      type: "purchase",
      custody: null,
      quantity: 5,
      lines: [line(3, null, at(LOC_A)), line(2, null, at(LOC_A))],
      cost: { amount_cents: 50000, unit_cost: 100, unit_costs_cents: [] },
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
  const derived = deriveServiceQuantities(start, [line(3, atBooking, atOos)], null);
  assertEquals(derived.quantity_out_of_service, 3);
  assertEquals(derived.quantity_in_service, 7);
});

Deno.test("returning to service restores the in-service count", () => {
  const start = ledger({ quantity_held: 10, quantity_in_service: 7, quantity_out_of_service: 3 });
  const derived = deriveServiceQuantities(start, [line(3, atOos, at(LOC_A))], null);
  assertEquals(derived.quantity_out_of_service, 0);
  assertEquals(derived.quantity_in_service, 10);
});

// ── The in-place term: `damaged` is a STATE, not a place ────────────

Deno.test("a damaged unit leaves service WITHOUT leaving its shelf", () => {
  // The whole point of the state/place split. The line is `bookings → locations`
  // — identical to a clean `check_in` — so the placement term sees nothing, and
  // reading placement alone would report a broken unit as fully in service.
  const start = ledger({ quantity_held: 10, quantity_in_service: 10 });
  const derived = deriveServiceQuantities(
    start,
    [line(3, atBooking, at(LOC_A))],
    { from: "out", to: "damaged" },
  );
  assertEquals(derived.quantity_out_of_service, 3);
  assertEquals(derived.quantity_in_service, 7);
});

Deno.test("a clean return moves nothing out of service", () => {
  // The discriminator is the custody key alone: same type of line, same places,
  // same quantity as the damaged case above. Without this the previous test
  // passes against an implementation that counts every `bookings → locations`
  // line.
  const start = ledger({ quantity_held: 10, quantity_in_service: 10 });
  const derived = deriveServiceQuantities(
    start,
    [line(3, atBooking, at(LOC_A))],
    { from: "out", to: "returned" },
  );
  assertEquals(derived.quantity_out_of_service, 0);
  assertEquals(derived.quantity_in_service, 10);
});

Deno.test("the placement and in-place terms cannot double-count", () => {
  // Disjoint by construction rather than by a guard: `CUSTODY_PLACE_KINDS.damaged`
  // is `["locations"]`, so a movement carrying `custody.to === "damaged"` cannot
  // also name an out-of-service place on that side — rule 3 of the balance
  // checker refuses it. This asserts the arithmetic consequence: a lost unit is
  // counted once by placement and a damaged unit once by state, never both.
  const start = ledger({ quantity_held: 10, quantity_in_service: 10 });
  const lost = deriveServiceQuantities(start, [line(2, atBooking, atOos)], {
    from: "out",
    to: "lost",
  });
  assertEquals(lost.quantity_out_of_service, 2, "placement term only");

  const damaged = deriveServiceQuantities(start, [line(2, atBooking, at(LOC_A))], {
    from: "out",
    to: "damaged",
  });
  assertEquals(damaged.quantity_out_of_service, 2, "state term only");
});

Deno.test("a LEGACY mark_damaged row is counted once, not twice", () => {
  // 🔴 The regression this guard exists for, and it is about STORED data rather
  // than about anything a writer can emit now. Measured 2026-09-19: all 4
  // `mark_damaged` movements in prod and all 4 in dev carry `bookings →
  // out-of-service` AND `custody.to === "damaged"` — legal under the old model,
  // and satisfying BOTH terms under this one. Rule 3 refuses this shape going
  // forward, but rule 3 only ever ran at write time, so it cannot speak for a
  // row already in the corpus.
  //
  // Without the guard this returns 8 on a 4-unit movement, and the two audit
  // scripts that replay the whole journal would report every one of those
  // products as twice as broken as it is.
  const start = ledger({ quantity_held: 10, quantity_in_service: 10 });
  const legacy = deriveServiceQuantities(start, [line(4, atBooking, atOos)], {
    from: "out",
    to: "damaged",
  });
  assertEquals(legacy.quantity_out_of_service, 4, "counted by placement, once");
  assertEquals(legacy.quantity_in_service, 6);
});

Deno.test("in_service and out_of_service always partition held", () => {
  // Before the journal, in_service moved in lockstep with held so it always
  // EQUALLED it, and out_of_service was written once as zero and never moved —
  // the ledger reported every product as 100% in service.
  //
  // ⚠️ The fixture moved with the model: this was `bookings → out-of-service`
  // with no custody, which is now an illegal `mark_damaged` line AND would
  // report zero out of service. A damaged return goes to the SHELF and carries
  // its state on the custody axis — that is the whole change.
  const { ledger: next } = applyMovementToLedger(
    ledger({ quantity_held: 10, quantity_in_service: 10 }),
    {
      reverses: null,
      type: "mark_damaged",
      custody: { from: "out", to: "damaged" },
      quantity: 4,
      lines: [line(4, atBooking, at(LOC_A))],
      cost: null,
    },
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
    ledger({ quantity_held: 10, quantity_in_service: 6, quantity_out_of_service: 4, total_cost_basis_cents: 400000 }),
    {
      reverses: null,
      type: "write_off",
      custody: null,
      quantity: 4,
      lines: [line(4, atOos, null)],
      cost: { amount_cents: 0, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.quantity_held, 6);
  assertEquals(next.quantity_out_of_service, 0);
  assertEquals(next.quantity_in_service, 6);
  assertEquals(next.total_cost_basis_cents, 240000, "4 units of basis written off at $400");
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

// ── A reversal reverses EXACTLY (api-cloudrun#1069) ──────────────────

/**
 * The prod history of Metro Rack - 3 Tier `mQNwG1fQQsfITtpaefE4`, verbatim.
 *
 * ⭐ It is a fixture rather than a scenario because the owner stated the answer
 * for it: *"a reversal should reverse exactly, yes i misentered the transaction
 * info twice"* — #2292 and #2294 are one purchase keyed twice, #2293 and #2296
 * are their corrections, and **the correct basis is $149.96**: the `find` of 2
 * at $0.00 plus the one real purchase.
 *
 * ⚠️ Before this fix the journal replayed to $224.94 and the stored ledger held
 * $299.92 — two different wrong numbers, differing only in how many reversals
 * each had folded.
 */
Deno.test("a reversal of a purchase relieves EXACTLY what it added (api-cloudrun#1069)", () => {
  const cost = (cents: number) => ({ amount_cents: cents, unit_cost: 0, unit_costs_cents: [] });
  const journal = [
    // #2291 find +2 @ $0.00
    { reverses: null, type: "find" as const, custody: null, quantity: 2, lines: [line(2, null, at(LOC_A))], cost: cost(0) },
    // #2297 purchase +1 @ $149.96
    { reverses: null, type: "purchase" as const, custody: null, quantity: 1, lines: [line(1, null, at(LOC_A))], cost: cost(14996) },
    // #2292 purchase +2 @ $149.96  — the mis-key
    { reverses: null, type: "purchase" as const, custody: null, quantity: 2, lines: [line(2, null, at(LOC_A))], cost: cost(14996) },
    // #2294 purchase +1 @ $149.96  — the mis-key again
    { reverses: null, type: "purchase" as const, custody: null, quantity: 1, lines: [line(1, null, at(LOC_A))], cost: cost(14996) },
    // #2293 reverses #2292
    { reverses: "m2292", type: "purchase" as const, custody: null, quantity: 2, lines: [line(2, at(LOC_A), null)], cost: cost(-14996) },
    // #2296 reverses #2294
    { reverses: "m2294", type: "purchase" as const, custody: null, quantity: 1, lines: [line(1, at(LOC_A), null)], cost: cost(-14996) },
  ];

  let folded = ledger();
  for (const m of journal) folded = applyMovementToLedger(folded, m, placements, mockTimestamp).ledger;

  assertEquals(folded.quantity_held, 3, "quantities were never the defect");
  assertEquals(
    folded.total_cost_basis_cents,
    14996,
    "the find at $0.00 plus the one real purchase — NOT the $224.94 a weighted-average relief left",
  );
});

Deno.test("reversing an increase is exact even when an unrelated purchase intervenes", () => {
  // 🔴 This is what a weighted-average relief cannot do, and it is the whole
  // point: the relief must not depend on a purchase that has nothing to do with
  // the movement being undone.
  const cost = (cents: number) => ({ amount_cents: cents, unit_cost: 0, unit_costs_cents: [] });
  let folded = ledger();
  for (
    const m of [
      { reverses: null, type: "purchase" as const, custody: null, quantity: 1, lines: [line(1, null, at(LOC_A))], cost: cost(10000) },
      { reverses: null, type: "purchase" as const, custody: null, quantity: 9, lines: [line(9, null, at(LOC_A))], cost: cost(900) },
      { reverses: "m1", type: "purchase" as const, custody: null, quantity: 1, lines: [line(1, at(LOC_A), null)], cost: cost(-10000) },
    ]
  ) folded = applyMovementToLedger(folded, m, placements, mockTimestamp).ledger;

  assertEquals(folded.quantity_held, 9);
  // A weighted-average share of $109.00 over 10 units is $10.90 — which would
  // leave $98.10 standing for nine units that cost $9.00.
  assertEquals(folded.total_cost_basis_cents, 900);
});

Deno.test("⚠️ reversing a DECREASE was already exact, and is unchanged (#1159)", () => {
  // The `delta > 0` branch has always added `cost.amount_cents` directly, and
  // `reverseTransaction` negates the amount the applier STORED. So #1159's
  // positive $1.23 on an `adjustment_decrease` restores exactly what #1158
  // relieved — it is not an operator compensating for the defect above.
  const start = ledger({ quantity_held: 1, total_cost_basis_cents: 0, average_unit_cost: 0 });
  const { ledger: next, basisUnderflowCents } = applyMovementToLedger(
    start,
    {
      reverses: "m1158",
      type: "adjustment_decrease",
      custody: null,
      quantity: 1,
      lines: [line(1, null, at(LOC_A))],
      cost: { amount_cents: 123, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.total_cost_basis_cents, 123);
  assertEquals(basisUnderflowCents, 0);
});

Deno.test("🔴 a reversal relieving more basis than exists REPORTS the shortfall", () => {
  // It is neither thrown nor clamped: a clamp makes the reversal inexact again,
  // and a throw would abort the corpus-wide replay scans mid-run.
  const start = ledger({ quantity_held: 2, total_cost_basis_cents: 5000, average_unit_cost: 2500 });
  const { ledger: next, costAppliedCents, basisUnderflowCents } = applyMovementToLedger(
    start,
    {
      reverses: "mX",
      type: "purchase",
      custody: null,
      quantity: 1,
      lines: [line(1, at(LOC_A), null)],
      cost: { amount_cents: -8000, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(basisUnderflowCents, 3000);
  assertEquals(costAppliedCents, -8000, "the relief stays EXACT — the shortfall is reported, not absorbed");
  assertEquals(next.total_cost_basis_cents, -3000);
});

Deno.test("a non-reversal decrease still relieves the weighted-average share", () => {
  // The rule this fix must NOT widen: on a `sale` the caller's number is
  // REVENUE, so relieving it would book revenue as cost.
  const start = ledger({ quantity_held: 4, total_cost_basis_cents: 40000, average_unit_cost: 100 });
  const { ledger: next, basisUnderflowCents } = applyMovementToLedger(
    start,
    {
      reverses: null,
      type: "sale",
      custody: null,
      quantity: 1,
      lines: [line(1, at(LOC_A), null)],
      cost: { amount_cents: 99900, unit_cost: 0, unit_costs_cents: [] },
    },
    placements,
    mockTimestamp,
  );
  assertEquals(next.total_cost_basis_cents, 30000, "a quarter of the basis, never the $999 of revenue");
  assertEquals(basisUnderflowCents, 0, "costOfUnits caps at the basis, so it can never underflow");
});
