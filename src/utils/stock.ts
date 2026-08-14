/**
 * Stock primitives — the interval rules, the two "how much does this consume"
 * definitions, and the reduce-and-fold pair that turns raw booking / OOS rows
 * into an availability answer. One place, so the availability engine, the shelf
 * allocator and the oversell gate cannot drift apart.
 *
 * Pure and db-free, like every `utils/*` module.
 *
 * ## The three layers, and why they are one module
 *
 * 1. **Primitives** — {@link heldByBooking}, {@link unitsClaimedOnShelves},
 *    {@link oosConsumes}, {@link boundMs}, {@link intervalsOverlap},
 *    {@link windowMs}. The rules that are easy to get subtly wrong.
 * 2. **Reducers** — {@link unavailableFromBooking}, {@link unavailableFromOOS}:
 *    one source document → the pre-reduced anonymous interval stored in
 *    `stock/{P}.unavailable[]`.
 * 3. **The fold** — {@link computeStockAvailability}: that array + a window → the
 *    numbers.
 *
 * They sit together because **the projection writer and the oversell gate run
 * different halves of the same pipeline**. The rebuild runs (2) and stores the
 * result; a claim cannot use the stored result — it would be racing against the
 * projection's own freshness — so it reads the sources itself, runs (2) in
 * memory and then (3). Splitting the layers across modules would mean the
 * write path and the gate could come to disagree about what a booking consumes,
 * which is the exact failure this file exists to prevent.
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
 * ## The `sale` / `rental` axis reads like a disagreement and is NOT one
 *
 * {@link heldByBooking} keys on `type === "sale"` while `isBookingClosed`
 * (`utils/bookings.ts`) keys on `type === "rental"`, so on paper they differ
 * about `service`/`surcharge`. **Only `rental` and `sale` bookings can reach
 * this function**, so the two agree everywhere it is evaluated.
 *
 * Measured 2026-08-13, both environments, and worth keeping because the naive
 * version of this claim is false: 439 `service` bookings DO exist (over 15
 * products), so "services have no bookings" is not what makes this safe. What
 * makes it safe is that **0 of those 15 products carry an inventory ledger** — a
 * service product is `stock_method: "none"`, so it has no ledger, therefore no
 * stock summary, therefore nothing to evaluate here. Bookings exist for
 * `rental` and `sale`; only those with a stock method hold stock.
 *
 * So do NOT "align" the two predicates. They are answering different questions
 * about the only two types that arrive, and each is right about its own.
 *
 * ## What IS open: a sale can come back
 *
 * `sale` being terminal on `out` is the general rule, not an absolute one — a
 * sold item can be returned, for a refund or without one, and the transaction
 * system already models that (`sale_return`, alongside `check_in`). When it
 * happens the units re-enter `quantity_held` through that transaction and this
 * function needs no special case: a returned unit leaves `out` for `returned`,
 * and neither counts here.
 *
 * The gap is downstream, not here: **0 sale bookings in either environment have
 * `returned > 0`**, i.e. the path has never been exercised end to end, and
 * fulfillment support for it is incomplete (api-cloudrun#513).
 */
import type {
  BookingBreakdown,
  BookingStatusType,
  ComponentTypeType,
  FirestoreTimestampType,
  FirestoreTimestampValue,
  OOSStatusType,
  Stock,
  StockUnavailableEntry,
} from "../schemas/mod.ts";
import { toChicagoEndOfDay, toChicagoStartOfDay } from "./dates.ts";

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

// ── The window ───────────────────────────────────────────────────────────────

/** The window an availability question is asked about. Offset-carrying ISO strings. */
export interface AvailabilityWindow {
  start: string;
  end: string;
}

/**
 * Normalize a requested window to the Chicago wall-clock day span it means, as
 * epoch millis.
 *
 * **Availability is always Chicago wall clock, and this function owns that
 * rule.** The shop is in Chicago; a requester in California asking for "June 1 –
 * June 5" means Chicago `Jun 1 00:00:00.000` → `Jun 5 23:59:59.999`, no matter
 * where the browser is — so a `-08:00`, a `Z` and a `-06:00` spelling of the same
 * day must produce identical numbers. Callers pass offset-carrying ISO strings; a
 * bare `YYYY-MM-DD` is rejected upstream by the schema factories.
 *
 * It lives here rather than in `utils/availability.ts` (which is where it was)
 * because both the summary engine and the pre-reduced fold below need it, and
 * this module is the one they can both reach: `availability.ts` already imports
 * from here, so the reverse edge would be a cycle.
 */
export function windowMs(window: AvailabilityWindow): { startMs: number; endMs: number } {
  return {
    startMs: Date.parse(toChicagoStartOfDay(window.start)),
    endMs: Date.parse(toChicagoEndOfDay(window.end)),
  };
}

// ── Source → pre-reduced entry (the reducers) ────────────────────────────────

/**
 * Just enough of a booking to reduce it to an unavailable interval. Structural
 * rather than `Pick<Booking, …>` so a caller can hand over a whole `Booking`, a
 * REST read, or a fixture — and so `dates` names only the two bounds that are
 * read, never the `_fs` twins (see {@link unavailableFromBooking}).
 */
export interface StockBookingSource extends StockConsumingBooking {
  status: BookingStatusType;
  dates: { start: string | null; end: string | null };
}

/** Just enough of an out-of-service record to reduce it to an unavailable interval. */
export interface StockOOSSource {
  status: OOSStatusType;
  quantity: number;
  dates: { start: string | null; end: string | null };
}

/**
 * Reduce a booking to the interval it makes unavailable, or `null` when it makes
 * none.
 *
 * `null` covers **both** exits, and folding them into one function is the point:
 * a `complete` booking has left the live working set, and a live booking that
 * consumes nothing (a `quoted` one holds no units) contributes nothing to any
 * answer. Two separate rules — a liveness filter on the query and a
 * zero-quantity filter on the projection — is what the previous model had, and
 * they could disagree.
 *
 * ⚠️ **The liveness test must be shared with whatever reads the sources.** The
 * rebuild query filters on status, and an overlay call site passes the
 * *post-write* booking — which may be the very write that completed it. Without
 * one rule the two disagree: the query drops a freshly-completed booking while
 * the overlay adds it straight back. That is not cosmetic — a completed **sale**
 * booking carries `out === quantity`, so leaving it in would keep consuming stock
 * forever, against the very `sale` transaction that removed those units from
 * `quantity_held`.
 *
 * The bounds are copied from the ISO fields and the `_fs` twins are ignored, not
 * because they are unreliable but because they have no job here: `_fs` exists so
 * Firestore can order and range-filter the `bookings` collection, and nothing
 * range-filters an array member. A null bound is preserved, never coerced — for a
 * pending sale it is the whole point.
 */
export function unavailableFromBooking(b: StockBookingSource): StockUnavailableEntry | null {
  if (b.status === "complete") return null;
  const quantity = heldByBooking(b);
  if (quantity <= 0) return null;
  return { start: b.dates.start, end: b.dates.end, quantity, kind: "booking" };
}

/**
 * Reduce an out-of-service record to the interval it makes unavailable, or `null`
 * when it makes none.
 *
 * The liveness rule is {@link oosConsumes}'s — terminal statuses hold zero — so
 * the status set is not restated here. See that function for the rule that must
 * never be "cleaned up": a live record claims its **full `quantity`**, never
 * reduced by `breakdown.returned_to_service`.
 */
export function unavailableFromOOS(o: StockOOSSource): StockUnavailableEntry | null {
  const quantity = oosConsumes(o);
  if (quantity <= 0) return null;
  return { start: o.dates.start, end: o.dates.end, quantity, kind: "oos" };
}

// ── The fold ────────────────────────────────────────────────────────────────

/** Everything a consumer needs from one product over one window. */
export interface StockAvailability {
  quantity_held: number;
  quantity_booked: number;
  quantity_out_of_service: number;
  quantity_available: number;
}

/**
 * Compute availability for one product over one window, from the pre-reduced
 * projection.
 *
 * ```
 * quantity_available = quantity_held − quantity_booked(w) − quantity_out_of_service(w)
 * ```
 *
 * Negative results are preserved, never clamped: an oversold product must stay
 * visibly oversold, and #424 makes that the intended shortage signal for
 * operators rather than an error state.
 *
 * `quantity_in_service` is not returned — it is `quantity_held −
 * quantity_out_of_service`, and no current consumer asks for it.
 *
 * ⚠️ **This must not be decomposed into a per-day rollup.** With `held = 2`, a
 * booking on days 1–2 and another on days 4–5, the answer for window `[1, 5]` is
 * exactly **0** — no single unit is free for the whole span — while a
 * min-over-days curve says 1. Overstating availability oversells. Intervals give
 * the exact answer; a daily curve does not.
 */
export function computeStockAvailability(
  stock: Pick<Stock, "quantity_held" | "unavailable">,
  window: AvailabilityWindow,
): StockAvailability {
  const { startMs, endMs } = windowMs(window);

  let quantity_booked = 0;
  let quantity_out_of_service = 0;

  for (const u of stock.unavailable) {
    const start = u.start === null ? null : Date.parse(u.start);
    const end = u.end === null ? null : Date.parse(u.end);
    if (!intervalsOverlap(start, end, startMs, endMs)) continue;
    if (u.kind === "booking") quantity_booked += u.quantity;
    else quantity_out_of_service += u.quantity;
  }

  const quantity_held = stock.quantity_held;
  return {
    quantity_held,
    quantity_booked,
    quantity_out_of_service,
    quantity_available: quantity_held - quantity_booked - quantity_out_of_service,
  };
}
