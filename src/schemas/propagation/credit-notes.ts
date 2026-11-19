/**
 * Credit-note propagation rules — origination, allocation, refund, and void.
 *
 * **The direction these rules describe is CFS → Xero.** The reverse direction
 * (a note created by hand in Xero, arriving on the CREDITNOTE webhook) is not a
 * propagation rule at all: it is an ingest, and it is already covered by the
 * settlement sync. What is new here is CFS originating the value instrument.
 *
 * ## Why a credit note fans out at all
 *
 * A payment settles one invoice. A credit note is a *value instrument* that can
 * be allocated across several — CN-1015 splits 11.99 → #1751 and 247.75 → #1767
 * — so issuing one touches N invoices, each of which projects new totals, each
 * of which may flip status, each of which co-writes that status back to its
 * orders. That is a genuine fan-out with a rules_expected count, which is why
 * these use `logTransactionPropagation` rather than the single-rule
 * `logPropagation`.
 *
 * ## The three facts these rules encode that the code cannot state
 *
 * 1. **An allocation IS a settlement document.** There is no `allocations[]`
 *    mirror on the note, so the edge from note to invoice runs *through* the
 *    journal. `where("credit.uid","==",uid)` is an ordinary query.
 * 2. **`remaining_credit_cents` is a projection, not a ledger.** It is co-written from
 *    the same settlements that move the invoices — and, for a cash refund, from a
 *    `refund` row that moves no invoice (api-cloudrun#1207) — so it is the signed
 *    fold over every row naming the note.
 * 3. **The allocation date is neither document's date.** See
 *    {@link allocateCreditNoteRules} — it is `max(note.date, invoice.date)`, and
 *    that is an accounting requirement rather than a convenience.
 *
 * Traced from: api-cloudrun/src/services/creditNotes.ts, lib/settlements.ts
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
 * The projection half, corpus-wide: every invoice's stored
 * `amount_paid`/`amount_credited`/`amount_due` equals the signed fold over its
 * settlements.
 *
 * This is the strongest guard in the set because it is **independent of the
 * writer** — it rebuilds from the journal with `recomputeSettlementTotals` and
 * compares, rather than re-running the delta the writer applied.
 */
const SETTLEMENT_TOTALS_FOLD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-settlement-totals.ts",
  clause:
    "the projection clause only — stored totals equal the signed fold over the invoice's settlements, corpus-wide. Says NOTHING about whether a credit note's `remaining_credit_cents` agrees with the same rows, and nothing about the allocation date.",
  gates: true,
};

/**
 * CFS's stored posting account against Xero's, per credit-note line.
 *
 * Deliberately a three-way comparison — stored value, `deriveCreditPostingAccount`,
 * and Xero — because a check that derived the expected value on read would be a
 * restatement of its own oracle. It runs a planted violation at startup so the
 * comparator is *seen* to fail.
 */
const CREDIT_POSTING_AGAINST_XERO: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-credit-note-posting.ts",
  clause:
    "the `ledger_account` clause — stored posting account vs `deriveCreditPostingAccount` vs Xero's own account code, naming the 4 historic miscodings as expected divergences. Covers neither `source_ledger_account` nor the allocation edge.",
  gates: true,
};

/**
 * The number series: monotonic, never reused, and ahead of the corpus.
 *
 * ⚠️ Necessarily a script rather than a test. Every test worker mints from a
 * NAMESPACED counter which lazy-inits unconditionally, so an absent or stale
 * singleton is indistinguishable from a healthy one from inside a green suite.
 */
const CREDIT_NOTE_NUMBER_AHEAD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-counters.ts",
  clause:
    "the `credit-notes` counter is ahead of every number in the collection. Does NOT check monotonicity across a void, nor agreement with Xero's own sequence — Xero frees a number on void and CFS does not, so the two legitimately diverge.",
  gates: true,
};

/**
 * The status↔`remaining_credit_cents` biconditional, enforced at write time by the
 * schema itself rather than by an audit.
 *
 * `construction` because a document asserting `applied` while holding credit
 * cannot be written at all — `validateBeforeWrite` rejects it.
 */
const CREDIT_NOTE_STATUS_REFINE: EnforcementRef = {
  kind: "zod",
  ref:
    "core/src/schemas/credit-note.ts::a credit note with this balance is",
  clause:
    "the stored status equals `deriveCreditStatus` — `applied` ⟺ `remaining_credit_cents === 0` on a note with value, a $0 note `issued` (void and draft stated) — the anchored `superRefine` issue — plus its neighbour `remaining_credit_cents cannot exceed the credit note's total_cents`. Says nothing about whether the stored `remaining_credit_cents` matches the settlements that produced it.",
  gates: true,
};

/**
 * The note's projection, corpus-wide: every note's stored
 * `remaining_credit_cents` equals `creditRemainingFromJournal` over the rows
 * naming it, plus parity with Xero's `RemainingCredit` where the note is linked.
 * Possible only once refunds are rows (api-cloudrun#1207) — before that a cash
 * refund consumed a note invisibly, and the fold disagreed on CN-1013 and CN-1016
 * by construction (api-cloudrun#469).
 */
const CREDIT_NOTE_REMAINING_FOLD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-credit-note-remaining.ts",
  clause:
    "the projection clause — stored `remaining_credit_cents` equals the signed fold over every `credit`/`refund` row and reversal naming the note, and Xero's `RemainingCredit` where the note is linked. Says nothing about the invoices the credit went to; `audit-settlement-totals.ts` owns those.",
  gates: true,
};

// ── create-credit-note ──────────────────────────────────────────────

/**
 * Origination writes ONE document plus its thread. It deliberately allocates
 * nothing: a note is a value instrument that exists before it is applied, and
 * conflating issue with allocation is what makes a partially-applied note
 * unrepresentable.
 */

// ── Discovery mirrors (one-document-model ruling 32, 6e-0a) ─────────
//
// Three mirrors share ONE pure merge in api-cloudrun (`upsertDocRef`), so they
// share their enforcement refs. Each is CONVERGENT, not co-written: the writer
// that moves a document's status converges its initiator by compare-and-set
// after its own commit, and an eventarc backstop on the source collection
// repairs whatever a writer missed or a script wrote raw.

const DOC_REF_MERGE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/docRefMirror.test.ts::upsertDocRef: returns the INPUT identities when the mirror agrees",
  clause:
    "the merge, writer-independently: a missing entry is added to both the object array and the uid list, a disagreeing entry is rewritten, an agreeing mirror comes back by identity (the no-write contract), and nothing is ever removed. Hermetic. Says nothing about whether any given writer calls it.",
  gates: true,
};

const DOC_REF_AUDIT: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-document-ref-mirrors.ts",
  clause:
    "every initiator's mirror agrees with the documents that name it, in both directions — a named document missing from the mirror, a mirror entry whose number or status disagrees, an object array and uid list that disagree, and an entry naming a document that does not name the initiator. Exits 2 on any.",
  gates: true,
};

const createCreditNoteRules: CollectionRule[] = [
  {
    id: "create-credit-note:number-from-counter",
    source: "counters",
    target: "credit-notes",
    mode: "derive",
    invariant:
      "A credit note's number is allocated from `counters/credit-notes` inside the creating transaction, is monotonic, and is NEVER reused — not even after a void, and not even though Xero frees a voided note's number",
    enforced_by: [CREDIT_NOTE_NUMBER_AHEAD],
    transaction: "create-credit-note",
    fields: [
      {
        source: ["count"],
        target: ["number"],
        transform:
          "allocateNumbers(tx, 'credit-notes', 1) — called AFTER every other tx.get(), built with PENDING_NUMBER and backfilled, so the counter's pessimistic lock spans one commit rather than the whole transaction",
      },
    ],
  },
  {
    id: "create-credit-note:posting-account",
    source: "credit-notes",
    target: "credit-notes",
    mode: "derive",
    invariant:
      "Each line's `ledger_account` is STORED, not derived on read — bad_debt posts to 6900 because the sale stands and the money is written off, while every other reason reverses the line's own revenue account",
    enforced_by: [CREDIT_POSTING_AGAINST_XERO],
    transaction: "create-credit-note",
    fields: [
      {
        source: ["reason"],
        target: ["items", "ledger_account"],
        transform:
          "deriveCreditPostingAccount(reason, item.source_ledger_account) — 6900 for bad_debt, the line's own source_ledger_account otherwise, null for correction/unspecified (the caller must supply it, because a correction is bidirectional)",
      },
    ],
  },
];

const createCreditNoteTransaction: TransactionDefinition = {
  id: "create-credit-note",
  description:
    "Mints a credit note from the shared counter, derives each line's posting account and its `sources` (`deriveCreditNoteSources`: the orders it credits, then its invoice), and cowrites its default thread. After the commit it converges `credit_notes[]` on every order it names. Allocates nothing — issuing and applying are separate acts.",
  steps: [
    "create-credit-note:number-from-counter",
    "create-credit-note:posting-account",
    "cowrite-thread:credit-notes-to-thread",
    "cowrite-thread:thread-to-credit-notes",
    "update-credit-note:note-to-orders",
  ],
};

// ── update-credit-note (note → orders, 6e-0a) ───────────────────────

const updateCreditNoteOrderRules: CollectionRule[] = [
  {
    id: "update-credit-note:note-to-orders",
    source: "credit-notes",
    target: "orders",
    mode: "co-write",
    side: "receivable",
    invariant:
      "Every order a credit note names (`orders:<uid>` in its `query_by_sources`, written by `deriveCreditNoteSources`) carries the note in `credit_notes[]` and `query_by_credit_notes`, and the entry's number and status CONVERGE on the note. CONVERGENT, not co-written: the order write is a compare-and-set AFTER the note's own commit, because two settlements on one order deadlocked inside one transaction (api-cloudrun#1293) and the order is the hot document. Every writer that moves the note's status converges unconditionally (gated on disagreement, never on the status having changed), and the `credit-notes` eventarc backstop repairs a write the writer missed or a script made raw. A void note STAYS in the mirror at `void`, as a void invoice stays in `invoices[]`.",
    enforced_by: [DOC_REF_MERGE, DOC_REF_AUDIT],
    trigger:
      "any credit-note write — targets the orders in its `query_by_sources`. Deliberately not gated on the status having changed (api-cloudrun#453's lesson).",
    fields: [
      { source: ["uid"], target: ["query_by_credit_notes"], transform: "added when absent; never removed" },
      {
        source: ["status"],
        target: ["credit_notes", "status"],
        transform: "upsertDocRef — the entry for this note is added when absent and rewritten when it disagrees; the input identities come back when it agrees, so no order is written",
      },
      { source: ["number"], target: ["credit_notes", "number"], transform: "converged by the same merge" },
      {
        source: [],
        target: ["version"],
        transform: "HELD: there is no operator edit to defend, and `updateOrder` never assigns `credit_notes`, so a stale client cannot revert it",
      },
    ],
  },
];

// ── allocate-credit-note ────────────────────────────────────────────

const allocateCreditNoteRules: CollectionRule[] = [
  {
    id: "allocate-credit-note:note-to-settlements",
    source: "credit-notes",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant:
      "Applying a credit note to an invoice appends one `type: credit` settlement per invoice, carrying the note's reason denormalized — one note across three invoices has ONE reason, and authoring it three times invites three answers",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "allocate-credit-note",
    fields: [
      { source: ["uid"], target: ["credit", "uid"] },
      { source: ["number"], target: ["credit", "label"], transform: "the note's display number" },
      {
        source: ["reason"],
        target: ["reason"],
        transform: "denormalized from the note",
      },
      { source: ["xero_id"], target: ["xero_id"], transform: "the note's CreditNoteID once Xero reports the allocation; null until then" },
      {
        source: [],
        target: ["date"],
        transform:
          "max(credit_note.date, invoice.date) — NOT either document's own date. Xero posts journals on both a cash and an accrual basis, so the allocation carries the only date on which both facts are true (verified 6/6 on the prod corpus). Allocating before the invoice exists would post a credit against a receivable that had not been raised.",
      },
      {
        source: [],
        target: ["uuid_session"],
        transform:
          "one session id shared by every settlement in the allocation, so a multi-invoice apply is recoverable as a unit",
      },
    ],
  },
  {
    id: "allocate-credit-note:settlements-to-invoices",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    side: "receivable",
    invariant:
      "Each credited invoice's totals are the signed fold over its settlements — `amount_credited` rises and `amount_due` falls by the allocated amount, while `total` is untouched because it derives from items[] and a credit changes what is OWED, not what was BILLED",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "allocate-credit-note",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform:
          "the invoice's journal folded, in the allocation's commit, conditioned on the invoice's version",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform:
          "recomputeSettlementTotals('receivable', total, rows) — total − paid − credited − void",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "deriveInvoiceStatus must account for credits: a FULLY credited invoice is settled, not unpaid. Omitting credits here is the #409 bug class.",
      },
    ],
  },
  {
    id: "allocate-credit-note:remaining-credit",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    side: "receivable",
    invariant:
      "The note's `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal` — every live allocation and cash refund drawing on it — written in the SAME commit as the allocation rows and each invoice's fold, conditioned on every document's version (ruling 128). The reversal leg is `reverse-settlement:release-to-credit-note`, and it is the half that is easy to omit: without it a retracted allocation restores the invoice and strands the note's credit forever. `applied` means remaining_credit_cents === 0 HOWEVER it got there, by allocation or by cash refund.",
    enforced_by: [CREDIT_NOTE_STATUS_REFINE],
    transaction: "allocate-credit-note",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform:
          "total − Σ signed draws, by fold. A NEGATIVE result is written, not clamped — it is the true projection of an over-allocation and the operator's signal.",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "derived from the resulting balance, both ways: issued → applied when it reaches 0, and applied → issued when a retraction puts credit back. A void note keeps `void` — voiding strands a balance rather than consuming it.",
      },
    ],
  },
];

const allocateCreditNoteTransaction: TransactionDefinition = {
  id: "allocate-credit-note",
  description:
    "Applies a credit to one or more billing documents of its side — a customer credit note to invoices, a supplier credit to bills of its supplier: appends a session-keyed `credit` settlement per document, folds each document's totals and status and the credit's remaining balance in ONE commit conditioned on every version (ruling 128), then converges the orders or purchases. Each side keeps its own Xero allocation push, after the commit (ruling 132). One route for both, `POST /settlements` with `type: \"credit\"`.",
  steps: [
    "allocate-credit-note:note-to-settlements",
    "allocate-credit-note:settlements-to-invoices",
    "allocate-credit-note:remaining-credit",
    "update-invoice:status-to-orders",
    "update-credit-note:note-to-orders",
    "allocate-credit-note:purchase-credit-to-settlements",
    "allocate-credit-note:settlements-to-bill",
    "allocate-credit-note:settlements-to-purchase-credit",
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

// ── Refunds (api-cloudrun#1207) ─────────────────────────────────────
//
// A cash refund pays a note's credit back to the customer without touching any
// invoice. Xero records it as a Payment of type `ARCREDITPAYMENT` on the note,
// and CFS records it as a `refund` settlement — the one settlement type that
// names a credit and no billing document (`SETTLEMENT_CONTRACTS.refund.settles`).
// Two ORIGINS, so two transactions: an operator recording one, and the Xero
// CREDITNOTE webhook reconciling the note's `Payments[]`. Neither pushes
// anything to Xero — the money moved in Xero or at the bank, and Xero is the
// authority on payments, so the webhook's match pass links an operator-recorded
// row exactly as it links an operator-recorded invoice payment.

const recordCreditNoteRefundRules: CollectionRule[] = [
  {
    id: "record-credit-note-refund:refund-to-settlements",
    source: "credit-notes",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant:
      "An operator recording a cash refund appends ONE `type: refund` settlement naming the note and no invoice, with `xero_id: null` — the CREDITNOTE webhook links it to Xero's `ARCREDITPAYMENT` later by amount, and an unlinked refund is never reaped. Legal only while the note accepts allocation and the amount is within its remaining credit — the `record_refund` action in `@cfs/core/utils/document-actions`.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD],
    transaction: "record-credit-note-refund",
    fields: [
      { source: ["uid"], target: ["credit", "uid"] },
      { source: ["number"], target: ["credit", "label"], transform: "the note's display number" },
      { source: ["organization", "uid"], target: ["uid_counterparty"] },
      { source: [], target: ["billing"], transform: "null — a refund settles the note, not an invoice" },
      { source: [], target: ["reason"], transform: '"refunded"' },
    ],
  },
  {
    id: "record-credit-note-refund:settlements-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    side: "receivable",
    invariant:
      "The note's `remaining_credit_cents` is its journal folded, committed WITH the session-keyed refund row in one batch conditioned on the note's version (ruling 128): a replay of the session finds its row and moves nothing.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD, CREDIT_NOTE_STATUS_REFINE],
    transaction: "record-credit-note-refund",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" },
      { source: [], target: ["status"], transform: "issued → applied when it reaches 0" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

const recordCreditNoteRefundTransaction: TransactionDefinition = {
  id: "record-credit-note-refund",
  description:
    "An operator records that a credit's balance was refunded in cash — a customer credit note paid back to the customer, or a supplier credit paid back by the supplier (ruling 134): appends a session-keyed `refund` settlement naming the credit and no billing document, and folds the credit's remaining balance and status in one commit. Touches no billing document. Pushes nothing to Xero — the CREDITNOTE webhook links the row to Xero's payment when it arrives.",
  steps: [
    "record-credit-note-refund:refund-to-settlements",
    "record-credit-note-refund:settlements-to-credit-note",
    "update-credit-note:note-to-orders",
    "record-credit-note-refund:purchase-credit-refund-to-settlements",
    "record-credit-note-refund:settlements-to-purchase-credit",
    "update-purchase-credit:status-to-purchases",
  ],
};

const syncXeroCreditNoteRefundsRules: CollectionRule[] = [
  {
    id: "sync-xero-credit-note-refunds:xero-to-settlements",
    source: "credit-notes",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant:
      "Xero is the authority on payments, so the note's `Payments[]` is reconciled INTO the journal in three passes, the shape of `sync-xero-settlement`: a PaymentID already on a row moves nothing; an operator-recorded refund (`xero_id: null`) matching by amount is LINKED, moving no money because it already moved; an unseen payment is appended as a `refund`. A Xero-LINKED refund Xero no longer reports is reaped by appending a `refund_reversal` (`source_retracted`) — only when the `Payments` key is PRESENT on the response, because an absent key is not evidence of absence.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD],
    transaction: "sync-xero-credit-note-refunds",
    fields: [
      { source: [], target: ["xero_id"], transform: "the match key, Xero's PaymentID — a redelivery matches instead of duplicating" },
      { source: [], target: ["reverses"], transform: "reap: the refund row Xero stopped reporting" },
    ],
  },
  {
    id: "sync-xero-credit-note-refunds:settlements-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    side: "receivable",
    invariant:
      "The note's remaining credit is the reconciled journal folded, committed WITH the rows in one batch conditioned on the note's version, so a redelivered webhook — which appends nothing — writes nothing.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD, CREDIT_NOTE_STATUS_REFINE],
    transaction: "sync-xero-credit-note-refunds",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" },
      { source: [], target: ["status"], transform: "issued ⇄ applied with the balance; a void note keeps `void`" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

const syncXeroCreditNoteRefundsTransaction: TransactionDefinition = {
  id: "sync-xero-credit-note-refunds",
  description:
    "Reconciles a Xero CREDITNOTE webhook's `Payments[]` — cash refunds on a customer credit note (`ARCREDITPAYMENT`) or a tracked supplier credit (`APCREDITPAYMENT`) — into the settlements journal as `refund` rows, and folds the credit's remaining balance and status in the same commit. Idempotent under redelivery: matching is on Xero's PaymentID, and a sync that appends nothing writes nothing.",
  steps: [
    "sync-xero-credit-note-refunds:xero-to-settlements",
    "sync-xero-credit-note-refunds:settlements-to-credit-note",
    "update-credit-note:note-to-orders",
    "sync-xero-credit-note-refunds:purchase-credit-xero-to-settlements",
    "sync-xero-credit-note-refunds:settlements-to-purchase-credit",
    "update-purchase-credit:status-to-purchases",
  ],
};

const reverseCreditNoteRefundRules: CollectionRule[] = [
  {
    id: "reverse-credit-note-refund:reverser-to-settlements",
    source: "settlements",
    target: "settlements",
    mode: "co-write",
    side: "receivable",
    invariant:
      "An operator retracts a refund THEY recorded that Xero has not linked (`xero_id: null`) by appending a `refund_reversal` naming it — the journal is append-only, so a mistaken record is undone, never edited. A Xero-LINKED refund is refused: it is removed in Xero, and the CREDITNOTE webhook's reap appends the reverser. One retraction per row, by the reverser's derived id.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD],
    transaction: "reverse-credit-note-refund",
    fields: [
      { source: ["uid"], target: ["reverses"] },
      { source: ["credit", "uid"], target: ["credit", "uid"], transform: "the reverser draws back on the same credit" },
    ],
  },
  {
    id: "reverse-credit-note-refund:settlements-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    side: "receivable",
    invariant:
      "The retracted refund's credit goes back to the note: its journal folded, in the reverser's commit, conditioned on the note's version.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD, CREDIT_NOTE_STATUS_REFINE],
    transaction: "reverse-credit-note-refund",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" },
      { source: [], target: ["status"], transform: "applied → issued once credit is back; a void note keeps `void`" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

const reverseCreditNoteRefundTransaction: TransactionDefinition = {
  id: "reverse-credit-note-refund",
  description:
    "An operator retracts an unlinked cash refund they recorded by mistake, on either side: appends a `refund_reversal` and gives the credit back to the credit document. Refused for a refund Xero has linked — that one is removed in Xero and reaped by the webhook. Touches no billing document and pushes nothing to Xero.",
  steps: [
    "reverse-credit-note-refund:reverser-to-settlements",
    "reverse-credit-note-refund:settlements-to-credit-note",
    "update-credit-note:note-to-orders",
    "reverse-credit-note-refund:purchase-credit-reverser-to-settlements",
    "reverse-credit-note-refund:settlements-to-purchase-credit",
    "update-purchase-credit:status-to-purchases",
  ],
};

// ── void-credit-note ────────────────────────────────────────────────

// NOTE: there is deliberately no `void-credit-note:reverse-allocations` rule.
//
// It existed here until beta.133 and described a void that appended a
// `credit_reversal` per live allocation. **CFS no longer does that, and the rule
// outlived the code by one release.** Voiding a note with any unreversed
// allocation is now refused unconditionally with a 409
// (`VOID_BLOCKED_BY_ALLOCATION`), because Xero refuses to void an allocated note
// and clearing an allocation needs `DELETE /CreditNotes/{id}/Allocations/{id}` —
// so the one-call path completed the CFS half, re-opened every affected invoice's
// balance, and then failed the Xero half. A ledger divergence produced by using a
// documented feature.
//
// It is worth recording HOW this was caught, because the rule shipped published
// to JSR in beta.132 while the code implementing it was already gone: the
// consumer's `propagationCoverage` ratchet asserts every rule id defined here is
// referenced in api-cloudrun service source, and this was the one id that was
// not. A propagation rule renders into `/openapi.json` as published API
// documentation, so an orphaned one is not dead code — it is a live claim that
// CFS behaves a way it does not.
//
// The operator path is `POST /settlements/{uid}/reverse` per allocation (already
// live, already idempotent per row), then void.
const voidCreditNoteRules: CollectionRule[] = [
  {
    id: "void-credit-note:status",
    source: "credit-notes",
    target: "credit-notes",
    mode: "derive",
    invariant:
      "A voided note keeps its number and strands its balance rather than consuming it — which is why `void` is exempt from the applied ⟺ remaining_credit_cents === 0 refine. The number is never reissued, even though Xero frees it.",
    enforced_by: [CREDIT_NOTE_STATUS_REFINE, CREDIT_NOTE_NUMBER_AHEAD],
    transaction: "void-credit-note",
    fields: [
      { source: [], target: ["status"], transform: 'literal "void"' },
    ],
  },
];

const voidCreditNoteTransaction: TransactionDefinition = {
  id: "void-credit-note",
  description:
    "Voids a credit note. Refused when ANY allocation or cash refund is unreversed (a refund is a Xero payment on the note, which Xero also refuses to void past). An allocation is refused with a 409 (`VOID_BLOCKED_BY_ALLOCATION`) — unconditionally, with no flag to override it, because Xero locks both ends of an allocation and CFS must not complete a retraction it cannot mirror. So a void that proceeds touches exactly ONE document in its commit: the note's own status. It moves no invoice balance, because a note with no live allocation has no invoice to affect. After the commit it converges the note's entry in `credit_notes[]` on every order it names, to `void`. Retract allocations first with `POST /settlements/{uid}/reverse`, then void.",
  steps: [
    "void-credit-note:status",
    "update-credit-note:note-to-orders",
  ],
};

// ── The payable twins (one-document-model rulings 44, 49, 132, 134) ──
//
// A supplier credit settles through the same writers as a customer credit note:
// an allocation, an operator cash refund, Xero's refund sync and the operator's
// reversal of an unlinked refund. The payable transactions that used to sit in
// `propagation/purchases.ts` (`allocate-purchase-credit`,
// `reverse-purchase-credit-allocation`, `settle-purchase-credit`) collapsed into
// these with the services (ruling 49); a supplier's cash refund gained an
// operator record (ruling 134), linked by the CREDITNOTE webhook as AR's is.

/** An operator allocation of a supplier credit, asserted on both folds and a replay. */
const PURCHASE_CREDIT_ALLOCATED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::allocate — a credit allocated to a bill folds both, and a replay moves nothing",
  clause:
    "an allocation appends one credit row naming the bill and the supplier credit, keyed on the request session; the bill's amount_credited_cents and the credit's remaining_credit_cents are both their journals folded, in the same commit; an allocation past the credit's remaining or the bill's due is refused; a replay writes nothing",
  gates: true,
};

/** A supplier's cash refund of a credit, reported by Xero, asserted with its reap. */
const SUPPLIER_REFUND_FOLDED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::refund — a supplier refund Xero reports appends one supplier_refund row and refolds the credit, and a reap reverses it",
  clause:
    "a payment Xero lists on a tracked ACCPAYCREDIT that CFS holds no live row for is appended as one refund row naming the credit (keyed on the credit, the PaymentID and a generation), and the credit's remaining_credit_cents is its journal folded in the same commit; a redelivery writes nothing; a linked row Xero stops listing is reversed (source_retracted) and the credit refolded",
  gates: true,
};

const allocatePurchaseCreditRules: CollectionRule[] = [
  {
    id: "allocate-credit-note:purchase-credit-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant:
      "An operator allocating a supplier credit to a bill of the same supplier appends ONE `credit` row naming both (`billing` + `credit`), carrying the credit's reason, keyed on the request session so a replay converges. It is written UNLINKED (`xero_id: null`, `synced_at: null`): the Xero allocation is the credit's own post-commit push, and until Xero reports it the INVOICE webhook links rather than reaps it.",
    enforced_by: [PURCHASE_CREDIT_ALLOCATED],
    transaction: "allocate-credit-note",
    fields: [
      { source: ["uid"], target: ["credit", "uid"], transform: "the row draws on the supplier credit" },
      { source: ["reason"], target: ["reason"], transform: "the allocation carries its credit's reason" },
    ],
  },
  {
    id: "allocate-credit-note:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    side: "payable",
    invariant:
      "The bill's `totals` are its journal folded in the allocation's commit, so `amount_credited_cents` moves by the allocation and `amount_due_cents` falls by it. Its `version` is bumped, as every writer of a bill's rows must.",
    enforced_by: [PURCHASE_CREDIT_ALLOCATED],
    transaction: "allocate-credit-note",
    fields: [{ source: ["amount_cents"], target: ["totals", "amount_credited_cents"], transform: "Σ live credit − credit_reversal, by fold" }],
  },
  {
    id: "allocate-credit-note:settlements-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant:
      "The supplier credit's `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal`, written in the allocation's commit, and its status re-derives (`applied` at 0). Its `version` is bumped.",
    enforced_by: [PURCHASE_CREDIT_ALLOCATED],
    transaction: "allocate-credit-note",
    fields: [{ source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" }],
  },
];

const purchaseCreditRefundRules: CollectionRule[] = [
  {
    id: "record-credit-note-refund:purchase-credit-refund-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant:
      "An operator records that a supplier paid a credit back in cash (ruling 134): ONE `refund` row naming the supplier credit and no bill, `xero_id: null`, session-keyed. Recorded in CFS only and never pushed; the CREDITNOTE webhook links it to Xero's `APCREDITPAYMENT` by amount, and an unlinked refund is never reaped.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "record-credit-note-refund",
    fields: [
      { source: ["uid"], target: ["credit", "uid"] },
      { source: ["supplier", "uid"], target: ["uid_counterparty"] },
      { source: [], target: ["billing"], transform: "null — a refund settles the credit, not a bill" },
      { source: [], target: ["reason"], transform: '"refunded"' },
    ],
  },
  {
    id: "record-credit-note-refund:settlements-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant:
      "The supplier credit's `remaining_credit_cents` is its journal folded, committed WITH the refund row in one batch conditioned on the credit's version.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "record-credit-note-refund",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" },
      { source: [], target: ["status"], transform: "issued → applied when it reaches 0" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
  {
    id: "sync-xero-credit-note-refunds:purchase-credit-xero-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant:
      "Each payment Xero lists on a tracked ACCPAYCREDIT (`APCREDITPAYMENT` — the supplier paying the credit back in cash) is reconciled INTO the journal, the receivable passes on the payable side: an operator-recorded refund (`xero_id: null`) matching by amount is LINKED; an unseen one is appended as ONE `refund` row naming the credit, keyed on the credit, the PaymentID and a generation, so a payment re-reported after its reap appends rather than overwriting; a linked row whose PaymentID Xero no longer lists is reversed (`source_retracted`) — only when the `Payments` key is present. ⚠️ A refund that would take the fold below zero is not written: CFS still holds an allocation Xero removed, so the bills those rows name are re-read and the delivery retries after them.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "sync-xero-credit-note-refunds",
    fields: [
      { source: ["uid"], target: ["credit", "uid"], transform: "the row draws on the supplier credit" },
      { source: [], target: ["xero_id"], transform: "Xero's PaymentID" },
    ],
  },
  {
    id: "sync-xero-credit-note-refunds:settlements-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant:
      "The supplier credit's `remaining_credit_cents` is its journal folded in the commit that wrote the rows, its status re-derives (`applied` at 0) and its `version` is bumped. The journal is read outside and the commit refuses when the credit's version moved, so every writer of a credit's rows bumps its version.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "sync-xero-credit-note-refunds",
    fields: [{ source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" }],
  },
  {
    id: "reverse-credit-note-refund:purchase-credit-reverser-to-settlements",
    source: "settlements",
    target: "settlements",
    mode: "co-write",
    side: "payable",
    invariant:
      "An operator retracts a supplier refund THEY recorded that Xero has not linked by appending a `refund_reversal` naming it, the receivable rule. A Xero-LINKED refund is refused: it is removed in Xero, and the CREDITNOTE webhook's reap appends the reverser.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "reverse-credit-note-refund",
    fields: [
      { source: ["uid"], target: ["reverses"] },
      { source: ["credit", "uid"], target: ["credit", "uid"], transform: "the reverser draws back on the same credit" },
    ],
  },
  {
    id: "reverse-credit-note-refund:settlements-to-purchase-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    side: "payable",
    invariant: "The retracted refund's credit goes back to the supplier credit: its journal folded, in the reverser's commit, conditioned on the credit's version.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "reverse-credit-note-refund",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "total − Σ signed draws, by fold" },
      { source: [], target: ["status"], transform: "applied → issued once credit is back; a void credit keeps `void`" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/credit-notes.ts` contributes to the propagation catalog. */
export const creditNotes: PropagationModule = {
  rules: [
    ...createCreditNoteRules,
    ...updateCreditNoteOrderRules,
    ...allocateCreditNoteRules,
    ...voidCreditNoteRules,
    ...recordCreditNoteRefundRules,
    ...syncXeroCreditNoteRefundsRules,
    ...reverseCreditNoteRefundRules,
    ...allocatePurchaseCreditRules,
    ...purchaseCreditRefundRules,
  ],
  transactions: [
    createCreditNoteTransaction,
    allocateCreditNoteTransaction,
    voidCreditNoteTransaction,
    recordCreditNoteRefundTransaction,
    syncXeroCreditNoteRefundsTransaction,
    reverseCreditNoteRefundTransaction,
  ],
};
