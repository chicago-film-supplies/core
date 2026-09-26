/**
 * OutOfService document schema — Firestore collection: out-of-service
 *
 * An OOS record tracks a quantity of inventory taken out of service for one
 * reason (cleaning, damaged, maintenance, lost).
 *
 * ## A STATE on a shelf, or a PLACE at the record (owner, 2026-09-25)
 *
 * A `lost` unit is on no shelf anywhere; a `damaged`, `cleaning` or
 * `maintenance` unit HAS a location — usually in the building, sometimes at a
 * vendor. So the record's `breakdown` says WHERE its units are, the way a
 * booking's breakdown does:
 *
 * | bucket                | the units are                              | put there by                  |
 * |-----------------------|--------------------------------------------|-------------------------------|
 * | `flagged`             | on a CFS shelf, flagged                    | a `flag` movement             |
 * | `away`                | at the record: lost, or at `destination`   | `send_away` / `mark_lost`     |
 * | `written_off`         | gone                                       | `write_off`                   |
 * | `returned_to_service` | back in service                            | `return_to_service`, a clear  |
 *
 * ⭐ **The booking analogy.** A unit at a customer is `out` and stands AT THE
 * BOOKING, which names its destination; a unit at a vendor is `away` and stands
 * AT THIS RECORD, which names its `destination`. Coming back is
 * `return_to_service`, as coming back from a customer is `check_in`.
 *
 * `draft/planned/active/blocked` used to be buckets here. They are CARD
 * statuses — a card is an event or a task — and they said nothing about where a
 * unit was, which is the one question the ledger needs answered. The task of
 * repairing or cleaning goes to cards (deferred); the record keeps placement.
 *
 * **Σ buckets ≤ `quantity`, not `===`.** A record with a future start holds
 * units in NO bucket: they are still in service on their shelf, and its window
 * is reserved on `stock/{P}` through the record itself. The shortfall is "not
 * yet in effect".
 *
 * The HISTORY of a record is the movement journal — every movement naming it
 * in `sources[]` — not a field on it. The embedded `transactions[]` it carried
 * (a CRMS-era log that only ever held `open`) is gone.
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
import { FirestoreId, OutOfServiceId, ThreadId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OOS_FLAG_REASONS,
  type OOSFlagReasonType,
  OOSReasonEnum,
  type OOSReasonType,
  OrderDerivedOrgPath,
  type OrgPathNodeType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import { type BookingDestinationRef, BookingDestinationRefSchema } from "./booking.ts";
import { MovementAllocationInput, type MovementAllocationInputType } from "./transaction.ts";

// ── Status ───────────────────────────────────────────────────────

/**
 * Derived, never client-set, by `deriveOOSStatus` (`@cfs/core/utils/out-of-service`):
 * `canceled` once `canceled_at` is set, `complete` once every unit is written
 * off or back in service, `active` otherwise.
 *
 * `active` rather than `open`: orders, bookings, cards and recurrences all say
 * `active` for "in progress".
 */
export const OOS_STATUSES = ["active", "complete", "canceled"] as const;
/** Allowed out-of-service statuses. See {@link OOS_STATUSES}. */
export type OOSStatusType = typeof OOS_STATUSES[number];
/** Zod schema for OOSStatusType. */
export const OOSStatusEnum: z.ZodType<OOSStatusType> = z.enum(OOS_STATUSES);

/** The only status a client may ask for; the writer translates it into `canceled_at`. */
export const OOS_USER_STATUSES = ["canceled"] as const;

// ── Breakdown ───────────────────────────────────────────────────────

/** Where a record's units are — see the module docblock's table. */
export const OOS_BREAKDOWN_KEYS = ["flagged", "away", "written_off", "returned_to_service"] as const;
/** One out-of-service breakdown bucket. */
export type OOSBreakdownKeyType = typeof OOS_BREAKDOWN_KEYS[number];

/** Operator-facing labels, one per {@link OOS_BREAKDOWN_KEYS} member. */
export const OOS_BREAKDOWN_LABELS: Readonly<Record<OOSBreakdownKeyType, string>> = {
  flagged: "Flagged",
  away: "Away",
  written_off: "Written Off",
  returned_to_service: "Returned To Service",
};

/** Per-bucket quantities. Σ ≤ `quantity` — the shortfall is "not yet in effect". */
export interface OOSBreakdown {
  flagged: number;
  away: number;
  written_off: number;
  returned_to_service: number;
}

/** Zod schema for OOSBreakdown. */
export const OOSBreakdownSchema: z.ZodType<OOSBreakdown> = z.strictObject({
  flagged: z.int().min(0).meta({ column: true, label: "Flagged" }),
  away: z.int().min(0).meta({ column: true, label: "Away" }),
  written_off: z.int().min(0).meta({ column: true, label: "Written Off" }),
  returned_to_service: z.int().min(0).meta({ column: true, label: "Returned To Service" }),
});

/** A location within a store affected by an out-of-service record. */
export interface OOSStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  transactionQuantity: number;
  default: boolean;
  max?: number | null;
}

/** A store affected by an out-of-service record. */
export interface OOSStore {
  uid_store: string;
  name: string;
  default: boolean;
  quantity: number;
  locations: OOSStoreLocation[];
}

/**
 * Date object — booking-style start/end with paired Firestore timestamps.
 *
 * `start` is the instant the units went out of service — or, for a record not
 * yet in effect, will. `end` is when they are due back (a vendor trip) or came
 * back.
 */
export interface OOSDates {
  start: string | null;
  start_fs: FirestoreTimestampType | null;
  end: string | null;
  end_fs: FirestoreTimestampType | null;
}

/** An out-of-service record tracking inventory removed from active service. */
export interface OutOfService {
  uid: string;
  uid_product: string;
  number: number;
  reason: OOSReasonType;
  status: OOSStatusType;
  quantity: number;
  breakdown: OOSBreakdown;
  canceled_at: FirestoreTimestampType | null;
  organization: {
    uid: string | null;
    path: OrgPathNodeType[];
    crms_id: number | null;
  } | null;
  dates: OOSDates;
  /**
   * Where the `away` units are — a vendor's address — or `null` (a lost unit
   * is nowhere; flagged units are on a shelf). The booking analogy: a booking
   * names where its `out` units went, and this names where its `away` ones did.
   * Same shape as a booking's delivery/collection ref.
   */
  destination: BookingDestinationRef | null;
  /** Flat query key for {@link destination}: `destination?.uid ?? null`. */
  uid_destination: string | null;
  /**
   * Who does the work — the Xero contact a repair or cleaning bill goes to.
   * Not always the `destination`'s occupant. A point-in-time `{uid, name}`
   * snapshot, like `Movement.supplier`.
   */
  supplier: UidNameRefType | null;
  sources: DocSourceType[];
  query_by_sources: string[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
  stores: OOSStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const OOSStoreLocationSchema: z.ZodType<OOSStoreLocation> = z.strictObject({
  uid_location: FirestoreId,
  name: z.string().meta({ column: true }),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  transactionQuantity: z.int(),
  default: z.boolean(),
  max: z.int().nullable().optional(),
});

// core#95 batch 12 REFUSED this default on the theory that
// `api-cloudrun/src/services/bookings.ts` names a real staged-input case ("the
// warehouse can fill these in via PUT once the actual location is known"). Batch
// 16 re-checked: `api-cloudrun/src/services/bookings.ts` creates an OOS record with a bare `stores: []` —
// no per-store `OOSStore` object ever constructed there, staged or otherwise —
// and neither `api-cloudrun/src/services/outOfService.ts` (`data.stores ?? []`,
// pass-through) nor any manager component builds one either
// (`manager/src/components/outOfService/OOSStores.tsx` only reads `.locations`;
// no add-store UI exists). `OOSStore.locations` was already required on the
// INTERFACE for both inputs (they type `stores?: OOSStore[]`, not a separate
// lenient shape), so the staged-input case this default was protecting has no
// call site anywhere in either repo. Removed rather than split.
const OOSStoreSchema: z.ZodType<OOSStore> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string().meta({ column: true }),
  default: z.boolean(),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  locations: z.array(OOSStoreLocationSchema).meta({ label: "Location" }),
});

const OOSDatesSchema: z.ZodType<OOSDates> = z.strictObject({
  start: chicagoInstant().meta({ serverSortVia: "dates.start_fs", column: true, label: "Start" }).nullable(),
  start_fs: FirestoreTimestamp.nullable(),
  end: chicagoInstant().meta({ serverSortVia: "dates.end_fs", column: true, label: "End" }).nullable(),
  end_fs: FirestoreTimestamp.nullable(),
});

/** Zod schema for OutOfService. */
export const OutOfServiceSchema: z.ZodType<OutOfService> = z.strictObject({
  uid: OutOfServiceId,
  uid_product: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "outOfServiceDetail", serverSortVia: "number" }),
  reason: OOSReasonEnum.meta({ column: true, label: "Reason" }),
  status: OOSStatusEnum.meta({ column: true, label: "Status" }),
  quantity: z.int().meta({ serverSortVia: "quantity", column: true, label: "Quantity" }),
  breakdown: OOSBreakdownSchema,
  canceled_at: FirestoreTimestamp.nullable().meta({ column: true, label: "Canceled" }),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    path: OrderDerivedOrgPath,
    crms_id: z.int().nullable(),
  }).nullable().meta({ label: "Organization" }),
  dates: OOSDatesSchema,
  destination: BookingDestinationRefSchema.nullable().meta({ label: "Destination" }),
  uid_destination: FirestoreId.nullable(),
  // ⚠️ The `label` is REQUIRED: `UidNameRef.name` is a labelless column, so the
  // key holding it must name it (`display-columns.test.ts` T9).
  supplier: UidNameRef.nullable().meta({ label: "Supplier" }),
  // Bare `z.array(DocSource)` — the dropped `.default([])` is core#95 batch
  // 10. 2/2 prod, 4/4 dev already carry the key (`createOutOfServiceRecord`
  // writes a literal `sources: [...]`).
  sources: z.array(DocSource).meta({ label: "Source" }),
  query_by_sources: z.array(z.string()),
  crms_id: z.int().nullable().optional(),
  crms_stock_level_id: z.int().nullable().optional(),
  stores: z.array(OOSStoreSchema).meta({ label: "Store" }),
  query_by_uid_store: z.array(FirestoreId),
  query_by_uid_location: z.array(FirestoreId),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine((doc, ctx) => {
  const placed = OOS_BREAKDOWN_KEYS.reduce((sum, k) => sum + doc.breakdown[k], 0);
  if (placed > doc.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["breakdown"],
      message: `breakdown places ${placed} units but the record holds ${doc.quantity}`,
    });
  }
  if (doc.uid_destination !== (doc.destination?.uid ?? null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_destination"],
      message: "uid_destination must mirror destination.uid",
    });
  }
}).meta({
  title: "Out of Service Record",
  collection: "out-of-service",
  displayDefaults: {
    columns: ["number", "reason", "organization.path", "quantity", "dates.start", "dates.end"],
    filters: {},
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────────

/** Input for creating an out-of-service record. */
export interface CreateOutOfServiceInputType {
  uid_product: string;
  reason: OOSReasonType;
  quantity: number;
  dates: { start?: string | null; end?: string | null };
  sources?: DocSourceType[];
  /**
   * One per operator action, client-minted OUTSIDE any retry loop. The record
   * takes its id from its first movement (`{uuid_session}|{type}|{subject}`),
   * so a retried create lands on the same id instead of opening a second
   * record — the idempotency a booking update already has.
   */
  uuid_session: string;
  /**
   * Which shelves the units are on (a flag) or leave from (a loss, a send-out).
   * Absent means the server allocates. Replaces `stores`: the record's
   * `stores[]` is derived from its movements.
   */
  allocations?: MovementAllocationInputType[];
  /** The uid only — the server resolves the snapshot, as for a movement's supplier. */
  destination?: { uid: string } | null;
  /** The uid only — the server resolves the name. */
  supplier?: { uid: string } | null;
}

/** Zod schema for CreateOutOfServiceInput. */
export const CreateOutOfServiceInput: z.ZodType<CreateOutOfServiceInputType> = z.object({
  uid_product: FirestoreId,
  reason: OOSReasonEnum,
  quantity: z.number().int().positive(),
  dates: z.object({
    start: chicagoInstant().nullable().optional(),
    end: chicagoInstant().nullable().optional(),
  }),
  sources: z.array(DocSource).optional(),
  uuid_session: z.uuid(),
  allocations: z.array(MovementAllocationInput).min(1).optional(),
  destination: z.object({ uid: FirestoreId }).nullable().optional(),
  supplier: z.object({ uid: FirestoreId }).nullable().optional(),
}).refine(
  (t) => !t.allocations || t.quantity === t.allocations.reduce((sum, a) => sum + a.quantity, 0),
  { message: "quantity must equal the sum of per-location allocation quantities", path: ["quantity"] },
) as z.ZodType<CreateOutOfServiceInputType>;

/**
 * Input for updating an out-of-service record.
 *
 * `breakdown` (when supplied) is the complete next state, Σ ≤ `quantity`. The
 * writer turns each bucket change into the movement that makes it true —
 * `flag`, `send_away`, `return_to_service`, `write_off`, or a reversal of one.
 * `status` is server-derived; only `"canceled"` is honored.
 *
 * `reason` edits the record IN PLACE, and only among the flag reasons: a
 * `lost` ↔ other change is a change of PLACE, not of reason (R3). The writer
 * records it as a `flag` `{r → r′}`, so the journal keeps the history.
 *
 * `dates.start` is honored only on a record with no sources (ad-hoc); a
 * source-bound record's start reflects the upstream event that pinned it.
 */
export interface UpdateOutOfServiceInputType {
  status?: typeof OOS_USER_STATUSES[number];
  reason?: OOSFlagReasonType;
  breakdown?: OOSBreakdown;
  dates?: { start?: string | null; end?: string | null };
  destination?: { uid: string } | null;
  supplier?: { uid: string } | null;
  /** Client-minted per operator action; names the movements this save writes. */
  uuid_session: string;
  version: number;
}

/** Zod schema for UpdateOutOfServiceInput. */
export const UpdateOutOfServiceInput: z.ZodType<UpdateOutOfServiceInputType> = z.object({
  status: z.enum(OOS_USER_STATUSES).optional(),
  reason: z.enum(OOS_FLAG_REASONS).optional(),
  breakdown: OOSBreakdownSchema.optional(),
  dates: z.object({
    start: chicagoInstant().nullable().optional(),
    end: chicagoInstant().nullable().optional(),
  }).optional(),
  destination: z.object({ uid: FirestoreId }).nullable().optional(),
  supplier: z.object({ uid: FirestoreId }).nullable().optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});
