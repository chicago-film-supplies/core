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
  OOSReasonType,
  PublicStockSummary,
  StockSummary,
  StockSummaryBookingEntry,
} from "../schemas/mod.ts";
import { emptyBookingsBreakdown } from "./bookings.ts";
import {
  type AvailabilityWindow,
  boundMs,
  heldByBooking,
  intervalsOverlap,
  oosConsumes,
  windowMs,
} from "./stock.ts";

// The window type and its Chicago normalization moved down into `utils/stock.ts`
// when the pre-reduced fold landed there and needed them too — this module
// already imports from that one, so the reverse edge would be a cycle. Re-exported
// rather than relocated silently: `AvailabilityWindow` is the parameter type of
// every availability call in the manager.
export type { AvailabilityWindow };

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

/** The empty per-reason OOS breakdown. */
function emptyOutOfServiceBreakdown(): OutOfServiceBreakdown {
  return { cleaning: 0, damaged: 0, maintenance: 0, lost: 0 };
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
    if (!intervalsOverlap(boundMs(b.start_fs, b.start), boundMs(b.end_fs, b.end), startMs, endMs)) {
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
    if (!intervalsOverlap(boundMs(o.start_fs, o.start), boundMs(o.end_fs, o.end), startMs, endMs)) {
      continue;
    }
    // `oosConsumes` owns BOTH halves of the rule — terminal statuses hold zero,
    // and a live record holds its FULL `quantity` (never reduced by
    // `returned_to_service`). Going through it rather than restating the status
    // set here is what keeps this arm and the summary writer in step.
    const quantity = oosConsumes(o);
    if (quantity === 0) continue;
    quantity_out_of_service += quantity;
    out_of_service_breakdown[o.reason as OOSReasonType] += quantity;
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
    if (intervalsOverlap(boundMs(u.start_fs, u.start), boundMs(u.end_fs, u.end), startMs, endMs)) {
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
    // Same one rule as `computeAvailability`'s OOS arm — terminal holds zero,
    // live holds its full `quantity`. Sharing `oosConsumes` is what stops the
    // projection and the reader disagreeing about which records still bite.
    const quantity = oosConsumes(o);
    if (quantity <= 0) continue;
    unavailable.push({
      start: o.start,
      start_fs: o.start_fs,
      end: o.end,
      end_fs: o.end_fs,
      quantity,
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
