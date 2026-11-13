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
import { BookingId, FirestoreId, OutOfServiceId } from "./_uid.ts";
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
import { ItemUid } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  allocationUnitsIssue,
  MovementAllocationInput,
  type MovementAllocationInputType,
  MovementUnitInput,
  type MovementUnitInputType,
} from "./transaction.ts";
import { type InboundCustodyRuleId, InboundCustodyRuleIdEnum, inboundCustodyRule } from "./custody.ts";

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

// ── The inbound lever's wire (PUT /purchase-receipts/{uid}/bookings) ───────

/**
 * One step an operator takes on an inbound booking — the twin of
 * `BookingAction` (`schemas/custody.ts`) over the inbound rule table
 * (`INBOUND_CUSTODY_RULES`). One lever route takes these (ruling 75, owner
 * 2026-11-12): the receipt, return and reversal routes are retired onto it, and
 * a rewind is a `*_undo` rule row, never a movement reversal (C3).
 *
 * - `path_source_item` — the purchase ROW this step acts for (ruling 65). Two
 *   lines of one product on one leg share a booking, so the booking alone cannot
 *   say which line's price a receipt posts; the movement names the row, and its
 *   leg and product must be the booking id's (`checkMovementContract`).
 * - `allocations` — where the units land (`receive`: absent is the store's
 *   default staging location; `put_away`: absent is the product's default
 *   storage) or leave from (`send_back`: absent lets the writer pick, as a
 *   check-out does). The api refuses a location the step cannot use.
 * - `units` — on a serialized product, exactly `quantity`, ascending. Only a
 *   `receive` captures a serial; every other step names units by number.
 * - `uid_out_of_service` — names the record a `receive_damaged_undo` consumes,
 *   as `BookingAction.uid_out_of_service` names an outbound loss undo's
 *   (api-cloudrun#1218; ruling 80 keeps the two sides aligned). Optional: without
 *   it the undo consumes the row's received-damaged records newest first. Any
 *   other rule naming one is refused.
 *
 * ⚠️ **A settle is not an operator row — with ONE paired exception.** `settle_lost`
 * and every settle undo move only in the out-of-service record's
 * `return_to_supplier` commit (C4, the 0b lost-subrent trace), which reaches the
 * lever as an internal row; on this wire they are refused, as `reclassify_*` is on
 * the outbound one. `settle_damaged` is accepted here ONLY as the take-back of a
 * `same_trip` exchange line received in the same request (ruling 83): on a
 * serialized X it is how the operator names which units go back damaged, as the
 * outbound operator sends X's `mark_*` actions. This schema checks only that the
 * request receives something ({@link BulkInboundBookingUpdateInput}); the LEVER
 * does the real pairing, since only it can read `exchanged_for` and the
 * disposition, and refuses an unpaired one.
 */
export interface InboundBookingActionType {
  rule: InboundCustodyRuleId;
  quantity: number;
  path_source_item: string[];
  allocations?: MovementAllocationInputType[];
  units?: MovementUnitInputType[];
  uid_out_of_service?: string;
}

/** Zod schema for {@link InboundBookingActionType}. */
export const InboundBookingAction: z.ZodType<InboundBookingActionType> = z.object({
  rule: InboundCustodyRuleIdEnum,
  quantity: z.int().min(1),
  path_source_item: z.array(ItemUid).min(1),
  allocations: z.array(MovementAllocationInput).min(1).optional(),
  units: z.array(MovementUnitInput).optional(),
  uid_out_of_service: OutOfServiceId.optional(),
}).superRefine((a, ctx) => {
  if (a.uid_out_of_service !== undefined && a.rule !== "receive_damaged_undo") {
    ctx.addIssue({
      code: "custom",
      path: ["uid_out_of_service"],
      message: "only a receive_damaged_undo names the out-of-service record it consumes",
    });
  }
  if (inboundCustodyRule(a.rule).stage === "settle" && a.rule !== "settle_damaged") {
    ctx.addIssue({
      code: "custom",
      path: ["rule"],
      message: `"${a.rule}" settles a rented unit on its out-of-service record; make it there (return_to_supplier)`,
    });
  }
  if (a.allocations && a.quantity !== a.allocations.reduce((sum, l) => sum + l.quantity, 0)) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "quantity must equal the sum of per-location allocation quantities" });
  }
  if (a.units !== undefined) {
    if (a.units.length !== a.quantity) {
      ctx.addIssue({ code: "custom", path: ["units"], message: "an action that names units names exactly `quantity` of them" });
    }
    for (let i = 1; i < a.units.length; i++) {
      if (a.units[i].number <= a.units[i - 1].number) {
        ctx.addIssue({ code: "custom", path: ["units", i], message: "units must be ascending by number, each named once" });
        break;
      }
    }
    if (a.rule !== "receive") {
      a.units.forEach((u, i) => {
        if (u.serial_number !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["units", i, "serial_number"],
            message: "only a receive captures a serial; every other step names units by number",
          });
        }
      });
    }
  }
  const issue = allocationUnitsIssue(a.units?.map((u) => u.number), a.allocations);
  if (issue !== null) ctx.addIssue({ code: "custom", path: ["allocations"], message: issue });
});

/**
 * An ordered list of actions on ONE inbound booking. Each (rule, row) pair at
 * most once: a movement's id is `{session}|{type}|{subject}` under the ROW's
 * sub-session (ruling 65), so a repeat would write one movement twice. Make it
 * two saves, or one action with the summed quantity.
 */
export const InboundBookingActions: z.ZodType<InboundBookingActionType[]> = z.array(InboundBookingAction).min(1).superRefine(
  (actions, ctx) => {
    const seen = new Set<string>();
    actions.forEach((a, i) => {
      const slot = `${a.rule}|${a.path_source_item.join("/")}`;
      if (seen.has(slot)) {
        ctx.addIssue({ code: "custom", path: [i], message: `"${a.rule}" is named twice for one row; sum the quantity or make two saves` });
      }
      seen.add(slot);
    });
  },
);

/** One inbound booking's actions in a lever request — the twin of `BookingUpdate`. */
export interface InboundBookingUpdateType {
  uid: string;
  /** The booking's version at read time; a stale one is a 409. */
  version: number;
  actions: InboundBookingActionType[];
}

/** Zod schema for {@link InboundBookingUpdateType}. */
export const InboundBookingUpdate: z.ZodType<InboundBookingUpdateType> = z.object({
  uid: BookingId,
  version: z.int().min(0),
  actions: InboundBookingActions,
});

/**
 * Body of `PUT /purchase-receipts/{uid}/bookings` — the inbound lever, the twin
 * of `BulkBookingUpdateInput` (`PUT /fulfillments/{uid}/bookings`).
 *
 * - `version` — the receipt document's version at read time.
 * - `uuid_session` — ONE session for the operator action, reused across retries
 *   (see `UpdateBookingInputType.uuid_session`); each row's movements take the
 *   row's sub-session under it.
 * - `date` — the physical instant the steps happened; absent is now. The same
 *   field as the outbound lever's (ruling 76), with the same api bounds: never
 *   later than now, never a date that replays a bucket negative, never inside
 *   Xero's live lock date for a step that posts (`UpdateBookingInputType.date`).
 * - `reference` — the supplier's delivery note, stamped on every movement.
 */
export interface BulkInboundBookingUpdateInputType {
  version: number;
  updates: InboundBookingUpdateType[];
  uuid_session: string;
  date?: string;
  reference?: string;
}

/** Zod schema for {@link BulkInboundBookingUpdateInputType}. */
export const BulkInboundBookingUpdateInput: z.ZodType<BulkInboundBookingUpdateInputType> = z.object({
  version: z.int().min(0),
  updates: z.array(InboundBookingUpdate).min(1),
  uuid_session: z.uuid(),
  date: chicagoInstant().optional(),
  reference: z.string().max(200).optional(),
}).superRefine((b, ctx) => {
  const seen = new Set<string>();
  b.updates.forEach((u, i) => {
    if (seen.has(u.uid)) ctx.addIssue({ code: "custom", path: ["updates", i, "uid"], message: "a booking is addressed once per request" });
    seen.add(u.uid);
  });
  // A wire `settle_damaged` is an exchange take-back (ruling 83): it travels with
  // the exchange line's receive. The lever checks the pairing itself.
  const receives = b.updates.some((u) => u.actions.some((a) => a.rule === "receive"));
  b.updates.forEach((u, i) => {
    u.actions.forEach((a, j) => {
      if (a.rule === "settle_damaged" && !receives) {
        ctx.addIssue({
          code: "custom",
          path: ["updates", i, "actions", j, "rule"],
          message: "settle_damaged is accepted only as the take-back of a same_trip exchange line received in the same " +
            "request; settle a record's units on the record (return_to_supplier)",
        });
      }
    });
  });
});
