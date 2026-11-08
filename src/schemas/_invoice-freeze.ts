/**
 * The invoice FREEZE predicates — pure functions over an invoice's status and
 * settled totals.
 *
 * They live here, beside the schemas, rather than in `utils/invoices.ts` (which
 * re-exports them, so no caller's import moves) because `InvoiceSchema` reads
 * {@link invoiceIsFrozen}: its line-money refine applies only to an invoice
 * that may still be repriced (purchases-as-documents Phase 5). `utils/invoices.ts`
 * imports the schema barrel, so the schema could not import it back.
 */
import type { InvoiceStatusType } from "./invoice.ts";

/** The settled half of an invoice's totals, as every predicate below reads it. */
export interface InvoiceSettledTotals {
  total_cents?: number;
  amount_paid_cents: number;
  amount_credited_cents?: number;
  amount_void_cents?: number;
  amount_due_cents?: number;
  closure_count?: number;
}

/**
 * Does this invoice record money having moved — paid, credited or voided? Money
 * only: a closure is NOT money. See {@link invoiceHasSettlement}, which counts it.
 */
export function invoiceHasMoneySettlement(invoice: { totals: InvoiceSettledTotals }): boolean {
  return invoice.totals.amount_paid_cents !== 0 ||
    (invoice.totals.amount_credited_cents ?? 0) !== 0 ||
    (invoice.totals.amount_void_cents ?? 0) !== 0;
}

/**
 * Does this invoice record money having moved — paid, credited or voided — or
 * has an operator CLOSED it (a live `closure` row, api-cloudrun#1169)?
 *
 * ⭐ **Tests the settled VALUE, not a row count**, which is what makes the
 * unfreeze work with no stored state anywhere: reversing a payment to zero
 * leaves the journal rows in place and this predicate answers `false` again.
 * Nothing caches "was settled".
 *
 * ⚠️ **An empty settlement list is not benign** — recomputing totals against one
 * zeroes `amount_paid_cents` and `amount_credited_cents` and restores
 * `amount_due_cents` to the full total. This predicate is what stands between
 * that recompute and a settled invoice's balance.
 *
 * Moved here from `api-cloudrun/src/lib/settlementProjection.ts`, which
 * re-exports it: it is a pure predicate over three numbers, three repos want it,
 * and {@link invoiceIsFrozen} below needs it.
 */
export function invoiceHasSettlement(invoice: { totals: InvoiceSettledTotals }): boolean {
  // R1: a closed $0 invoice is frozen exactly as a paid one is, and reversing the
  // closure unfreezes it the same way reversing a payment does — `closure_count`
  // is a fold, so nothing caches "was closed" either.
  return invoiceHasMoneySettlement(invoice) || (invoice.totals.closure_count ?? 0) > 0;
}

/**
 * 🔴 **The authoritative freeze predicate: may an operator still change this
 * invoice's ORGANIZATION or its DATE?**
 *
 * `invoiceHasSettlement(invoice) || status === "paid" || status === "void"`.
 *
 * **The rule follows Xero's**: once a payment is applied, the organization, the
 * invoice date, line money and the revenue account freeze. Text does not, and
 * tracking freezes only on `void`. WHICH fields freeze on this predicate is
 * `INVOICE_FIELD_FREEZE`'s answer, read per class through
 * {@link invoiceFieldIsFrozen}; this function is only the WHEN. Reversing the
 * payment to zero unfreezes it, because {@link invoiceHasSettlement} reads a
 * VALUE and no field records that the invoice was once settled.
 *
 * ⚠️ **This is NOT {@link SETTLED_STATUSES}, and the difference is the whole
 * reason it exists.** That constant is the STATUS column — `["paid", "void"]` —
 * and it is strictly weaker: it misses a `part_paid` invoice carrying a partial
 * payment, which has real money against it and must not be re-addressed. A gate
 * written on the status alone is wrong in both directions at once — stricter
 * than the server on a `paid` invoice, whose text fields are still editable, and
 * weaker on a `part_paid` one.
 *
 * ⚠️ **It answers the FIELD-CLASS question, not the money question.** The money
 * gate (`lineMoneyAgrees`) asks *did the amount move?*; this asks *is this field
 * the operator's to change at all?* Both exist, and neither subsumes the other.
 */
export function invoiceIsFrozen(
  invoice: { status: InvoiceStatusType; totals: InvoiceSettledTotals },
): boolean {
  return invoiceHasSettlement(invoice) || isPaidUp(invoice.status) || invoice.status === "void";
}

/** Nothing is owed: the status settlement moves a live document to. */
export function isPaidUp(status: InvoiceStatusType): boolean {
  return status === "paid" || status === "credited";
}

/**
 * **The one billing-document status derivation**, for invoices and supplier bills
 * alike (one-document-model Phase 4). Pure, and it lives beside the schemas
 * because both refine their stored `status` against it.
 *
 * - `draft` and `void` pass through: leaving either is an explicit move, never a
 *   derivation.
 * - 🔴 **A $0 document with nothing money-settled is `paid` only if an operator
 *   CLOSED it** (`closure_count > 0`), and `issued` otherwise — never from
 *   `amount_due_cents <= 0`. That comparison is what made #2396 read `paid`: a
 *   shrink invoice whose lines were all removed reached $0 due, the Xero webhook
 *   re-derived `paid`, and the freeze locked the operator out of their own edit.
 *   Xero marks every $0 document PAID on issue (probed 2026-10-01), so copying
 *   Xero's verdict here would reproduce it on every one.
 * - Nothing owed: `paid` when any cash moved (`paid` means nothing owed, not
 *   "cash received" — #1751 and #1322 were PAID in Xero with `AmountPaid: 0`),
 *   `credited` when credit alone settled it.
 * - Otherwise any cash or credit ⇒ `part_paid`; else `issued`.
 *
 * `amount_due_cents` is RE-COMPUTED from `total − paid − credited − voided`
 * rather than read, so a caller holding a stale due beside fresh buckets cannot
 * derive from the stale one.
 */
export function deriveInvoiceStatus(
  invoice: { status: InvoiceStatusType; totals: InvoiceSettledTotals & { total_cents: number } },
): InvoiceStatusType {
  const { status, totals } = invoice;
  if (status === "draft" || status === "void") return status;
  const paid = totals.amount_paid_cents;
  const credited = totals.amount_credited_cents ?? 0;
  const voided = totals.amount_void_cents ?? 0;
  if (totals.total_cents === 0 && !invoiceHasMoneySettlement(invoice)) {
    return (totals.closure_count ?? 0) > 0 ? "paid" : "issued";
  }
  // Bare integer comparisons: every operand is an exact count of cents.
  const due = totals.total_cents - paid - credited - voided;
  if (due <= 0) return paid <= 0 && credited > 0 ? "credited" : "paid";
  // ⚠️ Deliberately `> 0`, NOT {@link invoiceHasMoneySettlement}'s `!== 0`: that
  // predicate asks whether money MOVED (a net-negative over-reversal did move
  // money, so it still freezes), while this asks whether anything is PAID
  // toward the balance. A negative bucket leaves MORE due than the total, which
  // is not part paid. A partial void is a retraction, not a payment, so it does
  // not count here either.
  if (paid > 0 || credited > 0) return "part_paid";
  return "issued";
}
