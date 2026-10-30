/**
 * Purchase bill and supplier credit schemas — Firestore collections
 * `purchase-bills` and `purchase-credits`.
 *
 * What a supplier BILLED CFS for a purchase (an ACCPAY bill, or a SPEND bank
 * transaction — a bill born paid), and what it CREDITED back (an ACCPAYCREDIT).
 * Many bills per purchase, each its own document; each bill product item bills
 * some quantity of one purchase item, and moves that item's `quantity_billed` in
 * the same transaction. Design: api-cloudrun#1210; the item shape,
 * api-cloudrun#1407.
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
 *   supplier's in `Reference`). Each product item must equal its purchase
 *   item's cumulative share for the quantity it bills, to the cent, and the
 *   total is the Σ of the items — refined here as far as one document can say it, and
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
 * ## A bill freezes under the invoice's rules (D10)
 *
 * `PURCHASE_BILL_FIELD_FREEZE` copies `INVOICE_FIELD_FREEZE` class for class,
 * and `purchaseBillIsFrozen` (`@cfs/core/utils/invoices`) is the invoice's money
 * predicate over a bill's totals. Nothing edits a bill yet (a bill is written
 * once), so the table is DECLARED here for whichever change adds a bill edit or
 * wires the projection merge. Supplier credits get no table, matching sales
 * credit notes.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ItemUid, OutOfServiceId, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import { COACode, type COACodeType } from "./chart-of-accounts.ts";
import { PURCHASE_PRODUCT_ITEM_TYPES, type PurchaseProductItemTypeType } from "./purchase.ts";
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

/**
 * A bill or credit item that PROJECTS a purchase item — some quantity of one
 * buy, subrent or usage item (D5). It names that item by `path_purchase_item`,
 * as an invoice line names its order line by `path_order_item`, and carries its
 * own copy of the shared fields, each of which it may override: the billed
 * `quantity` and `amount_cents` (homonyms of the purchase item's ordered ones),
 * `coa_posting` and `uid_tracking_category` (`propagate: true`).
 *
 * On a LINKED bill the posting is the Xero document's where it has one; the
 * purchase item's is the expected one, so an account divergence is an ordinary
 * field difference between projection and source (serialized-subrent § 7b).
 * That is why `coa_posting` here is any `COACode`, not the purchase arm's
 * subset.
 */
export interface PurchaseDocumentProductItem {
  type: PurchaseProductItemTypeType;
  uid: string;
  /** `[uid]` — flat, self-inclusive. */
  path: string[];
  name: string;
  uid_product: string;
  /** Units (or, on a usage or activation-billed subrent item, periods) this item bills or un-bills. */
  quantity: number;
  amount_cents: number;
  coa_posting: COACodeType;
  uid_tracking_category: string | null;
  /** The `path` of the purchase item this projects. */
  path_purchase_item: string[];
}

/**
 * A bill or credit item billing something that is not a purchase product item —
 * freight, a fee, or a supplier's loss or damage charge on a subrent. Posts to
 * its own account and never touches basis. `name` equals `description`.
 *
 * A **document-only** direct item (no `path_purchase_item`) is the document's
 * own row, like an invoice's loss-and-damage line: freight nobody expected, and
 * serialized-subrent's historic Vision bills. One that projects a purchase
 * `direct` item names it.
 *
 * ## Attribution (api-cloudrun#1360, #1364)
 *
 * - `uid_product` — the RENTAL product the spend is attributed to. The writer
 *   emits the product's Xero `ItemCode` beside the stated account; rental items
 *   are untracked in Xero, so the code moves no Xero quantity or value.
 * - `uid_out_of_service` — the record a loss or damage charge is for. A
 *   `mark_lost` record's id is a `MovementId`, hence `OutOfServiceId`.
 *
 * Both permanent `.optional()`: freight and fees name nothing. The tracking is
 * `uid_tracking_category`, a bare category uid as on every other line; the Xero
 * option is resolved when the body is built (line-tracking-uid D1), so the old
 * stamped `xero_tracking_option_id` is gone.
 */
export interface PurchaseDocumentDirectItem {
  type: "direct";
  uid: string;
  path: string[];
  name: string;
  description: string;
  quantity: number;
  amount_cents: number;
  coa_posting: COACodeType;
  uid_tracking_category: string | null;
  uid_product?: string;
  uid_out_of_service?: string;
  /** The purchase `direct` item this projects, or absent for a document-only row. */
  path_purchase_item?: string[];
}

/** Union of a bill or credit item's arms, discriminated on `type`. */
export type PurchaseDocumentItem = PurchaseDocumentProductItem | PurchaseDocumentDirectItem;

const docItemHead = {
  uid: ItemUid,
  path: z.array(ItemUid),
  name: z.string().min(1).max(4000).meta({ column: true, label: "Name" }),
};
// The shared keys carry their `propagate` tags on the PURCHASE declaration
// (`schemas/purchase.ts`); a tag on either schema counts. The billed quantity and
// amount are homonyms there.
const docItemMoney = {
  quantity: z.int().min(1).meta({ column: true, label: "Quantity" }),
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
  coa_posting: COACode,
  uid_tracking_category: FirestoreId.nullable(),
};

// Un-annotated so `_zod.propValues` survives for the discriminated union below.
const PurchaseDocumentProductItemInner = z.strictObject({
  type: z.enum(PURCHASE_PRODUCT_ITEM_TYPES).meta({ column: true, label: "Type" }),
  ...docItemHead,
  uid_product: FirestoreId,
  ...docItemMoney,
  // As invoice's `path_order_item`, but REQUIRED: a product item bills a
  // purchase item by definition.
  path_purchase_item: z.array(ItemUid).min(1),
});

const PurchaseDocumentDirectItemInner = z.strictObject({
  type: z.literal("direct").meta({ column: true, label: "Type" }),
  ...docItemHead,
  description: z.string().min(1).max(4000).meta({ column: true, label: "Description" }),
  ...docItemMoney,
  // Permanent `.optional()`: freight and fees attribute nothing (api-cloudrun#1360).
  uid_product: FirestoreId.optional(),
  uid_out_of_service: OutOfServiceId.optional(),
  // `seed: false`: `[]` fails `.min(1)`, so the form seed must omit the key —
  // exactly as invoice's `path_order_item`.
  path_purchase_item: z.array(ItemUid).min(1).optional().meta({ seed: false }),
});

/** Zod schema for PurchaseDocumentProductItem. */
export const PurchaseDocumentProductItemSchema: z.ZodType<PurchaseDocumentProductItem> =
  PurchaseDocumentProductItemInner;
/** Zod schema for PurchaseDocumentDirectItem. */
export const PurchaseDocumentDirectItemSchema: z.ZodType<PurchaseDocumentDirectItem> =
  PurchaseDocumentDirectItemInner;

/** Zod schema for any bill or credit item — discriminated on `type`. */
export const PurchaseDocumentItemSchema: z.ZodType<PurchaseDocumentItem> = z.discriminatedUnion("type", [
  PurchaseDocumentProductItemInner,
  PurchaseDocumentDirectItemInner,
]);

function documentItemsIssues(
  doc: { origin: PurchaseDocumentOriginType; items: PurchaseDocumentItem[] },
  total: number,
  totalPath: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const uids = new Set<string>();
  const projected = new Set<string>();
  doc.items.forEach((item, i) => {
    if (uids.has(item.uid)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "uid"], message: "an item uid appears once per document" });
    }
    uids.add(item.uid);
    if (item.path.length !== 1 || item.path[0] !== item.uid) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "an item's path is [uid] — flat, self-inclusive" });
    }
    // A purchase item is billed by at most one item of a document — the
    // successor of the old "one line per product", which stopped being true
    // when one product could sit on two purchase items.
    if (item.path_purchase_item !== undefined) {
      const key = item.path_purchase_item.join("/");
      if (projected.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", i, "path_purchase_item"],
          message: "a purchase item is billed by at most one item of a document",
        });
      }
      projected.add(key);
    }
  });
  // A document with value must say what it is for. A bill's `items` is also
  // `.min(1)` on its schema; a credit may be empty only at zero.
  if (doc.items.length === 0 && total > 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a document with value names at least one item" });
  }
  // A linked document's total is Xero's and is exempt (module docblock).
  if (doc.origin === "pushed") {
    const sum = doc.items.reduce((s, item) => s + item.amount_cents, 0);
    if (sum !== total) {
      ctx.addIssue({
        code: "custom",
        path: totalPath,
        message: `a pushed document's total ${total} must equal its items' ${sum}`,
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
  /**
   * The server's queryable mirror of `due_date`, so a "what's due" list can sort
   * and range-filter it (api-cloudrun#1223). Absent or `null` when `due_date` is
   * `null`. Optional only until the dev/prod backfill lands: a bill written
   * before it carries no mirror, and a required key would make those unreadable.
   */
  due_date_fs?: FirestoreTimestampType | null;
  /** The supplier's own invoice number. */
  reference: string | null;
  /** Product projections and direct items, one array (D5). */
  items: PurchaseDocumentItem[];
  totals: PurchaseBillTotals;
  uid_thread?: string;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

function checkPurchaseBill(b: PurchaseBill, ctx: z.RefinementCtx): void {
  documentItemsIssues(b, b.totals.total_cents, ["totals", "total_cents"], ctx);
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
  // Only one direction is asserted: a bill with no due date can carry no mirror.
  // The converse (a due date with no mirror) stays legal until the backfill runs.
  if (b.due_date === null && b.due_date_fs != null) {
    ctx.addIssue({ code: "custom", path: ["due_date_fs"], message: "due_date_fs must be absent or null when due_date is null" });
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
  due_date: chicagoStartOfDay().nullable().meta({ column: true, label: "Due Date", serverSortVia: "due_date_fs" }),
  due_date_fs: FirestoreTimestamp.nullable().optional(),
  reference: z.string().max(255).nullable().meta({ column: true, label: "Reference" }),
  // `.min(1)`: a bill bills at least one item. With direct items in the same
  // array that holds without a special case — a historic Vision bill is
  // document-only direct items (D5).
  items: z.array(PurchaseDocumentItemSchema).min(1).meta({ label: "Item" }),
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

// ── Bill field-class freeze table (D10) ──────────────────────────

/**
 * The classes a bill's editable fields fall into, for the freeze question
 * *"may an operator still change this field?"* — `INVOICE_FIELD_CLASSES` with
 * `organization` → `supplier` and `coa_revenue` → `coa_posting`.
 *
 * Explicit tuple type rather than `as const` alone (core#43).
 */
export const PURCHASE_BILL_FIELD_CLASSES: readonly [
  "supplier",
  "date",
  "line_money",
  "coa_posting",
  "tracking",
  "text",
] = ["supplier", "date", "line_money", "coa_posting", "tracking", "text"];

/** One of {@link PURCHASE_BILL_FIELD_CLASSES}. */
export type PurchaseBillFieldClass = typeof PURCHASE_BILL_FIELD_CLASSES[number];

/** When a bill field class freezes, and what Xero does with it once settled. */
export interface PurchaseBillFieldFreezeContract {
  /**
   * - `"frozen"` — while `purchaseBillIsFrozen` (`@cfs/core/utils/invoices`):
   *   any money settled against the bill, paid, credited or voided.
   * - `"void"` — only once the bill is void (`amount_void_cents ≠ 0`; a bill has
   *   no status).
   * - `"never"` — always editable.
   */
  frozen_when: "frozen" | "void" | "never";
  /**
   * Does Xero accept a change to this class on a bill it holds a payment or
   * credit allocation against? `false` everywhere, and `false` means "NOT
   * SHOWN", never "refused" — the invoice rule. Xero's 2026-03-19 changelog
   * relaxed edits to "non financial fields" on paid ACCPAY bills without
   * defining them, and CFS has measured none. Before any change sets
   * `tracking` to `true`, probe one paid bill with the invoice's settled-edit
   * shape (GET, round-trip Xero's own lines by `LineItemID`, change only
   * `Tracking`) — a write to the live ledger, so the owner's go-ahead first.
   */
  xero_accepts_on_settled: boolean;
  /** The document and item keys in the class, typed against the stored shapes. */
  members: readonly (keyof PurchaseBill | keyof PurchaseDocumentProductItem | keyof PurchaseDocumentDirectItem)[];
}

/**
 * **The one bill field-class freeze table** (owner, 2026-10-28). Read only
 * through `purchaseBillFieldIsFrozen` (`@cfs/core/utils/invoices`).
 *
 * `tracking` says `false` where the invoice says `true`: the invoice's `true`
 * records edits Xero has ALREADY ACCEPTED on paid ACCREC invoices, and no such
 * edit has been shown on an ACCPAY bill. `line_money` is decided over the
 * rebuilt items, as the invoice's `lineMoneyAgrees` does.
 */
export const PURCHASE_BILL_FIELD_FREEZE: Readonly<
  Record<PurchaseBillFieldClass, PurchaseBillFieldFreezeContract>
> = {
  supplier: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["supplier"] },
  date: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["date"] },
  line_money: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["quantity", "amount_cents"] },
  coa_posting: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["coa_posting"] },
  tracking: { frozen_when: "void", xero_accepts_on_settled: false, members: ["uid_tracking_category"] },
  text: {
    frozen_when: "never",
    xero_accepts_on_settled: false,
    members: ["reference", "due_date", "name", "description"],
  },
};

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
  /** Each product item UN-bills that quantity of its purchase item: it lowers `quantity_billed`. */
  items: PurchaseDocumentItem[];
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
  documentItemsIssues(c, c.total_cents, ["total_cents"], ctx);
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
  items: z.array(PurchaseDocumentItemSchema).meta({ label: "Item" }),
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

/** A bill or credit item as an operator matches it to a purchase item. */
export interface PurchaseDocumentItemInputType {
  /** The purchase item billed — by row identity, never by product. */
  uid_item: string;
  quantity: number;
}

/** Zod schema for PurchaseDocumentItemInputType. */
export const PurchaseDocumentItemInput: z.ZodType<PurchaseDocumentItemInputType> = z.object({
  uid_item: ItemUid,
  quantity: z.int().min(1),
});

/**
 * A document-only direct item as an operator states it on a PUSHED bill or
 * credit. The writer mints its `uid`/`path` and sets `name` = `description`.
 * `uid_tracking_category` absent takes the attributed product's category, else
 * none; `null` states none.
 *
 * ⚠️ **The node stays STRICT, though both push inputs embed it.** Stripping
 * would let an api that predates a field silently drop it rather than 400, and
 * an attribution would vanish with nothing failing (api-cloudrun#1360).
 */
export interface PurchaseDocumentDirectItemInputType {
  description: string;
  coa_posting: COACodeType;
  amount_cents: number;
  uid_product?: string;
  uid_out_of_service?: string;
  uid_tracking_category?: string | null;
}

// Not exported: it is reached only through the two push inputs, and an exported
// `*Input` would be a strict node of its own in `tests/input-strictness.test.ts`.
const PurchaseDocumentDirectItemInput: z.ZodType<PurchaseDocumentDirectItemInputType> = z.strictObject({
  description: z.string().min(1).max(4000),
  coa_posting: COACode,
  amount_cents: z.int().min(0),
  uid_product: FirestoreId.optional(),
  uid_out_of_service: OutOfServiceId.optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
});

/** Each purchase item once per write: it is billed by at most one item of a document. */
function uniqueItemInputs(items: readonly { uid_item: string }[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.uid_item)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "uid_item"], message: "one item per purchase item" });
    }
    seen.add(item.uid_item);
  });
}

/**
 * Input for billing a purchase — push a new ACCPAY, or link an existing Xero
 * bill or card payment.
 *
 * A PUSHED bill item carries no amount: the writer prices it at the purchase
 * item's cumulative share, so a price the purchase does not hold cannot be
 * billed, and stamps the purchase item's `name`, `coa_posting` and
 * `uid_tracking_category`. A LINKED bill carries `total_cents` as Xero has it.
 */
export type CreatePurchaseBillInputType =
  | {
    mode: "push";
    date: string;
    due_date: string;
    reference?: string | null;
    items: PurchaseDocumentItemInputType[];
    direct_items?: PurchaseDocumentDirectItemInputType[];
    uuid_session: string;
    version: number;
  }
  | {
    mode: "link";
    xero_document: PurchaseBillXeroDocumentType;
    xero_id: string;
    items: PurchaseDocumentItemInputType[];
    uuid_session: string;
    version: number;
  };

const pushBillInput = z.object({
  mode: z.literal("push"),
  date: chicagoStartOfDay(),
  due_date: chicagoStartOfDay(),
  reference: z.string().max(255).nullable().optional(),
  items: z.array(PurchaseDocumentItemInput),
  direct_items: z.array(PurchaseDocumentDirectItemInput).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

// A link reads date, due date, reference and total FROM Xero rather than from
// the caller, so the stored bill cannot disagree with the document it links.
const linkBillInput = z.object({
  mode: z.literal("link"),
  xero_document: PurchaseBillXeroDocumentEnum,
  xero_id: z.uuid(),
  items: z.array(PurchaseDocumentItemInput).min(1),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** Zod schema for CreatePurchaseBillInputType. */
export const CreatePurchaseBillInput: z.ZodType<CreatePurchaseBillInputType> = z.discriminatedUnion("mode", [
  pushBillInput,
  linkBillInput,
]).superRefine((b, ctx) => {
  uniqueItemInputs(b.items, ctx);
  if (b.mode === "push" && b.items.length + (b.direct_items?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a bill names at least one item or direct item" });
  }
}) as z.ZodType<CreatePurchaseBillInputType>;

/**
 * Input for recording a supplier credit against a purchase — push a new
 * ACCPAYCREDIT, or link one the supplier's credit was entered as in Xero.
 *
 * Each `items` entry UN-bills that quantity of its purchase item: it lowers
 * `quantity_billed`, and a PUSHED credit prices it at the item's cumulative
 * share of the range it un-bills, so a price the purchase does not hold cannot
 * be credited. A price correction with no quantity is a `direct_items` entry
 * (push only). A LINKED credit reads its date, reference and total from Xero,
 * as a linked bill does.
 */
export type CreatePurchaseCreditInputType =
  | {
    mode: "push";
    reason: PurchaseCreditReasonType;
    date: string;
    reference?: string | null;
    items: PurchaseDocumentItemInputType[];
    direct_items?: PurchaseDocumentDirectItemInputType[];
    uuid_session: string;
    version: number;
  }
  | {
    mode: "link";
    reason: PurchaseCreditReasonType;
    xero_id: string;
    items: PurchaseDocumentItemInputType[];
    uuid_session: string;
    version: number;
  };

const pushCreditInput = z.object({
  mode: z.literal("push"),
  reason: PurchaseCreditReasonEnum,
  date: chicagoStartOfDay(),
  reference: z.string().max(255).nullable().optional(),
  items: z.array(PurchaseDocumentItemInput),
  direct_items: z.array(PurchaseDocumentDirectItemInput).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

const linkCreditInput = z.object({
  mode: z.literal("link"),
  reason: PurchaseCreditReasonEnum,
  xero_id: z.uuid(),
  items: z.array(PurchaseDocumentItemInput),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** Zod schema for CreatePurchaseCreditInputType. */
export const CreatePurchaseCreditInput: z.ZodType<CreatePurchaseCreditInputType> = z.discriminatedUnion("mode", [
  pushCreditInput,
  linkCreditInput,
]).superRefine((c, ctx) => {
  uniqueItemInputs(c.items, ctx);
  if (c.mode === "push" && c.items.length + (c.direct_items?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a pushed credit names at least one item or direct item" });
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

/**
 * Input for reversing an allocation CFS has not yet pushed to Xero. `version` is
 * the CREDIT's, as an allocation's is. `uuid_session` keys the reversal.
 */
export interface ReversePurchaseCreditAllocationInputType {
  uuid_session: string;
  version: number;
}

/** Zod schema for ReversePurchaseCreditAllocationInputType. */
export const ReversePurchaseCreditAllocationInput: z.ZodType<ReversePurchaseCreditAllocationInputType> = z.object({
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/**
 * Input for voiding a supplier credit from CFS. `version` is the credit's.
 * Refused while anything draws on the credit — remove its allocations and
 * refunds in Xero first, as Xero itself requires.
 */
export interface VoidPurchaseCreditInputType {
  version: number;
}

/** Zod schema for VoidPurchaseCreditInputType. */
export const VoidPurchaseCreditInput: z.ZodType<VoidPurchaseCreditInputType> = z.object({
  version: z.int().min(0),
});
