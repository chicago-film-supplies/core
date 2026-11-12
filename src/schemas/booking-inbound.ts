/**
 * Inbound booking document schema — Firestore collection: `bookings-inbound`.
 *
 * A purchase line's units on the SUPPLIER ladder, the twin of an order line's
 * units on the customer ladder (`bookings`). Written by the purchase writers
 * through the inbound booking lever; read by the receipt projection
 * (`purchase-receipts`), the purchase status derivation and, from 7b, supply
 * (`api-cloudrun/.claude/plans/one-document-model.md` § *7a core spec*, C5).
 *
 * ## The two booking collections share declarations, not a schema
 *
 * Every field both grains mean identically is the SAME Zod instance, referenced
 * key by key from `BOOKING_CORE` (`schemas/booking.ts`) and pinned by
 * `tests/booking-core-parity.test.ts`. What differs is declared here:
 *
 * - `uid` — the same grammar (`{purchaseUid}:{productUid}:{legUid}[:{sig}]`); the
 *   COLLECTION is what tells an inbound id from an outbound one;
 * - `source` — the purchase, as a `DocSource` (`{ collection: "purchases", uid }`),
 *   which is what a movement's `sources[]` holds. Phase 9 gives outbound
 *   bookings the same field in place of `uid_order`;
 * - `number` — the PURCHASE's number;
 * - `type` — `sale | rental` only (`InboundBookingTypeEnum`);
 * - `status` — `ordered | active | complete` ({@link INBOUND_BOOKING_STATUSES});
 * - `breakdown` / `units` — the inbound ladder;
 * - `quantity_ordered` — REQUIRED: there is no legacy population to forgive.
 *
 * Deliberately absent: an organization or supplier snapshot (the receipt and the
 * purchase carry the supplier), `subject`, `shortage` (a purchase draws on no
 * shelf), and the CRMS ids.
 *
 * @module
 */
import { z } from "zod";
import { BookingId, FirestoreId } from "./_uid.ts";
import {
  type InboundBookingTypeType,
  InboundBookingTypeEnum,
  type InboundBreakdown,
  InboundBreakdownSchema,
  INBOUND_UNIT_BUCKETS,
  type InboundUnitSetsType,
  InboundUnitSetsSchema,
} from "./_inbound-breakdown.ts";
import { checkBookingCollection, checkBookingDelivery, checkBookingUnitsWithin } from "./_booking-refines.ts";
import { BOOKING_CORE, type Booking, type BookingStore } from "./booking.ts";
import type { FirestoreTimestampType } from "./common.ts";

/**
 * An inbound booking's status, DERIVED from its breakdown and never sent:
 * `ordered` while every unit is still plan, `complete` once every unit sits in
 * a terminal key for its type (`isInboundTerminal`), else `active`.
 *
 * ⚠️ **Not the outbound vocabulary.** `reserved` / `part-prepped` / `prepped`
 * name preparation stages a supplier's units never pass through, and `draft` /
 * `quoted` have no writer on this ladder (rulings 2, 56). The default the 7a
 * spec took (D6).
 */
export const INBOUND_BOOKING_STATUSES = ["ordered", "active", "complete"] as const;
/** One inbound booking status. */
export type InboundBookingStatusType = typeof INBOUND_BOOKING_STATUSES[number];
/** Zod enum over {@link INBOUND_BOOKING_STATUSES}. */
export const InboundBookingStatusEnum: z.ZodType<InboundBookingStatusType> = z.enum(INBOUND_BOOKING_STATUSES);

/**
 * The purchase an inbound booking books — a `DocSource` narrowed to its one
 * legal collection, so it is assignable wherever a `DocSourceType` is read
 * (a movement's `sources[]`, a thread's) without a cast.
 */
export interface InboundBookingSource {
  collection: "purchases";
  uid: string;
}

/** Zod schema for {@link InboundBookingSource}. */
export const InboundBookingSourceSchema: z.ZodType<InboundBookingSource> = z.strictObject({
  collection: z.literal("purchases"),
  uid: FirestoreId,
});

/**
 * Full Firestore document for an inbound booking — an AGGREGATE per
 * `(purchase, product, LEG, component_signature_hash)`, exactly as an outbound
 * booking aggregates per `(order, product, leg, signature)`. Not a line: two
 * purchase lines of one product on one leg with the same ancestry share a row.
 */
export interface InboundBooking {
  uid: string;
  /** The purchase this booking books. Its `uid` is the id's first segment. */
  source: InboundBookingSource;
  uid_product: string;
  /** As {@link Booking.component_signature_hash}: `null` is the 3-segment (top-level) id. */
  component_signature_hash: string | null;
  name: string;
  /** The PURCHASE's number. */
  number: number;
  type: InboundBookingTypeType;
  status: InboundBookingStatusType;
  /** The PHYSICAL number — `Σ breakdown`, as on the outbound grain. */
  quantity: number;
  /**
   * What the PURCHASE asked for at this grain — Σ line quantity. REQUIRED, unlike
   * the outbound field, because every inbound booking is written by a writer that
   * knows it. `0` on a KEPT booking (its line was closed to 0 with units in hand).
   */
  quantity_ordered: number;
  breakdown: InboundBreakdown;
  /** Named units per bucket on a serialized product; `null` when not unit-tracked. */
  units: InboundUnitSetsType | null;
  dates: Booking["dates"];
  destinations: Booking["destinations"];
  stores: BookingStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  /** The delivery ADDRESS (where the supplier delivers), flat. */
  uid_destination_delivery: string;
  /** The collection ADDRESS (where a Subrent goes back from); `null` on a Buy. */
  uid_destination_collection: string | null;
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** The id's first segment is the purchase the booking names in `source`. */
function checkInboundSource(doc: { uid: string; source: InboundBookingSource }, ctx: z.RefinementCtx): void {
  if (doc.uid.split(":")[0] !== doc.source.uid) {
    ctx.addIssue({
      code: "custom",
      path: ["source", "uid"],
      message: "source.uid must be the purchase the booking id names (its first segment)",
    });
  }
}

/** Zod schema for {@link InboundBooking}. Key order is its own column order. */
export const InboundBookingSchema: z.ZodType<InboundBooking> = z.strictObject({
  uid: BookingId,
  source: InboundBookingSourceSchema,
  uid_product: BOOKING_CORE.uid_product,
  component_signature_hash: BOOKING_CORE.component_signature_hash,
  name: BOOKING_CORE.name,
  // ⚠️ Links the PURCHASE detail page: a receipt shares its purchase's id, and
  // the manager has no receipt page until 6e-0c. Re-point to the receipt
  // detail when it exists.
  number: z.int().meta({ column: true, label: "#", linkTo: "purchaseDetail", serverSortVia: "number" }),
  type: InboundBookingTypeEnum.meta({ column: true, label: "Type" }),
  status: InboundBookingStatusEnum.meta({ column: true, label: "Status" }),
  quantity: BOOKING_CORE.quantity,
  // Not "Ordered": that heading is `breakdown.ordered`'s (display rule T9).
  quantity_ordered: z.int().min(0).meta({ column: true, label: "Quantity ordered" }),
  breakdown: InboundBreakdownSchema,
  units: InboundUnitSetsSchema.nullable(),
  dates: BOOKING_CORE.dates,
  destinations: BOOKING_CORE.destinations,
  stores: BOOKING_CORE.stores,
  query_by_uid_store: BOOKING_CORE.query_by_uid_store,
  query_by_uid_location: BOOKING_CORE.query_by_uid_location,
  uid_destination_delivery: BOOKING_CORE.uid_destination_delivery,
  uid_destination_collection: BOOKING_CORE.uid_destination_collection,
  version: BOOKING_CORE.version,
  created_at: BOOKING_CORE.created_at,
  updated_at: BOOKING_CORE.updated_at,
})
  .superRefine(checkInboundSource)
  .superRefine(checkBookingCollection)
  .superRefine(checkBookingDelivery)
  .superRefine(checkBookingUnitsWithin(INBOUND_UNIT_BUCKETS))
  .meta({
    title: "InboundBooking",
    collection: "bookings-inbound",
    displayDefaults: {
      columns: ["number", "status", "quantity", "dates.start", "dates.end"],
      filters: {},
      sort: { column: "number", direction: "desc" },
      groupBy: [
        { field: null, label: "None" },
        { field: "status", label: "Status", kind: "enum" },
      ],
    },
  });
