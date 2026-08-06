/**
 * Credit-note propagation rules — origination, allocation, and void.
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
 * 2. **`remaining_credit` is a projection, not a ledger.** It is co-written from
 *    the same settlements that move the invoices, so the note and the invoices
 *    can never disagree about how much of the note has been consumed.
 * 3. **The allocation date is neither document's date.** See
 *    {@link allocateCreditNoteRules} — it is `max(note.date, invoice.date)`, and
 *    that is an accounting requirement rather than a convenience.
 *
 * Traced from: api-cloudrun/src/services/creditNotes.ts, lib/settlements.ts
 *
 * @module
 */
import type { CollectionRule, EnforcementRef, TransactionDefinition } from "./types.ts";

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
    "the projection clause only — stored totals equal the signed fold over the invoice's settlements, corpus-wide. Says NOTHING about whether a credit note's `remaining_credit` agrees with the same rows, and nothing about the allocation date.",
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
 * The status↔`remaining_credit` biconditional, enforced at write time by the
 * schema itself rather than by an audit.
 *
 * `construction` because a document asserting `applied` while holding credit
 * cannot be written at all — `validateBeforeWrite` rejects it.
 */
const CREDIT_NOTE_STATUS_REFINE: EnforcementRef = {
  kind: "zod",
  ref: "core/src/schemas/credit-note.ts:347",
  clause:
    "`applied` ⟺ `remaining_credit === 0` (void exempt), and `remaining_credit <= totals.total`. Says nothing about whether the stored `remaining_credit` matches the settlements that produced it.",
  gates: true,
};

// ── create-credit-note ──────────────────────────────────────────────

/**
 * Origination writes ONE document plus its thread. It deliberately allocates
 * nothing: a note is a value instrument that exists before it is applied, and
 * conflating issue with allocation is what makes a partially-applied note
 * unrepresentable.
 */
export const createCreditNoteRules: CollectionRule[] = [
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

export const createCreditNoteTransaction: TransactionDefinition = {
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

export const allocateCreditNoteRules: CollectionRule[] = [
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
      { source: ["reason"], target: ["reason"], transform: "denormalized from the note" },
      { source: ["xero_credit_note_id"], target: ["xero_credit_note_id"] },
      {
        source: [],
        target: ["date"],
        transform:
          "max(credit_note.date, invoice.date) — NOT either document's own date. Xero posts journals on both a cash and an accrual basis, so the allocation carries the only date on which both facts are true (verified 6/6 on the prod corpus). Allocating before the invoice exists would post a credit against a receivable that had not been raised.",
      },
      {
        source: [],
        target: ["uid_session"],
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
        target: ["totals", "amount_credited"],
        transform:
          "applied as a DELTA against the invoice read by CAS, never an absolute — two writers that each recomputed an absolute from their own read would clobber each other, and the invoice document is the transaction's only conflict point",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due"],
        transform: "recomputeSettlementTotals(total, rows) — total − paid − credited",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "derivePaymentStatus must account for credits: a FULLY credited invoice is settled, not unpaid. Omitting credits here is the #409 bug class.",
      },
    ],
  },
  {
    id: "allocate-credit-note:remaining-credit",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    invariant:
      "The note's `remaining_credit` is a projection of the same settlements that moved the invoices, co-written in the same transaction — so the note and its invoices can never disagree about how much of it has been consumed. `applied` means remaining_credit === 0 HOWEVER it got there, by allocation or by cash refund.",
    enforced_by: [CREDIT_NOTE_STATUS_REFINE],
    transaction: "allocate-credit-note",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit"],
        transform: "total minus every unreversed allocation minus any cash refunded",
      },
      {
        source: [],
        target: ["status"],
        transform: "issued → applied when remaining_credit reaches 0",
      },
    ],
  },
];

export const allocateCreditNoteTransaction: TransactionDefinition = {
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

// ── void-credit-note ────────────────────────────────────────────────

export const voidCreditNoteRules: CollectionRule[] = [
  {
    id: "void-credit-note:reverse-allocations",
    source: "credit-notes",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Voiding a note with live allocations appends a `credit_reversal` per allocation rather than deleting anything — the journal is append-only and the totals are a signed fold, so the do/undo pair nets to zero arithmetically. There is no `status` column to filter on, deliberately.",
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-credit-note",
    fields: [
      {
        source: ["uid"],
        target: ["reverses"],
        transform:
          "one reversal per unreversed allocation, its document id DERIVED from the settlement it retracts — which makes 'one retraction per row' structural rather than a query",
      },
    ],
  },
  {
    id: "void-credit-note:status",
    source: "credit-notes",
    target: "credit-notes",
    mode: "derive",
    invariant:
      "A voided note keeps its number and strands its balance rather than consuming it — which is why `void` is exempt from the applied ⟺ remaining_credit === 0 refine. The number is never reissued, even though Xero frees it.",
    enforced_by: [CREDIT_NOTE_STATUS_REFINE, CREDIT_NOTE_NUMBER_AHEAD],
    transaction: "void-credit-note",
    fields: [
      { source: [], target: ["status"], transform: "literal \"void\"" },
    ],
  },
];

export const voidCreditNoteTransaction: TransactionDefinition = {
  id: "void-credit-note",
  description:
    "Voids a credit note, appending a reversal for every live allocation so each affected invoice's balance re-opens by the same arithmetic that closed it. Refused locally with a 409 when an allocation is unreversed and the caller did not ask to retract it — Xero locks both ends of an allocation, so pushing first would fail later and less legibly.",
  steps: [
    "void-credit-note:reverse-allocations",
    "void-credit-note:status",
    "allocate-credit-note:settlements-to-invoices",
    "update-invoice:status-to-orders",
  ],
};
