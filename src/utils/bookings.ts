/**
 * Pure helpers over the booking breakdown shape and the order's denormalized
 * roll-up. Used both server-side (api-cloudrun) and client-side (manager) so
 * the warehouse picker sees instant optimistic updates and the order detail
 * page can compute "is this order done?" without a round-trip.
 *
 * ```ts
 * import {
 *   sumBookingBreakdown,
 *   isOrderBookingsClosed,
 *   mergeBookingBreakdown,
 * } from "@cfs/core/utils/bookings";
 * ```
 *
 * @module
 */
import type {
  AddressType,
  Booking,
  BookingBreakdown,
  BookingBreakdownKeyType,
  BookingDestinationRef,
  BookingUnitBucketType,
  ComponentTypeType,
  Order,
  OrderStatusType,
} from "../schemas/mod.ts";
import {
  BOOKING_BREAKDOWN_KEYS,
  BOOKING_BREAKDOWN_TERMINAL_KEYS,
  CUSTODY_HISTORY_KEYS,
  isCollectionLineType,
  ORDER_STATUS_TRAITS,
  ownsKey,
} from "../schemas/mod.ts";

/**
 * The breakdown key constants and their display labels live beside
 * `BookingBreakdownSchema` in
 * `schemas/booking.ts`, because the movement journal's custody axis is typed on
 * them and schema modules cannot import utils (the dependency runs strictly one
 * way). Re-exported here so `@cfs/core/utils/bookings` stays their address for
 * every existing importer.
 */
export {
  BOOKING_BREAKDOWN_KEYS,
  BOOKING_BREAKDOWN_LABELS,
  BOOKING_BREAKDOWN_TERMINAL_KEYS,
  BookingBreakdownKeyEnum,
  type BookingBreakdownKeyType,
} from "../schemas/mod.ts";

/**
 * How many of a bucket's units are UNTRACKED on a unit-tracked booking:
 * `breakdown[k] − units[k].length`. Units a bulk → serialized conversion found
 * already prepped or out and could not name (`api-cloudrun/.claude/plans/serial-tracking.md`
 * D1, D9).
 *
 * Derived, never stored: given the booking refine `units[k].length ≤
 * breakdown[k]`, a stored copy could only restate this, so it could only drift.
 * `0` on a booking that is not unit-tracked (`units` `null` or absent), where
 * the question does not arise.
 */
export function untrackedUnitCount(
  booking: Pick<Booking, "breakdown" | "units">,
  key: BookingUnitBucketType,
): number {
  if (booking.units == null) return 0;
  return booking.breakdown[key] - booking.units[key].length;
}

/**
 * A breakdown with every key stated. Since the keys' `feat!` this IS
 * `BookingBreakdown`; kept as an alias for existing importers.
 */
export type FullBookingBreakdown = Required<BookingBreakdown>;

/**
 * The units in one bucket of a possibly PARTIAL map (a delta, an override, a
 * fixture). An absent key reads 0. A stored breakdown states every key
 * (`schemas/_breakdown.ts`), so on one this is a plain lookup.
 */
export function breakdownQuantity(b: Partial<BookingBreakdown>, key: BookingBreakdownKeyType): number {
  return b[key] ?? 0;
}

/**
 * Σ of the named buckets — **the ONE place a breakdown is summed.**
 *
 * 🔴 A sum spelled key by key (`b.returned + b.lost + b.damaged`) compiled
 * straight through the arrival of `cleaning` and `maintenance` and stopped
 * counting them, in about a dozen places across three repos. Name the KEYS,
 * from `BOOKING_BREAKDOWN_KEYS` / `BOOKING_BREAKDOWN_TERMINAL_KEYS` where one
 * fits, and let this add them. `tests/breakdown-sums.test.ts` refuses a
 * named-key sum anywhere else in `src/`.
 */
export function sumBreakdownKeys(
  b: Partial<BookingBreakdown>,
  keys: readonly BookingBreakdownKeyType[],
): number {
  let total = 0;
  for (const key of keys) total += breakdownQuantity(b, key);
  return total;
}

/** Units that reached a terminal key: back, or out of service with a reason. */
export function terminalQuantity(b: Partial<BookingBreakdown>): number {
  return sumBreakdownKeys(b, BOOKING_BREAKDOWN_TERMINAL_KEYS);
}

/** `b` with every key stated, an absent one as 0 — for a partial map. */
export function fullBookingBreakdown(b: Partial<BookingBreakdown>): FullBookingBreakdown {
  const full = {} as FullBookingBreakdown;
  for (const key of BOOKING_BREAKDOWN_KEYS) full[key] = breakdownQuantity(b, key);
  return full;
}

/**
 * The empty breakdown shape — every key at zero.
 *
 * Use as the seed for new orders and as the target shape for fresh bookings.
 * ```ts
 * const order = { ...orderInput, bookings_breakdown: emptyBookingsBreakdown() };
 * ```
 */
export function emptyBookingsBreakdown(): FullBookingBreakdown {
  return fullBookingBreakdown({});
}

/**
 * Sum every value of a single booking's breakdown.
 *
 * The booking-level invariant is `sumBookingBreakdown(booking.breakdown) === booking.quantity`.
 * Use this to verify that a proposed breakdown change preserves the invariant
 * before submitting it through `PUT /bookings/{uid}`.
 */
export function sumBookingBreakdown(b: Partial<BookingBreakdown>): number {
  return sumBreakdownKeys(b, BOOKING_BREAKDOWN_KEYS);
}

/**
 * Merge a `Partial<breakdown>` over a current breakdown. Missing keys are
 * inherited from `current`. Useful for the optimistic UI path: a picker
 * types "returned: 1, out: 2" and the manager renders the merged result
 * before the API confirms.
 */
export function mergeBookingBreakdown(
  current: Booking["breakdown"],
  patch: Partial<Booking["breakdown"]> | undefined,
): Booking["breakdown"] {
  if (!patch) return { ...current };
  const merged = { ...current };
  for (const key of BOOKING_BREAKDOWN_KEYS) {
    const value = patch[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Sum a list of booking breakdowns into the order's roll-up shape.
 *
 * Mirrors the per-status keys of a booking's own `breakdown` (which aggregates
 * along the *product* axis) but aggregated along the *order* axis. Used to
 * seed `order.bookings_breakdown` at create/update time and to recompute it
 * client-side from cached bookings when the order doc isn't authoritative
 * yet.
 */
export function sumBookingsBreakdown(
  bookings: ReadonlyArray<{ breakdown: Booking["breakdown"] }>,
): FullBookingBreakdown {
  const total = emptyBookingsBreakdown();
  for (const b of bookings) {
    for (const key of BOOKING_BREAKDOWN_KEYS) total[key] += breakdownQuantity(b.breakdown, key);
  }
  return total;
}

/**
 * Apply a per-key delta to an order's bookings_breakdown roll-up in place.
 *
 * Given a booking's previous and next breakdown, mutate the order roll-up by
 * `+= next[k] - prev[k]` for each key.
 *
 * ⚠️ **This is NOT how the server maintains the roll-up, and has not been since
 * `finalizeOrderBookings` landed.** The docblock used to say it was — *"useful
 * server-side, where `updateBooking` applies a single-doc delta to avoid reading
 * every sibling booking"* — and that is precisely the mechanism the API replaced
 * with a fold over the order's full booking set, on the house rule *"recompute,
 * never a delta"*. `applyBookingBreakdownDelta` has **zero call sites** in
 * `api-cloudrun/src/`.
 *
 * One live consumer class remains, and it is not the cascade: **the manager's
 * optimistic UI**, which applies the delta locally for instant feedback and lets
 * the server's authoritative fold land after. (api-cloudrun's repair scripts
 * were the other — the repair-booking-breakdowns script, deleted 2026-10-09 by
 * the stock campaign because it wrote custody with no event, and
 * complete-stale-bookings before it, deleted 2026-08-30.)
 *
 * So it is kept deliberately. **Do not reach for it to maintain a roll-up in a
 * writer** — a delta is lossy the moment one is dropped, which is the failure
 * `sumBookingsBreakdown` exists to make unrepresentable.
 */
export function applyBookingBreakdownDelta(
  orderBreakdown: Order["bookings_breakdown"],
  prev: Booking["breakdown"],
  next: Booking["breakdown"],
): void {
  for (const key of BOOKING_BREAKDOWN_KEYS) {
    orderBreakdown[key] += next[key] - prev[key];
  }
}

/**
 * Carry the in-flight and terminal progress forward, and put the remainder in
 * one open bucket. The carry set is `prepped + out` plus every terminal key
 * — the previous `quoted` and `reserved` values are intentionally dropped, which
 * is what fixes the "two open buckets after a status flip" data corruption that
 * surfaced in opportunity webhook ingestion.
 *
 * 🔴 **The open bucket is FLOORED AT ZERO, so the movement journal wins on
 * committed buckets and the order wins only on open ones.** It was not, and an
 * order edit that shrank a booking below what the warehouse already held
 * balanced the books by writing a NEGATIVE `reserved` — carry 5, quantity 3
 * gave `{prepped: 5, reserved: -2}`, whose sum is 3, so every
 * `sum(breakdown) === quantity` check passed on it. Nothing in the schema
 * refuses a negative bucket (`z.int()`, not `z.int().min(0)`), and
 * `unavailableFromBooking` folds the breakdown to a single number, so those two
 * units came off the shelf's unavailable total while still physically out.
 *
 * ⚠️ **The consequence is that the caller can no longer assume
 * `sum(result) === quantity`** — it is `max(quantity, carry)`. That is the
 * point: the result is the PHYSICAL number, and a caller storing it must take
 * `sumBookingBreakdown(result)` as the booking's `quantity` and keep what was
 * asked for in `quantity_ordered`. See `Booking.quantity`'s docblock.
 */
function openBucket(
  key: "quoted" | "reserved",
  quantity: number,
  prev: Booking["breakdown"],
): Booking["breakdown"] {
  const carried = { ...emptyBookingsBreakdown(), ...pickKeys(prev, CUSTODY_HISTORY_KEYS) };
  const open = Math.max(0, quantity - sumBookingBreakdown(carried));
  return { ...carried, [key]: open };
}

function pickKeys(b: Partial<BookingBreakdown>, keys: readonly BookingBreakdownKeyType[]): Partial<BookingBreakdown> {
  const out: Partial<BookingBreakdown> = {};
  for (const key of keys) out[key] = breakdownQuantity(b, key);
  return out;
}

/**
 * A draft or canceled order books no PLAN (decision 10): the plan keys go to
 * zero and every key custody history reached is kept exactly as stored. Units
 * that moved are still where they are; an order status cannot un-move them.
 */
function keepCustodyOnly(prev: Booking["breakdown"]): Booking["breakdown"] {
  return { ...emptyBookingsBreakdown(), ...pickKeys(prev, CUSTODY_HISTORY_KEYS) };
}

/**
 * Project a booking's breakdown for a given **order** status, item type, and
 * total quantity. Pure sync — no I/O.
 *
 * ONE rule for every status (stock campaign P1): carry every custody key as it
 * stands and put the rest of the quantity in the status's plan bucket
 * (`ORDER_STATUS_TRAITS[status].planBucket`).
 *
 * | order status | breakdown |
 * |---|---|
 * | `quoted` | `quoted` = quantity − carried |
 * | `reserved` / `active` / `complete` | `reserved` = quantity − carried |
 * | `draft` / `canceled` | custody kept, no plan (decision 10) |
 * | `complete`, a `service`/`surcharge` line | all zeros |
 *
 * 🔴 **`complete` no longer SETTLES a booking.** It used to rewrite a rental to
 * `returned = quantity − out-of-service` and a sale to `out = quantity`, which on
 * any re-save of a complete order dropped `prepped`/`out`, could drive
 * `returned` negative, and erased a sale's returns and losses — custody changing
 * with no movement (gap G3). Now a complete order's stored custody stands, and
 * a raise books as `reserved` work, which reopens the order (decision 2). A
 * settled breakdown for a fixture is a test helper, not a projection.
 *
 * ⚠️ `draft`/`canceled` used to zero the WHOLE breakdown (gap G7), the last arm
 * that could drop custody.
 *
 * ⚠️ `status` is an `OrderStatusType`, **not** a `BookingStatusType`. The two
 * vocabularies overlap but are not the same set: an order can be `canceled`
 * (a booking cannot) and a booking can be `part-prepped`/`prepped` (an order
 * cannot). The projection is driven by the parent order.
 *
 * The open bucket is floored at zero — see `openBucket` — so the result sums to
 * `max(quantity, carried)`, the PHYSICAL number.
 */
export function calculateBookingBreakdown(
  status: OrderStatusType,
  type: ComponentTypeType,
  quantity: number,
  existingBreakdown?: Booking["breakdown"],
): Booking["breakdown"] {
  const prev = existingBreakdown ?? emptyBookingsBreakdown();
  // Indexed defensively, not as `TABLE[status]`: `template-helpers.generated.ts`
  // exposes this function to Eta templates with runtime-unchecked arguments, so an
  // out-of-vocabulary status must keep returning a breakdown rather than throw in
  // the PDF render path.
  const traits = (ORDER_STATUS_TRAITS as Partial<typeof ORDER_STATUS_TRAITS>)[status];
  if (traits === undefined) return emptyBookingsBreakdown();
  if (status === "complete" && !isStockLineType(type)) return emptyBookingsBreakdown();
  if (traits.planBucket === null) return keepCustodyOnly(prev);
  return openBucket(traits.planBucket, quantity, prev);
}

/** The line types a booking carries custody for: `rental` and `sale`. */
function isStockLineType(type: string): boolean {
  return type === "rental" || type === "sale";
}

/**
 * The keys whose units are still WORK: the plan (`quoted`, `reserved`), the prep
 * shelf, and `out` while CFS still owns it. A booking is closed when none of the
 * keys it owns here holds a unit.
 */
const OPEN_KEYS: readonly BookingBreakdownKeyType[] = ["quoted", "reserved", "prepped", "out"];

/** The {@link OPEN_KEYS} a booking of `type` owns ({@link ownsKey}). */
function openKeysFor(type: string): readonly BookingBreakdownKeyType[] {
  return OPEN_KEYS.filter((k) => ownsKey(type, k));
}

/**
 * Per-booking closure rule: no unit left in a key that is still work.
 *
 * `quoted + reserved + prepped` must be zero, and so must `out` where CFS still
 * owns it ({@link ownsKey}): a rental's `out` is in flight and must come back
 * (or be marked) first; a sale's `out` is delivered, so a sale can sit fully
 * out and be closed.
 *
 * Sale items still expose Return/Lost/Damaged actions in the picker (a sold
 * item *can* be returned for credit and lost/damaged-in-transit is real) —
 * they're available, just not required for closure.
 */
export function isBookingClosed(b: Pick<Booking, "type" | "breakdown">): boolean {
  return sumBreakdownKeys(b.breakdown, openKeysFor(b.type)) === 0;
}

/**
 * Predicate: is the order fully closed?
 *
 * An order is closed when every booking is closed (per `isBookingClosed`)
 * and the order has at least one booking. The non-empty guard prevents
 * auto-completing an empty order simply because it has nothing in flight.
 *
 * Drives the auto-cascade in the booking write path: when this predicate
 * flips to true after applying booking deltas, the order's status is set to
 * "complete" in the same Firestore transaction.
 */
export function isOrderBookingsClosed(
  bookings: ReadonlyArray<Pick<Booking, "type" | "breakdown">>,
): boolean {
  if (bookings.length === 0) return false;
  return bookings.every(isBookingClosed);
}

/**
 * Units a booking physically holds that have not come back: `prepped`, plus
 * `out` where CFS still owns it ({@link ownsKey}). A sale's `out` is delivered
 * and never comes back, the same split {@link isBookingClosed} makes.
 *
 * ⚠️ **Not `custodyMovedQuantity`.** That counts `returned`/`lost`/`damaged`
 * too — it answers "did custody ever move?", which decides whether a booking
 * may be DELETED (never, once it has any history — api-cloudrun#1147, Q4).
 * This answers "what is still out there?", which decides how much of a removed
 * or shrunk fulfillment row an order edit must KEEP (decision 3).
 */
export function liveCustody(b: Pick<Booking, "type" | "breakdown">): number {
  return sumBreakdownKeys(b.breakdown, LIVE_CUSTODY_KEYS.filter((k) => ownsKey(b.type, k)));
}

/** The keys holding physical custody that has not come back: {@link liveCustody} reads the owned ones. */
const LIVE_CUSTODY_KEYS: readonly BookingBreakdownKeyType[] = ["prepped", "out"];

/**
 * Whether custody ever moved on a booking: any of `prepped`, `out` or a terminal
 * key. Such a booking is part of what happened, and an order
 * edit must not delete it (api-cloudrun#1147, Q4); only a plan-only booking
 * (`quoted`/`reserved`) goes with its line.
 *
 * ⚠️ Deliberately wider than {@link liveCustody}: a booking is KEPT on history,
 * a fulfillment row on live custody, so a removed line whose units all came
 * back keeps its booking and loses its row.
 */
export function hasCustodyHistory(b: Pick<Booking, "breakdown">): boolean {
  // Everything but the plan-only keys. A cleaning-only booking has history, and
  // an order edit that read it as custody-free would DELETE it.
  return sumBreakdownKeys(b.breakdown, CUSTODY_HISTORY_KEYS) > 0;
}

/**
 * A KEPT booking: one an order edit left in place only because units moved on it
 * (api-cloudrun#1147). The order asks for none of it, so `quantity_ordered` is
 * `0`; its custody is history, not work the order asked for.
 */
export function isKeptBooking(b: Pick<Booking, "quantity_ordered">): boolean {
  return b.quantity_ordered === 0;
}

/** The order statuses an operator AUTHORS and the bookings never override. */
const AUTHORED_PHASE_STATUSES: ReadonlySet<OrderStatusType> = new Set(["draft", "quoted", "canceled"]);

/** Keys holding custody PAST the prep shelf: `out` and every terminal key. */
const PAST_PREP_KEYS: readonly BookingBreakdownKeyType[] = CUSTODY_HISTORY_KEYS.filter((k) => k !== "prepped");

/**
 * An order's status as `authored ⊕ derived` (stock campaign decision 2): the
 * operator's status where the operator owns it, otherwise the phase read off
 * its bookings.
 *
 * | stored | status |
 * |---|---|
 * | `draft`, `quoted`, `canceled` | the stored status, always |
 * | `reserved`, `active`, `complete`, and no booking the order asks for | the stored status: there is no work to read a phase off |
 * | `reserved`, `active`, `complete` | `complete` when every booking is closed (`isBookingClosed`, a kept one included), else `active` when any custody is past the prep shelf, else `reserved` |
 *
 * So a complete order REOPENS when an edit raises a line (the raise lands
 * `reserved` and the order reads `active`), and re-completes when the raise is
 * lowered; a `reserved` order whose units went out reads `active` whichever
 * writer moved them (census 6 found 11 stuck `reserved` in prod). It absorbs
 * the api's `bookingsCompleteOrder`: a canceled order whose kept bookings close
 * stays canceled, and kept bookings alone never complete an order — yet an OPEN
 * kept booking still holds one open.
 *
 * ⚠️ **The "no booking the order asks for" row is load-bearing.** An order of
 * only service lines books nothing; without the row every such complete order
 * would read `reserved` on its next save.
 */
export function deriveOrderStatus(
  stored: OrderStatusType,
  bookings: ReadonlyArray<Pick<Booking, "type" | "breakdown" | "quantity_ordered">>,
): OrderStatusType {
  if (AUTHORED_PHASE_STATUSES.has(stored)) return stored;
  if (!bookings.some((b) => !isKeptBooking(b))) return stored;
  if (isOrderBookingsClosed(bookings)) return "complete";
  if (bookings.some((b) => sumBreakdownKeys(b.breakdown, PAST_PREP_KEYS) > 0)) return "active";
  return "reserved";
}

/** One booking that blocks a cancel, and what it still holds. */
export interface CancelBlocker {
  uid: string;
  /** Units on the prep shelf: undo with `unprep`. */
  prepped: number;
  /** Units still out that CFS owns: return with `check_in`, or undo with `check_out_undo` then `unprep`. */
  out: number;
}

/**
 * Why an order may not be canceled yet, or `null` when it may (stock campaign
 * decision 13). Refused while any booking holds LIVE custody (`liveCustody`:
 * `prepped`, plus `out` where CFS still owns it), naming each one — the chain of
 * events is respected by returning or undoing those units first, each an
 * ordinary custody action with its movement, and only then canceling.
 * Returned and out-of-service history stays on kept bookings, as it always has.
 *
 * The api enforces it on the bookings its order write already reads; the
 * manager renders its prompt from the same list.
 */
export function cancelRefusal(
  bookings: ReadonlyArray<Pick<Booking, "uid" | "type" | "breakdown">>,
): { message: string; bookings: CancelBlocker[] } | null {
  const blockers: CancelBlocker[] = [];
  let units = 0;
  for (const b of bookings) {
    const live = liveCustody(b);
    if (live === 0) continue;
    units += live;
    blockers.push({ uid: b.uid, prepped: b.breakdown.prepped, out: ownsKey(b.type, "out") ? b.breakdown.out : 0 });
  }
  if (blockers.length === 0) return null;
  return {
    message: `${units} unit(s) on ${blockers.length} booking(s) are prepped or out — return or undo them before canceling ` +
      `(${blockers.map((b) => b.uid).join(", ")})`,
    bookings: blockers,
  };
}

/** One order row at a booking grain, before and after an order edit. */
export interface GrainRow {
  /** Caller-chosen row key, returned in {@link GrainKeep.byRow}. */
  key: string;
  /** The row's physical quantity before the edit (the stored fulfillment row's, else the previous order's). */
  before: number;
  /** The next order's quantity for the row, `0` when the edit removes it. */
  after: number;
}

/** @see {@link grainKeep} */
export interface GrainKeep {
  /** Units of live custody the next order no longer covers. */
  kept: number;
  /** How many of those each decreasing row keeps, by {@link GrainRow.key}. Only rows with a share appear. */
  byRow: ReadonlyMap<string, number>;
}

/**
 * How much of a grain's live custody an order edit leaves uncovered, and which
 * rows keep it (api-cloudrun#1147, decision 3). A grain is one booking:
 * `(product, leg, component signature)`.
 *
 * - `kept = max(0, live − Σ after)`: an edit may remove or shrink rows down to
 *   the grain's live custody and no further; only the SHORTFALL is kept.
 * - The shortfall is allocated to the rows that DECREASED, in the order given,
 *   each up to `before − after`. Anything left over (a picker that sent more
 *   than the rows held) goes to the last decreasing row.
 * - With no decreasing row, `byRow` is empty and `kept` is still reported: the
 *   edit did not uncover anything, and the booking floors itself.
 *
 * Pure, so the api writer and the manager's removal prompt compute the same
 * answer from the same inputs.
 *
 * ```ts
 * grainKeep(3, [{ key: "a", before: 5, after: 1 }]); // { kept: 2, byRow: a→2 }
 * ```
 */
export function grainKeep(live: number, rows: readonly GrainRow[]): GrainKeep {
  const covered = rows.reduce((sum, r) => sum + r.after, 0);
  const kept = Math.max(0, live - covered);
  const byRow = new Map<string, number>();
  const decreasing = rows.filter((r) => r.before > r.after);
  if (kept === 0 || decreasing.length === 0) return { kept, byRow };
  let remaining = kept;
  for (const r of decreasing) {
    const share = Math.min(remaining, r.before - r.after);
    if (share > 0) byRow.set(r.key, share);
    remaining -= share;
    if (remaining === 0) break;
  }
  if (remaining > 0) {
    const last = decreasing[decreasing.length - 1];
    byRow.set(last.key, (byRow.get(last.key) ?? 0) + remaining);
  }
  return { kept, byRow };
}

/**
 * Split one grain's custody across several bookings by quantity — every bucket
 * conserved exactly, and every recipient summing to its own quantity
 * (api-cloudrun#1204). Returns one full breakdown per entry of `quantities`, in
 * the same order.
 *
 * Each cell is `breakdown[k] × quantities[j] ÷ Σ quantities` rounded to the
 * floor or the ceiling, never further. The floors come first; the units they
 * leave go to the cells with the LARGEST remainder, exactly as
 * {@link https://en.wikipedia.org/wiki/Largest_remainder_method largest remainder}
 * would for one bucket.
 *
 * 🔴 **Rounding each bucket on its own is NOT enough, and that is why this
 * exists.** It conserves each bucket and breaks the recipients: `{ returned: 1,
 * lost: 1 }` over `[1, 1]` ties every remainder at ½, and an independent
 * per-bucket pass gives both units to the first recipient — a booking of 1
 * holding 2. Here the remainder pass also respects each recipient's leftover
 * capacity, and where the greedy order strands a unit, an augmenting path moves
 * one earlier choice aside. A solution always exists: the exact fractional
 * split is one, so an integral one within floor/ceiling of it does too.
 *
 * Deterministic: ties break by bucket order (`BOOKING_BREAKDOWN_KEYS`), then by
 * recipient index.
 *
 * ```ts
 * apportionBreakdown({ ...emptyBookingsBreakdown(), returned: 96, lost: 4 }, [64, 36]);
 * // [{ returned: 61, lost: 3, … }, { returned: 35, lost: 1, … }]
 * ```
 *
 * @throws RangeError when `quantities` is empty or holds anything but a
 *   positive safe integer, when a bucket is not a non-negative safe integer, or
 *   when `Σ breakdown !== Σ quantities` — there is no split that conserves both,
 *   so the honest answer is a refusal (the `distributeCents` rule).
 */
export function apportionBreakdown(
  breakdown: Partial<BookingBreakdown>,
  quantities: readonly number[],
): FullBookingBreakdown[] {
  if (quantities.length === 0) throw new RangeError("apportionBreakdown needs at least one recipient");
  for (const q of quantities) {
    if (!Number.isSafeInteger(q) || q <= 0) {
      throw new RangeError(`apportionBreakdown needs positive integer quantities, got ${q}`);
    }
  }
  const full = fullBookingBreakdown(breakdown);
  for (const key of BOOKING_BREAKDOWN_KEYS) {
    if (!Number.isSafeInteger(full[key]) || full[key] < 0) {
      throw new RangeError(`apportionBreakdown needs non-negative integer buckets, got ${key}: ${full[key]}`);
    }
  }
  const total = quantities.reduce((n, q) => n + q, 0);
  const units = sumBookingBreakdown(full);
  if (units !== total || !Number.isSafeInteger(total)) {
    throw new RangeError(
      `apportionBreakdown: the breakdown holds ${units} unit(s) and the quantities sum to ${total} — ` +
        `no split conserves both`,
    );
  }

  const out = quantities.map(() => emptyBookingsBreakdown());
  // Units each recipient still needs, and each bucket still has, after the floors.
  const capacity = [...quantities];
  const supply = new Map<BookingBreakdownKeyType, number>();
  // A cell eligible for one extra unit: its share had a fractional part. The
  // remainder is kept as the integer numerator over `total`, so it compares exactly.
  const cells: { key: BookingBreakdownKeyType; k: number; j: number; remainder: number }[] = [];
  BOOKING_BREAKDOWN_KEYS.forEach((key, k) => {
    let left = full[key];
    quantities.forEach((q, j) => {
      // BigInt so `bucket × quantity` cannot leave the safe range.
      const product = BigInt(full[key]) * BigInt(q);
      const floor = Number(product / BigInt(total));
      const remainder = Number(product % BigInt(total));
      out[j][key] = floor;
      capacity[j] -= floor;
      left -= floor;
      if (remainder > 0) cells.push({ key, k, j, remainder });
    });
    if (left > 0) supply.set(key, left);
  });

  // Greedy: the largest remainders first. `extra` records which cells took one.
  cells.sort((a, b) => b.remainder - a.remainder || a.k - b.k || a.j - b.j);
  const extra = new Set<(typeof cells)[number]>();
  const stranded: BookingBreakdownKeyType[] = [];
  for (const cell of cells) {
    if ((supply.get(cell.key) ?? 0) === 0 || capacity[cell.j] === 0) continue;
    extra.add(cell);
    supply.set(cell.key, supply.get(cell.key)! - 1);
    capacity[cell.j] -= 1;
  }
  for (const [key, n] of supply) for (let i = 0; i < n; i++) stranded.push(key);

  // Repair: route each stranded unit along an alternating path — an unused
  // cell into a recipient, and if that recipient is full, one of its used cells
  // back out to another bucket — until a recipient with spare capacity is hit.
  for (const start of stranded) {
    const seenBucket = new Set<BookingBreakdownKeyType>([start]);
    const seenRecipient = new Set<number>();
    const via = new Map<BookingBreakdownKeyType, (typeof cells)[number]>();
    const viaRecipient = new Map<number, (typeof cells)[number]>();
    const queue: BookingBreakdownKeyType[] = [start];
    let end: number | null = null;
    search: while (queue.length > 0) {
      const bucket = queue.shift()!;
      for (const cell of cells) {
        if (cell.key !== bucket || extra.has(cell) || seenRecipient.has(cell.j)) continue;
        seenRecipient.add(cell.j);
        viaRecipient.set(cell.j, cell);
        if (capacity[cell.j] > 0) {
          end = cell.j;
          break search;
        }
        for (const used of extra) {
          if (used.j !== cell.j || seenBucket.has(used.key)) continue;
          seenBucket.add(used.key);
          via.set(used.key, used);
          queue.push(used.key);
        }
      }
    }
    if (end === null) throw new Error("apportionBreakdown: no feasible split — this is a bug, not an input error");
    capacity[end] -= 1;
    // Walk back: take each entering cell, release each leaving one.
    let recipient: number = end;
    for (;;) {
      const entering = viaRecipient.get(recipient)!;
      extra.add(entering);
      if (entering.key === start) break;
      const leaving = via.get(entering.key)!;
      extra.delete(leaving);
      recipient = leaving.j;
    }
  }

  for (const cell of extra) out[cell.j][cell.key] += 1;
  return out;
}

/** A destination pair as far as {@link bookingCollectionFor} reads it. */
export interface BookingCollectionPair {
  delivery: { uid: string | null; address: AddressType | null };
  collection: { uid: string | null; address: AddressType | null } | null;
}

/** What {@link bookingCollectionFor} decides for one booking. */
export interface BookingCollection {
  /** `Booking.destinations.collection`. */
  collection: BookingDestinationRef | null;
  /** `Booking.uid_destination_collection`. */
  uid_destination_collection: string | null;
}

/**
 * **The one author of a booking's collection** (api-cloudrun#1154) — every
 * booking writer (the create path, the reconcile, a kept booking, a repair
 * script) takes both collection fields from here.
 *
 * 🔴 **Decided by the BOOKING's own `type`, not the order's or the pair's.** A
 * booking is one grain (`(order, product, leg, ancestry)`), and one grain has
 * one type (`mixedBookingGrains`, `@cfs/core/schemas`), so a `sale` booking on
 * an order that also rents still never comes back:
 *
 * | booking type | collection |
 * |---|---|
 * | `rental` | the pair's leg: `{ uid, address }` |
 * | anything else | `null`, both fields |
 *
 * A rental whose leg has no `uid` yet (an unplaced leg, legal on a draft alone)
 * takes the DELIVERY address, because `Booking.destinations.collection.uid` is a
 * required id; that was every writer's rule before this function existed, and
 * it is now confined to the one case that needs it.
 *
 * @throws Error on a `rental` whose pair has no collection leg — the order
 *   normalizer (`normalizeCollectionLegs`) re-seeds a leg whenever a rental is
 *   present, so reaching here without one is a writer that skipped it. A kept
 *   booking whose order dropped its leg passes its STORED leg as `pair`.
 */
export function bookingCollectionFor(type: string, pair: BookingCollectionPair): BookingCollection {
  if (!isCollectionLineType(type)) return { collection: null, uid_destination_collection: null };
  if (pair.collection === null) {
    throw new Error(
      "a rental booking needs its pair's collection leg — run normalizeCollectionLegs on the order first",
    );
  }
  const uid = pair.collection.uid ?? pair.delivery.uid;
  if (uid === null) {
    throw new Error("a rental booking's pair names no delivery or collection destination");
  }
  return {
    collection: { uid, address: pair.collection.address ?? null },
    uid_destination_collection: uid,
  };
}
