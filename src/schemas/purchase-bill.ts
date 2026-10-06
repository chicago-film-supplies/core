/**
 * Purchase bill and supplier credit schemas — Firestore collections
 * `purchase-bills` and `purchase-credits`.
 *
 * What a supplier BILLED CFS for a purchase (an ACCPAY bill, or a SPEND bank
 * transaction — a bill born paid), and what it CREDITED back (an ACCPAYCREDIT).
 * Many bills per purchase, each its own document; each bill line bills some
 * quantity of one purchase line, and moves that line's `quantity_billed` in the
 * same transaction. Plan: `api-cloudrun/.claude/plans/purchases.md`.
 *
 * ## Why not `invoices` with a direction
 *
 * A CFS invoice is an order PROJECTION — shared-field merge, destinations,
 * `priceDocument` tax, invoice actions, templates — and every one of those
 * readers would need a direction filter. A bill shares none of it. Supplier
 * credits are likewise not AR `credit-notes`: those carry an organization
 * snapshot, `priceCreditNote` tax and AR reasons.
 *
 * ## Pushed or linked
 *
 * `origin` says who authored the Xero document, and it decides which money rule
 * binds:
 *
 * - **`pushed`** — CFS authored it and POSTs it (`CFS-BILL-n` as the number, the
 *   supplier's in `Reference`). Each line must equal its purchase line's
 *   cumulative share for the quantity it bills, to the cent, and the total is
 *   the Σ of the lines — refined here as far as one document can say it, and
 *   the share itself asserted by the writer, which holds the purchase.
 * - **`linked`** — an existing Xero document CFS attaches to without pushing:
 *   every backfilled bill, and an operator linking a bill or card payment
 *   entered in Xero. Its total is XERO's, stored as Xero has it. P0 measured 21
 *   of 299 historic documents whose purchase-account lines disagree with the
 *   CFS basis (lines never received, lines coded off the purchase accounts), so
 *   a linked bill is EXEMPT from the share rule — the difference is reported by
 *   an audit, never refused.
 *
 * A **card-paid purchase is a linked `bank_transaction` bill** (owner,
 * 2026-10-05; 276 of the 299 historic documents are SPEND). It is never pushed,
 * carries no due date, and gets one payable payment settlement for its whole
 * total, so "billed" and "paid" need no second code path.
 *
 * ## Totals are a settlement projection
 *
 * `totals.amount_{paid,credited,void,due}_cents` are the invoice's keys exactly,
 * because `SETTLEMENT_CONTRACTS[type].sums_into` names those storage fields and
 * `recomputeSettlementTotals` never sees which document it is folding for. The
 * identity `paid + credited + void + due === total` is refined, as on the
 * invoice.
 *
 * No tax: purchases are resale-exempt (owner, 2026-10-05) and push `NoTax`.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  type SettlementReasonType,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";

// ── Shared vocabulary ────────────────────────────────────────────

/** Who authored the Xero document — see the module docblock. */
export const PURCHASE_DOCUMENT_ORIGINS = ["pushed", "linked"] as const;
/** One {@link PURCHASE_DOCUMENT_ORIGINS} member. */
export type PurchaseDocumentOriginType = typeof PURCHASE_DOCUMENT_ORIGINS[number];
/** Zod schema for PurchaseDocumentOriginType. */
export const PurchaseDocumentOriginEnum: z.ZodType<PurchaseDocumentOriginType> = z.enum(
  PURCHASE_DOCUMENT_ORIGINS,
);

/**
 * Which Xero collection a bill's `xero_id` lives in. A GUID cannot say: ACCPAY
 * bills and SPEND bank transactions are both plain GUIDs, which is the
 * ambiguity `Movement.xero_id` carries unresolved (api-cloudrun#1091). A bill
 * states it.
 */
export const PURCHASE_BILL_XERO_DOCUMENTS = ["invoice", "bank_transaction"] as const;
/** One {@link PURCHASE_BILL_XERO_DOCUMENTS} member. */
export type PurchaseBillXeroDocumentType = typeof PURCHASE_BILL_XERO_DOCUMENTS[number];
/** Zod schema for PurchaseBillXeroDocumentType. */
export const PurchaseBillXeroDocumentEnum: z.ZodType<PurchaseBillXeroDocumentType> = z.enum(
  PURCHASE_BILL_XERO_DOCUMENTS,
);

/** A bill or credit line: some quantity of ONE purchase line, keyed by product. */
export interface PurchaseDocumentLine {
  uid_product: string;
  quantity: number;
  amount_cents: number;
}

/** Zod schema for PurchaseDocumentLine. */
export const PurchaseDocumentLineSchema: z.ZodType<PurchaseDocumentLine> = z.strictObject({
  uid_product: FirestoreId,
  quantity: z.int().min(1).meta({ column: true, label: "Quantity" }),
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
});

/**
 * A line billing something that is not a product — freight, a fee. Posts to
 * its own account and never touches basis (landed cost is a follow-up).
 */
export interface PurchaseDirectLine {
  description: string;
  /** The Xero account the line posts to. */
  account_code: number;
  amount_cents: number;
}

/** Zod schema for PurchaseDirectLine. */
export const PurchaseDirectLineSchema: z.ZodType<PurchaseDirectLine> = z.strictObject({
  description: z.string().min(1).max(4000).meta({ column: true, label: "Description" }),
  account_code: z.int().min(0),
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
});

function documentLinesIssues(
  doc: { origin: PurchaseDocumentOriginType; lines: PurchaseDocumentLine[]; direct_lines: PurchaseDirectLine[] },
  total: number,
  totalPath: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  doc.lines.forEach((line, i) => {
    if (seen.has(line.uid_product)) {
      ctx.addIssue({
        code: "custom",
        path: ["lines", i, "uid_product"],
        message: "one line per product — a purchase line is billed by at most one line of a document",
      });
    }
    seen.add(line.uid_product);
  });
  // A bill's `lines` is `.min(1)` on the schema. A credit may carry only direct
  // lines (a rebate), but one with value must say what it is for.
  if (doc.lines.length + doc.direct_lines.length === 0 && total > 0) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "a document with value names at least one line" });
  }
  // A linked document's total is Xero's and is exempt (module docblock).
  if (doc.origin === "pushed") {
    const sum = doc.lines.reduce((s, l) => s + l.amount_cents, 0) +
      doc.direct_lines.reduce((s, l) => s + l.amount_cents, 0);
    if (sum !== total) {
      ctx.addIssue({
        code: "custom",
        path: totalPath,
        message: `a pushed document's total ${total} must equal its lines' ${sum}`,
      });
    }
  }
}

// ── Purchase bill ────────────────────────────────────────────────

/** A bill's settlement projection — the invoice's keys, see the module docblock. */
export interface PurchaseBillTotals {
  total_cents: number;
  amount_paid_cents: number;
  amount_credited_cents: number;
  amount_void_cents: number;
  amount_due_cents: number;
}

/** Zod schema for PurchaseBillTotals. */
export const PurchaseBillTotalsSchema: z.ZodType<PurchaseBillTotals> = z.strictObject({
  total_cents: z.int().min(0).meta({ column: true, label: "Total" }),
  amount_paid_cents: z.int().meta({ column: true, label: "Paid" }),
  amount_credited_cents: z.int().meta({ column: true, label: "Credited" }),
  amount_void_cents: z.int().meta({ column: true, label: "Voided" }),
  amount_due_cents: z.int().meta({ column: true, label: "Due" }),
});

/** A supplier bill against one purchase. */
export interface PurchaseBill {
  uid: string;
  /** Monotonic (`counters/purchase-bills`); pushed as `CFS-BILL-n`. Matches key on `uid` / `xero_id`, never this. */
  number: number;
  uid_purchase: string;
  /** Must equal the purchase's `supplier` — asserted by the writer. */
  supplier: UidNameRefType;
  origin: PurchaseDocumentOriginType;
  xero_document: PurchaseBillXeroDocumentType;
  /** Xero's `InvoiceID` or `BankTransactionID`; `null` only on a pushed bill not yet pushed. */
  xero_id: string | null;
  /** The bill date. A calendar date. */
  date: string;
  date_fs: FirestoreTimestampType;
  /**
   * `null` on a `bank_transaction` — a bill born paid is due on nothing — and on
   * a linked ACCPAY Xero holds without one (Xero does not require `DueDate`).
   * A pushed bill always states one: `CreatePurchaseBillInput` requires it.
   */
  due_date: string | null;
  /** The supplier's own invoice number. */
  reference: string | null;
  lines: PurchaseDocumentLine[];
  direct_lines: PurchaseDirectLine[];
  totals: PurchaseBillTotals;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

function checkPurchaseBill(b: PurchaseBill, ctx: z.RefinementCtx): void {
  documentLinesIssues(b, b.totals.total_cents, ["totals", "total_cents"], ctx);
  if (b.origin === "linked" && b.xero_id === null) {
    ctx.addIssue({ code: "custom", path: ["xero_id"], message: "a linked bill names the Xero document it links" });
  }
  if (b.xero_document === "bank_transaction") {
    if (b.origin !== "linked") {
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message: "a bank transaction is a card payment entered in Xero; CFS links it and never pushes one",
      });
    }
    if (b.due_date !== null) {
      ctx.addIssue({ code: "custom", path: ["due_date"], message: "a bill born paid is due on nothing; due_date must be null" });
    }
  }
  const t = b.totals;
  if (t.amount_paid_cents + t.amount_credited_cents + t.amount_void_cents + t.amount_due_cents !== t.total_cents) {
    ctx.addIssue({
      code: "custom",
      path: ["totals"],
      message: "amount_paid_cents + amount_credited_cents + amount_void_cents + amount_due_cents must equal total_cents exactly",
    });
  }
}

/** Zod schema for PurchaseBill. */
export const PurchaseBillSchema: z.ZodType<PurchaseBill> = z.strictObject({
  uid: FirestoreId,
  number: z.int().min(1).meta({ column: true, label: "#", linkTo: "purchaseBillDetail", serverSortVia: "number" }),
  uid_purchase: FirestoreId,
  supplier: UidNameRef.meta({ label: "Supplier" }),
  origin: PurchaseDocumentOriginEnum.meta({ column: true, label: "Origin" }),
  xero_document: PurchaseBillXeroDocumentEnum.meta({ column: true, label: "Xero Document" }),
  xero_id: z.uuid().nullable(),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  due_date: chicagoStartOfDay().nullable().meta({ column: true, label: "Due Date" }),
  reference: z.string().max(255).nullable().meta({ column: true, label: "Reference" }),
  // `.min(1)`: a bill bills at least one purchase line — that is what makes it
  // this purchase's. A freight-only bill from a carrier is an ordinary Xero bill.
  lines: z.array(PurchaseDocumentLineSchema).min(1).meta({ label: "Line" }),
  direct_lines: z.array(PurchaseDirectLineSchema).meta({ label: "Direct Line" }),
  totals: PurchaseBillTotalsSchema,
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkPurchaseBill).meta({
  title: "Purchase Bill",
  collection: "purchase-bills",
  displayDefaults: {
    columns: ["number", "date", "supplier.name", "reference", "totals.total_cents", "totals.amount_due_cents"],
    filters: {},
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "origin", label: "Origin", kind: "enum" },
    ],
  },
});

// ── Supplier credit ──────────────────────────────────────────────

/**
 * Why a supplier credited CFS. Closed, like `SETTLEMENT_REASONS`, and for the
 * same reason: it becomes a ledger code.
 *
 * **A subset of `SETTLEMENT_REASONS`, equal to `SETTLEMENT_CONTRACTS.bill_credit.reasons`**
 * — a `bill_credit` allocation row carries its credit's reason, as an AR `credit`
 * row does (`CREDIT_NOTE_REASONS`). Kept as its own `as const` tuple rather than
 * derived from the contract so `PurchaseCredit.reason` stays a narrow `z.enum`;
 * the subset is a compile-time check below and the equality is asserted by
 * `tests/settlements.test.ts`.
 */
export const PURCHASE_CREDIT_REASONS = [
  /** A short close left a line billed beyond what was received; auto-raised for the excess. */
  "short_close",
  /** The supplier corrected a price or quantity after billing. */
  "supplier_adjustment",
  /** An operator fixing their own record. */
  "correction",
] as const;
/** One {@link PURCHASE_CREDIT_REASONS} member. */
export type PurchaseCreditReasonType = typeof PURCHASE_CREDIT_REASONS[number];
// A reason here that the settlements journal cannot carry would be a credit
// whose allocation row cannot be written — a compile error, not a 400.
type _PurchaseCreditReasonsAreSettlementReasons = PurchaseCreditReasonType extends SettlementReasonType ? true
  : never;
const _purchaseCreditReasonParity: _PurchaseCreditReasonsAreSettlementReasons = true;
void _purchaseCreditReasonParity;
/** Zod schema for PurchaseCreditReasonType. */
export const PurchaseCreditReasonEnum: z.ZodType<PurchaseCreditReasonType> = z.enum(PURCHASE_CREDIT_REASONS);

/**
 * `issued` while it holds credit, `applied` once it holds none, `void` when
 * annulled — the AR credit note's vocabulary minus `draft` (a supplier credit is
 * raised by a close or recorded from the supplier, never drafted).
 */
export const PURCHASE_CREDIT_STATUSES = ["issued", "applied", "void"] as const;
/** One {@link PURCHASE_CREDIT_STATUSES} member. */
export type PurchaseCreditStatusType = typeof PURCHASE_CREDIT_STATUSES[number];
/** Zod schema for PurchaseCreditStatusType. */
export const PurchaseCreditStatusEnum: z.ZodType<PurchaseCreditStatusType> = z.enum(PURCHASE_CREDIT_STATUSES);

/** A supplier credit (ACCPAYCREDIT) against one purchase. */
export interface PurchaseCredit {
  uid: string;
  /** Monotonic (`counters/purchase-credits`). */
  number: number;
  uid_purchase: string;
  supplier: UidNameRefType;
  origin: PurchaseDocumentOriginType;
  reason: PurchaseCreditReasonType;
  status: PurchaseCreditStatusType;
  /** Xero's `CreditNoteID`; `null` only on a pushed credit not yet pushed. */
  xero_id: string | null;
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  /** Each line UN-bills that quantity of its purchase line: it lowers `quantity_billed`. */
  lines: PurchaseDocumentLine[];
  direct_lines: PurchaseDirectLine[];
  total_cents: number;
  /**
   * Credit not yet consumed: a **co-written projection** of the journal,
   * `purchaseCreditRemainingFromJournal(total_cents, rows)` — `total_cents` minus
   * every signed `bill_credit` allocation and `supplier_refund`. A supplier's
   * cash refund is a `supplier_refund` row, so unlike the AR note before
   * api-cloudrun#1207 this is rebuildable from the first document.
   */
  remaining_credit_cents: number;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

function checkPurchaseCredit(c: PurchaseCredit, ctx: z.RefinementCtx): void {
  documentLinesIssues(c, c.total_cents, ["total_cents"], ctx);
  if (c.origin === "linked" && c.xero_id === null) {
    ctx.addIssue({ code: "custom", path: ["xero_id"], message: "a linked credit names the Xero document it links" });
  }
  if (c.remaining_credit_cents < 0 || c.remaining_credit_cents > c.total_cents) {
    ctx.addIssue({
      code: "custom",
      path: ["remaining_credit_cents"],
      message: "remaining_credit_cents must lie between 0 and total_cents",
    });
  }
  // `applied` IS `remaining === 0`; a void strands the balance rather than
  // consuming it — the AR credit note's rule (`schemas/credit-note.ts`).
  if (c.status === "applied" && c.remaining_credit_cents !== 0) {
    ctx.addIssue({ code: "custom", path: ["remaining_credit_cents"], message: "an applied credit has no remaining credit" });
  }
  if (c.status === "issued" && c.remaining_credit_cents === 0 && c.total_cents !== 0) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "a fully consumed credit is applied, not issued" });
  }
}

/** Zod schema for PurchaseCredit. */
export const PurchaseCreditSchema: z.ZodType<PurchaseCredit> = z.strictObject({
  uid: FirestoreId,
  number: z.int().min(1).meta({ column: true, label: "#", linkTo: "purchaseCreditDetail", serverSortVia: "number" }),
  uid_purchase: FirestoreId,
  supplier: UidNameRef.meta({ label: "Supplier" }),
  origin: PurchaseDocumentOriginEnum.meta({ column: true, label: "Origin" }),
  reason: PurchaseCreditReasonEnum.meta({ column: true, label: "Reason" }),
  status: PurchaseCreditStatusEnum.meta({ column: true, label: "Status" }),
  xero_id: z.uuid().nullable(),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().max(255).nullable().meta({ column: true, label: "Reference" }),
  lines: z.array(PurchaseDocumentLineSchema).meta({ label: "Line" }),
  direct_lines: z.array(PurchaseDirectLineSchema).meta({ label: "Direct Line" }),
  total_cents: z.int().min(0).meta({ column: true, label: "Total" }),
  remaining_credit_cents: z.int().meta({ column: true, label: "Remaining Credit" }),
  uid_thread: ThreadId.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkPurchaseCredit).meta({
  title: "Supplier Credit",
  collection: "purchase-credits",
  displayDefaults: {
    columns: ["number", "date", "supplier.name", "reason", "total_cents", "remaining_credit_cents"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "reason", label: "Reason", kind: "enum" },
      { field: "status", label: "Status", kind: "enum" },
    ],
  },
});

// ── Inputs ───────────────────────────────────────────────────────

/** A bill or credit line as an operator matches it to a purchase line. */
export interface PurchaseDocumentLineInputType {
  uid_product: string;
  quantity: number;
}

/** Zod schema for PurchaseDocumentLineInputType. */
export const PurchaseDocumentLineInput: z.ZodType<PurchaseDocumentLineInputType> = z.object({
  uid_product: FirestoreId,
  quantity: z.int().min(1),
});

/**
 * Input for billing a purchase — push a new ACCPAY, or link an existing Xero
 * bill or card payment.
 *
 * A PUSHED bill line carries no amount: the writer prices it at the purchase
 * line's cumulative share, so a price the purchase does not hold cannot be
 * billed. A LINKED bill carries `total_cents` as Xero has it.
 */
export type CreatePurchaseBillInputType =
  | {
    mode: "push";
    date: string;
    due_date: string;
    reference?: string | null;
    lines: PurchaseDocumentLineInputType[];
    direct_lines?: PurchaseDirectLine[];
    uuid_session: string;
    version: number;
  }
  | {
    mode: "link";
    xero_document: PurchaseBillXeroDocumentType;
    xero_id: string;
    lines: PurchaseDocumentLineInputType[];
    uuid_session: string;
    version: number;
  };

const pushBillInput = z.object({
  mode: z.literal("push"),
  date: chicagoStartOfDay(),
  due_date: chicagoStartOfDay(),
  reference: z.string().max(255).nullable().optional(),
  lines: z.array(PurchaseDocumentLineInput).min(1),
  direct_lines: z.array(PurchaseDirectLineSchema).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

// A link reads date, due date, reference and total FROM Xero rather than from
// the caller, so the stored bill cannot disagree with the document it links.
const linkBillInput = z.object({
  mode: z.literal("link"),
  xero_document: PurchaseBillXeroDocumentEnum,
  xero_id: z.uuid(),
  lines: z.array(PurchaseDocumentLineInput).min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** Zod schema for CreatePurchaseBillInputType. */
export const CreatePurchaseBillInput: z.ZodType<CreatePurchaseBillInputType> = z.discriminatedUnion("mode", [
  pushBillInput,
  linkBillInput,
]).superRefine((b, ctx) => {
  const seen = new Set<string>();
  b.lines.forEach((line, i) => {
    if (seen.has(line.uid_product)) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "uid_product"], message: "one line per product" });
    }
    seen.add(line.uid_product);
  });
}) as z.ZodType<CreatePurchaseBillInputType>;

/**
 * Input for recording a supplier credit against a purchase — push a new
 * ACCPAYCREDIT, or link one the supplier's credit was entered as in Xero.
 *
 * Each `lines` entry UN-bills that quantity of its purchase line: it lowers
 * `quantity_billed`, and a PUSHED credit prices it at the line's cumulative
 * share of the range it un-bills, so a price the purchase does not hold cannot
 * be credited. A price correction with no quantity is a `direct_lines` entry
 * (push only). A LINKED credit reads its date, reference and total from Xero,
 * as a linked bill does.
 */
export type CreatePurchaseCreditInputType =
  | {
    mode: "push";
    reason: PurchaseCreditReasonType;
    date: string;
    reference?: string | null;
    lines: PurchaseDocumentLineInputType[];
    direct_lines?: PurchaseDirectLine[];
    uuid_session: string;
    version: number;
  }
  | {
    mode: "link";
    reason: PurchaseCreditReasonType;
    xero_id: string;
    lines: PurchaseDocumentLineInputType[];
    uuid_session: string;
    version: number;
  };

const pushCreditInput = z.object({
  mode: z.literal("push"),
  reason: PurchaseCreditReasonEnum,
  date: chicagoStartOfDay(),
  reference: z.string().max(255).nullable().optional(),
  lines: z.array(PurchaseDocumentLineInput),
  direct_lines: z.array(PurchaseDirectLineSchema).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

const linkCreditInput = z.object({
  mode: z.literal("link"),
  reason: PurchaseCreditReasonEnum,
  xero_id: z.uuid(),
  lines: z.array(PurchaseDocumentLineInput),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** Zod schema for CreatePurchaseCreditInputType. */
export const CreatePurchaseCreditInput: z.ZodType<CreatePurchaseCreditInputType> = z.discriminatedUnion("mode", [
  pushCreditInput,
  linkCreditInput,
]).superRefine((c, ctx) => {
  const seen = new Set<string>();
  c.lines.forEach((line, i) => {
    if (seen.has(line.uid_product)) {
      ctx.addIssue({ code: "custom", path: ["lines", i, "uid_product"], message: "one line per product" });
    }
    seen.add(line.uid_product);
  });
  if (c.mode === "push" && c.lines.length + (c.direct_lines?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "a pushed credit names at least one line or direct line" });
  }
}) as z.ZodType<CreatePurchaseCreditInputType>;

/**
 * Input for allocating some of a supplier credit to one bill of the same
 * supplier. `version` is the CREDIT's — the document whose balance the
 * allocation spends.
 */
export interface AllocatePurchaseCreditInputType {
  uid_purchase_bill: string;
  amount_cents: number;
  uuid_session: string;
  version: number;
}

/** Zod schema for AllocatePurchaseCreditInputType. */
export const AllocatePurchaseCreditInput: z.ZodType<AllocatePurchaseCreditInputType> = z.object({
  uid_purchase_bill: FirestoreId,
  amount_cents: z.int().min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});
