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
 * ## Both sides, one writer per kind (one-document-model rulings 44, 49, 128)
 *
 * Every transaction here runs on BOTH sides: a receivable run folds an invoice,
 * a payable run a supplier bill, through the same writer with the side supplied
 * as data. The payable transactions that used to sit beside these
 * (`settle-purchase-bill`, `void-purchase-bill`, `close-purchase-bill`,
 * `reopen-purchase-bill`, `void-purchase-bill-from-xero`) collapsed into their
 * receivable twins with the services (ruling 49). A twin's rules name different
 * collections, so each states its `side`, and a run is measured against its own
 * side's steps.
 *
 * ## One concurrency model (ruling 128)
 *
 * **Every settlement writer commits the journal row AND the projection it moves
 * in ONE batch, conditioned on the target document's version** (its
 * `lastUpdateTime`), with the journal read outside. A row therefore never exists
 * without its projection, and a lost race fails fast and re-reads, as a CAS does.
 * It replaced the receivable claim + CAS (row first, projection after), whose
 * window between the two commits needed a repair arm (`repairSettlementProjection`,
 * #547) and a replay filter (`withoutAlreadyCounted`), and which could not share
 * a document with the payable side's one-commit fold. The order and purchase
 * mirrors stay CONVERGENT, written after the commit and backed by the eventarc
 * reconcilers (`api-cloudrun/src/lib/orderInvoiceMirror.ts`).
 *
 * Traced from: api-cloudrun/src/lib/settlements.ts and its writers
 *
 * @module
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────

/**
 * The projection half, corpus-wide, and the strongest guard in the set because
 * it is **independent of the writer**: it rebuilds each billing document's
 * totals from the journal with `recomputeSettlementTotals` and compares.
 */
const SETTLEMENT_TOTALS_FOLD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-settlement-totals.ts",
  clause:
    "the projection clause only — each invoice's stored `amount_paid_cents`/`amount_credited_cents`/`amount_void_cents`/`amount_due_cents` equals the signed fold over its settlements, corpus-wide, exiting 1 on any divergence. Says NOTHING about the order mirror. **The void carve-out is gone**: it used to skip `amount_due_cents` on a void invoice, which meant the one class it could not see (api-cloudrun#436) was the one that had a live defect in it — 7 prod invoices voided by a non-zeroing path were indistinguishable from 34 correctly overridden ones. A void is now a settlement row, so the fold covers it like any other.",
  gates: true,
};

/**
 * Every settlement writer advances the target document's `version`.
 *
 * Not bookkeeping symmetry: the version bump is the check that catches a
 * NON-money edit authored before a settlement flipped the document to `paid`.
 */
const SETTLEMENT_BUMPS_VERSION: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/creditNotes/creditNotes.test.ts",
  clause:
    "the version clause, on the receivable credit arm only — an allocation moves `invoice.version`, and a replay moves it exactly once. The cash writers here are not covered by it.",
  gates: true,
};

/** A Xero payment arriving after a bill was written, asserted end to end. */
const BILL_PAYMENT_SYNCED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::webhook — a Xero payment on a pushed bill appends one bill_payment row and folds the bill; a redelivery appends nothing",
  clause:
    "a payment Xero reports on a tracked ACCPAY and CFS has not recorded is appended as a payment row keyed (bill, PaymentID, generation); the bill's totals are the journal folded; replaying the same payload writes nothing and does not bump the bill's version",
  gates: true,
};

/** The payable reap, asserted on a payment removed in Xero. */
const BILL_PAYMENT_REAPED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::webhook — a payment Xero stops reporting is reaped by a bill_payment_reversal",
  clause:
    "a linked payment row whose Xero id Xero no longer lists (the Payments key present) gets a payment_reversal with reason source_retracted; a card bill's born-paid row is never reaped, since a bank_transaction bill takes no Payment reap",
  gates: true,
};

/** A bill voided in Xero, asserted with a purchase whose lines it released. */
const BILL_VOIDED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::webhook — a bill voided in Xero appends one bill_void, retracts its payments and releases its lines",
  clause:
    "a tracked ACCPAY that Xero reports VOIDED or DELETED retracts every live payment, appends one void for total_cents and folds the bill to amount_due_cents 0, all in one commit, so the billing fold stops counting it; a redelivered void moves nothing",
  gates: true,
};

/** An operator void of a bill, asserted with its refusals. */
const BILL_VOIDED_FROM_CFS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::void from CFS — a bill nothing settles voids in Xero and releases its lines; one with a live payment is refused",
  clause:
    "voiding a pushed bill from CFS voids the posted Xero bill, then appends one void for total_cents, stamps voided_at, folds the bill to amount_due_cents 0, in one commit, so the billing fold stops counting it; a bill the void refusal refuses is refused before Xero is called",
  gates: true,
};

/** A Xero-side supplier-credit allocation reaching a tracked bill. */
const XERO_CREDIT_FOLDED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::webhook — a credit allocated in Xero appends one bill_credit row and refolds the credit",
  clause:
    "a supplier credit Xero reports allocated to a tracked bill, beyond what CFS's linked rows for that (bill, credit) hold, is first matched against CFS allocations Xero had not yet shown (linked, never duplicated) and the rest appended as a credit row; the bill and the credit are refolded in the same commit; a redelivery writes nothing",
  gates: true,
};

/** The $0 bill closure folds as a count, reversibly. */
const BILL_CLOSURE_FOLD: EnforcementRef = {
  kind: "test",
  ref: "core/tests/purchases.test.ts::a $0 bill closes and reopens as a count",
  clause: "a payable `closure` row folds +1 into closure_count, its reversal −1, and the status follows the derivation",
  gates: true,
};

// ── create-settlement ───────────────────────────────────────────────

const createSettlementRules: CollectionRule[] = [
  {
    id: "create-settlement:settlement-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    side: "receivable",
    invariant:
      "An invoice's settled totals are the signed fold over its settlements — appending a payment row raises `amount_paid_cents` and lowers `amount_due_cents` by the same amount, while `total` is untouched because it derives from items[] and a payment changes what is OWED, not what was BILLED. The row and the folded projection commit in ONE batch conditioned on the invoice's version as read (ruling 128): a row never exists without its projection, and a lost race re-reads. The row id is keyed on the request session (ruling 137), so a replay of the same session finds its row and returns it, moving nothing; a second press under a new session is a new attempt the action catalog refuses when nothing is due.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD, SETTLEMENT_BUMPS_VERSION],
    transaction: "create-settlement",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform: "the journal folded, in the row's commit",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform: "recomputeSettlementTotals('receivable', total, rows) — total − paid − credited − void",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "deriveInvoiceStatus over the folded totals — and it must account for credits, because a fully CREDITED invoice is settled rather than unpaid (#409)",
      },
      {
        source: [],
        target: ["version"],
        transform:
          "+1, only when the commit appended a row. The check that catches a NON-money edit authored before the settlement flipped the invoice to `paid`; a replay must NOT bump, or an idempotent call becomes observable as a 409 to a concurrent editor.",
      },
    ],
  },
  {
    id: "create-settlement:settlement-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    side: "payable",
    invariant:
      "An operator records a payment CFS sent against a supplier bill (ruling 134): one `payment` row naming the bill, `xero_id: null`, and the bill's totals folded, in ONE commit conditioned on the bill's version. Recorded in CFS only and never pushed: Xero's payment links it later by amount, through the INVOICE webhook's link arm (`sync-xero-settlement:xero-to-bill-settlements`), so the two never double-count (#412). A `bank_transaction` (card) bill takes no operator payment — it is born paid.",
    transaction: "create-settlement",
    fields: [
      { source: ["amount_cents"], target: ["totals", "amount_paid_cents"], transform: "the journal folded, in the row's commit" },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited − void" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals" },
      { source: [], target: ["version"], transform: "+1, only when the commit appended a row" },
    ],
  },
];

const createSettlementTransaction: TransactionDefinition = {
  id: "create-settlement",
  description:
    "Records a payment against a billing document — an invoice (cash received) or a supplier bill (cash sent): appends the session-keyed settlement row and folds the document's totals and status in one commit conditioned on its version, then converges the derived status onto each linked order or purchase. Pushes nothing to Xero on either side: Xero's own payment links the row when it arrives.",
  steps: [
    "create-settlement:settlement-to-invoice",
    "update-invoice:status-to-orders",
    "create-settlement:settlement-to-bill",
    "update-purchase-bill:status-to-purchases",
  ],
};

/**
 * The reversal's credit leg has ONE guard, and it is a test rather than a
 * refine — deliberately.
 *
 * `CREDIT_NOTE_STATUS_REFINE` (declared in `propagation/credit-notes.ts`)
 * only says a note is internally consistent: `applied` ⟺ zero balance, and the
 * balance never exceeds the face value. A note that never got its credit back is
 * internally consistent and completely wrong, so the refine cannot see this
 * class at all.
 */
const CREDIT_RELEASE_RESTORES_NOTE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/creditNotes/creditNotes.test.ts::retracting an allocation gives the credit back to the note",
  clause:
    "end to end on the deterministic path — allocate a note to exhaustion, retract the allocation, and assert the note is back to its full balance and out of `applied`, so it can be allocated again. Says nothing about concurrent retractions.",
  gates: true,
};

/** An operator reversing a supplier-credit allocation, asserted on both folds. */
const ALLOCATION_REVERSED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::reverse allocation — an unsynced allocation is reversed and both documents refold, a synced one is refused",
  clause:
    "reversing an allocation appends ONE credit_reversal naming it, keyed on the target so a second reversal is the same document; the bill's amount_credited_cents and the credit's remaining_credit_cents are both their journals folded, in the same commit conditioned on both versions; a replay writes nothing",
  gates: true,
};

// ── reverse-settlement ──────────────────────────────────────────────

const reverseSettlementRules: CollectionRule[] = [
  {
    id: "reverse-settlement:reverser-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    side: "receivable",
    invariant:
      "A retraction is an APPEND, never a delete or an edit — the reversing row carries the amount, names the row it reverses, and folds by its `*_reversal` type, so the journal stays an append-only history and the projection stays the fold over it. Exactly one retraction per row, checked with a POINT READ of the derived reverser id rather than a query over the siblings.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "reverse-settlement",
    fields: [
      // ⚠️ `reverses` is a field of the REVERSER ROW, not of the document this
      // rule targets; appending that row is the transaction's own root write, so
      // under the root-write ruling (2026-08-17) it is deliberately undeclared.
      { source: ["amount_cents"], target: ["totals", "amount_paid_cents"], transform: "the journal folded, the reverser included" },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited − void" },
      {
        source: [],
        target: ["totals", "closure_count"],
        transform:
          "−1 when the reverser is a `closure_reversal` (it folds the contract multiplier through `counts_into`, never `amount_cents`, which is 0); untouched for a money row",
      },
      {
        source: [],
        target: ["status"],
        transform: "deriveInvoiceStatus over the folded totals — typically paid → part_paid or issued; a reopened $0 invoice reads `issued`",
      },
      { source: [], target: ["version"], transform: "+1 — see create-settlement" },
    ],
  },
  {
    id: "reverse-settlement:release-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    side: "receivable",
    invariant:
      'Retracting a CREDIT allocation gives the credit back to the note it drew on, in the SAME commit as the reverser and the invoice\'s fold. Omitting it is not a cosmetic gap: the invoice is restored while the note still reports the credit as spent, so the credit is stranded — and a note the allocation had driven to zero stays `applied` with `remaining_credit_cents: 0`, which makes the over-allocation guard refuse every future allocation against it. Fires only for `type: "credit"` rows; a payment retraction has no credit to restore and writes nothing here.',
    enforced_by: [CREDIT_RELEASE_RESTORES_NOTE],
    transaction: "reverse-settlement",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform: "the note's journal folded by `creditRemainingFromJournal`, in the reverser's commit, conditioned on the note's version",
      },
      { source: [], target: ["status"], transform: "applied → issued once credit is back. A void note keeps `void`." },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
  {
    id: "reverse-settlement:reverser-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    side: "payable",
    invariant:
      "The payable twin of `reverse-settlement:reverser-to-invoice`, one writer: reversing a bill's row — an operator payment Xero has not linked, a supplier-credit allocation, or a `closure` (reopening a closed $0 bill, which then reads `issued` and unfreezes with no stored flag) — appends its reverser and folds the bill in one commit conditioned on its version. A Xero-linked payment is refused: it is removed in Xero, and the INVOICE webhook's reap appends the reverser.",
    enforced_by: [BILL_CLOSURE_FOLD, ALLOCATION_REVERSED],
    transaction: "reverse-settlement",
    fields: [
      { source: ["amount_cents"], target: ["totals", "amount_paid_cents"], transform: "the journal folded, the reverser included" },
      { source: ["amount_cents"], target: ["totals", "amount_credited_cents"], transform: "the journal folded, the reverser included" },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited − void" },
      { source: [], target: ["totals", "closure_count"], transform: "−1 on a `closure_reversal`" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals" },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
  {
    id: "reverse-settlement:release-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant:
      "Retracting a supplier-credit allocation gives the credit back to the supplier credit it drew on, in the same commit as the bill's fold, conditioned on both versions — the twin of `reverse-settlement:release-to-credit-note`.",
    enforced_by: [ALLOCATION_REVERSED],
    transaction: "reverse-settlement",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" },
      { source: [], target: ["status"], transform: "an `applied` credit with balance again is `issued`" },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
];

const reverseSettlementTransaction: TransactionDefinition = {
  id: "reverse-settlement",
  description:
    "Retracts one settlement of either side: appends its reverser and re-folds the billing document's totals and status — and, for a credit allocation, the credit's remaining balance — in ONE commit conditioned on every written document's version, then converges the status onto each linked order or purchase. Reopening a closed $0 document is this transaction on its `closure` row.",
  steps: [
    "reverse-settlement:reverser-to-invoice",
    "reverse-settlement:release-to-credit-note",
    "update-invoice:status-to-orders",
    "update-credit-note:note-to-orders",
    "reverse-settlement:reverser-to-bill",
    "reverse-settlement:release-to-purchase-credit",
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

// ── close-invoice ───────────────────────────────────────────────────

/**
 * The fold is exercised in core, not by the api's audit: `audit-settlement-totals`
 * compares the CENTS buckets and does not read `closure_count`. Naming the audit
 * here would claim a check of the count that nothing runs yet.
 */
const CLOSURE_FOLD: EnforcementRef = {
  kind: "test",
  ref: "core/tests/settlements.test.ts::close → reopen → close folds to 1, 0, 1 at every prefix",
  clause:
    "the projection clause only — a closure folds +1 into `closure_count`, its reversal −1, and the status reads `paid` exactly while the count is positive. Says nothing about the write path or the order mirror.",
  gates: true,
};

const closeInvoiceRules: CollectionRule[] = [
  {
    id: "close-invoice:closure-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    side: "receivable",
    invariant:
      "An operator closes a $0 invoice by appending a `closure` row (api-cloudrun#1169). It moves NO money — `amount_cents` is 0 by contract — so it reaches the invoice through `closure_count`, never through a cents bucket, and the invoice reads `paid` and freezes for as long as the count is positive. Its own transaction rather than `create-settlement`'s, because that rule maps `amount_cents → amount_paid_cents` and a closure maps nothing in cents. Legal only on a live invoice whose total is 0 with nothing money-settled and no live closure — the `close` action in `@cfs/core/utils/document-actions`. Session-keyed (ruling 137): a second close under a new session is refused by that action, not silently accepted.",
    enforced_by: [CLOSURE_FOLD],
    transaction: "close-invoice",
    fields: [
      { source: [], target: ["totals", "closure_count"], transform: "+1 — the contract multiplier folded through `counts_into`" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals — `issued` → `paid`" },
      { source: [], target: ["version"], transform: "+1 — see create-settlement" },
    ],
  },
  {
    id: "close-invoice:closure-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    side: "payable",
    invariant:
      "An operator closes a $0 bill by appending a `closure` row, the same rule as the invoice's: it moves no money, so the bill reads `paid` only through `closure_count`. Xero marks every $0 document PAID on issue, so Xero's verdict never decides this.",
    enforced_by: [BILL_CLOSURE_FOLD],
    transaction: "close-invoice",
    fields: [
      { source: [], target: ["totals", "closure_count"], transform: "+1 — the contract multiplier folded through `counts_into`" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals — `issued` → `paid`" },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
];

const closeInvoiceTransaction: TransactionDefinition = {
  id: "close-invoice",
  description:
    "Mark Paid on a $0 billing document (an invoice or a bill): appends a `closure` settlement row and folds `closure_count` and the status onto the document in one commit conditioned on its version, then converges the status onto each linked order or purchase. Reopening is `reverse-settlement` on that row. Pushes nothing to Xero — Xero already reads a $0 document PAID.",
  steps: [
    "close-invoice:closure-to-invoice",
    "update-invoice:status-to-orders",
    "close-invoice:closure-to-bill",
    "update-purchase-bill:status-to-purchases",
  ],
};

// ── sync-xero-settlement ────────────────────────────────────────────

const syncXeroSettlementRules: CollectionRule[] = [
  {
    id: "sync-xero-settlement:xero-to-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant:
      "Xero is the authority on what has been paid, so the webhook's payment and credit-allocation lists are reconciled INTO the journal: a payment Xero reports that an operator recorded unlinked is LINKED by amount (its `xero_id` set, no money moved); one CFS has not recorded is appended; and one CFS holds linked that Xero no longer reports is reaped by appending its reverser. Rows are matched on the Xero id, never on amount+date alone — two identical payments on one day are a real thing.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "sync-xero-settlement",
    fields: [
      {
        source: [],
        target: ["xero_id"],
        transform: "the match key — the PaymentID, or a credit's CreditNoteID; appended rows carry it so a redelivery matches instead of duplicating",
      },
      {
        source: [],
        target: ["reverses"],
        transform: "reap: a linked row Xero no longer reports gets a reverser with reason `source_retracted`, rather than being deleted — the journal is append-only",
      },
    ],
  },
  {
    id: "sync-xero-settlement:settlements-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    side: "receivable",
    invariant:
      "The invoice's projection is the reconciled journal folded, committed WITH the rows in one batch conditioned on the invoice's version, so a redelivered webhook — which appends nothing — writes nothing and moves no version.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "sync-xero-settlement",
    fields: [
      { source: ["amount_cents"], target: ["totals", "amount_paid_cents"], transform: "the journal folded" },
      { source: ["amount_cents"], target: ["totals", "amount_credited_cents"], transform: "the journal folded" },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited − void" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals" },
      { source: [], target: ["version"], transform: "+1, only when the journal moved" },
    ],
  },
  {
    id: "sync-xero-settlement:xero-to-bill-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant:
      "The payable twin, one writer: the payments and supplier-credit allocations Xero reports on a tracked ACCPAY are reconciled INTO the journal. A payment an operator recorded unlinked is LINKED by amount (ruling 134 — without this arm an operator payment plus Xero's would be the #412 double-apply); an unseen one is appended, keyed (bill, PaymentID, generation); a linked one Xero no longer lists is reaped by its `payment_reversal`. A credit allocation is reconciled as one aggregate per (bill, credit) against CFS's live `credit` rows: unlinked CFS allocations that fit are linked, a remaining excess appended, a shortfall reaps linked rows — an unlinked row is never reaped. The reap needs the `Payments` key PRESENT, and a `bank_transaction` (card) bill takes no Payment reap: its born-paid row's `xero_id` is the SPEND, which Xero never lists as a Payment.",
    enforced_by: [BILL_PAYMENT_SYNCED, BILL_PAYMENT_REAPED, XERO_CREDIT_FOLDED],
    transaction: "sync-xero-settlement",
    fields: [
      { source: [], target: ["xero_id"], transform: "the match key — Xero's PaymentID, or the supplier credit's CreditNoteID" },
      { source: [], target: ["reverses"], transform: "reap: a linked row Xero no longer reports gets a reverser (reason source_retracted), never a delete" },
      { source: ["uid"], target: ["billing", "uid"], transform: "the row settles the bill" },
    ],
  },
  {
    id: "sync-xero-settlement:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    side: "payable",
    invariant:
      "The bill's `totals` are its journal FOLDED, written in the same commit as the rows, so `paid + credited + void + due === total` holds after every sync. A sync that appends nothing writes nothing — the bill's `version` moves only when its journal does.",
    enforced_by: [BILL_PAYMENT_SYNCED],
    transaction: "sync-xero-settlement",
    fields: [
      { source: ["amount_cents"], target: ["totals", "amount_paid_cents"], transform: "Σ live payment − payment_reversal, by fold" },
      { source: ["amount_cents"], target: ["totals", "amount_due_cents"], transform: "total − paid − credited − void" },
    ],
  },
  {
    id: "sync-xero-settlement:settlements-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant:
      "Every supplier credit whose `credit` rows this commit appends, reverses or links is refolded in the SAME commit: `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal`, its status re-derives and its `version` is bumped — so a credit's balance never trails its journal, whichever writer moved it.",
    enforced_by: [XERO_CREDIT_FOLDED],
    transaction: "sync-xero-settlement",
    fields: [{ source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" }],
  },
];

const syncXeroSettlementTransaction: TransactionDefinition = {
  id: "sync-xero-settlement",
  description:
    "Reconciles a Xero INVOICE webhook's payments and credit allocations — on an ACCREC invoice or a tracked ACCPAY bill — into the settlements journal and folds the billing document's projection from it in the same commit, then converges the status onto each linked order or purchase. An ACCPAY resolves `purchase-bills` by `xero_id` and NOTHING else. Idempotent under redelivery by construction: matching is on Xero ids, and a sync that appends nothing writes nothing. One-directional: it never writes to Xero.",
  steps: [
    "sync-xero-settlement:xero-to-settlements",
    "sync-xero-settlement:settlements-to-invoice",
    "update-invoice:status-to-orders",
    "sync-xero-settlement:xero-to-bill-settlements",
    "sync-xero-settlement:settlements-to-bill",
    "sync-xero-settlement:settlements-to-purchase-credit",
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

// ── Voiding a billing document ──────────────────────────────────────
//
// **One transaction per ORIGIN, deliberately**, and each runs on both sides. A
// borrowed transaction id turns `logTransactionPropagation`'s only drift check
// off silently, so a void path that stopped reaping or stopped appending would be
// unreportable by construction. The MONEY half is identical across the origins
// and both sides and lives in one helper (`api-cloudrun/src/lib/invoiceVoid.ts`);
// what differs is the Xero direction, which each transaction's description states.
//
// ⚠️ The billing document is each void transaction's ROOT (the `source` of its
// reap and append steps, the target of none), so its re-fold is undeclared under
// the 2026-08-17 root-write ruling — on the payable side too, which is why the
// old `void-purchase-bill:settlements-to-bill` steps did not survive the collapse.

/**
 * The shared invariant text for the reap half. Written once because the origins
 * and the sides do the same thing — a divergence between them is the defect.
 */
const REAP_INVARIANT =
  "Voiding releases the billing document's money, so every live settlement is retracted by appending its reverser — the rows are never deleted, and each reverser's id is DERIVED from the row it retracts, so replaying the void across the origins converges on the same documents instead of stacking retractions.";

/**
 * The shared invariant text for the void-row half. It replaced
 * `void-invoice-from-xero:totals-override` — a voided invoice's due forced to 0 —
 * and the three carve-outs that kept that legal hid 7 prod invoices voided by a
 * path that never zeroed the balance (api-cloudrun#436).
 */
const VOID_ROW_INVARIANT =
  "A void is a SETTLEMENT, not a field override. Exactly one live `void` row per billing document — id derived from the document's uid and a generation — carrying `total_cents` and reason `voided`, so `amount_void_cents` folds to `total` and `amount_due_cents` falls out of the ordinary identity as 0. Xero reports `AmountDue: 0` on a voided document and is right; CFS DERIVES that 0 instead of assigning it, which is what lets the corpus audit see a void that was never released.";

/**
 * The field mappings for the void row, shared by every origin and both sides.
 * **They describe the SETTLEMENT ROW and nothing else** (api-cloudrun#568).
 */
const VOID_ROW_FIELDS = [
  { source: [], target: ["type"], transform: 'literal "void" — the settlement bucket that folds into `amount_void_cents`' },
  { source: [], target: ["reason"], transform: 'literal "voided"' },
  {
    source: ["totals", "total_cents"],
    target: ["amount_cents"],
    transform: "the void settlement's amount IS the document total — a void annuls everything billed",
  },
];

/** The reap's field mapping, shared by every origin and both sides. */
const REAP_FIELDS = [
  { source: ["uid"], target: ["reverses"], transform: "one reverser per unreversed settlement, sharing one uuid_session" },
];

// ── void-invoice (CFS-originated) ───────────────────────────────────

const voidInvoiceRules: CollectionRule[] = [
  {
    id: "void-invoice:reap-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant: REAP_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice",
    fields: REAP_FIELDS,
  },
  {
    id: "void-invoice:append-void-settlement",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD, SETTLEMENT_BUMPS_VERSION],
    transaction: "void-invoice",
    fields: VOID_ROW_FIELDS,
  },
  {
    id: "void-invoice:reap-bill-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant: REAP_INVARIANT,
    enforced_by: [BILL_VOIDED_FROM_CFS],
    transaction: "void-invoice",
    fields: REAP_FIELDS,
  },
  {
    id: "void-invoice:append-bill-void-settlement",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [BILL_VOIDED_FROM_CFS],
    transaction: "void-invoice",
    fields: VOID_ROW_FIELDS,
  },
];

const voidInvoiceTransaction: TransactionDefinition = {
  id: "void-invoice",
  description:
    "An operator voids a billing document — an invoice through `PUT /invoices/{uid}`, a pushed bill through `POST /purchase-bills/{uid}/void`: retracts every live settlement, appends its `void` row and folds its totals in one commit, then converges `void` onto each linked order or purchase. CFS ORIGINATES this one: an invoice's Xero void is pushed afterwards (deferred past a quota refusal rather than dropped); a bill Xero holds is voided in Xero FIRST, then committed, and a bill with no `xero_id` is voided in CFS alone. Refused by the `void` action before anything moves.",
  steps: [
    "void-invoice:reap-settlements",
    "void-invoice:append-void-settlement",
    "update-invoice:status-to-orders",
    "void-invoice:reap-bill-settlements",
    "void-invoice:append-bill-void-settlement",
    "update-purchase-bill:status-to-purchases",
  ],
};

// ── void-invoice-from-xero ──────────────────────────────────────────

const voidInvoiceFromXeroRules: CollectionRule[] = [
  {
    id: "void-invoice-from-xero:reap-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant: REAP_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-xero",
    fields: REAP_FIELDS,
  },
  {
    id: "void-invoice-from-xero:append-void-settlement",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-xero",
    fields: VOID_ROW_FIELDS,
  },
  {
    id: "void-invoice-from-xero:reap-bill-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant: REAP_INVARIANT,
    enforced_by: [BILL_VOIDED],
    transaction: "void-invoice-from-xero",
    fields: REAP_FIELDS,
  },
  {
    id: "void-invoice-from-xero:append-bill-void-settlement",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [BILL_VOIDED],
    transaction: "void-invoice-from-xero",
    fields: VOID_ROW_FIELDS,
  },
  {
    id: "void-invoice-from-xero:settlements-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant:
      "Every supplier credit whose allocation to the voided bill the reap reverses is refolded in the same commit (`creditRemainingFromJournal`), its status re-derived and its `version` bumped, so the credit is spendable again.",
    enforced_by: [BILL_VOIDED],
    transaction: "void-invoice-from-xero",
    fields: [{ source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" }],
  },
];

const voidInvoiceFromXeroTransaction: TransactionDefinition = {
  id: "void-invoice-from-xero",
  description:
    "Marks a billing document void because Xero voided it — an ACCREC invoice, or a tracked ACCPAY bill Xero reports VOIDED or DELETED: retracts every live settlement, appends its `void` row and folds the totals in one commit, then converges `void` onto each linked order or purchase. Ingest only — CFS never pushes back on this arm. Idempotency comes from the derived void-row id, never from a `status === \"void\"` early return, which is exactly why three Xero-bot-voided invoices once kept a balance Xero had closed. A card bill has no webhook: the daily sweep voids one whose SPEND Xero deleted, through this transaction.",
  steps: [
    "void-invoice-from-xero:reap-settlements",
    "void-invoice-from-xero:append-void-settlement",
    "update-invoice:status-to-orders",
    "void-invoice-from-xero:reap-bill-settlements",
    "void-invoice-from-xero:append-bill-void-settlement",
    "void-invoice-from-xero:settlements-to-purchase-credit",
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

// ── void-invoice-from-cancel ────────────────────────────────────────

const voidInvoiceFromCancelRules: CollectionRule[] = [
  {
    id: "void-invoice-from-cancel:reap-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant: REAP_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-cancel",
    fields: REAP_FIELDS,
  },
  {
    id: "void-invoice-from-cancel:append-void-settlement",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD, SETTLEMENT_BUMPS_VERSION],
    transaction: "void-invoice-from-cancel",
    fields: VOID_ROW_FIELDS,
  },
];

/**
 * The cancel origin (api-cloudrun#1154): canceling an order whose invoice bills
 * nothing else. Receivable only — a purchase close cancels nothing billed (a
 * close is a quantity edit, ruling 47) — so its steps state no side.
 *
 * ⚠️ **Its own id, never `void-invoice`'s.** There is no
 * `update-invoice:status-to-orders` step: the cancel UNLINKS both sides (G1,
 * api-cloudrun#453), so there is no order mirror left to converge.
 */
const voidInvoiceFromCancelTransaction: TransactionDefinition = {
  id: "void-invoice-from-cancel",
  description:
    "An order is canceled and it was the LAST order an unsettled invoice billed: the invoice is voided rather than emptied — every live settlement is retracted, the `void` row is appended for `total_cents`, the totals fold, and `version` advances. Its lines and totals stay as the record of what was voided; its `query_by_orders` / `number_orders` and the order's `invoices[]` / `query_by_invoices` drop each other, so no mirror converger can re-link a canceled order. Runs inside the order's `update-order` transaction. CFS ORIGINATES this void, so an issued invoice's Xero void is pushed afterwards through `/tasks/push-xero-invoice`, which derives void from the document.",
  steps: [
    "void-invoice-from-cancel:reap-settlements",
    "void-invoice-from-cancel:append-void-settlement",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/settlements.ts` contributes to the propagation catalog. */
export const settlements: PropagationModule = {
  rules: [
    ...createSettlementRules,
    ...reverseSettlementRules,
    ...closeInvoiceRules,
    ...syncXeroSettlementRules,
    ...voidInvoiceRules,
    ...voidInvoiceFromXeroRules,
    ...voidInvoiceFromCancelRules,
  ],
  transactions: [
    createSettlementTransaction,
    reverseSettlementTransaction,
    closeInvoiceTransaction,
    syncXeroSettlementTransaction,
    voidInvoiceTransaction,
    voidInvoiceFromXeroTransaction,
    voidInvoiceFromCancelTransaction,
  ],
};
