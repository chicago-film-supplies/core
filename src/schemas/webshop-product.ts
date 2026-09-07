/**
 * WebshopProduct document schema — Firestore collection: webshop-products
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ComponentPriceFormulaEnum,
  type ComponentPriceFormulaType,
  ComponentTypeEnum,
  type ComponentTypeType,
  type FirestoreTimestampType,
  InclusionTypeEnum,
  type InclusionTypeType,
  type ProductTypeType,
  StockMethodEnum,
  type StockMethodType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";
import { TaxRef, type TaxRefType } from "./order.ts";

/** A component product within a webshop parent product. */
export interface WebshopProductComponent {
  uid: string;
  path: string[];
  name: string;
  active?: boolean;
  type: ComponentTypeType;
  stock_method?: StockMethodType;
  description?: string;
  inclusion_type?: InclusionTypeType;
  quantity: number;
  zero_priced?: boolean;
  price: {
    base_cents: number;
    replacement_cents?: number | null;
    taxes: TaxRefType[];
    formula: ComponentPriceFormulaType;
    discountable: boolean;
  };
}

/** Shipping dimensions and hazard classification for a webshop product. */
export interface WebshopProductShipping {
  // Nullable for the same reason `ProductShipping` is: `null` is "not measured
  // yet" and `0` cannot say that (core#51). The webshop doc is a projection of
  // the product, so it has to be able to carry the fact rather than flatten it.
  weight?: number | null;
  height?: number | null;
  width?: number | null;
  length?: number | null;
  air_hazardous?: boolean;
  air_un?: number | null;
}

/**
 * What may appear in the PUBLIC catalog — `PRODUCT_TYPES` minus `replacement`
 * and `transaction_fee`.
 *
 * 🔴 **Do not unify this with `COMPONENT_TYPES`, which is byte-identical
 * today** (core#89). They never occupy the same slot: this types
 * `WebshopProduct.type`, the projection's own type, while `COMPONENT_TYPES`
 * types `ComponentObject.type` — and `WebshopProductComponent.type` above
 * already imports `ComponentTypeEnum` rather than holding a second copy. So
 * there is no site at which a reader could substitute one for the other.
 *
 * ⚠️ **The agreement has a shared CAUSE but not a shared DEFINITION.** Both
 * exclude the same two because each is a system-minted line type rather than a
 * catalog-authored one — a `replacement` is auto-minted per rental product, a
 * `transaction_fee` prices from a document total. That is not a coincidence,
 * which is what the issue called it. But nothing obliges the two to move
 * together: CFS could decide a delivery `surcharge` should not be publicly
 * listed without that touching what may be a component of a product.
 *
 * ⭐ **The load-bearing reason to refuse, though, is that only ONE of the two
 * has any enforcement outside its own schema.** `createWebshopDoc`
 * (`api-cloudrun/src/services/products.ts`) casts a product's own `type` into
 * this slot UNCHECKED, so this list is the sole thing standing between that
 * cast and a `transaction_fee` landing in a public projection. Weld the two and
 * a future widening of *"what may be a component"* silently widens what that
 * cast can smuggle in. The live proof that the cast's input can disagree with
 * its output is the stale mirror on product `77LKBYcC09u1PZFhxmDJ`, whose
 * source says `transaction_fee` while its projection says `sale`.
 */
const WEBSHOP_PRODUCT_TYPES = ["rental", "sale", "service", "surcharge"] as const;
type WebshopProductTypeType = typeof WEBSHOP_PRODUCT_TYPES[number];

// `WEBSHOP_PRODUCT_TYPES` must be a SUBSET of `PRODUCT_TYPES`, because
// `createWebshopDoc` casts a product's `type` into this slot unchecked — so a
// member here that is not a product type is a shape nothing can ever produce.
//
// ⚠️ Subset only, deliberately — no strict-subset second clause, unlike
// `_ComponentFormulaSubset` in `common.ts`. That clause encodes "this may never
// become the full set", which is defensible for component formulas and is NOT a
// claim anyone can support here: nothing rules out a future where a
// `replacement` is shoppable. Asserting only what is true is the point; the
// asymmetry is deliberate, not an omission.
type _WebshopTypeSubset = [WebshopProductTypeType] extends [ProductTypeType] ? true : never;
const _webshopTypeSubset: _WebshopTypeSubset = true;
void _webshopTypeSubset;

/** A webshop product document in the webshop-products Firestore collection. */
export interface WebshopProduct {
  uid: string;
  name: string;
  active: boolean;
  type: WebshopProductTypeType;
  stock_method?: StockMethodType;
  component_only?: boolean;
  description?: string;
  eligible_delivery: boolean;
  eligible_in_store_pickup: boolean;
  eligible_shipping_ground: boolean;
  eligible_shipping_air: boolean;
  price: {
    base_cents: number;
    replacement_cents?: number | null;
    taxes: TaxRefType[];
    formula: ComponentPriceFormulaType;
    discountable: boolean;
  };
  shipping?: WebshopProductShipping;
  alternates: UidNameRefType[];
  components: WebshopProductComponent[];
  component_of: WebshopProductComponent[];
  tags?: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  webshop: {
    available: boolean;
    description?: string | null;
  };
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

const WebshopComponentSchema: z.ZodType<WebshopProductComponent> = z.strictObject({
  uid: FirestoreId,
  path: z.array(z.string()),
  name: z.string().meta({ column: true }),
  active: z.boolean().optional(),
  type: ComponentTypeEnum,
  stock_method: StockMethodEnum.optional(),
  description: z.string().optional(),
  inclusion_type: InclusionTypeEnum.optional(),
  quantity: z.number(),
  zero_priced: z.boolean().optional(),
  /**
   * ⚠️ **Narrower than `Product.price` — `ComponentPriceFormulaType`, not
   * `PriceFormulaType`** (core#89). Two independent reasons, and the second is
   * the stronger one:
   *
   * 1. A webshop document mirrors a product whose type is confined to
   *    `WEBSHOP_PRODUCT_TYPES`, which excludes `transaction_fee` — the only
   *    type that legitimately prices from a document total.
   * 2. 🔴 **Neither webshop price arm declares `base_percent` at all**, so
   *    `percent_of_total` here would name a formula whose rate the document is
   *    structurally incapable of carrying. The member is not merely
   *    unreachable, it is uninhabitable.
   *
   * ⭐ Narrowing rather than adding `checkPriceBaseUnit`: on a price object with
   * no `base_percent` key that refinement could only ever fire its
   * *"percent_of_total requires base_percent"* arm — a formula ban wearing a
   * refinement's clothes. The type says it once, where a consumer can read it.
   */
  price: z.strictObject({
    base_cents: z.int(),
    replacement_cents: z.int().nullable().optional(),
    taxes: z.array(TaxRef).default([]).meta({ label: "Tax" }),
    formula: ComponentPriceFormulaEnum,
    discountable: z.boolean(),
  }),
});

/** Zod schema for a WebshopProduct document. */
export const WebshopProductSchema: z.ZodType<WebshopProduct> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(200).meta({ column: true, label: "Name" }),
  // Required, with the form seed carried by `initial` — see `product.ts`.
  active: z.boolean().meta({ initial: true }),
  type: z.enum(WEBSHOP_PRODUCT_TYPES).meta({ column: true, label: "Type" }),
  stock_method: StockMethodEnum.optional(),
  component_only: z.boolean().optional(),
  description: z.string().optional(),
  eligible_delivery: z.boolean(),
  eligible_in_store_pickup: z.boolean(),
  eligible_shipping_ground: z.boolean(),
  eligible_shipping_air: z.boolean(),
  /**
   * ⚠️ **Narrower than `Product.price` — `ComponentPriceFormulaType`, not
   * `PriceFormulaType`** (core#89). Two independent reasons, and the second is
   * the stronger one:
   *
   * 1. A webshop document mirrors a product whose type is confined to
   *    `WEBSHOP_PRODUCT_TYPES`, which excludes `transaction_fee` — the only
   *    type that legitimately prices from a document total.
   * 2. 🔴 **Neither webshop price arm declares `base_percent` at all**, so
   *    `percent_of_total` here would name a formula whose rate the document is
   *    structurally incapable of carrying. The member is not merely
   *    unreachable, it is uninhabitable.
   *
   * ⭐ Narrowing rather than adding `checkPriceBaseUnit`: on a price object with
   * no `base_percent` key that refinement could only ever fire its
   * *"percent_of_total requires base_percent"* arm — a formula ban wearing a
   * refinement's clothes. The type says it once, where a consumer can read it.
   */
  price: z.strictObject({
    base_cents: z.int(),
    replacement_cents: z.int().nullable().optional(),
    taxes: z.array(TaxRef).default([]).meta({ label: "Tax" }),
    formula: ComponentPriceFormulaEnum,
    discountable: z.boolean(),
  }),
  shipping: z.strictObject({
    weight: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    width: z.number().nullable().optional(),
    length: z.number().nullable().optional(),
    air_hazardous: z.boolean().optional(),
    air_un: z.number().nullable().optional(),
  }).optional(),
  alternates: z.array(UidNameRef).default([]).meta({ label: "Alternates" }),
  components: z.array(WebshopComponentSchema).default([]).meta({ label: "Components" }),
  component_of: z.array(WebshopComponentSchema).default([]).meta({ label: "Component Of" }),
  tags: z.array(UidNameRef).optional().meta({ label: "Tags" }),
  query_by_tags: z.array(z.string()).optional(),
  query_by_components: z.array(z.string()).optional(),
  query_by_component_of: z.array(z.string()).optional(),
  query_by_alternates: z.array(z.string()).optional(),
  webshop: z.strictObject({
    available: z.boolean().default(false),
    description: z.string().nullable().optional(),
  }),
  ...TimestampFields,
}).meta({
  title: "Webshop Product",
  collection: "webshop-products",
  displayDefaults: {
    columns: ["name", "type", "tags.name", "components.name", "component_of.name", "alternates.name"],
    filters: { type: ["rental", "sale", "service"], active: [true] },
    sort: { column: "name", direction: "asc" },
  },
});
