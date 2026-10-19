/**
 * **Is this issued invoice's Xero twin up to date?** — answered from the invoice
 * and its `invoices/{uid}/xero-sync/state` watermark alone, with no Xero call.
 *
 * ## Why it exists (api-cloudrun#1009, gate (c) of the order-propagation plan)
 *
 * An edit to an issued invoice reaches Xero through `/tasks/push-xero-invoice`.
 * When that push does not land — Xero refuses the payload (the task is dropped),
 * Cloud Tasks exhausts its retries, the day budget defers it to abandonment, or
 * the invoice needs manual intervention (payments applied) — the only record was
 * a log line. The invoice looked fine.
 *
 * So the state is DERIVED rather than recorded: the watermark's `pushed_hash` holds
 * the hash of {@link invoiceXeroProjection} as of the last push that SUCCEEDED, and the invoice
 * is out of sync whenever its current projection hashes differently. Every failure
 * mode above leaves the watermark behind, so every one shows, including those no
 * handler ever observes (a dropped task, a retry exhausted after the process died).
 *
 * ## One author for the projection
 *
 * The projection hash is ONE key with three readers: the enqueue gate
 * ({@link shouldPushInvoiceToXero}), the task's supersede check (the task payload
 * carries the hash it was enqueued for), and the manager's out-of-sync badge
 * ({@link invoiceXeroSyncStatus}). It lives here so the three cannot disagree
 * about what "the part Xero carries" means.
 *
 * ⚠️ **The gate compares against the WATERMARK, never old-vs-new** (api-cloudrun#1332).
 * The gate used to diff the old and new projections while the task superseded on
 * `version`. A settlement or a no-op PUT moves `version` and not the projection,
 * so it superseded the newest edit's task without re-arming one, and prod #2459
 * lost a $44.20 replacement line. Gated on the watermark, every write to a stale
 * invoice re-enqueues until a push lands. This is the order-quote push's design
 * (`api-cloudrun/src/services/orderDocWritten.ts`, gated on its `pushed_hash`).
 *
 * @module
 */
import type { Invoice, Settlement, XeroSyncState } from "../schemas/mod.ts";
import { isInvoiceLineItem, SETTLEMENT_CONTRACTS } from "../schemas/mod.ts";
import { canonicalJson, hash48 } from "./contentHash.ts";
import { liveSettlements } from "./invoices.ts";

/**
 * The part of an invoice that the Xero update body is built from.
 *
 * ⚠️ **Money totals and `status` are deliberately absent.** A settlement writer
 * advances `version` and moves `status` / `amount_*_cents` without touching a
 * line, and Xero learns of a payment from its own ledger, not from a push.
 *
 * ⚠️ **Lines are projected to what the body reads, never compared whole.**
 * api-cloudrun's `assembleXeroInvoiceUpdateBody` reads, per billable line: `uid`,
 * `name`, `quantity`, `coa_revenue`, `price.subtotal_cents`, `price.discount`,
 * and each tax's `uid` and `amount_cents`. Comparing `items` whole made every
 * key-only change a real Xero POST (api-cloudrun#993). api-cloudrun's
 * `api-cloudrun/tests/unit/xeroInvoiceEdit.test.ts` perturbs every leaf of a real line through
 * the real assembler, so a field the body starts reading cannot be missing here
 * unnoticed.
 */
export function invoiceXeroProjection(invoice: Partial<Invoice>): unknown {
  return {
    items: invoice.items?.filter(isInvoiceLineItem).map((line) => ({
      uid: line.uid,
      name: line.name ?? null,
      quantity: line.quantity ?? null,
      coa_revenue: line.coa_revenue ?? null,
      subtotal_cents: line.price?.subtotal_cents ?? null,
      discount: line.price?.discount ?? null,
      taxes: (line.price?.taxes ?? []).map((tax) => ({ uid: tax.uid, amount_cents: tax.amount_cents ?? 0 })),
    })) ?? null,
    date: invoice.date ?? null,
    due_date: invoice.due_date ?? null,
    reference: invoice.reference ?? null,
    subject: invoice.subject ?? null,
    contact: invoice.organization?.xero_id ?? null,
  };
}

// The two primitives live in `contentHash.ts`, the one copy. Re-exported so this
// module's public surface — and the `invoice-xero-sync` denylist entries — are
// unchanged.
export { canonicalJson, hash48 };

/** The hash a successful push records as the invoice sidecar's `pushed_hash`. */
export function invoiceXeroProjectionHash(invoice: Partial<Invoice>): string {
  return hash48(canonicalJson(invoiceXeroProjection(invoice)));
}

/**
 * - `in_sync` — the invoice's Xero-carried fields are what was last pushed.
 * - `out_of_sync` — they have changed since, and no push has landed; OR the invoice
 *   is issued and has no `xero_id` at all, because the issue POST never landed
 *   (a non-throttle refusal is logged and the status flip is not rolled back). For
 *   the moment between the status commit and the POST this reads out of sync too,
 *   which is true.
 * - `unknown` — linked and live, but no push has recorded a projection hash: no
 *   sidecar, or one written before this carried a hash (its `pushed_hash` is the
 *   old `v<version>` spelling). Not a claim either way.
 * - `not_applicable` — no Xero twin to keep in step: a draft, a void, or a paid
 *   invoice (exempt by owner rule).
 */
export type InvoiceXeroSyncStatus = "in_sync" | "out_of_sync" | "unknown" | "not_applicable";

/**
 * The spelling invoice sidecars carried before this module: `v<version>`. A hash
 * could in principle take that shape; if one ever did, it reads `unknown` — the
 * no-claim answer — rather than a wrong one.
 */
const LEGACY_VERSION_WATERMARK = /^v\d+$/;

/** Statuses whose Xero twin is live and should track CFS edits. */
const TRACKED_STATUSES: ReadonlySet<string> = new Set(["issued", "part_paid"]);

/** See {@link InvoiceXeroSyncStatus}. `state` is the watermark, or `null` when absent. */
export function invoiceXeroSyncStatus(
  invoice: Pick<Invoice, "status" | "xero_id"> & Partial<Invoice>,
  state: Pick<XeroSyncState, "pushed_hash"> | null,
): InvoiceXeroSyncStatus {
  if (!TRACKED_STATUSES.has(invoice.status)) return "not_applicable";
  if (!invoice.xero_id) return "out_of_sync";
  const pushed = state?.pushed_hash ?? null;
  if (pushed === null || LEGACY_VERSION_WATERMARK.test(pushed)) return "unknown";
  return pushed === invoiceXeroProjectionHash(invoice) ? "in_sync" : "out_of_sync";
}

/**
 * **Should this write enqueue a Xero edit push?** The one enqueue gate for an
 * issued invoice (api-cloudrun#1332).
 *
 * - `old.xero_id` must be set. The issue path patches `xero_id` onto the invoice
 *   before it writes the watermark, so that write would read `unknown` and enqueue
 *   an edit push for an invoice whose create POST has only just landed. The old
 *   side is what tells the two apart.
 * - The new state must read `out_of_sync` or `unknown` against the watermark.
 *   `unknown` enqueues because no push has recorded a hash yet, and a push that
 *   finds nothing to change is cheap. `paid`, `void` and `draft` read
 *   `not_applicable`, so they never enqueue.
 *
 * Nothing here compares `old` to `next`. A write that changes no Xero-carried
 * field still enqueues while an earlier edit's push has not landed. That is the
 * point: the earlier task may already have been superseded by this write.
 */
export function shouldPushInvoiceToXero(
  old: Partial<Invoice> | null | undefined,
  next: Partial<Invoice> | null | undefined,
  state: Pick<XeroSyncState, "pushed_hash"> | null,
): boolean {
  // Both sides are `Partial` because that is what an Eventarc write carries; a
  // delete (no `next`) or a document with no status has nothing to push.
  if (!old?.xero_id || !next?.status) return false;
  const status = invoiceXeroSyncStatus({ ...next, status: next.status, xero_id: next.xero_id ?? null }, state);
  return status === "out_of_sync" || status === "unknown";
}

/**
 * The live invoice-settling rows that **Xero holds** — a payment or credit
 * allocation Xero has an id for (`SETTLEMENT_CONTRACTS[type].xero_id_field` set on
 * the row). Xero refuses an edit to an invoice carrying one, so the edit push
 * stops at a manual seam when this is non-empty.
 *
 * ⚠️ **Not CFS's `status` or `amount_paid_cents`.** A payment an operator records
 * in CFS has no Xero id until Xero reports it, and Xero accepts an edit until then.
 * Keying on what CFS holds refused edits Xero would have taken. When CFS lags
 * Xero (a payment is in Xero and not yet reaped), this reads empty and Xero's own
 * ValidationException is the seam.
 *
 * Reversed rows are skipped ({@link liveSettlements}); reversers carry no Xero id
 * by contract, so they never count.
 */
export function invoiceSettlementsHeldByXero<
  T extends Pick<Settlement, "uid" | "type" | "reverses" | "xero_payment_id" | "xero_credit_note_id">,
>(settlements: readonly T[]): T[] {
  return liveSettlements(settlements).filter((s) => {
    const contract = SETTLEMENT_CONTRACTS[s.type];
    if (contract?.settles !== "invoice" || contract.xero_id_field === null) return false;
    return s[contract.xero_id_field] != null;
  });
}
