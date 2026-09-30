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
  ComponentTypeType,
  Order,
  OrderStatusType,
} from "../schemas/mod.ts";
import { BOOKING_BREAKDOWN_KEYS, BOOKING_BREAKDOWN_TERMINAL_KEYS, isCollectionLineType } from "../schemas/mod.ts";

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

/** A breakdown with every key stated — what arithmetic on one reads. */
export type FullBookingBreakdown = Required<BookingBreakdown>;

/**
 * The units in one bucket. An absent key reads 0: `cleaning` and `maintenance`
 * are optional until their backfill (`schemas/_breakdown.ts`), so a stored
 * breakdown may lack them.
 *
 * ⭐ **Read a bucket through this, never `b.cleaning ?? 0` at the call site.**
 * One reader is what lets the keys' tightening delete the fallback in one place.
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

/** `b` with every key stated, an absent one as 0. */
export function fullBookingBreakdown(b: Partial<BookingBreakdown>): FullBookingBreakdown {
  const full = {} as FullBookingBreakdown;
  for (const key of BOOKING_BREAKDOWN_KEYS) full[key] = breakdownQuantity(b, key);
  return full;
}

/**
 * The empty breakdown shape — every key at zero.
 *
 * Use as the seed for new orders and as the target shape for fresh bookings.
 * ⚠️ It STATES `cleaning` and `maintenance`, so a writer seeding from it
 * authors both keys — which a reader on a core older than the keys' beta
 * refuses (`z.strictObject`). The api pins this only after the manager's
 * reader release is in prod (custody-actions P2b step 2).
 *
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
 * Two live consumer classes remain, and neither is the cascade:
 *
 * - **The manager's optimistic UI**, which applies the delta locally for instant
 *   feedback and lets the server's authoritative fold land after.
 * - **api-cloudrun's operational repair script**
 *   `api-cloudrun/scripts/repair-booking-breakdowns.ts`, which moves one booking
 *   and adjusts its parent by exactly that booking's delta rather than re-folding
 *   the whole order. (Its former sibling `complete-stale-bookings.ts` was the
 *   other, and was deleted on 2026-08-30 — its successor drives
 *   `applyBookingUpdates` and so gets the whole-order fold instead.)
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
    const delta = breakdownQuantity(next, key) - breakdownQuantity(prev, key);
    // Leave an absent optional key absent when nothing moved it, so a roll-up
    // stored before the keys existed is not rewritten by a no-op.
    if (delta !== 0 || orderBreakdown[key] !== undefined) {
      orderBreakdown[key] = breakdownQuantity(orderBreakdown, key) + delta;
    }
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
  const carried = { ...fullBookingBreakdown(prev), quoted: 0, reserved: 0 };
  const open = Math.max(0, quantity - sumBookingBreakdown(carried));
  return { ...carried, [key]: open };
}

/**
 * How a `complete` order settles a booking, per item type.
 *
 * **`service` and `surcharge` settle to all-zeros, and that is load-bearing** —
 * `api-cloudrun/scripts/repair-booking-breakdowns.ts` derives its own
 * `expectedSumAfter` from this table (0 for a `complete` service/surcharge line,
 * `quantity` otherwise) and ABORTS the whole run when the projection disagrees.
 * Prod holds ~439 service/surcharge bookings. The `Record` annotation is what
 * stops a new `ComponentTypeType` member from silently acquiring the rental
 * treatment.
 *
 * ⚠️ The downstream enforcer named here used to be `complete-stale-bookings.ts`,
 * deleted on 2026-08-30. The rule did not move with it — it lives here, and the
 * test below pins it independently of any script.
 */
/** The terminal keys that are not `returned`: a unit out of service, with its reason. */
const OUT_OF_SERVICE_KEYS: readonly BookingBreakdownKeyType[] = BOOKING_BREAKDOWN_TERMINAL_KEYS.filter(
  (k) => k !== "returned",
);

function pickKeys(b: Partial<BookingBreakdown>, keys: readonly BookingBreakdownKeyType[]): Partial<BookingBreakdown> {
  const out: Partial<BookingBreakdown> = {};
  for (const key of keys) out[key] = breakdownQuantity(b, key);
  return out;
}

const COMPLETE_BY_TYPE: Readonly<
  Record<ComponentTypeType, (quantity: number, prev: Booking["breakdown"]) => Booking["breakdown"]>
> = {
  // Every out-of-service key is HISTORY and is kept; `returned` takes the rest.
  rental: (quantity, prev) => {
    const kept = { ...emptyBookingsBreakdown(), ...pickKeys(prev, OUT_OF_SERVICE_KEYS) };
    return { ...kept, returned: quantity - sumBookingBreakdown(kept) };
  },
  sale: (quantity) => ({ ...emptyBookingsBreakdown(), out: quantity }),
  service: () => emptyBookingsBreakdown(),
  surcharge: () => emptyBookingsBreakdown(),
};

/**
 * The projection rule, one entry per **order** status.
 *
 * Same shape as `MOVEMENT_CONTRACTS` (`schemas/transaction.ts`): the
 * `Record<OrderStatusType, …>` annotation makes an incomplete literal a compile
 * error at the declaration, so a new `ORDER_STATUSES` member cannot silently
 * fall through to an all-zero breakdown the way the previous if-chain let it.
 *
 * The values are projector functions rather than plain data because the arms
 * need `prev`, `quantity` and — for `complete` — the item `type`.
 */
const BREAKDOWN_PROJECTIONS: Readonly<
  Record<
    OrderStatusType,
    (quantity: number, prev: Booking["breakdown"], type: ComponentTypeType) => Booking["breakdown"]
  >
> = {
  draft: () => emptyBookingsBreakdown(),
  canceled: () => emptyBookingsBreakdown(),
  quoted: (quantity, prev) => openBucket("quoted", quantity, prev),
  reserved: (quantity, prev) => openBucket("reserved", quantity, prev),
  active: (quantity, prev) => openBucket("reserved", quantity, prev),
  complete: (quantity, prev, type) => COMPLETE_BY_TYPE[type]?.(quantity, prev) ?? emptyBookingsBreakdown(),
};

/**
 * Project a booking's breakdown for a given **order** status, item type, and
 * total quantity. Pure sync — no I/O.
 *
 * ⚠️ `status` is an `OrderStatusType`, **not** a `BookingStatusType`. The two
 * vocabularies overlap but are not the same set: an order can be `canceled`
 * (a booking cannot) and a booking can be `part-prepped`/`prepped` (an order
 * cannot). The projection is driven by the parent order, so a caller holding a
 * `booking.status` must read through to the order rather than pass it here —
 * that mismatch is what the narrowing exists to make a compile error.
 *
 * Status rules:
 *   draft / canceled  → all zeros (cleared on cancel/draft)
 *   quoted            → quoted = quantity − carry; preserves prepped/out/terminals
 *   reserved / active → reserved = quantity − carry; preserves prepped/out/terminals
 *   complete + rental → keeps every out-of-service key; returned = quantity − their sum
 *   complete + sale   → out = quantity; zero everything else
 *   complete + service / surcharge → all zeros
 */
export function calculateBookingBreakdown(
  status: OrderStatusType,
  type: ComponentTypeType,
  quantity: number,
  existingBreakdown?: Booking["breakdown"],
): Booking["breakdown"] {
  const prev = existingBreakdown ?? emptyBookingsBreakdown();
  // Indexed defensively, not as `TABLE[status](…)`: `template-helpers.generated.ts`
  // exposes this function to Eta templates with runtime-unchecked arguments, so an
  // out-of-vocabulary status must keep returning `base` rather than start throwing
  // on `undefined` in the PDF render path.
  return BREAKDOWN_PROJECTIONS[status]?.(quantity, prev, type) ?? emptyBookingsBreakdown();
}

/**
 * Per-booking closure rule.
 *
 * `quoted + reserved + prepped` must always be zero. The treatment of `out`
 * depends on `booking.type`:
 *
 * - `rental`: `out` is in-flight — units must be returned (or lost/damaged)
 *   before the booking is closed.
 * - any other type (`sale`, defensively `service`/`surcharge`): `out` is
 *   terminal — checkout is delivery and the units don't come back. The
 *   booking can sit in `out` indefinitely without blocking completion.
 *
 * Sale items still expose Return/Lost/Damaged actions in the picker (a sold
 * item *can* be returned for credit and lost/damaged-in-transit is real) —
 * they're available, just not required for closure.
 */
export function isBookingClosed(b: Pick<Booking, "type" | "breakdown">): boolean {
  if (sumBreakdownKeys(b.breakdown, ["quoted", "reserved", "prepped"]) !== 0) return false;
  if (b.type === "rental" && b.breakdown.out !== 0) return false;
  return true;
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
 * `out` on a rental. A sale's `out` is delivered and never comes back, the same
 * split {@link isBookingClosed} makes.
 *
 * ⚠️ **Not `custodyMovedQuantity`.** That counts `returned`/`lost`/`damaged`
 * too — it answers "did custody ever move?", which decides whether a booking
 * may be DELETED (never, once it has any history — api-cloudrun#1147, Q4).
 * This answers "what is still out there?", which decides how much of a removed
 * or shrunk fulfillment row an order edit must KEEP (decision 3).
 */
export function liveCustody(b: Pick<Booking, "type" | "breakdown">): number {
  return sumBreakdownKeys(b.breakdown, b.type === "rental" ? ["prepped", "out"] : ["prepped"]);
}

/** Every key but the plan-only `quoted`/`reserved`. */
const HISTORY_KEYS: readonly BookingBreakdownKeyType[] = BOOKING_BREAKDOWN_KEYS.filter(
  (k) => k !== "quoted" && k !== "reserved",
);

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
  return sumBreakdownKeys(b.breakdown, HISTORY_KEYS) > 0;
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
