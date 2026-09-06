/**
 * The **custody model** — where a booking's units are right now, what may move
 * them next, and which transitions are legal.
 *
 * ```ts
 * import {
 *   checkoutableQuantity,
 *   getStageForBookings,
 *   qtyOnStageSide,
 * } from "@cfs/core/utils/fulfillment-stage";
 * ```
 *
 * ## Why this is in core rather than in the picker
 *
 * Moved here from `manager/src/utils/fulfillmentStage.ts`, now deleted — ~430
 * lines of pure domain logic over `Booking`/`Fulfillment` with no Firestore and
 * no Solid in it, which used to live in `manager` only because it was first
 * written for the picker's two-column surface. Meanwhile the **terminal** end of
 * the same model was already shared (`isBookingClosed` / `isOrderBookingsClosed`
 * in `./bookings.ts`, imported by `api-cloudrun/src/services/orderFinalize.ts`)
 * and the **in-flight** end was stated twice, in two vocabularies: the API said
 * it in *status* terms (`isCheckoutable`), the picker in *bucket* terms
 * (`checkoutableQuantity`). {@link checkoutableQuantity} is now the one author
 * and both sides call it.
 *
 * ⚠️ **This area already has the scar.** `rebuildFulfillmentItems`
 * (`./fulfillment-items.ts`) lives in core *because a copy drifted*, and
 * `isFulfillmentLineItem` was a character-for-character twin
 * (api-cloudrun#674). The next consumer is the server's freeze predicate — a
 * custody question — and a server-authored copy of it would drift from the one
 * the picker uses to decide what is editable.
 *
 * ## `source` / `target`, not `col1` / `col2`
 *
 * The vocabulary this module was written in named a LAYOUT ("column 1", "column
 * 2"), which is why the model read as UI code. The concept is
 * **current-state vs target-state for a stage** — exactly {@link STAGE_SOURCE}
 * and {@link STAGE_TARGET} restated — so it is spelled that way here. Deciding
 * how many columns to draw, and which of them to hide, stays in `manager`
 * (`visibleBucketsForColumn`, `rollUpColumn`).
 *
 * @module
 */
import {
  type Booking,
  BOOKING_BREAKDOWN_TERMINAL_KEYS,
  type BookingBreakdownKeyType,
  type Fulfillment,
} from "../schemas/mod.ts";
import { isOrderBookingsClosed } from "./bookings.ts";

/**
 * Workflow stages for the fulfillment route, in lifecycle order. Each
 * non-terminal stage moves quantity from a source breakdown bucket to a target
 * bucket:
 *
 *   prep      reserved   →  prepped
 *   checkout  prepped    →  out
 *   return    out        →  returned (with split to lost / damaged)
 *   complete  —          —  (terminal — nothing pending)
 *   quoted    —          —  (pre-reserve — order not yet reserved)
 *
 * `quoted` is the pre-reservation bucket: it surfaces a booking whose qty is
 * still quoted (order status < reserved). Reserving the order moves that qty
 * into `reserved` and the booking enters the prep→checkout→return flow.
 * `part-prepped` is a booking *status*, not a bucket — partial prep is encoded
 * by `prepped > 0` co-existing with `reserved > 0` on the same booking.
 *
 * Type-awareness (matches {@link isBookingClosed} in `./bookings.ts`): `out` is
 * in-flight (needs return) only for `rental` bookings. For any other type
 * (`sale`, defensively `service`/`surcharge`) `out` is terminal — checkout is
 * delivery and the units don't come back, so a non-rental `out` does not hold
 * the destination open and renders on the done side. The Return/Lost/Damaged
 * actions stay *available* on it (a sold item can be returned for credit / lost
 * in transit), just not required for closure.
 */
export const FULFILLMENT_STAGES = [
  "quoted",
  "prep",
  "checkout",
  "return",
  "complete",
] as const;

/** One workflow stage of the fulfillment route. */
export type FulfillmentStage = typeof FULFILLMENT_STAGES[number];

/**
 * The three stages that actually move quantity. `quoted` is pre-reserve and
 * `complete` is terminal, so neither has a source or target bucket — which is
 * why {@link STAGE_SOURCE} and {@link STAGE_TARGET} are keyed on this subset
 * rather than on {@link FulfillmentStage}, and why every consumer has to
 * dispatch on the two ends explicitly rather than reading a missing key.
 */
export type ActionableStage = Exclude<FulfillmentStage, "quoted" | "complete">;

/**
 * Display label per stage.
 *
 * Declared beside the stage enum for the same reason
 * `BOOKING_BREAKDOWN_LABELS` is declared beside `BookingBreakdownSchema`: the
 * model and its display names get one home, so a fifth stage cannot be added
 * without naming it.
 */
export const FULFILLMENT_STAGE_LABELS: Record<FulfillmentStage, string> = {
  quoted: "Quoted",
  prep: "Prep",
  checkout: "Check Out",
  return: "Return",
  complete: "Complete",
};

/** The bucket a stage's action pulls FROM. */
export const STAGE_SOURCE: Record<ActionableStage, BookingBreakdownKeyType> = {
  prep: "reserved",
  checkout: "prepped",
  return: "out",
};

/** The bucket a stage's action pushes INTO. */
export const STAGE_TARGET: Record<ActionableStage, BookingBreakdownKeyType> = {
  prep: "prepped",
  checkout: "out",
  return: "returned",
};

/**
 * Which end of a stage a question is about — the units as they stand now
 * (`source`) or the units already past it (`target`).
 *
 * The picker renders these as two columns, and that is where the old `"col1"` /
 * `"col2"` spelling came from; the concept is not a layout.
 */
export type StageSide = "source" | "target";

/** True iff this booking's `out` bucket is in-flight (rental) vs terminal. */
function outIsInFlight(b: Pick<Booking, "type">): boolean {
  return b.type === "rental";
}

/**
 * Units of this booking a worker can actually check IN — its `out` quantity,
 * but only when `out` is in-flight.
 *
 * 🔴 **A non-rental `out` is TERMINAL and must never be offered for return.**
 * For a `sale`, checkout IS delivery: the units do not come back, and `out` is
 * where they permanently rest. Offering a sale row on a check-in surface lets a
 * worker "return" sold goods, which writes stock back into inventory that was
 * never coming — and it is invisible afterwards, because the booking looks
 * exactly like a returned rental.
 *
 * This is not hypothetical. The fulfillments campaign planned a repair that
 * would have moved `out → returned` on every terminal booking; measured, **all
 * 380 prod bookings with a terminal `out > 0` were sales**, and complete
 * rentals with `out > 0` numbered 0. That one-shot would have asserted 23,440
 * units of sold goods back into stock. The plan's own audit could not have
 * caught it — 379 of the 380 carry no custody event at all, so it classifies
 * them `no_events` and skips them by design.
 */
export function returnableQuantity(b: Pick<Booking, "type" | "breakdown">): number {
  return outIsInFlight(b) ? b.breakdown.out : 0;
}

/**
 * Units one check-out moves for this booking — everything reserved or staged,
 * ignoring status.
 *
 * ⚠️ **Not a substitute for {@link checkoutableQuantity}, which is the
 * question a caller asking "may I?" wants.** This is the *arithmetic* half,
 * split out because three api-cloudrun sites need the quantity on a booking
 * they have already decided about: `checkoutRow` builds the patch that applies
 * it, and the cross-order pre-flight sums it per product to size the ledger
 * draw-down. Each of those open-coded `reserved + prepped` before this existed.
 */
export function checkoutUnits(b: Pick<Booking, "breakdown">): number {
  return b.breakdown.reserved + b.breakdown.prepped;
}

/**
 * Units of this booking a worker can actually take OUT — everything reserved or
 * staged, which is exactly what one check-out moves, and zero when the
 * booking's status says it may not move at all.
 *
 * 🔴 **ONE author, and the two consumers behave OPPOSITELY on a failure.**
 * api-cloudrun's `checkoutOrder` **filters** on this — it called
 * `readOrderBookings` to DISCOVER its work, so a row that fails the predicate
 * is simply not part of the job. The cross-order form (`POST /checkouts`) was
 * TOLD its rows and must **refuse** instead: silently dropping one would report
 * success for units still sitting on the shelf, and it fails the whole request
 * rather than part of it. A client that offers a row the server would refuse
 * therefore turns one bad tick into a failed cart, with the picker standing at
 * a shelf with no idea which line did it. That is why the picker asks this same
 * function — two behaviours, one predicate, the thing that must not fork.
 *
 * ⚠️ **The STATUS half is the part that is easy to drop, and it is load-bearing
 * on its own.** A per-row partial checkout leaves a booking `active` with
 * `reserved > 0` — units present, and the server will not take them. Testing
 * the breakdown alone would offer exactly that row. `part-prepped` is admitted
 * alongside `prepped` because a partial prep is an ordinary state: some units
 * staged, the rest still reserved, and both move.
 *
 * 🔴 **Never a partial.** `checkoutRow` moves `reserved + prepped` wholesale and
 * accepts no quantity, so this is a row-level yes/no and the cart has no
 * quantity input. Peeling units off a line is the per-order path's job
 * (`applyBookingActions`), which takes a qty per action.
 */
export function checkoutableQuantity(b: Pick<Booking, "status" | "breakdown">): number {
  if (b.status !== "reserved" && b.status !== "prepped" && b.status !== "part-prepped") return 0;
  return checkoutUnits(b);
}

/**
 * Determine the current workflow stage for a set of bookings. The stage is the
 * earliest non-empty actionable source bucket across all bookings — if anything
 * is still reserved we're prepping; if everyone is past reserved but anything is
 * prepped we're checking out; if any *rental* is out we're returning. With no
 * actionable work left, a still-`quoted` booking surfaces the pre-reserve state,
 * otherwise the section is complete.
 *
 * Destination-agnostic — pass any subset of bookings.
 */
export function getStageForBookings(
  bookings: ReadonlyArray<Pick<Booking, "type" | "breakdown">>,
): FulfillmentStage {
  for (const b of bookings) if (b.breakdown.reserved > 0) return "prep";
  for (const b of bookings) if (b.breakdown.prepped > 0) return "checkout";
  // Only rental `out` needs a return; non-rental `out` is terminal.
  for (const b of bookings) if (outIsInFlight(b) && b.breakdown.out > 0) return "return";
  // Nothing actionable past reservation; anything still quoted is pre-reserve.
  for (const b of bookings) if (b.breakdown.quoted > 0) return "quoted";
  return "complete";
}

/**
 * Whether every booking in the set has reached a terminal/closed state.
 *
 * A named alias for {@link isOrderBookingsClosed}, kept because the picker asks
 * the question of an arbitrary SUBSET (one destination's bookings) rather than
 * of an order.
 */
export function bookingsComplete(
  bookings: ReadonlyArray<Pick<Booking, "type" | "breakdown">>,
): boolean {
  return isOrderBookingsClosed(bookings);
}

/**
 * Partition bookings by whether they still hold quantity in the stage's source
 * bucket. `complete` and `quoted` have no source bucket, so everything lands on
 * the target side.
 *
 * ⚠️ **No caller yet.** It had none in `manager` either when it moved here — the
 * picker classifies per ROW (`fulfillmentClassify.ts`) rather than per booking.
 * It is kept because the row-scoped freeze predicate the server needs next
 * (api-cloudrun#880) is exactly this question asked of one document's bookings;
 * if that increment does not reach for it, delete it rather than leaving it.
 */
export function partitionByStage<T extends Pick<Booking, "breakdown">>(
  bookings: readonly T[],
  stage: FulfillmentStage,
): { source: T[]; target: T[] } {
  if (stage === "complete" || stage === "quoted") return { source: [], target: [...bookings] };
  const sourceKey = STAGE_SOURCE[stage];
  const source: T[] = [];
  const target: T[] = [];
  for (const b of bookings) {
    if (b.breakdown[sourceKey] > 0) source.push(b);
    else target.push(b);
  }
  return { source, target };
}

/**
 * The natural next action for a given booking based on its own breakdown. Used
 * to label the per-row action button. A non-rental sitting in `out` has no
 * *required* next action (delivery is terminal) → `complete`.
 */
export function naturalNextActionForBooking(
  b: Pick<Booking, "type" | "breakdown">,
): FulfillmentStage {
  if (b.breakdown.reserved > 0) return "prep";
  if (b.breakdown.prepped > 0) return "checkout";
  if (b.breakdown.out > 0) return outIsInFlight(b) ? "return" : "complete";
  return "complete";
}

/**
 * Forward action alternate — moves qty from the booking's natural source
 * bucket to a later bucket. From any non-terminal source the user can skip
 * ahead (e.g. reserved → out, or out → lost / damaged).
 */
export interface FulfillmentForwardAlternate {
  kind: "forward";
  /** The action's stage — drives the breakdown delta the action emits. */
  stage: FulfillmentStage;
  /** Display label. */
  label: string;
  /**
   * For "return" stage actions, the bucket the qty lands in. Defaults
   * to "returned"; pickers can choose "lost" or "damaged" from the
   * override popover.
   */
  returnTo?: "returned" | "lost" | "damaged";
}

/**
 * Regression alternate — moves qty one step back from a later bucket.
 * Used by target-side "current state" rows to undo over-eager transitions
 * (e.g. accidentally checked out, or marked returned in error).
 *
 * Bucket flow (one step back, terminals reversible):
 *   returned/lost/damaged → out
 *   out                   → prepped
 *   prepped               → reserved
 */
export interface FulfillmentRegressionAlternate {
  kind: "regression";
  fromBucket: "prepped" | "out" | "returned" | "lost" | "damaged";
  toBucket: "reserved" | "prepped" | "out";
  label: string;
}

/** Either direction of override a picker may pick for a row. */
export type FulfillmentActionAlternate =
  | FulfillmentForwardAlternate
  | FulfillmentRegressionAlternate;

const TERMINAL_ALTERNATES: FulfillmentForwardAlternate[] = [
  { kind: "forward", stage: "return", label: "Mark Returned", returnTo: "returned" },
  { kind: "forward", stage: "return", label: "Mark Lost", returnTo: "lost" },
  { kind: "forward", stage: "return", label: "Mark Damaged", returnTo: "damaged" },
];

/**
 * The full list of forward override alternates for a row, in the popover's
 * display order. The natural next action is always first.
 *
 * 🔴 **Which transitions are LEGAL is a domain question, not a menu.** No
 * server-side transition validation exists today, so this list is currently the
 * only statement of the rule anywhere; it is in core so the server has one
 * answer to check a submitted movement against rather than inventing a second.
 *
 * A non-rental booking that has reached `out` is *closed* (no required next
 * action) but still exposes Return/Lost/Damaged — a sold item can be returned
 * for credit and lost/damaged-in-transit is real (see `isBookingClosed` in
 * `./bookings.ts`). So we still offer the terminal alternates whenever the
 * booking has `out > 0`, regardless of type; they're just no longer the default.
 */
export function actionAlternatesForBooking(
  b: Pick<Booking, "type" | "breakdown">,
): FulfillmentForwardAlternate[] {
  const next = naturalNextActionForBooking(b);

  if (next === "prep") {
    return [
      { kind: "forward", stage: "prep", label: "Prep" },
      { kind: "forward", stage: "checkout", label: "Check Out" },
      ...TERMINAL_ALTERNATES,
    ];
  }
  if (next === "checkout") {
    return [{ kind: "forward", stage: "checkout", label: "Check Out" }, ...TERMINAL_ALTERNATES];
  }
  if (next === "return") {
    return [...TERMINAL_ALTERNATES];
  }
  // next === "complete": a non-rental still sitting in `out` is closed but its
  // units can still be returned/lost/damaged — offer those (not as the default).
  // A truly-terminal booking (out === 0) gets none.
  if (b.breakdown.out > 0) return [...TERMINAL_ALTERNATES];
  return [];
}

/**
 * Regression alternates — one entry per non-empty target-side bucket on the
 * booking. Order mirrors the natural undo priority (terminals first, then out,
 * then prepped). The popover's "default" entry is the first; the rest live in
 * the menu.
 */
export function regressionAlternatesForBooking(
  b: Pick<Booking, "breakdown">,
): FulfillmentRegressionAlternate[] {
  const out: FulfillmentRegressionAlternate[] = [];
  if (b.breakdown.returned > 0) {
    out.push({ kind: "regression", fromBucket: "returned", toBucket: "out", label: "Revert Returned to Out" });
  }
  if (b.breakdown.lost > 0) {
    out.push({ kind: "regression", fromBucket: "lost", toBucket: "out", label: "Revert Lost to Out" });
  }
  if (b.breakdown.damaged > 0) {
    out.push({ kind: "regression", fromBucket: "damaged", toBucket: "out", label: "Revert Damaged to Out" });
  }
  if (b.breakdown.out > 0) {
    out.push({ kind: "regression", fromBucket: "out", toBucket: "prepped", label: "Revert Out to Prepped" });
  }
  if (b.breakdown.prepped > 0) {
    out.push({ kind: "regression", fromBucket: "prepped", toBucket: "reserved", label: "Revert Prepped to Reserved" });
  }
  return out;
}

/**
 * The size of the "source" bucket for a row's natural next action — also the
 * default qty for the action's input. Reducing it creates a partial transition
 * (e.g. 3-of-5 prepped, or 2 returned + 1 lost).
 */
export function sourceBucketSizeForBooking(b: Pick<Booking, "type" | "breakdown">): number {
  const action = naturalNextActionForBooking(b);
  if (action === "complete" || action === "quoted") return 0;
  return b.breakdown[STAGE_SOURCE[action]];
}

/**
 * The qty a forward action toward `target` moves for this booking — the picker
 * default + max, the per-row action qty, and the bulk "Action All" amount.
 *
 * prep / checkout — SKIP-AHEAD: qty comes from the booking's natural (earliest
 *   non-empty non-terminal) source bucket — exactly what `computeBookingTransition`
 *   moves — provided the booking exposes a forward alternate reaching `target`.
 *   So "Check Out All" sweeps reserved units straight to `out`, while an already
 *   prepped-only booking is excluded from "Prep All" (no `prep` alternate),
 *   keeping today's Auto behavior.
 *
 * return — NOT skip-ahead: `computeBookingTransition` pulls from the earliest
 *   non-empty bucket, so `out` can only be returned once `reserved`/`prepped` are
 *   clear. We therefore act only when the booking's natural next action IS
 *   `return` (rental, `out` is the current bucket). This preserves the invariant
 *   that bulk Return never sweeps a non-rental's terminal `out` (its natural next
 *   is `complete`) nor still-prepped/reserved qty — those stay deliberate
 *   per-item menu choices.
 */
export function actionableQtyTowardTarget(
  b: Pick<Booking, "type" | "breakdown">,
  target: FulfillmentStage,
): number {
  if (target === "complete" || target === "quoted") return 0;
  if (target === "return") {
    return naturalNextActionForBooking(b) === "return" ? b.breakdown.out : 0;
  }
  const hasMatch = actionAlternatesForBooking(b).some((a) => a.stage === target);
  return hasMatch ? sourceBucketSizeForBooking(b) : 0;
}

/**
 * Bucket sets per stage and side. The `source` side ("current state") is
 * everything up to and including the stage's source bucket, plus `quoted` (the
 * most-pending, pre-reserve bucket). The `target` side ("target state") is
 * everything past the source.
 *
 *   quoted    →  source=[quoted]                          target=[returned, lost, damaged]
 *   prep      →  source=[quoted, reserved]                target=[prepped, out, returned, lost, damaged]
 *   checkout  →  source=[quoted, reserved, prepped]       target=[out, returned, lost, damaged]
 *   return    →  source=[quoted, reserved, prepped, out]  target=[returned, lost, damaged]
 *   complete  →  source=[]                                target=[returned, lost, damaged]
 *
 * These are the type-agnostic base sets; {@link bucketsForBookingSide} applies
 * the per-type override (non-rental `out` → done side).
 */
const SOURCE_BUCKETS: Record<Exclude<FulfillmentStage, "complete">, BookingBreakdownKeyType[]> = {
  quoted: ["quoted"],
  prep: ["quoted", "reserved"],
  checkout: ["quoted", "reserved", "prepped"],
  return: ["quoted", "reserved", "prepped", "out"],
};

const TARGET_BUCKETS: Record<Exclude<FulfillmentStage, "complete">, BookingBreakdownKeyType[]> = {
  quoted: [...BOOKING_BREAKDOWN_TERMINAL_KEYS],
  prep: ["prepped", "out", ...BOOKING_BREAKDOWN_TERMINAL_KEYS],
  checkout: ["out", ...BOOKING_BREAKDOWN_TERMINAL_KEYS],
  return: [...BOOKING_BREAKDOWN_TERMINAL_KEYS],
};

/**
 * The type-agnostic buckets belonging to one side of a stage, in display order.
 * Used for the section-level fallback label and as the base for the per-booking
 * override.
 */
export function bucketsForStageSide(
  stage: FulfillmentStage,
  side: StageSide,
): BookingBreakdownKeyType[] {
  if (stage === "complete") {
    return side === "target" ? [...BOOKING_BREAKDOWN_TERMINAL_KEYS] : [];
  }
  return side === "source" ? SOURCE_BUCKETS[stage] : TARGET_BUCKETS[stage];
}

/**
 * Per-booking side membership — the type-aware variant. Non-rental `out` is
 * terminal, so it moves from the pending side to the done side (matching
 * `isBookingClosed`'s rental-only `out` gate in `./bookings.ts`).
 */
export function bucketsForBookingSide(
  b: Pick<Booking, "type">,
  stage: FulfillmentStage,
  side: StageSide,
): BookingBreakdownKeyType[] {
  let source = bucketsForStageSide(stage, "source");
  let target = bucketsForStageSide(stage, "target");
  if (!outIsInFlight(b)) {
    source = source.filter((k) => k !== "out");
    if (!target.includes("out")) target = ["out", ...target];
  }
  return side === "source" ? source : target;
}

/**
 * Sum of a booking's qty in the buckets belonging to one side of a stage
 * (type-aware). `> 0` means the row appears on that side.
 */
export function qtyOnStageSide(
  b: Pick<Booking, "type" | "breakdown">,
  stage: FulfillmentStage,
  side: StageSide,
): number {
  let sum = 0;
  for (const k of bucketsForBookingSide(b, stage, side)) sum += b.breakdown[k];
  return sum;
}

/**
 * Whether the prep/checkout actions are available for a fulfillment's status.
 * Those advance reserved→prepped→out, so they require the order to be reserved
 * (or already in-flight/active). Draft/quoted orders aren't reservable from the
 * fulfillment route — reserve the order first. (Return/Lost/Damaged actions are
 * NOT gated by this — a checked-out rental always needs returning.)
 *
 * `canceled` follows `complete` in the status enum, so this is an explicit
 * membership test, not an ordinal `>= reserved` comparison.
 */
export function canPrepCheckout(status: Fulfillment["status"] | undefined): boolean {
  return status === "reserved" || status === "active";
}
