/**
 * Purchase propagation (api-cloudrun#1210).
 *
 * A purchase is the out-of-service record's shape: a parent document whose
 * HISTORY is the journal. Its receipts are ordinary `purchase` movements naming
 * it in `sources[]`, and the parent carries co-written buckets
 * (`quantity_received` here; `quantity_billed` arrives with the bill writers).
 *
 * ## What a receipt reuses, and what it adds
 *
 * Receiving folds onto the ledger, the shelves and the unit roster EXACTLY as a
 * manual `purchase` movement does, so the receipt transactions name the movement
 * rules `create-transaction:*` / `reverse-transaction:*` and the shared
 * {@link STOCK_STEPS} as steps rather than minting a ledger rule per
 * transaction. The one edge they add is the bucket: the movement moves its
 * purchase line's `quantity_received` in the same commit.
 *
 * ## What propagates nothing
 *
 * `create-purchase`, `update-purchase` and `close-purchase` write the purchase
 * alone. A purchase moves no stock and posts nothing to Xero; the buckets a
 * close moves (`quantity_canceled`) are the document's own. A short close that
 * leaves a line billed beyond what was received raises a supplier credit, and
 * that edge lands with the purchase-credits writers.
 *
 * ## Billing
 *
 * A bill is its own document (`purchase-bills`), written in ONE transaction with
 * its purchase lines' `quantity_billed` — the bucket is the sum of the bills
 * naming it by construction, exactly as `quantity_received` is of the receipts.
 * A card payment linked as a bill is BORN PAID: the same transaction appends its
 * one `bill_payment` row and folds it, so its due is 0 from the first write. The
 * Xero push of a CFS-authored bill is a post-commit task writing the bill's own
 * `xero_id`, a root write, so it declares no edge.
 *
 * Traced from: api-cloudrun/src/services/purchases.ts
 */
import type { CollectionRule, EnforcementRef, PropagationModule, TransactionDefinition } from "./types.ts";
import { STOCK_STEPS } from "./stock.ts";

/** The receipt co-write, asserted end to end on two partial deliveries. */
const RECEIPT_MOVES_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchases.test.ts::receive — two partial receipts move quantity_received and each costs its cumulative share",
  clause:
    "each receipt is one `purchase` movement naming the purchase in sources[], and the purchase line's quantity_received moves in the same commit; the two receipts' costs sum to the line amount exactly; receiving past what is still to come is refused",
  gates: true,
};

/** The reversal lever, asserted together with the refusal of the standalone path. */
const RECEIPT_REVERSAL_LEVER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchases.test.ts::reverse a receipt — the lever decrements quantity_received in one commit, and a standalone reverse is refused",
  clause:
    "the reversal names the original and the purchase in sources[] and returns quantity_held; quantity_received falls by the receipt's quantity in the same commit; POST /transactions/{uid}/reverse on a receipt is a 400",
  gates: true,
};

const receivePurchaseRules: CollectionRule[] = [
  {
    id: "receive-purchase:receipt-to-purchase",
    source: "transactions",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Every receipt is a `purchase` movement naming its purchase in sources[] (exactly one `purchases` source — the movement refine), written in ONE commit with the purchase line's `quantity_received` bump, so the bucket is the sum of the receipts naming it by construction. Receiving is refused past `quantity − quantity_canceled − quantity_received`. A receipt's cost is its CUMULATIVE share of the line (`cumulativeShareCents`), never a client input, so the receipts of a fully received line sum to its `amount_cents` exactly. A receipt posts nothing to Xero: the bill is its own document.",
    enforced_by: [RECEIPT_MOVES_THE_BUCKET],
    transaction: "receive-purchase",
    fields: [
      {
        source: ["quantity"],
        target: ["lines", "quantity_received"],
        transform: "+ quantity on the line whose uid_product is the movement's",
      },
      {
        source: ["sources"],
        target: ["uid"],
        transform: "the movement's sources[] names the purchase; the purchase finds its receipts through query_by_sources",
      },
      {
        source: ["cost", "amount_cents"],
        target: ["lines", "amount_cents"],
        transform:
          "cumulativeShareCents(line.amount_cents, line.quantity, received_before, received_before + quantity) — read from the line, never written to it",
      },
    ],
  },
];

const reversePurchaseReceiptRules: CollectionRule[] = [
  {
    id: "reverse-purchase-receipt:receipt-to-purchase",
    source: "transactions",
    target: "purchases",
    mode: "co-write",
    invariant:
      "A receipt is reversed only through its purchase, never standalone (`assertStandaloneReversible`): the reversal negates the receipt's lines and cost exactly as `reverse-transaction` does, names the original AND the purchase in sources[], and lowers the purchase line's `quantity_received` in the same commit. Nothing is pushed to Xero, because the receipt pushed nothing.",
    enforced_by: [RECEIPT_REVERSAL_LEVER],
    transaction: "reverse-purchase-receipt",
    fields: [
      {
        source: ["quantity"],
        target: ["lines", "quantity_received"],
        transform: "− the reversed receipt's quantity",
      },
      {
        source: ["sources"],
        target: ["uid"],
        transform: "the reversal's sources[] names the original receipt and the purchase",
      },
    ],
  },
];

/** The bill co-write, asserted on a pushed bill billed in two parts. */
const BILL_MOVES_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBills.test.ts::push — two bills move quantity_billed and each line costs its cumulative share",
  clause:
    "each bill moves its purchase lines' quantity_billed in the same commit; each line is priced at its cumulative share, so the bills of a fully billed line sum to its amount_cents exactly; billing past quantity − quantity_canceled is refused",
  gates: true,
};

/** The born-paid card bill, asserted on a linked SPEND. */
const CARD_BILL_BORN_PAID: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBills.test.ts::link a card payment — the bill is born paid by one bill_payment row",
  clause:
    "a linked bank_transaction bill appends exactly one bill_payment row for its whole total in the same commit, keyed from the BankTransactionID, so amount_due_cents is 0 on the first write and a replay appends nothing",
  gates: true,
};

const createPurchaseBillRules: CollectionRule[] = [
  {
    id: "create-purchase-bill:bill-to-purchase",
    source: "purchase-bills",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Every bill line bills some quantity of ONE purchase line (keyed by product) and moves that line's `quantity_billed` in the same commit, so the bucket is the sum of the bills naming it. Billing is refused past `quantity − quantity_canceled`. Each line is priced at `cumulativeShareCents(line.amount_cents, line.quantity, billed_before, billed_after)` — never a client input — so the bills of a fully billed line sum to its amount exactly. A LINKED bill's lines are priced the same way for attribution; its total is Xero's and is exempt.",
    enforced_by: [BILL_MOVES_THE_BUCKET],
    transaction: "create-purchase-bill",
    fields: [
      {
        source: ["lines", "quantity"],
        target: ["lines", "quantity_billed"],
        transform: "+ quantity on the purchase line whose uid_product is the bill line's",
      },
      {
        source: ["uid_purchase"],
        target: ["uid"],
        transform: "the bill names its purchase",
      },
      {
        source: ["lines", "amount_cents"],
        target: ["lines", "amount_cents"],
        transform:
          "cumulativeShareCents(line.amount_cents, line.quantity, billed_before, billed_before + quantity) — read from the purchase line, never written to it",
      },
    ],
  },
  {
    id: "create-purchase-bill:bill-to-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    invariant:
      "A linked `bank_transaction` bill — a card payment, BORN PAID — appends exactly one `bill_payment` row (reason `payment_sent`, `xero_payment_id: null`, since the BankTransactionID is the bill's own `xero_id`) for its whole total in the bill's commit, and the bill's totals are that row folded by `recomputePurchaseBillTotals`. A linked ACCPAY appends one `bill_payment` row per payment Xero already reports. A pushed bill appends nothing: it is unpaid when written.",
    enforced_by: [CARD_BILL_BORN_PAID],
    transaction: "create-purchase-bill",
    fields: [
      {
        source: ["totals", "total_cents"],
        target: ["amount_cents"],
        transform: "a card bill's whole total; a linked ACCPAY's each Xero payment amount",
      },
      {
        source: ["uid"],
        target: ["uid_purchase_bill"],
        transform: "the row settles the bill",
      },
      {
        source: ["supplier", "uid"],
        target: ["uid_supplier"],
        transform: "denormalized for per-supplier reporting",
      },
    ],
  },
];

/** A Xero payment arriving after the bill was written, asserted end to end. */
const BILL_PAYMENT_SYNCED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::webhook — a Xero payment on a pushed bill appends one bill_payment row and folds the bill; a redelivery appends nothing",
  clause:
    "a payment Xero reports on a tracked ACCPAY and CFS has not recorded is appended as a bill_payment row keyed (bill, PaymentID, generation); the bill's totals are the journal folded by recomputePurchaseBillTotals; replaying the same payload writes nothing and does not bump the bill's version",
  gates: true,
};

/** The reap, asserted on a payment removed in Xero. */
const BILL_PAYMENT_REAPED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::webhook — a payment Xero stops reporting is reaped by a bill_payment_reversal",
  clause:
    "a bill_payment row carrying a xero_payment_id that Xero no longer lists (the Payments key present) gets a bill_payment_reversal with reason source_retracted; a row with no xero_payment_id (a card bill born paid) is never eligible",
  gates: true,
};

/** The void, asserted with a purchase whose lines it released. */
const BILL_VOIDED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::webhook — a bill voided in Xero appends one bill_void, retracts its payments and releases quantity_billed",
  clause:
    "a tracked ACCPAY that Xero reports VOIDED or DELETED retracts every live bill_payment, appends one bill_void for total_cents, folds the bill to amount_due_cents 0 and lowers each billed purchase line's quantity_billed by the bill line's quantity, all in one commit; a redelivered void moves nothing",
  gates: true,
};

const settlePurchaseBillRules: CollectionRule[] = [
  {
    id: "settle-purchase-bill:xero-to-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Xero is the authority on what CFS has paid a supplier, so the payments and supplier-credit allocations Xero reports on a tracked ACCPAY are reconciled INTO the journal. A credit allocation is reconciled as one aggregate per (bill, credit) against CFS's live `bill_credit` rows: CFS allocations Xero had not yet shown are matched and stamped synced, a remaining excess is appended, and a shortfall reaps synced rows — an unsynced row is never reaped. For payments: one it reports and CFS has not recorded is appended as a `bill_payment`, and one CFS holds that Xero no longer lists is reaped by appending its `bill_payment_reversal`. Matched on the Xero PaymentID, keyed (bill, PaymentID, generation), so a redelivery converges on the same document and a payment reported again after a reap takes a fresh one. The reap needs the `Payments` key PRESENT, and never touches a row with no `xero_payment_id` (a card bill born paid).",
    enforced_by: [BILL_PAYMENT_SYNCED, BILL_PAYMENT_REAPED],
    transaction: "settle-purchase-bill",
    fields: [
      {
        source: [],
        target: ["xero_payment_id"],
        transform: "the match key — an appended row carries it so a redelivery matches instead of duplicating",
      },
      {
        source: [],
        target: ["reverses"],
        transform: "reap: a row Xero no longer reports gets a reverser (reason source_retracted), never a delete",
      },
      {
        source: ["uid"],
        target: ["uid_purchase_bill"],
        transform: "the row settles the bill",
      },
    ],
  },
  {
    id: "settle-purchase-bill:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "The bill's `totals` are its journal FOLDED by `recomputePurchaseBillTotals`, written in the same commit as the rows, so `paid + credited + void + due === total` holds after every sync. A sync that appends nothing writes nothing — the bill's `version` moves only when its journal does.",
    enforced_by: [BILL_PAYMENT_SYNCED],
    transaction: "settle-purchase-bill",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform: "Σ live bill_payment − bill_payment_reversal, by fold",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_due_cents"],
        transform: "total − paid − credited − void",
      },
    ],
  },
];

const voidPurchaseBillFromXeroRules: CollectionRule[] = [
  {
    id: "void-purchase-bill-from-xero:void-to-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    invariant:
      "A bill Xero reports VOIDED or DELETED retracts every live `bill_payment` (Xero reallocates a voided bill's payments away from it) and appends ONE `bill_void` for its `total_cents`, so its due is derived as 0 rather than assigned. The void row is keyed on the bill and a generation (`nextBillVoidSettlementId`): a redelivery reuses the live row and moves nothing.",
    enforced_by: [BILL_VOIDED],
    transaction: "void-purchase-bill-from-xero",
    fields: [
      {
        source: ["totals", "total_cents"],
        target: ["amount_cents"],
        transform: "the bill_void row annuls the whole bill",
      },
      {
        source: [],
        target: ["reverses"],
        transform: "each live bill_payment gets its reverser, reason source_retracted",
      },
    ],
  },
  {
    id: "void-purchase-bill-from-xero:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "The voided bill's `totals` are its journal folded: `amount_void_cents === total_cents`, everything else 0, in the commit that wrote the rows.",
    enforced_by: [BILL_VOIDED],
    transaction: "void-purchase-bill-from-xero",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_void_cents"],
        transform: "the bill_void row, by fold",
      },
      {
        source: ["amount_cents"],
        target: ["totals", "amount_paid_cents"],
        transform: "0 once every payment is retracted",
      },
    ],
  },
  {
    id: "void-purchase-bill-from-xero:bill-to-purchase",
    source: "purchase-bills",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Voiding a bill un-bills its units (owner, 2026-10-06): each bill line lowers its purchase line's `quantity_billed` by its quantity, and the purchase's status re-derives, so the units can be billed again. Only on the transition into void — a bill already carrying a live `bill_void` releases nothing a second time. A later bill of the same units is priced at its cumulative share of the NEW range, so the live bills of a line can sum to its amount ±1¢ rather than exactly.",
    enforced_by: [BILL_VOIDED],
    transaction: "void-purchase-bill-from-xero",
    fields: [
      {
        source: ["lines", "quantity"],
        target: ["lines", "quantity_billed"],
        transform: "− quantity on the purchase line whose uid_product is the bill line's",
      },
    ],
  },
];

/** The credit co-write, asserted on a pushed credit un-billing part of a line. */
const CREDIT_UNBILLS_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::push — a credit un-bills its lines at their cumulative share",
  clause:
    "each credit line lowers its purchase line's quantity_billed by its quantity in the same commit; a pushed credit line is priced at the share of the range it un-bills, so a bill and the credit of all its units sum to zero; un-billing past quantity_billed is refused",
  gates: true,
};

/** An operator allocation, asserted on both folds and a replay. */
const CREDIT_ALLOCATED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::allocate — a credit allocated to a bill folds both, and a replay moves nothing",
  clause:
    "an allocation appends one bill_credit row naming the bill and the credit, keyed on the request session; the bill's amount_credited_cents and the credit's remaining_credit_cents are both their journals folded, in the same commit; an allocation past the credit's remaining or the bill's due is refused; a replay writes nothing",
  gates: true,
};

/** A Xero-side allocation reaching a tracked bill, asserted end to end. */
const XERO_CREDIT_FOLDED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::webhook — a credit allocated in Xero appends one bill_credit row and refolds the credit",
  clause:
    "a supplier credit Xero reports allocated to a tracked bill, beyond what CFS's synced rows for that (bill, credit) hold, is first matched against CFS allocations Xero had not yet shown (stamped synced, never duplicated) and the rest appended as a bill_credit row; the bill and the credit are refolded in the same commit; a redelivery writes nothing",
  gates: true,
};

const createPurchaseCreditRules: CollectionRule[] = [
  {
    id: "create-purchase-credit:credit-to-purchase",
    source: "purchase-credits",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Every credit line UN-bills some quantity of ONE purchase line (keyed by product): it lowers that line's `quantity_billed` in the same commit, so the bucket stays the bills naming it minus the credits naming it. Un-billing past `quantity_billed` is refused. A PUSHED credit line is priced at `cumulativeShareCents(line.amount_cents, line.quantity, billed_after, billed_before)` — the share of the range it un-bills — so a bill and a credit of all its units net to zero. A LINKED credit's lines are priced the same way for attribution; its total is Xero's.",
    enforced_by: [CREDIT_UNBILLS_THE_BUCKET],
    transaction: "create-purchase-credit",
    fields: [
      {
        source: ["lines", "quantity"],
        target: ["lines", "quantity_billed"],
        transform: "− quantity on the purchase line whose uid_product is the credit line's",
      },
      {
        source: ["uid_purchase"],
        target: ["uid"],
        transform: "the credit names its purchase",
      },
    ],
  },
];

const allocatePurchaseCreditRules: CollectionRule[] = [
  {
    id: "allocate-purchase-credit:credit-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    invariant:
      "An operator allocating a supplier credit to a bill of the same supplier appends ONE `bill_credit` row naming both (`uid_purchase_bill` + `uid_purchase_credit`), carrying the credit's reason, keyed on the request session so a retry converges. It is written UNSYNCED (`synced_at: null`): the Xero allocation is a post-commit push, and until Xero reports it the INVOICE webhook matches rather than reaps it.",
    enforced_by: [CREDIT_ALLOCATED],
    transaction: "allocate-purchase-credit",
    fields: [
      {
        source: ["uid"],
        target: ["uid_purchase_credit"],
        transform: "the row draws on the credit",
      },
      {
        source: ["reason"],
        target: ["reason"],
        transform: "the allocation carries its credit's reason",
      },
    ],
  },
  {
    id: "allocate-purchase-credit:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "The bill's `totals` are its journal folded by `recomputePurchaseBillTotals` in the allocation's commit, so `amount_credited_cents` moves by the allocation and `amount_due_cents` falls by it. Its `version` is bumped, as every writer of a bill's rows must.",
    enforced_by: [CREDIT_ALLOCATED],
    transaction: "allocate-purchase-credit",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform: "Σ live bill_credit − bill_credit_reversal, by fold",
      },
    ],
  },
  {
    id: "allocate-purchase-credit:settlements-to-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    invariant:
      "The credit's `remaining_credit_cents` is its journal folded by `purchaseCreditRemainingFromJournal`, written in the allocation's commit, and its status re-derives (`applied` at 0). Its `version` is bumped.",
    enforced_by: [CREDIT_ALLOCATED],
    transaction: "allocate-purchase-credit",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform: "total − Σ signed draws, by fold",
      },
    ],
  },
];

/** The credit half of a Xero-side reconcile — shared by the settle and void transactions. */
const settlementsToCreditRule = (
  id: "settle-purchase-bill:settlements-to-credit" | "void-purchase-bill-from-xero:settlements-to-credit",
  transaction: "settle-purchase-bill" | "void-purchase-bill-from-xero",
): CollectionRule => ({
  id,
  source: "settlements",
  target: "purchase-credits",
  mode: "co-write",
  invariant:
    "Every supplier credit whose `bill_credit` rows this commit appends, reverses or stamps is refolded in the SAME commit: `remaining_credit_cents` is its journal folded by `purchaseCreditRemainingFromJournal`, its status re-derives and its `version` is bumped — so a credit's balance never trails its journal, whichever writer moved it.",
  enforced_by: [XERO_CREDIT_FOLDED],
  transaction,
  fields: [
    {
      source: ["amount_cents"],
      target: ["remaining_credit_cents"],
      transform: "total − Σ signed draws, by fold",
    },
  ],
});

const createPurchaseBillTransaction: TransactionDefinition = {
  id: "create-purchase-bill",
  description:
    "Bills a purchase: either PUSHES a new ACCPAY (`CFS-BILL-n`, posted by a post-commit task with read-before-create) or LINKS an existing Xero bill or card payment, read from Xero rather than the caller. The bill moves its purchase lines' `quantity_billed` in the same transaction. A linked card payment is born paid, and a linked ACCPAY carries the payments Xero already reports, as `bill_payment` settlement rows in the same transaction — fires on: a link whose Xero document holds any payment.",
  steps: ["create-purchase-bill:bill-to-purchase", "create-purchase-bill:bill-to-settlements"],
};

const settlePurchaseBillTransaction: TransactionDefinition = {
  id: "settle-purchase-bill",
  description:
    "Reconciles the payments Xero reports on a tracked ACCPAY into the bill's journal — appends a `bill_payment` for each one CFS has not recorded and reaps one Xero no longer lists — and folds the bill's totals in the same commit. Run by the Xero INVOICE webhook (an ACCPAY resolves `purchase-bills` by `xero_id`, never a CFS invoice) and by the daily open-bill sweep. One-directional: it never writes to Xero. Fires on: a payment added or removed in Xero.",
  steps: [
    "settle-purchase-bill:xero-to-settlements",
    "settle-purchase-bill:settlements-to-bill",
    "settle-purchase-bill:settlements-to-credit",
  ],
};

const voidPurchaseBillFromXeroTransaction: TransactionDefinition = {
  id: "void-purchase-bill-from-xero",
  description:
    "Mirrors a bill Xero reports VOIDED or DELETED: retracts its live payments, appends one `bill_void` for its total, folds the bill to nothing due and releases its purchase lines' `quantity_billed`, in one commit. The `markInvoiceVoidedFromXero` twin. Never writes to Xero. Fires on: the first webhook that sees the bill void.",
  steps: [
    "void-purchase-bill-from-xero:void-to-settlements",
    "void-purchase-bill-from-xero:settlements-to-bill",
    "void-purchase-bill-from-xero:bill-to-purchase",
    "void-purchase-bill-from-xero:settlements-to-credit",
  ],
};

const createPurchaseCreditTransaction: TransactionDefinition = {
  id: "create-purchase-credit",
  description:
    "Records a supplier credit against a purchase: either PUSHES a new ACCPAYCREDIT (`CFS-SCR-n`, posted by a post-commit task with read-before-create) or LINKS one entered in Xero, read from Xero rather than the caller. Each credit line un-bills its purchase line, lowering `quantity_billed` in the same transaction. The credit is written holding its whole total; allocations are their own writes — a linked credit's existing Xero allocations arrive through the bills they name.",
  steps: ["create-purchase-credit:credit-to-purchase"],
};

const allocatePurchaseCreditTransaction: TransactionDefinition = {
  id: "allocate-purchase-credit",
  description:
    "Allocates some of a supplier credit to one bill of the same supplier: one unsynced `bill_credit` row, the bill and the credit both refolded and version-bumped, in one commit conditioned on both documents' versions. The Xero allocation is pushed after the commit by the credit's push task. Fires on: every allocation that is not a replay.",
  steps: [
    "allocate-purchase-credit:credit-to-settlements",
    "allocate-purchase-credit:settlements-to-bill",
    "allocate-purchase-credit:settlements-to-credit",
  ],
};

const createPurchaseTransaction: TransactionDefinition = {
  id: "create-purchase",
  description:
    "Creates a purchase order: a supplier, a store, and one line per product with its quantity and amount. Propagates NOTHING — a purchase moves no stock and posts nothing to Xero; receipts and bills are their own writes. The document id is derived from the client's uuid_session, so a retried create lands on the same purchase.",
  steps: [],
};

const updatePurchaseTransaction: TransactionDefinition = {
  id: "update-purchase",
  description:
    "Amends a purchase's date, reference, notes or lines. Propagates NOTHING. A line's quantity may not fall below what is received or billed, and its amount may not change once it has any receipt or bill — a price that moved after goods arrived is a short close plus a new purchase, because every receipt already carries its share of the old price.",
  steps: [],
};

const closePurchaseTransaction: TransactionDefinition = {
  id: "close-purchase",
  description:
    "Short-closes (or, with nothing received, cancels) some or all of a purchase's lines: `quantity_canceled = quantity − quantity_received`. Propagates NOTHING in this release — the buckets it moves are the purchase's own. A close that would leave a line billed beyond what was received is refused until the purchase-bills writers can raise the supplier credit for the excess.",
  steps: [],
};

const receivePurchaseTransaction: TransactionDefinition = {
  id: "receive-purchase",
  description:
    "Receives goods against a purchase: one `purchase` movement per product, each naming the purchase in sources[] and costing its cumulative share of the line, folded onto the ledger, the shelves and the unit roster through the one ledger writer, with the purchase's `quantity_received` moved in the same commit. Posts nothing to Xero. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: every receipt, since a purchase always moves quantity_held.",
  steps: [
    "receive-purchase:receipt-to-purchase",
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
  ],
};

const reversePurchaseReceiptTransaction: TransactionDefinition = {
  id: "reverse-purchase-receipt",
  description:
    "Reverses one receipt through its purchase: the reversal is the receipt's lines and cost negated, applied through the one ledger writer, and the purchase's `quantity_received` falls in the same commit. Posts nothing to Xero. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: every receipt reversal.",
  steps: [
    "reverse-purchase-receipt:receipt-to-purchase",
    "reverse-transaction:transaction-to-ledger",
    "reverse-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
  ],
};

/** Everything `propagation/purchases.ts` contributes to the catalog. */
export const purchases: PropagationModule = {
  rules: [
    ...receivePurchaseRules,
    ...reversePurchaseReceiptRules,
    ...createPurchaseBillRules,
    ...settlePurchaseBillRules,
    settlementsToCreditRule("settle-purchase-bill:settlements-to-credit", "settle-purchase-bill"),
    ...voidPurchaseBillFromXeroRules,
    settlementsToCreditRule("void-purchase-bill-from-xero:settlements-to-credit", "void-purchase-bill-from-xero"),
    ...createPurchaseCreditRules,
    ...allocatePurchaseCreditRules,
  ],
  transactions: [
    createPurchaseTransaction,
    updatePurchaseTransaction,
    closePurchaseTransaction,
    receivePurchaseTransaction,
    reversePurchaseReceiptTransaction,
    createPurchaseBillTransaction,
    settlePurchaseBillTransaction,
    voidPurchaseBillFromXeroTransaction,
    createPurchaseCreditTransaction,
    allocatePurchaseCreditTransaction,
  ],
};
