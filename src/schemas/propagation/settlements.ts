/**
 * Settlement propagation rules — the cash side of the settlements journal.
 *
 * ## Why this file exists (api-cloudrun#453)
 *
 * The settlement→invoice edge was declared only in its **credit** variant
 * (`allocate-credit-note:settlements-to-invoices`). The cash-payment edge — a
 * client payment, a retraction, a Xero payment webhook, a Xero void — was
 * undeclared, and its four writers all borrowed the `update-invoice` transaction
 * id when they logged.
 *
 * That is not a documentation nit. `logTransactionPropagation`'s only drift
 * check is `rules_fired.length === 0 && rules_expected > 0`, and `update-invoice`
 * declares exactly ONE step, so six writers collapsed onto a one-step
 * transaction where the check **can never fire**. Per-writer accounting is what
 * makes it able to fire at all: a transaction that declares three steps and
 * fires two is now visible, and each writer is measured against its own
 * declaration instead of against a borrowed one.
 *
 * ## The one fact these rules encode that the code cannot state
 *
 * **`createSettlement` is deliberately NOT atomic.** It writes the journal row,
 * then moves the invoice by CAS, then fans out to the orders in a *separate*
 * transaction — three commits. That is a considered trade, not an oversight:
 * two transactions that read AND write one invoice block each other for the full
 * 25s deadline (60–87s per contender in `firestoreWrite.ts`'s own table), and
 * the invoice is the hot document on the money path. The cost is a window in
 * which a crash leaves the order mirror stale, which is why the mirror is
 * *convergent* (`src/lib/orderInvoiceMirror.ts`) and backed by an eventarc
 * reconciler rather than merely co-written.
 *
 * The other three writers here ARE single-transaction.
 *
 * Traced from: api-cloudrun/src/services/invoices.ts, lib/settlements.ts
 *
 * @module
 */
import type { CollectionRule, EnforcementRef, TransactionDefinition } from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────

/**
 * The projection half, corpus-wide, and the strongest guard in the set because
 * it is **independent of the writer**: it rebuilds each invoice's totals from
 * the journal with `recomputeSettlementTotals` and compares, rather than
 * re-running the delta the writer applied.
 */
const SETTLEMENT_TOTALS_FOLD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-settlement-totals.ts",
  clause:
    "the projection clause only — each invoice's stored `amount_paid_cents`/`amount_credited_cents`/`amount_due_cents` equals the signed fold over its settlements, corpus-wide, exiting 1 on any divergence. Says NOTHING about the order mirror, and it deliberately exempts `amount_due_cents` on a void invoice (see `void-invoice-from-xero:totals-override`).",
  gates: true,
};

/**
 * Every settlement writer advances `invoice.version`.
 *
 * Not bookkeeping symmetry: `updateInvoice` has no server-side guard refusing
 * item edits on a settled invoice, so the version bump is the ONLY thing that
 * can reject an edit authored before a settlement flipped the invoice to `paid`.
 */
const SETTLEMENT_BUMPS_VERSION: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/creditNotes/creditNotes.test.ts",
  clause:
    "the version clause, on the credit arm only — an allocation moves `invoice.version`, and a replay moves it exactly once. The three cash writers here are not covered by it.",
  gates: true,
};

// ── create-settlement ───────────────────────────────────────────────

export const createSettlementRules: CollectionRule[] = [
  {
    id: "create-settlement:settlement-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    invariant:
      "An invoice's settled totals are the signed fold over its settlements — appending a payment row raises `amount_paid_cents` and lowers `amount_due_cents` by the same amount, while `total` is untouched because it derives from items[] and a payment changes what is OWED, not what was BILLED. The row is written BEFORE the projection: the journal is the truth and the projection is repairable, so a crash leaves stale totals over a real row rather than moved money with nothing behind it.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD, SETTLEMENT_BUMPS_VERSION],
    transaction: "create-settlement",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform:
          "applied as a DELTA against the invoice read by CAS, never an absolute — two writers that each recomputed an absolute from their own read would clobber each other",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform: "recomputeSettlementTotals(total, rows) — total − paid − credited",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "derivePaymentStatus over the folded totals — and it must account for credits, because a fully CREDITED invoice is settled rather than unpaid (#409)",
      },
      {
        source: [],
        target: ["version"],
        transform:
          "+1. The only server-side check that can reject an item edit authored before the settlement flipped the invoice to `paid` — `updateInvoice` has no settled-invoice guard of its own. Gated on the write actually moving money: a replay zeroed by `withoutAlreadyCounted` must NOT bump, or an idempotent call becomes observable as a 409 to a concurrent editor.",
      },
    ],
  },
];

export const createSettlementTransaction: TransactionDefinition = {
  id: "create-settlement",
  description:
    "Records a payment against an invoice: appends the settlement row, moves the invoice's projected totals and status by CAS, then co-writes the derived status to each linked order. THREE commits, not one — the invoice is the hot document on the money path and a transactional read+write would block every concurrent writer for the full 25s deadline. The order mirror is therefore convergent and backed by the eventarc reconciler, not merely co-written.",
  steps: [
    "create-settlement:settlement-to-invoice",
    "update-invoice:status-to-orders",
  ],
};

// ── reverse-settlement ──────────────────────────────────────────────

export const reverseSettlementRules: CollectionRule[] = [
  {
    id: "reverse-settlement:reverser-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    invariant:
      "A retraction is an APPEND, never a delete or an edit — the reversing row carries the negated amount and names the row it reverses, so the journal stays an append-only history and the projection stays the fold over it. Exactly one retraction per row, checked with a POINT READ of the derived reverser id rather than a query over the siblings, because a range read here would block every concurrent appender to this invoice for 25s.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "reverse-settlement",
    fields: [
      { source: ["uid"], target: ["reverses"], transform: "the reversed row's uid, on the reverser" },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform: "negated delta — applySettlementDelta over the reverser alone",
      },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited" },
      { source: [], target: ["status"], transform: "derivePaymentStatus over the folded totals — typically paid → part_paid or issued" },
      { source: [], target: ["version"], transform: "+1 — see create-settlement" },
    ],
  },
];

export const reverseSettlementTransaction: TransactionDefinition = {
  id: "reverse-settlement",
  description:
    "Retracts one settlement: appends its reverser, re-folds the invoice's totals and status, and co-writes that status to each linked order. Single transaction, unlike create-settlement — the retraction path is not hot.",
  steps: [
    "reverse-settlement:reverser-to-invoice",
    "update-invoice:status-to-orders",
  ],
};

// ── sync-xero-settlement ────────────────────────────────────────────

export const syncXeroSettlementRules: CollectionRule[] = [
  {
    id: "sync-xero-settlement:xero-to-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Xero is the authority on what has been paid, so the webhook's payment and credit-allocation lists are reconciled INTO the journal: a payment Xero reports and CFS has not recorded is appended, and one CFS holds that Xero no longer reports is reaped by appending its reverser. Rows are matched on the Xero payment/credit id, never on amount+date — two identical payments on one day are a real thing.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "sync-xero-settlement",
    fields: [
      { source: [], target: ["xero_payment_id"], transform: "the match key — appended rows carry it so a redelivery matches instead of duplicating" },
      { source: [], target: ["xero_credit_note_id"], transform: "same, for a credit note allocated in Xero and unknown to CFS" },
      {
        source: [],
        target: ["reverses"],
        transform:
          "reap: a CFS row Xero no longer reports gets a reverser with reason `reaped_not_reported_by_xero`, rather than being deleted — the journal is append-only",
      },
    ],
  },
  {
    id: "sync-xero-settlement:settlements-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    invariant:
      "The invoice's projection follows the reconciled journal, and a redelivered webhook moves NOTHING — the delta is taken over `withoutAlreadyCounted(pending, existing)`, so replaying the same Xero payload is a true no-op rather than a doubled balance",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "sync-xero-settlement",
    fields: [
      { source: ["amount_cents"], target: ["totals", "amount_paid_cents"], transform: "delta over the genuinely-new rows only" },
      { source: ["amount_cents"], target: ["totals", "amount_credited_cents"], transform: "same, for credit allocations Xero reports" },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited" },
      { source: [], target: ["status"], transform: "derivePaymentStatus over the folded totals" },
      { source: [], target: ["version"], transform: "+1 — see create-settlement" },
    ],
  },
];

export const syncXeroSettlementTransaction: TransactionDefinition = {
  id: "sync-xero-settlement",
  description:
    "Reconciles a Xero invoice webhook's payments and credit allocations into the settlements journal, re-folds the invoice's projection from it, and co-writes the resulting status to each linked order. Idempotent under redelivery by construction: matching is on Xero ids and the delta excludes rows already counted.",
  steps: [
    "sync-xero-settlement:xero-to-settlements",
    "sync-xero-settlement:settlements-to-invoice",
    "update-invoice:status-to-orders",
  ],
};

// ── void-invoice-from-xero ──────────────────────────────────────────

export const voidInvoiceFromXeroRules: CollectionRule[] = [
  {
    id: "void-invoice-from-xero:reap-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Voiding in Xero releases the invoice's money, so every live settlement is retracted by appending its reverser — the rows are never deleted, and the reversers carry reason `invoice_voided_in_xero` so the retraction is distinguishable from an operator's",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-xero",
    fields: [
      { source: ["uid"], target: ["reverses"], transform: "one reverser per unreversed settlement, sharing one uid_session" },
    ],
  },
  {
    id: "void-invoice-from-xero:totals-override",
    source: "invoices",
    target: "invoices",
    mode: "derive",
    invariant:
      "A voided invoice is the ONE place the projection is overridden rather than folded: `amount_paid_cents` and `amount_credited_cents` fold to zero and so agree with the journal, but `amount_due_cents` is FORCED to zero where the fold would give `total`. Xero reports `AmountDue: 0` and is right — the invoice is annulled, not outstanding. This is exactly the case the invoice schema's identity refine exempts, and why a totals repair must skip void invoices: rebuilding one from the log alone would re-open a balance Xero has closed.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-xero",
    fields: [
      { source: [], target: ["status"], transform: "literal \"void\"" },
      { source: [], target: ["totals", "amount_paid_cents"], transform: "0 — agrees with the fold once every settlement is reversed" },
      { source: [], target: ["totals", "amount_credited_cents"], transform: "0 — same" },
      { source: [], target: ["totals", "amount_due_cents"], transform: "0 — OVERRIDDEN, does not agree with the fold" },
      { source: [], target: ["version"], transform: "+1 — see create-settlement" },
    ],
  },
];

export const voidInvoiceFromXeroTransaction: TransactionDefinition = {
  id: "void-invoice-from-xero",
  description:
    "Marks an invoice void because Xero voided it: retracts every live settlement into the journal, overrides the totals to zero, and co-writes `void` to each linked order's invoices[] entry. Ingest only — CFS never originates this; the reverse direction is `updateInvoice` with status `void`, which pushes to Xero.",
  steps: [
    "void-invoice-from-xero:reap-settlements",
    "void-invoice-from-xero:totals-override",
    "update-invoice:status-to-orders",
  ],
};
