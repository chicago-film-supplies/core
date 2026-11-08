/**
 * The purchase action ruleset — ONE answer to "what may an operator do to this
 * purchase, this line, this bill or this supplier credit?", the supplier side's
 * twin of `utils/invoice-actions.ts`.
 *
 * Three offer functions, each returning only ids from `PURCHASE_ACTION_IDS`:
 *
 * - {@link purchaseActionsFor} — on a purchase and its lines;
 * - {@link purchaseBillActionsFor} — on a bill;
 * - {@link purchaseCreditActionsFor} — on a supplier credit.
 *
 * ## ⚠️ There is no `assert*` here yet, unlike the invoice ruleset
 *
 * The invoice module's guarantee is that a button cannot be offered that the
 * server refuses, because the route asserts the same functions. This one has
 * that guarantee for three rules only: {@link purchaseItemTouched},
 * {@link purchaseBillVoidRefusal} and {@link purchaseBillPushRefusal} are shared
 * with the API. Every other rule here
 * is a statement of what `api-cloudrun/src/services/purchases.ts` and
 * `purchaseCredits.ts` refuse, matched by hand and pinned by tests on both
 * sides.
 *
 * ## Rules every caller keeps
 *
 * 1. **Fail closed.** An action this module does not offer is refused, and a
 *    line that cannot be probed is not offered.
 * 2. An offer is a snapshot of the documents it was handed; the server re-checks.
 *
 * @module
 */
import {
  isPurchaseLine,
  type PayableDividerType,
  type Purchase,
  type PurchaseActionId,
  type PurchaseBill,
  type PurchaseCredit,
  type PurchaseDocumentItem,
  purchaseItemBasis,
  purchaseLineKeyOf,
  purchaseLines,
  type PurchaseRentalItem,
  type PurchaseReplacementItem,
  type PurchaseSaleItem,
  type PurchaseServiceItem,
} from "../schemas/mod.ts";
import {
  type PurchaseBilledDocuments,
  purchaseBillIsLive,
  purchaseLineBilledNet,
} from "./purchase-documents.ts";
import type { PurchaseBillXeroSyncStatus } from "./purchase-bill-xero-sync.ts";
import { remainingToBill, remainingToReceive, remainingToReturn } from "./purchases.ts";

/** The keys of a purchase line the ruleset reads — so a line not yet saved can be asked too. */
type LineKeys = "uid" | "path" | "quantity" | "quantity_billed" | "quantity_canceled" | "price";

/** A purchase line as the ruleset reads it. */
export type PurchaseActionItem =
  | Pick<PurchaseSaleItem, LineKeys | "type" | "quantity_received">
  | Pick<PurchaseRentalItem, LineKeys | "type" | "quantity_received" | "quantity_returned">
  | Pick<PurchaseServiceItem, LineKeys | "type">
  | Pick<PurchaseReplacementItem, LineKeys | "type">;

/** One action the UI may offer. `key` is what a menu de-duplicates on. */
export interface PurchaseActionOffer {
  /** The action id, or `<action>:<uid_item>` for a per-line action. */
  key: string;
  action: PurchaseActionId;
  /** The per-line actions: the line it acts on. */
  uid_item?: string;
  /** `bill_item`: the most units it may bill. Always > 0. */
  max_quantity?: number;
  /** `allocate_credit`: the most cents it may move. Always > 0. */
  max_cents?: number;
  /**
   * `close`: what the close leaves the purchase as. `cancel` when every line
   * ends canceled in full, so the purchase reads canceled; `close` otherwise.
   */
  outcome?: "cancel" | "close";
}

/** What {@link purchaseActionsFor} needs that the purchase alone does not carry. */
export interface PurchaseOfferContext {
  /**
   * The paths a live bill names ({@link purchaseBilledPaths}): how a TIME line,
   * which counts no `quantity_billed`, is known to be billed. **Absent ⇒ none**,
   * so a billed time line reads as untouched; the server re-checks.
   */
  billed_paths?: ReadonlySet<string>;
}

/**
 * The paths of the lines of purchase `uidPurchase` that a LIVE bill bills,
 * each joined with `/` — relative to that purchase, so they compare with its
 * own `item.path`. A bill may bill several purchases, hence the scope.
 */
export function purchaseBilledPaths(
  bills: readonly Pick<PurchaseBill, "totals" | "items" | "voided_at">[],
  uidPurchase: string,
): Set<string> {
  const prefix = `${uidPurchase}/`;
  return new Set(
    bills.filter(purchaseBillIsLive).flatMap((b) =>
      b.items.flatMap((row) => {
        if (!isPurchaseLine(row)) return [];
        const key = purchaseLineKeyOf(row as PurchaseDocumentItem);
        return key !== null && key.startsWith(prefix) ? [key.slice(prefix.length)] : [];
      })
    ),
  );
}

/**
 * **Has anything happened to this line that makes it history as well as an
 * order?** A touched line cannot be removed or moved across bases. A time line
 * counts no `quantity_billed`, so whether a bill names it comes from
 * `billedPaths` ({@link purchaseBilledPaths}).
 */
export function purchaseItemTouched(item: PurchaseActionItem, billedPaths: ReadonlySet<string>): boolean {
  const billed = (item.quantity_billed ?? 0) > 0 || billedPaths.has(item.path.join("/"));
  switch (item.type) {
    case "sale":
      return billed || item.quantity_received + item.quantity_canceled > 0;
    case "rental":
      return billed || item.quantity_received + item.quantity_canceled + item.quantity_returned > 0;
    case "service":
    case "replacement":
      return billed || item.quantity_canceled > 0;
    default: {
      const unreachable: never = item;
      throw new Error(`purchaseItemTouched: unknown item ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * **Would a close change this line?** Units still to arrive are canceled; a
 * service or replacement cancels its unbilled quantity, or all of it on a time line. A rental
 * with units still out is NOT closable: the close zeroes its supply, so the API
 * refuses it until they have gone back.
 */
export function purchaseItemClosable(item: PurchaseActionItem): boolean {
  switch (item.type) {
    case "service":
    case "replacement":
      return item.quantity - item.quantity_canceled - (item.quantity_billed ?? 0) > 0;
    case "rental":
      return remainingToReturn(item) === 0 && remainingToReceive(item) > 0;
    case "sale":
      return remainingToReceive(item) > 0;
    default: {
      const unreachable: never = item;
      throw new Error(`purchaseItemClosable: unknown item ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Whether a close leaves this line canceled in full: nothing received, and no flat charge billed. */
function closeCancels(item: PurchaseActionItem): boolean {
  return item.type === "service" || item.type === "replacement"
    ? (item.quantity_billed ?? 0) === 0
    : item.quantity_received === 0;
}

/**
 * The units a line may still bill, 0 when it has nothing to bill: what is
 * ordered, less what is billed and canceled. A TIME line counts no
 * `quantity_billed`, so it offers its open units every time — what is left of
 * its time is the bill writer's `remainingTimeCounts`, not a unit count.
 */
function billableQuantity(item: PurchaseActionItem): number {
  return remainingToBill({
    quantity: item.quantity,
    quantity_billed: item.quantity_billed ?? 0,
    quantity_canceled: item.quantity_canceled,
  });
}

/**
 * **Everything an operator may do to a purchase and its lines.** Per-line offers
 * follow the purchase-level ones, in line order.
 *
 * `close` is refused whole while any subrent has units out, because the API
 * refuses a whole-purchase close on that line even when it has nothing left to
 * close.
 */
export function purchaseActionsFor(
  purchase: Pick<Purchase, "status" | "query_by_bills"> & {
    items: readonly (PurchaseActionItem | { type: PayableDividerType })[];
  },
  ctx: PurchaseOfferContext = {},
): PurchaseActionOffer[] {
  const offers: PurchaseActionOffer[] = [];
  const { status } = purchase;
  const items = purchase.items.filter((i): i is PurchaseActionItem => isPurchaseLine(i));
  const active = status === "active";
  const unitsOut = items.some((i) => i.type === "rental" && remainingToReturn(i) > 0);
  if (active && !unitsOut && items.some(purchaseItemClosable)) {
    offers.push({ key: "close", action: "close", outcome: items.every(closeCancels) ? "cancel" : "close" });
  }
  if (status !== "canceled") offers.push({ key: "add_bill", action: "add_bill" });
  if (purchase.query_by_bills.length > 0 || items.some((i) => (i.quantity_billed ?? 0) > 0)) {
    offers.push({ key: "add_credit", action: "add_credit" });
  }
  const billedPaths = ctx.billed_paths ?? new Set<string>();
  for (const item of items) {
    const line = (action: PurchaseActionId, extra: Partial<PurchaseActionOffer> = {}) =>
      offers.push({ key: `${action}:${item.uid}`, action, uid_item: item.uid, ...extra });
    if (active && purchaseItemClosable(item)) line("close_item");
    if (status !== "canceled") {
      const max = billableQuantity(item);
      if (max > 0) line("bill_item", { max_quantity: max });
    }
    if (!purchaseItemTouched(item, billedPaths)) {
      line("remove_item");
      line("change_basis");
    }
  }
  return offers;
}

/**
 * The bill an operator asks to void, or asks what it may do to: one of
 * {@link PurchaseBilledDocuments}' bills, and who authored it.
 */
export type PurchaseBillActionBill =
  & PurchaseBilledDocuments["bills"][number]
  & Pick<PurchaseBill, "origin">;

/**
 * What a bill's void is decided on: the bill's purchase and EVERY bill and credit
 * of that purchase. ⚠️ **Required, unlike {@link PurchaseOfferContext}.** That
 * context reads an absent key as "none", which is safe there because the server
 * re-checks. Here it would offer Void on an unknown answer, so a caller without
 * these documents cannot compile.
 */
export interface PurchaseBillContext extends PurchaseBilledDocuments {
  purchase: Pick<Purchase, "items">;
  /**
   * `purchaseBillXeroSyncStatus(bill, sidecar)`. The one optional key: absent means
   * `push_to_xero` is not offered, so an unknown answer cannot offer it.
   */
  xero_sync_status?: PurchaseBillXeroSyncStatus;
}

/**
 * Why an operator may not void this bill, or `null` when they may. The offer and
 * the API's route both ask this, so a button cannot offer what the server
 * refuses. A void from Xero is never refused and never reads this: Xero has
 * already voided the bill, and the count floors at 0.
 *
 * ⚠️ `amount_paid_cents` and `amount_credited_cents` are the journal folded, so
 * an unsynced allocation refuses too. Xero would refuse any payment or
 * allocation it holds.
 *
 * Only FLAT lines are read for the negative: a time line counts no
 * `quantity_billed`, so there is nothing for a recount to take below zero.
 */
export function purchaseBillVoidRefusal(bill: PurchaseBillActionBill, ctx: PurchaseBillContext): string | null {
  if (!purchaseBillIsLive(bill)) return `Bill ${bill.number} is already void.`;
  if (bill.origin === "linked") return `Bill ${bill.number} is linked to a document in Xero. Void it in Xero.`;
  if (bill.totals.amount_paid_cents > 0 || bill.totals.amount_credited_cents > 0) {
    return `Cannot void bill ${bill.number}: payments or supplier credits are applied to it. Remove them first.`;
  }
  const others = { uid_purchase: ctx.uid_purchase, bills: ctx.bills.filter((b) => b.uid !== bill.uid), credits: ctx.credits };
  const named = purchaseBilledPaths([bill], ctx.uid_purchase);
  const stranded = purchaseLines(ctx.purchase.items).filter((item) =>
    purchaseItemBasis(item) === "flat" && named.has(item.path.join("/")) &&
    purchaseLineBilledNet(item.path, others).quantity < 0
  );
  if (stranded.length > 0) {
    return `Cannot void bill ${bill.number}: a supplier credit would be left with no bill under it. Void the credit first.`;
  }
  return null;
}

/**
 * Why an operator may not ask for this bill to be pushed to Xero, or `null` when
 * they may. The offer and the API's route both ask this.
 *
 * ⚠️ **Unlike the invoice's `push_to_xero`, a bill not yet in Xero may be pushed.**
 * The bill task reads before it creates, and this is the only remedy an operator
 * has for a create Xero refused.
 *
 * A settled bill may be pushed, as an invoice may: Xero takes a tracking change on
 * it, and the task answers anything else with the
 * `purchase_bill_edit_has_settlements` seam.
 */
export function purchaseBillPushRefusal(
  bill: PurchaseBillActionBill,
  status: PurchaseBillXeroSyncStatus,
): string | null {
  if (!purchaseBillIsLive(bill)) return `Bill ${bill.number} is void.`;
  if (bill.origin === "linked") return `Bill ${bill.number} is linked to a document in Xero, so CFS does not push it.`;
  if (status === "in_sync") return `Xero already has bill ${bill.number} as it stands.`;
  return null;
}

/**
 * Everything an operator may do to a bill: spend credit on it while it is a live
 * ACCPAY with money due, void it unless {@link purchaseBillVoidRefusal} says
 * otherwise, and push it while {@link purchaseBillPushRefusal} allows.
 */
export function purchaseBillActionsFor(
  bill: PurchaseBillActionBill & Pick<PurchaseBill, "xero_document">,
  ctx: PurchaseBillContext,
): PurchaseActionOffer[] {
  const offers: PurchaseActionOffer[] = [];
  if (bill.xero_document === "invoice" && purchaseBillIsLive(bill) && bill.totals.amount_due_cents > 0) {
    offers.push({ key: "allocate_credit", action: "allocate_credit", max_cents: bill.totals.amount_due_cents });
  }
  if (purchaseBillVoidRefusal(bill, ctx) === null) offers.push({ key: "void_bill", action: "void_bill" });
  if (ctx.xero_sync_status !== undefined && purchaseBillPushRefusal(bill, ctx.xero_sync_status) === null) {
    offers.push({ key: "push_to_xero", action: "push_to_xero" });
  }
  return offers;
}

/** Everything an operator may do to a supplier credit: void it while nothing has drawn on it. */
export function purchaseCreditActionsFor(
  credit: Pick<PurchaseCredit, "status" | "total_cents" | "remaining_credit_cents">,
): PurchaseActionOffer[] {
  if (credit.status === "void" || credit.remaining_credit_cents !== credit.total_cents) return [];
  return [{ key: "void_credit", action: "void_credit" }];
}
