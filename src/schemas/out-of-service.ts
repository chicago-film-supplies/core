/**
 * OutOfService document schema — Firestore collection: out-of-service
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
import { FirestoreId, ThreadId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OOSReasonEnum,
  type OOSReasonType,
  OrderDerivedOrgPath,
  type OrgPathNodeType,
  TimestampFields,
} from "./common.ts";

// ── Status enum ─────────────────────────────────────────────────────

const OOS_STATUSES = [
  "draft",
  "planned",
  "active",
  "blocked",
  "complete",
  "canceled",
] as const;
/** Allowed out-of-service statuses. Server-derived from breakdown + number + canceled_at; only "canceled" is operator-set. */
export type OOSStatusType = typeof OOS_STATUSES[number];
/** Zod schema for OOSStatusType. */
export const OOSStatusEnum: z.ZodType<OOSStatusType> = z.enum(OOS_STATUSES);

// ── Transaction type enum ───────────────────────────────────────────

const OOS_TRANSACTION_TYPES = [
  "open",
  "written_off",
  "returned_to_service",
] as const;
/**
 * Allowed types for an `OOSTransaction`. Terminal types match the breakdown
 * keys 1:1 — a transaction with `type === "written_off"` and `quantity === N`
 * corresponds to `breakdown.written_off += N`.
 */
export type OOSTransactionTypeType = typeof OOS_TRANSACTION_TYPES[number];
/** Zod schema for OOSTransactionTypeType. */
export const OOSTransactionTypeEnum: z.ZodType<OOSTransactionTypeType> = z.enum(OOS_TRANSACTION_TYPES);

// ── Breakdown ───────────────────────────────────────────────────────

/** Per-phase quantity breakdown — sum equals top-level `quantity`. */
export interface OOSBreakdown {
  draft: number;
  planned: number;
  active: number;
  blocked: number;
  written_off: number;
  returned_to_service: number;
}

/** Zod schema for OOSBreakdown. */
export const OOSBreakdownSchema: z.ZodType<OOSBreakdown> = z.strictObject({
  draft: z.int().meta({ column: true, label: "Draft" }),
  planned: z.int().meta({ column: true, label: "Planned" }),
  active: z.int().meta({ column: true, label: "Active" }),
  blocked: z.int().meta({ column: true, label: "Blocked" }),
  written_off: z.int().meta({ column: true, label: "Written Off" }),
  returned_to_service: z.int().meta({ column: true, label: "Returned To Service" }),
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

/** A transaction entry within an out-of-service record. */
export interface OOSTransaction {
  crms_id?: number | null;
  crms_quarantine_id?: number | null;
  crms_stock_level_id?: number | null;
  crms_stock_level_uid?: string;
  date: string;
  date_fs: FirestoreTimestampType;
  quantity: number;
  source: DocSourceType;
  type: OOSTransactionTypeType;
}

/**
 * Date object — booking-style start/end with paired Firestore timestamps.
 *
 * `start` is nullable for `draft` records (operator composing) and `planned`
 * records (scheduled maintenance with no pinned start instant). Once the
 * record reaches `active`, `start` should be set (writer enforces).
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
    name: string;
    path?: OrgPathNodeType[];
    crms_id: number | null;
  } | null;
  dates: OOSDates;
  sources: DocSourceType[];
  query_by_sources: string[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
  stores: OOSStore[];
  query_by_uid_store: string[];
  query_by_uid_location: string[];
  transactions?: OOSTransaction[];
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

const OOSStoreSchema: z.ZodType<OOSStore> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string().meta({ column: true }),
  default: z.boolean(),
  quantity: z.int().meta({ column: true, label: "Quantity" }),
  locations: z.array(OOSStoreLocationSchema).default([]).meta({ label: "Location" }),
});

const OOSTransactionSchema: z.ZodType<OOSTransaction> = z.strictObject({
  crms_id: z.int().nullable().optional(),
  crms_quarantine_id: z.int().nullable().optional(),
  crms_stock_level_id: z.int().nullable().optional(),
  crms_stock_level_uid: z.string().optional(),
  date: chicagoInstant(),
  date_fs: FirestoreTimestamp,
  quantity: z.int(),
  source: DocSource,
  type: OOSTransactionTypeEnum,
});

const OOSDatesSchema: z.ZodType<OOSDates> = z.strictObject({
  start: chicagoInstant().meta({ serverSortVia: "dates.start_fs", column: true, label: "Start" }).nullable(),
  start_fs: FirestoreTimestamp.nullable(),
  end: chicagoInstant().meta({ serverSortVia: "dates.end_fs", column: true, label: "End" }).nullable(),
  end_fs: FirestoreTimestamp.nullable(),
});

/** Zod schema for OutOfService. */
export const OutOfServiceSchema: z.ZodType<OutOfService> = z.strictObject({
  uid: FirestoreId,
  uid_product: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "outOfServiceDetail", serverSortVia: "number" }),
  reason: OOSReasonEnum.meta({ column: true, label: "Reason" }),
  status: OOSStatusEnum.meta({ column: true, label: "Status" }),
  quantity: z.int().meta({ serverSortVia: "quantity", column: true, label: "Quantity" }),
  breakdown: OOSBreakdownSchema,
  canceled_at: FirestoreTimestamp.nullable().meta({ column: true, label: "Canceled" }),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: z.string().meta({ pii: "mask", column: true, linkTo: "organizationDetail" }),
    path: OrderDerivedOrgPath,
    crms_id: z.int().nullable(),
  }).nullable().meta({ label: "Organization" }),
  dates: OOSDatesSchema,
  sources: z.array(DocSource).default([]).meta({ label: "Source" }),
  query_by_sources: z.array(z.string()).default([]),
  crms_id: z.int().nullable().optional(),
  crms_stock_level_id: z.int().nullable().optional(),
  stores: z.array(OOSStoreSchema).default([]).meta({ label: "Store" }),
  query_by_uid_store: z.array(FirestoreId).default([]),
  query_by_uid_location: z.array(FirestoreId).default([]),
  transactions: z.array(OOSTransactionSchema).optional(),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Out of Service Record",
  collection: "out-of-service",
  displayDefaults: {
    columns: ["number", "reason", "organization.name", "quantity", "dates.start", "dates.end"],
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
  stores?: OOSStore[];
  crms_id?: number | null;
  crms_stock_level_id?: number | null;
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
  stores: z.array(OOSStoreSchema).optional(),
  crms_id: z.int().nullable().optional(),
  crms_stock_level_id: z.int().nullable().optional(),
});

/**
 * Input for updating an out-of-service record.
 *
 * `breakdown` (when supplied) must be the complete next state — the writer
 * enforces `sum(breakdown) === quantity`. `status` is server-derived; only
 * `"canceled"` is honored from the client and translated into
 * `canceled_at = now()`.
 *
 * `dates.start` is honored on update only when the record has no sources
 * (`sources.length === 0` — manually created / ad-hoc). Source-bound records
 * (booking PUT or order check-in lineage) reject `dates.start` updates with a
 * 400 — the start there reflects a real ledger event recorded by the upstream
 * writer, and operator-side drift would desync the OOS from the source's
 * audit trail.
 */
export interface UpdateOutOfServiceInputType {
  status?: OOSStatusType;
  breakdown?: OOSBreakdown;
  dates?: { start?: string | null; end?: string | null };
  stores?: OOSStore[];
  version: number;
}

/** Zod schema for UpdateOutOfServiceInput. */
export const UpdateOutOfServiceInput: z.ZodType<UpdateOutOfServiceInputType> = z.object({
  status: OOSStatusEnum.optional(),
  breakdown: OOSBreakdownSchema.optional(),
  dates: z.object({
    start: chicagoInstant().nullable().optional(),
    end: chicagoInstant().nullable().optional(),
  }).optional(),
  stores: z.array(OOSStoreSchema).optional(),
  version: z.int().min(0),
});
