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
 * server refuses, because the route asserts the same functions. This one does
 * not have that guarantee: the API keeps its own refusals, and only
 * {@link purchaseItemTouched} is shared with it. So each rule here is a
 * statement of what `api-cloudrun/src/services/purchases.ts` and
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
  type BuyItem,
  type ChargeItem,
  type Purchase,
  type PurchaseActionId,
  type PurchaseBill,
  type PurchaseCredit,
  type PurchaseItem,
  purchaseItemBasis,
  type SubrentItem,
  type UnitType,
} from "../schemas/mod.ts";
import {
  type PurchaseBilledDocuments,
  purchaseBillIsLive,
  type PurchaseDocumentContext,
  projectPurchaseLineToBillLine,
} from "./purchase-documents.ts";
import { remainingToBill, remainingToReceive, remainingToReturn } from "./purchases.ts";

/** The keys of a purchase line the ruleset reads — so a line not yet saved can be asked too. */
type LineKeys = "uid" | "path" | "quantity" | "quantity_billed" | "quantity_canceled" | "price";

/** A purchase line as the ruleset reads it. */
export type PurchaseActionItem =
  | Pick<BuyItem, LineKeys | "type" | "quantity_received">
  | Pick<SubrentItem, LineKeys | "type" | "quantity_received" | "quantity_returned">
  | Pick<ChargeItem, LineKeys | "type">;

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
  /**
   * What a time line's bill is projected from. **Absent ⇒ a time line is offered
   * for its open units unprobed**, and the server answers `nothing_to_bill` if
   * they are already billed.
   */
  billing?: {
    /** The billing cut-off, a Chicago instant. */
    through: string;
    units: readonly Pick<UnitType, "uid" | "charge_windows">[];
    billed: PurchaseBilledDocuments;
    pricing: PurchaseDocumentContext;
  };
}

/** The paths of the purchase lines a LIVE bill names, each joined with `/`. */
export function purchaseBilledPaths(bills: readonly Pick<PurchaseBill, "totals" | "items">[]): Set<string> {
  return new Set(
    bills.filter(purchaseBillIsLive).flatMap((b) =>
      b.items.flatMap((l) => (l.path_purchase_item === undefined ? [] : [l.path_purchase_item.join("/")]))
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
    case "buy":
      return billed || item.quantity_received + item.quantity_canceled > 0;
    case "subrent":
      return billed || item.quantity_received + item.quantity_canceled + item.quantity_returned > 0;
    case "charge":
      return billed || item.quantity_canceled > 0;
    default: {
      const unreachable: never = item;
      throw new Error(`purchaseItemTouched: unknown item ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * **Would a close change this line?** Units still to arrive are canceled; a
 * charge cancels its unbilled quantity, or all of it on a time line. A subrent
 * with units still out is NOT closable: the close zeroes its supply, so the API
 * refuses it until they have gone back.
 */
export function purchaseItemClosable(item: PurchaseActionItem): boolean {
  switch (item.type) {
    case "charge":
      return item.quantity - item.quantity_canceled - (item.quantity_billed ?? 0) > 0;
    case "subrent":
      return remainingToReturn(item) === 0 && remainingToReceive(item) > 0;
    case "buy":
      return remainingToReceive(item) > 0;
    default: {
      const unreachable: never = item;
      throw new Error(`purchaseItemClosable: unknown item ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Whether a close leaves this line canceled in full: nothing received, and no flat charge billed. */
function closeCancels(item: PurchaseActionItem): boolean {
  return item.type === "charge" ? (item.quantity_billed ?? 0) === 0 : item.quantity_received === 0;
}

/** The units a line may still bill, 0 when it has nothing to bill. */
function billableQuantity(item: PurchaseActionItem, billing: PurchaseOfferContext["billing"]): number {
  if (purchaseItemBasis(item) === "flat") {
    return remainingToBill({
      quantity: item.quantity,
      quantity_billed: item.quantity_billed ?? 0,
      quantity_canceled: item.quantity_canceled,
    });
  }
  const open = Math.max(0, item.quantity - item.quantity_canceled);
  if (billing === undefined || open === 0) return open;
  try {
    // The projector reads the line's price, span and units, none of them
    // stamped by the server, so a line not yet saved projects `null` or throws.
    const line = projectPurchaseLineToBillLine(
      item as PurchaseItem,
      { uid: "probe", uid_purchase: "probe", quantity: 0, through: billing.through, units: billing.units, billed: billing.billed },
      billing.pricing,
    );
    return line?.quantity ?? 0;
  } catch {
    return 0;
  }
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
  purchase: Pick<Purchase, "status" | "query_by_bills"> & { items: readonly PurchaseActionItem[] },
  ctx: PurchaseOfferContext = {},
): PurchaseActionOffer[] {
  const offers: PurchaseActionOffer[] = [];
  const { items, status } = purchase;
  const active = status === "active";
  const unitsOut = items.some((i) => i.type === "subrent" && remainingToReturn(i) > 0);
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
      const max = billableQuantity(item, ctx.billing);
      if (max > 0) line("bill_item", { max_quantity: max });
    }
    if (!purchaseItemTouched(item, billedPaths)) {
      line("remove_item");
      line("change_basis");
    }
  }
  return offers;
}

/** Everything an operator may do to a bill: spend credit on it while it is a live ACCPAY with money due. */
export function purchaseBillActionsFor(
  bill: Pick<PurchaseBill, "totals" | "xero_document">,
): PurchaseActionOffer[] {
  if (bill.xero_document !== "invoice" || !purchaseBillIsLive(bill) || bill.totals.amount_due_cents <= 0) return [];
  return [{ key: "allocate_credit", action: "allocate_credit", max_cents: bill.totals.amount_due_cents }];
}

/** Everything an operator may do to a supplier credit: void it while nothing has drawn on it. */
export function purchaseCreditActionsFor(
  credit: Pick<PurchaseCredit, "status" | "total_cents" | "remaining_credit_cents">,
): PurchaseActionOffer[] {
  if (credit.status === "void" || credit.remaining_credit_cents !== credit.total_cents) return [];
  return [{ key: "void_credit", action: "void_credit" }];
}
