/**
 * WebshopProduct document schema — Firestore collection: webshop-products
 */
import { z } from "zod";
import {
  ComponentTypeEnum,
  type ComponentTypeType,
  type FirestoreTimestampType,
  InclusionTypeEnum,
  type InclusionTypeType,
  PriceFormulaEnum,
  type PriceFormulaType,
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
    base: number;
    replacement?: number | null;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
}

/** Shipping dimensions and hazard classification for a webshop product. */
export interface WebshopProductShipping {
  weight?: number;
  height?: number;
  width?: number;
  length?: number;
  air_hazardous?: boolean;
  air_un?: number | null;
}

const WEBSHOP_PRODUCT_TYPES = ["rental", "sale", "service", "surcharge"] as const;
type WebshopProductTypeType = typeof WEBSHOP_PRODUCT_TYPES[number];

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
    base: number;
    replacement?: number | null;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
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
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

const WebshopComponentSchema: z.ZodType<WebshopProductComponent> = z.strictObject({
  uid: z.string(),
  path: z.array(z.string()),
  name: z.string(),
  active: z.boolean().optional(),
  type: ComponentTypeEnum,
  stock_method: StockMethodEnum.optional(),
  description: z.string().optional(),
  inclusion_type: InclusionTypeEnum.optional(),
  quantity: z.number(),
  zero_priced: z.boolean().optional(),
  price: z.strictObject({
    base: z.number(),
    replacement: z.number().nullable().optional(),
    taxes: z.array(TaxRef).default([]),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }),
});

/** Zod schema for a WebshopProduct document. */
export const WebshopProductSchema: z.ZodType<WebshopProduct> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(200),
  active: z.boolean().default(true),
  type: z.enum(WEBSHOP_PRODUCT_TYPES),
  stock_method: StockMethodEnum.optional(),
  component_only: z.boolean().optional(),
  description: z.string().optional(),
  eligible_delivery: z.boolean().default(false),
  eligible_in_store_pickup: z.boolean().default(false),
  eligible_shipping_ground: z.boolean().default(false),
  eligible_shipping_air: z.boolean().default(false),
  price: z.strictObject({
    base: z.number(),
    replacement: z.number().nullable().optional(),
    taxes: z.array(TaxRef).default([]),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }),
  shipping: z.strictObject({
    weight: z.number().optional(),
    height: z.number().optional(),
    width: z.number().optional(),
    length: z.number().optional(),
    air_hazardous: z.boolean().optional(),
    air_un: z.number().nullable().optional(),
  }).optional(),
  alternates: z.array(UidNameRef).default([]),
  components: z.array(WebshopComponentSchema).default([]),
  component_of: z.array(WebshopComponentSchema).default([]),
  tags: z.array(UidNameRef).default([]).optional(),
  query_by_tags: z.array(z.string()).default([]).optional(),
  query_by_components: z.array(z.string()).default([]).optional(),
  query_by_component_of: z.array(z.string()).default([]).optional(),
  query_by_alternates: z.array(z.string()).default([]).optional(),
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
