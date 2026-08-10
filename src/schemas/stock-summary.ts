/**
 * StockSummary document schema — Firestore collection: stock-summaries
 *
 * **One doc per product; the doc id IS the product uid.** The doc caches the
 * *inputs* to an availability answer, never an answer itself:
 *
 *   quantity_booked(s,e) = Σ (reserved+prepped+out)  over bookings overlapping [s,e]
 *   quantity_oos(s,e)    = Σ quantity                over OOS records overlapping [s,e]
 *   quantity_available   = quantity_held − quantity_booked(s,e) − quantity_oos(s,e)
 *
 * The window enters only as an overlap filter, so any window is derivable from
 * this one doc by `computeAvailability` (`@cfs/core/utils/availability`) — in
 * Deno or in the browser, with no round-trip. Keying on the *question* instead
 * (the old `{product}:rental:{start}:{end}` id) made storage scale with every
 * date range anyone ever asked about, which is what forced the 50-doc cap, the
 * TTL, the pruner, and the mint-on-read from an unauthenticated endpoint.
 *
 * **Interval bounds are nullable on both sides, and null means open-ended**
 * (`start: null` = −∞, `end: null` = +∞) — one rule for bookings and OOS alike.
 * This is not a formality: a *sale* booking carries `end: null` because a sold
 * unit does not come back, so it must keep consuming stock in every window after
 * its sale date until the booking completes and an operator's `sale` transaction
 * drops `quantity_held`. Treating a null end as a point event (`end = start`)
 * would hand those units back as "available" the day after the sale — a live
 * oversell. Bookings with a null `start` (none exist today, but the Booking
 * schema permits it) are −∞ by the same rule, which under-sells rather than
 * over-sells.
 */
import { z } from "zod";
import { BookingId, FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ComponentTypeEnum,
  type ComponentTypeType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OOSReasonEnum,
  type OOSReasonType,
  ProductTypeEnum,
  type ProductTypeType,
} from "./common.ts";
import { type BookingBreakdown, BookingBreakdownSchema } from "./booking.ts";
import { OOSStatusEnum, type OOSStatusType } from "./out-of-service.ts";

/**
 * A live (non-complete) booking as an interval + its breakdown. `end`/`end_fs`
 * null = open-ended (see the module note — this is the sale case).
 */
export interface StockSummaryBookingEntry {
  uid: string;
  number: number;
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  breakdown: BookingBreakdown;
  /**
   * The booking's `Booking.type`. Drives the sale rule in `heldByBooking`
   * (`@cfs/core/utils/availability`): a sale's `out` units have already left
   * ownership, so counting them again would subtract them twice.
   *
   * Required. A summary is a pure projection of its product's bookings and OOS
   * records, so making this required costs a rebuild, not a backfill — and an
   * optional field here would mean two availability behaviours coexisting, which
   * is the one thing this document exists to prevent.
   */
  type: ComponentTypeType;
}

/** A non-terminal out-of-service record as an interval + its quantity. */
export interface StockSummaryOOSEntry {
  uid: string;
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  quantity: number;
  reason: OOSReasonType;
  status: OOSStatusType;
}

/**
 * Window-independent availability inputs for one product. Doc id == `uid` ==
 * `uid_product` == the product's / inventory-ledger's Firestore id.
 */
export interface StockSummary {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  quantity_held: number;
  bookings: StockSummaryBookingEntry[];
  out_of_service: StockSummaryOOSEntry[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const StockSummaryBookingEntrySchema: z.ZodType<StockSummaryBookingEntry> = z.strictObject({
  uid: BookingId,
  number: z.number().meta({ column: true, label: "#" }),
  start: chicagoInstant().meta({ column: true, label: "Start" }).nullable(),
  start_fs: FirestoreTimestamp.nullable(),
  end: chicagoInstant().meta({ column: true, label: "End" }).nullable(),
  end_fs: FirestoreTimestamp.nullable(),
  breakdown: BookingBreakdownSchema,
  type: ComponentTypeEnum,
});

const StockSummaryOOSEntrySchema: z.ZodType<StockSummaryOOSEntry> = z.strictObject({
  uid: FirestoreId,
  start: chicagoInstant().meta({ column: true, label: "Start" }).nullable(),
  start_fs: FirestoreTimestamp.nullable(),
  end: chicagoInstant().meta({ column: true, label: "End" }).nullable(),
  end_fs: FirestoreTimestamp.nullable(),
  quantity: z.number().meta({ column: true, label: "Quantity" }),
  reason: OOSReasonEnum.meta({ column: true, label: "Reason" }),
  status: OOSStatusEnum.meta({ column: true, label: "Status" }),
});

/** Zod schema for StockSummary. */
export const StockSummarySchema: z.ZodType<StockSummary> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  type: ProductTypeEnum.meta({ column: true, label: "Type" }),
  quantity_held: z.number().meta({ column: true, label: "Quantity Held" }),
  bookings: z.array(StockSummaryBookingEntrySchema).default([]).meta({ label: "Booking" }),
  out_of_service: z.array(StockSummaryOOSEntrySchema).default([]).meta({ label: "Out of Service" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Stock Summary",
  collection: "stock-summaries",
  displayDefaults: {
    columns: ["type", "quantity_held", "bookings.number", "out_of_service.quantity"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
