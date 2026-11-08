/**
 * **Is this pushed bill's Xero twin up to date?** Answered from the bill and its
 * `purchase-bills/{uid}/xero-sync/state` watermark alone, with no Xero call. The
 * supplier side's twin of `utils/invoice-xero-sync.ts`, and derived the same way:
 * the watermark holds the hash of what the last SUCCESSFUL push carried, so every
 * way a push can fail leaves the bill reading out of sync.
 *
 * ## Why a second hash on the watermark
 *
 * A bill's `pushed_hash` hashes the API-built body, which folds in the product's
 * `xero_code` and the category's Xero option. The manager cannot compute that, and
 * a product change moved it for no edit anyone made, so the daily sweep sent an
 * unrequested Xero edit. {@link purchaseBillXeroProjectionHash} is a pure function
 * of the bill, stored as `pushed_projection_hash`. `pushed_hash` could not simply
 * change meaning: stored watermarks hold the old value, and every one would read
 * as an edit.
 *
 * @module
 */
import { type PurchaseBill, purchaseDocumentLines, type XeroSyncState } from "../schemas/mod.ts";
import { canonicalJson, hash48 } from "./contentHash.ts";
import { purchaseBillIsLive } from "./invoices.ts";

/** The part of a bill the Xero body is built from. */
export type PurchaseBillXeroFields = Pick<PurchaseBill, "items" | "date" | "due_date" | "reference">;

/**
 * Exactly what api-cloudrun's `buildPurchaseBillBody` reads of a bill.
 *
 * ⚠️ **Lines keep their stored order**, which the body's line order follows.
 * ⚠️ Deliberately absent, each for a reason:
 * - `uid` and `price`: the body reads neither (`amount_cents` is the money).
 * - the contact: an edit sends back Xero's own.
 * - totals and settlements: Xero learns of a payment from its own ledger.
 *
 * `api-cloudrun/tests/unit/purchaseBillXeroProjection.test.ts` perturbs every leaf
 * through the real builder, so a field the body starts reading cannot be missing
 * here unnoticed.
 */
export function purchaseBillXeroProjection(bill: PurchaseBillXeroFields): unknown {
  return {
    // Lines only: a divider is never a Xero line, so the hash reads what Xero
    // holds and stays where it stood before dividers existed (one-document-model
    // Phase 3; the `invoiceXeroProjection` filter is the precedent).
    items: purchaseDocumentLines(bill.items).map((item) => ({
      type: item.type,
      uid_product: item.uid_product ?? null,
      name: item.name,
      quantity: item.quantity,
      amount_cents: item.amount_cents,
      ledger_account: item.ledger_account,
      uid_tracking_category: item.uid_tracking_category,
    })),
    date: bill.date,
    due_date: bill.due_date,
    reference: bill.reference,
  };
}

/** The hash a successful push records as `pushed_projection_hash`. */
export function purchaseBillXeroProjectionHash(bill: PurchaseBillXeroFields): string {
  return hash48(canonicalJson(purchaseBillXeroProjection(bill)));
}

/**
 * - `in_sync` — Xero carries this bill as it stands.
 * - `out_of_sync` — it does not, or the bill never reached Xero at all.
 * - `unknown` — no push has recorded a projection hash yet. Not a claim either way.
 * - `not_applicable` — a linked bill (CFS never pushes it) or a void one.
 */
export type PurchaseBillXeroSyncStatus = "in_sync" | "out_of_sync" | "unknown" | "not_applicable";

/**
 * See {@link PurchaseBillXeroSyncStatus}. `state` is the watermark, or `null` when absent.
 *
 * ⚠️ **A settled bill still compares.** Out of sync is a true statement about Xero
 * whether or not CFS can do anything about it; a settled bill only loses the push
 * (`purchaseBillPushRefusal`, `@cfs/core/utils/purchase-actions`).
 */
export function purchaseBillXeroSyncStatus(
  bill: PurchaseBillXeroFields & Pick<PurchaseBill, "origin" | "xero_id" | "totals" | "status">,
  state: Pick<XeroSyncState, "pushed_projection_hash"> | null,
): PurchaseBillXeroSyncStatus {
  if (bill.origin !== "pushed" || !purchaseBillIsLive(bill)) return "not_applicable";
  if (!bill.xero_id) return "out_of_sync";
  const pushed = state?.pushed_projection_hash ?? null;
  if (pushed === null) return "unknown";
  return pushed === purchaseBillXeroProjectionHash(bill) ? "in_sync" : "out_of_sync";
}
