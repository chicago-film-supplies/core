/**
 * Product document schema — Firestore collection: products
 */
import { z } from "zod";
import { FirestoreId, ThreadId } from "./_uid.ts";
import { chicagoInstant } from "./_datetime.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import { MovementAllocationInput, type MovementAllocationInputType } from "./transaction.ts";
import {
  ActorRef,
  type ActorRefType,
  COARevenueEnum,
  type COARevenueType,
  ComponentTypeEnum,
  type ComponentTypeType,
  type FirestoreTimestampType,
  checkItemContract,
  InclusionTypeEnum,
  type InclusionTypeType,
  PriceFormulaEnum,
  type PriceFormulaType,
  ProductTypeEnum,
  type ProductTypeType,
  StockMethodEnum,
  type StockMethodType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import { TaxRef, type TaxRefType } from "./order.ts";

/** An alternate product reference. */
export interface ProductAlternate {
  uid: string;
  name: string;
}

/**
 * A product reference in `component_of` — the RECIPROCAL back-reference naming a
 * parent this product is a component of.
 *
 * Deliberately the reduced shape: the relationship attributes
 * (`inclusion_type`, `zero_priced`, `active`, `description`) describe how the
 * PARENT includes this product and are authored on the parent's own
 * `components` entry, which is the authoritative side. Prod agrees — across 141
 * `component_of` rows on 91 products, exactly one carries any of them
 * (measured 2026-07-29), against 165/165 on `components`.
 *
 * @see {@link AuthoredProductComponent} for the authored side.
 */
export interface ProductComponent {
  uid: string;
  path: string[];
  name: string;
  active?: boolean;
  type: ComponentTypeType;
  stock_method: StockMethodType;
  crms_id: number | null;
  crms_accessory_id?: number | null;
  description?: string;
  inclusion_type?: InclusionTypeType;
  quantity: number;
  zero_priced?: boolean;
  price: {
    base_cents: number;
    replacement_cents?: number | null;
    coa_revenue?: COARevenueType;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
}

/**
 * A component product within a parent product — the entry in `components`.
 *
 * Identical to {@link ProductComponent} except that `inclusion_type` is
 * **required**, and that difference is the point. Both expanders
 * (`buildOrderComponentLines` in manager, and the staged-add path) filter
 * `=== "mandatory" || === "default"`, so an `undefined` here is a silent fourth
 * bucket whose component is dropped from every order it should have joined.
 *
 * The optionality it replaces existed to accommodate `component_of`, where the
 * field genuinely is not authored — and it leaked onto the authored side, where
 * it is a bug. Splitting the two is what lets this side be required. Prod
 * carries 0 undefined rows across 165 `components` entries on 63 products, so
 * this is hardening with a zero-row backfill; writers with no answer pass
 * `"default"`, the reading `crmsProduct.ts` and manager's new-component form
 * already take.
 *
 * NOT expressed as `.default("default")`: `validateBeforeWrite` validates but
 * writes the RAW doc, so a schema default never materializes and the field would
 * still be written absent.
 */
export interface AuthoredProductComponent extends ProductComponent {
  inclusion_type: InclusionTypeType;
}

/** Pricing details for a product. */
export interface ProductPrice {
  base_cents: number;
  replacement_cents?: number | null;
  coa_revenue?: COARevenueType;
  taxes: TaxRefType[];
  formula: PriceFormulaType;
  discountable: boolean;
}

/**
 * Shipping dimensions and hazard classification for a product.
 *
 * The four dimensions are nullable: `null` is "not measured yet", which `0`
 * could not express. See the storage schema for why the distinction is
 * load-bearing (core#51).
 */
export interface ProductShipping {
  weight: number | null;
  height: number | null;
  width: number | null;
  length: number | null;
  air_hazardous: boolean;
  air_un: number | null;
}

/** Webshop availability and description for a product. */
export interface ProductWebshop {
  available: boolean;
  description?: string | null;
}

/**
 * One product photo. Array order is display order and `images[0]` is the
 * primary image — there is deliberately no `sort` or `is_primary` field, so
 * there is only one thing to disagree with.
 *
 * Row identity is `uuid`, the original upload. It never changes (background
 * removal is additive: it fills `uuid_cutout` and leaves the original intact),
 * so it is the value `DELETE|PATCH /products/{uid}/images/{image_id}` carries.
 * That is why this array member has no `crypto.randomUUID()` `uid` — the
 * convention exists for members with no natural key, and this one has one.
 *
 * Display rule everywhere: `img.uuid_cutout ?? img.uuid`.
 */
export interface ProductImage {
  /** The original upload — immutable row identity, never deleted while the row lives. */
  uuid: string;
  /** The transparent-PNG cutout. `null` until background removal has run. */
  uuid_cutout: string | null;
  /** Alt text for SEO + WCAG. Per-image by nature ("front view" vs "rear I/O panel"). */
  alt: string | null;
  /** Intrinsic width in px, captured client-side at upload — prevents layout shift (CLS). */
  width: number | null;
  /** Intrinsic height in px. A cutout has the same dimensions as its original. */
  height: number | null;
}

/**
 * Derive `query_by_images` from `images` — each row's `uuid` followed by its
 * `uuid_cutout` when set, walking `images` in order.
 *
 * The single source of the denormalization, called by every writer. Defined here
 * rather than in `utils/products.ts` because the schema needs it and the import
 * direction is strictly utils → schemas; `@cfs/core/utils/products` re-exports
 * it, which is where writers should import from (same shape as `deriveName`).
 *
 * **Ordered, but not an ordering source.** The emitted array follows `images`
 * row order — it costs nothing (one pass either way) and a mirror that tracks
 * the display array is easier to eyeball in the console than an arbitrary one.
 * But `images` remains the sole authority on display order: this field exists
 * for Firestore `array-contains`, and the refinement below compares it as a
 * multiset, so a differently-ordered mirror holding the same uuids is still
 * valid. Nothing may read order back out of it.
 */
export function deriveProductImageUuids(
  images: readonly { uuid: string; uuid_cutout: string | null }[] | undefined,
): string[] {
  if (!images) return [];
  const uuids: string[] = [];
  for (const img of images) {
    uuids.push(img.uuid);
    if (img.uuid_cutout) uuids.push(img.uuid_cutout);
  }
  return uuids;
}

/** A product document in the products Firestore collection. */
export interface Product {
  uid: string;
  name: string;
  active: boolean;
  type: ProductTypeType;
  stock_method: StockMethodType;
  component_only: boolean;
  crms_id: number | null;
  crms_rate_id?: number | null;
  crms_stock_level_ids?: Record<string, number>;
  crms_linked_rental_id?: number | null;
  crms_linked_replacement_id?: number | null;
  crms_linked_replacement_rate_id?: number | null;
  description?: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: ProductPrice;
  shipping?: ProductShipping;
  alternates: ProductAlternate[];
  components: AuthoredProductComponent[];
  component_of: ProductComponent[];
  tags: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  tracking_category_name?: string;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  uid_tracking_category?: string | null;
  webshop: ProductWebshop;
  images?: ProductImage[];
  /**
   * Flat mirror of every uuid in `images` — originals and cutouts — existing
   * solely to make Firestore `array-contains` possible. Carries no ordering
   * meaning: `images` is the authority on display order.
   */
  query_by_images?: string[];
  xero_id: string | null;
  /**
   * The Xero Item `Code` of the Item that `xero_id` points at — i.e. the
   * identifier we must send as a line's `ItemCode`. Kept alongside `xero_id`
   * (the Xero `ItemID`) because Xero's document validator resolves lines by
   * Code, not by ItemID, and the two are independent: an Item can be renamed
   * or re-coded without its ItemID changing.
   *
   * Historically the push paths emitted `crms_id` as the `ItemCode` on the
   * assumption `Code == crms_id`. That convention has three defect classes in
   * the live catalog (suffix-renamed codes, duplicated codes, and codes with
   * no Item), so it is not load-bearing. Populated by `xeroItemCreateUpdate`
   * from the Xero response. `null` when the product has never been pushed to
   * Xero — in which case no `ItemCode` may be emitted at all.
   */
  xero_code?: string | null;
  xero_tracking_option_id: string | null;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const ComponentObject = z.strictObject({
  uid: FirestoreId,
  path: z.array(z.string()),
  // Links to the component's OWN product page, not the row's — `TableCell`
  // reads the uid off the entry the value came from.
  name: z.string().meta({ column: true, linkTo: "productDetail" }),
  active: z.boolean().optional(),
  type: ComponentTypeEnum,
  stock_method: StockMethodEnum,
  crms_id: z.int().nullable(),
  crms_accessory_id: z.int().nullable().optional(),
  description: z.string().optional(),
  inclusion_type: InclusionTypeEnum.optional(),
  quantity: z.number(),
  zero_priced: z.boolean().optional(),
  price: z.strictObject({
    base_cents: z.int(),
    replacement_cents: z.int().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]).meta({ label: "Tax" }),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }),
});

/**
 * Schema for a `component_of` back-reference. `inclusion_type` is optional here
 * because the parent authors it — see {@link ProductComponent}.
 *
 * A catalog component is a line item in waiting: `COMPONENT_TYPES` is a subset
 * of `DOC_LINE_ITEM_TYPES` (pinned by a compile-time assertion in `schemas/common.ts`),
 * and every component that survives expansion becomes an order line of the same
 * `type`. So it answers to the same contract, and the rental ⇒
 * `price.replacement_cents` rule is stated once rather than a third time here.
 */
export const ComponentSchema: z.ZodType<ProductComponent> = ComponentObject
  .superRefine(checkItemContract);

/**
 * Schema for an authored `components` entry — {@link ComponentSchema} with
 * `inclusion_type` required.
 *
 * **Storage only.** `CreateProductInput` / `UpdateProductInput` deliberately keep
 * `ComponentSchema`, so a client may omit `inclusion_type` and the WRITER fills
 * `"default"` — the reading `crmsProduct.ts` and manager's new-component form
 * already take. Requiring it at the boundary instead would 400 any client that
 * has not been rebuilt, and manager is pinned several betas back on purpose
 * (manager#265). Normalize at the writer, guard at storage: no undefined can
 * reach a stored document either way, which is what the expanders need.
 *
 * @see {@link AuthoredProductComponent}
 */
export const AuthoredComponentSchema: z.ZodType<AuthoredProductComponent> = ComponentObject
  .extend({ inclusion_type: InclusionTypeEnum })
  .superRefine(checkItemContract);

/** Zod schema for a Product document. */
export const ProductSchema: z.ZodType<Product> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(200).meta({ column: true, label: "Name", linkTo: "productDetail" }),
  // `.meta({ initial })` rather than `.default()`, here and on the two
  // `eligible_*` booleans below: the Typesense config declares these required,
  // and a `.default()` never materializes on a write (`validateBeforeWrite`
  // persists the RAW doc), so a writer that omitted one produced a document
  // that could never index. Required forces the writer to be explicit; the
  // annotation keeps `getInitialValues` seeding the create form `true`, which
  // the type-derived zero (`false`) would not.
  active: z.boolean().meta({ initial: true, column: true, label: "Active" }),
  type: ProductTypeEnum.meta({ column: true, label: "Type" }),
  stock_method: StockMethodEnum.meta({ column: true, label: "Stock Method" }),
  component_only: z.boolean().meta({ column: true, label: "Component Only" }),
  // Every `crms_*` here is a Rails row id, so `z.int()` — the densest cluster of
  // the rule, and the one that names the trap. `crms_rate_id` and
  // `crms_linked_replacement_rate_id` contain "rate" and are **not rates**: a
  // sweep keyed on the name would 4dp them, and the same sweep run backwards
  // would integer-ize `Discount.rate` and `cost.unit_cost`, which are. The rule
  // is about what the field IS, and it is checked structurally by
  // `tests/typesenseFieldCoverage.test.ts` rather than by name.
  crms_id: z.int().nullable(),
  crms_rate_id: z.int().nullable().optional(),
  crms_stock_level_ids: z.record(z.string(), z.int()).optional(),
  crms_linked_rental_id: z.int().nullable().optional(),
  crms_linked_replacement_id: z.int().nullable().optional(),
  crms_linked_replacement_rate_id: z.int().nullable().optional(),
  description: z.string().optional().meta({ column: true, label: "Description" }),
  eligible_delivery: z.boolean().meta({ initial: true, column: true, label: "Delivery Eligible" }),
  eligible_in_store_pickup: z.boolean().meta({ initial: true, column: true, label: "Pickup Eligible" }),
  eligible_shipping_ground: z.boolean().meta({ column: true, label: "Ground Eligible" }),
  eligible_shipping_air: z.boolean().meta({ column: true, label: "Air Eligible" }),
  price: z.strictObject({
    base_cents: z.int().meta({ column: true, label: "Price" }),
    replacement_cents: z.int().nullable().optional().meta({ column: true, label: "Replacement Price" }),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]).meta({ label: "Tax" }),
    formula: PriceFormulaEnum.meta({ column: true, label: "Price Formula" }),
    discountable: z.boolean().default(true).meta({ column: true, label: "Discountable" }),
  }),
  // The four dimensions are NULLABLE because `0` means two different things —
  // "weighs nothing" and "nobody has weighed it" — and the corpus is entirely
  // the second: 0 of 549 prod products carried a value > 0 when this was
  // measured (core#51, 2026-08-10). Once specs are populated, a remaining `0`
  // becomes permanently ambiguous and the information to disambiguate it is
  // gone, so the window for this change closes when data entry starts.
  //
  // Per-field, not a block-level `measured_at`: the four are populated
  // independently and `measured_at` cannot express "weighed but not measured
  // for size". The two are not exclusive — provenance can be added later.
  //
  // Safe for the search index: Typesense declares these `float, optional: true`
  // and ACCEPTS an explicit `null`, dropping the key rather than rejecting the
  // document — verified on dev Typesense 30.2, 2026-08-10, on both the
  // single-document and bulk-import paths. Neither the type nor the optionality
  // changes, so no reindex is forced.
  shipping: z.strictObject({
    weight: z.number().nullable().meta({ column: true, label: "Weight" }),
    height: z.number().nullable().meta({ column: true, label: "Height" }),
    width: z.number().nullable().meta({ column: true, label: "Width" }),
    length: z.number().nullable().meta({ column: true, label: "Length" }),
    air_hazardous: z.boolean().meta({ column: true, label: "Air Hazardous" }),
    air_un: z.number().nullable().meta({ column: true, label: "UN Number" }),
  }).optional(),
  alternates: z.array(UidNameRef).default([]).meta({ label: "Alternates" }),
  components: z.array(AuthoredComponentSchema).default([]).meta({ label: "Components" }),
  component_of: z.array(ComponentSchema).default([]).meta({ label: "Component Of" }),
  tags: z.array(UidNameRef).default([]).meta({ label: "Tags" }),
  query_by_tags: z.array(z.string()).default([]).optional(),
  query_by_components: z.array(z.string()).default([]).optional(),
  query_by_component_of: z.array(z.string()).default([]).optional(),
  query_by_alternates: z.array(z.string()).default([]).optional(),
  tracking_category_name: z.string().optional().meta({ column: true, label: "Tracking Category" }),
  uid_linked_rental: FirestoreId.nullable().optional(),
  uid_linked_replacement: FirestoreId.nullable().optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
  webshop: z.strictObject({
    available: z.boolean().default(false).meta({ column: true, label: "Available" }),
    description: z.string().nullable().optional().meta({ column: true, label: "Description" }),
  }).meta({ label: "Webshop" }),
  // Ordered display list; `images[0]` is the primary image. Every member field
  // is required-but-nullable on purpose: `validateBeforeWrite` writes the RAW
  // doc, so a schema `.default()` never materializes and a writer that omits a
  // field would persist it as absent. Making them required forces the writer to
  // be explicit. The annotation wraps the `.nullable()` (invoice.ts:315's form)
  // — a tag on the outside of a `.nullable()` has silently gone unseen here.
  images: z.array(z.strictObject({
    uuid: uploadcareRef(z.string()),
    uuid_cutout: uploadcareRef(z.string().nullable()),
    alt: z.string().max(300).nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
  })).optional(),
  // No `.default([])`, unlike its `query_by_*` siblings above. A default is
  // applied during parse, so it would turn "writer omitted the mirror" into
  // "writer sent an empty mirror" and the refinement below could no longer tell
  // an untouched legacy doc from a drifted write.
  query_by_images: z.array(uploadcareRef(z.string())).optional(),
  xero_id: z.uuid().nullable(),
  // Optional (not `.nullable()`-required) so the ~531 existing product docs
  // validate unchanged before the backfill lands.
  xero_code: z.string().min(1).nullable().optional(),
  xero_tracking_option_id: z.uuid().nullable(),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).refine(
  (p) => p.type !== "rental" || p.stock_method === "none" || p.price.replacement_cents != null,
  {
    message: "price.replacement_cents is required for rental products",
    path: ["price", "replacement_cents"],
  },
).refine(
  (p) => {
    // Skip only when BOTH are absent — that is the ~531 pre-images product
    // docs, which must keep validating unchanged. One side present without the
    // other is precisely the drift this exists to reject, so it is compared
    // (against `[]`), not waved through. `validateBeforeWrite` validates the
    // merged doc, so a legitimate patch always presents both.
    if (p.images === undefined && p.query_by_images === undefined) return true;
    // Multiset comparison, NOT element-wise: `query_by_images` is an
    // `array-contains` index and carries no ordering meaning — `images` is the
    // sole authority on display order. Requiring a specific order here would
    // reject a writer that emitted the same uuids in a different but equally
    // correct arrangement, and would quietly imply the mirror ordered something.
    // Length is compared too, so a duplicate cannot hide behind a matching set.
    const derived = deriveProductImageUuids(p.images).sort();
    const mirror = [...(p.query_by_images ?? [])].sort();
    return mirror.length === derived.length && derived.every((uuid, i) => mirror[i] === uuid);
  },
  {
    // `query_by_images` is a derived mirror, and a stale denorm has cost this
    // codebase before (142 prod ledger denorms went stale because a cascade
    // walked the forward array). This makes drift unrepresentable at the write
    // boundary rather than auditable after the fact.
    //
    // Known gap, by construction: `validateBeforeWrite` strips FieldValue
    // sentinels before parsing, so an `arrayUnion` write of `images` would slip
    // past this. Every writer must build the full array — do not reintroduce a
    // sentinel writer for `images` or `query_by_images`.
    message:
      "query_by_images must hold exactly the uuids in images — every image uuid plus every non-null cutout uuid, no more and no fewer. Order is not compared; images is the authority on display order",
    path: ["query_by_images"],
  },
).meta({
  title: "Product",
  collection: "products",
  displayDefaults: {
    columns: ["name", "type", "tracking_category_name", "tags.name", "components.name", "component_of.name", "alternates.name"],
    filters: { type: ["rental", "sale", "service"], active: [true] },
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a product. */
export interface CreateProductInputType {
  uid: string;
  name: string;
  active: boolean;
  type: ProductTypeType;
  stock_method: StockMethodType;
  component_only: boolean;
  description: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: {
    base_cents: number;
    replacement_cents?: number | null;
    coa_revenue?: COARevenueType;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
  shipping?: {
    weight: number | null;
    height: number | null;
    width: number | null;
    length: number | null;
    air_hazardous: boolean;
    air_un: number | null;
  };
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  // NOTE: no `tracking_category_name`. It is a DERIVED denorm of the tracking
  // category's name, and `createProduct` reads it off the category doc it
  // already fetches. Accepting it from the client made it a free-text field
  // shadowing a derived one — a caller could name the category anything, and
  // whatever it sent was persisted unvalidated whenever `uid_tracking_category`
  // was absent. Removing it breaks nobody: the input object strips unknown keys
  // rather than rejecting them, so a client still sending it is simply ignored.
  uid_tracking_category?: string | null;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  webshop: {
    available: boolean;
    description?: string | null;
  };
  transaction?: {
    type: "purchase" | "make" | "find";
    quantity: number;
    total_cost_cents: number;
    date: string;
    reference: string;
    uid_session: string;
    allocations: MovementAllocationInputType[];
  };
}

/** Input schema for creating a product. */
export const CreateProductInput: z.ZodType<CreateProductInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(200),
  active: z.boolean(),
  type: ProductTypeEnum,
  stock_method: StockMethodEnum,
  component_only: z.boolean(),
  description: z.string(),
  eligible_delivery: z.boolean(),
  eligible_in_store_pickup: z.boolean(),
  eligible_shipping_ground: z.boolean(),
  eligible_shipping_air: z.boolean(),
  price: z.object({
    base_cents: z.int(),
    replacement_cents: z.int().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]).meta({ label: "Tax" }),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }),
  // Nullable to match storage — see `ProductSchema`. A client that has not
  // measured a dimension sends `null`, which is what makes "unmeasured"
  // enterable rather than collapsing to `0` (core#51).
  shipping: z.object({
    weight: z.number().nullable(),
    height: z.number().nullable(),
    width: z.number().nullable(),
    length: z.number().nullable(),
    air_hazardous: z.boolean(),
    air_un: z.number().nullable(),
  }).optional(),
  alternates: z.array(UidNameRef).default([]),
  components: z.array(ComponentSchema).default([]),
  component_of: z.array(ComponentSchema).default([]),
  tags: z.array(UidNameRef).default([]),
  uid_tracking_category: FirestoreId.nullable().optional(),
  uid_linked_rental: FirestoreId.nullable().optional(),
  uid_linked_replacement: FirestoreId.nullable().optional(),
  webshop: z.object({
    available: z.boolean(),
    description: z.string().nullable().optional(),
  }),
  // The opening-balance movement. No `uid`: a movement's document id is derived
  // (`{uid_session}|{type}|{subject}`), which is what makes a retried create
  // idempotent rather than appending a second event.
  transaction: z.object({
    type: z.enum(["purchase", "make", "find"]),
    quantity: z.number().int().nonnegative(),
    total_cost_cents: z.int(),
    date: chicagoInstant(),
    reference: z.string(),
    uid_session: z.uuid(),
    allocations: z.array(MovementAllocationInput).min(1),
  }).optional(),
}).refine(
  (p) => p.type !== "rental" || p.stock_method === "none" || p.price.replacement_cents != null,
  {
    message: "price.replacement_cents is required for rental products",
    path: ["price", "replacement_cents"],
  },
).refine(
  // Opening-balance scalar quantity must equal Σ per-location allocation, or the
  // ledger is born desynced (quantity_held != Σ store_breakdown). Backstop behind
  // the server-side assertQuantityMatchesLocations guard (#168). Same rule the
  // movement schema enforces as balance rule 1, applied at the input boundary so
  // the caller gets a 400 rather than a 500 from validateBeforeWrite.
  (p) =>
    !p.transaction ||
    p.transaction.quantity ===
      p.transaction.allocations.reduce((sum, a) => sum + a.quantity, 0),
  {
    message: "transaction.quantity must equal the sum of per-location allocation quantities",
    path: ["transaction", "quantity"],
  },
);
/** Input type for updating a product. */
export interface UpdateProductInputType {
  uid: string;
  name?: string;
  active?: boolean;
  type?: ProductTypeType;
  stock_method?: StockMethodType;
  component_only?: boolean;
  description?: string;
  eligible_delivery?: boolean;
  eligible_in_store_pickup?: boolean;
  eligible_shipping_ground?: boolean;
  eligible_shipping_air?: boolean;
  price?: {
    base_cents: number;
    replacement_cents?: number | null;
    coa_revenue?: COARevenueType;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
  shipping?: {
    weight: number | null;
    height: number | null;
    width: number | null;
    length: number | null;
    air_hazardous: boolean;
    air_un: number | null;
  };
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  /**
   * `null` clears the product's tracking category. It is nullable, not merely
   * optional, because "absent" already means "leave it alone" on a patch input —
   * without a null there is no wire value for un-assign at all, and the clear
   * half of the service's tracking branch is unreachable. Clearing also nulls
   * `xero_tracking_option_id` and unsets `tracking_category_name`.
   */
  uid_tracking_category?: string | null;
  uid_linked_rental?: string;
  uid_linked_replacement?: string;
  webshop?: {
    available: boolean;
    description?: string | null;
  };
  version: number;
}

/** Input schema for updating a product. */
export const UpdateProductInput: z.ZodType<UpdateProductInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(200).optional(),
  active: z.boolean().optional(),
  type: ProductTypeEnum.optional(),
  stock_method: StockMethodEnum.optional(),
  component_only: z.boolean().optional(),
  description: z.string().optional(),
  eligible_delivery: z.boolean().optional(),
  eligible_in_store_pickup: z.boolean().optional(),
  eligible_shipping_ground: z.boolean().optional(),
  eligible_shipping_air: z.boolean().optional(),
  price: z.object({
    base_cents: z.int(),
    replacement_cents: z.int().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]).meta({ label: "Tax" }),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }).optional(),
  shipping: z.object({
    weight: z.number().nullable(),
    height: z.number().nullable(),
    width: z.number().nullable(),
    length: z.number().nullable(),
    air_hazardous: z.boolean(),
    air_un: z.number().nullable(),
  }).optional(),
  alternates: z.array(UidNameRef).optional(),
  components: z.array(ComponentSchema).optional(),
  component_of: z.array(ComponentSchema).optional(),
  tags: z.array(UidNameRef).optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
  uid_linked_rental: FirestoreId.optional(),
  uid_linked_replacement: FirestoreId.optional(),
  webshop: z.object({
    available: z.boolean(),
    description: z.string().nullable().optional(),
  }).optional(),
  version: z.int().min(0),
});
