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
  ownsKey,
} from "../schemas/mod.ts";
import { isOrderBookingsClosed, sumBreakdownKeys } from "./bookings.ts";

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
  return ownsKey(b.type, "out");
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
 * split out because api-cloudrun's `checkoutRow` needs the quantity on a
 * booking it has already decided about, and open-coded `reserved + prepped`
 * before this existed.
 */
export function checkoutUnits(b: Pick<Booking, "breakdown">): number {
  return sumBreakdownKeys(b.breakdown, ["reserved", "prepped"]);
}

/**
 * Units of this booking a worker can actually take OUT — everything reserved or
 * staged, which is exactly what one check-out moves, and zero when the
 * booking's status says it may not move at all.
 *
 * 🔴 **ONE author, and the two consumers behave OPPOSITELY on a failure.**
 * api-cloudrun's `checkoutOrder` **filters** on this — it called
 * `readOrderBookings` to DISCOVER its work, so a row that fails the predicate
 * is simply not part of the job. A client that computes a check-out itself
 * must ask the same question before offering the row, or it offers a booking
 * the server's own check-out would skip — two callers, one predicate, the thing
 * that must not fork.
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
 * Bucket sets per stage and side. The `source` side ("current state") is
 * everything up to and including the stage's source bucket, plus `quoted` (the
 * most-pending, pre-reserve bucket). The `target` side ("target state") is
 * everything past the source.
 *
 *   quoted    →  source=[quoted]                          target=[…terminal]
 *   prep      →  source=[quoted, reserved]                target=[prepped, out, …terminal]
 *   checkout  →  source=[quoted, reserved, prepped]       target=[out, …terminal]
 *   return    →  source=[quoted, reserved, prepped, out]  target=[…terminal]
 *   complete  →  source=[]                                target=[…terminal]
 *
 * `…terminal` is `BOOKING_BREAKDOWN_TERMINAL_KEYS` — returned, lost, damaged,
 * cleaning, maintenance. 🔴 Derived, never listed: the api#880 freeze reads the
 * `prep` target side, so a terminal key missing here would let an order edit
 * rewrite units that are physically back.
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
  return sumBreakdownKeys(b.breakdown, bucketsForBookingSide(b, stage, side));
}

/**
 * Units of this booking whose custody has left ALLOCATION — everything in
 * `prepped`, `out` or a terminal bucket. `> 0` means a warehouse worker has
 * physically acted on this booking's stock.
 *
 * 🔴 **This is the freeze predicate for the order → fulfillment cascade
 * (api-cloudrun#880), and the boundary it draws is `reserved | prepped`.**
 * Quantity still sitting in `quoted` or `reserved` is a *plan* — the order says
 * so, and an order edit is entitled to restate it. Quantity that has reached
 * `prepped` or beyond is a *physical fact* about where the goods are, and an
 * order edit must not rewrite it. So a row with `custodyMovedQuantity > 0`
 * keeps its stored `quantity` and cannot be removed by an order-side change,
 * while a row at zero keeps tracking its order.
 *
 * ⭐ **It is spelled as the TARGET side of `prep` because that is exactly where
 * the boundary lives** — {@link SOURCE_BUCKETS}`.prep` is `[quoted, reserved]`
 * and {@link TARGET_BUCKETS}`.prep` is everything past it. Naming it here
 * rather than leaving `qtyOnStageSide(b, "prep", "target")` at the call site is
 * the whole point: at a server freeze site that expression reads like someone
 * asked the wrong stage, and a reader who "fixed" it to the stage the booking is
 * actually in would silently change which rows freeze.
 *
 * ⚠️ **Type-independent, unlike its neighbours, and that is deliberate rather
 * than an oversight.** {@link returnableQuantity} and
 * {@link bucketsForBookingSide} branch on `outIsInFlight` because they ask
 * whether `out` still needs WORK — which a sale's `out` does not. Custody is a
 * different question: a sold unit that has gone out the door has moved custody
 * every bit as much as a rented one, and it is *less* recoverable. `out` is on
 * the target side of `prep` for both types, so the branch is a no-op here and
 * the function is honest about not needing it.
 *
 * ⚠️ **The grain is the BOOKING, and a booking is keyed on the LEG and on the
 * COMPONENT SIGNATURE.** A booking id is `{order}:{item}:{pair uid}` for a
 * top-level occurrence and `{order}:{item}:{pair uid}:{signature}` for a
 * component one ({@link buildBookingIdFromSignature}), so what shares a
 * booking — and therefore freezes together — is two occurrences of the same
 * product under one **leg** with the same component ancestry. ⭐ Segment 3 is
 * the destination pair's uid, **not** its address: two legs to one address are
 * two bookings and freeze independently (api-cloudrun#933). The same product standalone
 * and nested inside a kit are different bookings and freeze independently.
 *
 * 🔴 **This paragraph previously said the grain was `(order, product,
 * destination)`, full stop, and that reading is what a caller acts on.** It
 * predated the signature segment, and `destination` has since been corrected to
 * the LEG; it is the wrong mental model in the expensive direction: a consumer that keys its own freeze set on
 * `(product, destination)` cannot match the ids it derives them from, so the
 * freeze goes ABSENT rather than merely coarse. That is api-cloudrun#1060.
 * **Parse a booking id with {@link parseBookingId}; never hand-split it.**
 *
 * A per-row mental model of this predicate is still wrong, and would still look
 * right in every single-occurrence test.
 *
 * ⚠️ Replaced `partitionByStage`, which beta.348 kept for precisely this caller
 * and which turned out to be the wrong instrument: it partitions on the source
 * bucket, so a booking holding only `quoted` lands on the `target` side of
 * `prep` without any custody having moved.
 *
 * ## 🔴 NOT the same question as the picker's per-stage target test
 *
 * The manager spells `qtyOnStageSide(b, stage, "target") > 0` in three places
 * (the manager's since-deleted per-order screen: its column classifier,
 * destination section and item row — the last read it as
 * a quantity rather than a predicate), and it looks like this predicate written
 * out. It is
 * not, and the difference is the `stage` argument: the picker passes the
 * SECTION'S CURRENT stage, so its boundary MOVES as the section advances — at
 * `checkout` a `prepped` booking is on the source side, at `return` an `out` one
 * is. That is a column-rendering question. This one fixes the boundary at
 * `reserved | prepped` forever, because that is where a plan becomes a physical
 * fact. **The manager is therefore not re-deriving this rule, and must not be
 * "unified" with it.**
 *
 * ⭐ **They are related in exactly one direction, and it is asserted.** The
 * target sets are nested — {@link TARGET_BUCKETS} gives
 * `prep ⊇ checkout ⊇ return = quoted` — so `prep`'s is the WIDEST, and
 * therefore `qtyOnStageSide(b, anyStage, "target") > 0` implies
 * `custodyMovedQuantity(b) > 0` while the converse fails. The freeze can never
 * be narrower than any rendering predicate, which is the safe direction: a row
 * the picker draws as already-actioned is always one this refuses to rewrite.
 * `tests/fulfillment-stage.test.ts` pins it over every stage so an edit to the
 * bucket tables cannot quietly invert it.
 */
export function custodyMovedQuantity(b: Pick<Booking, "type" | "breakdown">): number {
  return qtyOnStageSide(b, "prep", "target");
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
