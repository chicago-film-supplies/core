/**
 * CreditNote document schema — Firestore collection: `credit-notes`
 *
 * The **value instrument**: a credit issued to an organization, with lines, tax,
 * a number and a remaining balance. Where it gets *applied* is not stored here —
 * an allocation is a `settlements` document, and `where("uid_credit_note","==",uid)`
 * is an ordinary query. Three of the four platforms surveyed (TigerBeetle, Odoo,
 * Xero) make the allocation its own record; the one that doesn't, ERPNext, is the
 * one whose seam is its documented failure source.
 *
 * **A first-class collection, not an invoice variant.** `Invoice` carries a
 * `query_by_orders` min-1 + destinations refine a credit note has no analogue
 * for, the Xero push targets a different endpoint, and `Discount.amount` is
 * `.min(0)` with sign-naive item math — so Odoo's positive-amount-with-a-type
 * trick would mean threading a direction sign through `calculateItemSubtotal`
 * and `getTaxTotals`. Against ~4 notes a year, a union would make all 962
 * invoices carry credit-note columns.
 *
 * **`credit-notes`, not `credits`.** Both fit the kebab-case-plural convention,
 * but `credit` is the most overloaded word in this space — it is the
 * double-entry *side*, it is TigerBeetle's `credits_pending`/`credits_posted`,
 * and it is the accounting sense throughout `chart-of-accounts`. A collection
 * called `credits` would collide head-on with the ledger vocabulary the moment
 * CFS owns its ledger, which is the stated destination.
 *
 * **Organization-scoped, not contact-scoped.** Xero's model is contact-scoped,
 * but CFS has no contact-scoped billing document and every invoice carries the
 * denormalized `organization` block. A contact-scoped document could not reuse
 * it and would lose the `organization.name` Typesense sort.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ItemUid } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  Address,
  type AddressType,
  checkItemPriceFormula,
  COARevenueEnum,
  type COARevenueType,
  DOC_LINE_ITEM_TYPES,
  type DocLineItemTypeType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  PriceFormulaEnum,
  type PriceFormulaType,
  SETTLEMENT_CONTRACTS,
  type SettlementReasonType,
  TaxProfileEnum,
  type TaxProfileType,
  TimestampFields,
} from "./common.ts";
import {
  Discount,
  type DiscountType,
  PriceModifier,
  type PriceModifierType,
} from "./order.ts";

// ── Status ───────────────────────────────────────────────────────

/**
 * Credit-note lifecycle.
 *
 * **Deliberately three live states, with no `part_applied`.** The distinction a
 * partial member would draw is already carried by `remaining_credit`, more
 * informatively — and adding it would invert the operator's primary query:
 * *"does this note still have credit I can allocate?"* is exactly
 * `status === "issued"` here, but would become `issued OR part_applied`.
 *
 * Grounded rather than guessed: across all 12 notes in the live tenant
 * (2026-08-01) `RemainingCredit` is either `0.00` or the full total — never in
 * between. Xero has no partial state either; it stays AUTHORISED until the
 * balance reaches zero. Even CN-1015, split across #1751 and #1767, landed both
 * allocations at once.
 *
 * `applied` means **`remaining_credit === 0`, however it got there** — by
 * allocation *or* by cash refund. CN-1013 and CN-1016 are PAID in Xero with a
 * Payment attached and zero allocations, and a cash refund IS a credit note
 * settled by cash rather than by allocation.
 */
const CREDIT_NOTE_STATUSES = ["draft", "issued", "applied", "void"] as const;
/** Allowed credit-note statuses. */
export type CreditNoteStatusType = typeof CREDIT_NOTE_STATUSES[number];
/** Zod schema for CreditNoteStatusType. */
export const CreditNoteStatusEnum: z.ZodType<CreditNoteStatusType> = z.enum(
  CREDIT_NOTE_STATUSES,
);

/**
 * Why this credit was issued — the `credit` arm of {@link SETTLEMENT_CONTRACTS},
 * **derived rather than re-listed**, so the document and the settlements it
 * spawns can never offer different reasons.
 *
 * The reason lives on the *document* and is denormalized onto each settlement:
 * one credit note allocated across three invoices has one reason, and authoring
 * it three times invites three answers.
 */
export const CREDIT_NOTE_REASONS: readonly SettlementReasonType[] =
  SETTLEMENT_CONTRACTS.credit.reasons;

// ── Item price ───────────────────────────────────────────────────

/** Pricing breakdown for a single credit-note line. */
export interface CreditNoteDocItemPrice {
  base: number;
  chargeable_days: number | null;
  formula: PriceFormulaType;
  subtotal: number;
  subtotal_discounted: number;
  discount: DiscountType | null;
  taxes: PriceModifierType[];
  total: number;
}

const CreditNoteDocItemPriceSchema: z.ZodType<CreditNoteDocItemPrice> = z.strictObject({
  base: z.number().default(0),
  chargeable_days: z.number().nullable().default(null),
  formula: PriceFormulaEnum.default("fixed"),
  subtotal: z.number().default(0),
  subtotal_discounted: z.number().default(0),
  discount: Discount.nullable().default(null),
  taxes: z.array(PriceModifier).default([]),
  total: z.number().default(0),
});

// ── Line items ───────────────────────────────────────────────────

/**
 * A credited line.
 *
 * **`coa_revenue` is required, not optional.** A credit spanning lines with
 * different revenue accounts (#1689 hits 4000 and 4100; #1322 is all 4210)
 * cannot be posted correctly from a document-level amount, and apportioning it
 * afterwards is inferring cause from effect — the thing `transaction.ts` warns
 * against. This is also the gap Xero *has*: its allocation view carries
 * `LineItems: []`, and Odoo's users pay OCA for a module that adds line-level
 * provenance.
 *
 * **No dividers.** A credit note has no destinations and bills no orders, so the
 * whole `ORDER_ITEM_LEVELS` / `INVOICE_ITEM_LEVELS` hierarchy — and the `path`
 * machinery that goes with it — has nothing to organize here. Lines are flat.
 */
export interface CreditNoteDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: CreditNoteDocItemPrice;
  coa_revenue: COARevenueType;
  tracking_category: string | null;
  xero_id: string | null;
  xero_tracking_option_id: string | null;
  /** The invoice line this credits, when the credit was raised from one. */
  uid_invoice_item: string | null;
}

const CreditNoteDocLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none" }),
  description: z.string().meta({ pii: "none" }).default(""),
  quantity: z.number().default(0),
  price: CreditNoteDocItemPriceSchema,
  coa_revenue: COARevenueEnum,
  tracking_category: z.string().nullable().default(null),
  xero_id: z.uuid().nullable().default(null),
  xero_tracking_option_id: z.uuid().nullable().default(null),
  uid_invoice_item: ItemUid.nullable().default(null),
}).superRefine(checkItemPriceFormula);

/** Zod schema for a credit-note line item. */
export const CreditNoteDocLineItem: z.ZodType<CreditNoteDocLineItem> = CreditNoteDocLineItemInner;

// ── Totals ───────────────────────────────────────────────────────

/**
 * Credit-note totals.
 *
 * Dollars, not cents — they sit beside `items[]` priced in dollars, and a
 * document that mixed both internally would be worse than either. The cents
 * boundary is the `settlements` journal; `total` here is what an allocation
 * draws *from*.
 *
 * **No `transaction_fees`.** A card-processing fee is charged when money is
 * taken, not when it is given back; crediting one is an `order_adjustment` line,
 * not a fee row.
 */
export interface CreditNoteDocTotals {
  subtotal: number;
  subtotal_discounted: number;
  discount_amount: number;
  taxes: PriceModifierType[];
  total: number;
}

const CreditNoteDocTotalsSchema: z.ZodType<CreditNoteDocTotals> = z.strictObject({
  subtotal: z.number().default(0),
  subtotal_discounted: z.number().default(0),
  discount_amount: z.number().default(0),
  taxes: z.array(PriceModifier).default([]),
  total: z.number().default(0),
});

// ── Document ─────────────────────────────────────────────────────

/** A credit note issued to an organization. */
export interface CreditNote {
  uid: string;
  /**
   * Monotonic, **never reused** — not even after a void.
   *
   * Xero frees a number when its holder is VOIDED or DELETED, and the live
   * tenant shows how routine that is: 4 of 12 notes are voided re-issues
   * (CN-1008→CN-1009, CN-1010+CN-1011→CN-1012). So **every match keys on `uid`
   * or `xero_credit_note_id`, never on `number`.**
   *
   * Stored bare. `CN-` is presentation only: no collection in this package
   * stores a prefixed string number, and `"CN-0001"` would break
   * `default_sorting_field: "number"`.
   */
  number: number;
  status: CreditNoteStatusType;
  reason: SettlementReasonType;
  /** The accounting issue date, and one of the two inputs to the allocation-date rule. */
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
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
  tax_profile: TaxProfileType;
  items: CreditNoteDocLineItem[];
  totals: CreditNoteDocTotals;
  /**
   * Value not yet consumed, in dollars. `total` minus every unreversed
   * allocation minus any cash refunded.
   *
   * A stored projection of the settlements that name this note, exactly as the
   * invoice's `amount_credited` is — co-written in the same transaction, and
   * rebuildable from the journal.
   */
  remaining_credit: number;
  sources: DocSourceType[];
  query_by_sources: string[];
  xero_credit_note_id: string | null;
  defaultThreadId?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

function checkCreditNote(cn: CreditNote, ctx: z.RefinementCtx): void {
  if (!CREDIT_NOTE_REASONS.includes(cn.reason)) {
    ctx.addIssue({
      code: "custom",
      path: ["reason"],
      message: `"${cn.reason}" is not a credit reason ` +
        `(expected one of: ${CREDIT_NOTE_REASONS.join(", ")})`,
    });
  }

  // `applied` IS `remaining_credit === 0` — the status is a materialized
  // derivation, so a document asserting one and storing the other is a
  // contradiction rather than a preference. A voided note is exempt: voiding
  // strands the balance rather than consuming it, which is exactly what the
  // three VOIDED notes in the live tenant look like (remaining == total).
  if (cn.status !== "void") {
    const exhausted = Math.abs(cn.remaining_credit) <= 0.005;
    if (cn.status === "applied" && !exhausted) {
      ctx.addIssue({
        code: "custom",
        path: ["remaining_credit"],
        message: "an applied credit note has no remaining credit",
      });
    }
    if (cn.status === "issued" && exhausted && cn.totals.total !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "a fully consumed credit note is applied, not issued",
      });
    }
  }

  if (cn.remaining_credit > cn.totals.total + 0.005) {
    ctx.addIssue({
      code: "custom",
      path: ["remaining_credit"],
      message: "remaining_credit cannot exceed the credit note's total",
    });
  }
}

/** Zod schema for a CreditNote. */
export const CreditNoteSchema: z.ZodType<CreditNote> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ label: "#", linkTo: "creditNoteDetail", serverSortVia: "number" }),
  status: CreditNoteStatusEnum,
  reason: z.enum(
    CREDIT_NOTE_REASONS as unknown as [SettlementReasonType, ...SettlementReasonType[]],
  ),
  // `chicagoStartOfDay()`, matching `Invoice.date` — this is an accounting
  // calendar date, not an instant. (A settlement's `date` is the opposite case
  // and uses `chicagoInstant()`; the two semantics are why both factories exist.)
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().nullable().default(null),
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
  tax_profile: TaxProfileEnum,
  items: z.array(CreditNoteDocLineItem).default([]),
  totals: CreditNoteDocTotalsSchema,
  remaining_credit: z.number().default(0),
  sources: z.array(DocSource).default([]),
  query_by_sources: z.array(z.string()).default([]),
  xero_credit_note_id: z.uuid().nullable().default(null),
  defaultThreadId: z.string().optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).superRefine(checkCreditNote).meta({
  title: "Credit Note",
  collection: "credit-notes",
  displayDefaults: {
    columns: ["number", "date", "organization.name", "reason", "totals.total", "remaining_credit"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});
