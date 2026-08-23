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
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  DocumentOrganizationSnapshot,
  type DocumentOrganizationSnapshotType,
  checkItemPriceFormula,
  checkPriceBaseUnit,
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
  TimestampFields,
} from "./common.ts";
import {
  Discount,
  type DiscountType,
  PriceModifier,
  type PriceModifierType,
} from "./order.ts";
import { COACode } from "./chart-of-accounts.ts";

// ── Posting ──────────────────────────────────────────────────────

/** Xero's Bad Debt account. The one posting account a `reason` determines. */
export const COA_BAD_DEBT = 6900;

/**
 * Where a credit line posts, from the two facts that decide it.
 *
 * **Bad debt is not a revenue reversal, and that is the whole rule.** The money
 * *was* owed — the sale stands — and the write-off moves it to Bad Debt so it
 * can be written off: `DR 6900 / CR A/R`. Everything else is a return or an
 * allowance, where the customer never owed the money and the revenue itself is
 * reversed: `DR <the line's own revenue account> / CR A/R`. `early_return` is
 * the clearest case of the second kind.
 *
 * **New notes derive this; history does not obey it.** Of the 12 notes in the
 * live tenant, 8 agree and 4 are miscodings the owner has ruled historic rather
 * than sanctioned — CN-1007 books a bad-debt write-off to 4210 (revenue), and
 * CN-1010/1011/1012 book a customer credit to 6000 General Operating Expenses
 * on a free-text line whose `TaxType` is `INPUT`, a *purchase* tax type on a
 * receivable. CFS stores the corrected account and leaves Xero alone; the
 * divergence is recorded as a comment on the note's thread, and
 * `audit-credit-note-posting.ts` reports it. Xero still holds the original, so
 * nothing is lost by correcting.
 *
 * That is also why `coa_posting` is STORED rather than derived on read: the
 * stored value is what CFS asserts, this function is what CFS intends, and an
 * audit comparing them against Xero is a real guard precisely because the three
 * come from different places. Deriving on read would make the check a
 * restatement of its own oracle.
 *
 * `correction` is deliberately absent: it is bidirectional — an operator may be
 * adding a credit they missed or removing one that never happened — so its
 * posting depends on what is being corrected. Callers must supply it.
 *
 * @returns the account code, or `null` when the rule has no opinion.
 */
export function deriveCreditPostingAccount(
  reason: SettlementReasonType,
  coaRevenue: number | null,
): number | null {
  if (reason === "bad_debt") return COA_BAD_DEBT;
  if (reason === "correction" || reason === "unspecified") return null;
  return coaRevenue;
}

// ── Status ───────────────────────────────────────────────────────

/**
 * Credit-note lifecycle.
 *
 * **Deliberately three live states, with no `part_applied`.** The distinction a
 * partial member would draw is already carried by `remaining_credit_cents`, more
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
 * `applied` means **`remaining_credit_cents === 0`, however it got there** — by
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
}

const CreditNoteDocItemPriceSchema: z.ZodType<CreditNoteDocItemPrice> = z.strictObject({
  base_cents: z.int().default(0).meta({ column: true, label: "Base Price" }),
  base_percent: z.number().nullable().optional(),
  chargeable_days: z.number().nullable().default(null),
  formula: PriceFormulaEnum.default("fixed").meta({ column: true, label: "Formula" }),
  subtotal_cents: z.int().default(0).meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().default(0).meta({ column: true, label: "Discounted Subtotal" }),
  discount: Discount.nullable().default(null).meta({ label: "Discount" }),
  taxes: z.array(PriceModifier).default([]).meta({ label: "Tax" }),
  total_cents: z.int().default(0).meta({ column: true, label: "Total" }),
}).superRefine(checkPriceBaseUnit);

// ── Line items ───────────────────────────────────────────────────

/**
 * A credited line.
 *
 * **`coa_revenue` is required, not optional.** A credit spanning lines with
 * different revenue accounts (#1689 hits 4000 and 4100; #1322 is all 4210)
 * cannot be posted correctly from a document-level amount, and apportioning it
 * afterwards is inferring cause from effect — the thing `schemas/transaction.ts` warns
 * against. This is also the gap Xero *has*: its allocation view carries
 * `LineItems: []`, and Odoo's users pay OCA for a module that adds line-level
 * provenance.
 *
 * **No dividers.** A credit note has no destinations and bills no orders, so the
 * whole `ORDER_ITEM_LEVELS` / `INVOICE_ITEM_LEVELS` hierarchy — and the `path`
 * machinery that goes with it — has nothing to organize here. Lines are flat.
 *
 * ## `coa_revenue` and `coa_posting` are TWO facts, and a line has both
 *
 * They are routinely different, and collapsing them loses real information.
 * Measured on the live tenant: CN-1009 writes off 35 lines whose products are
 * rentals — `product.price.coa_revenue` 4000 Rental Income — and every one of
 * them posts to **6900 Bad Debt**. Store only the posting account and the
 * revenue attribution that tracking-category rollups and the tax tables depend
 * on is gone; store only the revenue account and the write-off is invisible.
 *
 * - **`coa_revenue`** — the revenue account of the *thing being credited*.
 *   Product-sourced, same vocabulary as the invoice line it mirrors. Never the
 *   account the credit posts to, and — since the owner ruling of 2026-08-20 —
 *   never an input to what the line is taxed either.
 * - **`coa_posting`** — where this credit lands in the ledger. Any account in
 *   the `chart-of-accounts` catalog, including the expense range, which is
 *   exactly why it cannot be `COARevenueEnum`: that enum is shared with
 *   `Product.price.coa_revenue`, and widening it would make a catalog product
 *   whose revenue account is Bad Debt Expense representable.
 */
export interface CreditNoteDocLineItem {
  uid: string;
  type: DocLineItemTypeType;
  name: string;
  description: string;
  quantity: number;
  price: CreditNoteDocItemPrice;
  /**
   * The revenue account of the thing credited. **Nullable**, matching
   * `InvoiceDocLineItem` — a credit can be raised on a free-text line with no
   * catalog product behind it, and the live tenant already holds one (CN-1012's
   * sole line has no `ItemCode`). A schema stricter than the invoice it credits
   * cannot represent the corpus.
   */
  coa_revenue: COARevenueType | null;
  /**
   * The account this credit posts to. See {@link deriveCreditPostingAccount} —
   * new notes derive it, history stores what actually happened.
   */
  coa_posting: number;
  tracking_category: string | null;
  xero_id: string | null;
  xero_tracking_option_id: string | null;
  /** The invoice line this credits, when the credit was raised from one. */
  uid_invoice_item: string | null;
}

const CreditNoteDocLineItemInner = z.strictObject({
  uid: ItemUid,
  type: z.enum(DOC_LINE_ITEM_TYPES).meta({ column: true, label: "Type" }),
  // Catalog product name — not customer data. See `OrderDocLineItem.name`.
  name: z.string().meta({ pii: "none", column: true }),
  description: z.string().meta({ pii: "none", column: true, label: "Description" }).default(""),
  quantity: z.int().default(0).meta({ column: true, label: "Quantity" }),
  price: CreditNoteDocItemPriceSchema,
  coa_revenue: COARevenueEnum.nullable(),
  coa_posting: COACode,
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
 * Integer cents, matching `items[]` and matching the `settlements` journal the
 * allocations are drawn into. **This document used to be dollars end to end**
 * while the journal beside it was already cents — a split that was recorded as
 * an intentional boundary and was in fact just drift, and which meant the 2dp
 * census had never evaluated this corpus at all.
 *
 * **No `transaction_fees`.** A card-processing fee is charged when money is
 * taken, not when it is given back; crediting one is an `order_adjustment` line,
 * not a fee row.
 */
export interface CreditNoteDocTotals {
  subtotal_cents: number;
  subtotal_discounted_cents: number;
  discount_amount_cents: number;
  taxes: PriceModifierType[];
  total_cents: number;
}

const CreditNoteDocTotalsSchema: z.ZodType<CreditNoteDocTotals> = z.strictObject({
  subtotal_cents: z.int().default(0).meta({ column: true, label: "Subtotal" }),
  subtotal_discounted_cents: z.int().default(0).meta({ column: true, label: "Discounted Subtotal" }),
  discount_amount_cents: z.int().default(0).meta({ column: true, label: "Discount" }),
  taxes: z.array(PriceModifier).default([]).meta({ label: "Tax" }),
  total_cents: z.int().default(0).meta({ column: true, label: "Total" }),
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
  organization: DocumentOrganizationSnapshotType;
  items: CreditNoteDocLineItem[];
  totals: CreditNoteDocTotals;
  /**
   * Value not yet consumed, in integer cents. `total_cents` minus every
   * unreversed allocation minus any cash refunded.
   *
   * A stored projection of the settlements that name this note, exactly as the
   * invoice's `amount_credited_cents` is — co-written in the same transaction.
   *
   * ⚠️ **NOT rebuildable from the journal, and an earlier revision of this line
   * said it was.** A cash refund consumes a note without touching any invoice,
   * so it appends no settlement row — there is none to append, since a
   * `Settlement` is keyed on `uid_invoice`. The status docblock above states the
   * same thing from the other side (*"however it got there"*), and the two
   * claims cannot both be true. Measured on prod 2026-08-16: CN-1013 ($485.06)
   * and CN-1016 ($62.16) are `applied` with `remaining_credit_cents: 0` and
   * **zero** rows naming them, and Xero agrees — `RemainingCredit: 0`,
   * `Allocations: []`, one `Payments[]` entry each. A rebuild from the journal
   * would hand both notes their full credit back and flip them out of
   * `applied`, re-opening $547.22 of credit that has already been paid out in
   * cash. Nothing rebuilds this field today — `allocateCreditNote` applies a
   * delta and `createCreditNote` seeds it — and nothing should start.
   * api-cloudrun#469.
   */
  remaining_credit_cents: number;
  sources: DocSourceType[];
  query_by_sources: string[];
  xero_credit_note_id: string | null;
  uid_thread?: string;
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

  // `applied` IS `remaining_credit_cents === 0` — the status is a materialized
  // derivation, so a document asserting one and storing the other is a
  // contradiction rather than a preference. A voided note is exempt: voiding
  // strands the balance rather than consuming it, which is exactly what the
  // three VOIDED notes in the live tenant look like (remaining == total).
  if (cn.status !== "void") {
    // Exactly zero. Both operands are integer cents, so the half-cent tolerance
    // this replaced no longer names a reachable state — and "exhausted" was
    // always meant to be exact anyway: `applied` IS `remaining === 0`.
    const exhausted = cn.remaining_credit_cents === 0;
    if (cn.status === "applied" && !exhausted) {
      ctx.addIssue({
        code: "custom",
        path: ["remaining_credit_cents"],
        message: "an applied credit note has no remaining credit",
      });
    }
    if (cn.status === "issued" && exhausted && cn.totals.total_cents !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "a fully consumed credit note is applied, not issued",
      });
    }
  }

  if (cn.remaining_credit_cents > cn.totals.total_cents) {
    ctx.addIssue({
      code: "custom",
      path: ["remaining_credit_cents"],
      message: "remaining_credit_cents cannot exceed the credit note's total_cents",
    });
  }
}

/** Zod schema for a CreditNote. */
export const CreditNoteSchema: z.ZodType<CreditNote> = z.strictObject({
  uid: FirestoreId,
  number: z.int().meta({ column: true, label: "#", linkTo: "creditNoteDetail", serverSortVia: "number" }),
  status: CreditNoteStatusEnum.meta({ column: true, label: "Status" }),
  reason: z.enum(
    CREDIT_NOTE_REASONS as unknown as [SettlementReasonType, ...SettlementReasonType[]],
  ).meta({ column: true, label: "Reason" }),
  // `chicagoStartOfDay()`, matching `Invoice.date` — this is an accounting
  // calendar date, not an instant. (A settlement's `date` is the opposite case
  // and uses `chicagoInstant()`; the two semantics are why both factories exist.)
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().nullable().default(null).meta({ column: true, label: "Reference", linkTo: "creditNoteDetail" }),
  external_notes: z.string().meta({ pii: "mask", column: true, label: "External Notes" }).nullable().optional(),
  internal_notes: z.string().meta({ pii: "mask", column: true, label: "Internal Notes" }).nullable().optional(),
  organization: DocumentOrganizationSnapshot,
  // `tax_profile` was DELETED here — api-cloudrun#596 item 3's contract third,
  // applied to prod (2,317 documents) and dev on 2026-08-22. The three steps
  // were forced, not ceremonial: every write validates the FULL document and
  // this is a `z.strictObject`, so a schema that has dropped the key REJECTS
  // every stored document still carrying it. Optional → empty storage → delete.
  items: z.array(CreditNoteDocLineItem).default([]).meta({ label: "Item" }),
  totals: CreditNoteDocTotalsSchema,
  remaining_credit_cents: z.int().default(0).meta({ column: true, label: "Remaining Credit" }),
  sources: z.array(DocSource).default([]),
  query_by_sources: z.array(z.string()).default([]),
  xero_credit_note_id: z.uuid().nullable().default(null),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkCreditNote).meta({
  title: "Credit Note",
  collection: "credit-notes",
  displayDefaults: {
    columns: [
      "number",
      "date",
      "organization.name",
      "reason",
      "totals.total_cents",
      "remaining_credit_cents",
    ],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});
