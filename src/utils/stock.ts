/**
 * Stock primitives — the interval rules and the two "how much does this consume"
 * definitions, in one place so the availability engine and the shelf allocator
 * cannot drift apart.
 *
 * Pure and db-free, like every `utils/*` module.
 *
 * ## ⚠️ There are TWO consumption definitions, and they are not interchangeable
 *
 * This is the whole reason this module exists. The obvious refactor — "both
 * functions sum a booking's breakdown, so give them one implementation" — is
 * **wrong**, and the docstring that used to sit on the allocator's copy claimed
 * exactly that (*"the same definition as `quantity_booked`"*). It is deleted.
 *
 * They differ because they are subtracted from **different denominators**:
 *
 * | | {@link heldByBooking} | {@link unitsClaimedOnShelves} |
 * |---|---|---|
 * | subtracted from | `ledger.quantity_held` | `ledger.store_breakdown` |
 * | does a rental check-out move that number? | **no** — the units stay owned | **yes** — they leave the shelf |
 * | so `out` must… | still count (rental) | not be re-counted |
 * | asked by | `computeAvailability` | the allocator's netting |
 *
 * A rental check-out is `locations → bookings`: the units leave
 * `store_breakdown` and `locations/{id}.products[]` but stay owned, so
 * `quantity_held` is unchanged. That is why the identity is
 * `quantity_held === Σ store_breakdown + units out at live bookings` rather than
 * `quantity_held === Σ store_breakdown` — the two are equal only when nothing is
 * out on a job.
 *
 * So unifying these onto {@link heldByBooking} would make the allocator
 * **under-net for rentals** and point two pickers at the same physical unit;
 * unifying onto {@link unitsClaimedOnShelves} would make availability
 * double-subtract a sale's units. Both directions are bugs. Keep them separate,
 * keep them named, and keep this table.
 *
 * ## The `sale` / `rental` axis is NOT settled — do not "align" it here
 *
 * {@link heldByBooking} keys on `type === "sale"`. Three other live sites key on
 * `type === "rental"` instead — `isBookingClosed` (`utils/bookings.ts`), the
 * order propagation spec (`schemas/propagation/orders.ts`) and manager's
 * fulfillment stage machine. Those agree with each other and disagree with this
 * one about `service`/`surcharge` bookings.
 *
 * It is latent because a service or surcharge product has `stock_method: "none"`
 * → no inventory ledger → no stock summary, so such a booking never reaches
 * {@link heldByBooking} at all. **It goes live the day someone gives a service
 * product a real stock method**, silently. Deciding it is a product question
 * ("do a service booking's checked-out units hold stock?"), not a refactor, so
 * it is recorded here rather than resolved.
 */
import type {
  BookingBreakdown,
  ComponentTypeType,
  FirestoreTimestampType,
  FirestoreTimestampValue,
} from "../schemas/mod.ts";

/** Just enough of a booking to answer either consumption question. */
export interface StockConsumingBooking {
  breakdown: BookingBreakdown;
  type: ComponentTypeType;
}

/**
 * Units this booking still consumes from **`quantity_held`** — the definition of
 * `quantity_booked`, and deliberately narrower than `sumBookingBreakdown`.
 *
 * `reserved + prepped`, plus `out` **unless the booking is a sale**. For a sale
 * the checkout is also the moment ownership ends: the movement drops
 * `quantity_held`, so counting the booking's `out` as well would subtract the
 * same units twice.
 *
 * Note this excludes `out` **only**, never the whole entry. A 5-unit sale
 * booking with 2 checked out must keep consuming for the other 3, or the
 * remainder is handed back as available and oversells — which is why the entry
 * stays in the summary rather than being filtered out of it.
 *
 * See the module header before making this agree with
 * {@link unitsClaimedOnShelves}. It should not.
 */
export function heldByBooking(b: StockConsumingBooking): number {
  const base = b.breakdown.reserved + b.breakdown.prepped;
  return b.type === "sale" ? base : base + b.breakdown.out;
}

/**
 * Units this booking still claims from **`store_breakdown`** — the shelf-side
 * question, and type-blind on purpose.
 *
 * `reserved + prepped + out`. It is used as a LIVENESS GATE by the allocator's
 * netting: a booking that holds nothing contributes no claim even if a stale
 * `stores` array lingers. The netting then subtracts the booking's whole
 * `stores[].locations[].quantity`, not this number — so this decides *whether*
 * a booking claims, not *how much*.
 *
 * ⚠️ **It includes `out`, and that is not the same statement as
 * {@link heldByBooking}'s.** Read the module header for why the two must differ.
 * Whether including `out` is right *here* is a separate, open question: a
 * check-out removes the units from `store_breakdown`, so a booking whose units
 * have all left arguably claims nothing more. Measured 2026-08-13 across both
 * environments, no live booking over-claims against its shelves (0 of 21
 * candidates), which is consistent with `recomputeBookingAllocations` converging
 * `stores` against the live ledger on every write. Do not "fix" this without
 * re-measuring that — the convergence job may be what is holding it up.
 */
export function unitsClaimedOnShelves(b: { breakdown: BookingBreakdown }): number {
  return (b.breakdown?.reserved ?? 0) + (b.breakdown?.prepped ?? 0) + (b.breakdown?.out ?? 0);
}

/**
 * Does this booking hold any physical stock at all? The shelf-side liveness
 * predicate — `unitsClaimedOnShelves(b) > 0`.
 *
 * Deliberately the shelf definition rather than {@link heldByBooking}: every
 * current caller is asking "is this booking still physically live", which a
 * fully-checked-out sale still is until it completes.
 */
export function bookingHoldsStock(b: { breakdown: BookingBreakdown }): boolean {
  return unitsClaimedOnShelves(b) > 0;
}

/** OOS statuses that no longer hold units out of service. */
export const TERMINAL_OOS_STATUSES: ReadonlySet<string> = new Set(["complete", "canceled"]);

/**
 * Units an out-of-service record consumes — its **full `quantity`** until it
 * reaches a terminal status, then zero.
 *
 * ⚠️ **Never reduce this by `breakdown.returned_to_service`.** A 5-unit record
 * with 3 returned to service still holds 5 out of service: the returned units
 * are accounted for by the record's own status transition, and subtracting them
 * here hands the same units back twice. It looks like a tidy-up and it is a live
 * oversell. (Swept 2026-08-13: no site in the workspace does this — keep it that
 * way.)
 */
export function oosConsumes(o: { status: string; quantity: number }): number {
  return TERMINAL_OOS_STATUSES.has(o.status) ? 0 : o.quantity;
}

/**
 * Resolve an interval bound to epoch millis, or `null` for open-ended.
 *
 * Prefers the `_fs` twin — that is the field Firestore itself orders by, so it
 * is the bound of record — and falls back to parsing the paired ISO string when
 * `_fs` isn't a real Timestamp (a plain-JSON fixture, a REST read, a write-time
 * `FieldValue` sentinel). `null` on both sides means genuinely open-ended.
 */
export function boundMs(
  fs: FirestoreTimestampType | null,
  iso: string | null,
): number | null {
  const maybe = fs as FirestoreTimestampValue | null;
  if (maybe && typeof maybe.toMillis === "function") return maybe.toMillis();
  if (iso) {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/**
 * Does `[startMs, endMs]` overlap `[windowStartMs, windowEndMs]`?
 *
 * A null bound is open-ended: `start === null` is −∞, `end === null` is +∞. That
 * single rule covers both an open-ended OOS record and — the load-bearing case —
 * a pending **sale** booking, which carries no end date because a sold unit does
 * not come back. It must keep consuming stock in every window after its sale
 * date until the booking completes and an operator's `sale` transaction drops
 * `quantity_held`. Collapsing a null end to a point (`end = start`) would hand
 * those units back as "available" the day after the sale — a live oversell.
 *
 * ⚠️ **A Firestore query CANNOT express this rule**, and that asymmetry has
 * already cost us. An inequality (`where("dates.end_fs", ">=", start)`) does not
 * match a null field, so a predicate written to mirror this function silently
 * drops every open-ended interval — measured 2026-08-13 as 80 prod / 73 dev
 * pending sale bookings invisible to the allocator's netting read
 * (api-cloudrun#512). A query needs an explicit `== null` arm; only in-memory
 * filtering can use this function directly.
 */
export function intervalsOverlap(
  startMs: number | null,
  endMs: number | null,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  return (startMs === null || startMs <= windowEndMs) &&
    (endMs === null || endMs >= windowStartMs);
}
