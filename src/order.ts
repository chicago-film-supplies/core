/**
 * Order schemas — Firestore collection: orders
 */
import { z } from "zod";
import { chicagoInstant } from "./_datetime.ts";
import {
  Address,
  type AddressType,
  DocItemTypeEnum,
  type DocItemTypeType,
  DocLineItemTypeEnum,
  type DocLineItemTypeType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  InclusionTypeEnum,
  type InclusionTypeType,
  type NameParts,
  NamePartsFields,
  Phone,
  PriceFormulaEnum,
  type PriceFormulaType,
  RateTypeEnum,
  type RateType,
  StockMethodEnum,
  type StockMethodType,
  TaxProfileEnum,
  type InvoiceStatusType,
  InvoiceStatusEnum,
  type TaxProfileType,
  NameField,
  TimestampFields,
} from "./common.ts";

export const ORDER_STATUSES = [
  "draft", "quoted", "reserved", "active", "complete", "canceled",
] as const;
export type OrderStatusType = typeof ORDER_STATUSES[number];
const OrderStatus: z.ZodType<OrderStatusType> = z.enum(ORDER_STATUSES);

/**
 * Statuses an operator may set directly via UpdateOrderInput.status.
 * `active` and `complete` are computed by the booking workflow and are
 * never accepted from a manual write.
 */
export const ORDER_USER_STATUSES = ["draft", "quoted", "reserved", "canceled"] as const;
export type OrderUserStatusType = typeof ORDER_USER_STATUSES[number];

/**
 * Statuses derived from booking state — set only by the API's booking write
 * path (reserved → active when a booking moves quantity into out;
 * active → complete when every quantity has reached a terminal state).
 */
export const ORDER_COMPUTED_STATUSES = ["active", "complete"] as const;
export type OrderComputedStatusType = typeof ORDER_COMPUTED_STATUSES[number];

/**
 * The statuses an operator can move to from the given current status.
 * Returns an empty list for computed statuses (`active`, `complete`) and
 * filters the current status out of the user-settable set.
 */
export function getOrderStatusTransitions(current: OrderStatusType): OrderUserStatusType[] {
  if ((ORDER_COMPUTED_STATUSES as readonly string[]).includes(current)) return [];
  return ORDER_USER_STATUSES.filter((s) => s !== current);
}

/**
 * Server-side gate for an order status write. `source: "manual"` rejects
 * writes that move into a computed status or out of a computed status into
 * anything other than the same value (no-op). `source: "propagation"`
 * trusts the booking write path that sets `active` or `complete`.
 */
export function isValidOrderStatusTransition(
  prev: OrderStatusType,
  next: OrderStatusType,
  source: "manual" | "propagation",
): boolean {
  if (prev === next) return true;
  if (source === "propagation") return true;
  return (getOrderStatusTransitions(prev) as readonly string[]).includes(next);
}

// Item type constants imported from common.ts:
// DocItemTypeType / DocItemTypeEnum — all types including structural dividers (input schemas)
// DocLineItemTypeType / DocLineItemTypeEnum — billable types only (doc schemas)

const INCLUSION_TYPES_NULLABLE = ["default", "mandatory", "optional"] as const;

/**
 * Order dates — all six date boundaries as ISO datetime strings with offset,
 * or null when the boundary is unset.
 */
export interface OrderDatesType {
  delivery_start: string | null;
  delivery_end: string | null;
  collection_start: string | null;
  collection_end: string | null;
  charge_start: string | null;
  charge_end: string | null;
}

/** Zod schema for order dates. */
export const OrderDates: z.ZodType<OrderDatesType> = z.object({
  delivery_start: chicagoInstant().nullable(),
  delivery_end: chicagoInstant().nullable(),
  collection_start: chicagoInstant().nullable(),
  collection_end: chicagoInstant().nullable(),
  charge_start: chicagoInstant().nullable(),
  charge_end: chicagoInstant().nullable(),
});

/**
 * Contact reference embedded in a destination endpoint.
 * When present (not null), uid and first_name are required. `name` is the
 * server-derived display string (see `deriveName` in common.ts) — populated
 * by api-cloudrun on every write so consumers don't re-derive client-side.
 */
export interface DestinationContactType extends NameParts {
  uid: string;
  name: string;
  phones?: string[];
}

/** Zod schema for destination contact reference. */
export const DestinationContact: z.ZodType<DestinationContactType> = z.object({
  uid: z.string(),
  ...NamePartsFields,
  name: NameField,
  phones: z.array(Phone).optional(),
});

/**
 * Contact reference in a destination endpoint (document schema — uid & first_name required).
 */
export interface DocDestinationContactType extends NameParts {
  uid: string;
  name: string;
  phones?: string[];
}

/** Zod schema for destination contact reference (document version). */
export const DocDestinationContact: z.ZodType<DocDestinationContactType> = z.strictObject({
  uid: z.string(),
  ...NamePartsFields,
  name: NameField,
  phones: z.array(Phone).default([]),
});

/**
 * A single destination endpoint (delivery or collection).
 */
export interface DestinationEndpointType {
  uid?: string | null;
  address?: AddressType | null;
  instructions?: string | null;
  contact?: DestinationContactType | null;
}

/** Zod schema for a destination endpoint. */
export const DestinationEndpoint: z.ZodType<DestinationEndpointType> = z.object({
  uid: z.string().nullable().optional(),
  address: Address.optional(),
  instructions: z.string().nullable().optional(),
  contact: DestinationContact.nullable().optional(),
});

/**
 * Destination endpoint in the full document (uid is nullable, contact uses doc version).
 */
export interface DocDestinationEndpointType {
  uid: string | null;
  address: AddressType | null;
  instructions: string | null;
  contact: DocDestinationContactType | null;
}

/** Zod schema for a destination endpoint (document version). */
export const DocDestinationEndpoint: z.ZodType<DocDestinationEndpointType> = z.strictObject({
  uid: z.string().nullable(),
  address: Address,
  instructions: z.string().nullable(),
  contact: DocDestinationContact.nullable(),
});

/**
 * A destination pair — delivery and collection endpoints.
 *
 * `customer_collecting` is true when the customer picks up the items at our
 * warehouse for the delivery side of this pair. `customer_returning` is true
 * when the customer drops the items off at our warehouse for the collection
 * side. Both default to false (we deliver / we collect).
 */
export interface DestinationType {
  delivery: DestinationEndpointType;
  collection: DestinationEndpointType;
  customer_collecting?: boolean;
  customer_returning?: boolean;
}

/** Zod schema for a destination pair. */
export const Destination: z.ZodType<DestinationType> = z.object({
  delivery: DestinationEndpoint,
  collection: DestinationEndpoint,
  customer_collecting: z.boolean().optional(),
  customer_returning: z.boolean().optional(),
});

/**
 * Document-level destination pair. See `DestinationType` for flag semantics.
 */
export interface DocDestinationType {
  delivery: DocDestinationEndpointType;
  collection: DocDestinationEndpointType;
  customer_collecting: boolean;
  customer_returning: boolean;
}

/** Zod schema for a document-level destination pair. */
export const DocDestination: z.ZodType<DocDestinationType> = z.strictObject({
  delivery: DocDestinationEndpoint,
  collection: DocDestinationEndpoint,
  customer_collecting: z.boolean().default(false),
  customer_returning: z.boolean().default(false),
});

// ── Shared modifier types ─────────────────────────────────────────

/**
 * A rate-based charge applied to an item or order (tax or transaction fee).
 * uid references a tax doc (for taxes) or a product doc (for transaction fees).
 */
export interface PriceModifierType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  amount: number;
}

/** Zod schema for a rate-based price modifier (tax or transaction fee). */
export const PriceModifier: z.ZodType<PriceModifierType> = z.strictObject({
  uid: z.string(),
  name: z.string(),
  rate: z.number(),
  type: RateTypeEnum,
  amount: z.number(),
});

/**
 * Denormalized tax snapshot without computed amount — used on product catalog entries.
 * PriceModifier extends this shape with `amount` for order-time computation.
 */
export interface TaxRefType {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
}

/** Zod schema for a denormalized tax snapshot without computed amount. */
export const TaxRef: z.ZodType<TaxRefType> = z.strictObject({
  uid: z.string(),
  name: z.string(),
  rate: z.number(),
  type: RateTypeEnum,
});

/**
 * Discount applied to an item price. Nullable — null means no discount.
 * rate is per-unit for flat discounts (rate × quantity × days_factor = amount).
 */
export interface DiscountType {
  rate: number;
  type: RateType;
  amount: number;
}

/** Zod schema for an item discount. */
export const Discount: z.ZodType<DiscountType> = z.strictObject({
  rate: z.number(),
  type: RateTypeEnum,
  amount: z.number(),
});

/** Discount input — rate and type only. Amount is computed by calculateItemPrice. */
export interface DiscountInputType {
  rate: number;
  type: RateType;
}

/** Zod schema for a discount input (without computed amount). */
export const DiscountInput: z.ZodType<DiscountInputType> = z.object({
  rate: z.number(),
  type: RateTypeEnum,
});

// ── Input schemas ─────────────────────────────────────────────────

/**
 * Price breakdown for an order item (input — client sends partial data, server computes the rest).
 */
export interface ItemPriceType {
  base?: number;
  replacement?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  subtotal?: number;
  discount?: DiscountInputType | null;
  taxes?: Array<{ uid: string }>;
  total?: number;
}

/** Zod schema for item price breakdown (input). */
export const ItemPrice: z.ZodType<ItemPriceType> = z.object({
  base: z.number().optional(),
  replacement: z.number().nullable().optional(),
  chargeable_days: z.int().nullable().optional(),
  formula: PriceFormulaEnum.optional(),
  subtotal: z.number().optional(),
  discount: DiscountInput.nullable().optional(),
  taxes: z.array(z.object({ uid: z.string() })).optional(),
  total: z.number().optional(),
});

/**
 * An individual order item (rental, replacement, sale, service, surcharge, group header, or destination).
 */
export interface OrderItemType {
  uid: string;
  type: DocItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: ItemPriceType;
  stock_method?: StockMethodType;
  path: string[];
  inclusion_type?: InclusionTypeType | null;
  zero_priced?: boolean | null;
  uid_delivery?: string;
  uid_collection?: string;
  order_number?: number;
  uid_order?: string;
}

/** Zod schema for an individual order item (input). */
export const OrderItem: z.ZodType<OrderItemType> = z.object({
  uid: z.string(),
  type: DocItemTypeEnum,
  name: z.string().optional(),
  description: z.string().optional(),
  quantity: z.int().optional(),
  price: ItemPrice.optional(),
  stock_method: StockMethodEnum.optional(),
  path: z.array(z.string()),
  inclusion_type: InclusionTypeEnum.nullable().optional(),
  zero_priced: z.boolean().nullable().optional(),
  uid_delivery: z.string().optional(),
  uid_collection: z.string().optional(),
  order_number: z.number().optional(),
  uid_order: z.string().optional(),
});

/**
 * Input schema for POST /orders — what the endpoint accepts.
 */
export interface CreateOrderInputType {
  uid: string;
  organization: { uid: string };
  status: OrderStatusType;
  dates: OrderDatesType;
  tax_profile: TaxProfileType;
  destinations: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
}

/** Input schema for creating an order. */
export const CreateOrderInput: z.ZodType<CreateOrderInputType> = z.object({
  uid: z.string(),
  organization: z.object({ uid: z.string() }),
  status: OrderStatus,
  dates: OrderDates,
  tax_profile: TaxProfileEnum,
  destinations: z.array(Destination).min(1, "At least one destination is required"),
  items: z.array(OrderItem)
    .refine(
      (items) => items.length === 0 || items[0].type === "destination",
      { message: "First item must be a destination divider" },
    )
    .optional(),
  subject: z.string().optional(),
  reference: z.string().nullable().optional(),
});

/**
 * Input schema for PUT /orders/:uid — partial update.
 */
export interface UpdateOrderInputType {
  uid?: string;
  organization?: { uid: string };
  status?: OrderStatusType;
  dates?: OrderDatesType;
  tax_profile?: TaxProfileType;
  destinations?: DestinationType[];
  items?: OrderItemType[];
  subject?: string;
  reference?: string | null;
  version: number;
}

/** Input schema for updating an order. */
export const UpdateOrderInput: z.ZodType<UpdateOrderInputType> = z.object({
  uid: z.string().optional(),
  organization: z.object({ uid: z.string() }).optional(),
  status: OrderStatus.optional(),
  dates: OrderDates.optional(),
  tax_profile: TaxProfileEnum.optional(),
  destinations: z.array(Destination).min(1, "At least one destination is required").optional(),
  items: z.array(OrderItem)
    .refine(
      (items) => items.length === 0 || items[0].type === "destination",
      { message: "First item must be a destination divider" },
    )
    .optional(),
  subject: z.string().optional(),
  reference: z.string().nullable().optional(),
  version: z.int().min(0),
});

// ── Full document schemas ────────────────────────────────────────

/**
 * Line item price in the full order document (all fields required after server compute).
 * subtotal = pre-discount (base × qty × days_factor).
 * subtotal_discounted = post-discount.
 * total = subtotal_discounted + sum(taxes[].amount).
 */
export interface OrderDocItemPriceType {
  base: number;
  replacement?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal: number;
  subtotal_discounted: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total: number;
}

export const OrderDocItemPrice: z.ZodType<OrderDocItemPriceType> = z.strictObject({
  base: z.number().default(0),
  replacement: z.number().nullable().optional(),
  chargeable_days: z.number().int().nullable().default(null),
  formula: PriceFormulaEnum.default("five_day_week"),
  subtotal: z.number().default(0),
  subtotal_discounted: z.number().default(0),
  discount: Discount.nullable().default(null),
  taxes: z.array(PriceModifier).default([]),
  total: z.number().default(0),
});

/** Line item in the full order document. */
export interface OrderDocLineItemType {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price?: OrderDocItemPriceType;
  stock_method?: StockMethodType;
  order_number?: number;
  uid_order?: string;
  path: string[];
  inclusion_type?: "default" | "mandatory" | "optional" | null;
  zero_priced?: boolean | null;
  crms_id?: number | null;
  uid_delivery?: string | null;
  uid_collection?: string | null;
}

export const OrderDocLineItem: z.ZodType<OrderDocLineItemType> = z.strictObject({
  uid: z.string(),
  type: DocLineItemTypeEnum,
  name: z.string().min(1).max(100),
  description: z.string().default(""),
  quantity: z.number().int().min(0).default(0),
  price: OrderDocItemPrice.optional(),
  stock_method: StockMethodEnum.optional(),
  order_number: z.number().optional(),
  uid_order: z.string().optional(),
  path: z.array(z.string()).default([]),
  inclusion_type: z.enum(INCLUSION_TYPES_NULLABLE).nullable().optional(),
  zero_priced: z.boolean().nullable().optional(),
  crms_id: z.number().nullable().optional(),
  uid_delivery: z.string().nullable().optional(),
  uid_collection: z.string().nullable().optional(),
}).refine(
  (item) => item.type !== "rental" || item.stock_method === "none" || item.price?.replacement != null,
  { message: "price.replacement is required for rental items", path: ["price", "replacement"] },
);

/** Destination divider item in the order document items array. */
export interface OrderDocDestinationItemType {
  uid: string;
  type: "destination";
  name: string;
  path: string[];
  uid_delivery: string | null;
  uid_collection: string | null;
  description: string;
}

/** Destination divider in items array. */
export const OrderDocDestinationItem: z.ZodType<OrderDocDestinationItemType> = z.strictObject({
  uid: z.uuid(),
  type: z.literal("destination"),
  name: z.string().max(200).default(""),
  path: z.array(z.string()).default([]),
  uid_delivery: z.string().nullable().default(null),
  uid_collection: z.string().nullable().default(null),
  description: z.string().default(""),
});

/** Group divider in items array. */
export interface OrderDocGroupItemType {
  uid: string;
  type: "group";
  name: string;
  path: string[];
  description: string;
}

export const OrderDocGroupItem: z.ZodType<OrderDocGroupItemType> = z.strictObject({
  uid: z.uuid(),
  type: z.literal("group"),
  name: z.string().min(1).max(100),
  path: z.array(z.string()).default([]),
  description: z.string().default(""),
});

/** Transaction fee line item in the full order document. */
export interface OrderDocTransactionFeeItemType {
  uid: string;
  type: "transaction_fee";
  name: string;
  path: string[];
  description: string;
  quantity: number;
  price: PriceModifierType;
  order_number?: number;
  uid_order?: string;
}

/** Zod schema for a transaction fee line item in the order document. */
export const OrderDocTransactionFeeItem: z.ZodType<OrderDocTransactionFeeItemType> = z.strictObject({
  uid: z.string(),
  type: z.literal("transaction_fee"),
  name: z.string().min(1).max(100),
  path: z.array(z.string()).default([]),
  description: z.string().default(""),
  quantity: z.number().int().min(0).default(0),
  price: PriceModifier,
  order_number: z.number().optional(),
  uid_order: z.string().optional(),
});

/** Union of all item types in the document. */
export const OrderDocItem: z.ZodType<OrderDocLineItemType | OrderDocDestinationItemType | OrderDocGroupItemType | OrderDocTransactionFeeItemType> = z.union([
  OrderDocLineItem,
  OrderDocDestinationItem,
  OrderDocGroupItem,
  OrderDocTransactionFeeItem,
]);

/** Order dates with Firestore timestamp companions. */
export interface OrderDocDatesType {
  delivery_start: string | null;
  delivery_start_fs: FirestoreTimestampType;
  delivery_end: string | null;
  delivery_end_fs: FirestoreTimestampType;
  collection_start: string | null;
  collection_start_fs: FirestoreTimestampType;
  collection_end: string | null;
  collection_end_fs: FirestoreTimestampType;
  charge_start: string | null;
  charge_start_fs: FirestoreTimestampType;
  charge_end: string | null;
  charge_end_fs: FirestoreTimestampType;
  days_active: number | null;
  days_charged: number | null;
}

/** Zod schema for order dates with Firestore timestamp companions. */
export const OrderDocDates: z.ZodType<OrderDocDatesType> = z.strictObject({
  delivery_start: chicagoInstant().nullable().default(null),
  delivery_start_fs: FirestoreTimestamp,
  delivery_end: chicagoInstant().nullable().default(null),
  delivery_end_fs: FirestoreTimestamp,
  collection_start: chicagoInstant().nullable().default(null),
  collection_start_fs: FirestoreTimestamp,
  collection_end: chicagoInstant().nullable().default(null),
  collection_end_fs: FirestoreTimestamp,
  charge_start: chicagoInstant().nullable().default(null),
  charge_start_fs: FirestoreTimestamp,
  charge_end: chicagoInstant().nullable().default(null),
  charge_end_fs: FirestoreTimestamp,
  days_active: z.int().nullable().default(null),
  days_charged: z.int().nullable().default(null),
});

/** Union of all item types stored in the order document. */
export type OrderDocItemType = OrderDocLineItemType | OrderDocDestinationItemType | OrderDocGroupItemType | OrderDocTransactionFeeItemType;

/** Type guard that narrows an order doc item to a line item (excludes destination/group dividers). */
export function isLineItem(item: OrderDocItemType): item is OrderDocLineItemType {
  return item.type !== "destination" && item.type !== "group";
}

/** Denormalized organization snapshot on the order document. */
const OrderDocOrganization = z.strictObject({
  uid: z.string().nullable(),
  name: z.string().min(1).max(100).meta({ pii: "mask" }),
  crms_id: z.number().nullable().optional(),
  xero_id: z.string().nullable().optional(),
  billing_address: Address.optional(),
});

/** Order totals. */
export interface OrderDocTotalsType {
  discount_amount: number;
  subtotal: number;
  subtotal_discounted: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total: number;
  replacement_total: number;
}

const OrderDocTotals: z.ZodType<OrderDocTotalsType> = z.strictObject({
  discount_amount: z.number().default(0),
  subtotal: z.number().default(0),
  subtotal_discounted: z.number().default(0),
  taxes: z.array(PriceModifier).default([]),
  transaction_fees: z.array(PriceModifier).default([]),
  total: z.number().default(0),
  replacement_total: z.number().default(0),
});

/**
 * Full order document schema (Firestore document shape).
 * Used for validation before writing to Firestore.
 */
export interface Order {
  uid: string;
  number: number;
  status: OrderStatusType;
  organization: {
    uid: string | null;
    name: string;
    crms_id?: number | null;
    xero_id?: string | null;
    billing_address?: AddressType | null;
  };
  dates: OrderDocDatesType;
  destinations: DocDestinationType[];
  items: OrderDocItemType[];
  tax_profile: TaxProfileType;
  totals: OrderDocTotalsType;
  invoices: Array<{ uid: string; number: number; status: InvoiceStatusType }>;
  query_by_invoices: string[];
  query_by_items: string[];
  query_by_contacts: string[];
  /**
   * Roll-up of breakdown across all bookings on this order. Mirrors the keys
   * of `stock-summaries.bookings_breakdown` and `booking.breakdown` but
   * aggregated along the order axis. Maintained incrementally by booking
   * writes (createOrder seeds it; updateBooking applies a delta).
   *
   * Invariant: sum of all values === sum of `booking.quantity` across the
   * order's bookings. The order is considered complete when
   * `quoted + reserved + prepped + out === 0` (every quantity has reached
   * a terminal state: returned, lost, or damaged).
   */
  bookings_breakdown: {
    quoted: number;
    reserved: number;
    prepped: number;
    out: number;
    returned: number;
    lost: number;
    damaged: number;
  };
  crms_id?: number | null;
  crms_status?: string;
  subject?: string;
  reference?: string | null;
  defaultThreadId?: string;
  version: number;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for the full order Firestore document. */
export const OrderSchema: z.ZodType<Order> = z.strictObject({
  uid: z.string(),
  number: z.int(),
  status: OrderStatus,
  organization: OrderDocOrganization,
  dates: OrderDocDates,
  destinations: z.array(DocDestination).min(1),
  items: z.array(OrderDocItem).default([]),
  tax_profile: TaxProfileEnum.default("tax_applied"),
  totals: OrderDocTotals,
  invoices: z.array(z.strictObject({ uid: z.string(), number: z.number(), status: InvoiceStatusEnum })).default([]),
  query_by_invoices: z.array(z.string()).default([]),
  query_by_items: z.array(z.string()).default([]),
  query_by_contacts: z.array(z.string()).default([]),
  bookings_breakdown: z.strictObject({
    quoted: z.number().default(0),
    reserved: z.number().default(0),
    prepped: z.number().default(0),
    out: z.number().default(0),
    returned: z.number().default(0),
    lost: z.number().default(0),
    damaged: z.number().default(0),
  }).default({ quoted: 0, reserved: 0, prepped: 0, out: 0, returned: 0, lost: 0, damaged: 0 }),
  crms_id: z.number().nullable().optional(),
  crms_status: z.string().optional(),
  subject: z.string().default(""),
  reference: z.string().max(255).nullable().default(null),
  defaultThreadId: z.string().optional(),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Order",
  collection: "orders",
  displayDefaults: {
    columns: ["number", "organization.name", "subject", "dates.delivery_start", "dates.collection_start", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
}) as z.ZodType<Order>;

// ── Shared utility types ─────────────────────────────────────────

/**
 * A consolidated line item — aggregated quantity and price for display.
 * Used by consolidateItems() in utilities and the manager app.
 */
export interface ConsolidatedItemType {
  uid: string;
  name: string;
  type: string;
  quantity: number;
  total_price: number;
  unit_price: number;
  stock_method: string;
}

/**
 * Path context for an item — which destination and group it belongs to.
 * Used by getGroupPath() in utilities and consumed by the manager app.
 */
export interface GroupPathType {
  destination: string | null;
  group: string | null;
  product: string | null;
}
