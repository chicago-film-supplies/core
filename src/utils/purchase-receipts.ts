/**
 * Purchase receipt rows — why a stored receipt row exists.
 *
 * The receipt (`schemas/purchase-receipt.ts`) is the payable side's custody
 * document, the twin of the fulfillment. This module holds the receipt's twin
 * of `fulfillmentRowSources` (`utils/fulfillment-items.ts`): ONE classifier for
 * "why does this row exist", which every reader of a receipt row asks through
 * (the receiver's save, the purchase → receipt sync, the drift audit), so a new
 * kind of receipt-only row is a new member of the union rather than a branch
 * taught to some readers and not others (core#129's lesson on the fulfillment).
 *
 * @module
 */
import { isPurchaseReceiptLineItem } from "../schemas/purchase-receipt.ts";
import type { PurchaseReceiptItemType, PurchaseReceiptLineItemType } from "../schemas/purchase-receipt.ts";
import { PURCHASE_PRODUCT_ITEM_TYPES } from "../schemas/purchase.ts";

/**
 * Why a stored receipt LINE row exists — {@link receiptRowSources}.
 *
 * | source | the row is | how it is told |
 * |---|---|---|
 * | `purchase` | the purchase's own custody line | a `sale` or `rental` purchase row is at its path |
 * | `kept` | a line the purchase closed while its units were held (ruling 47) | `quantity_ordered: 0` |
 * | `receipt_extra` | a line the supplier sent that the PO lacks (ruling 35) | `quantity_ordered: null` |
 * | `unexplained` | none of these — a finding | — |
 *
 * The fulfillment's `substitution`, `exchange` and `invoice_projected` have no
 * twin here: nothing substitutes on a receipt, an Exchange on a subrent is a
 * PURCHASE-side operation (ruling 7), and no billing document projects onto the
 * receipt.
 */
export type ReceiptRowSource = "purchase" | "kept" | "receipt_extra" | "unexplained";

/** The purchase fields {@link receiptRowSources} reads. */
export interface ReceiptRowSourcePurchase {
  items: ReadonlyArray<{ readonly type: string; readonly path: readonly string[] }>;
}

/** The receipt fields {@link receiptRowSources} reads. */
export interface ReceiptRowSourceReceipt<T extends PurchaseReceiptLineItemType> {
  items: ReadonlyArray<PurchaseReceiptItemType | T>;
}

const CUSTODY_TYPES: ReadonlySet<string> = new Set(PURCHASE_PRODUCT_ITEM_TYPES);

/** `path` as a map key. `\x1f` cannot occur in a uid, so this cannot collide. */
const pathKey = (path: readonly string[]): string => path.join("\x1f");

/**
 * Classify every LINE row of a stored receipt by why it exists.
 *
 * **Precedence is the table's order**, top first: a row at a purchase custody
 * path is `purchase` whatever its `quantity_ordered` says (the sync re-stamps
 * that field later in the same transaction than the bookings read it, so it is
 * never the ownership test). Off the purchase, `quantity_ordered` is the
 * server's signature: `0` is a row the sync KEPT, `null` is a row a receiver
 * added, and a positive count names a purchase line that is not there — a sync
 * that did not run, which is the finding.
 *
 * ⚠️ **Only the purchase's `sale` and `rental` rows count**, kit headers
 * included: a `service` or `replacement` line moves no custody, so a receipt row
 * at its path is not the purchase's.
 *
 * ⚠️ **Dividers are not classified** — their survival is a placement question
 * (`placeStoredOnlyRows`), not a provenance one, as on the fulfillment.
 *
 * @param receipt - The stored receipt
 * @param purchase - The purchase it projects
 * @returns Each line row, by object identity, mapped to its source
 */
export function receiptRowSources<T extends PurchaseReceiptLineItemType>(
  receipt: ReceiptRowSourceReceipt<T>,
  purchase: ReceiptRowSourcePurchase,
): Map<T, ReceiptRowSource> {
  const purchasePaths = new Set(
    purchase.items.filter((i) => CUSTODY_TYPES.has(i.type)).map((i) => pathKey(i.path)),
  );
  const out = new Map<T, ReceiptRowSource>();
  for (const row of receipt.items) {
    if (!isPurchaseReceiptLineItem(row as PurchaseReceiptItemType)) continue;
    const line = row as T;
    const q = line.quantity_ordered;
    const source: ReceiptRowSource = purchasePaths.has(pathKey(line.path))
      ? "purchase"
      : q === 0
      ? "kept"
      : q === null
      ? "receipt_extra"
      : "unexplained";
    out.set(line, source);
  }
  return out;
}
