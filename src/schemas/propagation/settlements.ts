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
 * *convergent* (`api-cloudrun/src/lib/orderInvoiceMirror.ts`) and backed by an eventarc
 * reconciler rather than merely co-written.
 *
 * The other three writers here ARE single-transaction.
 *
 * Traced from: api-cloudrun/src/services/invoices.ts, lib/settlements.ts
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
 * it is **independent of the writer**: it rebuilds each invoice's totals from
 * the journal with `recomputeSettlementTotals` and compares, rather than
 * re-running the delta the writer applied.
 */
const SETTLEMENT_TOTALS_FOLD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-settlement-totals.ts",
  clause:
    "the projection clause only — each invoice's stored `amount_paid_cents`/`amount_credited_cents`/`amount_void_cents`/`amount_due_cents` equals the signed fold over its settlements, corpus-wide, exiting 1 on any divergence. Says NOTHING about the order mirror. **The void carve-out is gone**: it used to skip `amount_due_cents` on a void invoice, which meant the one class it could not see (api-cloudrun#436) was the one that had a live defect in it — 7 prod invoices voided by a non-zeroing path were indistinguishable from 34 correctly overridden ones. A void is now a settlement row, so the fold covers it like any other.",
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

const createSettlementRules: CollectionRule[] = [
  {
    id: "create-settlement:settlement-to-invoice",
    source: "settlements",
    target: "invoices",
    mode: "co-write",
    invariant:
      "An invoice's settled totals are the signed fold over its settlements — appending a payment row raises `amount_paid_cents` and lowers `amount_due_cents` by the same amount, while `total` is untouched because it derives from items[] and a payment changes what is OWED, not what was BILLED. The row is written BEFORE the projection: the journal is the truth and the projection is repairable, so a crash leaves stale totals over a real row rather than moved money with nothing behind it. ⚠️ The row is written with `create`, NOT `set`, and that is the atomic claim on the session rather than a stylistic choice — the `existing.exists` pre-check is a read-then-act, so with a `set` two concurrent requests carrying one session both find the row absent, both write it, and both apply their own delta: one journal row, the money counted twice. Losing the create means a sibling is mid-flight and owns the projection, so the loser writes nothing; a row found ALREADY present at the start of a request is the different case, and it repairs.",
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
        transform:
          "recomputeSettlementTotals(total, rows) — total − paid − credited",
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
          "+1. The only server-side check that can reject an item edit authored before the settlement flipped the invoice to `paid` — ⚠️ NOT the only one any more — `updateInvoice` gained its own settled guard in api-cloudrun `61b52d03` (2026-08-10), one day after this file was last touched, and it throws `Cannot reprice a settled invoice`. The version bump is still the check that catches a NON-money edit the reprice gate deliberately admits. Gated on the write actually moving money: a replay zeroed by `withoutAlreadyCounted` must NOT bump, or an idempotent call becomes observable as a 409 to a concurrent editor.",
      },
    ],
  },
];

const createSettlementTransaction: TransactionDefinition = {
  id: "create-settlement",
  description:
    "Records a payment against an invoice: appends the settlement row, moves the invoice's projected totals and status by CAS, then co-writes the derived status to each linked order. THREE commits, not one — the invoice is the hot document on the money path and a transactional read+write would block every concurrent writer for the full 25s deadline. The order mirror is therefore convergent and backed by the eventarc reconciler, not merely co-written.",
  steps: [
    "create-settlement:settlement-to-invoice",
    "update-invoice:status-to-orders",
  ],
};

/**
 * The reversal's credit-note leg has ONE guard, and it is a test rather than a
 * refine — deliberately.
 *
 * `CREDIT_NOTE_STATUS_REFINE` (declared in `propagation/credit-notes.ts`)
 * only says a note is internally consistent: `applied` ⟺ zero balance, and the
 * balance never exceeds the face value. A note that never got its credit back is
 * internally consistent and completely wrong, so the refine cannot see this
 * class at all. Naming it here would have looked like enforcement and provided
 * none — the shape this campaign rejects everywhere else.
 */
const CREDIT_RELEASE_RESTORES_NOTE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/creditNotes/creditNotes.test.ts::retracting an allocation gives the credit back to the note",
  clause:
    "end to end on the deterministic path — allocate a note to exhaustion, retract the allocation, and assert the note is back to its full balance and out of `applied`, so it can be allocated again. Says nothing about concurrent retractions.",
  gates: true,
};

// ── reverse-settlement ──────────────────────────────────────────────

const reverseSettlementRules: CollectionRule[] = [
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
      // ⚠️ A `{ source: ["uid"], target: ["reverses"] }` mapping sat here and was
      // deleted 2026-08-17: `reverses` is a field of the REVERSER ROW, not of the
      // invoice this rule targets. Appending that row is `reverse-settlement`'s
      // own root write (`settlements` is the source of both its steps and the
      // target of neither), so under the root-write ruling it is deliberately
      // undeclared — and the invariant above already says the reverser "names the
      // row it reverses".
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform:
          "negated delta — applySettlementDelta over the reverser alone",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform: "total − paid − credited",
      },
      {
        source: [],
        target: ["totals", "closure_count"],
        transform:
          "−1 when the reverser is a `closure_reversal` (it folds the contract multiplier through `counts_into`, never `amount_cents`, which is 0); untouched for a money row",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "deriveInvoiceStatus over the folded totals — typically paid → part_paid or issued; a reopened $0 invoice reads `issued`",
      },
      {
        source: [],
        target: ["version"],
        transform: "+1 — see create-settlement",
      },
    ],
  },
  {
    id: "reverse-settlement:release-to-credit-note",
    source: "settlements",
    target: "credit-notes",
    mode: "co-write",
    invariant:
      'Retracting a CREDIT allocation gives the credit back to the note it drew on. This is the second half of `allocate-credit-note:remaining-credit`, and omitting it is not a cosmetic gap: the invoice is restored while the note still reports the credit as spent, so the credit is stranded — and a note the allocation had driven to zero stays `applied` with `remaining_credit_cents: 0`, which makes the over-allocation guard refuse every future allocation against it. The credit becomes permanently unusable. Fires only for `type: "credit"` rows carrying a `uid_credit_note`; a payment retraction has no note to restore and correctly writes nothing here.',
    enforced_by: [CREDIT_RELEASE_RESTORES_NOTE],
    transaction: "reverse-settlement",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform:
          "added back as a DELTA under a lastUpdateTime precondition, post-commit — the note is a hot document and is deliberately never written inside the per-invoice transaction. Capped at `totals.total_cents`, because the schema refine rejects a note holding more than its own face value; a cap means the stored balance had already drifted and is reported rather than swallowed.",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "applied → issued once credit is back. A void note keeps `void`.",
      },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
];

const reverseSettlementTransaction: TransactionDefinition = {
  id: "reverse-settlement",
  description:
    "Retracts one settlement: appends its reverser, re-folds the invoice's totals and status, co-writes that status to each linked order, and — for a credit allocation — releases the credit back to its note. Single transaction for the invoice half, unlike create-settlement; the note half is a post-commit CAS because the note is hot.",
  steps: [
    "reverse-settlement:reverser-to-invoice",
    "reverse-settlement:release-to-credit-note",
    "update-invoice:status-to-orders",
  ],
};

// ── close-invoice ───────────────────────────────────────────────────

/**
 * The fold is exercised in core, not by the api's audit: `audit-settlement-totals`
 * compares the CENTS buckets and does not read `closure_count` until the api
 * learns it (invoice-actions P2). Naming the audit here would claim a check of
 * the count that nothing runs yet.
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
    invariant:
      "An operator closes a $0 invoice by appending a `closure` row (api-cloudrun#1169). It moves NO money — `amount_cents` is 0 by contract — so it reaches the invoice through `closure_count`, never through a cents bucket, and the invoice reads `paid` and freezes for as long as the count is positive. It has its own transaction rather than riding `create-settlement`, because the two steps are not identical: that rule maps `amount_cents → amount_paid_cents`, and a closure maps nothing in cents. Legal only on a live invoice whose total is 0 with nothing money-settled and no live closure — the `close` action in `@cfs/core/utils/invoice-actions`.",
    enforced_by: [CLOSURE_FOLD],
    transaction: "close-invoice",
    fields: [
      {
        source: [],
        target: ["totals", "closure_count"],
        transform: "+1 — the contract multiplier folded through `counts_into`",
      },
      {
        source: [],
        target: ["status"],
        transform: "deriveInvoiceStatus over the folded totals — `issued` → `paid`",
      },
      {
        source: [],
        target: ["version"],
        transform: "+1 — see create-settlement",
      },
    ],
  },
];

const closeInvoiceTransaction: TransactionDefinition = {
  id: "close-invoice",
  description:
    "Mark Paid on a $0 invoice: appends a `closure` settlement row, folds `closure_count` and the status onto the invoice, and co-writes the status to each linked order. Reopening is `reverse-settlement` on that row, which appends a `closure_reversal`. Pushes nothing to Xero — Xero already reads a $0 invoice PAID.",
  steps: [
    "close-invoice:closure-to-invoice",
    "update-invoice:status-to-orders",
  ],
};

// ── sync-xero-settlement ────────────────────────────────────────────

const syncXeroSettlementRules: CollectionRule[] = [
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
      {
        source: [],
        target: ["xero_payment_id"],
        transform:
          "the match key — appended rows carry it so a redelivery matches instead of duplicating",
      },
      {
        source: [],
        target: ["xero_credit_note_id"],
        transform:
          "same, for a credit note allocated in Xero and unknown to CFS",
      },
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
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform: "delta over the genuinely-new rows only",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform: "same, for credit allocations Xero reports",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform: "total − paid − credited",
      },
      {
        source: [],
        target: ["status"],
        transform: "deriveInvoiceStatus over the folded totals",
      },
      {
        source: [],
        target: ["version"],
        transform: "+1 — see create-settlement",
      },
    ],
  },
];

const syncXeroSettlementTransaction: TransactionDefinition = {
  id: "sync-xero-settlement",
  description:
    "Reconciles a Xero invoice webhook's payments and credit allocations into the settlements journal, re-folds the invoice's projection from it, and co-writes the resulting status to each linked order. Idempotent under redelivery by construction: matching is on Xero ids and the delta excludes rows already counted.",
  steps: [
    "sync-xero-settlement:xero-to-settlements",
    "sync-xero-settlement:settlements-to-invoice",
    "update-invoice:status-to-orders",
  ],
};

// ── Voiding an invoice ──────────────────────────────────────────────
//
// **One transaction per ORIGIN, deliberately.** A void reaches CFS from an
// operator through `updateInvoice` and from the Xero invoice webhook, and until
// api-cloudrun#436 both logged under `update-invoice`, which declares exactly
// ONE step. A borrowed transaction id turns `logTransactionPropagation`'s only
// drift check (`rules_fired.length === 0 && rules_expected > 0`) off silently,
// so a void path that stopped reaping or stopped appending was unreportable by
// construction. Declaring one transaction per origin is what gives that check
// something to compare against.
//
// ⚠️ There were THREE origins until the CRMS retirement (api-cloudrun#556):
// `void-invoice-from-crms` covered the CRMS invoice webhook's status 40 and is
// deleted with that handler. The rule is about origins, not about the number —
// a fourth origin gets its own transaction rather than borrowing one of these.
//
// The MONEY half is identical across both and lives in one helper
// (`api-cloudrun/src/lib/invoiceVoid.ts`); what actually differs is the Xero
// direction, which each transaction's description states.

/**
 * The shared invariant text for the reap half. Written once because the three
 * origins do the same thing — a divergence between them is the defect, not the
 * design.
 */
const REAP_INVARIANT =
  "Voiding releases the invoice's money, so every live settlement is retracted by appending its reverser — the rows are never deleted, and each reverser's id is DERIVED from the row it retracts, so replaying the void across the three origins converges on the same documents instead of stacking retractions.";

/**
 * The shared invariant text for the void-row half.
 *
 * ⚠️ This replaced `void-invoice-from-xero:totals-override`, and the deletion is
 * the point of #436. That rule declared a voided invoice to be "the ONE place
 * the projection is overridden rather than folded" — `amount_due_cents` forced
 * to 0 where the fold gave `total`. Three carve-outs existed to keep that
 * legal (the schema's identity refine, `audit-settlement-totals.ts`, and
 * `repair-invoice-settlement-totals.ts`), and between them they made the class
 * invisible: an invoice voided by a path that never zeroed the balance looked
 * exactly like one that had. Seven prod invoices sat that way, and the
 * population was still growing when it was measured.
 */
const VOID_ROW_INVARIANT =
  "A void is a SETTLEMENT, not a field override. Exactly one `void` row per invoice — id derived from the invoice uid — carrying `total_cents` and reason `invoice_voided`, so `amount_void_cents` folds to `total` and `amount_due_cents` falls out of the ordinary identity as 0. Xero reports `AmountDue: 0` on a voided invoice and is right; what changed is that CFS now DERIVES that 0 instead of assigning it, which is what lets the corpus audit see a void that was never released.";

/**
 * The field mappings for the void row, shared by all three origins.
 *
 * ⚠️ **These describe the SETTLEMENT ROW and nothing else.** Until 2026-08-17
 * this array also carried `status`, `totals.amount_void_cents`,
 * `totals.amount_due_cents` and a `version` bump — every one of them a field of
 * the INVOICE, declared against a `settlements` target. `Settlement` has no
 * `status` and no `totals`, so those three paths resolved against nothing, which
 * is how the field-path ratchet found them (api-cloudrun#568).
 *
 * `applyInvoiceVoid` really does make two writes — it appends this row AND
 * re-folds the invoice — and one rule was describing both. The invoice half
 * needs no rule of its own: the invoice is `void-invoice`'s OWN ROOT (it is the
 * `source` of all three of that transaction's steps and the target of none), and
 * the 2026-08-17 ruling is that a transaction does not declare the write to its
 * root. So the repair is a DELETION, not a second rule — and the fold is already
 * stated where it belongs, in {@link VOID_ROW_INVARIANT}.
 *
 * ⭐ `type` and `reason` are ADDED here rather than merely surviving: the row's
 * two most identifying fields were undeclared the whole time, because the three
 * slots that should have described them were describing the invoice.
 */
const VOID_ROW_FIELDS = [
  {
    source: [],
    target: ["type"],
    transform:
      'literal "void" — the settlement bucket that folds into `amount_void_cents`',
  },
  { source: [], target: ["reason"], transform: 'literal "invoice_voided"' },
  {
    source: ["totals", "total_cents"],
    target: ["amount_cents"],
    transform:
      "the void settlement's amount IS the invoice total — a void annuls everything billed",
  },
];

// ── void-invoice (CFS-originated) ───────────────────────────────────

const voidInvoiceRules: CollectionRule[] = [
  {
    id: "void-invoice:reap-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant: REAP_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice",
    fields: [
      {
        source: ["uid"],
        target: ["reverses"],
        transform:
          "one reverser per unreversed settlement, sharing one uuid_session",
      },
    ],
  },
  {
    id: "void-invoice:append-void-settlement",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD, SETTLEMENT_BUMPS_VERSION],
    transaction: "void-invoice",
    fields: VOID_ROW_FIELDS,
  },
];

const voidInvoiceTransaction: TransactionDefinition = {
  id: "void-invoice",
  description:
    "An operator voids an invoice through `PUT /invoices/{uid}`: retracts every live settlement, appends the invoice's `void` row, folds the totals, and co-writes `void` to each linked order's invoices[] entry. CFS ORIGINATES this one, so the Xero void is pushed afterwards, outside the transaction (and deferred past a quota refusal rather than dropped — the CFS status flip has already committed and nothing re-pushes a non-draft invoice).",
  steps: [
    "void-invoice:reap-settlements",
    "void-invoice:append-void-settlement",
    "update-invoice:status-to-orders",
  ],
};

// ── void-invoice-from-xero ──────────────────────────────────────────

const voidInvoiceFromXeroRules: CollectionRule[] = [
  {
    id: "void-invoice-from-xero:reap-settlements",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant: REAP_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-xero",
    fields: [
      {
        source: ["uid"],
        target: ["reverses"],
        transform:
          "one reverser per unreversed settlement, sharing one uuid_session",
      },
    ],
  },
  {
    id: "void-invoice-from-xero:append-void-settlement",
    source: "invoices",
    target: "settlements",
    mode: "co-write",
    invariant: VOID_ROW_INVARIANT,
    enforced_by: [SETTLEMENT_TOTALS_FOLD],
    transaction: "void-invoice-from-xero",
    fields: VOID_ROW_FIELDS,
  },
];

const voidInvoiceFromXeroTransaction: TransactionDefinition = {
  id: "void-invoice-from-xero",
  description:
    "Marks an invoice void because Xero voided it: retracts every live settlement into the journal, appends the invoice's `void` row, folds the totals, and co-writes `void` to each linked order's invoices[] entry. Ingest only — CFS never pushes back on this arm. ⚠️ Its `status === \"void\"` early return no longer short-circuits the money: idempotency comes from the derived void-row id, and the old early return is exactly why three Xero-bot-voided invoices kept a balance Xero had closed.",
  steps: [
    "void-invoice-from-xero:reap-settlements",
    "void-invoice-from-xero:append-void-settlement",
    "update-invoice:status-to-orders",
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
    fields: [
      {
        source: ["uid"],
        target: ["reverses"],
        transform:
          "one reverser per unreversed settlement, sharing one uuid_session",
      },
    ],
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
 * The FOURTH void origin (api-cloudrun#1154): canceling an order whose invoice
 * bills nothing else. Before it, the cancel stripped the order's scope and left
 * an issued `$0`, lineless invoice keeping its number — a document the customer
 * was told they owed and that now claimed to bill nothing.
 *
 * ⚠️ **Its own id, never `void-invoice`'s.** A borrowed transaction id turns the
 * drift check off silently; this one declares exactly the two money steps it
 * runs. There is no `update-invoice:status-to-orders` step, and that is the
 * difference from the other three: the cancel UNLINKS both sides (G1,
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
