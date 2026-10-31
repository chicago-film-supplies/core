/**
 * WebshopProduct document schema — Firestore collection: webshop-products
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { checkDatedRates, type DatedRate, DatedRateSchema } from "./price-formula.ts";
import {
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
  /** @see `ProductComponent.uid_tax_class` — mirrored from the component product. */
  uid_tax_class?: string;
  price: WebshopPrice;
}

/**
 * A webshop price: the product's formula and its dated rates (purchases-as-documents
 * D4), mirrored. A webshop document mirrors a product whose type is confined to
 * `WEBSHOP_PRODUCT_TYPES`, which excludes `transaction_fee`, so it never carries a
 * percent-of-total price: it always names a formula and at least one rate.
 */
export interface WebshopPrice {
  uid_price_formula: string;
  rates: DatedRate[];
  replacement_cents?: number | null;
  discountable: boolean;
}

const WebshopPriceSchema: z.ZodType<WebshopPrice> = z.strictObject({
  uid_price_formula: FirestoreId,
  rates: z.array(DatedRateSchema).min(1).superRefine(checkDatedRates),
  replacement_cents: z.int().nullable().optional(),
  discountable: z.boolean(),
});

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
// `_ComponentFormulaSubset` in `schemas/common.ts`. That clause encodes "this
// may never become the full set", which is defensible for component formulas and is NOT a
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
  price: WebshopPrice;
  shipping?: WebshopProductShipping;
  alternates: UidNameRefType[];
  components: WebshopProductComponent[];
  component_of: WebshopProductComponent[];
  tags?: UidNameRefType[];
  query_by_tags?: string[];
  query_by_components?: string[];
  query_by_component_of?: string[];
  query_by_alternates?: string[];
  /** @see `Product.uid_tax_class` — mirrored from the source product. */
  uid_tax_class?: string | null;
  /** @see `Product.tax_class_name`. */
  tax_class_name?: string | null;
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
  uid_tax_class: FirestoreId.optional(),
  price: WebshopPriceSchema,
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
  price: WebshopPriceSchema,
  shipping: z.strictObject({
    weight: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    width: z.number().nullable().optional(),
    length: z.number().nullable().optional(),
    air_hazardous: z.boolean().optional(),
    air_un: z.number().nullable().optional(),
  }).optional(),
  alternates: z.array(UidNameRef).meta({ label: "Alternates" }),
  components: z.array(WebshopComponentSchema).meta({ label: "Components" }),
  component_of: z.array(WebshopComponentSchema).meta({ label: "Component Of" }),
  tags: z.array(UidNameRef).optional().meta({ label: "Tags" }),
  query_by_tags: z.array(z.string()).optional(),
  query_by_components: z.array(z.string()).optional(),
  query_by_component_of: z.array(z.string()).optional(),
  query_by_alternates: z.array(z.string()).optional(),
  uid_tax_class: FirestoreId.nullable().optional(),
  tax_class_name: z.string().nullable().optional(),
  webshop: z.strictObject({
    available: z.boolean(),
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
