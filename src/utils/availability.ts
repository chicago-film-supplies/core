/**
 * The availability engine — the single source of the CFS availability formula.
 *
 * A stock summary caches the *inputs* to an availability answer (one doc per
 * product: `quantity_held` + the live booking intervals + the live OOS
 * intervals). The window enters only as an overlap filter, so any window is
 * derivable from that one doc, by anyone holding it:
 *
 * ```ts
 * import { computeAvailability } from "@cfs/core/utils/availability";
 *
 * const { quantity_available } = computeAvailability(summary, {
 *   start: "2026-06-01T00:00:00.000-05:00",
 *   end:   "2026-06-05T00:00:00.000-05:00",
 * });
 * ```
 *
 * Pure and db-free: interval arithmetic runs off `FirestoreTimestampValue`'s
 * structural `toMillis()` (or the paired ISO string), so this runs unchanged in
 * Deno on the server, in the browser against an `onSnapshot` doc, and over a
 * plain JSON fixture in a test. No Firestore SDK import, either side.
 *
 * **Availability is always Chicago wall clock, and this module owns that rule.**
 * The shop is in Chicago; a requester in California asking for "June 1 – June 5"
 * means Chicago `Jun 1 00:00:00.000` → `Jun 5 23:59:59.999`, no matter where the
 * browser is. The window is normalized here — `toChicagoStartOfDay` on `start`,
 * `toChicagoEndOfDay` on `end` — so a `-08:00`, a `Z` and a `-06:00` spelling of
 * the same day produce identical numbers. Callers pass offset-carrying ISO
 * strings; a bare `YYYY-MM-DD` is rejected upstream by the schema factories.
 *
 * **This must not be decomposed into a per-day rollup.** With `held = 2`, a
 * booking on days 1–2 and another on days 4–5, the answer for window `[1, 5]` is
 * exactly **0** — no single unit is free for the whole span — while a
 * min-over-days curve says 1. Overstating availability oversells. Intervals give
 * the exact answer; a daily curve does not.
 *
 * @module
 */
import type {
  BookingBreakdown,
  ComponentTypeType,
  FirestoreTimestampType,
  FirestoreTimestampValue,
  OOSReasonType,
  PublicStockSummary,
  StockSummary,
  StockSummaryBookingEntry,
} from "../schemas/mod.ts";
import { emptyBookingsBreakdown } from "./bookings.ts";
import { toChicagoEndOfDay, toChicagoStartOfDay } from "./dates.ts";

/** The window an availability question is asked about. Offset-carrying ISO strings. */
export interface AvailabilityWindow {
  start: string;
  end: string;
}

/** Per-reason out-of-service quantities over the window. */
export interface OutOfServiceBreakdown {
  cleaning: number;
  damaged: number;
  maintenance: number;
  lost: number;
}

/** Everything the manager's availability cells and stock panel need for one window. */
export interface AvailabilityResult {
  quantity_held: number;
  quantity_booked: number;
  quantity_out_of_service: number;
  quantity_in_service: number;
  quantity_available: number;
  bookings_breakdown: BookingBreakdown;
  out_of_service_breakdown: OutOfServiceBreakdown;
  /** The booking entries that actually overlap the window — the audit trail. */
  bookings: StockSummaryBookingEntry[];
}

/** The public storefront's answer — no booking/OOS detail, same exact numbers. */
export interface PublicAvailabilityResult {
  quantity_held: number;
  quantity_unavailable: number;
  quantity_available: number;
}

/** OOS statuses that no longer hold units out of service. */
const TERMINAL_OOS_STATUSES = new Set(["complete", "canceled"]);

/** The empty per-reason OOS breakdown. */
function emptyOutOfServiceBreakdown(): OutOfServiceBreakdown {
  return { cleaning: 0, damaged: 0, maintenance: 0, lost: 0 };
}

/**
 * Resolve an interval bound to epoch millis, or `null` for open-ended.
 *
 * Prefers the `_fs` twin — that is the field Firestore itself orders by, so it
 * is the bound of record — and falls back to parsing the paired ISO string when
 * `_fs` isn't a real Timestamp (a plain-JSON fixture, a REST read, a write-time
 * `FieldValue` sentinel). `null` on both sides means genuinely open-ended.
 */
function boundMs(fs: FirestoreTimestampType | null, iso: string | null): number | null {
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
 * not come back. It must keep consuming stock in every window after its sale date
 * until the booking completes and an operator's `sale` transaction drops
 * `quantity_held`. Collapsing a null end to a point (`end = start`) would hand
 * those units back as "available" the day after the sale — a live oversell.
 */
function overlaps(
  startMs: number | null,
  endMs: number | null,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  return (startMs === null || startMs <= windowEndMs) &&
    (endMs === null || endMs >= windowStartMs);
}

/**
 * Normalize a requested window to the Chicago wall-clock day span it means, as
 * epoch millis. See the module note: this is where "June 1 – June 5" becomes
 * Chicago `Jun 1 00:00:00.000` → `Jun 5 23:59:59.999` regardless of the caller's
 * offset.
 */
function windowMs(window: AvailabilityWindow): { startMs: number; endMs: number } {
  return {
    startMs: Date.parse(toChicagoStartOfDay(window.start)),
    endMs: Date.parse(toChicagoEndOfDay(window.end)),
  };
}

/**
 * The units a booking still consumes from stock: `reserved + prepped + out`. A
 * `quoted` booking has claimed nothing yet, and the terminal buckets
 * (`returned`, `lost`, `damaged`) have already given the units back or written
 * them off — this is the definition of `quantity_booked`, and it is deliberately
 * narrower than `sumBookingBreakdown`.
 *
 * **A sale's `out` units are excluded**, because for a sale the checkout is also
 * the moment ownership ends: the movement drops `quantity_held`, so counting the
 * booking's `out` as well would subtract the same units twice.
 *
 * Note this excludes `out` **only** — not the whole entry. A 5-unit sale booking
 * with 2 checked out must keep consuming for the other 3, or the remainder is
 * handed back as available and oversells. That is why the entry stays in the
 * summary rather than being filtered out of it.
 *
 * Both call sites — `computeAvailability` and `toPublicStockSummary` — go through
 * here, so the manager and the public storefront cannot disagree about it.
 */
function heldByBooking(b: { breakdown: BookingBreakdown; type: ComponentTypeType }): number {
  const base = b.breakdown.reserved + b.breakdown.prepped;
  return b.type === "sale" ? base : base + b.breakdown.out;
}

/**
 * Compute availability for one product over one window, from the cached inputs.
 *
 * ```
 * quantity_available = quantity_held − quantity_booked(w) − quantity_out_of_service(w)
 * ```
 *
 * Negative results are preserved, never clamped: an oversold product must stay
 * visibly oversold.
 */
export function computeAvailability(
  summary: StockSummary,
  window: AvailabilityWindow,
): AvailabilityResult {
  const { startMs, endMs } = windowMs(window);

  const bookings: StockSummaryBookingEntry[] = [];
  const bookings_breakdown = emptyBookingsBreakdown();
  let quantity_booked = 0;

  for (const b of summary.bookings) {
    if (!overlaps(boundMs(b.start_fs, b.start), boundMs(b.end_fs, b.end), startMs, endMs)) {
      continue;
    }
    bookings.push(b);
    quantity_booked += heldByBooking(b);
    bookings_breakdown.quoted += b.breakdown.quoted;
    bookings_breakdown.reserved += b.breakdown.reserved;
    bookings_breakdown.prepped += b.breakdown.prepped;
    bookings_breakdown.out += b.breakdown.out;
    bookings_breakdown.returned += b.breakdown.returned;
    bookings_breakdown.lost += b.breakdown.lost;
    bookings_breakdown.damaged += b.breakdown.damaged;
  }

  const out_of_service_breakdown = emptyOutOfServiceBreakdown();
  let quantity_out_of_service = 0;

  for (const o of summary.out_of_service) {
    if (TERMINAL_OOS_STATUSES.has(o.status)) continue;
    if (!overlaps(boundMs(o.start_fs, o.start), boundMs(o.end_fs, o.end), startMs, endMs)) {
      continue;
    }
    quantity_out_of_service += o.quantity;
    out_of_service_breakdown[o.reason as OOSReasonType] += o.quantity;
  }

  const quantity_held = summary.quantity_held;
  return {
    quantity_held,
    quantity_booked,
    quantity_out_of_service,
    quantity_in_service: quantity_held - quantity_out_of_service,
    quantity_available: quantity_held - quantity_booked - quantity_out_of_service,
    bookings_breakdown,
    out_of_service_breakdown,
    bookings,
  };
}

/**
 * The public-storefront form. Same arithmetic, run over the sanitized
 * `unavailable[]` list (bookings ∪ OOS, merged and anonymized), so an outsider
 * gets the exact number without learning what made a unit unavailable.
 */
export function computePublicAvailability(
  summary: PublicStockSummary,
  window: AvailabilityWindow,
): PublicAvailabilityResult {
  const { startMs, endMs } = windowMs(window);

  let quantity_unavailable = 0;
  for (const u of summary.unavailable) {
    if (overlaps(boundMs(u.start_fs, u.start), boundMs(u.end_fs, u.end), startMs, endMs)) {
      quantity_unavailable += u.quantity;
    }
  }

  const quantity_held = summary.quantity_held;
  return {
    quantity_held,
    quantity_unavailable,
    quantity_available: quantity_held - quantity_unavailable,
  };
}

/**
 * Project the internal summary to its public twin — the one place the sanitized
 * shape is defined, so the API's writer and any rebuild script can't drift.
 *
 * Bookings and OOS records merge into one anonymous interval list. Only
 * stock-*consuming* entries survive: a booking contributes `heldByBooking` (a
 * `quoted` booking holds nothing), and zero-quantity entries are dropped
 * outright — they'd leak the existence of a booking without affecting any answer.
 */
export function toPublicStockSummary(summary: StockSummary): PublicStockSummary {
  const unavailable: PublicStockSummary["unavailable"] = [];

  for (const b of summary.bookings) {
    const quantity = heldByBooking(b);
    if (quantity <= 0) continue;
    unavailable.push({
      start: b.start,
      start_fs: b.start_fs,
      end: b.end,
      end_fs: b.end_fs,
      quantity,
    });
  }

  for (const o of summary.out_of_service) {
    if (TERMINAL_OOS_STATUSES.has(o.status)) continue;
    if (o.quantity <= 0) continue;
    unavailable.push({
      start: o.start,
      start_fs: o.start_fs,
      end: o.end,
      end_fs: o.end_fs,
      quantity: o.quantity,
    });
  }

  return {
    uid: summary.uid,
    uid_product: summary.uid_product,
    type: summary.type,
    quantity_held: summary.quantity_held,
    unavailable,
    created_at: summary.created_at,
    updated_at: summary.updated_at,
  };
}
