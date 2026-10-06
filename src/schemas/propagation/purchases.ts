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

const createPurchaseBillTransaction: TransactionDefinition = {
  id: "create-purchase-bill",
  description:
    "Bills a purchase: either PUSHES a new ACCPAY (`CFS-BILL-n`, posted by a post-commit task with read-before-create) or LINKS an existing Xero bill or card payment, read from Xero rather than the caller. The bill moves its purchase lines' `quantity_billed` in the same transaction. A linked card payment is born paid, and a linked ACCPAY carries the payments Xero already reports, as `bill_payment` settlement rows in the same transaction — fires on: a link whose Xero document holds any payment.",
  steps: ["create-purchase-bill:bill-to-purchase", "create-purchase-bill:bill-to-settlements"],
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
  rules: [...receivePurchaseRules, ...reversePurchaseReceiptRules, ...createPurchaseBillRules],
  transactions: [
    createPurchaseTransaction,
    updatePurchaseTransaction,
    closePurchaseTransaction,
    receivePurchaseTransaction,
    reversePurchaseReceiptTransaction,
    createPurchaseBillTransaction,
  ],
};
