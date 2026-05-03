/**
 * OutOfServiceRecord document schema — Firestore collection: out-of-service
 *
 * An OOS record tracks a quantity of inventory removed from active service for
 * a particular reason (cleaning, damaged, maintenance, lost). Records can be
 * born from a booking update (warehouse marks items lost or damaged on
 * check-in), from a manual admin action, or from CRMS quarantine sync.
 *
 * `sources` is a polymorphic 0..N list using the shared `DocSourceType` shape
 * (`{ collection, uid, label }`). Conventions:
 *   - OOS from a booking update → two entries: `bookings:<uid>` + `orders:<uid>`
 *   - OOS manually attached to an order → one entry: `orders:<uid>`
 *   - Fully ad-hoc OOS (shelf maintenance) → empty array
 * The companion `query_by_sources: string[]` (`["<collection>:<uid>", ...]`)
 * gives Firestore `array-contains` filtering for both order- and
 * booking-detail lookups without sub-object equality issues.
 */
import { z } from "zod";
import { chicagoInstant } from "./_datetime.ts";
import {
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OOSReasonEnum,
  type OOSReasonType,
  TimestampFields,
} from "./common.ts";

/** A location within a store affected by an out-of-service record. */
export interface OOSStoreLocation {
  uid_location: string;
  name: string;
  transactionQuantity: number;
  default: boolean;
  max?: number | null;
}

/** A store affected by an out-of-service record. */
export interface OOSStore {
  uid_store: string;
  name: string;
  locations: OOSStoreLocation[];
}

/** A transaction entry within an out-of-service record. */
export interface OOSTransaction {
  crms_id?: number | null;
  crms_quarantine_id?: number | null;
  crms_stock_level_id?: number | null;
  date: string;
  date_fs?: FirestoreTimestampType;
  out_of_service_uid: string;
  quantity: number;
  stock_level_uid?: string;
  type: string;
}

/** Date object — booking-style start/end with paired Firestore timestamps. */
export interface OOSDates {
  start: string;
  start_fs: FirestoreTimestampType;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
}

/** An out-of-service record tracking inventory removed from active service. */
export interface OutOfServiceRecord {
  uid: string;
  uid_product: string;
  reason: OOSReasonType;
  quantity: number;
  quantity_return_to_service: number;
  quantity_write_off: number;
  complete?: boolean;
  dates: OOSDates;
  sources: DocSourceType[];
  query_by_sources: string[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
  stock_level_id?: string | null;
  stores?: OOSStore[];
  query_by_uid_store?: string[];
  query_by_uid_location?: string[];
  transactions?: OOSTransaction[];
  defaultThreadId?: string;
  version: number;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

const OOSStoreLocationSchema: z.ZodType<OOSStoreLocation> = z.strictObject({
  uid_location: z.string(),
  name: z.string(),
  transactionQuantity: z.number(),
  default: z.boolean(),
  max: z.number().nullable().optional(),
});

const OOSStoreSchema: z.ZodType<OOSStore> = z.strictObject({
  uid_store: z.string(),
  name: z.string(),
  locations: z.array(OOSStoreLocationSchema).default([]),
});

const OOSTransactionSchema: z.ZodType<OOSTransaction> = z.strictObject({
  crms_id: z.number().nullable().optional(),
  crms_quarantine_id: z.number().nullable().optional(),
  crms_stock_level_id: z.number().nullable().optional(),
  date: chicagoInstant(),
  date_fs: FirestoreTimestamp.optional(),
  out_of_service_uid: z.string(),
  quantity: z.number(),
  stock_level_uid: z.string().optional(),
  type: z.string(),
});

const OOSDatesSchema: z.ZodType<OOSDates> = z.strictObject({
  start: chicagoInstant().meta({ serverSortVia: "dates.start_fs" }),
  start_fs: FirestoreTimestamp,
  end: chicagoInstant().meta({ serverSortVia: "dates.end_fs" }).nullable(),
  end_fs: FirestoreTimestamp.nullable(),
});

/** Zod schema for OutOfServiceRecord. */
export const OutOfServiceRecordSchema: z.ZodType<OutOfServiceRecord> = z.strictObject({
  uid: z.string(),
  uid_product: z.string(),
  reason: OOSReasonEnum,
  quantity: z.number().meta({ serverSortVia: "quantity" }),
  quantity_return_to_service: z.number(),
  quantity_write_off: z.number(),
  complete: z.boolean().optional(),
  dates: OOSDatesSchema,
  sources: z.array(DocSource).default([]),
  query_by_sources: z.array(z.string()).default([]),
  crms_id: z.number().nullable().optional(),
  crms_stock_level_id: z.number().nullable().optional(),
  stock_level_id: z.string().nullable().optional(),
  stores: z.array(OOSStoreSchema).default([]).optional(),
  query_by_uid_store: z.array(z.string()).default([]).optional(),
  query_by_uid_location: z.array(z.string()).default([]).optional(),
  transactions: z.array(OOSTransactionSchema).optional(),
  defaultThreadId: z.string().optional(),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Out of Service Record",
  collection: "out-of-service",
  displayDefaults: {
    columns: ["reason", "quantity", "dates.start", "dates.end"],
    filters: {},
    sort: { column: "dates.start", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────────

/** Input for creating an out-of-service record. */
export interface CreateOutOfServiceRecordInputType {
  uid_product: string;
  reason: OOSReasonType;
  quantity: number;
  quantity_return_to_service?: number;
  quantity_write_off?: number;
  dates: { start: string; end?: string | null };
  sources?: DocSourceType[];
  stores?: OOSStore[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
  stock_level_id?: string | null;
}

/** Zod schema for CreateOutOfServiceRecordInput. */
export const CreateOutOfServiceRecordInput: z.ZodType<CreateOutOfServiceRecordInputType> = z.object({
  uid_product: z.string().min(1),
  reason: OOSReasonEnum,
  quantity: z.number().positive(),
  quantity_return_to_service: z.number().min(0).optional(),
  quantity_write_off: z.number().min(0).optional(),
  dates: z.object({
    start: chicagoInstant(),
    end: chicagoInstant().nullable().optional(),
  }),
  sources: z.array(DocSource).default([]).optional(),
  stores: z.array(OOSStoreSchema).default([]).optional(),
  crms_id: z.number().nullable().optional(),
  crms_stock_level_id: z.number().nullable().optional(),
  stock_level_id: z.string().nullable().optional(),
});

/** Input for updating an out-of-service record. */
export interface UpdateOutOfServiceRecordInputType {
  complete?: boolean;
  quantity_return_to_service?: number;
  quantity_write_off?: number;
  dates?: { end?: string | null };
  stores?: OOSStore[];
  version: number;
}

/** Zod schema for UpdateOutOfServiceRecordInput. */
export const UpdateOutOfServiceRecordInput: z.ZodType<UpdateOutOfServiceRecordInputType> = z.object({
  complete: z.boolean().optional(),
  quantity_return_to_service: z.number().min(0).optional(),
  quantity_write_off: z.number().min(0).optional(),
  dates: z.object({
    end: chicagoInstant().nullable().optional(),
  }).optional(),
  stores: z.array(OOSStoreSchema).optional(),
  version: z.int().min(0),
});
