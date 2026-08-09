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
import { FirestoreId, ItemUid } from "./_uid.ts";
import {
  type FirestoreTimestampType,
  FULFILLMENT_LINE_ITEM_TYPES,
  type FulfillableItemType,
  StockMethodEnum,
  type StockMethodType,
  TimestampFields,
} from "./common.ts";
import {
  DocDestination,
  type DocDestinationType,
} from "./order.ts";

const FULFILLMENT_ORDER_STATUSES = [
  "draft", "quoted", "reserved", "active", "complete", "canceled",
] as const;
type FulfillmentOrderStatusType = typeof FULFILLMENT_ORDER_STATUSES[number];
const FulfillmentOrderStatus: z.ZodType<FulfillmentOrderStatusType> = z.enum(FULFILLMENT_ORDER_STATUSES);

// The list and its "why" live in `common.ts`, beside `ITEM_CONTRACTS` and the
// compile-time assertion tying it to `fulfillable`.
type FulfillmentLineItemTypeType = FulfillableItemType;

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

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`.
const FulfillmentLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(FULFILLMENT_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  // Fulfillment items are a projection of order items, so this is the same
  // string; it must carry the same classification.
  name: z.string().min(1).max(100).meta({ pii: "none", column: true }),
  // Line-item text — not customer data. See `OrderDocLineItem.description`.
  // Fulfillment items are a projection of order items, so this is the same
  // string; it must carry the same classification.
  description: z.string().meta({ pii: "none", column: true, label: "Description" }).default(""),
  quantity: z.number().int().min(0).default(0).meta({ column: true, label: "Quantity" }),
  stock_method: StockMethodEnum.optional().meta({ column: true, label: "Stock Method" }),
  path: z.array(ItemUid).default([]),
  order_number: z.number().optional().meta({ column: true, label: "Order #" }),
  uid_order: FirestoreId.optional(),
  uid_delivery: FirestoreId.nullable().optional(),
  uid_collection: FirestoreId.nullable().optional(),
  quantity_order: z.number().int().min(0).optional(),
  path_substituted_for: z.array(ItemUid).optional(),
});

export const FulfillmentLineItem: z.ZodType<FulfillmentLineItemType> = FulfillmentLineItemInner;

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

const FulfillmentDestinationItemInner = z.strictObject({
  uid: z.uuid(),
  type: z.literal("destination"),
  // Venue label, projected from `OrderDocDestinationItem.name` — same string,
  // same classification. See `OrderDocLineItem.name`.
  name: z.string().max(200).meta({ pii: "none" }).default(""),
  path: z.array(ItemUid).default([]),
  uid_delivery: FirestoreId.nullable().default(null),
  uid_collection: FirestoreId.nullable().default(null),
  description: z.string().meta({ pii: "none" }).default(""),
});

export const FulfillmentDestinationItem: z.ZodType<FulfillmentDestinationItemType> = FulfillmentDestinationItemInner;

/** Group divider in the fulfillment items array. */
export interface FulfillmentGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

const FulfillmentGroupItemInner = z.strictObject({
  uid: z.uuid(),
  type: z.literal("group"),
  // Section header, projected from `OrderDocGroupItem.name` — same string, same
  // classification. See `OrderDocLineItem.name`.
  name: z.string().min(1).max(100).meta({ pii: "none" }),
  path: z.array(ItemUid).default([]),
  description: z.string().meta({ pii: "none" }).default(""),
});

export const FulfillmentGroupItem: z.ZodType<FulfillmentGroupItemType> = FulfillmentGroupItemInner;

/** Union of all item types in the fulfillment order view. */
export type FulfillmentItemType =
  | FulfillmentLineItemType
  | FulfillmentDestinationItemType
  | FulfillmentGroupItemType;

export const FulfillmentItem: z.ZodType<FulfillmentItemType> = z.discriminatedUnion("type", [
  FulfillmentLineItemInner,
  FulfillmentDestinationItemInner,
  FulfillmentGroupItemInner,
]);

/** Sanitized organization snapshot — uid and name only. */
const FulfillmentOrganization = z.strictObject({
  uid: FirestoreId.nullable(),
  name: z.string().min(1).max(100).meta({ pii: "mask", column: true }),
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
  destinations: DocDestinationType[];
  items: FulfillmentItemType[];
  subject: string;
  reference: string | null;
  query_by_items: string[];
  query_by_contacts: string[];
  query_by_dates: string[];
  /**
   * Optimistic-concurrency token. Bumped on every write — projection writes
   * (createOrder, updateOrder, opportunity webhook) and picker writes (PUT
   * /fulfillments/{uid}/items). Picker PUT body carries this value; server
   * 409s on mismatch. Mirrors `Order.version`.
   */
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

export const FulfillmentSchema: z.ZodType<Fulfillment> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "fulfillmentDetail" }),
  status: FulfillmentOrderStatus.meta({ column: true, label: "Status" }),
  organization: FulfillmentOrganization.meta({ label: "Organization" }),
  destinations: z.array(DocDestination).min(1),
  items: z.array(FulfillmentItem).default([]).meta({ label: "Item" }),
  subject: z.string().default("").meta({ column: true, label: "Subject" }),
  reference: z.string().max(255).nullable().default(null).meta({ column: true, label: "Reference" }),
  query_by_items: z.array(z.string()).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  query_by_dates: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Fulfillment",
  collection: "fulfillments",
  displayDefaults: {
    columns: ["number", "organization.name", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
}) as z.ZodType<Fulfillment>;
