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
 *    journal. `where("uid_credit_note","==",uid)` is an ordinary query.
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
    "the `coa_posting` clause — stored posting account vs `deriveCreditPostingAccount` vs Xero's own account code, naming the 4 historic miscodings as expected divergences. Covers neither `coa_revenue` nor the allocation edge.",
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
    "core/src/schemas/credit-note.ts::an applied credit note has no remaining credit",
  clause:
    "`applied` ⟺ `remaining_credit_cents === 0` (void exempt) — the anchored `superRefine` issue — plus its neighbour `remaining_credit_cents cannot exceed the credit note's total_cents`. Says nothing about whether the stored `remaining_credit_cents` matches the settlements that produced it.",
  gates: true,
};

/**
 * The note's projection, corpus-wide: every note's stored
 * `remaining_credit_cents` equals `creditNoteRemainingFromJournal` over the rows
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
      "Each line's `coa_posting` is STORED, not derived on read — bad_debt posts to 6900 because the sale stands and the money is written off, while every other reason reverses the line's own revenue account",
    enforced_by: [CREDIT_POSTING_AGAINST_XERO],
    transaction: "create-credit-note",
    fields: [
      {
        source: ["reason"],
        target: ["items", "coa_posting"],
        transform:
          "deriveCreditPostingAccount(reason, item.coa_revenue) — 6900 for bad_debt, the line's own coa_revenue otherwise, null for correction/unspecified (the caller must supply it, because a correction is bidirectional)",
      },
    ],
  },
];

const createCreditNoteTransaction: TransactionDefinition = {
  id: "create-credit-note",
  description:
    "Mints a credit note from the shared counter, derives each line's posting account, and cowrites its default thread. Allocates nothing — issuing and applying are separate acts.",
  steps: [
    "create-credit-note:number-from-counter",
    "create-credit-note:posting-account",
    "cowrite-thread:credit-notes-to-thread",
    "cowrite-thread:thread-to-credit-notes",
  ],
};

// ── allocate-credit-note ────────────────────────────────────────────

const allocateCreditNoteRules: CollectionRule[] = [
  {
    id: "allocate-credit-note:note-to-settlements",
    source: "credit-notes",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Applying a credit note to an invoice appends one `type: credit` settlement per invoice, carrying the note's reason denormalized — one note across three invoices has ONE reason, and authoring it three times invites three answers",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "allocate-credit-note",
    fields: [
      { source: ["uid"], target: ["uid_credit_note"] },
      { source: ["number"], target: ["number_credit_note"] },
      {
        source: ["reason"],
        target: ["reason"],
        transform: "denormalized from the note",
      },
      { source: ["xero_credit_note_id"], target: ["xero_credit_note_id"] },
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
    invariant:
      "Each credited invoice's totals are the signed fold over its settlements — `amount_credited` rises and `amount_due` falls by the allocated amount, while `total` is untouched because it derives from items[] and a credit changes what is OWED, not what was BILLED",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "allocate-credit-note",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform:
          "applied as a DELTA against the invoice read by CAS, never an absolute — two writers that each recomputed an absolute from their own read would clobber each other, and the invoice document is the transaction's only conflict point",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform:
          "recomputeSettlementTotals(total, rows) — total − paid − credited",
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
    invariant:
      "The note's `remaining_credit_cents` tracks its UNREVERSED allocations, and it does so through two writers rather than one: `allocate-credit-note` subtracts what a request consumed, and `reverse-settlement` adds back what a retraction released. Both are DELTAS applied under compare-and-set, outside the per-invoice transactions, so concurrent writers compose instead of clobbering (api-cloudrun#545). ⚠️ The reversal leg is the half that is easy to omit — without it a retracted allocation restores the invoice and strands the note's credit forever, and a note driven to zero then refuses every future allocation. Since api-cloudrun#1207 it IS also a fold over the journal — a cash refund is a `refund` row, so `creditNoteRemainingFromJournal` rebuilds it and `audit-credit-note-remaining.ts` checks it — but the writers still apply deltas, because the fold needs every row and the CAS needs only this request's. `applied` means remaining_credit_cents === 0 HOWEVER it got there, by allocation or by cash refund.",
    enforced_by: [CREDIT_NOTE_STATUS_REFINE],
    transaction: "allocate-credit-note",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform:
          "allocation subtracts this request's consumption; retraction adds the released amount back. Each is re-read and re-applied under a lastUpdateTime precondition. A NEGATIVE result is written, not clamped — by then the settlements are durable on their invoices, so it is the true projection of an over-allocation and the operator's signal. A restore that would exceed `totals.total_cents` IS capped, because the schema refine rejects that document outright; the cap is reported rather than silent.",
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
    "Applies a credit note to one or more invoices: appends a credit settlement per invoice, moves each invoice's projected totals and status, and co-writes the note's remaining credit. Fans out across N invoices and their orders.",
  steps: [
    "allocate-credit-note:note-to-settlements",
    "allocate-credit-note:settlements-to-invoices",
    "allocate-credit-note:remaining-credit",
    "update-invoice:status-to-orders",
  ],
};

// ── Refunds (api-cloudrun#1207) ─────────────────────────────────────
//
// A cash refund pays a note's credit back to the customer without touching any
// invoice. Xero records it as a Payment of type `ARCREDITPAYMENT` on the note,
// and CFS records it as a `refund` settlement — the one settlement type that
// names a credit note and no invoice (`SETTLEMENT_CONTRACTS.refund.settles`).
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
    invariant:
      "An operator recording a cash refund appends ONE `type: refund` settlement naming the note and no invoice, with `xero_payment_id: null` — the CREDITNOTE webhook links it to Xero's `ARCREDITPAYMENT` later by amount, and an unlinked refund is never reaped. Legal only while the note accepts allocation and the amount is within its remaining credit — the `record_refund` action in `@cfs/core/utils/invoice-actions`.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD],
    transaction: "record-credit-note-refund",
    fields: [
      { source: ["uid"], target: ["uid_credit_note"] },
      { source: ["number"], target: ["number_credit_note"] },
      { source: ["organization", "uid"], target: ["uid_organization"] },
      { source: [], target: ["uid_invoice"], transform: "null — a refund settles the note, not an invoice" },
      { source: [], target: ["reason"], transform: '"credit_refunded"' },
    ],
  },
  {
    id: "record-credit-note-refund:settlements-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    invariant:
      "The note's `remaining_credit_cents` falls by the refunded amount, as a DELTA under compare-and-set after the row is claimed — the same claim+CAS shape as `allocate-credit-note`, and for the same reason: the note is a hot document. A pre-read hit on the derived row id is repaired by re-folding the note from the journal; a lost claim writes nothing, because the sibling that won is about to apply its own delta.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD, CREDIT_NOTE_STATUS_REFINE],
    transaction: "record-credit-note-refund",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "− amount, under a lastUpdateTime precondition" },
      { source: [], target: ["status"], transform: "issued → applied when it reaches 0" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

const recordCreditNoteRefundTransaction: TransactionDefinition = {
  id: "record-credit-note-refund",
  description:
    "An operator records that a credit note's credit was refunded in cash: appends a `refund` settlement naming the note and no invoice, and moves the note's remaining credit and status. Touches no invoice and no order. Pushes nothing to Xero — the CREDITNOTE webhook links the row to Xero's payment when it arrives.",
  steps: [
    "record-credit-note-refund:refund-to-settlements",
    "record-credit-note-refund:settlements-to-credit-note",
  ],
};

const syncXeroCreditNoteRefundsRules: CollectionRule[] = [
  {
    id: "sync-xero-credit-note-refunds:xero-to-settlements",
    source: "credit-notes",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Xero is the authority on payments, so the note's `Payments[]` is reconciled INTO the journal in three passes, the shape of `sync-xero-settlement`: a PaymentID already on a row moves nothing; an operator-recorded refund (`xero_payment_id: null`) matching by amount is LINKED, moving no money because it already moved; an unseen payment is appended as a `refund`. A Xero-LINKED refund Xero no longer reports is reaped by appending a `refund_reversal` (`source_retracted`) — only when the `Payments` key is PRESENT on the response, because an absent key is not evidence of absence.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD],
    transaction: "sync-xero-credit-note-refunds",
    fields: [
      { source: [], target: ["xero_payment_id"], transform: "the match key — a redelivery matches instead of duplicating" },
      { source: [], target: ["reverses"], transform: "reap: the refund row Xero stopped reporting" },
    ],
  },
  {
    id: "sync-xero-credit-note-refunds:settlements-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    invariant:
      "The note's remaining credit follows the reconciled journal, and a redelivered webhook moves NOTHING: an appended refund subtracts, a reap adds back, a link moves nothing, and each is a DELTA under compare-and-set gated on this call having claimed the row.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD, CREDIT_NOTE_STATUS_REFINE],
    transaction: "sync-xero-credit-note-refunds",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "− appended refunds, + reaped ones" },
      { source: [], target: ["status"], transform: "issued ⇄ applied with the balance; a void note keeps `void`" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

const syncXeroCreditNoteRefundsTransaction: TransactionDefinition = {
  id: "sync-xero-credit-note-refunds",
  description:
    "Reconciles a Xero CREDITNOTE webhook's `Payments[]` (cash refunds, `ARCREDITPAYMENT`) into the settlements journal as `refund` rows, and moves the note's remaining credit and status. Idempotent under redelivery: matching is on Xero's PaymentID, and the delta counts only rows this call claimed.",
  steps: [
    "sync-xero-credit-note-refunds:xero-to-settlements",
    "sync-xero-credit-note-refunds:settlements-to-credit-note",
  ],
};

const reverseCreditNoteRefundRules: CollectionRule[] = [
  {
    id: "reverse-credit-note-refund:reverser-to-settlements",
    source: "settlements",
    target: "settlements",
    mode: "co-write",
    invariant:
      "An operator retracts a refund THEY recorded that Xero has not linked (`xero_payment_id: null`) by appending a `refund_reversal` naming it — the journal is append-only, so a mistaken record is undone, never edited. A Xero-LINKED refund is refused: it is removed in Xero, and the CREDITNOTE webhook's reap appends the reverser. One retraction per row, by the reverser's derived id.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD],
    transaction: "reverse-credit-note-refund",
    fields: [
      { source: ["uid"], target: ["reverses"] },
      { source: ["uid_credit_note"], target: ["uid_credit_note"] },
    ],
  },
  {
    id: "reverse-credit-note-refund:settlements-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    invariant:
      "The retracted refund's credit goes back to the note, as a DELTA under compare-and-set after the reverser is claimed — capped at `totals.total_cents`, and the cap reported, exactly as a retracted allocation's release is.",
    enforced_by: [CREDIT_NOTE_REMAINING_FOLD, CREDIT_NOTE_STATUS_REFINE],
    transaction: "reverse-credit-note-refund",
    fields: [
      { source: ["amount_cents"], target: ["remaining_credit_cents"], transform: "+ amount" },
      { source: [], target: ["status"], transform: "applied → issued once credit is back; a void note keeps `void`" },
      { source: [], target: ["version"], transform: "+1, only when money moved" },
    ],
  },
];

const reverseCreditNoteRefundTransaction: TransactionDefinition = {
  id: "reverse-credit-note-refund",
  description:
    "An operator retracts an unlinked cash refund they recorded by mistake: appends a `refund_reversal` and gives the credit back to the note. Refused for a refund Xero has linked — that one is removed in Xero and reaped by the webhook. Touches no invoice and pushes nothing to Xero.",
  steps: [
    "reverse-credit-note-refund:reverser-to-settlements",
    "reverse-credit-note-refund:settlements-to-credit-note",
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
    "Voids a credit note. Refused when ANY allocation or cash refund is unreversed (a refund is a Xero payment on the note, which Xero also refuses to void past). An allocation is refused with a 409 (`VOID_BLOCKED_BY_ALLOCATION`) — unconditionally, with no flag to override it, because Xero locks both ends of an allocation and CFS must not complete a retraction it cannot mirror. So a void that proceeds touches exactly ONE document: the note's own status. It moves no invoice balance and cascades to no order, because a note with no live allocation has no invoice to affect. Retract allocations first with `POST /settlements/{uid}/reverse`, then void.",
  steps: [
    "void-credit-note:status",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/credit-notes.ts` contributes to the propagation catalog. */
export const creditNotes: PropagationModule = {
  rules: [
    ...createCreditNoteRules,
    ...allocateCreditNoteRules,
    ...voidCreditNoteRules,
    ...recordCreditNoteRefundRules,
    ...syncXeroCreditNoteRefundsRules,
    ...reverseCreditNoteRefundRules,
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
