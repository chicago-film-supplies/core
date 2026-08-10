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
  damaged: z.int().meta({ column: true, label: "Damaged" }),
  lost: z.int().meta({ column: true, label: "Lost" }),
  out: z.int().meta({ column: true, label: "Out" }),
  prepped: z.int().meta({ column: true, label: "Prepped" }),
  quoted: z.int().meta({ column: true, label: "Quoted" }),
  reserved: z.int().meta({ column: true, label: "Reserved" }),
  returned: z.int().meta({ column: true, label: "Returned" }),
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
  /**
   * A **lossy** per-unit denorm of `total_price_cents`, in integer cents:
   * `unit_price_cents × quantity` does NOT in general equal
   * `total_price_cents`, by construction. The residual is discarded on purpose
   * because nothing ever multiplies it back — contrast
   * `getXeroUnitAmountFromCents`, whose residual is real money in someone
   * else's ledger and is absorbed through `DiscountRate`. Same arithmetic
   * shape, opposite contracts; neither may be swept into the other, and
   * `audit-booking-prices.ts` must not grow a `unit × qty === total`
   * assertion, which would be false by design.
   */
  unit_price_cents: number;
  total_price_cents: number;
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
  name: z.string().meta({ column: true }),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  default: z.boolean(),
});

const BookingStoreSchema: z.ZodType<BookingStore> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string().meta({ column: true }),
  default: z.boolean(),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  locations: z.array(BookingStoreLocationSchema).default([]).meta({ label: "Location" }),
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
 *
 * {@link UpdateBookingInputType.uid_session} is what makes this endpoint safe to
 * retry once a breakdown change also appends to the movement journal — see the
 * field's own note.
 */
export interface UpdateBookingInputType {
  status?: BookingStatusType;
  breakdown?: Booking["breakdown"];
  version: number;
  /**
   * The client-minted uuid identifying ONE operator action, required.
   *
   * A breakdown change now appends movement events, and appending is not
   * idempotent the way an absolute-set write was: a lost response plus the
   * manager's retry would say the operator returned the units twice. Every
   * movement's document id is `{uid_session}|{type}|{subject}`, so a retry
   * carrying the same session resolves to the same documents and collapses to
   * one event by construction.
   *
   * **Required, with no server-side fallback.** A server-minted session would be
   * fresh on every attempt, which is precisely the retry the id exists to
   * absorb — an optional field would therefore be silently wrong exactly when it
   * mattered. Mint it per operator action (not per request, and not per
   * keystroke) and reuse it across retries of that action.
   */
  uid_session: string;
}

/** Zod schema for UpdateBookingInput. */
export const UpdateBookingInput: z.ZodType<UpdateBookingInputType> = z.object({
  status: BookingStatus.optional(),
  breakdown: z.object({
    damaged: z.int().min(0),
    lost: z.int().min(0),
    out: z.int().min(0),
    prepped: z.int().min(0),
    quoted: z.int().min(0),
    reserved: z.int().min(0),
    returned: z.int().min(0),
  }).optional(),
  version: z.int().min(0),
  uid_session: z.uuid(),
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
  /**
   * ONE session for the whole request, not one per row.
   *
   * A bulk apply IS one operator action — "check out these five rows", or a
   * picker action cascading onto a kit's component bookings — so the rows share
   * a session. They cannot collide on it: a movement's id carries the subject,
   * and every row addresses a different booking. See
   * {@link UpdateBookingInputType.uid_session}.
   */
  uid_session: string;
}

export const BulkBookingUpdateInput: z.ZodType<BulkBookingUpdateInputType> = z.object({
  version: z.int().min(0),
  updates: z.array(BookingUpdate).min(1),
  uid_session: z.uuid(),
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
  name: z.string().meta({ column: true, label: "Product", linkTo: "productDetail" }),
  number: z.int().meta({ column: true, label: "#", linkTo: "fulfillmentDetail", serverSortVia: "number" }),
  type: ComponentTypeEnum.meta({ column: true, label: "Type" }),
  status: BookingStatus.meta({ column: true, label: "Status" }),
  quantity: z.int().meta({ serverSortVia: "quantity", column: true, label: "Quantity" }),
  shortage: z.int().meta({ column: true, label: "Shortage" }),
  subject: z.string().meta({ column: true, label: "Subject" }),
  unit_price_cents: z.int().meta({ column: true, label: "Unit Price" }),
  total_price_cents: z.int().meta({ column: true, label: "Total" }),
  // crms_id and crms_product_id are written back post-transaction by CRMS sync
  crms_id: z.int().nullable().optional(),
  crms_product_id: z.int().nullable().optional(),
  breakdown: BookingBreakdownSchema,
  dates: z.strictObject({
    start: chicagoInstant().meta({ serverSortVia: "dates.start_fs", column: true, label: "Start" }).nullable(),
    start_fs: FirestoreTimestamp.nullable(),
    end: chicagoInstant().meta({ serverSortVia: "dates.end_fs", column: true, label: "End" }).nullable(),
    end_fs: FirestoreTimestamp.nullable(),
    charge_start: chicagoInstant().nullable().meta({ column: true, label: "Charge Start" }),
    charge_start_fs: FirestoreTimestamp.nullable(),
    charge_end: chicagoInstant().nullable().meta({ column: true, label: "Charge End" }),
    charge_end_fs: FirestoreTimestamp.nullable(),
  }),
  destinations: z.strictObject({
    delivery: BookingDestinationRefSchema.nullable().meta({ label: "Delivery" }),
    collection: BookingDestinationRefSchema.nullable().meta({ label: "Collection" }),
  }),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: z.string().meta({ pii: "mask", column: true, linkTo: "organizationDetail" }),
    crms_id: z.int().nullable(),
  }).meta({ label: "Organization" }),
  stores: z.array(BookingStoreSchema).default([]).meta({ label: "Store" }),
  query_by_uid_store: z.array(FirestoreId).default([]),
  query_by_uid_location: z.array(FirestoreId).default([]),
  uid_destination_delivery: FirestoreId,
  uid_destination_collection: FirestoreId,
  version: z.int().min(0).default(0),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
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
