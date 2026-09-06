import { assertEquals } from "@std/assert";
import {
  actionAlternatesForBooking,
  actionableQtyTowardTarget,
  bookingsComplete,
  bucketsForBookingSide,
  bucketsForStageSide,
  canPrepCheckout,
  checkoutableQuantity,
  checkoutUnits,
  custodyMovedQuantity,
  FULFILLMENT_STAGE_LABELS,
  FULFILLMENT_STAGES,
  getStageForBookings,
  naturalNextActionForBooking,
  qtyOnStageSide,
  regressionAlternatesForBooking,
  returnableQuantity,
  sourceBucketSizeForBooking,
  STAGE_SOURCE,
  STAGE_TARGET,
} from "../src/utils/fulfillment-stage.ts";
import { BOOKING_BREAKDOWN_LABELS, type Booking } from "../src/schemas/mod.ts";

/**
 * The three fields every predicate here reads. Deliberately NOT a whole
 * `Booking` behind a cast: each export takes a `Pick<Booking, …>`, so a
 * minimal literal type-checks and a field one of them starts reading without
 * declaring becomes a compile error rather than a silent `undefined`.
 */
function bk(
  breakdown: Partial<Booking["breakdown"]>,
  type: Booking["type"] = "rental",
  status: Booking["status"] = "reserved",
): Pick<Booking, "type" | "status" | "breakdown"> {
  return {
    type,
    status,
    breakdown: {
      damaged: 0,
      lost: 0,
      out: 0,
      prepped: 0,
      quoted: 0,
      reserved: 0,
      returned: 0,
      ...breakdown,
    },
  };
}

// ── the stage vocabulary itself ──────────────────────────────────────────────

Deno.test("every stage is labelled, and the label table has no extra members", () => {
  // A population assertion beside the declaration: the two property tests below
  // would both pass over an empty stage list.
  assertEquals(FULFILLMENT_STAGES.length, 5);
  assertEquals(
    Object.keys(FULFILLMENT_STAGE_LABELS).sort(),
    [...FULFILLMENT_STAGES].sort(),
  );
  for (const stage of FULFILLMENT_STAGES) {
    assertEquals(FULFILLMENT_STAGE_LABELS[stage].length > 0, true, `${stage} has no label`);
  }
});

Deno.test("STAGE_SOURCE / STAGE_TARGET pairs match the lifecycle", () => {
  assertEquals(STAGE_SOURCE.prep, "reserved");
  assertEquals(STAGE_TARGET.prep, "prepped");
  assertEquals(STAGE_SOURCE.checkout, "prepped");
  assertEquals(STAGE_TARGET.checkout, "out");
  assertEquals(STAGE_SOURCE.return, "out");
  assertEquals(STAGE_TARGET.return, "returned");
});

Deno.test("the bucket labels the picker renders come from the schema declaration", () => {
  // The now-deleted `manager/src/utils/fulfillmentStage.ts` carried its own
  // `BUCKET_LABEL` map restating all seven, and the two had already diverged on
  // `out`. This is the arm that would go red if a copy reappeared and drifted.
  assertEquals(BOOKING_BREAKDOWN_LABELS.out, "Checked Out");
  assertEquals(BOOKING_BREAKDOWN_LABELS.quoted, "Quoted");
  assertEquals(Object.keys(BOOKING_BREAKDOWN_LABELS).length, 7);
});

// ── getStageForBookings ──────────────────────────────────────────────────────

Deno.test("getStageForBookings: 'prep' when any booking has reserved > 0", () => {
  assertEquals(getStageForBookings([bk({ reserved: 3 }), bk({ prepped: 2 })]), "prep");
});

Deno.test("getStageForBookings: 'checkout' when nothing is reserved but something is prepped", () => {
  assertEquals(getStageForBookings([bk({ prepped: 3 }), bk({ out: 2 })]), "checkout");
});

Deno.test("getStageForBookings: 'return' when only 'out' is non-zero among non-terminal buckets", () => {
  assertEquals(getStageForBookings([bk({ out: 3 }), bk({ returned: 2 })]), "return");
});

Deno.test("getStageForBookings: 'complete' when everything is in terminal buckets", () => {
  assertEquals(getStageForBookings([bk({ returned: 3 }), bk({ lost: 1, damaged: 1 })]), "complete");
});

Deno.test("getStageForBookings: an empty list is complete, not quoted", () => {
  assertEquals(getStageForBookings([]), "complete");
});

// ── custodyMovedQuantity ─────────────────────────────────────────────────────
//
// Replaced `partitionByStage` in beta.349. The first arm below is the one that
// retired it: `partitionByStage(bookings, "prep")` puts a purely-`quoted`
// booking on the TARGET side, because it partitions on the source bucket
// (`reserved`) and `quoted` is not it — so the server freeze predicate
// api-cloudrun#880 needed would have frozen an order that had not been reserved.

Deno.test("custodyMovedQuantity: allocation buckets are NOT custody", () => {
  // The `partitionByStage` trap, asserted directly: `quoted` is pre-reserve.
  assertEquals(custodyMovedQuantity(bk({ quoted: 5 })), 0);
  assertEquals(custodyMovedQuantity(bk({ reserved: 5 })), 0);
  assertEquals(custodyMovedQuantity(bk({ quoted: 2, reserved: 3 })), 0);
  assertEquals(custodyMovedQuantity(bk({})), 0);
});

Deno.test("custodyMovedQuantity: a PARTIAL prep counts only the prepped units", () => {
  // `part-prepped` is a status, not a bucket — partial prep is `prepped > 0`
  // co-existing with `reserved > 0`, and it is the case that decides whether
  // the freeze is per-row-wholesale or per-quantity.
  assertEquals(custodyMovedQuantity(bk({ reserved: 1, prepped: 2 })), 2);
  assertEquals(custodyMovedQuantity(bk({ quoted: 4, reserved: 1, prepped: 1 })), 1);
});

Deno.test("custodyMovedQuantity: `out` counts for a SALE as well as a rental", () => {
  // Type-independent on purpose, unlike `returnableQuantity`. A sold unit that
  // has left the building has moved custody every bit as much as a rented one,
  // and is less recoverable — the type only decides whether it needs returning.
  assertEquals(custodyMovedQuantity(bk({ out: 3 }, "rental")), 3);
  assertEquals(custodyMovedQuantity(bk({ out: 3 }, "sale")), 3);
  assertEquals(returnableQuantity(bk({ out: 3 }, "rental")), 3);
  assertEquals(returnableQuantity(bk({ out: 3 }, "sale")), 0);
});

Deno.test("custodyMovedQuantity: terminal buckets are custody, and it sums", () => {
  assertEquals(custodyMovedQuantity(bk({ returned: 3 })), 3);
  assertEquals(custodyMovedQuantity(bk({ lost: 2 })), 2);
  assertEquals(custodyMovedQuantity(bk({ damaged: 1 })), 1);
  assertEquals(
    custodyMovedQuantity(bk({ quoted: 9, reserved: 9, prepped: 1, out: 2, returned: 3, lost: 4, damaged: 5 })),
    15,
  );
});

/**
 * The corpus for the nesting property below — one booking per interesting
 * position in the lifecycle, both types.
 */
const CUSTODY_CORPUS = (["rental", "sale"] as const).flatMap((t) => [
  bk({}, t),
  bk({ quoted: 3 }, t),
  bk({ reserved: 3 }, t),
  bk({ quoted: 1, reserved: 2 }, t),
  bk({ reserved: 1, prepped: 2 }, t),
  bk({ prepped: 3 }, t),
  bk({ prepped: 1, out: 2 }, t),
  bk({ out: 3 }, t),
  bk({ out: 1, returned: 2 }, t),
  bk({ returned: 1, lost: 1, damaged: 1 }, t),
]);

Deno.test("custodyMovedQuantity is the WIDEST target side — the freeze can never be narrower than a rendering predicate", () => {
  // 🔴 The relationship to the picker's `qtyOnStageSide(b, stage, "target") > 0`,
  // which is a DIFFERENT question (its boundary moves with the section's stage)
  // but must never exceed this one. `TARGET_BUCKETS.prep` is the widest set, so
  // a row the picker draws as already-actioned at ANY stage is always a row this
  // predicate refuses to let an order edit rewrite. An edit to the bucket tables
  // that inverted this would silently un-freeze picked rows.
  for (const b of CUSTODY_CORPUS) {
    const custody = custodyMovedQuantity(b);
    for (const stage of FULFILLMENT_STAGES) {
      const onTarget = qtyOnStageSide(b, stage, "target");
      if (onTarget > custody) {
        throw new Error(
          `qtyOnStageSide(_, "${stage}", "target") = ${onTarget} exceeds ` +
            `custodyMovedQuantity = ${custody} for ${JSON.stringify(b.breakdown)} (${b.type})`,
        );
      }
    }
  }
});

Deno.test("...and the implication is STRICTLY one-directional", () => {
  // Pairs with the arm above: without this, that loop would pass just as well
  // if the two were the same function. A fully-prepped booking has moved
  // custody and sits on NO stage-`return` target bucket.
  const prepped = bk({ prepped: 3 });
  assertEquals(custodyMovedQuantity(prepped), 3);
  assertEquals(qtyOnStageSide(prepped, "return", "target"), 0);
  assertEquals(qtyOnStageSide(prepped, "checkout", "target"), 0);
});

// ── naturalNextActionForBooking ──────────────────────────────────────────────

Deno.test("naturalNextActionForBooking walks the lifecycle", () => {
  assertEquals(naturalNextActionForBooking(bk({ reserved: 3 })), "prep");
  assertEquals(naturalNextActionForBooking(bk({ prepped: 3 })), "checkout");
  assertEquals(naturalNextActionForBooking(bk({ out: 3 })), "return");
  assertEquals(naturalNextActionForBooking(bk({ returned: 2, lost: 1 })), "complete");
});

Deno.test("naturalNextActionForBooking prioritises the earliest non-empty source", () => {
  assertEquals(naturalNextActionForBooking(bk({ reserved: 1, prepped: 2 })), "prep");
  assertEquals(naturalNextActionForBooking(bk({ prepped: 1, out: 2 })), "checkout");
});

// ── actionAlternatesForBooking ───────────────────────────────────────────────

Deno.test("actionAlternatesForBooking offers prep + skip-ahead for a reserved booking", () => {
  assertEquals(
    actionAlternatesForBooking(bk({ reserved: 3 })).map((a) => a.label),
    ["Prep", "Check Out", "Mark Returned", "Mark Lost", "Mark Damaged"],
  );
});

Deno.test("actionAlternatesForBooking drops 'Prep' for a prepped booking", () => {
  assertEquals(
    actionAlternatesForBooking(bk({ prepped: 3 })).map((a) => a.label),
    ["Check Out", "Mark Returned", "Mark Lost", "Mark Damaged"],
  );
});

Deno.test("actionAlternatesForBooking offers only the return splits for an out booking", () => {
  assertEquals(
    actionAlternatesForBooking(bk({ out: 3 })).map((a) => a.label),
    ["Mark Returned", "Mark Lost", "Mark Damaged"],
  );
});

Deno.test("actionAlternatesForBooking offers nothing for a terminal booking", () => {
  assertEquals(actionAlternatesForBooking(bk({ returned: 3 })), []);
});

// ── sourceBucketSizeForBooking ───────────────────────────────────────────────

Deno.test("sourceBucketSizeForBooking reads the natural action's source bucket", () => {
  assertEquals(sourceBucketSizeForBooking(bk({ reserved: 3, prepped: 2 })), 3);
  assertEquals(sourceBucketSizeForBooking(bk({ prepped: 3 })), 3);
  assertEquals(sourceBucketSizeForBooking(bk({ returned: 3 })), 0);
});

// ── non-rental `out` is terminal (matches isBookingClosed) ───────────────────

Deno.test("a sale that is out does NOT hold the destination at 'return'", () => {
  assertEquals(getStageForBookings([bk({ out: 3 }, "sale")]), "complete");
  assertEquals(getStageForBookings([bk({ out: 3 }, "rental")]), "return");
});

Deno.test("a mixed destination stays at 'return' only for the rental's out", () => {
  assertEquals(getStageForBookings([bk({ out: 3 }, "sale"), bk({ out: 2 }, "rental")]), "return");
});

Deno.test("naturalNext for a sale-out is 'complete', not 'return'", () => {
  assertEquals(naturalNextActionForBooking(bk({ out: 3 }, "sale")), "complete");
});

Deno.test("a sale-out is closed per bookingsComplete", () => {
  assertEquals(bookingsComplete([bk({ out: 3 }, "sale")]), true);
  assertEquals(bookingsComplete([bk({ out: 3 }, "rental")]), false);
});

Deno.test("a sale-out STILL offers Return/Lost/Damaged (optional, not required)", () => {
  assertEquals(
    actionAlternatesForBooking(bk({ out: 3 }, "sale")).map((a) => a.label),
    ["Mark Returned", "Mark Lost", "Mark Damaged"],
  );
});

Deno.test("a sale-out sits on the target side, a rental-out on the source side", () => {
  const sale = bk({ out: 3 }, "sale");
  const rental = bk({ out: 3 }, "rental");
  assertEquals(qtyOnStageSide(rental, "return", "source"), 3);
  assertEquals(qtyOnStageSide(rental, "return", "target"), 0);
  assertEquals(qtyOnStageSide(sale, "return", "source"), 0);
  assertEquals(qtyOnStageSide(sale, "return", "target"), 3);
  assertEquals(bucketsForBookingSide(sale, "return", "target").includes("out"), true);
});

// ── returnableQuantity ───────────────────────────────────────────────────────

Deno.test("returnableQuantity offers a rental's out units", () => {
  assertEquals(returnableQuantity(bk({ out: 3 }, "rental")), 3);
});

Deno.test("🔴 returnableQuantity offers NOTHING for a sale, whose out is terminal", () => {
  // Checkout IS delivery for a sale — the units do not come back. Offering the
  // row lets a worker return sold goods, writing stock back into inventory that
  // was never coming, and the booking afterwards is indistinguishable from a
  // returned rental.
  //
  // Measured on prod 2026-08-27: all 380 bookings with a terminal `out > 0` are
  // sales (complete rentals with out > 0: 0). A repair that moved out → returned
  // on them would have asserted 23,440 units of sold goods back into stock.
  assertEquals(returnableQuantity(bk({ out: 5 }, "sale")), 0);
});

Deno.test("returnableQuantity offers nothing for the other non-rental types either", () => {
  // The rule is "rental", not "not sale" — a `service` or `surcharge` line has
  // no units to hand back, and defaulting them to returnable would be the same
  // defect with a rarer trigger.
  assertEquals(returnableQuantity(bk({ out: 1 }, "service")), 0);
  assertEquals(returnableQuantity(bk({ out: 1 }, "surcharge")), 0);
});

Deno.test("returnableQuantity counts only `out`, not the terminal buckets beside it", () => {
  assertEquals(returnableQuantity(bk({ prepped: 5 }, "rental")), 0);
  assertEquals(returnableQuantity(bk({ returned: 5 }, "rental")), 0);
  assertEquals(returnableQuantity(bk({ out: 2, returned: 3 }, "rental")), 2);
});

// ── quoted is a pre-reserve stage, not 'complete' ────────────────────────────

Deno.test("an all-quoted set yields the 'quoted' stage, not 'complete'", () => {
  assertEquals(getStageForBookings([bk({ quoted: 3 })]), "quoted");
});

Deno.test("a mix of quoted + reserved prioritises the actionable 'prep' stage", () => {
  assertEquals(getStageForBookings([bk({ quoted: 3 }), bk({ reserved: 2 })]), "prep");
});

Deno.test("'quoted' is a SOURCE-side bucket at the quoted stage, so it renders", () => {
  assertEquals(bucketsForStageSide("quoted", "source"), ["quoted"]);
  assertEquals(qtyOnStageSide(bk({ quoted: 3 }), "quoted", "source"), 3);
});

// ── actionableQtyTowardTarget ────────────────────────────────────────────────

Deno.test("actionableQtyTowardTarget: checkout sweeps reserved straight to out", () => {
  assertEquals(actionableQtyTowardTarget(bk({ reserved: 3 }), "checkout"), 3);
});

Deno.test("actionableQtyTowardTarget: prep on a reserved booking is the Auto-equivalent", () => {
  assertEquals(actionableQtyTowardTarget(bk({ reserved: 3 }), "prep"), 3);
});

Deno.test("actionableQtyTowardTarget excludes a prepped-only booking from Prep", () => {
  assertEquals(actionableQtyTowardTarget(bk({ prepped: 3 }), "prep"), 0);
});

Deno.test("actionableQtyTowardTarget: checkout on a prepped booking moves the prepped qty", () => {
  assertEquals(actionableQtyTowardTarget(bk({ prepped: 3 }), "checkout"), 3);
});

Deno.test("actionableQtyTowardTarget uses the earliest-source qty for a partial booking", () => {
  assertEquals(actionableQtyTowardTarget(bk({ reserved: 1, prepped: 2 }), "checkout"), 1);
});

Deno.test("actionableQtyTowardTarget: return acts on a rental's out qty", () => {
  assertEquals(actionableQtyTowardTarget(bk({ out: 3 }), "return"), 3);
});

Deno.test("actionableQtyTowardTarget: return does NOT sweep a non-rental's terminal out", () => {
  assertEquals(actionableQtyTowardTarget(bk({ out: 3 }, "sale"), "return"), 0);
});

Deno.test("actionableQtyTowardTarget: return is 0 while an earlier bucket still holds qty", () => {
  assertEquals(actionableQtyTowardTarget(bk({ prepped: 2, out: 3 }, "sale"), "return"), 0);
  assertEquals(actionableQtyTowardTarget(bk({ prepped: 2, out: 3 }), "return"), 0);
  assertEquals(actionableQtyTowardTarget(bk({ reserved: 3, out: 2 }), "return"), 0);
});

Deno.test("actionableQtyTowardTarget is 0 toward every target for a terminal booking", () => {
  const terminal = bk({ returned: 3 });
  assertEquals(actionableQtyTowardTarget(terminal, "prep"), 0);
  assertEquals(actionableQtyTowardTarget(terminal, "checkout"), 0);
  assertEquals(actionableQtyTowardTarget(terminal, "return"), 0);
});

Deno.test("actionableQtyTowardTarget guards the quoted/complete targets to 0", () => {
  const b = bk({ reserved: 3 });
  assertEquals(actionableQtyTowardTarget(b, "quoted"), 0);
  assertEquals(actionableQtyTowardTarget(b, "complete"), 0);
});

// ── regressionAlternatesForBooking ───────────────────────────────────────────

Deno.test("regressionAlternates lead with the most-terminal non-empty bucket", () => {
  const alts = regressionAlternatesForBooking(bk({ out: 2, returned: 3 }));
  assertEquals(alts[0].fromBucket, "returned");
  assertEquals(alts[0].toBucket, "out");
});

// ── checkoutUnits / checkoutableQuantity ─────────────────────────────────────

Deno.test("checkoutUnits is the status-blind arithmetic half", () => {
  // It is what `checkoutRow` applies and what the cross-order pre-flight sums
  // per product; both have already decided the booking may move.
  assertEquals(checkoutUnits(bk({ reserved: 3, prepped: 2 }, "rental", "active")), 5);
  assertEquals(checkoutUnits(bk({ out: 3 }, "rental", "active")), 0);
});

Deno.test("checkoutableQuantity takes reserved AND prepped together", () => {
  assertEquals(checkoutableQuantity(bk({ reserved: 3, prepped: 2 }, "rental", "part-prepped")), 5);
});

Deno.test("checkoutableQuantity admits reserved, prepped and part-prepped", () => {
  for (const status of ["reserved", "prepped", "part-prepped"] as const) {
    assertEquals(checkoutableQuantity(bk({ reserved: 2 }, "rental", status)), 2);
  }
});

Deno.test("🔴 checkoutableQuantity refuses an ACTIVE booking that still holds reserved units", () => {
  // The regression this exists to stop. A per-row partial checkout
  // (`applyBookingActions`) flips the booking to `active` and leaves the
  // remainder reserved — units present, and `POST /checkouts` will not take
  // them. A predicate reading the breakdown alone would offer exactly this row,
  // and the server refuses the WHOLE cart over it, not just the row.
  assertEquals(checkoutableQuantity(bk({ reserved: 2, out: 3 }, "rental", "active")), 0);
  // …and this is the pair that makes the status half visible: same breakdown,
  // and the arithmetic half still counts it.
  assertEquals(checkoutUnits(bk({ reserved: 2, out: 3 }, "rental", "active")), 2);
});

Deno.test("checkoutableQuantity refuses the pre-reserve and terminal statuses", () => {
  assertEquals(checkoutableQuantity(bk({ quoted: 4 }, "rental", "quoted")), 0);
  assertEquals(checkoutableQuantity(bk({ reserved: 4 }, "rental", "draft")), 0);
  assertEquals(checkoutableQuantity(bk({ returned: 4 }, "rental", "complete")), 0);
});

Deno.test("checkoutableQuantity refuses a reserved booking with nothing in either bucket", () => {
  assertEquals(checkoutableQuantity(bk({ out: 3 }, "rental", "reserved")), 0);
});

Deno.test("checkoutableQuantity is type-AGNOSTIC, unlike returnableQuantity", () => {
  assertEquals(checkoutableQuantity(bk({ reserved: 6 }, "sale", "reserved")), 6);
  // Its `out` is terminal, which is the asymmetry: a sale can go out and must
  // never be offered back.
  assertEquals(returnableQuantity(bk({ out: 6 }, "sale")), 0);
});

// ── canPrepCheckout ──────────────────────────────────────────────────────────

Deno.test("canPrepCheckout is an explicit membership test, not an ordinal compare", () => {
  // `canceled` FOLLOWS `complete` in the status enum, so a `>= reserved`
  // comparison would admit both terminal states.
  assertEquals(canPrepCheckout("reserved"), true);
  assertEquals(canPrepCheckout("active"), true);
  assertEquals(canPrepCheckout("complete"), false);
  assertEquals(canPrepCheckout("canceled"), false);
  assertEquals(canPrepCheckout(undefined), false);
});
