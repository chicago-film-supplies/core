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
 * The bill shares the invoice's line head, posting and tax cores, its pricer and
 * sync, its status vocabulary (stored, refined against `deriveInvoiceStatus`), its
 * freeze table and its diff (`computeDocumentDiffs`).
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
 * `INVOICE_FIELD_FREEZE` is the one table, with per-side members, and
 * `invoiceIsFrozen` (`@cfs/core/utils/invoices`) the one predicate, over a bill's
 * status and totals. `updatePurchaseBill` and the purchase → bill sync both read
 * it. Supplier credits get no table, matching sales credit notes.
 *
 * @module
 */
import type { SharedLineType } from "./side.ts";
import { z } from "zod";
import { FirestoreId, ItemUid, ThreadId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import { COACode, type COACodeType } from "./chart-of-accounts.ts";
import {
  isKitHeaderLine,
  isPurchaseLine,
  kitHeaderIssues,
  zeroPricedMoneyIssues,
  PayablePriceMoneyCore,
  payablePostingIssues,
  PURCHASE_PRODUCT_ITEM_TYPES,
  type PurchaseLinePrice,
  purchaseLineMoneyIssues,
  type PurchaseProductItemTypeType,
  type PurchaseDestinationInputType,
  purchaseDestinationInputIssues,
  payableInputUidIssue,
  payableLineUidIssue,
} from "./purchase.ts";
import {
  checkDestinationJoin,
  checkLeadingDivider,
  type OrderDocDestinationItemType,
  type OrderDocGroupItemType,
  PairCore,
  type PairCoreType,
  PairInputCore,
  Discount,
  DiscountInput,
  type DiscountInputType,
  PriceModifier,
  TaxRef,
} from "./order.ts";
import { LedgerPostingCore, LineItemCore, LineTaxCore, PayableKitLedgerAccount } from "./_items.ts";
import { DestinationDividerArm, GroupDividerArm } from "./_dividers.ts";
import { PriceFormulaRefSchema, RateKey, RateSnapshotSchema, TierCountSchema, type TierCountType } from "./price-formula.ts";
import { deriveInvoiceStatus } from "./_invoice-freeze.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  InvoiceStatusEnum,
  type InvoiceStatusType,
  type SettlementReasonType,
  SubstitutedForList,
  SubstitutedForListInput,
  type SubstitutedForEntryType,
  OutOfServiceList,
  OutOfServiceListInput,
  type OutOfServiceEntryType,
  outOfServiceLinkIssues,
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
 * un-overridden bill line follows its purchase line; the exempt tax keys; and
 * the computed money `priceDocument` writes from the line's stated
 * `amount_cents`) plus the line's metered `counts` — `[]` on a flat line, the counts
 * a time line bills on a time one (one-document-model Phase 3).
 *
 * A LINKED document's `amount_cents` is Xero's money, stamped by the link
 * writer; the computed money follows from it like any other stated total.
 */
export interface PurchaseDocumentLinePrice extends Omit<PurchaseLinePrice, "replacement_cents"> {
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
  ...PayablePriceMoneyCore,
});

/**
 * The keys every bill or credit line carries beside its arm — the purchase
 * line's shared head, posting and tax cores (`schemas/_items.ts`, one instance
 * per key; see `PurchaseItemBase` for why `quantity` is still each grain's own),
 * plus the line's money.
 *
 * A line carries no per-unit windows and no span of its own: a time line
 * meters its PAIR's `charge_windows` (`destinations`), as an invoice line does
 * (one-document-model Phase 3 retired `units[]` and `dates`; 0 stored lines
 * carried either).
 *
 * `xero_line_id` is the Xero `LineItemID` of the line on a LINKED document —
 * the one id a tracking edit can address a line CFS did not author by. It is
 * stamped when the document is linked and backfilled for older links; an item
 * that cannot be paired to exactly one Xero line (several items folded into
 * one line, or lines with no item code to choose between) stays absent and is
 * refused for a tracking edit, never guessed (one-document-model, § Linked-bill
 * tracking). A PUSHED document carries none: CFS authored its lines, so the
 * settled-edit path pairs them by position, as it does an invoice's, and one
 * item may be two Xero lines (`splitExactLines`).
 *
 * ⚠️ Not the invoice line's `xero_id`, which is the PRODUCT's Xero `ItemID`
 * (api-cloudrun `productLineDenorms`). The names differ because the facts do.
 */
interface PurchaseDocumentLineBase {
  uid: string;
  name: string;
  description: string;
  /** Units this item bills or un-bills (on a time line, the units its windows cover). */
  quantity: number;
  /**
   * Self-inclusive, under its purchase divider: `[purchase uid, ...the
   * purchase line's path]` for a line that bills a purchase line, authored by
   * `computePurchaseDocumentItemPaths`. A line's `uid` is its purchase line's,
   * as an invoice line's is its order line's.
   */
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
  xero_line_id?: string;
  /**
   * On a supplier CREDIT line only: the bill this line credits. Both or neither
   * with {@link path_bill_item}, because a path is a row identity within ONE
   * document, so the bill's uid has to travel with it. A close and a linked
   * credit name none: a close has no single bill, and Xero's allocation view
   * carries no lines (api-cloudrun#1439).
   */
  uid_purchase_bill?: string;
  /** The `path` of the bill line credited — the AR credit note's `path_invoice_item`. */
  path_bill_item?: string[];
}

/**
 * A bill or credit item that PROJECTS a purchase item — some quantity of one
 * sale (Buy) or rental (Subrent) item (D5). It sits AT that item's path under
 * the item's purchase divider, as an invoice line sits at its order line's
 * (one-document-model Phase 3), and carries its own copy of the shared fields, each of
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
export interface PurchaseDocumentProductItem extends Omit<PurchaseDocumentLineBase, "ledger_account"> {
  /** `null` marks a kit header (`isKitHeaderLine`). */
  ledger_account: COACodeType | null;
  type: PurchaseProductItemTypeType;
  uid_product: string;
  /**
   * A MOVE pointer (the `path_order_item` twin): the purchase item this line
   * bills when it sits at another path in its purchase's block, relative to
   * that purchase. Absent when the line sits at its purchase line's own path.
   *
   * Several rows may name one purchase line: a split bills it in two places.
   */
  path_purchase_item?: string[];
  /**
   * The purchase lines this row stands in for, with how many units: the
   * invoice line's `substituted_for`. It records that the bill deliberately
   * bills a DIFFERENT product, which is what makes the purchase read X as
   * billed rather than still open.
   */
  substituted_for?: SubstitutedForEntryType[];
}

/**
 * A bill or credit SERVICE (Charge) line — freight, a fee, a carrier line.
 * Posts to its own account and never touches basis.
 *
 * A **document-only** service line (at a path its purchase does not carry, or
 * outside any purchase divider) is the document's own row, like an invoice's
 * loss-and-damage line: freight nobody expected. One that projects a purchase
 * `service` item sits at its path.
 *
 * `uid_product` is attribution (api-cloudrun#1360, #1364): the writer emits the
 * product's Xero `ItemCode` beside the stated account when it has one; rental
 * items are untracked in Xero, so the code moves no Xero quantity or value.
 * Permanent `.optional()`: freight and fees name nothing.
 */
export interface PurchaseDocumentServiceItem extends PurchaseDocumentLineBase {
  type: "service";
  uid_product?: string;
  /** A move pointer, as on {@link PurchaseDocumentProductItem}. */
  path_purchase_item?: string[];
}

/**
 * A bill or credit REPLACEMENT line — the supplier billing CFS for its unit
 * lost or damaged in CFS's hands, naming the out-of-service record(s) (until
 * 2026-11 a `charge` with a single record id). A `mark_lost` record's id is a
 * `MovementId`, hence `OutOfServiceId`.
 *
 * `uid_product` is the lost rental's money-only twin, never the rental (owner
 * ruling 15; see `PurchaseReplacementItem`).
 */
export interface PurchaseDocumentReplacementItem extends Omit<PurchaseDocumentServiceItem, "type"> {
  type: "replacement";
  /**
   * The records this line bills, each with its share of `quantity` (ruling 16).
   * Follows its purchase line's with `quantity` and `amount_cents` as one unit
   * (`PurchaseReplacementItem.out_of_service`). Required since W4K's contract
   * publish, which retired the pre-W4R single `uid_out_of_service`.
   */
  out_of_service: OutOfServiceEntryType[];
}

/** Union of a bill or credit LINE's arms, discriminated on `type`. */
export type PurchaseDocumentItem =
  | PurchaseDocumentProductItem
  | PurchaseDocumentServiceItem
  | PurchaseDocumentReplacementItem;

/**
 * A bill's or supplier credit's `purchase` divider — the `InvoiceDocOrderItem`
 * twin. Its `uid` IS the purchase's document id, so the lines under it are
 * scoped to that purchase by path alone (one-document-model Phase 3).
 */
export interface PurchaseDocPurchaseItemType {
  uid: string;
  type: "purchase";
  /** `PO-n`, machine-written. */
  name: string;
  path: string[];
  description: string;
}

const PurchaseDocPurchaseItemInner = z.strictObject({
  uid: ItemUid,
  type: z.literal("purchase"),
  name: z.string().max(200).meta({ pii: "none" }),
  path: z.array(ItemUid),
  description: z.string().meta({ pii: "none" }),
});

/** Zod schema for {@link PurchaseDocPurchaseItemType}. */
export const PurchaseDocPurchaseItem: z.ZodType<PurchaseDocPurchaseItemType> = PurchaseDocPurchaseItemInner;

/**
 * Any row of a bill's or supplier credit's `items[]`: a line, or a
 * purchase / destination / group divider (`PURCHASE_DOCUMENT_ITEM_LEVELS`).
 */
export type PurchaseDocumentRow =
  | PurchaseDocumentItem
  | PurchaseDocPurchaseItemType
  | OrderDocDestinationItemType
  | OrderDocGroupItemType;

/** A bill or credit line that bills and posts: never a kit header. */
export type PurchaseDocumentPostedItem = PurchaseDocumentItem & { ledger_account: COACodeType };

/** The lines of a bill's or credit's rows, with dividers and kit headers dropped. */
export function purchaseDocumentLines(rows: readonly PurchaseDocumentRow[]): PurchaseDocumentPostedItem[] {
  return rows.filter((r): r is PurchaseDocumentPostedItem => isPurchaseLine(r) && !isKitHeaderLine(r));
}

/**
 * A bill's or supplier credit's destination pair — the purchase's pair
 * ({@link PurchaseDestination}) scoped by `uid_purchase`, the
 * `InvoiceDocDestination` twin, so a document billing several purchases
 * carries each one's pairs.
 */
export interface PurchaseDocDestination extends PairCoreType {
  uid_purchase: string;
}

/** Zod schema for {@link PurchaseDocDestination}. */
export const PurchaseDocDestinationSchema: z.ZodType<PurchaseDocDestination> = z.strictObject({
  uid_purchase: FirestoreId,
  ...PairCore,
});

/**
 * The purchase line a bill or credit line bills, as `[purchase uid, ...path in
 * that purchase]` joined by `/` — its move pointer when it has one, else its
 * own path under its purchase divider — or `null` for a line outside any
 * purchase divider. The one join key for "which purchase line is this".
 */
export function purchaseLineKeyOf(row: Pick<PurchaseDocumentItem, "path" | "path_purchase_item">): string | null {
  if (row.path.length < 2) return null;
  const uidPurchase = row.path[0];
  const local = row.path_purchase_item ?? row.path.slice(1);
  return [uidPurchase, ...local].join("/");
}

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
  // A linked document's Xero `LineItemID` (docblock above). Not shared.
  xero_line_id: z.uuid().optional(),
  // A credit line's pointer at the bill line it credits (the docblock above).
  uid_purchase_bill: FirestoreId.optional().meta({ seed: false }),
  // `seed: false`: `[]` fails `.min(1)`, exactly as `path_invoice_item`.
  path_bill_item: z.array(ItemUid).min(1).optional().meta({ seed: false }),
};

/**
 * A line's own shape rules — the purchase line's flat rule and stated-total
 * money (`purchaseLineMoneyIssues`), the type's posting class
 * (`payablePostingIssues`), and the bill line's: a flat line meters no counts,
 * and a pushed time line states the counts its money is priced from.
 *
 * `origin` decides the one rule that differs by authorship: a pushed time line
 * states its counts. Either way a line's computed money follows from its
 * stated `amount_cents`.
 */
function documentLineIssues(
  item: PurchaseDocumentItem,
  origin: PurchaseDocumentOriginType,
): { path: (string | number)[]; message: string }[] {
  const issues = purchaseLineMoneyIssues({ price: item.price, amount_cents: item.amount_cents }, "document");
  issues.push(...payablePostingIssues(item.type, item.ledger_account), ...kitHeaderIssues(item), ...zeroPricedMoneyIssues(item));
  const counts = item.price?.counts.length ?? 0;
  const time = item.price?.price_formula.basis === "time";
  if (!time && counts > 0) issues.push({ path: ["price", "counts"], message: "a flat line meters no counts" });
  // A pushed time line's money IS its counts priced, so it states them; a linked
  // one's money is Xero's, and its counts are whatever the link could read.
  if (time && origin === "pushed" && counts === 0) {
    issues.push({ path: ["price", "counts"], message: "a pushed time line states the counts it bills" });
  }
  if ((item.uid_purchase_bill === undefined) !== (item.path_bill_item === undefined)) {
    issues.push({ path: ["path_bill_item"], message: "uid_purchase_bill and path_bill_item are set together" });
  }
  return issues;
}

// Un-annotated so `_zod.propValues` survives for the discriminated union below.
// The line rules run at the document level (`documentItemsIssues`), which knows
// the document's `origin`.
const PurchaseDocumentProductItemInner = z.strictObject({
  type: z.enum(PURCHASE_PRODUCT_ITEM_TYPES).meta({ column: true, label: "Type" }),
  ...docItemHead,
  ...docItemShape,
  ledger_account: PayableKitLedgerAccount,
  uid_product: FirestoreId,
  // The move pointer, exactly as invoice's `path_order_item`.
  path_purchase_item: z.array(ItemUid).min(1).optional().meta({ seed: false }),
  // Plain `.optional()`, matching the invoice line's. Only a substitute carries it.
  substituted_for: SubstitutedForList.optional(),
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
  out_of_service: OutOfServiceList.meta({ seed: false }),
}).superRefine((item, ctx) => {
  for (const [path, message] of outOfServiceLinkIssues(item)) {
    ctx.addIssue({ code: "custom", path, message });
  }
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

/** Zod schema for any bill or credit LINE — discriminated on `type`. */
export const PurchaseDocumentItemSchema: z.ZodType<PurchaseDocumentItem> = z.discriminatedUnion("type", [
  PurchaseDocumentProductItemInner,
  PurchaseDocumentServiceItemInner,
  PurchaseDocumentReplacementItemInner,
]);

/** Zod schema for any {@link PurchaseDocumentRow}. */
export const PurchaseDocumentRowSchema: z.ZodType<PurchaseDocumentRow> = z.discriminatedUnion("type", [
  PurchaseDocPurchaseItemInner,
  DestinationDividerArm,
  GroupDividerArm,
  PurchaseDocumentProductItemInner,
  PurchaseDocumentServiceItemInner,
  PurchaseDocumentReplacementItemInner,
]);

function documentItemsIssues(
  doc: { origin: PurchaseDocumentOriginType; items: PurchaseDocumentRow[] },
  total: number,
  totalPath: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const paths = new Set<string>();
  doc.items.forEach((row, i) => {
    if (row.path.length === 0 || row.path.at(-1) !== row.uid) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "an item's path is self-inclusive: it ends in its own uid" });
    }
    const pathKey = row.path.join("/");
    if (paths.has(pathKey)) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "an item's path appears once per document" });
    }
    paths.add(pathKey);
    if (!isPurchaseLine(row)) return;
    const item = row as PurchaseDocumentItem;
    // Keyed by its product, or `custom-` (W4K), as a purchase line is.
    const uidMessage = payableLineUidIssue(item);
    if (uidMessage !== null) ctx.addIssue({ code: "custom", path: ["items", i, "uid"], message: uidMessage });
    for (const issue of documentLineIssues(item, doc.origin)) {
      ctx.addIssue({ code: "custom", path: ["items", i, ...issue.path], message: issue.message });
    }
  });
  // A document with value must say what it is for. A bill's `items` is also
  // `.min(1)` on its schema; a credit may be empty only at zero.
  const lines = purchaseDocumentLines(doc.items);
  if (lines.length === 0 && total > 0) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a document with value names at least one item" });
  }
  // A linked document's total is Xero's and is exempt (module docblock). The
  // sum reads the PRICED money, as `priceDocument`'s stage 5 totals it.
  if (doc.origin === "pushed") {
    const sum = lines.reduce((s, item) => s + item.price.total_cents, 0);
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
  /**
   * How many live `bill_closure` rows close this bill: 1 on a $0 bill an operator
   * marked paid. Stated only where it says something, as on the invoice.
   */
  closure_count?: number;
}

/** Zod schema for PurchaseBillTotals. */
export const PurchaseBillTotalsSchema: z.ZodType<PurchaseBillTotals> = z.strictObject({
  total_cents: z.int().min(0).meta({ column: true, label: "Total" }),
  amount_paid_cents: z.int().meta({ column: true, label: "Paid" }),
  amount_credited_cents: z.int().meta({ column: true, label: "Credited" }),
  amount_void_cents: z.int().meta({ column: true, label: "Voided" }),
  amount_due_cents: z.int().meta({ column: true, label: "Due" }),
  closure_count: z.int().nonnegative().optional(),
});

/**
 * The purchases a bill's `purchase` dividers name, in document order — the
 * one author of `PurchaseBill.query_by_purchases`.
 */
export function deriveQueryByPurchases(rows: readonly Pick<PurchaseDocumentRow, "type" | "uid">[]): string[] {
  return rows.filter((r) => r.type === "purchase").map((r) => r.uid);
}

/** Every `purchase` divider names a distinct purchase, and the mirrors agree with them. */
function purchaseScopeIssues(
  doc: { items: PurchaseDocumentRow[]; query_by_purchases?: string[]; number_purchases?: number[] },
  ctx: z.RefinementCtx,
  uidPurchase?: string,
): void {
  const scoped = deriveQueryByPurchases(doc.items);
  if (new Set(scoped).size !== scoped.length) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a purchase is scoped by one purchase divider per document" });
  }
  if (doc.query_by_purchases !== undefined) {
    if (doc.query_by_purchases.join("/") !== scoped.join("/")) {
      ctx.addIssue({
        code: "custom",
        path: ["query_by_purchases"],
        message: "query_by_purchases must list the purchase dividers' uids, in order",
      });
    }
    if (doc.number_purchases !== undefined && doc.number_purchases.length !== doc.query_by_purchases.length) {
      ctx.addIssue({
        code: "custom",
        path: ["number_purchases"],
        message: "number_purchases carries one number per query_by_purchases entry",
      });
    }
  }
  if (uidPurchase !== undefined && scoped.some((u) => u !== uidPurchase)) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "a supplier credit's purchase dividers name the purchase in its sources" });
  }
}

/** A supplier bill against one or more purchases. */
export interface PurchaseBill {
  uid: string;
  /** Monotonic (`counters/purchase-bills`); pushed as `CFS-BILL-n`. Matches key on `uid` / `xero_id`, never this. */
  number: number;
  /**
   * The purchases this bill bills — its `purchase` dividers' uids, in order
   * ({@link deriveQueryByPurchases}, refined). The `Invoice.query_by_orders`
   * twin: one bill may bill several purchases, as a supplier's statement does.
   * `[]` on a charge-only bill with no purchase.
   */
  query_by_purchases: string[];
  /** The purchases' numbers, one per {@link query_by_purchases} entry — the `Invoice.number_orders` twin. */
  number_purchases: number[];
  /**
   * The invoice's status vocabulary, stored and refined equal to
   * `deriveInvoiceStatus`. A bill has no draft step, so it is born `issued`.
   */
  status: InvoiceStatusType;
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
  /** Product projections and charge items under their dividers ({@link PurchaseDocumentRow}). */
  items: PurchaseDocumentRow[];
  /** The billed purchases' pairs ({@link PurchaseDocDestination}), one per destination divider. */
  destinations: PurchaseDocDestination[];
  totals: PurchaseBillTotals;
  /**
   * When the bill was voided, stamped by every void path. **Absent means not
   * voided**, or voided before this stamp existed (`amount_void_cents` then says
   * so). A bare `.optional()` rather than `.nullable()` on purpose:
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
  purchaseScopeIssues(b, ctx);
  checkLeadingDivider("purchase_document")(b, ctx);
  checkDestinationJoin(b, ctx);
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
  checkBillStatus(b, ctx);
  purchaseDocumentLines(b.items).forEach((l) => {
    if (l.uid_purchase_bill !== undefined || l.path_bill_item !== undefined) {
      ctx.addIssue({ code: "custom", path: ["items"], message: "a bill line credits nothing; only a supplier credit line names a bill line" });
    }
  });
}

/**
 * `status` is the derivation's answer, and `void` says exactly what the money and
 * the stamp say: a $0 bill's void folds to 0, so the stamp carries it.
 */
function checkBillStatus(b: PurchaseBill, ctx: z.RefinementCtx): void {
  // One vocabulary, and a bill has no draft step: it is born `issued`.
  if (b.status === "draft") ctx.addIssue({ code: "custom", path: ["status"], message: "a bill has no draft status" });
  // The #2396 shape from the other side: a closed bill that still owes money.
  if ((b.totals.closure_count ?? 0) > 0 && b.totals.total_cents !== 0) {
    ctx.addIssue({ code: "custom", path: ["totals", "closure_count"], message: "closure_count > 0 is legal only on a bill whose total_cents is 0" });
  }
  const derived = deriveInvoiceStatus(b);
  if (b.status !== derived) {
    ctx.addIssue({ code: "custom", path: ["status"], message: `a bill with these totals is ${derived}, not ${b.status}` });
  }
  const voided = b.voided_at !== undefined || b.totals.amount_void_cents !== 0;
  if ((b.status === "void") !== voided) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "a bill is void exactly when it carries a void stamp or void money" });
  }
}

/** Zod schema for PurchaseBill. */
export const PurchaseBillSchema: z.ZodType<PurchaseBill> = z.strictObject({
  uid: FirestoreId,
  number: z.int().min(1).meta({ column: true, label: "#", linkTo: "purchaseBillDetail", serverSortVia: "number" }),
  query_by_purchases: z.array(FirestoreId).meta({ derived: true }),
  number_purchases: z.array(z.int().min(1)).meta({ column: true, label: "Purchase #" }),
  status: InvoiceStatusEnum.meta({ column: true, label: "Status" }),
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
  items: z.array(PurchaseDocumentRowSchema).min(1).meta({ label: "Item" }),
  destinations: z.array(PurchaseDocDestinationSchema).meta({ label: "Destination" }),
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
    columns: ["number", "date", "supplier.name", "reference", "status", "totals.total_cents", "totals.amount_due_cents"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    groupBy: [
      { field: null, label: "None" },
      { field: "origin", label: "Origin", kind: "enum" },
      { field: "status", label: "Status", kind: "enum" },
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
  /**
   * What the credit was raised on — the `CreditNote` shape: one `purchases`
   * source, then a `purchase-bills` source per bill its lines name
   * ({@link derivePurchaseCreditSources}). "Raised on" is read here and "allocated
   * to" from the journal, as on a credit note.
   */
  sources: DocSourceType[];
  query_by_sources: string[];
  supplier: UidNameRefType;
  origin: PurchaseDocumentOriginType;
  reason: PurchaseCreditReasonType;
  status: PurchaseCreditStatusType;
  /** Xero's `CreditNoteID`; `null` only on a pushed credit not yet pushed. */
  xero_id: string | null;
  date: string;
  date_fs: FirestoreTimestampType;
  reference: string | null;
  /**
   * Each product item UN-bills that quantity of its purchase item: it lowers
   * `quantity_billed`. Under its purchase's dividers, as a bill's are.
   */
  items: PurchaseDocumentRow[];
  /** The purchase's pairs the credited lines sit under ({@link PurchaseDocDestination}). */
  destinations: PurchaseDocDestination[];
  total_cents: number;
  /**
   * Credit not yet consumed: a **co-written projection** of the journal,
   * `creditRemainingFromJournal("payable", total_cents, rows)` — `total_cents` minus
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

/** The purchase a credit was raised on, or `undefined` when its sources name none. */
export function purchaseCreditPurchaseUid(credit: Pick<PurchaseCredit, "sources">): string | undefined {
  return credit.sources.find((s) => s.collection === "purchases")?.uid;
}

/**
 * **The one author of a supplier credit's `sources`**: its purchase, then each
 * bill its lines name, in line order. `query_by_sources` is
 * `<collection>:<uid>` of each, as on a credit note.
 */
export function derivePurchaseCreditSources(
  uidPurchase: string,
  rows: readonly PurchaseDocumentRow[],
): Pick<PurchaseCredit, "sources" | "query_by_sources"> {
  const bills = [...new Set(purchaseDocumentLines([...rows]).flatMap((l) => l.uid_purchase_bill ?? []))];
  const sources: DocSourceType[] = [
    { collection: "purchases", uid: uidPurchase },
    ...bills.map((uid) => ({ collection: "purchase-bills" as const, uid })),
  ];
  return { sources, query_by_sources: sources.map((s) => `${s.collection}:${s.uid}`) };
}

function checkPurchaseCredit(c: PurchaseCredit, ctx: z.RefinementCtx): void {
  documentItemsIssues(c, c.total_cents, ["total_cents"], ctx);
  const uidPurchase = purchaseCreditPurchaseUid(c);
  purchaseScopeIssues(c, ctx, uidPurchase);
  if (uidPurchase === undefined) {
    ctx.addIssue({ code: "custom", path: ["sources"], message: "a supplier credit names the purchase it was raised on" });
  } else {
    const want = derivePurchaseCreditSources(uidPurchase, c.items);
    if (want.query_by_sources.join(" ") !== c.query_by_sources.join(" ")) {
      ctx.addIssue({ code: "custom", path: ["query_by_sources"], message: "query_by_sources must be derivePurchaseCreditSources over the credit's lines" });
    }
    if (want.sources.map((s) => s.uid).join(" ") !== c.sources.map((s) => s.uid).join(" ")) {
      ctx.addIssue({ code: "custom", path: ["sources"], message: "sources must name the purchase, then each bill the lines credit" });
    }
  }
  // An empty credit (allowed at zero) has no rows to lead with.
  if (c.items.length > 0) checkLeadingDivider("purchase_document")({ items: c.items, query_by_purchases: uidPurchase ? [uidPurchase] : [] }, ctx);
  checkDestinationJoin(c, ctx);
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
  sources: z.array(DocSource).min(1),
  query_by_sources: z.array(z.string()),
  supplier: UidNameRef.meta({ label: "Supplier" }),
  origin: PurchaseDocumentOriginEnum.meta({ column: true, label: "Origin" }),
  reason: PurchaseCreditReasonEnum.meta({ column: true, label: "Reason" }),
  status: PurchaseCreditStatusEnum.meta({ column: true, label: "Status" }),
  xero_id: z.uuid().nullable(),
  date: chicagoStartOfDay().meta({ serverSortVia: "date_fs", column: true, label: "Date" }),
  date_fs: FirestoreTimestamp,
  reference: z.string().max(255).nullable().meta({ column: true, label: "Reference" }),
  items: z.array(PurchaseDocumentRowSchema).meta({ label: "Item" }),
  destinations: z.array(PurchaseDocDestinationSchema).meta({ label: "Destination" }),
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
  /**
   * The purchase item billed, by its path on the purchase: the row identity.
   * Its uid is its product's (W4K), and one product may sit on two items.
   */
  path_purchase_item: string[];
  quantity: number;
}

/** Zod schema for PurchaseDocumentItemInputType. */
export const PurchaseDocumentItemInput: z.ZodType<PurchaseDocumentItemInputType> = z.object({
  path_purchase_item: z.array(ItemUid).min(1),
  quantity: z.int().min(1),
});

/**
 * One line of a supplier CREDIT as an operator states it: a purchase item, or a
 * bill line (one-document-model 6d), and what it un-bills.
 *
 * - **flat, naming no bill line** — `quantity` units, priced from the line's
 *   billed pool (`purchaseLineCreditCents`): the pool's share, or a stated
 *   `amount_cents` the pool caps.
 * - **flat, naming a bill line** — units `(c, c + quantity]` of that line, `c`
 *   what live credits already took from it, priced first-come from the line's
 *   own money (`billLineCreditCents`), or a stated `amount_cents` capped at what
 *   is left of it. The units are capped per bill line and by the pools behind
 *   them (`creditableBillLines`).
 * - **time** — credited by COUNTS, as an AR credit note is (0b ruling 3):
 *   `quantity` units over `counts`, priced `rates × counts` like the bill line
 *   it reverses. Absent `counts`, the writer credits everything the line is
 *   billed for, net (`purchaseLineBilledCounts`). The per-unit windows this
 *   input used to take retired with the unit charge windows
 *   (one-document-model Phase 3).
 */
export interface PurchaseCreditItemInputType extends Omit<PurchaseDocumentItemInputType, "path_purchase_item"> {
  /**
   * The purchase item credited, by its path on the purchase. Required unless the
   * line names a bill line ({@link uid_purchase_bill} + {@link path_bill_item}):
   * a credit raised from a bill is keyed on the BILL LINE, and the writer derives
   * the purchase line from the row (one-document-model 6d, owner ruling 23), so a
   * substitute or a bill-authored line, which projects no purchase line of its
   * own, can be credited. A client may still send both.
   */
  path_purchase_item?: string[];
  /** A time line's counts to credit; refused on a flat line by the writer. */
  counts?: TierCountType[];
  /**
   * The bill line credited (api-cloudrun#1439). Both or neither with
   * {@link path_bill_item}; refused on a link. Its units are capped per bill line
   * (`creditableBillLines`) and priced first-come from it (`billLineCreditCents`).
   */
  uid_purchase_bill?: string;
  path_bill_item?: string[];
  /** A pushed flat line's stated credit, capped at the line's billed pool; a supplier's memo governs. */
  amount_cents?: number;
}

/** Zod schema for PurchaseCreditItemInputType. */
export const PurchaseCreditItemInput: z.ZodType<PurchaseCreditItemInputType> = z.object({
  // Optional only beside a named bill line; `uniqueItemInputs` requires one or the other.
  path_purchase_item: z.array(ItemUid).min(1).optional(),
  quantity: z.int().min(1),
  counts: z.array(z.object({ rate_key: RateKey, num: z.int().min(0), den: z.int().min(1) })).min(1).optional(),
  uid_purchase_bill: FirestoreId.optional(),
  path_bill_item: z.array(ItemUid).min(1).optional(),
  amount_cents: z.int().min(0).optional(),
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
  /**
   * The product the charge attributes. On a replacement charge it is the lost
   * rental's money-only twin (`uid_linked_replacement`), which the writer
   * derives from the record — never the rental itself (owner ruling 15).
   */
  uid_product?: string;
  /** The records a replacement charge bills; its shares sum to 1. */
  out_of_service?: OutOfServiceEntryType[];
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
  // The stripping twin, as `tests/input-strictness.test.ts` requires of a new
  // node: the charge node itself stays strict (see the docblock above).
  out_of_service: OutOfServiceListInput.optional(),
  uid_tracking_category: FirestoreId.nullable().optional(),
}).superRefine((item, ctx) => {
  // The writer stamps `quantity: 1` on a charge, so its shares sum to 1.
  for (const [path, message] of outOfServiceLinkIssues(item, { quantity: 1 })) {
    ctx.addIssue({ code: "custom", path, message });
  }
});

/**
 * Each credited ROW once per write, and every line names what it bills or
 * credits.
 *
 * - A line names a purchase item (`path_purchase_item`) or, on a credit, a bill
 *   line (`uid_purchase_bill` + `path_bill_item`, both or neither).
 * - Keyed on the row the write produces under the purchase divider: a bill line's
 *   own path below that divider when one is named, else the purchase line's
 *   path. A credit row copies the bill row it credits (owner ruling 23), so two
 *   items resolving to one row would store one path twice. Two bills' lines at
 *   one path are therefore credited in two writes; two rows of one split
 *   purchase line, at different paths, in one.
 */
function uniqueItemInputs(
  items: readonly { path_purchase_item?: readonly string[]; uid_purchase_bill?: string; path_bill_item?: readonly string[] }[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const halves = (item.uid_purchase_bill === undefined) !== (item.path_bill_item === undefined);
    if (halves) {
      ctx.addIssue({ code: "custom", path: ["items", i, "path_bill_item"], message: "uid_purchase_bill and path_bill_item are set together" });
    }
    const named = item.path_bill_item !== undefined && item.uid_purchase_bill !== undefined;
    const row = named ? item.path_bill_item!.slice(1) : item.path_purchase_item;
    if (row === undefined) {
      if (!halves) {
        ctx.addIssue({ code: "custom", path: ["items", i, "path_purchase_item"], message: "a line names its purchase item, or a bill line it credits" });
      }
      return;
    }
    const key = row.join("/");
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: ["items", i, named ? "path_bill_item" : "path_purchase_item"],
        message: "one item per credited row; credit another bill's line at the same path in a second credit",
      });
    }
    seen.add(key);
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
 * Each `items` entry UN-bills that quantity of its purchase item, or of the
 * bill line it names: it lowers `quantity_billed`, and a PUSHED credit prices it
 * from the line's billed pool (`purchaseLineCreditCents`) or from the named bill
 * line (`billLineCreditCents`), so more than was billed cannot be credited. A price correction with no quantity is a `charge_items` entry
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

/** A divider row of a bill's whole-array input. */
export interface PurchaseBillDividerInputType {
  type: "purchase" | "destination" | "group";
  uid: string;
  path: string[];
  name?: string;
}

/**
 * A line row of a bill's whole-array input.
 *
 * The writer pairs each row to a stored one (exact path, then the row's uid and
 * ancestry), and the paired row is the base for every key this row omits, so a
 * row that moved keeps them. A row no stored row pairs with is, in order: a
 * split's clone if it states {@link path_purchase_item}; a line of the purchase
 * named by its path; or a line the bill itself authors, which states its name,
 * account, quantity and money (and `uid_product` on a sale or rental).
 *
 * On a TIME line `price.rates` restates each unit rate; a flat line's
 * `amount_cents` is stated directly (gross when a discount is set).
 *
 * `path_purchase_item` absent keeps the stored pointer, and there is no `null`
 * form: the writer stamps every moved row's pointer and clears one a move back
 * made pointless, so a stale client's identity-only rows cannot clear one.
 * The writer assigns the tax class and a bill-authored line's flat formula.
 */
export interface PurchaseBillLineInputType {
  type: SharedLineType;
  uid: string;
  path: string[];
  name?: string;
  description?: string;
  quantity?: number;
  amount_cents?: number;
  /** `null` is a stored kit header echoed back; the writer decides what a `none` product holds. */
  ledger_account?: COACodeType | null;
  /** The product a bill-authored sale or rental bills. A stored line's product never changes. */
  uid_product?: string;
  /** A kit component's flag, as on an order line's input. */
  zero_priced?: boolean | null;
  /** A kit component's ratio to its direct parent. */
  quantity_per_parent?: number | null;
  /** The records a replacement row bills, shares summing to `quantity`. */
  out_of_service?: OutOfServiceEntryType[];
  /** The purchase line this row bills from another position. See the docblock. */
  path_purchase_item?: string[];
  /** What this row stands in for ({@link PurchaseDocumentProductItem.substituted_for}). */
  substituted_for?: SubstitutedForEntryType[];
  /** Absent keeps; `null` clears the operator's class, restoring the line's own. */
  uid_tax_class_override?: string | null;
  /** Absent keeps the line's category; a uid sets it; `null` restores its product's, the order/invoice line rule (none with no product). */
  uid_tracking_category?: string | null;
  price?: {
    /** A bill-authored time line's formula. A stored line's formula never changes here. */
    uid_price_formula?: string;
    rates?: { rate_key: string; amount_cents: number }[];
    discount?: DiscountInputType | null;
  };
}

/** One row of a bill's whole-array input. */
export type PurchaseBillRowInputType = PurchaseBillDividerInputType | PurchaseBillLineInputType;

/**
 * Input for editing a bill (`PUT /purchase-bills/{uid}`). `items`, when present,
 * is the WHOLE array in its new order, the invoice's shape (one-document-model
 * Phase 5): a row it omits is removed. Refused per field class once the bill is
 * settled (`INVOICE_FIELD_FREEZE`); a settled linked bill takes a tracking edit
 * alone. An accepted edit is pushed to Xero through the ACCPAY edit push (D5).
 *
 * `destinations`, when present, edits the pairs it names, each stated whole; a
 * pair it leaves out is unchanged. A pair's membership follows its divider in
 * `items`, as on an invoice.
 */
export interface UpdatePurchaseBillInputType {
  version: number;
  date?: string;
  due_date?: string;
  reference?: string | null;
  items?: PurchaseBillRowInputType[];
  destinations?: PurchaseBillDestinationInputType[];
}

/**
 * A bill's pair as a client sends it: a purchase's pair input scoped by
 * `uid_purchase`, the `InvoiceDocDestination` input's twin.
 */
export interface PurchaseBillDestinationInputType extends PurchaseDestinationInputType {
  uid_purchase: string;
}

/** Zod schema for {@link PurchaseBillDestinationInputType}. */
export const PurchaseBillDestinationInput: z.ZodType<PurchaseBillDestinationInputType> = z.object({
  uid_purchase: FirestoreId,
  uid: z.uuid(),
  ...PairInputCore,
}).superRefine(purchaseDestinationInputIssues);

const billDividerInput = (type: "purchase" | "destination" | "group") =>
  z.object({ type: z.literal(type), uid: ItemUid, path: z.array(ItemUid).min(1), name: LineItemCore.name.optional() });

const billLineInput = (type: SharedLineType) =>
  z.object({
    type: z.literal(type),
    uid: ItemUid,
    path: z.array(ItemUid).min(1),
    name: LineItemCore.name.optional(),
    description: LineItemCore.description.optional(),
    quantity: z.int().min(1).optional(),
    amount_cents: z.int().min(0).optional(),
    ledger_account: COACode.nullable().optional(),
    uid_product: FirestoreId.optional(),
    zero_priced: z.boolean().nullable().optional(),
    quantity_per_parent: z.number().min(0).nullable().optional(),
    out_of_service: OutOfServiceListInput.optional().meta({ seed: false }),
    path_purchase_item: z.array(ItemUid).min(1).optional(),
    substituted_for: SubstitutedForListInput.optional(),
    uid_tax_class_override: FirestoreId.nullable().optional(),
    uid_tracking_category: FirestoreId.nullable().optional(),
    price: z.object({
      uid_price_formula: FirestoreId.optional(),
      rates: z.array(z.object({ rate_key: RateKey, amount_cents: z.int() })).optional(),
      discount: DiscountInput.nullable().optional(),
    }).optional(),
  }).superRefine((row, ctx) => {
    // A row naming its product is keyed by it (W4K), as a purchase line input is.
    const message = payableInputUidIssue(row);
    if (message !== null) ctx.addIssue({ code: "custom", path: ["uid"], message });
    for (const [path, msg] of outOfServiceLinkIssues(row)) ctx.addIssue({ code: "custom", path, message: msg });
  });

/** Zod schema for one {@link PurchaseBillRowInputType}. */
export const PurchaseBillRowInput: z.ZodType<PurchaseBillRowInputType> = z.discriminatedUnion("type", [
  billDividerInput("purchase"),
  billDividerInput("destination"),
  billDividerInput("group"),
  billLineInput("sale"),
  billLineInput("rental"),
  billLineInput("service"),
  billLineInput("replacement"),
]);

/** Zod schema for UpdatePurchaseBillInputType. */
export const UpdatePurchaseBillInput: z.ZodType<UpdatePurchaseBillInputType> = z.object({
  version: z.int().min(0),
  date: chicagoStartOfDay().optional(),
  due_date: chicagoStartOfDay().optional(),
  reference: z.string().max(255).nullable().optional(),
  items: z.array(PurchaseBillRowInput).optional(),
  destinations: z.array(PurchaseBillDestinationInput).optional(),
}).superRefine((u, ctx) => {
  const seen = new Set<string>();
  u.items?.forEach((item, i) => {
    const key = item.path.join("/");
    if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["items", i, "path"], message: "a row appears once per write" });
    seen.add(key);
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

/**
 * Input for marking a $0 bill paid, or undoing that. `version` is the bill's.
 * The refusals are `closeRefusal` and `purchaseBillReopenRefusal`.
 */
export interface PurchaseBillClosureInputType {
  version: number;
}

/** Zod schema for PurchaseBillClosureInputType. */
export const PurchaseBillClosureInput: z.ZodType<PurchaseBillClosureInputType> = z.object({
  version: z.int().min(0),
});
