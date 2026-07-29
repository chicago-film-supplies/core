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
 * `transactions` is now a live-written source: the movement journal links a
 * reversal to the event it negates, and a component event to its parent, both
 * through `sources[]`. (It was historical-only when this list was surveyed —
 * 898 instances, identical count in both envs.) Never narrow this past stored
 * data; survey first.
 *
 * `locations` carries no `sources[]` of its own — it is here because a movement
 * line's `location.from` / `location.to` is a `DocSource` pointing at wherever
 * the units physically are: a `locations` doc (on a shelf), a `bookings` doc
 * (out on a job), or an `out-of-service` record. Widening is safe; the
 * `DocSource` shape is unchanged.
 */
export const CFS_SOURCE_COLLECTIONS = [
  "bookings",
  "cards",
  "contacts",
  "invoices",
  "locations",
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

/**
 * How a line's `price.base` becomes money.
 *
 * - `five_day_week` — `base × quantity × max(chargeable_days / 5, 1)`.
 * - `fixed` — `base × quantity`, no day factor.
 * - `percent_of_total` — `base` is a **percentage of the document's
 *   `subtotal_discounted`**, not a per-unit dollar amount. A line priced this
 *   way cannot be costed from itself, so `calculateItemSubtotal` rejects it;
 *   the amount is computed once per document by `calculateTransactionFeeAmount`
 *   during the totals pass. Only a `transaction_fee` line is priced this way —
 *   a credit-card fee is a percentage of what is being charged, which is the
 *   whole reason the fee type exists.
 */
const PRICE_FORMULAS = ["five_day_week", "fixed", "percent_of_total"] as const;
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

/**
 * Every item type that can appear in a `items[]` array, across all three
 * path-bearing collections. Derived from {@link DOC_ITEM_TYPES} rather than
 * re-typed: an invoice is exactly the order vocabulary plus the `order` divider
 * it needs to bill several orders at once.
 */
const ITEM_TYPES = [...DOC_ITEM_TYPES, "order"] as const;
/** Union of every order/invoice/fulfillment item type. */
export type ItemTypeType = typeof ITEM_TYPES[number];
/** Zod schema for {@link ItemTypeType}. */
export const ItemTypeEnum: z.ZodType<ItemTypeType> = z.enum(ITEM_TYPES);

// ── Item contracts ───────────────────────────────────────────────

/**
 * The per-type rules an `items[]` entry must satisfy, one entry per
 * {@link ITEM_TYPES} member. Modelled on `MOVEMENT_CONTRACTS` in
 * `transaction.ts`: a table the schema reads, so a contradiction is reported by
 * the schema instead of restated in every consumer.
 *
 * **The table carries only the axes that vary by TYPE.** The axes that vary by
 * COLLECTION are already the three documents' shapes and are not repeated here —
 * an invoice line has no `stock_method` key and its price has no `replacement`
 * key, a fulfillment line has no `price` at all, and every one of those objects
 * is a `z.strictObject`. Restating "forbidden" for them would be a second source
 * of truth for something the shape already makes inexpressible.
 *
 * Measured against prod `cfs-3100` (951 orders / 958 invoices / 952
 * fulfillments, 2026-07-29) before each axis was written — three axes an earlier
 * draft proposed are absent because the corpus refutes them:
 *
 * - **no `taxable` axis.** Every line type carries taxes on some rows and not
 *   others (surcharges: 149 of 151 order rows ARE taxed). Whether a line is
 *   taxed is the product's `tax_class` and the document's `tax_profile`, i.e.
 *   configuration, not a type invariant.
 * - **no per-type `formula` whitelist.** Order `sale`/`service`/`surcharge` rows
 *   are `fixed` while their invoice projections are `five_day_week` (617 sale,
 *   643 service, 137 surcharge). A whitelist keyed on type would reject the
 *   invoice side of the same line.
 * - **`replacement` is `optional`, not `forbidden`, off the rental arm.** All
 *   1,480 non-rental order line items carry a `price.replacement`; the builder
 *   writes it for every type.
 */
export interface ItemContract {
  /** Structural divider (organizes the array) or billable line (is charged for). */
  kind: "divider" | "line";
  /**
   * How the line meets the document total: `pre_tax` counts INTO the subtotal,
   * `from_total` is priced FROM it (a transaction fee), `none` is not priced at
   * all. This is the single fact behind `isPreTaxItem` / `isTransactionFeeItem`
   * / `isPriceableItem`, and it is what makes `percent_of_total` legal.
   */
  pricing: "pre_tax" | "from_total" | "none";
  /** Whether `price.replacement` must appear. Rentals need one once stocked. */
  replacement: "required_when_stocked" | "optional" | "forbidden";
  /** Whether the type can be picked off a shelf — the source of `FULFILLMENT_LINE_ITEM_TYPES`. */
  fulfillable: boolean;
  /**
   * Types that may be this item's immediate structural parent (`path.at(-2)`).
   * The document root is always legal and is not listed.
   *
   * This is the one asymmetry the corpus supports and the array-level check in
   * `validateItemParentage` enforces: **a divider is never parented by a line.**
   * Across all three collections a `group` sits only under a `destination`, a
   * `destination` only under an `order` divider or the root, and an `order`
   * divider only at the root — while line items are parented by dividers AND by
   * other line items (kit components; 4,453 such rows in orders alone).
   */
  parentable_by: readonly ItemTypeType[];
}

// Everything a component line may hang from: the three dividers plus every line
// type that can be a kit parent. `transaction_fee` is excluded on both sides — a
// fee is a document-level charge, so it neither nests under a product nor
// carries components of its own.
const LINE_PARENTS = [
  "order", "destination", "group", "rental", "replacement", "sale", "service", "surcharge",
] as const;
const DIVIDER_PARENTS = ["order", "destination", "group"] as const;

const ITEM_CONTRACTS_INNER = {
  // ── dividers ──
  order: { kind: "divider", pricing: "none", replacement: "forbidden", fulfillable: false, parentable_by: [] },
  destination: { kind: "divider", pricing: "none", replacement: "forbidden", fulfillable: false, parentable_by: ["order"] },
  group: { kind: "divider", pricing: "none", replacement: "forbidden", fulfillable: false, parentable_by: ["destination"] },
  // ── lines ──
  rental: { kind: "line", pricing: "pre_tax", replacement: "required_when_stocked", fulfillable: true, parentable_by: LINE_PARENTS },
  replacement: { kind: "line", pricing: "pre_tax", replacement: "optional", fulfillable: true, parentable_by: LINE_PARENTS },
  sale: { kind: "line", pricing: "pre_tax", replacement: "optional", fulfillable: true, parentable_by: LINE_PARENTS },
  service: { kind: "line", pricing: "pre_tax", replacement: "optional", fulfillable: true, parentable_by: LINE_PARENTS },
  surcharge: { kind: "line", pricing: "pre_tax", replacement: "optional", fulfillable: true, parentable_by: LINE_PARENTS },
  // A fee is priced FROM the document total, has no replacement value, and is
  // never picked off a shelf — which is why `FULFILLMENT_LINE_ITEM_TYPES`
  // excludes it rather than collapsing to `DOC_LINE_ITEM_TYPES`.
  transaction_fee: { kind: "line", pricing: "from_total", replacement: "forbidden", fulfillable: false, parentable_by: DIVIDER_PARENTS },
} as const;

/** The per-type item contract table. @see {@link ItemContract} */
export const ITEM_CONTRACTS: Readonly<Record<ItemTypeType, ItemContract>> = ITEM_CONTRACTS_INNER;

/**
 * The contract for an item `type`, or `undefined` for a value outside
 * {@link ITEM_TYPES}. Takes a `string` because the loose `LineItem` shadow in
 * `@cfs/core/utils/orders` types `type` as `string`; an unrecognized type has no
 * contract and every derived predicate answers `false` for it.
 */
export function itemContract(type: string): ItemContract | undefined {
  return (ITEM_CONTRACTS as Record<string, ItemContract | undefined>)[type];
}

/**
 * The `pricing` half of {@link ITEM_CONTRACTS}: a `percent_of_total` price is
 * legal only where the contract says the line is priced FROM the document total.
 *
 * Applies to every price shape in the package, so it is the check the invoice
 * arm attaches on its own — an invoice line has no `stock_method` and its price
 * has no `replacement` key, which leaves this as the only axis it can express.
 *
 * `percent_of_total` prices a line from the DOCUMENT total, which only
 * `calculateTransactionFeeAmount` knows how to do — `calculateItemSubtotal`
 * throws on it. Before this axis the combination was merely thrown on at
 * runtime, deep in `perUnitSubtotal`; here it is unwritable. The converse is
 * deliberately NOT asserted: a flat-amount fee is legitimate, and
 * `calculateTransactionFeeAmount` prices one.
 */
export function checkItemPriceFormula(
  item: { type: string; price?: { formula?: string } | null },
  ctx: z.RefinementCtx,
): void {
  const contract = itemContract(item.type);
  if (!contract || item.price == null) return;
  if (contract.pricing !== "from_total" && item.price.formula === "percent_of_total") {
    ctx.addIssue({
      code: "custom",
      path: ["price", "formula"],
      message: `"percent_of_total" prices from the document total and is only valid on a transaction_fee`,
    });
  }
}

/**
 * The full per-item contract check — {@link checkItemPriceFormula} plus the
 * `replacement` axis. Attached with `.superRefine` to the ORDER line-item arm,
 * the one item shape whose price carries a `replacement` channel. The direct
 * analogue of `checkMovementContract` in `transaction.ts`.
 *
 * `required_when_stocked` treats a MISSING `stock_method` as stocked — the
 * conservative reading, and the one the hand-written refine this replaced always
 * enforced. **Both callers now make the field required** (`OrderDocLineItemInner`
 * as of W5, `ComponentObject` from the start), so that branch is unreachable
 * through either one; it is kept because a refinement is not a parse and this
 * function takes a structural bound, not a schema.
 *
 * The `stock_method` requirement is also why the axis does not run on the
 * invoice arm: an invoice line drops `stock_method` and `price.replacement`
 * together, so an absent `stock_method` there means "this shape has no answer",
 * not "unknown" — and running it would reject all 7,076 invoice rentals in prod.
 */
export function checkItemContract(
  item: {
    type: string;
    stock_method?: string | null;
    price?: { formula?: string; replacement?: number | null } | null;
  },
  ctx: z.RefinementCtx,
): void {
  checkItemPriceFormula(item, ctx);
  const contract = itemContract(item.type);
  if (!contract) return;

  // Deliberately NOT gated on `price` being present: a rental with no price at
  // all cannot state a replacement value either, and the hand-written refine
  // this replaced rejected that case too (`item.price?.replacement != null`).
  // Both callers require `price` outright now, so — as with `stock_method`
  // above — this is defence on a structural bound, not a reachable branch.
  if (
    contract.replacement === "required_when_stocked" &&
    item.stock_method !== "none" && item.price?.replacement == null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["price", "replacement"],
      message: `price.replacement is required for ${item.type} items`,
    });
  }
  if (contract.replacement === "forbidden" && item.price?.replacement != null) {
    ctx.addIssue({
      code: "custom",
      path: ["price", "replacement"],
      message: `"${item.type}" has no replacement value; price.replacement must be absent`,
    });
  }
}

// A type list and a contract table are two hand-written lists of the same names;
// these make a gap between them a compile error. `MANUAL_MOVEMENT_TYPES` in
// `transaction.ts` is the one such list in this package WITHOUT an assertion,
// and core#41 is exactly the resulting drift.
type _ContractsCoverTypes = ItemTypeType extends keyof typeof ITEM_CONTRACTS ? true : never;
const _contractParity: _ContractsCoverTypes = true;
void _contractParity;

// `DOC_LINE_ITEM_TYPES` must be exactly the `kind: "line"` members — checked in
// BOTH directions, so neither adding a line type nor dropping one can drift.
type _LineTypes = {
  [K in ItemTypeType]: typeof ITEM_CONTRACTS_INNER[K]["kind"] extends "line" ? K : never;
}[ItemTypeType];
type _LineParity = [DocLineItemTypeType] extends [_LineTypes]
  ? [_LineTypes] extends [DocLineItemTypeType] ? true : never
  : never;
const _lineParity: _LineParity = true;
void _lineParity;

/**
 * The `pricing: "pre_tax"` members — every type that counts INTO the document
 * subtotal.
 *
 * Derived from {@link ITEM_CONTRACTS} rather than listed. A hand-written copy of
 * this union is exactly the drift the parity assertions above exist to prevent,
 * and `@cfs/core/utils/orders` carried one — `PreTaxLineItem["type"]` was the
 * literal list `"rental" | "sale" | "service" | "surcharge" | "replacement"`,
 * a sixth place to remember when a type is added.
 */
export type PreTaxItemType = {
  [K in ItemTypeType]: typeof ITEM_CONTRACTS_INNER[K]["pricing"] extends "pre_tax" ? K : never;
}[ItemTypeType];

/**
 * The `pricing: "from_total"` members — priced FROM the document total rather
 * than into it, which is what makes a `percent_of_total` formula legal on them.
 */
export type FromTotalItemType = {
  [K in ItemTypeType]: typeof ITEM_CONTRACTS_INNER[K]["pricing"] extends "from_total" ? K : never;
}[ItemTypeType];

/** The `kind: "divider"` members — the structural types that organize an array. */
export type DividerItemType = {
  [K in ItemTypeType]: typeof ITEM_CONTRACTS_INNER[K]["kind"] extends "divider" ? K : never;
}[ItemTypeType];

/**
 * Whether an item type is a billable line rather than a structural divider.
 *
 * The ONE answer to a question that was previously answered by hand in five
 * modules as `type !== "destination" && type !== "group"` — sometimes with
 * `&& type !== "order"` (correct for invoices, where an `order` divider exists)
 * and sometimes with `&& type !== "transaction_fee"`, which is a **different
 * question**: see {@link isFulfillableItemType}.
 *
 * Takes a `string` because callers hold item types from loosely-typed sources.
 * A value outside {@link ITEM_TYPES} has no contract and answers `false`.
 */
export function isLineItemType(type: string): type is DocLineItemTypeType {
  return itemContract(type)?.kind === "line";
}

/** Whether an item type is a structural divider — the complement of {@link isLineItemType}. */
export function isDividerItemType(type: string): type is DividerItemType {
  return itemContract(type)?.kind === "divider";
}

/**
 * Whether an item type can be picked off a shelf — the `fulfillable` axis.
 *
 * NOT a synonym for {@link isLineItemType}: `transaction_fee` is a line and is
 * not fulfillable. Two predicates seven lines apart in `services/fulfillment.ts`
 * drew exactly that distinction by hand and read as if they disagreed.
 */
export function isFulfillableItemType(type: string): type is FulfillableItemType {
  return itemContract(type)?.fulfillable === true;
}

/**
 * Line item types a fulfillment carries — the `fulfillable: true` members.
 * `transaction_fee` is excluded because a fee has no stock and is never picked
 * off a shelf, so this is NOT a narrower spelling of {@link DOC_LINE_ITEM_TYPES}
 * waiting to be collapsed into it; the exclusion IS the contract.
 *
 * Lives here rather than in `fulfillment.ts` so the list, the table it must
 * agree with, and the assertion below are one thing to read.
 */
export const FULFILLMENT_LINE_ITEM_TYPES = ["rental", "replacement", "sale", "service", "surcharge"] as const;
/** @see {@link FULFILLMENT_LINE_ITEM_TYPES} */
export type FulfillableItemType = typeof FULFILLMENT_LINE_ITEM_TYPES[number];

// Same bidirectional parity for the fulfillable axis: adding a fulfillable type
// without listing it, or listing one the table calls unfulfillable, is a compile
// error rather than a divergence discovered in the picker.
type _FulfillableTypes = {
  [K in ItemTypeType]: typeof ITEM_CONTRACTS_INNER[K]["fulfillable"] extends true ? K : never;
}[ItemTypeType];
type _FulfillableParity = [FulfillableItemType] extends [_FulfillableTypes]
  ? [_FulfillableTypes] extends [FulfillableItemType] ? true : never
  : never;
const _fulfillableParity: _FulfillableParity = true;
void _fulfillableParity;

// `ComponentSchema` reuses `checkItemContract`, which is only sound while every
// catalog component type is also an item type — a component that expanded into
// a line with no contract would silently skip the check rather than fail it.
type _ComponentsAreLines = ComponentTypeType extends DocLineItemTypeType ? true : never;
const _componentParity: _ComponentsAreLines = true;
void _componentParity;

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
