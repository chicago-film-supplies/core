/**
 * Product document schema — Firestore collection: products
 */
import { z } from "zod";
import { chicagoInstant } from "./_datetime.ts";
import { type TransactionStore, TransactionStoreSchema } from "./transaction.ts";
import {
  ActorRef,
  type ActorRefType,
  COARevenueEnum,
  type COARevenueType,
  ComponentTypeEnum,
  type ComponentTypeType,
  type FirestoreTimestampType,
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

/** A component product within a parent product. */
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
    base: number;
    replacement?: number | null;
    coa_revenue?: COARevenueType;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
}

/** Pricing details for a product. */
export interface ProductPrice {
  base: number;
  replacement?: number | null;
  coa_revenue?: COARevenueType;
  taxes: TaxRefType[];
  formula: PriceFormulaType;
  discountable: boolean;
}

/** Shipping dimensions and hazard classification for a product. */
export interface ProductShipping {
  weight: number;
  height: number;
  width: number;
  length: number;
  air_hazardous: boolean;
  air_un: number | null;
}

/** Webshop availability and description for a product. */
export interface ProductWebshop {
  available: boolean;
  description?: string | null;
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
  components: ProductComponent[];
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
  images?: string[];
  xero_id?: string | null;
  xero_tracking_option_id?: string;
  defaultThreadId?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

export const ComponentSchema: z.ZodType<ProductComponent> = z.strictObject({
  uid: z.string(),
  path: z.array(z.string()),
  name: z.string(),
  active: z.boolean().optional(),
  type: ComponentTypeEnum,
  stock_method: StockMethodEnum,
  crms_id: z.number().nullable(),
  crms_accessory_id: z.number().nullable().optional(),
  description: z.string().optional(),
  inclusion_type: InclusionTypeEnum.optional(),
  quantity: z.number(),
  zero_priced: z.boolean().optional(),
  price: z.strictObject({
    base: z.number(),
    replacement: z.number().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }),
}).refine(
  (c) => c.type !== "rental" || c.stock_method === "none" || c.price.replacement != null,
  { message: "price.replacement is required for rental components", path: ["price", "replacement"] },
);

/** Zod schema for a Product document. */
export const ProductSchema: z.ZodType<Product> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(200),
  active: z.boolean().default(true),
  type: ProductTypeEnum,
  stock_method: StockMethodEnum,
  component_only: z.boolean().default(false),
  crms_id: z.number().nullable(),
  crms_rate_id: z.number().nullable().optional(),
  crms_stock_level_ids: z.record(z.string(), z.number()).optional(),
  crms_linked_rental_id: z.number().nullable().optional(),
  crms_linked_replacement_id: z.number().nullable().optional(),
  crms_linked_replacement_rate_id: z.number().nullable().optional(),
  description: z.string().optional(),
  eligible_delivery: z.boolean().default(true),
  eligible_in_store_pickup: z.boolean().default(true),
  eligible_shipping_ground: z.boolean().default(false),
  eligible_shipping_air: z.boolean().default(false),
  price: z.strictObject({
    base: z.number(),
    replacement: z.number().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]),
    formula: PriceFormulaEnum,
    discountable: z.boolean().default(true),
  }),
  shipping: z.strictObject({
    weight: z.number(),
    height: z.number(),
    width: z.number(),
    length: z.number(),
    air_hazardous: z.boolean(),
    air_un: z.number().nullable(),
  }).optional(),
  alternates: z.array(UidNameRef).default([]),
  components: z.array(ComponentSchema).default([]),
  component_of: z.array(ComponentSchema).default([]),
  tags: z.array(UidNameRef).default([]),
  query_by_tags: z.array(z.string()).default([]).optional(),
  query_by_components: z.array(z.string()).default([]).optional(),
  query_by_component_of: z.array(z.string()).default([]).optional(),
  query_by_alternates: z.array(z.string()).default([]).optional(),
  tracking_category_name: z.string().optional(),
  uid_linked_rental: z.string().nullable().optional(),
  uid_linked_replacement: z.string().nullable().optional(),
  uid_tracking_category: z.string().nullable().optional(),
  webshop: z.strictObject({
    available: z.boolean().default(false),
    description: z.string().nullable().optional(),
  }),
  images: z.array(z.string()).optional(),
  xero_id: z.string().nullable().optional(),
  xero_tracking_option_id: z.string().optional(),
  defaultThreadId: z.string().optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).refine(
  (p) => p.type !== "rental" || p.stock_method === "none" || p.price.replacement != null,
  { message: "price.replacement is required for rental products", path: ["price", "replacement"] },
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
    base: number;
    replacement?: number | null;
    coa_revenue?: COARevenueType;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
  shipping?: {
    weight: number;
    height: number;
    width: number;
    length: number;
    air_hazardous: boolean;
    air_un: number | null;
  };
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  tracking_category_name?: string;
  uid_tracking_category?: string | null;
  uid_linked_rental?: string | null;
  uid_linked_replacement?: string | null;
  webshop: {
    available: boolean;
    description?: string | null;
  };
  transaction?: {
    uid: string;
    type: "purchase" | "make" | "find";
    quantity: number;
    total_cost: number;
    date: string;
    reference: string;
    stores: TransactionStore[];
  };
}

/** Input schema for creating a product. */
export const CreateProductInput: z.ZodType<CreateProductInputType> = z.object({
  uid: z.string(),
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
    base: z.number(),
    replacement: z.number().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }),
  shipping: z.object({
    weight: z.number(),
    height: z.number(),
    width: z.number(),
    length: z.number(),
    air_hazardous: z.boolean(),
    air_un: z.number().nullable(),
  }).optional(),
  alternates: z.array(UidNameRef).default([]),
  components: z.array(ComponentSchema).default([]),
  component_of: z.array(ComponentSchema).default([]),
  tags: z.array(UidNameRef).default([]),
  tracking_category_name: z.string().optional(),
  uid_tracking_category: z.string().nullable().optional(),
  uid_linked_rental: z.string().nullable().optional(),
  uid_linked_replacement: z.string().nullable().optional(),
  webshop: z.object({
    available: z.boolean(),
    description: z.string().nullable().optional(),
  }),
  transaction: z.object({
    uid: z.string(),
    type: z.enum(["purchase", "make", "find"]),
    quantity: z.number(),
    total_cost: z.number(),
    date: chicagoInstant(),
    reference: z.string(),
    stores: z.array(TransactionStoreSchema),
  }).optional(),
}).refine(
  (p) => p.type !== "rental" || p.stock_method === "none" || p.price.replacement != null,
  { message: "price.replacement is required for rental products", path: ["price", "replacement"] },
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
    base: number;
    replacement?: number | null;
    coa_revenue?: COARevenueType;
    taxes: TaxRefType[];
    formula: PriceFormulaType;
    discountable: boolean;
  };
  shipping?: {
    weight: number;
    height: number;
    width: number;
    length: number;
    air_hazardous: boolean;
    air_un: number | null;
  };
  alternates?: UidNameRefType[];
  components?: ProductComponent[];
  component_of?: ProductComponent[];
  tags?: UidNameRefType[];
  uid_tracking_category?: string;
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
  uid: z.string(),
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
    base: z.number(),
    replacement: z.number().nullable().optional(),
    coa_revenue: COARevenueEnum.optional(),
    taxes: z.array(TaxRef).default([]),
    formula: PriceFormulaEnum,
    discountable: z.boolean(),
  }).optional(),
  shipping: z.object({
    weight: z.number(),
    height: z.number(),
    width: z.number(),
    length: z.number(),
    air_hazardous: z.boolean(),
    air_un: z.number().nullable(),
  }).optional(),
  alternates: z.array(UidNameRef).optional(),
  components: z.array(ComponentSchema).optional(),
  component_of: z.array(ComponentSchema).optional(),
  tags: z.array(UidNameRef).optional(),
  uid_tracking_category: z.string().optional(),
  uid_linked_rental: z.string().optional(),
  uid_linked_replacement: z.string().optional(),
  webshop: z.object({
    available: z.boolean(),
    description: z.string().nullable().optional(),
  }).optional(),
  version: z.int().min(0),
});
