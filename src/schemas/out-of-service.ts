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
 * | `returned_to_supplier`| settled to the supplier's account (subrent)| `return_to_supplier`          |
 *
 * `returned_to_supplier` is a RENTED unit that cannot go back — lost at the
 * customer, or damaged — settled to the supplier's account rather than
 * physically returned (api-cloudrun#1360). ⚠️ The record's `supplier` field is
 * the REPAIR vendor, not this; the subrent is named only in the settling
 * movement's `sources[]`.
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
  Address,
  type AddressType,
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
  OrgSnapshotCore,
  type OrgPathNodeType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import { type BookingDestinationRef, BookingDestinationRefSchema } from "./booking.ts";
import { allocationUnitsIssue, MovementAllocationInput, type MovementAllocationInputType } from "./transaction.ts";
import { UnitSet } from "./unit.ts";

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
export const OOS_BREAKDOWN_KEYS = ["flagged", "away", "written_off", "returned_to_service", "returned_to_supplier"] as const;
/** One out-of-service breakdown bucket. */
export type OOSBreakdownKeyType = typeof OOS_BREAKDOWN_KEYS[number];

/**
 * The RESOLVED buckets: a unit in one of them is no longer out of service at
 * this record — gone, back in service, or settled to its supplier. A record
 * whose every unit is resolved is `complete` (`deriveOOSStatus`), and an open
 * record consumes stock only for its unresolved units (`oosConsumes`).
 *
 * 🔴 **Sum resolved units through this list, never by naming keys.** A sum
 * spelled `written_off + returned_to_service` compiled straight through the
 * arrival of `returned_to_supplier` and would have left a settled record
 * `active` and consuming stock forever.
 */
export const OOS_BREAKDOWN_TERMINAL_KEYS = ["written_off", "returned_to_service", "returned_to_supplier"] as const;
/** One {@link OOS_BREAKDOWN_TERMINAL_KEYS} member. */
export type OOSBreakdownTerminalKeyType = typeof OOS_BREAKDOWN_TERMINAL_KEYS[number];

/** Operator-facing labels, one per {@link OOS_BREAKDOWN_KEYS} member. */
export const OOS_BREAKDOWN_LABELS: Readonly<Record<OOSBreakdownKeyType, string>> = {
  flagged: "Flagged",
  away: "Away",
  written_off: "Written Off",
  returned_to_service: "Returned To Service",
  returned_to_supplier: "Returned To Supplier",
};

/**
 * Per-bucket quantities. Σ ≤ `quantity` — the shortfall is "not yet in effect".
 *
 * `returned_to_supplier` is REQUIRED: every stored record states it (the api's
 * writers state it, a backfill zero-filled the rest — prod, dev and `test`, read
 * 0 missing on 2026-10-26). The update INPUT still accepts it absent
 * ({@link OOSBreakdownInputType}): a client built before the bucket sends four
 * keys, and that is no change, not an un-settle.
 */
export interface OOSBreakdown {
  flagged: number;
  away: number;
  written_off: number;
  returned_to_service: number;
  /** Settled to the supplier's account (subrent). */
  returned_to_supplier: number;
}

/** Zod schema for OOSBreakdown. */
export const OOSBreakdownSchema: z.ZodType<OOSBreakdown> = z.strictObject({
  flagged: z.int().min(0).meta({ column: true, label: "Flagged" }),
  away: z.int().min(0).meta({ column: true, label: "Away" }),
  written_off: z.int().min(0).meta({ column: true, label: "Written Off" }),
  returned_to_service: z.int().min(0).meta({ column: true, label: "Returned To Service" }),
  returned_to_supplier: z.int().min(0).meta({ column: true, label: "Returned To Supplier" }),
});

/**
 * The breakdown a client SENDS: {@link OOSBreakdown} with `returned_to_supplier`
 * optional. Storage is tightened, not the input (a client built before the
 * bucket is not rebuilt in step), so an absent key reads as 0 here, through
 * {@link oosBucketQuantity}.
 */
export interface OOSBreakdownInputType {
  flagged: number;
  away: number;
  written_off: number;
  returned_to_service: number;
  /** Optional on input: a pre-bucket client sends four keys. */
  returned_to_supplier?: number;
}

/** Zod schema for {@link OOSBreakdownInputType}. */
export const OOSBreakdownInput: z.ZodType<OOSBreakdownInputType> = z.object({
  flagged: z.int().min(0),
  away: z.int().min(0),
  written_off: z.int().min(0),
  returned_to_service: z.int().min(0),
  // Optional on INPUT only — see the interface. Storage requires it.
  returned_to_supplier: z.int().min(0).optional(),
});

/**
 * One bucket of a breakdown, reading an ABSENT key as 0 — the way a
 * reader touches a bucket of an INPUT, where `returned_to_supplier` may be absent. An absent
 * key read raw is `undefined`, and `undefined` in a sum is `NaN`, which a `>`
 * comparison then reads as false: the guards that refuse over-placement go
 * silent rather than loud.
 */
export function oosBucketQuantity(b: Partial<OOSBreakdown>, key: OOSBreakdownKeyType): number {
  return b[key] ?? 0;
}

/** Σ of `keys` (every bucket by default), each read through {@link oosBucketQuantity}. */
export function sumOOSBuckets(
  b: Partial<OOSBreakdown>,
  keys: readonly OOSBreakdownKeyType[] = OOS_BREAKDOWN_KEYS,
): number {
  let total = 0;
  for (const key of keys) total += oosBucketQuantity(b, key);
  return total;
}

/** Every bucket stated, an absent one as 0 — for a caller that needs the full shape. */
export function fullOOSBreakdown(b: Partial<OOSBreakdown>): Required<OOSBreakdown> {
  const full = {} as Required<OOSBreakdown>;
  for (const key of OOS_BREAKDOWN_KEYS) full[key] = oosBucketQuantity(b, key);
  return full;
}

/**
 * Which units sit in each bucket of a record, on a serialized product
 * (`api-cloudrun/.claude/plans/serial-tracking.md` D6). Each set is a
 * canonical `UnitSet`, and the sets are pairwise disjoint.
 *
 * `units[k].length ≤ breakdown[k]`, not `===`: a historic record (24 walkie
 * losses on Replacement lines among them) names no unit at all, and writes off
 * without vacating anything.
 */
export interface OOSUnitsType {
  away: number[];
  flagged: number[];
  returned_to_service: number[];
  written_off: number[];
  /** Required in storage, as {@link OOSBreakdown.returned_to_supplier}. */
  returned_to_supplier: number[];
}

/** Every bucket's set must be disjoint from the others: a unit is in one bucket at a time. */
function unitsDisjoint(sets: Partial<OOSUnitsType>, ctx: z.RefinementCtx): void {
  const seen = new Map<number, OOSBreakdownKeyType>();
  for (const key of OOS_BREAKDOWN_KEYS) {
    for (const n of oosBucketUnits(sets, key)) {
      const other = seen.get(n);
      if (other !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `unit ${n} is in both "${other}" and "${key}"; a unit is in one bucket at a time`,
        });
      }
      seen.set(n, key);
    }
  }
}

/** Zod schema for {@link OOSUnitsType}. */
export const OOSUnitsSchema: z.ZodType<OOSUnitsType> = z.strictObject({
  away: UnitSet,
  flagged: UnitSet,
  returned_to_service: UnitSet,
  written_off: UnitSet,
  returned_to_supplier: UnitSet,
}).superRefine(unitsDisjoint);

/** The unit sets a client SENDS: {@link OOSUnitsType} with `returned_to_supplier` optional. */
export interface OOSUnitsInputType {
  away: number[];
  flagged: number[];
  returned_to_service: number[];
  written_off: number[];
  /** Optional on input, as {@link OOSBreakdownInputType.returned_to_supplier}. */
  returned_to_supplier?: number[];
}

/** Zod schema for {@link OOSUnitsInputType}. */
export const OOSUnitsInput: z.ZodType<OOSUnitsInputType> = z.object({
  away: UnitSet,
  flagged: UnitSet,
  returned_to_service: UnitSet,
  written_off: UnitSet,
  returned_to_supplier: UnitSet.optional(),
}).superRefine(unitsDisjoint);

/** One bucket's unit set, reading an ABSENT set as `[]` — {@link oosBucketQuantity}'s twin. */
export function oosBucketUnits(units: Partial<OOSUnitsType>, key: OOSBreakdownKeyType): number[] {
  return units[key] ?? [];
}

function unitsOverBreakdown(
  units: OOSUnitsInputType,
  breakdown: OOSBreakdownInputType,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  for (const key of OOS_BREAKDOWN_KEYS) {
    const named = oosBucketUnits(units, key).length;
    const held = oosBucketQuantity(breakdown, key);
    if (named > held) {
      ctx.addIssue({
        code: "custom",
        path: [...path, key],
        message: `"${key}" names ${named} units but holds ${held}`,
      });
    }
  }
}

/** A location within a store affected by an out-of-service record. */
export interface OOSStoreLocation {
  uid_location: string;
  name: string;
  quantity: number;
  transactionQuantity: number;
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

/**
 * A product named by `{uid, name}`. The `name` links to the PRODUCT's page,
 * not the row's: `TableCell` resolves `linkTo` through the uid of the object
 * the value sits in, which is why the name is nested here and not at the root.
 */
export interface ProductRefType {
  uid: string;
  name: string;
}

/** Zod schema for {@link ProductRefType}. Labelless — the key holding it names the column. */
export const ProductRef: z.ZodType<ProductRefType> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).meta({ pii: "none", column: true, linkTo: "productDetail" }),
});

/** An out-of-service record tracking inventory removed from active service. */
export interface OutOfService {
  uid: string;
  uid_product: string;
  /**
   * The product, with its name. `uid_product` is its flat query mirror. The
   * name is live while the record is `active` (a rename cascades to it) and
   * frozen once the record is terminal.
   */
  product: ProductRefType;
  number: number;
  reason: OOSReasonType;
  status: OOSStatusType;
  quantity: number;
  breakdown: OOSBreakdown;
  /**
   * Which units sit in each bucket — `null` when the record names no unit (a
   * bulk product, or a serialized one before its roster was seeded). See
   * {@link OOSUnitsType}.
   *
   * 🔴 **REQUIRED-nullable, never optional**, for the reason and by the four
   * steps `Booking.units` records (serial-tracking D2/D6). Census 2026-10-04
   * after the backfill: 325/325 prod and 382/382 dev records carry the key.
   */
  units: OOSUnitsType | null;
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
  // Optional until the backfill — see the interface field's own note.
  product: ProductRef.meta({ label: "Product" }),
  number: z.int().meta({ column: true, label: "#", linkTo: "outOfServiceDetail", serverSortVia: "number" }),
  reason: OOSReasonEnum.meta({ column: true, label: "Reason" }),
  status: OOSStatusEnum.meta({ column: true, label: "Status" }),
  quantity: z.int().meta({ serverSortVia: "quantity", column: true, label: "Quantity" }),
  breakdown: OOSBreakdownSchema,
  // Required-nullable — see the interface field's own note. `null` names no unit.
  units: OOSUnitsSchema.nullable(),
  canceled_at: FirestoreTimestamp.nullable().meta({ column: true, label: "Canceled" }),
  organization: z.strictObject({
    ...OrgSnapshotCore,
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
  const placed = sumOOSBuckets(doc.breakdown);
  if (placed > doc.quantity) {
    ctx.addIssue({
      code: "custom",
      path: ["breakdown"],
      message: `breakdown places ${placed} units but the record holds ${doc.quantity}`,
    });
  }
  if (doc.units != null) unitsOverBreakdown(doc.units, doc.breakdown, ctx, ["units"]);
  if (doc.uid_destination !== (doc.destination?.uid ?? null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_destination"],
      message: "uid_destination must mirror destination.uid",
    });
  }
  if (doc.product.uid !== doc.uid_product) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_product"],
      message: "uid_product must mirror product.uid",
    });
  }
}).meta({
  title: "Out of Service Record",
  collection: "out-of-service",
  displayDefaults: {
    columns: ["number", "product.name", "reason", "organization.path", "quantity", "dates.start", "dates.end"],
    filters: {},
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────────

/**
 * Where an `away` unit went, as an operator names it: an existing
 * `destinations` document, or an address the server resolves to one.
 *
 * An address goes through the SAME dedupe as an order leg's endpoint
 * (api-cloudrun `findOrCreateDestination`: mapbox id → coordinates → exact
 * text), into the ONE `destinations` pool. A destination is an address and
 * stores no role — the role lives on the reference (an order pair says
 * "deliver here", the record's `supplier` says who is paid) — so a vendor's
 * workshop and a customer's stage at one address are one document. Owner
 * ruling, 2026-09-27.
 *
 * A DISCRIMINATED union — `{ kind: "uid", uid }` or `{ kind: "address",
 * address }` — with no optional keys. The discriminator is what lets the PII
 * walker (`pii/walker.ts`) pick the address arm and mask it; a plain
 * `z.union` of `{uid}` / `{address}` has nothing to dispatch on, so the walker
 * skips it and the address ships raw (`tests/pii.test.ts` caught exactly
 * that). The address arm refuses `null`, which `Address` alone admits.
 */
export type OOSDestinationInputType =
  | { kind: "uid"; uid: string }
  | { kind: "address"; address: AddressType };

/** Zod schema for {@link OOSDestinationInputType}. */
export const OOSDestinationInput: z.ZodType<OOSDestinationInputType> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("uid"), uid: FirestoreId }),
  z.strictObject({ kind: z.literal("address"), address: Address }).refine(
    (d): d is { kind: "address"; address: AddressType } => d.address !== null,
    { message: "address is required", path: ["address"] },
  ),
]);

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
  /** An existing destination or a new address — see {@link OOSDestinationInput}. */
  destination?: OOSDestinationInputType | null;
  /** The uid only — the server resolves the name. */
  supplier?: { uid: string } | null;
  /**
   * Which units the record takes, on a serialized product: a canonical
   * `UnitSet` of at most `quantity` numbers. A manual record picks from
   * unflagged shelf units (serial-tracking D6). When allocations name units
   * too, they partition this list.
   */
  units?: number[];
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
  destination: OOSDestinationInput.nullable().optional(),
  supplier: z.object({ uid: FirestoreId }).nullable().optional(),
  units: UnitSet.optional(),
}).refine(
  (t) => !t.allocations || t.quantity === t.allocations.reduce((sum, a) => sum + a.quantity, 0),
  { message: "quantity must equal the sum of per-location allocation quantities", path: ["quantity"] },
).superRefine((t, ctx) => {
  if (t.units !== undefined && t.units.length > t.quantity) {
    ctx.addIssue({ code: "custom", path: ["units"], message: `names ${t.units.length} units but the record holds ${t.quantity}` });
  }
  const issue = allocationUnitsIssue(t.units, t.allocations);
  if (issue !== null) ctx.addIssue({ code: "custom", path: ["allocations"], message: issue });
}) as z.ZodType<CreateOutOfServiceInputType>;

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
  breakdown?: OOSBreakdownInputType;
  /**
   * The complete next unit sets, beside the complete next `breakdown` it
   * names units for (and only with it). The writer moves exactly the units
   * whose bucket changed; a set is a fact, so the diff guesses nothing.
   */
  units?: OOSUnitsInputType;
  dates?: { start?: string | null; end?: string | null };
  destination?: OOSDestinationInputType | null;
  supplier?: { uid: string } | null;
  /**
   * INPUT-ONLY, never stored: the subrent purchase a `returned_to_supplier`
   * increase is settled against (api-cloudrun#1360). Required by the writer
   * when that bucket rises, and validated there as a subrent of this record's
   * product with at least that many units still owed. The link is stored only
   * in the settling movement's `sources[]` — the record's own `supplier` is
   * the REPAIR vendor and is not reused. Sent with the breakdown it settles.
   */
  uid_purchase?: string;
  /** Client-minted per operator action; names the movements this save writes. */
  uuid_session: string;
  version: number;
}

/** Zod schema for UpdateOutOfServiceInput. */
export const UpdateOutOfServiceInput: z.ZodType<UpdateOutOfServiceInputType> = z.object({
  status: z.enum(OOS_USER_STATUSES).optional(),
  reason: z.enum(OOS_FLAG_REASONS).optional(),
  breakdown: OOSBreakdownInput.optional(),
  units: OOSUnitsInput.optional(),
  dates: z.object({
    start: chicagoInstant().nullable().optional(),
    end: chicagoInstant().nullable().optional(),
  }).optional(),
  destination: OOSDestinationInput.nullable().optional(),
  supplier: z.object({ uid: FirestoreId }).nullable().optional(),
  // Optional: only a save that raises `returned_to_supplier` names a purchase.
  uid_purchase: FirestoreId.optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
}).superRefine((u, ctx) => {
  if (u.uid_purchase !== undefined && u.breakdown === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_purchase"],
      message: "uid_purchase names the subrent a returned_to_supplier increase settles against, so it is sent with the breakdown",
    });
  }
  if (u.units === undefined) return;
  if (u.breakdown === undefined) {
    ctx.addIssue({ code: "custom", path: ["units"], message: "units are sent with the breakdown they name units for" });
    return;
  }
  unitsOverBreakdown(u.units, u.breakdown, ctx, ["units"]);
});
