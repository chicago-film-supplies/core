/**
 * Booking document schema — Firestore collection: bookings
 */
import { z } from "zod";
import { BookingId, FirestoreId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  Address,
  type AddressType,
  ComponentTypeEnum,
  type ComponentTypeType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
} from "./common.ts";

export const BOOKING_STATUSES = [
  "draft", "quoted", "reserved", "part-prepped", "prepped", "active", "complete",
] as const;
export type BookingStatusType = typeof BOOKING_STATUSES[number];
const BookingStatus: z.ZodType<BookingStatusType> = z.enum(BOOKING_STATUSES);

/** A reference to a destination with its address, used in booking delivery/collection. */
export interface BookingDestinationRef {
  uid: string;
  address: AddressType | null;
}

/** Per-status quantity breakdown for a booking — also embedded in stock-summary entries. */
export interface BookingBreakdown {
  damaged: number;
  lost: number;
  out: number;
  prepped: number;
  quoted: number;
  reserved: number;
  returned: number;
}

/** Zod schema for BookingBreakdown. */
export const BookingBreakdownSchema: z.ZodType<BookingBreakdown> = z.strictObject({
  damaged: z.number(),
  lost: z.number(),
  out: z.number(),
  prepped: z.number(),
  quoted: z.number(),
  reserved: z.number(),
  returned: z.number(),
});

/**
 * All seven keys of the booking lifecycle breakdown, in lifecycle order (which
 * is NOT the schema's alphabetical field order — the UI reads left to right).
 *
 * These live beside the schema rather than in `utils/bookings.ts` because
 * schema modules cannot import utils (the dependency runs strictly one way) and
 * the movement journal needs the key union to type a custody transition.
 * `utils/bookings.ts` re-exports all three, so existing importers are unaffected.
 */
export const BOOKING_BREAKDOWN_KEYS = [
  "quoted", "reserved", "prepped", "out", "returned", "lost", "damaged",
] as const;

/** Keys representing items that are still in flight (pre-terminal). */
export const BOOKING_BREAKDOWN_OPEN_KEYS = ["quoted", "reserved", "prepped", "out"] as const;

/** Keys representing items that have reached a terminal state. */
export const BOOKING_BREAKDOWN_TERMINAL_KEYS = ["returned", "lost", "damaged"] as const;

/** One key of the booking lifecycle breakdown. */
export type BookingBreakdownKeyType = typeof BOOKING_BREAKDOWN_KEYS[number];

/** Zod enum over the seven breakdown keys — the custody axis of a movement. */
export const BookingBreakdownKeyEnum: z.ZodType<BookingBreakdownKeyType> = z.enum(
  BOOKING_BREAKDOWN_KEYS,
);

// Compile-time guard: the key list and the breakdown shape cannot drift apart.
// Either direction failing is a type error, so adding a key to one without the
// other does not compile.
type _KeysCoverBreakdown = BookingBreakdownKeyType extends keyof BookingBreakdown ? true : never;
type _BreakdownCoversKeys = keyof BookingBreakdown extends BookingBreakdownKeyType ? true : never;
const _keyParity: [_KeysCoverBreakdown, _BreakdownCoversKeys] = [true, true];
void _keyParity;

/** A specific location within a store allocated for a booking. */
export interface BookingStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  default: boolean;
}

/** A store and its locations assigned to a booking. */
export interface BookingStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: BookingStoreLocation[];
}

/** Full Firestore document for a booking (a single product line within an order). */
export interface Booking {
  uid: string;
  uid_order: string;
  uid_product: string;
  name: string;
  number: number;
  type: ComponentTypeType;
  status: BookingStatusType;
  quantity: number;
  shortage: number;
  subject: string;
  unit_price: number;
  total_price: number;
  crms_id?: number | null;
  crms_product_id?: number | null;
  breakdown: BookingBreakdown;
  dates: {
    start: string | null;
    start_fs: FirestoreTimestampType | null;
    end: string | null;
    end_fs: FirestoreTimestampType | null;
    charge_start: string | null;
    charge_start_fs: FirestoreTimestampType | null;
    charge_end: string | null;
    charge_end_fs: FirestoreTimestampType | null;
  };
  destinations: {
    delivery: BookingDestinationRef | null;
    collection: BookingDestinationRef | null;
  };
  organization: {
    uid: string | null;
    name: string;
    crms_id: number | null;
  };
  stores: BookingStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  uid_destination_delivery: string;
  uid_destination_collection: string;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const BookingDestinationRefSchema: z.ZodType<BookingDestinationRef> = z.strictObject({
  uid: FirestoreId,
  address: Address,
});

const BookingStoreLocationSchema: z.ZodType<BookingStoreLocation> = z.strictObject({
  uid_location: FirestoreId,
  name: z.string(),
  quantity: z.number(),
  default: z.boolean(),
});

const BookingStoreSchema: z.ZodType<BookingStore> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string(),
  default: z.boolean(),
  quantity: z.number(),
  locations: z.array(BookingStoreLocationSchema).default([]),
});

// ── Update input ──────────────────────────────────────────────

/**
 * Input for updating a single booking via `PUT /bookings/{uid}`.
 *
 * Status and breakdown are independently optional — most warehouse PUTs only
 * change the breakdown. When `breakdown` is supplied it must be the complete
 * next state (all 7 keys); the service requires `sum(breakdown) === quantity`
 * and treats the value as an absolute write, not a partial patch. Version is
 * required for optimistic concurrency.
 */
export interface UpdateBookingInputType {
  status?: BookingStatusType;
  breakdown?: Booking["breakdown"];
  version: number;
}

/** Zod schema for UpdateBookingInput. */
export const UpdateBookingInput: z.ZodType<UpdateBookingInputType> = z.object({
  status: BookingStatus.optional(),
  breakdown: z.object({
    damaged: z.number().min(0),
    lost: z.number().min(0),
    out: z.number().min(0),
    prepped: z.number().min(0),
    quoted: z.number().min(0),
    reserved: z.number().min(0),
    returned: z.number().min(0),
  }).optional(),
  version: z.int().min(0),
});

// ── Bulk update input (PUT /fulfillments/{uid}/bookings) ───────

/**
 * Per-row entry for the bulk fulfillment-bookings endpoint. Matches
 * `UpdateBookingInputType` field-for-field, plus the booking `uid` to address
 * the row (since the URL carries the fulfillment uid, not the booking uid).
 */
export interface BookingUpdateType {
  uid: string;
  status?: BookingStatusType;
  breakdown?: Booking["breakdown"];
  version: number;
}

export const BookingUpdate: z.ZodType<BookingUpdateType> = z.object({
  uid: BookingId,
  status: BookingStatus.optional(),
  breakdown: BookingBreakdownSchema.optional(),
  version: z.int().min(0),
});

/**
 * Body of `PUT /fulfillments/{uid}/bookings` — applies N booking transitions
 * for one order in a single Firestore transaction.
 *
 * Top-level `version` is the fulfillment doc version at read time. Currently
 * advisory: a stale value 409s. Per-row `version` carries each booking's
 * current version for optimistic concurrency.
 *
 * No fixed cap on `updates.length`. Bound only by the real Firestore limits
 * (270s tx duration, 10 MiB request size). The bulk service rejects empty
 * arrays with 400.
 */
export interface BulkBookingUpdateInputType {
  version: number;
  updates: BookingUpdateType[];
}

export const BulkBookingUpdateInput: z.ZodType<BulkBookingUpdateInputType> = z.object({
  version: z.int().min(0),
  updates: z.array(BookingUpdate).min(1),
});

/**
 * Successful response from `PUT /fulfillments/{uid}/bookings`. Per-row
 * `results` carry the post-write booking versions in input order.
 */
export interface BulkBookingUpdateResponseType {
  success: true;
  order_completed: boolean;
  oos_records_written: number;
  results: Array<{ uid: string; version: number }>;
}

export const BulkBookingUpdateResponse: z.ZodType<BulkBookingUpdateResponseType> =
  z.object({
    success: z.literal(true),
    order_completed: z.boolean(),
    oos_records_written: z.int().min(0),
    results: z.array(z.object({
      uid: BookingId,
      version: z.int().min(0),
    })),
  });

/** Zod schema for Booking. */
export const BookingSchema: z.ZodType<Booking> = z.strictObject({
  uid: BookingId,
  uid_order: FirestoreId,
  uid_product: FirestoreId,
  name: z.string(),
  number: z.int().meta({ label: "#", linkTo: "fulfillmentDetail", serverSortVia: "number" }),
  type: ComponentTypeEnum,
  status: BookingStatus,
  quantity: z.number().meta({ serverSortVia: "quantity" }),
  shortage: z.number(),
  subject: z.string(),
  unit_price: z.number(),
  total_price: z.number(),
  // crms_id and crms_product_id are written back post-transaction by CRMS sync
  crms_id: z.number().nullable().optional(),
  crms_product_id: z.number().nullable().optional(),
  breakdown: BookingBreakdownSchema,
  dates: z.strictObject({
    start: chicagoInstant().meta({ serverSortVia: "dates.start_fs" }).nullable(),
    start_fs: FirestoreTimestamp.nullable(),
    end: chicagoInstant().meta({ serverSortVia: "dates.end_fs" }).nullable(),
    end_fs: FirestoreTimestamp.nullable(),
    charge_start: chicagoInstant().nullable(),
    charge_start_fs: FirestoreTimestamp.nullable(),
    charge_end: chicagoInstant().nullable(),
    charge_end_fs: FirestoreTimestamp.nullable(),
  }),
  destinations: z.strictObject({
    delivery: BookingDestinationRefSchema.nullable(),
    collection: BookingDestinationRefSchema.nullable(),
  }),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: z.string().meta({ pii: "mask" }),
    crms_id: z.number().nullable(),
  }),
  stores: z.array(BookingStoreSchema).default([]),
  query_by_uid_store: z.array(FirestoreId).default([]),
  query_by_uid_location: z.array(FirestoreId).default([]),
  uid_destination_delivery: FirestoreId,
  uid_destination_collection: FirestoreId,
  version: z.int().min(0).default(0),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Booking",
  collection: "bookings",
  displayDefaults: {
    columns: ["number", "status", "organization.name", "quantity", "dates.start", "dates.end"],
    filters: {},
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});
