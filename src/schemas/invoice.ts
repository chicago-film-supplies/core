/**
 * Invoice document schema — Firestore collection: invoices
 */
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import {
  ActorRef,
  type ActorRefType,
  Address,
  type AddressType,
  checkItemPriceFormula,
  checkPriceBaseUnit,
  COARevenueEnum,
  type COARevenueType,
  DOC_LINE_ITEM_TYPES,
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
  isLineItemType,
} from "./common.ts";
import {
  Discount,
  DiscountInput,
  type DiscountInputType,
  type DiscountType,
  DocDestinationEndpoint,
  type DocDestinationType,
  OrderDocDates,
  type OrderDocDestinationItemType,
  type OrderDocGroupItemType,
  PriceModifier,
  type PriceModifierType,
} from "./order.ts";

export { type InvoiceStatusType } from "./common.ts";
const InvoiceStatus: z.ZodType<InvoiceStatusType> = InvoiceStatusEnum;

// ── Status contracts ────────────────────────────────────────────

/**
 * What one invoice status admits, on every axis anything in CFS asks about.
 *
 * Five hand-written status sets used to live in four repos, and three of them
 * were textually identical while a fourth looked identical and was not. As
 * columns they stop looking like duplicates of each other and start being
 * separate answers to separate questions — which is what makes collapsing them
 * safe where a naive merge was not.
 */
export interface InvoiceStatusContract {
  /**
   * Statuses an **operator** may move to via `PUT /invoices/{uid}`.
   *
   * **Not the legal transition graph**, and the distinction is load-bearing.
   * `derivePaymentStatus` produces `issued → part_paid → paid`, and both
   * `markInvoiceVoidedFromXero` and the CRMS void hook force `→ void` from any
   * state; none of those appear here, and all of them are correct. Applying
   * this column to a Xero-authoritative path would break it.
   */
  operator_moves: readonly InvoiceStatusType[];
  /**
   * Has the invoice **ever** reached Xero? `INVOICE_STATUSES \ {draft}`.
   *
   * `void` is a member and that is deliberate: `selectXeroInvoiceTwin` lets a
   * void CFS invoice adopt a VOIDED Xero twin, so excluding it would strand
   * every void invoice at `xero_id == null` and bury the exact divergence
   * `reconcile-xero-invoice-links.ts` exists to find.
   */
  reached_xero: boolean;
  /**
   * Is the invoice **currently** live in Xero — i.e. is a Xero counterpart
   * expected to exist and be non-VOIDED? The near-twin of `reached_xero`; the
   * two differ only on `void`, which is the whole reason both exist.
   */
  live_in_xero: boolean;
  /**
   * Is the embedded snapshot frozen — no longer rewritten by an organization
   * name/address cascade? Neither `reached_xero`'s nor `live_in_xero`'s
   * complement; a third question.
   *
   * This column is why `"voided"` — a string that is not a member of
   * {@link InvoiceStatusType} — silently matched nothing in three org-cascade
   * queries and re-wrote every VOID invoice on any org edit.
   */
  settled: boolean;
  /**
   * May an operator record a further payment against it? Deliberately excludes
   * `paid`: without that, a payment against a fully-settled invoice drives
   * `amount_due` negative, and `derivePaymentStatus` then re-derives `paid`
   * from it and absorbs the overpayment silently.
   */
  accepts_payment: boolean;
}

/**
 * The per-status contract table.
 *
 * The `Readonly<Record<InvoiceStatusType, …>>` annotation is what enforces
 * totality: a sixth status is a type error **here**, at the declaration, which
 * forces an answer to all five questions rather than defaulting four of them.
 * No separate parity guard — a `T extends keyof typeof TABLE` assertion beside
 * this would read `T extends T` and could not fail.
 *
 * Deliberately **not** carrying an `amounts` column. Two status↔amounts rules
 * were proposed and both were killed by paging all 962 prod invoices:
 * `paid ⟹ amount_due <= 0` fails on 20 of 813, and `issued ⟹ amount_paid == 0`
 * fails on **75 of 98** — a bucket whose money matches Xero to the cent and
 * whose `status` is what is stale. The arithmetic identity that did survive
 * (`amount_paid + amount_credited + amount_due == total`, exempting `void`)
 * ships separately as a `superRefine`, because it is the one rule that does not
 * mention status.
 */
export const INVOICE_STATUS_CONTRACTS: Readonly<
  Record<InvoiceStatusType, InvoiceStatusContract>
> = {
  draft: {
    operator_moves: ["issued", "void"],
    reached_xero: false,
    live_in_xero: false,
    settled: false,
    accepts_payment: false,
  },
  issued: {
    operator_moves: ["void"],
    reached_xero: true,
    live_in_xero: true,
    settled: false,
    accepts_payment: true,
  },
  part_paid: {
    operator_moves: ["void"],
    reached_xero: true,
    live_in_xero: true,
    settled: false,
    accepts_payment: true,
  },
  paid: {
    operator_moves: ["void"],
    reached_xero: true,
    live_in_xero: true,
    settled: true,
    accepts_payment: false,
  },
  void: {
    operator_moves: [],
    reached_xero: true,
    live_in_xero: false,
    settled: true,
    accepts_payment: false,
  },
};

/**
 * May an operator move `from` to `to` via `PUT /invoices/{uid}`?
 *
 * Read this rather than the column, so the manager cannot offer a button the
 * server will 400 — and so a status outside the vocabulary answers `false`
 * instead of throwing on an undefined lookup.
 */
export function canOperatorTransition(from: string, to: string): boolean {
  const contract = (INVOICE_STATUS_CONTRACTS as Record<string, InvoiceStatusContract | undefined>)[
    from
  ];
  return contract?.operator_moves.some((s) => s === to) ?? false;
}

/** Every status whose contract answers `true` for `column`. */
function statusesWhere(
  column: "reached_xero" | "live_in_xero" | "settled" | "accepts_payment",
): InvoiceStatusType[] {
  return (Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[])
    .filter((s) => INVOICE_STATUS_CONTRACTS[s][column]);
}

/**
 * Statuses whose Xero counterpart is expected to exist and be non-VOIDED.
 *
 * Was three textually identical copies — `lib/xeroQuoteStatus.ts`,
 * `services/invoices.ts` and `scripts/audit-xero-quotes.ts`, the last carrying
 * a "keep in lockstep" comment that nothing enforced.
 */
export const LIVE_IN_XERO_STATUSES: readonly InvoiceStatusType[] = statusesWhere("live_in_xero");

/**
 * Statuses that have **ever** reached Xero. Includes `void` — see
 * {@link InvoiceStatusContract.reached_xero}. NOT interchangeable with
 * {@link LIVE_IN_XERO_STATUSES}, which is exactly the mistake this pair exists
 * to prevent.
 */
export const REACHED_XERO_STATUSES: readonly InvoiceStatusType[] = statusesWhere("reached_xero");

/** Statuses whose embedded snapshot is frozen against org-cascade rewrites. */
export const SETTLED_STATUSES: readonly InvoiceStatusType[] = statusesWhere("settled");

/** Statuses that still admit a further payment. Excludes `paid` deliberately. */
export const ACCEPTS_PAYMENT_STATUSES: readonly InvoiceStatusType[] = statusesWhere(
  "accepts_payment",
);

// Invoice item types are a superset of order item types — they add the "order"
// divider. That superset had a name here (`InvoiceItemTypeType`, an alias of
// `ITEM_TYPES`) for exactly one purpose: typing the flat input schema's
// `type` field. Both input unions are discriminated now, so each arm names its
// own literal and the combined enum has no consumer left. The vocabulary itself
// still lives in `common.ts` (`ITEM_TYPES` / `ITEM_CONTRACTS`).

// ── Payment tracking: GONE, not deprecated ──────────────────────
//
// `Invoice.payments[]` and its `InvoicePayment` type were deleted here on
// 2026-08-03. Settlement lives in the top-level append-only `settlements`
// collection, which is what made credit notes expressible at all: Xero settles
// an invoice two ways — cash (`Payments[]`) and credit allocation
// (`CreditNotes[]`) — and this array could only ever model the first. Invoice
// #1322 recorded $4,495.62 as cash collected that was never collected, and
// every reconciliation reported it clean because CFS and Xero agreed on the one
// number they could both express.
//
// The field survived one beta past its replacement purely as PARSE TOLERANCE:
// `InvoiceSchema` is a `z.strictObject`, so an undeclared `payments` would have
// failed validation on the next write of any document still carrying one. That
// is now moot — `migrate-payments-to-settlements.ts --drop-legacy` stripped it
// from all 967 prod / 968 dev invoices on 2026-08-02, and
// `audit-settlement-totals.ts` reports both envs clean. A strict object is the
// enforcement: an invoice cannot acquire a `payments` array again.
//
// `PAYMENT_STATUSES` and `UpdatePaymentInput` went with it — the endpoints they
// typed (`POST /invoices/{uid}/payments`, `PATCH .../payments/{payment_uid}`)
// no longer exist, because correcting an append-only journal is another append.

// ── Item price ───────────────────────────────────────────────────

/** Pricing breakdown for a single invoice line item. */
export interface InvoiceDocItemPrice {
  base_cents: number;
  /** See {@link OrderDocItemPriceType.base_percent} — same biconditional. */
  base_percent?: number | null;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total_cents: number;
  /**
   * @deprecated Legacy CRMS field — not set on new invoices.
   *
   * A PERCENT, not money — no `_cents` suffix, and it must not acquire one.
   */
  discount_percent?: number;
}

const InvoiceDocItemPriceSchema: z.ZodType<InvoiceDocItemPrice> = z.strictObject({
  base_cents: z.int().default(0).meta({ column: true, label: "Base Price" }),
  base_percent: z.number().nullable().optional(),
  chargeable_days: z.number().nullable().default(null).meta({ column: true, label: "Chargeable Days" }),
  formula: PriceFormulaEnum.default("five_day_week").meta({ column: true, label: "Formula" }),
  subtotal_cents: z.int().default(0).meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().default(0).meta({ column: true, label: "Discounted Subtotal" }),
  discount: Discount.nullable().default(null).meta({ label: "Discount" }),
  taxes: z.array(PriceModifier).default([]).meta({ label: "Tax" }),
  total_cents: z.int().default(0).meta({ column: true, label: "Total" }),
  discount_percent: z.number().optional(),
}).superRefine(checkPriceBaseUnit);

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

// Un-annotated so `_zod.propValues` survives for the discriminated union below
// — see `_dividers.ts`.
const InvoiceDocLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none", column: true }),
  // Line-item text — not customer data. See `OrderDocLineItem.description`.
  description: z.string().meta({ pii: "none", column: true, label: "Description" }).default(""),
  quantity: z.int().default(0).meta({ column: true, label: "Quantity" }),
  price: InvoiceDocItemPriceSchema,
  path: z.array(ItemUid).default([]),
  coa_revenue: COARevenueEnum.nullable().optional(),
  tracking_category: z.string().nullable().optional(),
  xero_id: z.uuid().nullable().optional(),
  xero_tracking_option_id: z.uuid().nullable().optional(),
  crms_opportunity_id: z.int().nullable().optional(),
  crms_id: z.union([z.int(), z.string()]).nullable().optional(),
}).superRefine(checkItemPriceFormula);

export const InvoiceDocLineItemSchema: z.ZodType<InvoiceDocLineItem> = InvoiceDocLineItemInner;

// ── Order divider ───────────────────────────────────────────────

/** Order divider item — scopes invoice items to a source order for multi-order invoices. */
export interface InvoiceDocOrderItemType {
  uid: string;
  type: "order";
  name: string;
  path: string[];
  description: string;
}

const InvoiceDocOrderItemInner = z.strictObject({
  // Option B: the order divider's identity IS the source order's Firestore doc-id
  // (order.uid), not a synthesized UUID — so this is z.string(), not z.uuid().
  uid: ItemUid,
  type: z.literal("order"),
  // Machine-generated, not operator-typed: 218/218 order dividers in the dev
  // replica are literally `Order #NNN`. See `OrderDocLineItem.name`.
  name: z.string().max(200).meta({ pii: "none" }).default(""),
  path: z.array(ItemUid).default([]),
  description: z.string().meta({ pii: "none" }).default(""),
});

/** Zod schema for an order divider item. */
export const InvoiceDocOrderItem: z.ZodType<InvoiceDocOrderItemType> = InvoiceDocOrderItemInner;

// ── Item union ──────────────────────────────────────────────────

/** Union of all item types stored in an invoice document. */
export type InvoiceDocItemType = InvoiceDocLineItem | OrderDocGroupItemType | OrderDocDestinationItemType | InvoiceDocOrderItemType;

/**
 * Zod schema for any invoice document item — discriminated on `type`.
 *
 * The invoice side never carried a second `transaction_fee` claimant, so it was
 * always discriminable; it stayed a plain union only because the order side
 * wasn't. See `OrderDocItem`.
 */
export const InvoiceDocItem: z.ZodType<InvoiceDocItemType> = z.discriminatedUnion("type", [
  InvoiceDocLineItemInner,
  GroupDividerArm,
  DestinationDividerArm,
  InvoiceDocOrderItemInner,
]);

/**
 * Type guard that narrows an invoice doc item to a billable line item (excludes
 * structural dividers).
 *
 * The narrowing target is invoice-specific, but the DECISION is not: it is
 * `ITEM_CONTRACTS[type].kind`, shared with `isLineItem` in `order.ts`. Written
 * out by hand this read `!== "destination" && !== "group" && !== "order"` — one
 * clause longer than the order guard, which is exactly the kind of difference
 * that looks like a bug and is not.
 */
export function isInvoiceLineItem(item: InvoiceDocItemType): item is InvoiceDocLineItem {
  return isLineItemType(item.type);
}

// ── Totals ───────────────────────────────────────────────────────

/**
 * Invoice-level totals with settlement tracking.
 *
 * `amount_paid`, `amount_credited` and `amount_due` are a **co-written
 * projection** of the `settlements` journal — produced only by
 * `recomputeSettlementTotals`, written in the same transaction as the settlement
 * that changed them, and rebuildable from the log by
 * `scripts/repair-invoice-settlement-totals.ts`. They are not a denormalization
 * to apologise for; they are the target architecture, and the same shape
 * `stock-summaries` already has against the movement journal.
 *
 * `total` is NOT part of that projection — it derives from `items[]`. So the
 * rebuild is deliberately **partial**: it repairs the settlement-fed fields
 * without re-pricing anything.
 */
export interface InvoiceDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  transaction_fees: PriceModifierType[];
  total_cents: number;
  amount_paid_cents: number;
  /**
   * Value settled by credit note rather than cash. **Sits beside `total` and
   * never reduces it** — keeping "billed 18,196 / collected 16,000 / wrote off
   * 2,196" legible is the entire point.
   *
   * Optional so the compiler forces `?? 0` at every read until the migration has
   * stamped the ~962 pre-existing invoices.
   */
  amount_credited_cents?: number;
  /**
   * Value annulled by voiding the invoice. **The third settlement bucket**, and
   * the reason `amount_due_cents` on a void invoice is now derived like every
   * other invoice's instead of being assigned.
   *
   * A void used to be a *field override*: `amount_due_cents` was set to 0 while
   * the journal still folded to `total`. That forced the identity refine below
   * to exempt void invoices, which made the exemption a blind spot — an invoice
   * voided by a path that forgot to zero the balance looked exactly like one
   * that had zeroed it correctly, and 7 prod invoices sat that way undetected
   * (api-cloudrun#436). As a `void` settlement row the fold produces the 0
   * itself, so the identity holds on every invoice and the class becomes
   * visible to the corpus audit.
   *
   * Optional for the same reason as `amount_credited_cents`: the field postdates
   * the corpus, and `validateBeforeWrite` persists the RAW doc, so a schema
   * default would never materialize — it would only hide the absence from the
   * compiler at every read.
   */
  amount_void_cents?: number;
  amount_due_cents: number;
}

const InvoiceDocTotalsSchema: z.ZodType<InvoiceDocTotals> = z.strictObject({
  subtotal_cents: z.int().default(0).meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().default(0).meta({ column: true, label: "Discounted Subtotal" }),
  discount_amount_cents: z.int().default(0).meta({ column: true, label: "Discount" }),
  taxes: z.array(PriceModifier).default([]).meta({ label: "Tax" }),
  transaction_fees: z.array(PriceModifier).default([]).meta({ label: "Transaction Fee" }),
  total_cents: z.int().default(0).meta({ column: true, label: "Total" }),
  amount_paid_cents: z.int().default(0).meta({ column: true, label: "Amount Paid" }),
  // Bare `.optional()` with NO default, deliberately: ~962 prod invoices
  // predate the field, and `validateBeforeWrite` persists the RAW doc, so a
  // schema default would never materialize anyway — it would only hide the
  // absence from the compiler at every read.
  amount_credited_cents: z.int().optional().meta({ column: true, label: "Amount Credited" }),
  // Same: bare `.optional()`, no default. See the interface docblock.
  amount_void_cents: z.int().optional().meta({ column: true, label: "Amount Voided" }),
  // Unbounded on purpose: an over-credited invoice must stay negative.
  amount_due_cents: z.int().default(0).meta({ column: true, label: "Amount Due" }),
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
  delivery: DocDestinationEndpoint.meta({ label: "Delivery" }),
  collection: DocDestinationEndpoint.meta({ label: "Collection" }),
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
  date_fs: FirestoreTimestampType;
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
  xero_id: string | null;
  uploadcare_uuid: string | null;
  pdf_generated_at: FirestoreTimestampType | null;
  pdf_versions?: Array<{
    version: number;
    uploadcare_uuid: string;
    created_at: FirestoreTimestampType;
    created_by: ActorRefType;
    deleted_at: FirestoreTimestampType | null;
  }>;
  /**
   * CDN uploads this doc owns pending reconcile — the producer work list that
   * makes a displaced draft render collectable in-band instead of by the weekly
   * sweep.
   *
   * ABSENT on every doc written before this field existed and on any writer that
   * doesn't construct it — always read as `(doc.uploadcare_files ?? [])`.
   * `.default([])` does not materialize: `validateBeforeWrite` discards
   * `result.data` and callers write the RAW doc.
   *
   * `version_source` is the writer's snapshot of `invoice.version` (for quotes,
   * of `order.version`) — the staleness filter that decides which of N racing
   * renders promotes to `uploadcare_uuid`. Deliberately not named `version`:
   * `pdf_versions[].version` above already means a user-facing sequence number.
   */
  uploadcare_files?: Array<{
    uuid: string;
    version_source: number;
    created_at: FirestoreTimestampType;
  }>;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_id?: number | null;
  /** @deprecated Legacy CRMS field — not set on new invoices. */
  crms_opportunity_ids?: number[];
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for an Invoice document. */
export const InvoiceSchema: z.ZodType<Invoice> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "invoiceDetail" }),
  status: InvoiceStatus.meta({ column: true, label: "Status" }),
  query_by_orders: z.array(z.string()).default([]),
  number_orders: z.array(z.int()).default([]).meta({ column: true, label: "Order #" }),
  tax_profile: TaxProfileEnum.meta({ column: true, label: "Tax Profile" }),
  // The ISO field carries the annotation; its `_fs` Timestamp mirror is the
  // same column under the other encoding — see `FS_MIRROR_SUFFIX`.
  date: chicagoStartOfDay().meta({ column: true, label: "Date", serverSortVia: "date_fs" }),
  date_fs: FirestoreTimestamp,
  due_date: chicagoStartOfDay().optional().meta({ column: true, label: "Due Date", serverSortVia: "due_date_fs" }),
  due_date_fs: FirestoreTimestamp.optional(),
  subject: z.string().nullable().optional().meta({ column: true, label: "Subject", linkTo: "invoiceDetail" }),
  reference: z.string().nullable().optional().meta({ column: true, label: "Reference", linkTo: "invoiceDetail" }),
  external_notes: z.string().meta({ pii: "mask", column: true, label: "External Notes" }).nullable().optional(),
  internal_notes: z.string().meta({ pii: "mask", column: true, label: "Internal Notes" }).nullable().optional(),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: z.string().meta({ pii: "mask", column: true }),
    crms_id: z.int().nullable().optional(),
    tax_profile: TaxProfileEnum.meta({ column: true, label: "Tax Profile" }),
    xero_id: z.uuid().nullable(),
    billing_address: Address,
  }).meta({ label: "Organization" }),
  destinations: z.array(InvoiceDocDestination).default([]),
  items: z.array(InvoiceDocItem).default([]).meta({ label: "Item" }),
  totals: InvoiceDocTotalsSchema,
  xero_id: z.uuid().nullable(),
  uploadcare_uuid: uploadcareRef(z.string().nullable().default(null)),
  pdf_generated_at: FirestoreTimestamp.nullable().default(null),
  // Optional, not `.default([])`: the default never materializes (raw-doc write)
  // and 82 prod invoices already lack the field, so a required type licenses
  // unguarded `.map`/`.find` reads that 500 on those docs. Optional makes
  // `deno task check` fail on exactly those accesses.
  pdf_versions: z.array(z.strictObject({
    version: z.number(),
    uploadcare_uuid: uploadcareRef(z.string()),
    created_at: FirestoreTimestamp,
    // Not a display column — this is the PDF version's author, not the
    // invoice's, and it sits inside an array nothing tabulates.
    created_by: ActorRef,
    deleted_at: FirestoreTimestamp.nullable(),
  })).optional(),
  // `uuid` is a plain string, deliberately NOT `uploadcareRef()`: the sweep's
  // value harvest already protects it (full-document read, recursing arrays), so
  // tagging would only enlist a transient work list into the hand-written
  // extractors and the `refCounts` scan-anomaly canary. Exempted by name in
  // `uploadcare/dictionary.ts`.
  uploadcare_files: z.array(z.strictObject({
    uuid: z.string(),
    version_source: z.int().min(0),
    created_at: FirestoreTimestamp,
  })).optional(),
  crms_id: z.int().nullable().optional(),
  crms_opportunity_ids: z.array(z.int()).optional(),
  uid_thread: ThreadId.optional(),
  /** Optimistic-concurrency if-match token — bumped on every whole-doc write, not a revision pointer (mirrors orders/orgs/contacts). */
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).refine(
  (inv) => inv.query_by_orders.length === 0 || inv.destinations.length >= 1,
  { message: "destinations must be provided when the invoice is linked to at least one source order", path: ["destinations"] },
).refine(
  // EXACT, not a tolerance. Every operand is an integer count of cents, so
  // there is no representation error left to absorb and "within half a cent"
  // no longer describes anything — a half-cent gap is now unrepresentable, and
  // a one-cent gap is a real projection defect that the old epsilon would have
  // caught too.
  //
  // **The `void` exemption is RETIRED (api-cloudrun#436).** It read
  // `inv.status === "void" || …` because Xero closes a voided invoice's balance
  // while the journal still folded to `total` — true of the old field-override
  // model, and the cost was that the identity said nothing at all about a void
  // invoice. It could not distinguish "balance correctly zeroed" from "voided by
  // a path that forgot to zero it", which is the entire class #436 describes. A
  // void is now a `void` settlement summing into `amount_void_cents`, the fold
  // produces the 0 by itself, and the identity holds on all four buckets for
  // every invoice in the corpus.
  (inv) =>
    inv.totals.amount_paid_cents + (inv.totals.amount_credited_cents ?? 0) +
          (inv.totals.amount_void_cents ?? 0) +
          inv.totals.amount_due_cents === inv.totals.total_cents,
  {
    message:
      "amount_paid_cents + amount_credited_cents + amount_void_cents + amount_due_cents must equal total_cents exactly",
    path: ["totals", "amount_due_cents"],
  },
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
  base_cents?: number;
  base_percent?: number | null;
  chargeable_days?: number | null;
  formula?: PriceFormulaType;
  discount?: DiscountInputType | null;
  taxes?: Array<{ uid: string }>;
}

const InvoiceItemInputPriceSchema: z.ZodType<InvoiceItemInputPrice> = z.object({
  base_cents: z.int().optional(),
  base_percent: z.number().nullable().optional(),
  chargeable_days: z.number().nullable().optional(),
  formula: PriceFormulaEnum.optional(),
  discount: DiscountInput.nullable().optional(),
  taxes: z.array(z.object({ uid: FirestoreId })).optional(),
}).superRefine(checkPriceBaseUnit);

/**
 * A billable invoice line as a client sends it — the input mirror of
 * `InvoiceDocLineItemSchema`.
 *
 * `uid_order` / `uid_delivery` / `uid_collection` are absent on purpose. The
 * flat schema this replaces accepted all three on any item; `buildInvoiceItems`
 * reads the destination pair only on a destination divider and reads `uid_order`
 * nowhere at all (the order divider's identity IS the source order's uid — the
 * transitional field was retired in Phase D, and the manager stopped sending
 * it). Prod agrees: 0 of 8,744 invoice line items carry any of the three.
 */
export interface InvoiceItemInputLineType {
  uid: string;
  type: DocLineItemTypeType;
  name?: string;
  description?: string;
  quantity?: number;
  price?: InvoiceItemInputPrice;
  path?: string[];
  coa_revenue?: COARevenueType | null;
  tracking_category?: string | null;
}

// Un-annotated for `_zod.propValues`, `z.object` so unknown keys are stripped
// rather than rejected — see the note on `OrderItemLineInner`.
const InvoiceItemInputLineInner = z.object({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  // Line-item text — not customer data. See `OrderDocLineItem.description`.
  description: z.string().meta({ pii: "none" }).optional(),
  quantity: z.int().optional(),
  price: InvoiceItemInputPriceSchema.optional(),
  path: z.array(ItemUid).optional(),
  coa_revenue: COARevenueEnum.nullable().optional(),
  tracking_category: z.string().nullable().optional(),
}).superRefine(checkItemPriceFormula);

/** Zod schema for a billable invoice line (input). */
export const InvoiceItemInputLine: z.ZodType<InvoiceItemInputLineType> = InvoiceItemInputLineInner;

/** A destination divider as a client sends it. */
export interface InvoiceItemInputDestinationType {
  uid: string;
  type: "destination";
  name?: string;
  description?: string;
  path?: string[];
  uid_delivery?: string;
  uid_collection?: string;
}

// `z.strictObject`, unlike the line arm above — see the note on
// `OrderItemDestinationInner`: a divider has no extra stored fields for a client
// to ship back, so strictness turns "a divider carrying a price" into a 400 that
// names the key rather than a silent strip.
const InvoiceItemInputDestinationInner = z.strictObject({
  uid: ItemUid,
  type: z.literal("destination"),
  // Venue label, not a person. See `DestinationDividerArm.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid).optional(),
  uid_delivery: FirestoreId.optional(),
  uid_collection: FirestoreId.optional(),
});

/** Zod schema for a destination divider (invoice input). */
export const InvoiceItemInputDestination: z.ZodType<InvoiceItemInputDestinationType> =
  InvoiceItemInputDestinationInner;

/** A group divider as a client sends it. */
export interface InvoiceItemInputGroupType {
  uid: string;
  type: "group";
  name?: string;
  description?: string;
  path?: string[];
}

// Strict for the same reason as the destination arm above.
const InvoiceItemInputGroupInner = z.strictObject({
  uid: ItemUid,
  type: z.literal("group"),
  // Section header drawn from the catalog. See `GroupDividerArm.name`.
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid).optional(),
});

/** Zod schema for a group divider (invoice input). */
export const InvoiceItemInputGroup: z.ZodType<InvoiceItemInputGroupType> = InvoiceItemInputGroupInner;

/** An order divider as a client sends it — invoice-only, scopes items to a source order. */
export interface InvoiceItemInputOrderType {
  uid: string;
  type: "order";
  name?: string;
  description?: string;
  path?: string[];
}

// Strict for the same reason as the destination arm above.
const InvoiceItemInputOrderInner = z.strictObject({
  // The divider's identity IS the source order's doc id — see
  // `InvoiceDocOrderItem`.
  uid: ItemUid,
  type: z.literal("order"),
  name: z.string().meta({ pii: "none" }).optional(),
  description: z.string().meta({ pii: "none" }).optional(),
  path: z.array(ItemUid).optional(),
});

/** Zod schema for an order divider (invoice input). */
export const InvoiceItemInputOrder: z.ZodType<InvoiceItemInputOrderType> = InvoiceItemInputOrderInner;

/** Input version of an invoice item — a line, or one of the three dividers. */
export type InvoiceItemInputType =
  | InvoiceItemInputLineType
  | InvoiceItemInputDestinationType
  | InvoiceItemInputGroupType
  | InvoiceItemInputOrderType;

/**
 * Zod schema for an invoice item (input) — discriminated on `type`, mirroring
 * the stored {@link InvoiceDocItem} union.
 *
 * `type` was itself `.optional()` here, which is why `buildInvoiceItems`
 * carried two `item.type ?? "rental"` defaults — and `rental` is the one type
 * whose stored contract demands a `price.replacement` that path never supplies,
 * so an item that omitted `type` was defaulted into the single most restrictive
 * shape. It is required now; the manager has always sent it (0 of 10,603 stored
 * invoice items lack one).
 *
 * The line arm comes first for the same `getInitialValues` reason as
 * {@link OrderItem}, and carries `checkItemPriceFormula` for the same reason —
 * it is the one contract axis an invoice price shape can answer (no
 * `stock_method`, no `price.replacement`; running the full check would reject
 * all 7,076 prod invoice rentals).
 *
 * NOTE there is deliberately no "first item must be a destination" refine on the
 * invoice side, unlike `CreateOrderInput`: 28 prod invoices legitimately start
 * with a line item — the flat CRMS invoices with no order divider at all.
 */
const InvoiceItemInputSchema: z.ZodType<InvoiceItemInputType> = z.discriminatedUnion("type", [
  InvoiceItemInputLineInner,
  InvoiceItemInputDestinationInner,
  InvoiceItemInputGroupInner,
  InvoiceItemInputOrderInner,
]);

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

