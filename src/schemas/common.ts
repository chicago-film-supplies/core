/**
 * Shared schema fragments used across multiple collections.
 */
import { z } from "zod";
import { AnyUid, FirestoreId } from "./_uid.ts";

// Re-export the id validators so consumers can import them from the package root.
export { AnyUid, BookingId, CardId, EventCardId, FirestoreId, ItemUid, ListId, QuoteId, ThreadId } from "./_uid.ts";

/**
 * Structural interfaces for Firestore Timestamp and FieldValue.
 * Expressed structurally so the schemas package has no firebase-admin dependency.
 */
export interface FirestoreTimestampValue {
  toMillis(): number;
  toDate(): Date;
  seconds: number;
  nanoseconds: number;
}

/** Structural interface for Firestore FieldValue (write-time sentinel). */
export interface FirestoreFieldValue {
  isEqual(other: FirestoreFieldValue): boolean;
}

/** Union of Firestore Timestamp (read) and FieldValue (write). */
export type FirestoreTimestampType = FirestoreTimestampValue | FirestoreFieldValue;

/**
 * Firestore Timestamp — structural check for `{ seconds, nanoseconds }`.
 *
 * Tight on purpose: rejects `undefined`, `null`, plain objects, and
 * `FieldValue` write-time sentinels (which only carry `isEqual`). Writers
 * must stamp a real `Timestamp` (e.g. `Timestamp.now()` from
 * `firebase-admin/firestore`) — `validateBeforeWrite` strips `FieldValue`
 * sentinels before validation, so a sentinel-stamped timestamp would
 * surface here as `undefined` and fail loudly.
 *
 * The accepted union still includes `FirestoreFieldValue` for back-compat
 * with consumers that type fields against the union (e.g. user-facing
 * `cloneDeep` mutate-then-stamp patterns), but the runtime gate enforces
 * the real-Timestamp contract.
 */
export const FirestoreTimestamp: z.ZodType<FirestoreTimestampType> = z.custom<FirestoreTimestampType>(
  (val) => {
    if (val === null || typeof val !== "object") return false;
    // Accept either the public Timestamp accessor shape (`seconds`/
    // `nanoseconds`, exposed via getters on a `Timestamp` instance) OR the
    // private underscored shape (`_seconds`/`_nanoseconds`, what survives
    // `structuredClone` / `lodash.cloneDeep`). Firestore writes accept both.
    const v = val as Partial<FirestoreTimestampValue> & {
      _seconds?: number;
      _nanoseconds?: number;
    };
    if (typeof v.seconds === "number" && typeof v.nanoseconds === "number") return true;
    if (typeof v._seconds === "number" && typeof v._nanoseconds === "number") return true;
    return false;
  },
);

/**
 * Standard timestamp fields present on most documents.
 */
export const TimestampFields: {
  created_at: z.ZodType<FirestoreTimestampType>;
  updated_at: z.ZodType<FirestoreTimestampType>;
} = {
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
};

/**
 * Email string with format and length constraints.
 */
export const Email: z.ZodType<string> = z.email("Must be a valid email address").min(5).max(254).meta({ pii: "mask" });

/**
 * Phone string with length constraints.
 */
export const Phone: z.ZodType<string> = z
  .string()
  .min(10, "Phone number must be at least 10 characters")
  .max(20, "Phone number must not exceed 20 characters")
  .meta({ pii: "mask" });

/**
 * Split name fields shared across Contact, User, Invite, and any schema
 * embedding a contact reference. `first_name` is required; the rest are optional.
 *
 * Stored documents also carry a denormalized `name: string` (use `NameField`
 * + `deriveName()` below). Inputs do not — clients send parts; the server
 * derives `name` at write time. See `deriveName` for the canonical join rule.
 */
export interface NameParts {
  first_name: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
}

/**
 * All-optional variant of `NameParts` — use for partial update input types
 * (PUT endpoints) where callers may omit `first_name`.
 */
export interface PartialNameParts {
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  pronunciation?: string;
}

/**
 * Fields object — spread into a parent `z.strictObject()` (documents) or
 * `z.object()` (inputs) to attach the standard split-name fields.
 */
export const NamePartsFields: {
  first_name: z.ZodType<string>;
  middle_name: z.ZodType<string | undefined>;
  last_name: z.ZodType<string | undefined>;
  pronunciation: z.ZodType<string | undefined>;
} = {
  first_name: z.string().min(1, "First name is required").max(50).meta({ pii: "mask" }),
  middle_name: z.string().min(1).max(50).meta({ pii: "mask" }).optional(),
  last_name: z.string().min(1).max(50).meta({ pii: "mask" }).optional(),
  pronunciation: z.string().min(1).max(100).meta({ pii: "mask" }).optional(),
};

/**
 * Variant of `NamePartsFields` where every field is optional — use for partial
 * update input schemas (PUT endpoints) where callers may omit `first_name`.
 */
export const NamePartsFieldsPartial: {
  first_name: z.ZodType<string | undefined>;
  middle_name: z.ZodType<string | undefined>;
  last_name: z.ZodType<string | undefined>;
  pronunciation: z.ZodType<string | undefined>;
} = {
  first_name: z.string().min(1, "First name is required").max(50).meta({ pii: "mask" }).optional(),
  middle_name: z.string().min(1).max(50).meta({ pii: "mask" }).optional(),
  last_name: z.string().min(1).max(50).meta({ pii: "mask" }).optional(),
  pronunciation: z.string().min(1).max(100).meta({ pii: "mask" }).optional(),
};

/**
 * Canonical join rule for deriving a single display string from name parts.
 * Joins `[first_name, middle_name, last_name]` with single spaces (missing
 * parts are dropped, never produce empty padding) and appends ` (pronunciation)`
 * when set. This is the single source of truth — every `name` field on a
 * stored document and `ActorRef.name` is computed by passing through here.
 */
export function deriveName(parts: PartialNameParts): string {
  const base = [parts.first_name, parts.middle_name, parts.last_name].filter(Boolean).join(" ");
  return parts.pronunciation ? `${base} (${parts.pronunciation})` : base;
}

/**
 * Zod field for the denormalized `name` on stored documents (Contact, User,
 * Invite, embedded contact refs in destinations, ActorRef-shaped objects).
 *
 * The 255 max is the exact upper bound of `deriveName(parts)` given the
 * existing per-part maxes:
 *   50 (first) + 1 (sp) + 50 (middle) + 1 (sp) + 50 (last) + 1 (sp)
 *   + 1 ("(") + 100 (pronunciation) + 1 (")") = 255
 * If any part's `.max(...)` changes, this ceiling must move with it or
 * worst-case writes will fail validation.
 */
export const NameField: z.ZodType<string> = z.string().min(1).max(255).meta({ pii: "mask" });

/**
 * Coordinates object (latitude/longitude).
 */
export interface CoordinatesType {
  latitude: number;
  longitude: number;
}

/** Zod schema for coordinates (latitude/longitude), nullable. */
export const Coordinates: z.ZodType<CoordinatesType | null> = z.strictObject({
  latitude: z.number(),
  longitude: z.number(),
}).nullable();

/**
 * Address object — shared between organizations and order destinations.
 */
export interface AddressType {
  city: string;
  country_name: string;
  full: string;
  name: string;
  postcode: string;
  region: string;
  street: string;
  street2?: string;
  mapbox_id?: string;
  address_coordinates?: CoordinatesType | null;
  user_coordinates?: CoordinatesType | null;
}

/**
 * Collections that may legitimately appear as a {@link DocSourceType} `collection`.
 *
 * This was `z.string().min(1)` — free text that reached a Firestore collection
 * name. `CreateCardInput.sources` comes straight off the POST body and
 * `createCard` copies it into the THREAD's `sources`, so
 * `POST /cards {sources:[{collection:"cards", uid:X}]}` wrote a thread claiming
 * a card as its own source, which `deleteCard` then unpicks by
 * `s.collection === "cards"`. Every consumer was re-deriving the same implicit
 * "it's one of the known CFS collections" contract; it is encoded once here.
 *
 * Membership is the union of a read-only survey of every stored `DocSource` in
 * BOTH envs (threads, comments, cards, recurrences.prototype, out-of-service
 * `sources[]` + `transactions[].source` — dev and prod agreed on the same 12
 * values, no malformed entries) plus `template-components`, which has no stored
 * instance yet but is declared legitimate by `TEMPLATE_SOURCES` in `comment.ts`.
 *
 * `transactions` has no live writer — its 898 instances (identical count in both
 * envs) are historical. It stays in: dropping it would fail those docs on their
 * next update through `validateBeforeWrite`. Never narrow this past stored data;
 * survey first.
 */
export const CFS_SOURCE_COLLECTIONS = [
  "bookings",
  "cards",
  "contacts",
  "invoices",
  "orders",
  "organizations",
  "out-of-service",
  "products",
  "roles",
  "template-components",
  "templates",
  "templates-versions",
  "transactions",
] as const;
/** A collection name valid in a {@link DocSourceType}. */
export type CfsSourceCollectionType = typeof CFS_SOURCE_COLLECTIONS[number];
/** Zod schema for CfsSourceCollectionType. */
export const CfsSourceCollectionEnum: z.ZodType<CfsSourceCollectionType> = z.enum(
  CFS_SOURCE_COLLECTIONS,
);

/**
 * A `{collection, uid}` pointer to any Firestore document. Used polymorphically
 * by Thread, Comment, and Card to reference the source docs they belong to.
 *
 * Lives here (not in thread.ts where it originated) because it's a shared
 * primitive — the "thread" prefix misled readers into thinking it was
 * thread-specific.
 */
export interface DocSourceType {
  collection: CfsSourceCollectionType;
  uid: string;
  label?: string | null;
}

/** Zod schema for a polymorphic doc reference. */
export const DocSource: z.ZodType<DocSourceType> = z.strictObject({
  collection: CfsSourceCollectionEnum,
  // Polymorphic — points at any collection, including composite-keyed docs
  // (bookings, stock-summaries). AnyUid is the union of every known id shape.
  uid: AnyUid,
  label: z.string().max(200).nullable().optional(),
});

/**
 * Generic uid + name reference used across many collections.
 */
export interface UidNameRefType {
  uid: string;
  name: string;
}

/** Zod schema for a uid + name reference. */
export const UidNameRef: z.ZodType<UidNameRefType> = z.strictObject({
  // Generic/polymorphic reference — AnyUid covers every known id shape.
  uid: AnyUid,
  name: z.string().min(1).max(100).meta({ pii: "none" }),
});

/**
 * Actor reference — embedded `{uid, name}` for `created_by` / `updated_by` /
 * `deleted_by` fields across document schemas. The `name` is denormalized at
 * write time by the server via `deriveName(parts)` (with `uid` as a fallback
 * when all parts are empty — see `buildActorRef` in api-cloudrun). Non-human
 * actors (e.g. integrations, scheduled jobs) use a synthetic uid such as
 * `"manager-bot"` with a matching display name. Name changes on the source
 * user fan out via the `update-user:name-to-actor-refs` propagation rule.
 */
export interface ActorRefType {
  uid: string;
  name: string;
}

/** Zod schema for an actor reference. */
export const ActorRef: z.ZodType<ActorRefType> = z.strictObject({
  // Free-form in historical data: real user ids, bot slugs (manager-bot,
  // crms-bot, …), ad-hoc migration actors (migrateProducts, migration-bot),
  // and even legacy email addresses. Not constrainable without a data cleanup
  // — deferred to a future migration before a strict ActorId can be applied.
  uid: z.string().min(1),
  name: NameField,
});

// ── Shared enums ────────────────────────────────────────────────────

const RATE_TYPES = ["percent", "flat"] as const;
/** Allowed values for rate type: percent or flat. */
export type RateType = typeof RATE_TYPES[number];
/** Zod schema for RateType. */
export const RateTypeEnum: z.ZodType<RateType> = z.enum(RATE_TYPES);

const PRODUCT_TYPES = ["rental", "sale", "service", "surcharge", "replacement", "transaction_fee"] as const;
/** Allowed values for product type. */
export type ProductTypeType = typeof PRODUCT_TYPES[number];
/** Zod schema for ProductTypeType. */
export const ProductTypeEnum: z.ZodType<ProductTypeType> = z.enum(PRODUCT_TYPES);

const STOCK_METHODS = ["bulk", "serialized", "none"] as const;
/** Allowed values for inventory stock tracking method. */
export type StockMethodType = typeof STOCK_METHODS[number];
/** Zod schema for StockMethodType. */
export const StockMethodEnum: z.ZodType<StockMethodType> = z.enum(STOCK_METHODS);

const TAX_PROFILES = ["tax_applied", "tax_exempt", "tax_rantoul", "tax_frankfort"] as const;
/** Allowed values for organization-level tax profile. */
export type TaxProfileType = typeof TAX_PROFILES[number];
/** Zod schema for TaxProfileType. */
export const TaxProfileEnum: z.ZodType<TaxProfileType> = z.enum(TAX_PROFILES);

const PRICE_FORMULAS = ["five_day_week", "fixed"] as const;
/** Allowed values for pricing formula. */
export type PriceFormulaType = typeof PRICE_FORMULAS[number];
/** Zod schema for PriceFormulaType. */
export const PriceFormulaEnum: z.ZodType<PriceFormulaType> = z.enum(PRICE_FORMULAS);

const ITEM_TAX_PROFILES = [
  "tax_none", "tax_chicago_rental_tax", "tax_chicago_sales_tax", "tax_rantoul_sales_tax",
] as const;
/** Allowed values for item-level tax profile. */
export type ItemTaxProfileType = typeof ITEM_TAX_PROFILES[number];
/** Zod schema for ItemTaxProfileType. */
export const ItemTaxProfileEnum: z.ZodType<ItemTaxProfileType> = z.enum(ITEM_TAX_PROFILES);

const INCLUSION_TYPES = ["default", "mandatory", "optional"] as const;
/** Allowed values for component inclusion type. */
export type InclusionTypeType = typeof INCLUSION_TYPES[number];
/** Zod schema for InclusionTypeType. */
export const InclusionTypeEnum: z.ZodType<InclusionTypeType> = z.enum(INCLUSION_TYPES);

const COMPONENT_TYPES = ["rental", "sale", "service", "surcharge"] as const;
/** Allowed values for component type. */
export type ComponentTypeType = typeof COMPONENT_TYPES[number];
/** Zod schema for ComponentTypeType. */
export const ComponentTypeEnum: z.ZodType<ComponentTypeType> = z.enum(COMPONENT_TYPES);

const COA_REVENUE_CODES = [
  2210, 2800, 4000, 4100, 4110, 4120, 4130, 4140, 4150,
  4200, 4210, 4700, 4800,
] as const;
/** Allowed values for chart-of-accounts revenue code. */
export type COARevenueType = typeof COA_REVENUE_CODES[number];
/** Zod schema for COARevenueType. */
export const COARevenueEnum: z.ZodType<COARevenueType> = z.union([
  z.literal(2210), z.literal(2800), z.literal(4000), z.literal(4100),
  z.literal(4110), z.literal(4120), z.literal(4130), z.literal(4140),
  z.literal(4150), z.literal(4200), z.literal(4210), z.literal(4700),
  z.literal(4800),
]);

const DOC_ITEM_TYPES = ["rental", "destination", "group", "replacement", "sale", "service", "surcharge", "transaction_fee"] as const;
/** All item types accepted in order/invoice input schemas (includes structural dividers). */
export type DocItemTypeType = typeof DOC_ITEM_TYPES[number];
/** Zod schema for DocItemTypeType. */
export const DocItemTypeEnum: z.ZodType<DocItemTypeType> = z.enum(DOC_ITEM_TYPES);

/** Billable line item types stored in order/invoice documents (excludes destination/group dividers). */
export const DOC_LINE_ITEM_TYPES = ["rental", "replacement", "sale", "service", "surcharge", "transaction_fee"] as const;
/** Billable line item types stored in order/invoice documents (excludes destination/group dividers). */
export type DocLineItemTypeType = typeof DOC_LINE_ITEM_TYPES[number];
/** Zod schema for DocLineItemTypeType. */
export const DocLineItemTypeEnum: z.ZodType<DocLineItemTypeType> = z.enum(DOC_LINE_ITEM_TYPES);

const INVOICE_STATUSES = ["draft", "issued", "part_paid", "paid", "void"] as const;
/** Possible invoice statuses. */
export type InvoiceStatusType = typeof INVOICE_STATUSES[number];
/** Zod schema for InvoiceStatusType. */
export const InvoiceStatusEnum: z.ZodType<InvoiceStatusType> = z.enum(INVOICE_STATUSES);

const OOS_REASONS = ["cleaning", "damaged", "maintenance", "lost"] as const;
/** Allowed values for out-of-service reason. */
export type OOSReasonType = typeof OOS_REASONS[number];
/** Zod schema for OOSReasonType. */
export const OOSReasonEnum: z.ZodType<OOSReasonType> = z.enum(OOS_REASONS);

// ── Store breakdown (shared by InventoryLedger & StockSummary) ──────

/** A single location within a store breakdown entry. */
export interface StoreBreakdownLocation {
  uid_location: string;
  name: string;
  quantity: number;
  default: boolean;
  max: number | null;
}

/** A single store entry in a stock breakdown, containing its locations. */
export interface StoreBreakdownEntry {
  uid_store: string;
  name: string;
  default: boolean;
  crms_stock_level_id: number | null;
  quantity: number;
  locations: StoreBreakdownLocation[];
}

/** Zod schema for StoreBreakdownLocation. */
export const StoreBreakdownLocationSchema: z.ZodType<StoreBreakdownLocation> = z.strictObject({
  uid_location: FirestoreId,
  name: z.string(),
  quantity: z.number().min(0), // physical shelf count — can't go negative
  default: z.boolean(),
  max: z.number().nullable(),
});

/** Zod schema for StoreBreakdownEntry. */
export const StoreBreakdownEntrySchema: z.ZodType<StoreBreakdownEntry> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string(),
  default: z.boolean(),
  crms_stock_level_id: z.number().nullable(),
  quantity: z.number().min(0), // Σ of this store's location quantities — can't go negative
  locations: z.array(StoreBreakdownLocationSchema).default([]),
});

// ── Address ─────────────────────────────────────────────────────────

/**
 * Zod schema for Address, nullable.
 *
 * The object carries the `pii: "mask"` tag and every leaf inherits it, so a
 * new field added here is masked by default — the safe direction. The three
 * coarse-geography leaves opt OUT explicitly: a city / state / country cannot
 * identify anyone on their own, they are what makes a sanitized fixture still
 * look like a plausible address, and faking them produces nonsense (the mask
 * transform reads `"United States"` as a person's name and `"IL"` as a city).
 * The identifying parts — `street`, `street2`, `full`, `name`, `postcode`, and
 * the two `Coordinates` — stay masked.
 */
export const Address: z.ZodType<AddressType | null> = z.strictObject({
  city: z.string().default("").meta({ pii: "none" }),
  country_name: z.string().default("").meta({ pii: "none" }),
  full: z.string().default(""),
  name: z.string().max(100).default(""),
  postcode: z.string().default(""),
  region: z.string().default("").meta({ pii: "none" }),
  street: z.string().default(""),
  street2: z.string().default("").optional(),
  mapbox_id: z.string().default("").optional(),
  address_coordinates: Coordinates.optional(),
  user_coordinates: Coordinates.optional(),
}).nullable().meta({
  pii: "mask",
});
