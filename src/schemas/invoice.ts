/**
 * Invoice document schema — Firestore collection: invoices
 */
import { z } from "zod";
import { FirestoreId, ItemUid } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import {
  ActorRef,
  type ActorRefType,
  Address,
  type AddressType,
  COARevenueEnum,
  type COARevenueType,
  DocLineItemTypeEnum,
  type DocLineItemTypeType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  PriceFormulaEnum,
  type PriceFormulaType,
  TaxProfileEnum,
  type InvoiceStatusType,
  InvoiceStatusEnum,
  type TaxProfileType,
  TimestampFields,
} from "./common.ts";
import {
  Discount,
  DiscountInput,
  type DiscountInputType,
  type DiscountType,
  DocDestinationEndpoint,
  type DocDestinationType,
  OrderDocDates,
  OrderDocDestinationItem,
  type OrderDocDestinationItemType,
  OrderDocGroupItem,
  type OrderDocGroupItemType,
  PriceModifier,
  type PriceModifierType,
} from "./order.ts";

export { type InvoiceStatusType } from "./common.ts";
const InvoiceStatus: z.ZodType<InvoiceStatusType> = InvoiceStatusEnum;

// Invoice item types are a superset of order item types — adds "order" divider.
// Billable types (DOC_LINE_ITEM_TYPES) are shared and unchanged.
const INVOICE_ITEM_TYPES = [
  "rental", "destination", "group", "order", "replacement", "sale", "service", "surcharge", "transaction_fee",
] as const;
/** Possible invoice item types (input — includes structural dividers + order divider). */
export type InvoiceItemTypeType = typeof INVOICE_ITEM_TYPES[number];
const InvoiceItemTypeEnum: z.ZodType<InvoiceItemTypeType> = z.enum(INVOICE_ITEM_TYPES);

const PAYMENT_STATUSES = ["active", "deleted"] as const;

// ── Payment tracking ─────────────────────────────────────────────

/** A payment received against this invoice (synced from Xero). */
export interface InvoicePayment {
  uid: string;
  xero_payment_id: string;
  date: string;
  amount: number;
  reference: string | null;
  status: typeof PAYMENT_STATUSES[number];
  synced_at?: FirestoreTimestampType;
}

const InvoicePaymentSchema: z.ZodType<InvoicePayment> = z.strictObject({
  uid: z.uuid(),
  xero_payment_id: z.string(),
  date: chicagoStartOfDay(),
  amount: z.number(),
  reference: z.string().nullable(),
  status: z.enum(PAYMENT_STATUSES),
  synced_at: FirestoreTimestamp.optional(),
});

// ── Item price ───────────────────────────────────────────────────

/** Pricing breakdown for a single invoice line item. */
export interface InvoiceDocItemPrice {
  base: number;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal: number;
  subtotal_discounted: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total: number;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  discount_percent?: number;
}

const InvoiceDocItemPriceSchema: z.ZodType<InvoiceDocItemPrice> = z.strictObject({
  base: z.number().default(0),
  chargeable_days: z.number().nullable().default(null),
  formula: PriceFormulaEnum.default("five_day_week"),
  subtotal: z.number().default(0),
  subtotal_discounted: z.number().default(0),
  discount: Discount.nullable().default(null),
  taxes: z.array(PriceModifier).default([]),
  total: z.number().default(0),
  discount_percent: z.number().optional(),
});

// ── Line items ───────────────────────────────────────────────────

/** A billable line item on an invoice. */
export interface InvoiceDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: InvoiceDocItemPrice;
  path: string[];
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
  xero_id?: string | null;
  xero_tracking_option_id?: string | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_opportunity_id?: number | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_id?: number | string | null;
}

export const InvoiceDocLineItemSchema: z.ZodType<InvoiceDocLineItem> = z.strictObject({
  uid: ItemUid,
  type: DocLineItemTypeEnum,
  name: z.string(),
  // Free-text — custom items routinely paraphrase the customer's request;
  // mask in fixtures + logs.
  description: z.string().meta({ pii: "mask" }).default(""),
  quantity: z.number().default(0),
  price: InvoiceDocItemPriceSchema,
  path: z.array(ItemUid).default([]),
  coa_revenue: COARevenueEnum.nullable().optional(),
  tracking_category: z.string().nullable().optional(),
  xero_id: z.uuid().nullable().optional(),
  xero_tracking_option_id: z.uuid().nullable().optional(),
  crms_opportunity_id: z.number().nullable().optional(),
  crms_id: z.union([z.number(), z.string()]).nullable().optional(),
});

// ── Order divider ───────────────────────────────────────────────

/** Order divider item — scopes invoice items to a source order for multi-order invoices. */
export interface InvoiceDocOrderItemType {
  uid: string;
  type: "order";
  name: string;
  path: string[];
  description: string;
}

/** Zod schema for an order divider item. */
export const InvoiceDocOrderItem: z.ZodType<InvoiceDocOrderItemType> = z.strictObject({
  // Option B: the order divider's identity IS the source order's Firestore doc-id
  // (order.uid), not a synthesized UUID — so this is z.string(), not z.uuid().
  uid: ItemUid,
  type: z.literal("order"),
  // Operator-typed divider label — often references the source order/customer.
  name: z.string().max(200).meta({ pii: "mask" }).default(""),
  path: z.array(ItemUid).default([]),
  description: z.string().meta({ pii: "mask" }).default(""),
});

// ── Item union ──────────────────────────────────────────────────

/** Union of all item types stored in an invoice document. */
export type InvoiceDocItemType = InvoiceDocLineItem | OrderDocGroupItemType | OrderDocDestinationItemType | InvoiceDocOrderItemType;

/** Zod schema for any invoice document item (line item, group, destination, or order divider). */
export const InvoiceDocItem: z.ZodType<InvoiceDocItemType> = z.union([
  InvoiceDocLineItemSchema,
  OrderDocGroupItem,
  OrderDocDestinationItem,
  InvoiceDocOrderItem,
]);

/** Type guard that narrows an invoice doc item to a billable line item (excludes structural dividers). */
export function isInvoiceLineItem(item: InvoiceDocItemType): item is InvoiceDocLineItem {
  return item.type !== "destination" && item.type !== "group" && item.type !== "order";
}

// ── Totals ───────────────────────────────────────────────────────

/** Invoice-level totals with payment tracking. */
export interface InvoiceDocTotals {
  subtotal: number;
  subtotal_discounted: number;
  discount_amount: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total: number;
  amount_paid: number;
  amount_due: number;
}

const InvoiceDocTotalsSchema: z.ZodType<InvoiceDocTotals> = z.strictObject({
  subtotal: z.number().default(0),
  subtotal_discounted: z.number().default(0),
  discount_amount: z.number().default(0),
  taxes: z.array(PriceModifier).default([]),
  transaction_fees: z.array(PriceModifier).default([]),
  total: z.number().default(0),
  amount_paid: z.number().default(0),
  amount_due: z.number().default(0),
});

// ── Destinations ────────────────────────────────────────────────

/**
 * Destination pair on an invoice — mirrors the order's `DocDestinationType`
 * with a `uid_order` scope field so multi-order invoices can carry pairs
 * from several orders and have them selectively synced per source order.
 * Carries `dates` (rendered on the invoice) snapshotted from the source order.
 */
export interface InvoiceDocDestinationType extends DocDestinationType {
  uid_order: string;
}

export const InvoiceDocDestination: z.ZodType<InvoiceDocDestinationType> = z.strictObject({
  uid_order: FirestoreId,
  dates: OrderDocDates,
  delivery: DocDestinationEndpoint,
  collection: DocDestinationEndpoint,
  customer_collecting: z.boolean().default(false),
  customer_returning: z.boolean().default(false),
});

// ── Document schema ──────────────────────────────────────────────

/** An invoice document in the invoices Firestore collection. */
export interface Invoice {
  uid: string;
  number: number;
  status: InvoiceStatusType;
  query_by_orders: string[];
  number_orders: number[];
  tax_profile: TaxProfileType;
  date: string;
  date_fs?: FirestoreTimestampType;
  due_date?: string;
  due_date_fs?: FirestoreTimestampType;
  subject?: string | null;
  reference?: string | null;
  external_notes?: string | null;
  internal_notes?: string | null;
  organization: {
    uid: string | null;
    name: string;
    crms_id?: number | null;
    tax_profile: TaxProfileType;
    xero_id: string | null;
    billing_address: AddressType | null;
  };
  destinations: InvoiceDocDestinationType[];
  items: InvoiceDocItemType[];
  totals: InvoiceDocTotals;
  payments: InvoicePayment[];
  xero_id: string | null;
  uploadcare_uuid: string | null;
  pdf_generated_at: FirestoreTimestampType | null;
  pdf_versions: Array<{
    version: number;
    uploadcare_uuid: string;
    created_at: FirestoreTimestampType;
    created_by: ActorRefType;
    deleted_at: FirestoreTimestampType | null;
  }>;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_id?: number | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_opportunity_ids?: number[];
  defaultThreadId?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for an Invoice document. */
export const InvoiceSchema: z.ZodType<Invoice> = z.strictObject({
  uid: FirestoreId,
  number: z.number(),
  status: InvoiceStatus,
  query_by_orders: z.array(z.string()).default([]),
  number_orders: z.array(z.number()).default([]),
  tax_profile: TaxProfileEnum,
  date: chicagoStartOfDay(),
  date_fs: FirestoreTimestamp,
  due_date: chicagoStartOfDay().optional(),
  due_date_fs: FirestoreTimestamp.optional(),
  subject: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  external_notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  internal_notes: z.string().meta({ pii: "mask" }).nullable().optional(),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: z.string().meta({ pii: "mask" }),
    crms_id: z.number().nullable().optional(),
    tax_profile: TaxProfileEnum,
    xero_id: z.uuid().nullable(),
    billing_address: Address,
  }),
  destinations: z.array(InvoiceDocDestination).default([]),
  items: z.array(InvoiceDocItem).default([]),
  totals: InvoiceDocTotalsSchema,
  payments: z.array(InvoicePaymentSchema).default([]),
  xero_id: z.uuid().nullable(),
  uploadcare_uuid: uploadcareRef(z.string().nullable().default(null)),
  pdf_generated_at: FirestoreTimestamp.nullable().default(null),
  pdf_versions: z.array(z.strictObject({
    version: z.number(),
    uploadcare_uuid: uploadcareRef(z.string()),
    created_at: FirestoreTimestamp,
    created_by: ActorRef,
    deleted_at: FirestoreTimestamp.nullable(),
  })).default([]),
  crms_id: z.number().nullable().optional(),
  crms_opportunity_ids: z.array(z.number()).optional(),
  defaultThreadId: z.string().optional(),
  /** Optimistic-concurrency if-match token — bumped on every whole-doc write, not a revision pointer (mirrors orders/orgs/contacts). */
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).refine(
  (inv) => inv.query_by_orders.length === 0 || inv.destinations.length >= 1,
  { message: "destinations must be provided when the invoice is linked to at least one source order", path: ["destinations"] },
).meta({
  title: "Invoice",
  collection: "invoices",
  displayDefaults: {
    columns: ["number", "organization.name", "reference", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
});

// ── Input schemas ────────────────────────────────────────────────

/** Item price input — partial, server computes the rest. */
export interface InvoiceItemInputPrice {
  base?: number;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  discount?: DiscountInputType | null;
  taxes?: Array<{ uid: string }>;
}

const InvoiceItemInputPriceSchema: z.ZodType<InvoiceItemInputPrice> = z.object({
  base: z.number().optional(),
  chargeable_days: z.number().nullable().optional(),
  formula: PriceFormulaEnum.optional(),
  discount: DiscountInput.nullable().optional(),
  taxes: z.array(z.object({ uid: FirestoreId })).optional(),
});

/** Input version of an invoice item (covers line items, groups, destinations, and order dividers). */
export interface InvoiceItemInputType {
  uid: string;
  type?: InvoiceItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: InvoiceItemInputPrice;
  path?: string[];
  uid_order?: string;
  uid_delivery?: string;
  uid_collection?: string;
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
}

const InvoiceItemInputSchema: z.ZodType<InvoiceItemInputType> = z.object({
  uid: ItemUid,
  type: InvoiceItemTypeEnum.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  quantity: z.number().optional(),
  price: InvoiceItemInputPriceSchema.optional(),
  path: z.array(ItemUid).optional(),
  uid_order: FirestoreId.optional(),
  uid_delivery: FirestoreId.optional(),
  uid_collection: FirestoreId.optional(),
  coa_revenue: COARevenueEnum.nullable().optional(),
  tracking_category: z.string().nullable().optional(),
});

/** Input schema for POST /invoices — create an invoice from orders. */
export interface CreateInvoiceInputType {
  uid: string;
  query_by_orders: string[];
  organization: { uid: string };
  tax_profile: TaxProfileType;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  external_notes?: string;
  internal_notes?: string;
}

/** Input schema for creating an invoice. */
export const CreateInvoiceInput: z.ZodType<CreateInvoiceInputType> = z.object({
  uid: FirestoreId,
  query_by_orders: z.array(z.string()).min(1, "At least one source order is required"),
  organization: z.object({ uid: FirestoreId }),
  tax_profile: TaxProfileEnum,
  items: z.array(InvoiceItemInputSchema).optional(),
  destinations: z.array(InvoiceDocDestination).optional(),
  date: chicagoStartOfDay().optional(),
  due_date: chicagoStartOfDay().optional(),
  subject: z.string().optional(),
  reference: z.string().nullable().optional(),
  external_notes: z.string().meta({ pii: "mask" }).optional(),
  internal_notes: z.string().meta({ pii: "mask" }).optional(),
});

/** Input schema for PUT /invoices/:uid — partial update. */
export interface UpdateInvoiceInputType {
  status?: InvoiceStatusType;
  items?: InvoiceItemInputType[];
  destinations?: InvoiceDocDestinationType[];
  date?: string;
  due_date?: string;
  subject?: string;
  reference?: string | null;
  external_notes?: string;
  internal_notes?: string;
  version: number;
}

/** Input schema for updating an invoice. */
export const UpdateInvoiceInput: z.ZodType<UpdateInvoiceInputType> = z.object({
  status: InvoiceStatus.optional(),
  items: z.array(InvoiceItemInputSchema).optional(),
  destinations: z.array(InvoiceDocDestination).optional(),
  date: chicagoStartOfDay().optional(),
  due_date: chicagoStartOfDay().optional(),
  subject: z.string().optional(),
  reference: z.string().nullable().optional(),
  external_notes: z.string().meta({ pii: "mask" }).optional(),
  internal_notes: z.string().meta({ pii: "mask" }).optional(),
  version: z.int().min(0),
});

/** Input schema for PATCH /invoices/{uid}/payments/{payment_uid} — partial update of a single payment. */
export interface UpdatePaymentInputType {
  date?: string;
  amount?: number;
  reference?: string | null;
  status?: typeof PAYMENT_STATUSES[number];
  version: number;
}

/** Input schema for updating a single payment on an invoice. */
export const UpdatePaymentInput: z.ZodType<UpdatePaymentInputType> = z.object({
  date: chicagoStartOfDay().optional(),
  amount: z.number().positive().optional(),
  reference: z.string().nullable().optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  version: z.int().min(0),
});
