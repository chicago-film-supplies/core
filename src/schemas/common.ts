/**
 * Shared schema fragments used across multiple collections.
 */
import { z } from "zod";
import { AnyUid, FirestoreId } from "./_uid.ts";
import { usState } from "./_usState.ts";

// Re-export the id validators so consumers can import them from the package root.
export { AnyUid, BookingId, CardId, EventCardId, FirestoreId, ItemUid, ListId, QuoteId, ThreadId } from "./_uid.ts";

// Re-export the region canonicalizer so consumers reach one implementation.
export { isIllinoisPostcode, toRegionCode, toUsStateCode, usState } from "./_usState.ts";

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
 * Meta key marking a node as the {@link FirestoreTimestamp} custom type.
 *
 * `isDateLikeNode` used to recognise it by **instance identity** — the only
 * handle a `z.custom()` offers, since its `def.type` is the uninformative
 * `"custom"`. That was safe exactly as long as nobody annotated a timestamp
 * field, because **`.meta()` clones**: `FirestoreTimestamp.meta({ label })` is a
 * different instance, the identity test fails, and a `created_at` column
 * silently stops rendering as a date and starts printing a raw epoch. Declaring
 * display columns means annotating `created_at` / `updated_at` / `last_order`,
 * so the identity test had to go.
 *
 * A meta marker survives the clone because `.meta()` **merges**: the clone
 * carries both this key and whatever the annotation added.
 */
export const FIRESTORE_TIMESTAMP_META = "firestoreTimestamp";

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
 *
 * Carries {@link FIRESTORE_TIMESTAMP_META} so it stays recognisable **through a
 * `.meta()` clone** — see that constant.
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
).meta({
  [FIRESTORE_TIMESTAMP_META]: true,
  // zod-to-openapi cannot infer a JSON schema for a `z.custom`, so it reads this
  // for every usage and throws `UnknownZodTypeError` without it. It lives HERE
  // rather than being injected by the API at boot — which is where it used to
  // live, behind `if (!z.globalRegistry.has(FirestoreTimestamp))`. That guard
  // meant "has no meta", so the moment this type carried ANY annotation the
  // representation stopped being registered; and it could only ever cover the
  // base instance, never the `.meta()` clones on `TimestampFields`. Meta MERGES
  // through a clone, so declaring it at the source covers both.
  type: "string",
  format: "date-time",
  description: "Firestore Timestamp (serialized as an ISO datetime in the spec).",
});

/**
 * Standard timestamp fields present on most documents.
 *
 * Both are declared display columns here rather than at each of the ~30 sites
 * that spread this object — the heading is the same everywhere because the
 * meaning is. `.meta()` clones, so these two are distinct instances of
 * `FirestoreTimestamp` and the base stays unannotated.
 */
export const TimestampFields: {
  created_at: z.ZodType<FirestoreTimestampType>;
  updated_at: z.ZodType<FirestoreTimestampType>;
} = {
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
};

/**
 * Email string with format and length constraints.
 */
export const Email: z.ZodType<string> = z.email("Must be a valid email address").min(5).max(254).meta({ pii: "mask" });

/**
 * Phone string with length constraints.
 *
 * Carries `cell: "phone"` because a phone number is the one display type Zod
 * cannot discriminate — it is a `z.string()` with a regex, structurally
 * identical to a subject line. Declared once, here, rather than recovered per
 * column by testing whether the path `includes("phone")`. (An email needs no
 * such marker: `z.email()` has its own `format`.)
 */
export const Phone: z.ZodType<string> = z
  .string()
  .min(10, "Phone number must be at least 10 characters")
  .max(20, "Phone number must not exceed 20 characters")
  .meta({ pii: "mask", cell: "phone" });

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
  "credit-notes",
  "invoices",
  "locations",
  "orders",
  "organizations",
  "out-of-service",
  "products",
  "roles",
  "settlements",
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
  collection: CfsSourceCollectionEnum.meta({ column: true, label: "Collection" }),
  // Polymorphic — points at any collection, including composite-keyed docs
  // (bookings, stock). AnyUid is the union of every known id shape.
  uid: AnyUid,
  // `label` the FIELD, and `label` the display annotation, are unrelated names
  // that happen to collide: this is the human description of the source doc.
  label: z.string().max(200).nullable().optional().meta({ column: true, label: "Label" }),
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
  // A reference's name IS the column, and the heading is the key that holds it
  // — "Tags" under `tags`, "Alternates" under `alternates`. Hence `column`
  // without a `label` of its own: every key holding a `UidNameRef` must name it.
  name: z.string().min(1).max(100).meta({ pii: "none", column: true }),
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

/**
 * The display annotation a **discriminated** rate column carries.
 *
 * A rate normally names its unit outright — `unit: "usd"` on
 * `transactions:cost.unit_cost` says "4dp dollars" and the cell formats it. A
 * `rate` beside a {@link RateTypeEnum} cannot: `10.25` is `10.25%` when the
 * row's own `type` says `percent` and `$10.25` per unit when it says `flat`. The
 * unit is a property of the ROW, not of the field, so no static per-field value
 * can express it — one would render the other arm wrongly.
 *
 * So the annotation names *where to look* (`unitVia`, a sibling key resolved
 * against the leaf's own parent object) and *what each value means* (`unitMap`).
 * The map is the load-bearing half: a bare `rate: true` would repeat exactly
 * what `TypesenseField.money` did — carry a definition with no unit, which
 * rendered every money mirror 100× on 2026-08-08.
 *
 * One constant rather than four copies, so a new `RateType` member is one edit;
 * `tests/display-columns.test.ts` T14 fails if the map stops covering the enum.
 */
export const RATE_UNIT_META = {
  unitVia: "type",
  unitMap: { percent: "percent", flat: "usd" },
} as const;

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

// `TAX_PROFILES` / `TaxProfileType` / `TaxProfileEnum` were DELETED here
// (api-cloudrun#596 item 3, the contract third). The enum welded a property of
// the CUSTOMER (`tax_exempt`) to a property of WHERE THE GOODS WENT
// (`tax_rantoul` / `tax_frankfort` / `tax_paxton`) in one slot, so a document
// could assert only one of them — which is why a mixed Chicago/Frankfort order
// was unpriceable and an exempt customer's jurisdiction was unrecordable.
// {@link JurisdictionEnum} and `tax_exempt` are the two axes that replaced it.
//
// ⚠️ **The vocabulary survives OUTSIDE core, in api-cloudrun, and that is not
// an oversight.** CRMS names a tax CLASS whose members are exactly these, and
// `getOrgInvoiceTaxProfileFromCrmsId` renders one on every member webhook. That
// is a CRMS concept with a CRMS lifetime, so it belongs at that boundary rather
// than in the shared document vocabulary — it goes at the CRMS cutover.

/**
 * **Where the goods went** — the tax jurisdiction CFS collects for.
 *
 * This is the axis the retired `tax_profile` enum welded to exemption and could
 * not separate: it mixed a property of the *customer* (`tax_exempt`) with a
 * property of *where the goods went* (`tax_rantoul`, `tax_frankfort`,
 * `tax_paxton`) in one slot, so a document got exactly one of them — which is
 * why jurisdiction WAS document-scoped, why a mixed Chicago/Frankfort order
 * could not be priced, and why an exempt customer's jurisdiction was
 * unrecordable. Splitting the two axes is what made a per-destination answer
 * expressible, and the enum was deleted at api-cloudrun#596 item 3.
 *
 * A jurisdiction is a **registration**, not a place: CFS is registered to
 * collect in exactly these, and an address outside them does not get its own
 * rate — it sources to the store (origin sourcing) or resolves `no_nexus`. See
 * `deriveJurisdiction` in `@cfs/core/utils/taxes` for the three cases and their
 * distinct legal reasons.
 *
 * ⚠️ **`paxton` stays a member although CFS no longer delivers there.** Prod
 * holds one `complete` order and one invoice under it, both embedding the
 * Paxton tax uid, and `calculateItemTax` throws `Unknown tax uid` on a missing
 * one. The member is what keeps that history re-derivable; it is removed from
 * the manager picker and from the derivation rule, not from the vocabulary.
 *
 * ## `no_nexus` is a sourcing ANSWER, not a place — and it is why `null` is free
 *
 * Every level of the precedence chain below is `JurisdictionType | null`, and
 * **`null` means one thing at every level: "I assert nothing, ask the next
 * level."** The answer *"this sources somewhere CFS collects no tax"* is
 * `no_nexus`, a value like any other — so it is an override an operator can
 * author, it stops the chain by being an answer rather than by a special rule,
 * and a plain `??` expresses the whole precedence.
 *
 * ```
 * order/invoice.destinations[i].jurisdiction   the document's own value   ← WINS
 *   ?? organizations/{uid}.jurisdiction_claim    the customer's standing claim
 *   ?? deriveJurisdiction(address, origin)       total — always answers
 * ```
 *
 * 🔴 **An earlier design spelled that answer `null` and it does not work.**
 * With `null` meaning both *"no jurisdiction"* and *"no opinion"*, `a ?? b`
 * collapses them and a stored no-jurisdiction falls through to the next level:
 * an out-of-state delivery for a Frankfort-claim customer resolves `frankfort`,
 * i.e. over-collection on a customer CFS has no nexus with. Splitting the two
 * into a value and an absence is what removes the ambiguity — not a
 * `firstAsserted` walker that policed it, which this replaced.
 *
 * ⚠️ **`no_nexus` is NOT "outside Illinois", and the two must not be merged.**
 * It names the *legal reason* — CFS has no collection obligation there — which
 * is precisely the distinction `deriveJurisdiction` case 1 (nexus) draws
 * against case 3 (origin sourcing). A non-Chicago Illinois delivery is
 * emphatically **not** `no_nexus`: it sources to the store and is taxed.
 * Naming it after the reason rather than the geography is also what keeps it
 * true if CFS ever registers in another state — that state then gets its own
 * member, and `no_nexus` still means what it says.
 *
 * ⚠️ **Not offered everywhere the type is.** `taxes/{uid}.jurisdiction` records
 * who levies a tax, and nobody levies one under `no_nexus`; the manager's tax
 * picker excludes it exactly as it already excludes `paxton`.
 */
/**
 * The jurisdictions CFS is REGISTERED to collect in, as a runtime list.
 *
 * Exported so an audit can print a TOTAL `(jurisdiction x item type)` matrix —
 * the cells nothing covers are the point of that report, and they are only
 * visible against the full vocabulary. A hand-copied list in the audit would be
 * a second encoding of the registration set, free to drift from this one.
 */
export const JURISDICTIONS = ["chicago", "rantoul", "frankfort", "paxton", "no_nexus"] as const;
/** Allowed values for tax jurisdiction. */
export type JurisdictionType = typeof JURISDICTIONS[number];
/** Zod schema for JurisdictionType. */
export const JurisdictionEnum: z.ZodType<JurisdictionType> = z.enum(JURISDICTIONS);

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

// `ITEM_TAX_PROFILES` / `ItemTaxProfileType` / `ItemTaxProfileEnum` were removed
// here (api-cloudrun#435). They were a THIRD tax vocabulary beside
// `TAX_PROFILES` and the live COA→tax map, exported from `schemas/mod.ts` and used by
// nothing — no schema field was typed with them, and the one place their string
// values appeared was `chart-of-accounts.default_tax_profile`, which was
// `z.string()` and is deleted in the same change.

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
 * path-bearing collections: the order vocabulary ({@link DOC_ITEM_TYPES}) plus
 * the `order` divider an invoice needs to bill several orders at once.
 *
 * **Written out rather than spread, and that is load-bearing — see core#43.**
 * This was `[...DOC_ITEM_TYPES, "order"] as const`, which is the honest way to
 * say it and which TypeScript infers correctly. JSR's npm declaration emit does
 * not: it is syntactic, cannot expand the spread without inference, and silently
 * published `declare const ITEM_TYPES: readonly ["order"]`. So every npm
 * consumer saw `ItemTypeType` as the single literal `"order"`, and everything
 * typed on it — `LineItem.type`, `ITEM_CONTRACTS`, `ItemTypeEnum` — degraded
 * with it. Deno consumers read this source and were unaffected, which is exactly
 * why nothing caught it: the api-cloudrun suite, `deno task check` and
 * `deno publish --dry-run` all agree with the source. Measured cost: 57 of the
 * 75 type errors on manager's `beta.88` → `beta.109` bump.
 *
 * The derivation survives as the parity assertion below, so the two cannot
 * drift — a hand-written list without one is what core#41 is. Do not "tidy" this
 * back into a spread; `tests/jsr-emit-safety.test.ts` fails if you do.
 */
const ITEM_TYPES = [
  "rental",
  "destination",
  "group",
  "replacement",
  "sale",
  "service",
  "surcharge",
  "transaction_fee",
  "order",
] as const;
/** Union of every order/invoice/fulfillment item type. */
export type ItemTypeType = typeof ITEM_TYPES[number];
/** Zod schema for {@link ItemTypeType}. */
export const ItemTypeEnum: z.ZodType<ItemTypeType> = z.enum(ITEM_TYPES);

// The derivation the list above replaces, asserted BOTH ways so the hand-written
// members and `DOC_ITEM_TYPES + "order"` are provably the same set. Adding a
// `DOC_ITEM_TYPES` member fails the first; inventing a member here fails the
// second. Same shape as `_lineParity` below — both compare two lists neither of
// which is typed on the other, which is what makes them capable of failing.
type _DerivedItemTypeType = DocItemTypeType | "order";
type _ItemTypesCoverDerived = Exclude<_DerivedItemTypeType, ItemTypeType> extends never ? true : never;
type _DerivedCoversItemTypes = Exclude<ItemTypeType, _DerivedItemTypeType> extends never ? true : never;
const _itemTypeParity: [_ItemTypesCoverDerived, _DerivedCoversItemTypes] = [true, true];
void _itemTypeParity;

// ── Item contracts ───────────────────────────────────────────────

/**
 * The per-type rules an `items[]` entry must satisfy, one entry per
 * {@link ITEM_TYPES} member. Modelled on `MOVEMENT_CONTRACTS` in
 * `schemas/transaction.ts`: a table the schema reads, so a contradiction is reported by
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
 *   taxed is `findTaxFor(catalog, jurisdiction, taxed_as ?? type, asOf)` — a
 *   property of WHERE the goods went as much as of the line, so it is not a
 *   type invariant. (This bullet named `tax_class` and `tax_profile` until
 *   2026-08-22; neither is a field any more.)
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
 * analogue of `checkMovementContract` in `schemas/transaction.ts`.
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
 *
 * ⚠️ **This function takes a STRUCTURAL BOUND, not a schema, so the compiler
 * cannot tell you when a field it reads has been renamed away.** During the
 * dollars→cents migration `price.replacement` became `price.replacement_cents`
 * everywhere; had the bound below not moved with it, `deno check` would have
 * stayed green while `item.price?.replacement` read `undefined` forever — the
 * `forbidden` arm permanently vacuous (a transaction_fee could carry a
 * replacement price) and the `required_when_stocked` arm firing on every
 * stocked rental. Any future rename of a field named here must edit this
 * signature; `tests/common.test.ts` pins both arms against a live shape so a
 * vacuous bound fails rather than passes.
 */
export function checkItemContract(
  item: {
    type: string;
    stock_method?: string | null;
    price?: { formula?: string; replacement_cents?: number | null } | null;
  },
  ctx: z.RefinementCtx,
): void {
  checkItemPriceFormula(item, ctx);
  const contract = itemContract(item.type);
  if (!contract) return;

  // Deliberately NOT gated on `price` being present: a rental with no price at
  // all cannot state a replacement value either, and the hand-written refine
  // this replaced rejected that case too (`item.price?.replacement_cents != null`).
  // Both callers require `price` outright now, so — as with `stock_method`
  // above — this is defence on a structural bound, not a reachable branch.
  if (
    contract.replacement === "required_when_stocked" &&
    item.stock_method !== "none" && item.price?.replacement_cents == null
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["price", "replacement_cents"],
      message: `price.replacement_cents is required for ${item.type} items`,
    });
  }
  if (contract.replacement === "forbidden" && item.price?.replacement_cents != null) {
    ctx.addIssue({
      code: "custom",
      path: ["price", "replacement_cents"],
      message: `"${item.type}" has no replacement value; price.replacement_cents must be absent`,
    });
  }
}

/**
 * The unit half of a line's price: which of `base_cents` / `base_percent` a
 * `formula` is allowed to carry.
 *
 * **This exists because `price.base` used to carry two units.** On a
 * `transaction_fee` line with `formula === "percent_of_total"`, `base` was a
 * *percentage* of the document's `subtotal_discounted`; on every other line it
 * was a per-unit dollar amount. One field, two units, discriminated only by a
 * sibling — so a reader that did not consult `formula` first multiplied a 2.9%
 * card fee as if it were $2.90, and integer cents would have made 2.9%
 * unrepresentable outright.
 *
 * The split puts the unit in the NAME: `base_cents` is money (integer cents),
 * `base_percent` is a percentage stored at 4dp — the quantum Xero's
 * `DiscountRate` holds, and deliberately NOT the `RATE_SCALE = 1_000_000n`
 * widening `utils/orders.ts` uses to *apply* a rate exactly. Conflating those
 * two would store six decimals Xero cannot carry.
 *
 * **The rule is exactly-one-of, in the only form a `.default(0)` leaves
 * checkable.** `base_cents` keeps its default, so it is materialized by the
 * parse before any object-level refinement runs and can never be observed
 * "absent" here; asserting it is *zero* on the fee arm is the same guarantee
 * against the same failure, and it is the half that can actually fail. The
 * `base_percent` half is asserted in both directions.
 */
export function checkPriceBaseUnit(
  price: {
    formula?: string;
    base_cents?: number;
    base_percent?: number | null;
  } | null | undefined,
  ctx: z.RefinementCtx,
): void {
  if (price == null) return;

  if (price.formula === "percent_of_total") {
    if (price.base_percent == null) {
      ctx.addIssue({
        code: "custom",
        path: ["base_percent"],
        message: `"percent_of_total" prices from a percentage of the document total; base_percent is required`,
      });
    }
    if (price.base_cents) {
      ctx.addIssue({
        code: "custom",
        path: ["base_cents"],
        message:
          `"percent_of_total" carries its rate in base_percent; base_cents must be 0, got ${price.base_cents}`,
      });
    }
    return;
  }

  if (price.base_percent != null) {
    ctx.addIssue({
      code: "custom",
      path: ["base_percent"],
      message:
        `base_percent is only meaningful on a "percent_of_total" price; this one is "${price.formula}"`,
    });
  }
}

// `ITEM_CONTRACTS`' totality over `ITEM_TYPES` is enforced by the
// `Readonly<Record<ItemTypeType, ItemContract>>` annotation at its declaration:
// an `ITEM_CONTRACTS_INNER` missing a member fails there. An
// `ItemTypeType extends keyof typeof ITEM_CONTRACTS` guard used to sit here
// claiming to be that check; the annotation fixes `keyof` to the union, so it
// read `T extends T` and could not fail. Verified by planting an unbacked
// `ITEM_TYPES` member: the annotation reddened, `_itemTypeParity` below
// reddened, that guard did not.

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
 * The {@link PreTaxItemType} members as a runtime enum — the vocabulary of
 * `Tax.item_types`, i.e. *which line types a tax covers*.
 *
 * 🔑 **`PreTaxItemType`, not {@link DocLineItemTypeType}, and the difference is
 * the whole point.** `transaction_fee` is `pricing: "from_total"`, and
 * `calculateItemTax` **throws** `Item is not priceable` on it. Typing the field
 * at the pre-tax subset makes *"a tax that covers transaction fees"*
 * unrepresentable rather than merely absent from a list, and keeps
 * {@link ITEM_CONTRACTS} the single author of what is priceable. The
 * `destination` / `group` dividers fall out for free.
 *
 * ⚠️ **Written out rather than derived, deliberately** — JSR's npm declaration
 * emit truncates a spread inside an `as const` array (core#43), so a
 * `[...X] as const` here would publish a different, wrong type to the manager
 * only. `_preTaxParity` below is the mechanism that keeps the hand-written list
 * honest, checked in BOTH directions.
 */
export const PRE_TAX_ITEM_TYPES = ["rental", "replacement", "sale", "service", "surcharge"] as const;
/** Zod schema for PreTaxItemType. @see {@link PRE_TAX_ITEM_TYPES} */
export const PreTaxItemTypeEnum: z.ZodType<PreTaxItemType> = z.enum(PRE_TAX_ITEM_TYPES);

type _PreTaxListed = typeof PRE_TAX_ITEM_TYPES[number];
type _PreTaxParity = [_PreTaxListed] extends [PreTaxItemType]
  ? [PreTaxItemType] extends [_PreTaxListed] ? true : never
  : never;
const _preTaxParity: _PreTaxParity = true;
void _preTaxParity;

/**
 * What a line is TAXED AS — the pre-tax types plus `"none"`.
 *
 * The value of `items[].taxed_as`, a per-line override of the type the tax
 * engine keys on. `null`/absent means *use `item.type`*; `"none"` means *this
 * line is untaxed regardless of what its type would attract*, which is the one
 * answer `item.type` cannot express without lying about what the line is.
 *
 * ⚠️ **It overrides the TYPE used for tax, never the tax itself.** There is
 * deliberately no per-line tax reference: a line naming its own tax uid is a
 * second copy of the catalog that drifts from the jurisdiction rule, which is
 * the api-cloudrun#409 class ($2,741.78 of phantom receivable) in miniature.
 *
 * Written out rather than spread for the same JSR-emit reason as
 * {@link PRE_TAX_ITEM_TYPES}; `_taxedAsParity` pins it.
 */
const TAXED_AS = ["rental", "replacement", "sale", "service", "surcharge", "none"] as const;
/** Allowed values for a line's tax-type override. */
export type TaxedAsType = typeof TAXED_AS[number];
/** Zod schema for TaxedAsType. */
export const TaxedAsEnum: z.ZodType<TaxedAsType> = z.enum(TAXED_AS);

type _TaxedAsListed = Exclude<TaxedAsType, "none">;
type _TaxedAsParity = [_TaxedAsListed] extends [PreTaxItemType]
  ? [PreTaxItemType] extends [_TaxedAsListed] ? true : never
  : never;
const _taxedAsParity: _TaxedAsParity = true;
void _taxedAsParity;

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

// ── Settlements ──────────────────────────────────────────────────
//
// The vocabulary of the `settlements` journal — the revenue-side twin of the
// `transactions` movement journal. It lives in `schemas/common.ts` rather than in
// `settlement.ts` because `credit-notes` shares the reason enum: one credit
// note allocated across three invoices has ONE reason, denormalized onto each
// settlement, and authoring it three times invites three answers.

/**
 * SIX members, in three do/undo pairs.
 *
 * The reversal arms are their own **types**, exactly as `MOVEMENT_TYPES` carries
 * `sale` and `sale_return` rather than a second `kind` field. That is what lets
 * the totals be a plain signed fold over *every* row: a do/undo pair nets to
 * zero arithmetically rather than by being filtered out, so an invoice can do
 * and undo perpetually with correct totals after each append, and there is no
 * liveness derivation to get wrong.
 *
 * **`void` is a settlement, and that is the whole of api-cloudrun#436.** A void
 * annuls what is owed, so it settles the invoice exactly as cash or a credit
 * note does — Xero reports `AmountDue: 0` and is right. It used to be modelled
 * as a *field override*: `amount_due_cents` was assigned 0 while the journal
 * still folded to `total`, which meant the schema's identity refine had to
 * exempt void invoices, `audit-settlement-totals.ts` had to skip them, and
 * `repair-invoice-settlement-totals.ts` had to refuse them. Three carve-outs, and
 * between them they made the class **invisible**: a void invoice whose balance
 * was never zeroed was indistinguishable from one correctly overridden, and 7
 * prod invoices sat that way. As a journal row the fold produces the 0 on its
 * own and every carve-out is deleted.
 */
const SETTLEMENT_TYPES = [
  "payment",
  "payment_reversal",
  "credit",
  "credit_reversal",
  "void",
  "void_reversal",
] as const;
/** One settlement event's kind. @see {@link SETTLEMENT_CONTRACTS} */
export type SettlementTypeType = typeof SETTLEMENT_TYPES[number];
/** Zod schema for SettlementTypeType. */
export const SettlementTypeEnum: z.ZodType<SettlementTypeType> = z.enum(SETTLEMENT_TYPES);

/**
 * Why a settlement happened. **Closed by design**, and the one thing here that
 * is expensive to change later: it becomes a 16-bit `code` when CFS owns its
 * ledger, and a taxonomy that started as prose cannot be mechanically ported.
 * Widening is additive and free; *re-meaning* a member after history carries it
 * is not.
 *
 * **Xero's `Reference` is a description, not a reason — never auto-map from
 * it.** Deriving `reason` from the reference string was proposed and rejected on
 * the evidence: CN-1013 reads *"L&D Refund"* but is economically an adjustment
 * down, and CN-1017 reads *"Tables & Racks"* — which names the items credited
 * while the actual reason was an early return. The string says *what* was
 * credited; the enum records *why*. A plausible-looking auto-map would write
 * eight wrong reasons indistinguishable from correct ones, so the backfill
 * writes `unspecified` and an operator classifies the eight by hand.
 *
 * `damage_settlement` was drafted and dropped before shipping: if L&D refunds
 * are adjustments, it described nothing. A member that describes nothing is easy
 * to drop *before* history uses it and impossible after.
 */
const SETTLEMENT_REASONS = [
  /** payment — cash received against the invoice. */
  "payment_received",
  /** credit — uncollectible, written off (#1301, #1981). */
  "bad_debt",
  /** credit — a rental came back early (CN-1015). */
  "early_return",
  /** credit — the billed amount was corrected after the fact (CN-1013, CN-1016). */
  "order_adjustment",
  /** credit — discretionary. */
  "goodwill",
  /**
   * void — the invoice was annulled, so nothing is owed on it.
   *
   * **Deliberately NOT `source_retracted`.** That member means "the originating
   * system no longer reports it" — the reap, where CFS holds a row Xero has
   * stopped listing. A void is the opposite kind of fact: the invoice is
   * reported, and reported as annulled. Re-meaning an existing member after
   * history carries it is the one change this enum's docblock calls expensive;
   * widening is additive and free.
   */
  "invoice_voided",
  /** reversal — the originating system no longer reports it (the reap). */
  "source_retracted",
  /** any — an operator fixing their own record. */
  "correction",
  /** backfilled history only — never written by new code. */
  "unspecified",
] as const;
/** Why a settlement happened. @see {@link SETTLEMENT_CONTRACTS} */
export type SettlementReasonType = typeof SETTLEMENT_REASONS[number];
/** Zod schema for SettlementReasonType. */
export const SettlementReasonEnum: z.ZodType<SettlementReasonType> = z.enum(SETTLEMENT_REASONS);

/** How one settlement type may be filled. @see {@link SETTLEMENT_CONTRACTS} */
export interface SettlementContract {
  /** Which reasons are legal for this type. */
  reasons: readonly SettlementReasonType[];
  /** Which external-id field this type may carry; `null` ⇒ neither. */
  xero_id_field: "xero_payment_id" | "xero_credit_note_id" | null;
  /**
   * Which invoice total this type feeds — **the storage key, deliberately, not
   * the semantic name.**
   *
   * The `_cents` suffix is not decoration that drifted in from the migration:
   * these literals must keep matching a real field on `InvoiceDocTotals`, and
   * "renaming them back to the semantic name" is precisely how a literal comes
   * to name a field that no longer exists. Verified when the suffix landed —
   * every consumer compares this as a literal (`=== "amount_paid_cents"`) and
   * nothing indexes `totals[sums_into]` anywhere, so a half-done rename is
   * TS2367 at each site rather than a silent runtime mis-route.
   *
   * ⚠️ **THREE buckets, and a two-way test on this field is now wrong.** Both
   * consumers were written when there were two, as `=== "amount_paid_cents"`
   * with an implicit `else` meaning "credited" — so adding a third member
   * silently routed every `void` row into `amount_credited_cents`. Neither
   * would have failed to compile. Any new reader must handle all three
   * explicitly and fail loudly on an unrecognized one.
   */
  sums_into: "amount_paid_cents" | "amount_credited_cents" | "amount_void_cents";
  /** Whether `reverses` must or must not be set. */
  reverses: "required" | "forbidden";
}

/**
 * The per-type settlement contract, one entry per {@link SETTLEMENT_TYPES}
 * member — a table the schema reads, so a contradiction is reported by the
 * schema instead of restated in every consumer.
 *
 * `sums_into` is load-bearing rather than documentation: `calculateInvoiceTotals`
 * takes its settlement argument structurally, so without a declared target a
 * credit row would be silently summed into `amount_paid`. Reading the target
 * from the table removes that class entirely.
 *
 * A reversal carries **no** external id. The reap appends a reverser because
 * Xero stopped reporting a payment — the reverser is a CFS event with no Xero
 * counterpart, and the id it retracts is still on the row `reverses` names.
 */
export const SETTLEMENT_CONTRACTS: Readonly<Record<SettlementTypeType, SettlementContract>> = {
  payment: {
    reasons: ["payment_received", "correction", "unspecified"],
    xero_id_field: "xero_payment_id",
    sums_into: "amount_paid_cents",
    reverses: "forbidden",
  },
  payment_reversal: {
    reasons: ["source_retracted", "correction", "unspecified"],
    xero_id_field: null,
    sums_into: "amount_paid_cents",
    reverses: "required",
  },
  credit: {
    reasons: [
      "bad_debt",
      "early_return",
      "order_adjustment",
      "goodwill",
      "correction",
      "unspecified",
    ],
    xero_id_field: "xero_credit_note_id",
    sums_into: "amount_credited_cents",
    reverses: "forbidden",
  },
  credit_reversal: {
    reasons: ["source_retracted", "correction", "unspecified"],
    xero_id_field: null,
    sums_into: "amount_credited_cents",
    reverses: "required",
  },
  // A void carries no external id even though Xero is usually where it
  // originates: Xero annuls the INVOICE, not a settlement, so there is no Xero
  // payment or credit-note object for this row to name. The invoice's own
  // `xero_id` is the linkage, and it is already stored.
  void: {
    reasons: ["invoice_voided", "correction", "unspecified"],
    xero_id_field: null,
    sums_into: "amount_void_cents",
    reverses: "forbidden",
  },
  // Un-voiding is a real operation — a Xero void can be reversed by re-issuing,
  // and an operator can void by mistake. Pairing the arm is what keeps
  // `amount_void_cents` a fold rather than a latch: without it the only way back
  // would be to edit or delete the `void` row, and the journal is append-only.
  void_reversal: {
    reasons: ["source_retracted", "correction", "unspecified"],
    xero_id_field: null,
    sums_into: "amount_void_cents",
    reverses: "required",
  },
};

/**
 * The contract for a settlement `type`, or `undefined` for a value outside
 * {@link SETTLEMENT_TYPES}. Tolerant of a `string` for the same reason
 * {@link itemContract} is — callers hold types from loosely-typed sources.
 */
export function settlementContract(type: string): SettlementContract | undefined {
  return SETTLEMENT_CONTRACTS[type as SettlementTypeType];
}

/**
 * `+1` for a settlement that increases the total it feeds, `-1` for one that
 * reduces it.
 *
 * **Derived from the contract, never declared**, exactly as
 * `getTransactionMultiplier` derives from `places` rather than carrying a ±1
 * column: a type that must name what it reverses IS a retraction, and one that
 * must not IS an application. Two facts that could disagree become one that
 * cannot.
 *
 * **The sign keys on `type`, not on `reason`.** The package answers this the
 * same way three times over — `getTransactionMultiplier(type)`, and
 * `out_of_service_breakdown[o.reason]` where reason is a *breakdown dimension*
 * rather than a direction. It is also forced here: `correction` is genuinely
 * bidirectional (an operator may be adding a payment they missed or removing one
 * that never happened), so a reason-keyed sign would have to split it into
 * `correction_added`/`correction_removed`, and every other bidirectional reason
 * after it. Type carries direction, reason carries why, and the contract's
 * `reasons` list keeps the pairs legal.
 */
export function getSettlementMultiplier(type: SettlementTypeType): 1 | -1 {
  return SETTLEMENT_CONTRACTS[type].reverses === "required" ? -1 : 1;
}

// A type list and a contract table are two hand-written lists of the same names;
// this makes a gap between them a compile error rather than a runtime hole —
// the drift core#41 is.
type _SettlementContractsCoverTypes = SettlementTypeType extends keyof typeof SETTLEMENT_CONTRACTS
  ? true
  : never;
const _settlementContractParity: _SettlementContractsCoverTypes = true;
void _settlementContractParity;

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
  name: z.string().meta({ column: true }),
  quantity: z.number().min(0).meta({ column: true, label: "Quantity" }), // physical shelf count — can't go negative
  default: z.boolean(),
  max: z.number().nullable(),
});

/** Zod schema for StoreBreakdownEntry. */
export const StoreBreakdownEntrySchema: z.ZodType<StoreBreakdownEntry> = z.strictObject({
  uid_store: FirestoreId,
  name: z.string().meta({ column: true }),
  default: z.boolean(),
  crms_stock_level_id: z.int().nullable(),
  quantity: z.number().min(0).meta({ column: true, label: "Quantity" }), // Σ of this store's location quantities — can't go negative
  locations: z.array(StoreBreakdownLocationSchema).default([]).meta({ label: "Location" }),
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
  city: z.string().default("").meta({ pii: "none", column: true, label: "City" }),
  country_name: z.string().default("").meta({ pii: "none" }),
  // The whole-address column. Labelled once here and prefixed by whatever key
  // holds the address, so `destinations[].delivery.address.full` reads "Delivery
  // Address" and `destinations[].collection.address.full` reads "Collection
  // Address" without forking the schema — `.meta()` on the two *legs* clones,
  // this shared node does not.
  full: z.string().default("").meta({ column: true, label: "Address" }),
  name: z.string().max(100).default(""),
  postcode: z.string().default(""),
  // Canonicalized to the two-letter USPS code on parse — see `_usState.ts` for
  // why this normalizes rather than validates, and for the caveat that a
  // document-schema transform does NOT rewrite what `validateBeforeWrite`
  // stores.
  region: usState().default("").meta({ pii: "none", column: true, label: "State" }),
  street: z.string().default(""),
  street2: z.string().default("").optional(),
  mapbox_id: z.string().default("").optional(),
  address_coordinates: Coordinates.optional(),
  user_coordinates: Coordinates.optional(),
}).nullable().meta({
  pii: "mask",
});

// ── Document organization snapshot ──────────────────────────────────

/** The customer-organization snapshot embedded on an order/invoice/credit note. */
export interface DocumentOrganizationSnapshotType {
  uid: string | null;
  name: string;
  crms_id?: number | null;
  /**
   * Level 2 of the jurisdiction precedence — the customer's standing claim,
   * mirrored from {@link Organization.jurisdiction_claim}.
   *
   * ⚠️ **This is the SNAPSHOT half of the pair that replaces `tax_profile`,
   * and it is optional for the same reason `tax_profile` was** — the expand
   * third of expand/migrate/contract. Every snapshot is a `z.strictObject` and
   * every write path validates the whole document, so the old and new schemas
   * have disjoint accepted sets: a required field here rejects every stored
   * document that predates it, and no deploy order closes that window.
   *
   * ⚠️ **Absent and `null` are NOT the same fact during the migration, and
   * that is only true because the BUILDER never emits absent.**
   * {@link buildOrganizationSnapshot} writes `?? null`, so from this publish
   * onward absent can only mean *"this snapshot predates the axes — read
   * `tax_profile`"*, while `null` means *"the customer asserts no
   * jurisdiction"* and asks the next level. `documentTaxContext`
   * (api-cloudrun) is the one place that distinguishes them, and the fallback
   * arm is deleted when the corpus is migrated.
   *
   * The `?? null` is lossless rather than a flattening, and that is measured
   * rather than assumed: on prod 2026-08-21 the 291 organizations split 277
   * `tax_applied` / 11 `tax_exempt` / 3 location profiles, and the axes line up
   * exactly — the same 11 carry `tax_exempt: true`, the same 3 carry a
   * matching `jurisdiction_claim` (Kenwood frankfort, Simeon and Waterloo West
   * rantoul), and the 277 carry NEITHER. So on the organization there is no
   * "unknown" state for `?? null` to destroy: absent already means *asserts
   * nothing*.
   */
  jurisdiction_claim?: JurisdictionType | null;
  /**
   * The customer's exemption, mirrored from {@link Organization.tax_exempt} —
   * the half `tax_profile` welds to jurisdiction and cannot separate.
   *
   * ⚠️ **Sticky from either side**: `org.tax_exempt || doc.tax_exempt === true`,
   * never `doc ?? org`. A `false` on the document must not un-exempt an exempt
   * customer.
   */
  tax_exempt?: boolean;
  xero_id: string | null;
  billing_address?: AddressType | null;
}

/**
 * The customer-organization snapshot embedded on an order, an invoice and a
 * credit note.
 *
 * **One schema, because four hand-maintained near-identical literals is what
 * caused api-cloudrun#486.** The order's copy was one field short of the
 * invoice's — it carried no `tax_profile` — so nothing on the order write path
 * could see that a customer was tax-exempt, and `repriceOrderItemsForProfile`
 * passed a hardcoded `"tax_applied"` into `materializeDocumentTax` because
 * there was nothing else to pass. A tax-exempt customer's *invoices* were
 * untaxed and their *orders* were taxed, and only CRMS stamping
 * `order.tax_profile` from the opportunity header hid it.
 *
 * ⚠️ **Sharing the schema pins WHERE the snapshot is built, not WHAT it holds**
 * — the Ratchet-G lesson in the workspace CLAUDE.md (untracked and
 * machine-local, api-cloudrun#530), where a single allowed
 * renderer of the money `_str` mirror was singular and wrong for five months.
 * The value assertion that sits beside this is api-cloudrun's writer-parity
 * test: one order created natively and one created through the CRMS opportunity
 * path, same commercial facts, must produce byte-identical `organization`
 * blocks.
 *
 * The two fields where the three schemas disagreed take the **union**, not
 * either side: merging to one alone retroactively makes existing documents of
 * the other unwritable.
 *
 * - `billing_address` — the order had it `.optional()`, the invoice and credit
 *   note required (and prod invoices store an explicit `null`). {@link Address}
 *   is already `.nullable()`, so `.optional()` is the union of the three.
 * - `name` — the order bounded it `[1, 100]`, the other two did not. Bounded
 *   wins here and is *not* a tightening in practice: every snapshot is copied
 *   from `Organization.name`, which carries the same bounds, and prod holds no
 *   invoice or credit note with an empty one (measured 2026-08-11).
 */
export const DocumentOrganizationSnapshot: z.ZodType<DocumentOrganizationSnapshotType> = z
  .strictObject({
    uid: FirestoreId.nullable(),
    // No `label` — the heading is the "Organization" carried by the key above.
    name: z.string().min(1).max(100).meta({ pii: "mask", column: true }),
    crms_id: z.int().nullable().optional(),
    // REQUIRED as of api-cloudrun#489 — the contract third of
    // expand/migrate/contract, and the reason it took three steps is worth
    // keeping: it could not land required in the publish that started writing
    // it. Every write path validates the FULL document (`validatedSet` inside
    // `runInstrumentedTransaction`) and every one of these snapshots is a
    // `z.strictObject`, so the two schema versions have disjoint accepted sets —
    // the old one REJECTS a document carrying `tax_profile`, a required new one
    // REJECTS the 981 prod orders that lacked it. No deploy order avoids a
    // window of failing order writes, including the CRMS opportunity webhook,
    // whose failures are silent drops.
    //
    // Gate, re-measured immediately before this landed (2026-08-11):
    // `audit-order-tax-snapshot.ts` category A = 0 in BOTH environments — prod
    // 0 of 984, dev 0 of 984 after a re-run of the backfill, which had been
    // clobbered back to 2 by the prod→dev mirror.
    // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
    // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
    // were forced, not ceremonial: every write validates the FULL document and
    // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
    // every stored document still carrying it. Optional → empty storage →
    // delete. (#489 made the same field REQUIRED by the mirror-image dance, and
    // its comment is the reason this one was safe.)
    // The pair that RETIRES `tax_profile` (api-cloudrun#596 item 1). Optional
    // through the expand step, for the disjoint-accepted-sets reason above —
    // the same three-step dance `tax_profile` itself needed, and the reason
    // this schema's own history is worth keeping in view.
    jurisdiction_claim: JurisdictionEnum.nullable().optional().meta({
      column: true,
      label: "Jurisdiction Claim",
    }),
    tax_exempt: z.boolean().optional().meta({ column: true, label: "Tax Exempt" }),
    xero_id: z.uuid().nullable(),
    billing_address: Address.optional(),
  })
  .meta({ label: "Organization" });

// `DEFAULT_TAX_PROFILE` was DELETED here (api-cloudrun#596 item 3). It was the
// profile to assume when no organization profile was in hand — a default that
// existed because the enum had no way to say "this customer asserts nothing"
// other than by naming the ordinary case. The axes say it directly: an absent
// `jurisdiction_claim` IS "asks the next level", and an absent `tax_exempt` IS
// "not exempt", so there is no default left to centralise.
