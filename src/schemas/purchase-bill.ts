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
 * ## Own collections, one MODEL (superseded ruling)
 *
 * This docblock used to argue against `invoices` with a direction: every AR
 * reader would need a direction filter. That argument stands for the
 * COLLECTION — bills and supplier credits stay their own collections (owner,
 * 2026-11-07) — and it was never an argument against sharing a MODEL.
 * api-cloudrun's `one-document-model` plan moves the supplier side onto the
 * customer side's: a bill is the payable twin of an invoice, a supplier credit
 * of a credit note, and every difference is an entry in `SIDE_CONTRACTS`
 * (`schemas/side.ts`) rather than a branch on the collection. No sign enters the
 * math; the side is derived from the collection, never stored.
 *
 * Phase 1 shares the LINE: the head (`LineItemCore`), the posting
 * (`LedgerPostingCore`, `ledger_account`) and the tax levers (`LineTaxCore`),
 * with the receivable line types labelled per side. The pricer, sync, diff and
 * status follow in later phases.
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
 * No tax is charged: purchases are resale-exempt (owner, 2026-10-05) and push
 * `NoTax`. A line still carries its type's tax class and `price.taxes: []` —
 * exemption, not absence (`PurchaseLinePrice`, `schemas/purchase.ts`).
 *
 * ## A bill freezes under the invoice's rules (D10)
 *
 * `PURCHASE_BILL_FIELD_FREEZE` copies `INVOICE_FIELD_FREEZE` class for class,
 * and `purchaseBillIsFrozen` (`@cfs/core/utils/invoices`) is the invoice's money
 * predicate over a bill's totals. `updatePurchaseBill` and the purchase → bill
 * sync both read it. Supplier credits get no table, matching sales credit notes.
 *
 * @module
 */
import { z } from "zod";
import { FirestoreId, ItemUid, OutOfServiceId, ThreadId, UnitId } from "./_uid.ts";
import { chicagoInstant, chicagoStartOfDay } from "./_datetime.ts";
import { COACode, type COACodeType } from "./chart-of-accounts.ts";
import {
  payablePostingIssues,
  PURCHASE_PRODUCT_ITEM_TYPES,
  type PurchaseLinePrice,
  purchaseLineMoneyIssues,
  type PurchaseProductItemTypeType,
} from "./purchase.ts";
import {
  ChargeWindow,
  type ChargeWindowType,
  Discount,
  DiscountInput,
  type DiscountInputType,
  PriceModifier,
  TaxRef,
} from "./order.ts";
import { LedgerPostingCore, LineItemCore, LineTaxCore } from "./_items.ts";
import { PriceFormulaRefSchema, RateKey, RateSnapshotSchema, TierCountSchema, type TierCountType } from "./price-formula.ts";
import { formulaMoneyMismatch } from "./_line-money.ts";
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
 * How a bill or credit line is priced: the purchase line's {@link PurchaseLinePrice}
 * (formula snapshot, rates, discount — each `propagate: true` there, so an
 * un-overridden bill line follows its purchase line; and the exempt tax keys)
 * plus the line's frozen metered `counts` (ruling 8).
 *
 * - **flat** — `rates: []`, `counts: []`; `amount_cents` is the stated net share.
 * - **time** — `rates` ≥ 1, and `counts` are the UNIT-periods the line bills:
 *   the engine's tier counts summed over every unit's windows, so the line's
 *   money is `priceFromFormula(rates, counts, 1, discount)` — quantity is
 *   folded into the counts, because each unit meters its own windows and a
 *   per-unit count does not factor out. On a PUSHED document the refine
 *   asserts `amount_cents` equals exactly that; a LINKED document's money is
 *   Xero's and is diffed, never refused.
 */
export interface PurchaseDocumentLinePrice extends PurchaseLinePrice {
  counts: TierCountType[];
}

/** Zod schema for {@link PurchaseDocumentLinePrice}. */
export const PurchaseDocumentLinePriceSchema: z.ZodType<PurchaseDocumentLinePrice> = z.strictObject({
  price_formula: PriceFormulaRefSchema,
  rates: z.array(RateSnapshotSchema).meta({ label: "Rate" }),
  discount: Discount.nullable().meta({ label: "Discount" }),
  taxes: z.array(PriceModifier).meta({ label: "Tax", derived: true }),
  taxes_base: z.array(TaxRef).optional().meta({ label: "Base Tax", derived: true }),
  counts: z.array(TierCountSchema).meta({ derived: true }),
});

/**
 * One unit's charge windows on a time bill line — what the SUPPLIER billed for
 * that unit, defaulted at create from the unit's unbilled windows
 * (`UnitType.charge_windows`) and owned by the line from then on. The windows
 * are core's time-only `ChargeWindow`; `uid_unit` names the unit (`MovementUnit`'s
 * spelling). The purchase↔bill diff compares their coverage with the units'.
 */
export interface PurchaseDocumentLineUnit {
  uid_unit: string;
  charge_windows: ChargeWindowType[];
}

/** Zod schema for PurchaseDocumentLineUnit. */
export const PurchaseDocumentLineUnitSchema: z.ZodType<PurchaseDocumentLineUnit> = z.strictObject({
  uid_unit: UnitId,
  charge_windows: z.array(ChargeWindow).min(1),
});

/**
 * The keys every bill or credit line carries beside its arm — the purchase
 * line's shared head, posting and tax cores (`schemas/_items.ts`, one instance
 * per key; see `PurchaseItemBase` for why `quantity` is still each grain's own),
 * plus the line's money and its time keys.
 *
 * `units` and `dates` are a time line's: the units billed with their windows,
 * and the span a span-metered formula (Verizon) reads. Required on every arm
 * since api-cloudrun#1425: a flat line states `units: []` and `dates: null`.
 *
 * `xero_id` is the Xero `LineItemID` of the line on the bill's Xero document —
 * the invoice line's `xero_id` twin. A pushed document takes it from the push
 * response; a linked one is backfilled from its Xero document, and a line that
 * cannot be paired is left `null` and listed, never guessed
 * (one-document-model, § Linked-bill tracking).
 */
interface PurchaseDocumentLineBase {
  uid: string;
  name: string;
  description: string;
  /** Units this item bills or un-bills (on a time line, the units its windows cover). */
  quantity: number;
  /** `[uid]` — flat, self-inclusive. */
  path: string[];
  zero_priced: boolean | null;
  quantity_per_parent?: number | null;
  ledger_account: COACodeType;
  uid_tracking_category: string | null;
  uid_tax_class: string;
  uid_tax_class_override?: string | null;
  /** Net money, integer cents. */
  amount_cents: number;
  price: PurchaseDocumentLinePrice;
  units: PurchaseDocumentLineUnit[];
  dates: ChargeWindowType | null;
  xero_id?: string | null;
}

/**
 * A bill or credit item that PROJECTS a purchase item — some quantity of one
 * sale (Buy) or rental (Subrent) item (D5). It names that item by
 * `path_purchase_item`, as an invoice line names its order line by
 * `path_order_item`, and carries its own copy of the shared fields, each of
 * which it may override until the bill is settled: the billed `quantity` and
 * `amount_cents` (homonyms of the purchase item's ordered ones), `price`,
 * `name`, `description`, `ledger_account`, `uid_tracking_category` and the tax
 * class (`propagate: true` on the shared declarations).
 *
 * On a LINKED bill the posting is the Xero document's where it has one; the
 * purchase item's is the expected one, so an account divergence is an ordinary
 * field difference between projection and source. The account still has to
 * sit in the type's class (`payablePostingIssues`).
 */
export interface PurchaseDocumentProductItem extends PurchaseDocumentLineBase {
  type: PurchaseProductItemTypeType;
  uid_product: string;
  /** The `path` of the purchase item this projects. */
  path_purchase_item: string[];
}

/**
 * A bill or credit SERVICE (Charge) line — freight, a fee, a carrier line.
 * Posts to its own account and never touches basis.
 *
 * A **document-only** service line (no `path_purchase_item`) is the document's
 * own row, like an invoice's loss-and-damage line: freight nobody expected.
 * One that projects a purchase `service` item names it.
 *
 * `uid_product` is attribution (api-cloudrun#1360, #1364): the writer emits the
 * product's Xero `ItemCode` beside the stated account when it has one; rental
 * items are untracked in Xero, so the code moves no Xero quantity or value.
 * Permanent `.optional()`: freight and fees name nothing.
 */
export interface PurchaseDocumentServiceItem extends PurchaseDocumentLineBase {
  type: "service";
  uid_product?: string;
  /** The purchase `service` item this projects, or absent for a document-only row. */
  path_purchase_item?: string[];
}

/**
 * A bill or credit REPLACEMENT line — the supplier billing CFS for its unit
 * lost or damaged in CFS's hands, naming the out-of-service record (until
 * 2026-11 a `charge` with `uid_out_of_service`). A `mark_lost` record's id is a
 * `MovementId`, hence `OutOfServiceId`.
 */
export interface PurchaseDocumentReplacementItem extends Omit<PurchaseDocumentServiceItem, "type"> {
  type: "replacement";
  uid_out_of_service: string;
}

/** Union of a bill or credit item's arms, discriminated on `type`. */
export type PurchaseDocumentItem =
  | PurchaseDocumentProductItem
  | PurchaseDocumentServiceItem
  | PurchaseDocumentReplacementItem;

// The shared head, posting and tax cores (one instance per key) and the line's
// own money. The shared keys carry their `propagate` tags on the shared
// declarations; a tag on either schema counts. The billed quantity and amount
// are homonyms (`propagate: false` on the purchase side).
const docItemHead = {
  uid: LineItemCore.uid,
  name: LineItemCore.name,
  description: LineItemCore.description,
};
const docItemShape = {
  quantity: z.int().min(1).meta({ column: true, label: "Quantity" }),
  path: LineItemCore.path,
  zero_priced: LineItemCore.zero_priced,
  quantity_per_parent: LineItemCore.quantity_per_parent,
  ...LedgerPostingCore,
  ...LineTaxCore,
  amount_cents: z.int().min(0).meta({ column: true, label: "Amount" }),
  price: PurchaseDocumentLinePriceSchema,
  units: z.array(PurchaseDocumentLineUnitSchema).meta({ label: "Unit" }),
  dates: ChargeWindow.nullable().meta({ label: "Span" }),
  // The invoice line's twin (`schemas/invoice.ts`), copied exactly.
  xero_id: z.uuid().nullable().optional(),
};

/**
 * A line's own shape rules — the purchase line's flat/time rule
 * (`purchaseLineMoneyIssues`), the type's posting class
 * (`payablePostingIssues`), and the bill line's: a flat line meters nothing
 * (no counts, no units), a unit appears once, and on a PUSHED document a time
 * line's money is exactly what its own snapshot reproduces.
 */
function documentLineIssues(
  item: PurchaseDocumentItem,
  origin: PurchaseDocumentOriginType,
): { path: (string | number)[]; message: string }[] {
  const basis = item.price?.price_formula.basis ?? "flat";
  // The purchase rule's rates half binds here too; its amount half does not —
  // a bill's time line carries the money it BILLS, which the purchase line
  // cannot know, so only the flat half of the amount rule is asked.
  const issues = purchaseLineMoneyIssues({
    price: item.price,
    amount_cents: basis === "time" ? null : item.amount_cents,
  });
  issues.push(...payablePostingIssues(item.type, item.ledger_account));
  const units = item.units ?? [];
  if (basis === "flat") {
    if ((item.price?.counts.length ?? 0) > 0) issues.push({ path: ["price", "counts"], message: "a flat line meters no counts" });
    if (units.length > 0) issues.push({ path: ["units"], message: "a flat line bills no unit windows" });
  } else if (origin === "pushed" && item.price) {
    const expected = formulaMoneyMismatch(item.price, 1, item.amount_cents);
    if (expected !== null) {
      issues.push({
        path: ["amount_cents"],
        message: Number.isNaN(expected)
          ? "a count names a rate key the line's rates do not carry"
          : `a pushed time line's amount ${item.amount_cents} must equal its rates × counts: ${expected}`,
      });
    }
  }
  const seen = new Set<string>();
  units.forEach((u, k) => {
    if (seen.has(u.uid_unit)) issues.push({ path: ["units", k, "uid_unit"], message: "a unit appears once per line" });
    seen.add(u.uid_unit);
  });
  return issues;
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below.
// The line rules run at the document level (`documentItemsIssues`), which knows
// the document's `origin`.
const PurchaseDocumentProductItemInner = z.strictObject({
  type: z.enum(PURCHASE_PRODUCT_ITEM_TYPES).meta({ column: true, label: "Type" }),
  ...docItemHead,
  ...docItemShape,
  uid_product: FirestoreId,
  // As invoice's `path_order_item`, but REQUIRED: a product item bills a
  // purchase item by definition.
  path_purchase_item: z.array(ItemUid).min(1),
});

const noCustodyLine = {
  ...docItemHead,
  ...docItemShape,
  // Permanent `.optional()`: freight and fees attribute nothing (api-cloudrun#1360).
  uid_product: FirestoreId.optional(),
  // `seed: false`: `[]` fails `.min(1)`, so the form seed must omit the key —
  // exactly as invoice's `path_order_item`.
  path_purchase_item: z.array(ItemUid).min(1).optional().meta({ seed: false }),
};

const PurchaseDocumentServiceItemInner = z.strictObject({
  type: z.literal("service").meta({ column: true, label: "Type" }),
  ...noCustodyLine,
});

const PurchaseDocumentReplacementItemInner = z.strictObject({
  type: z.literal("replacement").meta({ column: true, label: "Type" }),
  ...noCustodyLine,
  uid_out_of_service: OutOfServiceId,
});

/** Zod schema for PurchaseDocumentProductItem. */
export const PurchaseDocumentProductItemSchema: z.ZodType<PurchaseDocumentProductItem> =
  PurchaseDocumentProductItemInner;
/** Zod schema for PurchaseDocumentServiceItem. */
export const PurchaseDocumentServiceItemSchema: z.ZodType<PurchaseDocumentServiceItem> =
  PurchaseDocumentServiceItemInner;
/** Zod schema for PurchaseDocumentReplacementItem. */
export const PurchaseDocumentReplacementItemSchema: z.ZodType<PurchaseDocumentReplacementItem> =
  PurchaseDocumentReplacementItemInner;

/** Zod schema for any bill or credit item — discriminated on `type`. */
export const PurchaseDocumentItemSchema: z.ZodType<PurchaseDocumentItem> = z.discriminatedUnion("type", [
  PurchaseDocumentProductItemInner,
  PurchaseDocumentServiceItemInner,
  PurchaseDocumentReplacementItemInner,
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
    for (const issue of documentLineIssues(item, doc.origin)) {
      ctx.addIssue({ code: "custom", path: ["items", i, ...issue.path], message: issue.message });
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
  /** Product projections and charge items, one array (D5). */
  items: PurchaseDocumentItem[];
  totals: PurchaseBillTotals;
  /**
   * When the bill was voided, stamped by every void path. **Absent means not
   * voided.** `purchaseBillIsLive` (`@cfs/core/utils/invoices`) reads it as well as
   * `totals.amount_void_cents`, because a $0 bill's void folds to 0 and would
   * otherwise read live. A bare `.optional()` rather than `.nullable()` on purpose:
   * required-nullable would mean backfilling every bill, for a key only a void
   * ever writes. Not a display column and not a Typesense field:
   * `totals.amount_void_cents` already is both, and a new field would force a
   * `purchase-bills` reindex for nothing an operator reads.
   */
  voided_at?: FirestoreTimestampType;
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
  // `.min(1)`: a bill bills at least one item. With charge items in the same
  // array that holds without a special case — a historic Vision bill is one
  // document-only or standing-line charge item (D5).
  items: z.array(PurchaseDocumentItemSchema).min(1).meta({ label: "Item" }),
  totals: PurchaseBillTotalsSchema,
  voided_at: FirestoreTimestamp.optional(),
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
 * `organization` → `supplier` and `coa_revenue` → `ledger_account` (the class is
 * named after its one member, as the invoice's is; `coa_posting` until the
 * one-document-model Phase 1 rename).
 *
 * Explicit tuple type rather than `as const` alone (core#43).
 */
export const PURCHASE_BILL_FIELD_CLASSES: readonly [
  "supplier",
  "date",
  "line_money",
  "ledger_account",
  "tracking",
  "text",
] = ["supplier", "date", "line_money", "ledger_account", "tracking", "text"];

/** One of {@link PURCHASE_BILL_FIELD_CLASSES}. */
export type PurchaseBillFieldClass = typeof PURCHASE_BILL_FIELD_CLASSES[number];

/** When a bill field class freezes, and what Xero does with it once settled. */
export interface PurchaseBillFieldFreezeContract {
  /**
   * - `"frozen"` — while `purchaseBillIsFrozen` (`@cfs/core/utils/invoices`):
   *   any money settled against the bill, paid, credited or voided.
   * - `"void"` — only once the bill is void (`purchaseBillIsLive` is false; a bill has
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
  members: readonly (
    | keyof PurchaseBill
    | keyof PurchaseDocumentProductItem
    | keyof PurchaseDocumentServiceItem
    | keyof PurchaseDocumentReplacementItem
  )[];
}

/**
 * **The one bill field-class freeze table** (owner, 2026-10-28). Read only
 * through `purchaseBillFieldIsFrozen` (`@cfs/core/utils/invoices`).
 *
 * `tracking` says `true`, as the invoice's does. The invoice's records edits
 * Xero has ALREADY ACCEPTED on paid ACCREC invoices. For ACCPAY the evidence is
 * thinner: CFS-BILL-299 is PAID and carries tracking, with `UpdatedDateUTC` after
 * its payment date, and that does not say the edit came through the API. So the
 * push re-reads the bill and advances nothing unless money, status and lines
 * held and the tracking landed. `line_money` is decided over the rebuilt items,
 * as the invoice's `lineMoneyAgrees` does.
 */
export const PURCHASE_BILL_FIELD_FREEZE: Readonly<
  Record<PurchaseBillFieldClass, PurchaseBillFieldFreezeContract>
> = {
  supplier: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["supplier"] },
  date: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["date"] },
  line_money: {
    frozen_when: "frozen",
    xero_accepts_on_settled: false,
    // The tax levers sit here as on the invoice: a class change re-prices the line.
    members: ["quantity", "amount_cents", "price", "units", "dates", "uid_tax_class", "uid_tax_class_override"],
  },
  ledger_account: { frozen_when: "frozen", xero_accepts_on_settled: false, members: ["ledger_account"] },
  tracking: { frozen_when: "void", xero_accepts_on_settled: true, members: ["uid_tracking_category"] },
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

/**
 * What a bill's settlements add up to, for display. A bill stores NO status:
 * `derivePurchaseBillStatus` (`@cfs/core/utils/invoices`) reads this off its
 * totals. `unpaid` stands where an invoice says `issued`, because a bill has no
 * issue step. `credited` has no invoice twin: the invoice folds it into `paid`,
 * while an operator reading supplier bills needs to tell settled-by-credit from
 * money paid.
 */
export const PURCHASE_BILL_STATUSES = ["unpaid", "part_paid", "paid", "credited", "void"] as const;
/** One {@link PURCHASE_BILL_STATUSES} member. */
export type PurchaseBillStatusType = typeof PURCHASE_BILL_STATUSES[number];
/** Zod schema for PurchaseBillStatusType. */
export const PurchaseBillStatusEnum: z.ZodType<PurchaseBillStatusType> = z.enum(PURCHASE_BILL_STATUSES);

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
 * One line of a supplier CREDIT as an operator states it: a purchase item and
 * what it un-bills.
 *
 * - **flat** — `quantity` units, priced at the item's cumulative share of the
 *   range they un-bill (`cumulativeShareCents`). `units` and `dates` are refused.
 * - **time** — the TIME it un-bills, never units of an amount: `units` names each
 *   unit's credited windows, `dates` the credited span of a span-metered line
 *   (Verizon). Every credited piece must already be billed and not credited
 *   (`billedUnitCoverage`), and the line is priced as what those windows
 *   contributed: `meter(coverage) − meter(coverage − credited)`, at the purchase
 *   line's snapshotted rates (`projectPurchaseLineToCreditLine`,
 *   `@cfs/core/utils/purchase-documents`). `quantity` is the count of units
 *   credited, or of the span's units on a unit-less span line.
 */
export interface PurchaseCreditItemInputType extends PurchaseDocumentItemInputType {
  units?: PurchaseDocumentLineUnit[];
  dates?: ChargeWindowType | null;
}

const CreditLineUnitInput: z.ZodType<PurchaseDocumentLineUnit> = z.object({
  uid_unit: UnitId,
  charge_windows: z.array(z.object({ start: chicagoInstant(), end: chicagoInstant() })).min(1),
});

/** Zod schema for PurchaseCreditItemInputType. */
export const PurchaseCreditItemInput: z.ZodType<PurchaseCreditItemInputType> = z.object({
  uid_item: ItemUid,
  quantity: z.int().min(1),
  units: z.array(CreditLineUnitInput).optional(),
  dates: z.object({ start: chicagoInstant(), end: chicagoInstant() }).nullable().optional(),
});

/**
 * A document-only charge item as an operator states it on a PUSHED bill or
 * credit (freight nobody expected, a fee). The writer mints its `uid`/`path`,
 * stamps a Fixed formula snapshot and `quantity: 1`.
 * `uid_tracking_category` follows the order/invoice line rule: absent or `null`
 * takes the attributed product's category (none when it names no product); a
 * uid sets it and must name a live category.
 *
 * ⚠️ **The node stays STRICT, though both push inputs embed it.** Stripping
 * would let an api that predates a field silently drop it rather than 400, and
 * an attribution would vanish with nothing failing (api-cloudrun#1360).
 */
export interface PurchaseDocumentChargeItemInputType {
  name: string;
  description?: string;
  ledger_account: COACodeType;
  amount_cents: number;
  uid_product?: string;
  uid_out_of_service?: string;
  uid_tracking_category?: string | null;
}

// Not exported: it is reached only through the two push inputs, and an exported
// `*Input` would be a strict node of its own in `tests/input-strictness.test.ts`.
const PurchaseDocumentChargeItemInput: z.ZodType<PurchaseDocumentChargeItemInputType> = z.strictObject({
  name: LineItemCore.name,
  description: LineItemCore.description.optional(),
  ledger_account: COACode,
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
 * A PUSHED bill item carries no amount: the writer defaults it from the
 * purchase item (`projectPurchaseLineToBillLine`, `@cfs/core/utils/purchase-documents`) —
 * a flat line at the item's cumulative share, a time line priced from its
 * units' UNBILLED charge windows — and stamps the purchase item's `name`,
 * `description`, `price`, `ledger_account`, `uid_tracking_category` and tax
 * class. The operator then
 * overrides any of them until the bill is settled ({@link UpdatePurchaseBillInput}).
 * A LINKED bill carries `total_cents` as Xero has it.
 */
export type CreatePurchaseBillInputType =
  | {
    mode: "push";
    date: string;
    due_date: string;
    reference?: string | null;
    items: PurchaseDocumentItemInputType[];
    charge_items?: PurchaseDocumentChargeItemInputType[];
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
  charge_items: z.array(PurchaseDocumentChargeItemInput).optional(),
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
  if (b.mode === "push" && b.items.length + (b.charge_items?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a bill names at least one item or charge item" });
  }
}) as z.ZodType<CreatePurchaseBillInputType>;

/**
 * Input for recording a supplier credit against a purchase — push a new
 * ACCPAYCREDIT, or link one the supplier's credit was entered as in Xero.
 *
 * Each `items` entry UN-bills that quantity of its purchase item: it lowers
 * `quantity_billed`, and a PUSHED credit prices it at the item's cumulative
 * share of the range it un-bills, so a price the purchase does not hold cannot
 * be credited. A price correction with no quantity is a `charge_items` entry
 * (push only). A LINKED credit reads its date, reference and total from Xero,
 * as a linked bill does.
 */
export type CreatePurchaseCreditInputType =
  | {
    mode: "push";
    reason: PurchaseCreditReasonType;
    date: string;
    reference?: string | null;
    items: PurchaseCreditItemInputType[];
    charge_items?: PurchaseDocumentChargeItemInputType[];
    uuid_session: string;
    version: number;
  }
  | {
    mode: "link";
    reason: PurchaseCreditReasonType;
    xero_id: string;
    items: PurchaseCreditItemInputType[];
    uuid_session: string;
    version: number;
  };

const pushCreditInput = z.object({
  mode: z.literal("push"),
  reason: PurchaseCreditReasonEnum,
  date: chicagoStartOfDay(),
  reference: z.string().max(255).nullable().optional(),
  items: z.array(PurchaseCreditItemInput),
  charge_items: z.array(PurchaseDocumentChargeItemInput).optional(),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

const linkCreditInput = z.object({
  mode: z.literal("link"),
  reason: PurchaseCreditReasonEnum,
  xero_id: z.uuid(),
  items: z.array(PurchaseCreditItemInput),
  uuid_session: z.uuid(),
  version: z.int().min(0),
});

/** Zod schema for CreatePurchaseCreditInputType. */
export const CreatePurchaseCreditInput: z.ZodType<CreatePurchaseCreditInputType> = z.discriminatedUnion("mode", [
  pushCreditInput,
  linkCreditInput,
]).superRefine((c, ctx) => {
  uniqueItemInputs(c.items, ctx);
  if (c.mode === "push" && c.items.length + (c.charge_items?.length ?? 0) === 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a pushed credit names at least one item or charge item" });
  }
}) as z.ZodType<CreatePurchaseCreditInputType>;

/**
 * One line of a PUSHED bill as an operator edits it (D5): any shared field may
 * be overridden until the bill is settled — exactly the invoice rule. Matched
 * to the stored line by `uid`; an absent key KEEPS the stored value.
 *
 * Money is edited through its INPUTS, never typed over the result on a time
 * line: `price.rates`, `price.discount`, `units` and `dates`, from which the
 * writer re-meters `counts` and re-prices `amount_cents`. A flat line's
 * `amount_cents` is stated directly (gross when a discount is set).
 */
export interface PurchaseBillLineEditInputType {
  uid: string;
  name?: string;
  description?: string;
  quantity?: number;
  amount_cents?: number;
  ledger_account?: COACodeType;
  /** Absent keeps; `null` clears the operator's class, restoring the line's own. */
  uid_tax_class_override?: string | null;
  /** Absent keeps the line's category; a uid sets it; `null` restores its product's, the order/invoice line rule (none with no product). */
  uid_tracking_category?: string | null;
  price?: { rates?: { rate_key: string; amount_cents: number }[]; discount?: DiscountInputType | null };
  units?: PurchaseDocumentLineUnit[];
  dates?: ChargeWindowType | null;
}

/**
 * Input for editing a PUSHED, unsettled bill (`PUT /purchase-bills/{uid}`) — a
 * PATCH. `items`, when present, names lines to edit by `uid`; lines it omits are
 * kept. Refused on a linked bill (Xero is authoritative) and, per field class,
 * once the bill is frozen (`PURCHASE_BILL_FIELD_FREEZE`). An accepted edit is
 * pushed to Xero through the ACCPAY edit push (D5).
 */
export interface UpdatePurchaseBillInputType {
  version: number;
  date?: string;
  due_date?: string;
  reference?: string | null;
  items?: PurchaseBillLineEditInputType[];
}

const BillLineUnitInput: z.ZodType<PurchaseDocumentLineUnit> = z.object({
  uid_unit: UnitId,
  charge_windows: z.array(z.object({ start: chicagoInstant(), end: chicagoInstant() })).min(1),
});

/** Zod schema for UpdatePurchaseBillInputType. */
export const UpdatePurchaseBillInput: z.ZodType<UpdatePurchaseBillInputType> = z.object({
  version: z.int().min(0),
  date: chicagoStartOfDay().optional(),
  due_date: chicagoStartOfDay().optional(),
  reference: z.string().max(255).nullable().optional(),
  items: z.array(z.object({
    uid: ItemUid,
    name: LineItemCore.name.optional(),
    description: LineItemCore.description.optional(),
    quantity: z.int().min(1).optional(),
    amount_cents: z.int().min(0).optional(),
    ledger_account: COACode.optional(),
    uid_tax_class_override: FirestoreId.nullable().optional(),
    uid_tracking_category: FirestoreId.nullable().optional(),
    price: z.object({
      rates: z.array(z.object({ rate_key: RateKey, amount_cents: z.int() })).optional(),
      discount: DiscountInput.nullable().optional(),
    }).optional(),
    units: z.array(BillLineUnitInput).optional(),
    dates: z.object({ start: chicagoInstant(), end: chicagoInstant() }).nullable().optional(),
  })).optional(),
}).superRefine((u, ctx) => {
  const seen = new Set<string>();
  u.items?.forEach((item, i) => {
    if (seen.has(item.uid)) ctx.addIssue({ code: "custom", path: ["items", i, "uid"], message: "a line is edited once per write" });
    seen.add(item.uid);
  });
}) as z.ZodType<UpdatePurchaseBillInputType>;

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

/**
 * Input for voiding a supplier bill from CFS. `version` is the bill's. A pushed
 * bill only: a linked one is Xero's. The refusals are
 * `purchaseBillVoidRefusal` (`utils/purchase-actions.ts`).
 */
export interface VoidPurchaseBillInputType {
  version: number;
}

/** Zod schema for VoidPurchaseBillInputType. */
export const VoidPurchaseBillInput: z.ZodType<VoidPurchaseBillInputType> = z.object({
  version: z.int().min(0),
});
