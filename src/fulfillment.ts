/**
 * Fulfillment schemas — Firestore collection: fulfillments
 *
 * Sanitized projection of an Order for the fulfillment client view.
 * Strips pricing, financial totals, invoice refs, tax profile, CRM/Xero
 * ids, notes, and transaction_fee line items. Keeps destination contacts,
 * dates, quantities, and item structure.
 *
 * Picker-editable: line items may carry `quantity_order` (server-set when
 * picker quantity diverges from order quantity) and `path_substituted_for`
 * (picker-set on substitution line items, cleared on graduation). The doc
 * carries its own `version` for optimistic concurrency on picker writes.
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
export interface FulfillmentLineItemType {
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
  /**
   * Server-set when picker quantity diverges from the order's projected
   * quantity for the same path. Carries admin's intended quantity. Picker
   * writes that include this field on any line item are rejected (400) —
   * it is server-managed.
   */
  quantity_order?: number;
  /**
   * Picker-set on substitution line items. Carries the path of the
   * substituted-for item at the moment of substitution. Cleared by the
   * projection on graduation (admin emits at the same path).
   */
  path_substituted_for?: string[];
}

export const FulfillmentLineItem: z.ZodType<FulfillmentLineItemType> = z.strictObject({
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
  quantity_order: z.number().int().min(0).optional(),
  path_substituted_for: z.array(z.string()).optional(),
});

/** Destination divider in the fulfillment items array. */
export interface FulfillmentDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}

export const FulfillmentDestinationItem: z.ZodType<FulfillmentDestinationItemType> = z.strictObject({
  uid: z.uuid(),
  type: z.literal("destination"),
  name: z.string().max(200).default(""),
  path: z.array(z.string()).default([]),
  uid_delivery: z.string().nullable().default(null),
  uid_collection: z.string().nullable().default(null),
  description: z.string().default(""),
});

/** Group divider in the fulfillment items array. */
export interface FulfillmentGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

export const FulfillmentGroupItem: z.ZodType<FulfillmentGroupItemType> = z.strictObject({
  uid: z.uuid(),
  type: z.literal("group"),
  name: z.string().min(1).max(100),
  path: z.array(z.string()).default([]),
  description: z.string().default(""),
});

/** Union of all item types in the fulfillment order view. */
export type FulfillmentItemType =
  | FulfillmentLineItemType
  | FulfillmentDestinationItemType
  | FulfillmentGroupItemType;

export const FulfillmentItem: z.ZodType<FulfillmentItemType> = z.union([
  FulfillmentLineItem,
  FulfillmentDestinationItem,
  FulfillmentGroupItem,
]);

/** Sanitized organization snapshot — uid and name only. */
const FulfillmentOrganization = z.strictObject({
  uid: z.string().nullable(),
  name: z.string().min(1).max(100).meta({ pii: "mask" }),
});

/**
 * Sanitized order document for the fulfillment client view.
 * Mirrors the order by uid — one fulfillment doc per order.
 */
export interface Fulfillment {
  uid: string;
  number: number;
  status: FulfillmentOrderStatusType;
  organization: {
    uid: string | null;
    name: string;
  };
  dates: OrderDocDatesType;
  destinations: DocDestinationType[];
  items: FulfillmentItemType[];
  subject: string;
  reference: string | null;
  query_by_items: string[];
  query_by_contacts: string[];
  /**
   * Optimistic-concurrency token. Bumped on every write — projection writes
   * (createOrder, updateOrder, opportunity webhook) and picker writes (PUT
   * /fulfillments/{uid}/items). Picker PUT body carries this value; server
   * 409s on mismatch. Mirrors `Order.version`.
   */
  version: number;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

export const FulfillmentSchema: z.ZodType<Fulfillment> = z.strictObject({
  uid: z.string(),
  number: z.int(),
  status: FulfillmentOrderStatus,
  organization: FulfillmentOrganization,
  dates: OrderDocDates,
  destinations: z.array(DocDestination).min(1),
  items: z.array(FulfillmentItem).default([]),
  subject: z.string().default(""),
  reference: z.string().max(255).nullable().default(null),
  query_by_items: z.array(z.string()).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Fulfillment",
  collection: "fulfillments",
  displayDefaults: {
    columns: ["number", "organization.name", "subject", "dates.delivery_start", "dates.collection_start", "status"],
    filters: { status: [] },
    sort: { column: "dates.delivery_start", direction: "desc" },
  },
}) as z.ZodType<Fulfillment>;
