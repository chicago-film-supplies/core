/**
 * PublicStockSummary document schema — Firestore collection: public-stock-summaries
 *
 * The sanitized projection of `stock-summaries/{productUid}` (same doc id).
 * Bookings and out-of-service records are merged into one anonymous
 * `unavailable[]` list of intervals: no uid, no booking number, no order, no OOS
 * reason. An outsider can't tell "booked" from "in for repair" — but
 *
 *   quantity_available(w) = quantity_held − Σ quantity over `unavailable` overlapping w
 *
 * still yields the **exact** number, so the public storefront derives real
 * availability for any window with no privileged read and no round-trip.
 *
 * Only stock-*consuming* entries appear: a booking contributes
 * `reserved + prepped + out` (the `quantity_booked` definition — a `quoted`
 * booking holds no units), and zero-quantity entries are dropped entirely.
 *
 * `end: null` means open-ended, and carries real weight here — a pending sale
 * booking has no end date, so it must keep the unit unavailable in every later
 * window. See the note in `stock-summary.ts`.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  FirestoreTimestamp,
  type FirestoreTimestampType,
  ProductTypeEnum,
  type ProductTypeType,
} from "./common.ts";

/** One anonymous unavailable interval — a booking or an OOS record, indistinguishable. */
export interface PublicUnavailableEntry {
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
  quantity: number;
}

/** Window-independent, public-safe availability inputs for one product. */
export interface PublicStockSummary {
  uid: string;
  uid_product: string;
  type: ProductTypeType;
  quantity_held: number;
  unavailable: PublicUnavailableEntry[];
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const PublicUnavailableEntrySchema: z.ZodType<PublicUnavailableEntry> = z.strictObject({
  start: chicagoInstant().nullable(),
  start_fs: FirestoreTimestamp.nullable(),
  end: chicagoInstant().nullable(),
  end_fs: FirestoreTimestamp.nullable(),
  quantity: z.number(),
});

/** Zod schema for PublicStockSummary. */
export const PublicStockSummarySchema: z.ZodType<PublicStockSummary> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  type: ProductTypeEnum.meta({ column: true, label: "Type" }),
  quantity_held: z.number().meta({ column: true, label: "Quantity Held" }),
  unavailable: z.array(PublicUnavailableEntrySchema).default([]).meta({ column: true, label: "Unavailable" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Public Stock Summary",
  collection: "public-stock-summaries",
  displayDefaults: {
    columns: ["type", "quantity_held", "unavailable"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
