/**
 * OrderFulfillment schemas — Firestore collection: order-fulfillments
 *
 * Sanitized projection of an Order for the fulfillment client view.
 * Strips pricing, financial totals, invoice refs, tax profile, CRM/Xero
 * ids, version, notes, and transaction_fee line items. Keeps
 * destination contacts, dates, quantities, and item structure.
 */
import { z } from "zod";
import {
  type FirestoreTimestampType,
  StockMethodEnum,
  type StockMethodType,
  TimestampFields,
} from "./common.ts";
import {
  DocDestination,
  type DocDestinationType,
  OrderDocDates,
  type OrderDocDatesType,
} from "./order.ts";

const FULFILLMENT_ORDER_STATUSES = [
  "draft", "quoted", "reserved", "active", "complete", "canceled",
] as const;
type FulfillmentOrderStatusType = typeof FULFILLMENT_ORDER_STATUSES[number];
const FulfillmentOrderStatus: z.ZodType<FulfillmentOrderStatusType> = z.enum(FULFILLMENT_ORDER_STATUSES);

// Fulfillment line items exclude transaction_fee — that type is purely financial.
const FULFILLMENT_LINE_ITEM_TYPES = ["rental", "replacement", "sale", "service", "surcharge"] as const;
type FulfillmentLineItemTypeType = typeof FULFILLMENT_LINE_ITEM_TYPES[number];
const FulfillmentLineItemTypeEnum: z.ZodType<FulfillmentLineItemTypeType> = z.enum(FULFILLMENT_LINE_ITEM_TYPES);

/** Line item in the fulfillment order view — no price, no financial flags. */
export interface OrderFulfillmentLineItemType {
  uid: string;
  type: FulfillmentLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  stock_method?: StockMethodType;
  path: string[];
  order_number?: number;
  uid_order?: string;
  uid_delivery?: string | null;
  uid_collection?: string | null;
}

export const OrderFulfillmentLineItem: z.ZodType<OrderFulfillmentLineItemType> = z.strictObject({
  uid: z.string(),
  type: FulfillmentLineItemTypeEnum,
  name: z.string().min(1).max(100),
  description: z.string().default(""),
  quantity: z.number().int().min(0).default(0),
  stock_method: StockMethodEnum.optional(),
  path: z.array(z.string()).default([]),
  order_number: z.number().optional(),
  uid_order: z.string().optional(),
  uid_delivery: z.string().nullable().optional(),
  uid_collection: z.string().nullable().optional(),
});

/** Destination divider in the fulfillment items array. */
export interface OrderFulfillmentDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}

export const OrderFulfillmentDestinationItem: z.ZodType<OrderFulfillmentDestinationItemType> = z.strictObject({
  uid: z.uuid(),
  type: z.literal("destination"),
  name: z.string().max(200).default(""),
  path: z.array(z.string()).default([]),
  uid_delivery: z.string().nullable().default(null),
  uid_collection: z.string().nullable().default(null),
  description: z.string().default(""),
});

/** Group divider in the fulfillment items array. */
export interface OrderFulfillmentGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

export const OrderFulfillmentGroupItem: z.ZodType<OrderFulfillmentGroupItemType> = z.strictObject({
  uid: z.uuid(),
  type: z.literal("group"),
  name: z.string().min(1).max(100),
  path: z.array(z.string()).default([]),
  description: z.string().default(""),
});

/** Union of all item types in the fulfillment order view. */
export type OrderFulfillmentItemType =
  | OrderFulfillmentLineItemType
  | OrderFulfillmentDestinationItemType
  | OrderFulfillmentGroupItemType;

export const OrderFulfillmentItem: z.ZodType<OrderFulfillmentItemType> = z.union([
  OrderFulfillmentLineItem,
  OrderFulfillmentDestinationItem,
  OrderFulfillmentGroupItem,
]);

/** Sanitized organization snapshot — uid and name only. */
const OrderFulfillmentOrganization = z.strictObject({
  uid: z.string().nullable(),
  name: z.string().min(1).max(100).meta({ pii: "mask" }),
});

/**
 * Sanitized order document for the fulfillment client view.
 * Mirrors the order by uid — one fulfillment doc per order.
 */
export interface OrderFulfillment {
  uid: string;
  number: number;
  status: FulfillmentOrderStatusType;
  organization: {
    uid: string | null;
    name: string;
  };
  dates: OrderDocDatesType;
  destinations: DocDestinationType[];
  items: OrderFulfillmentItemType[];
  subject: string;
  reference: string | null;
  query_by_items: string[];
  query_by_contacts: string[];
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

export const OrderFulfillmentSchema: z.ZodType<OrderFulfillment> = z.strictObject({
  uid: z.string(),
  number: z.int(),
  status: FulfillmentOrderStatus,
  organization: OrderFulfillmentOrganization,
  dates: OrderDocDates,
  destinations: z.array(DocDestination).min(1),
  items: z.array(OrderFulfillmentItem).default([]),
  subject: z.string().default(""),
  reference: z.string().max(255).nullable().default(null),
  query_by_items: z.array(z.string()).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  ...TimestampFields,
}).meta({
  title: "Order (Fulfillment)",
  collection: "order-fulfillments",
  displayDefaults: {
    columns: ["number", "organization.name", "subject", "dates.delivery_start", "dates.collection_start", "status"],
    filters: { status: [] },
    sort: { column: "dates.delivery_start", direction: "desc" },
  },
}) as z.ZodType<OrderFulfillment>;
