/**
 * Test lenses over the per-line account (one-document-model 6e-0b2 F9).
 *
 * Beta F deleted `invoicedByPath`, `invoiceOnlyLines`, `remainingForOrder` and
 * the document-taking builders; every reader now goes through `billedByPath` →
 * `accountInitiator`. The tests that pinned those functions' behaviour still
 * hold, so they read the account through these lenses instead of being
 * rewritten one assertion at a time — which makes each of them a check that the
 * account reproduces the old answer.
 *
 * A lens reshapes; it decides nothing. Every number comes from the account.
 */
import {
  type AccountedCreditNote,
  type AccountedInvoice,
  accountBilling,
  type AccountingContext,
  billedByPath,
  buildOverbillingCredits,
  buildRemainingInvoice,
  type DocumentOnlyLines,
  type InitiatorAccount,
  type OverbillingCredits,
  type RemainingInvoice,
  type RemainingOrderSource,
} from "../../src/utils/quantityAccounting.ts";
import { computeOrderInvoiceCoverage, type OrderInvoiceCoverage } from "../../src/utils/invoices.ts";
import type { LineItem } from "../../src/utils/orders.ts";
import type { DocDestinationType } from "../../src/schemas/mod.ts";
import { type PurchaseBilledDocuments, purchaseBillingFold } from "../../src/utils/purchase-documents.ts";

/** A context that meters nothing: enough for an account built with no pairs. */
const NO_METER: AccountingContext = { formulas: new Map(), holidays: [] };

/** The receivable account of an order over its invoices and credit notes. */
export function orderAccount(
  orderUid: string,
  items: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
  destinations: readonly DocDestinationType[] = [],
  ctx: AccountingContext = NO_METER,
  creditNotes: readonly AccountedCreditNote[] = [],
): InitiatorAccount {
  return accountBilling("receivable", { uid: orderUid, items, destinations }, invoices, creditNotes, ctx);
}

/** `billedByPath("receivable", …)` — the fold the deleted `invoicedByPath` was. */
export function billedAR(
  orderUid: string,
  items: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
  creditNotes: readonly AccountedCreditNote[] = [],
) {
  return billedByPath("receivable", { uid: orderUid, items }, invoices, creditNotes);
}

/** The fold's `document_only`, with the fold's `compared` / `unaligned` / `credits_unkeyed` beside it. */
export function documentOnlyAR(
  orderUid: string,
  items: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
  creditNotes: readonly AccountedCreditNote[] = [],
): DocumentOnlyLines & { compared: string[]; unaligned: string[]; credits_unkeyed: string[] } {
  const fold = billedAR(orderUid, items, invoices, creditNotes);
  return { ...fold.document_only, compared: fold.compared, unaligned: fold.unaligned, credits_unkeyed: fold.credits_unkeyed };
}

/** One account line as the deleted `remainingForOrder` listed it. */
export interface RemainderViewLine {
  path: string[];
  item: LineItem;
  ordered: number;
  /** Billed units, floored at 0 where a caller acts (R2). */
  invoiced: number;
  /** `ordered − invoiced`; negative is over-billing. */
  quantity: number;
  quantity_cents: number;
  extension_cents: number;
  /** Nothing bills the path. */
  new: boolean;
  bills: boolean;
}

/**
 * The lines a remainder caller sees: each account line with something to bill,
 * or billed beyond the order — the deleted `remainingForOrder`'s view. Empty, with
 * the refusal named, when the account refuses.
 */
export function remainderView(
  orderUid: string,
  items: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
  destinations: readonly DocDestinationType[],
  ctx: AccountingContext,
  creditNotes: readonly AccountedCreditNote[] = [],
): { lines: RemainderViewLine[]; compared: string[]; unaligned: string[]; crms_authored: string[]; credits_unkeyed: string[] } {
  const account = orderAccount(orderUid, items, invoices, destinations, ctx, creditNotes);
  const crms_authored = [...account.documents.values()]
    .filter((d) => d.role === "billing" && d.live && d.crms_id !== null)
    .map((d) => d.uid);
  const head = { compared: account.compared, unaligned: account.unaligned, crms_authored, credits_unkeyed: account.credits_unkeyed };
  if (account.refused) return { lines: [], ...head };
  const lines: RemainderViewLine[] = [];
  for (const line of account.lines) {
    const invoiced = Math.max(0, line.billed.quantity);
    const quantity = line.ordered - invoiced;
    const extension_cents = line.extension.amount_cents;
    if (quantity === 0 && extension_cents === 0 && !line.remaining.bills) continue;
    lines.push({
      path: line.path,
      item: line.item,
      ordered: line.ordered,
      invoiced,
      quantity,
      quantity_cents: line.quantity_cents,
      extension_cents,
      new: !line.named,
      bills: line.remaining.bills,
    });
  }
  return { lines, ...head, crms_authored: [] };
}

/** `buildRemainingInvoice` over the order's account. */
export function remainingInvoiceOf(
  order: RemainingOrderSource,
  invoices: readonly AccountedInvoice[],
  creditNotes: readonly AccountedCreditNote[],
  ctx: AccountingContext,
  mintUid?: () => string,
): RemainingInvoice {
  return buildRemainingInvoice(order, orderAccount(order.uid, order.items, invoices, order.destinations, ctx, creditNotes), mintUid);
}

/** `buildOverbillingCredits` over the order's account. */
export function overbillingOf(
  order: RemainingOrderSource,
  invoices: readonly AccountedInvoice[],
  ctx: AccountingContext,
  creditNotes: readonly AccountedCreditNote[] = [],
): OverbillingCredits {
  return buildOverbillingCredits(orderAccount(order.uid, order.items, invoices, order.destinations, ctx, creditNotes));
}

/** `computeOrderInvoiceCoverage` over an order's account with no credit notes. */
export function coverageOf(
  orderUid: string,
  items: readonly LineItem[],
  invoices: readonly AccountedInvoice[],
): OrderInvoiceCoverage {
  return computeOrderInvoiceCoverage(orderAccount(orderUid, items, invoices));
}

/** `{ quantity, amount_cents }` the payable fold bills at one purchase line — the deleted `purchaseLineBilledNet`'s answer. */
export function billedNetAP(path: readonly string[], documents: PurchaseBilledDocuments): { quantity: number; amount_cents: number } {
  const at = purchaseBillingFold(documents).byPath.get(path.join("/"));
  return { quantity: at?.quantity ?? 0, amount_cents: at?.amount_cents ?? 0 };
}
