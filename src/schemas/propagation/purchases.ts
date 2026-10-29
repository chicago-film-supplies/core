/**
 * Purchase propagation (api-cloudrun#1210).
 *
 * A purchase is the out-of-service record's shape: a parent document whose
 * HISTORY is the journal. Its receipts are movements naming it in `sources[]` —
 * `purchase` on a buy, `subrent_in` on a subrent — and the parent carries
 * co-written buckets (`quantity_received`, `quantity_billed`, and on a subrent
 * `quantity_returned`, moved by its `subrent_out` returns and by the
 * `return_to_supplier` settles an out-of-service record's PUT writes).
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
 * ## What a BUY's create, update and close propagate: inbound supply
 *
 * On a buy, `create-purchase` and `update-purchase` move no stock and post
 * nothing to Xero. But a dated buy line is INBOUND supply for its unreceived
 * remainder (api-cloudrun#1228), so a create, an `expected_date` or quantity
 * edit, and a close each change supply: they bump `stock-locks/{P}` and rebuild
 * `stock/{P}` through {@link STOCK_STEPS}. ⚠️ An edit or a close can LOWER
 * supply, which is the direction that oversells, so the bump is not optional.
 * A close also moves the document's own `quantity_canceled`, and when it
 * leaves a line billed beyond what was received it raises a supplier credit for
 * the excess in the same commit (`close-purchase:excess-to-credit`).
 *
 * ## A SUBRENT's do: supply, and a card
 *
 * A subrent line is SUPPLY over its hire window from the moment the purchase
 * exists, so every write of a subrent — create, update, close, receive, return
 * — is a supply change, through the same {@link STOCK_STEPS}
 * (`stock:purchases-to-stock`). And each subrent has ONE "return to supplier"
 * card the same writers keep current (`purchase-card:purchases-to-card`). Each
 * transaction's `description` says which steps fire on a subrent only.
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
      "Every receipt is ONE movement naming its purchase in sources[] (exactly one `purchases` source — the movement refine) — a `purchase` on a buy, a cost-forbidden `subrent_in` on a subrent — written in ONE commit with the purchase line's `quantity_received` bump, so the bucket is the sum of the receipts naming it by construction. Receiving is refused past `quantity − quantity_canceled − quantity_received`. A buy receipt's cost is the line's CUMULATIVE target at the new received count — the goods' share plus every landed cost's share (`purchaseLineReceiptTargetCents`) — minus the cost the journal already holds for the product, never a client input, so the receipts of a fully received line sum to its `amount_cents` plus its landed costs exactly; a subrent receipt carries no cost at all, because a rented unit is never owned. A receipt posts nothing to Xero: the bill is its own document.",
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
          "a buy only: the goods' half of purchaseLineReceiptTargetCents(line, received_before + quantity) − Σ the journal's cost for the product — read from the line, never written to it. A subrent_in has no cost object.",
      },
      {
        source: ["cost", "amount_cents"],
        target: ["lines", "landed_costs", "amount_cents"],
        transform:
          "a buy only: each landed cost adds cumulativeShareCents(entry.amount_cents, entry.quantity, 0, clamp(received_after − entry.received_at_entry, 0, entry.quantity)) to the same cumulative target — read, never written (api-cloudrun#1227)",
      },
    ],
  },
];

/** The return bucket, bounded by what came in — refused by the line refine. */
const RETURN_BOUNDED: EnforcementRef = {
  kind: "zod",
  ref: "core/src/schemas/purchase.ts::line.quantity_returned > line.quantity_received",
  clause: "`quantity_returned ≤ quantity_received` — a unit can only go back once it has come in",
  gates: true,
};

/**
 * The return co-write end to end. ⚠️ The anchor names the api-cloudrun
 * integration test the subrent writer phase adds; until it lands,
 * api-cloudrun's `enforcedByResolves` reports it unresolved — a forcing
 * function on that phase.
 */
const RETURN_MOVES_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/subrents.test.ts::the 1074 flow — receive 10, check out 20, check in 20, return 10, bill",
  clause:
    "each return is one `subrent_out` naming the purchase, quantity_returned moves in the same commit, quantity_rented_in falls by the same amount and the owned average does not move; returning past what is in custody is refused",
  gates: true,
};

const returnPurchaseRules: CollectionRule[] = [
  {
    id: "return-purchase:return-to-purchase",
    source: "transactions",
    target: "purchases",
    mode: "co-write",
    invariant:
      "A subrent's units go back to the supplier as ONE `subrent_out` movement per product naming the purchase in sources[] (exactly one), written in ONE commit with the purchase line's `quantity_returned` bump, so the bucket is the sum of the returns naming it by construction. Returning is refused past `quantity_received − quantity_returned`, and on a buy. A return carries no cost — the units were never owned — and posts nothing to Xero.",
    enforced_by: [RETURN_BOUNDED, RETURN_MOVES_THE_BUCKET],
    transaction: "return-purchase",
    fields: [
      {
        source: ["quantity"],
        target: ["lines", "quantity_returned"],
        transform: "+ quantity on the line whose uid_product is the movement's",
      },
      {
        source: ["sources"],
        target: ["uid"],
        transform: "the movement's sources[] names the purchase; the purchase finds its returns through query_by_sources",
      },
    ],
  },
];

const reversePurchaseReturnRules: CollectionRule[] = [
  {
    id: "reverse-purchase-return:return-to-purchase",
    source: "transactions",
    target: "purchases",
    mode: "co-write",
    invariant:
      "A return is reversed only through its purchase, never standalone (`standaloneReversalRefusal` answers `purchase_return`): the reversal negates the `subrent_out`'s lines, names the original AND the purchase in sources[], and lowers the purchase line's `quantity_returned` in the same commit. Nothing is pushed to Xero.",
    enforced_by: [RETURN_BOUNDED, RETURN_MOVES_THE_BUCKET],
    transaction: "reverse-purchase-return",
    fields: [
      {
        source: ["quantity"],
        target: ["lines", "quantity_returned"],
        transform: "− the reversed return's quantity",
      },
      {
        source: ["sources"],
        target: ["uid"],
        transform: "the reversal's sources[] names the original return and the purchase",
      },
    ],
  },
];

/**
 * The settle end to end on a real record PUT. ⚠️ The anchor names the
 * api-cloudrun integration step the settle writer adds (api-cloudrun#1360,
 * plan Phase 2 D4); until it lands, api-cloudrun's `enforcedByResolves`
 * reports it unresolved — a forcing function on that phase.
 */
const SETTLE_MOVES_THE_PURCHASE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/subrents.test.ts::settle — a damaged rented unit and a lost one go back to the supplier from their records, and the PO closes",
  clause:
    "each settle is one `return_to_supplier` naming the record, the purchase and its supplier; the purchase line's quantity_returned and the return card move in the same commit, quantity_rented_in falls and the owned basis does not; lowering the bucket reverses it and restores all three; a settle naming no purchase, a buy, another product's purchase, or more than that purchase still has out is refused. The `quantity_rented_in` bound is not asserted: the purchase bound is reached first through the API",
  gates: true,
};

/**
 * A settle, from the OUT-OF-SERVICE side: the record PUT is its lever, so the
 * rule is the `update-out-of-service-record` transaction's (declared in
 * `propagation/out-of-service.ts`), and it lives here beside the other writers
 * of `quantity_returned` — as `propagation/invoices.ts` holds `update-order:*`.
 */
const settleToPurchaseRules: CollectionRule[] = [
  {
    id: "update-out-of-service-record:record-to-purchase",
    source: "out-of-service",
    target: "purchases",
    mode: "co-write",
    invariant:
      "A rise in a record's `returned_to_supplier` settles that many RENTED units to the subrent purchase the save names (`uid_purchase`, input-only): one `return_to_supplier` naming the record, the purchase (exactly one) and its supplier, written in ONE commit with the purchase line's `quantity_returned` bump and its return card — so `quantity_returned` stays the sum of the returns and settles naming it. Refused on a buy, on a purchase with no line for the record's product, past `quantity_received − quantity_returned`, and past the ledger's `quantity_rented_in`. Lowering the bucket reverses the newest settles, each naming its original and ITS purchase, and lowers that purchase's `quantity_returned` in the same commit. A settle carries no cost and posts nothing to Xero; what the supplier charges for the unit is a line on its bill.",
    enforced_by: [RETURN_BOUNDED, SETTLE_MOVES_THE_PURCHASE],
    transaction: "update-out-of-service-record",
    fields: [
      {
        source: ["breakdown", "returned_to_supplier"],
        target: ["lines", "quantity_returned"],
        transform: "± the bucket's change, on the line whose uid_product is the record's",
      },
      {
        source: ["uid"],
        target: ["uid"],
        transform: "the settle's sources[] names the record AND the purchase; the purchase finds it through query_by_sources",
      },
    ],
  },
];

/** The card's status/action rules, asserted directly on their table. */
const PURCHASE_CARD_TABLE: EnforcementRef = {
  kind: "test",
  ref: "core/tests/card.test.ts::computeCardStatusFromPurchase / computeCardActionFromPurchase — the table",
  clause: "status and action are derived from the purchase's buckets: planned → active while units are out → complete when nothing is in custody or still coming; canceled with the purchase",
  gates: true,
};

/** The card's shape, held by the card refine. */
const PURCHASE_CARD_SHAPE: EnforcementRef = {
  kind: "zod",
  ref: "core/src/schemas/card.ts::function checkPurchaseCard",
  clause: "the payload names exactly ONE purchase source, is never also an event card, and a purchase action sits only on it",
  gates: true,
};

const purchaseCardRules: CollectionRule[] = [
  {
    id: "purchase-card:purchases-to-card",
    source: "purchases",
    target: "cards",
    mode: "co-write",
    invariant:
      "Every SUBRENT purchase has exactly one \"return to supplier\" card, id `derivedDocId(\"purchase-return-card:\" + uid)`, written in the SAME commit as every write of the purchase that could move it (create, update, close, receive, return and their reversals) and never by a client. Its status, action and date are derived from the purchase's buckets by `computeCardStatusFromPurchase` / `computeCardActionFromPurchase` / `purchaseCardDue` (@cfs/core/utils/cards); its kind is the `purchases` source PAYLOAD (`isPurchaseCard`), not the bare source, so a hand-authored to-do that links a PO is never taken over. A buy has no card.",
    enforced_by: [PURCHASE_CARD_TABLE, PURCHASE_CARD_SHAPE],
    fields: [
      { source: ["status"], target: ["status"], transform: "computeCardStatusFromPurchase(purchase, card.status)" },
      { source: ["lines", "quantity_received"], target: ["status"], transform: "see status — received > returned on any line is `active`" },
      { source: ["lines", "quantity_returned"], target: ["action"], transform: "computeCardActionFromPurchase — return_to_supplier while any unit is in custody" },
      { source: ["lines", "dates", "end"], target: ["dates", "start"], transform: "purchaseCardDue — the earliest due-back among open lines" },
      { source: ["number"], target: ["purchases", "number"] },
      { source: ["supplier"], target: ["purchases", "supplier"] },
      { source: ["uid"], target: ["sources"], transform: "[{ collection: \"purchases\", uid }]" },
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

/** An operator reversing an UNSYNCED allocation, asserted on both folds and the refusals. */
const ALLOCATION_REVERSED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::reverse allocation — an unsynced allocation is reversed and both documents refold, a synced one is refused",
  clause:
    "reversing an unsynced bill_credit row appends ONE bill_credit_reversal naming it, keyed on the target so a second reversal is the same document; the bill's amount_credited_cents and the credit's remaining_credit_cents are both their journals folded, in the same commit conditioned on both versions; a row already reported by Xero is refused (remove it in Xero, whose webhook then reaps it); a replay writes nothing",
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

/** The short-close auto-credit, asserted with a bill it is then allocated to. */
const CLOSE_RAISES_CREDIT: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::short close — a line billed beyond what it received raises a short_close credit, allocated to the bill",
  clause:
    "closing a line billed beyond what it received writes one pushed purchase-credit (reason short_close, keyed on the purchase and the close session) for the excess units at the share of the range they un-bill, and sets quantity_billed to quantity_received in the same commit; the credit is then allocated newest bill first; a retried close writes nothing new",
  gates: true,
};

const closePurchaseRules: CollectionRule[] = [
  {
    id: "close-purchase:excess-to-credit",
    source: "purchases",
    target: "purchase-credits",
    mode: "co-write",
    invariant:
      "A close that leaves a line billed beyond what it received (`quantity_billed > quantity_received`) raises ONE pushed supplier credit (`reason: short_close`) in the same commit, with one line per such purchase line for `quantity_billed − quantity_received` units, priced at `cumulativeShareCents(amount_cents, quantity, received, billed)` — the share of the range it un-bills, as any pushed credit is. The purchase line's `quantity_billed` falls to `quantity_received` in that commit. The credit's id is derived from the purchase and the close session, so a retried close finds it rather than minting a second. Allocating it to the purchase's bills is a separate write per bill (`allocate-purchase-credit`), newest bill first, after the commit.",
    enforced_by: [CLOSE_RAISES_CREDIT],
    transaction: "close-purchase",
    fields: [
      {
        source: ["lines", "quantity_billed"],
        target: ["lines", "quantity"],
        transform: "quantity_billed − quantity_received, for each line the close leaves over-billed",
      },
      {
        source: ["uid"],
        target: ["uid_purchase"],
        transform: "the credit names the purchase it closes",
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

const reversePurchaseCreditAllocationRules: CollectionRule[] = [
  {
    id: "reverse-purchase-credit-allocation:reverser-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    invariant:
      "An operator undoing an allocation CFS has not yet pushed appends ONE `bill_credit_reversal` row naming the `bill_credit` it retracts, with an id derived from its target so a second reversal is the same document. Only a row with `synced_at: null` can be reversed here: once Xero reports it, the way out is deleting the allocation in Xero, whose webhook reaps the row.",
    enforced_by: [ALLOCATION_REVERSED],
    transaction: "reverse-purchase-credit-allocation",
    fields: [
      {
        source: ["uid"],
        target: ["uid_purchase_credit"],
        transform: "the reverser draws back on the same credit as its target",
      },
    ],
  },
  {
    id: "reverse-purchase-credit-allocation:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "The bill's `totals` are its journal folded by `recomputePurchaseBillTotals` in the reversal's commit, so `amount_credited_cents` falls by the allocation and `amount_due_cents` rises by it. Its `version` is bumped.",
    enforced_by: [ALLOCATION_REVERSED],
    transaction: "reverse-purchase-credit-allocation",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform: "Σ live bill_credit − bill_credit_reversal, by fold",
      },
    ],
  },
  {
    id: "reverse-purchase-credit-allocation:settlements-to-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    invariant:
      "The credit's `remaining_credit_cents` is its journal folded by `purchaseCreditRemainingFromJournal`, written in the reversal's commit, and its status re-derives (an `applied` credit with balance again is `issued`). Its `version` is bumped.",
    enforced_by: [ALLOCATION_REVERSED],
    transaction: "reverse-purchase-credit-allocation",
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

/** A supplier's cash refund of a credit, reported by Xero, asserted with its reap. */
const SUPPLIER_REFUND_FOLDED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::refund — a supplier refund Xero reports appends one supplier_refund row and refolds the credit, and a reap reverses it",
  clause:
    "a payment Xero lists on a tracked ACCPAYCREDIT that CFS holds no live row for is appended as one supplier_refund row naming the credit (keyed on the credit, the PaymentID and a generation), and the credit's remaining_credit_cents is its journal folded in the same commit; a redelivery writes nothing; a linked row Xero stops listing is reversed (source_retracted) and the credit refolded",
  gates: true,
};

/** A credit Xero reports VOIDED, asserted with a live allocation to reap. */
const CREDIT_VOIDED_FROM_XERO: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::void from Xero — a voided credit reaps its draws, refolds its bills and re-bills its purchase lines",
  clause:
    "a tracked supplier credit Xero reports VOIDED or DELETED becomes void; every live row drawing on it is reversed (source_retracted), each bill those rows credited is refolded in the same commit, and each credit line raises its purchase line's quantity_billed back by its quantity; a redelivery writes nothing",
  gates: true,
};

/** An operator void, asserted with its refusal. */
const CREDIT_VOIDED_FROM_CFS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::void from CFS — a credit nothing draws on voids in Xero and re-bills; one with a live allocation is refused",
  clause:
    "voiding a supplier credit from CFS voids the posted Xero credit note, then marks the credit void and raises each credit line's purchase line quantity_billed back by its quantity in one commit; a credit with any live allocation or refund is refused before Xero is called, as is a void that would re-bill units the purchase has since canceled",
  gates: true,
};

const settlePurchaseCreditRules: CollectionRule[] = [
  {
    id: "settle-purchase-credit:xero-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    invariant:
      "Each payment Xero lists on a tracked ACCPAYCREDIT (`APCREDITPAYMENT` — the supplier paying the credit back in cash) that CFS holds no live row for is appended as ONE `supplier_refund` row naming the credit (`uid_purchase_credit`, `uid_purchase_bill: null`), keyed on the credit, the PaymentID and a generation (`nextXeroSupplierRefundSettlementId`), so a payment re-reported after its reap appends rather than overwriting. A live row whose PaymentID Xero no longer lists is reversed (`source_retracted`) — only when the `Payments` key is present.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "settle-purchase-credit",
    fields: [
      {
        source: ["uid"],
        target: ["uid_purchase_credit"],
        transform: "the row draws on the credit",
      },
      {
        source: [],
        target: ["xero_payment_id"],
        transform: "Xero's PaymentID",
      },
    ],
  },
  {
    id: "settle-purchase-credit:settlements-to-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    invariant:
      "The credit's `remaining_credit_cents` is its journal folded by `purchaseCreditRemainingFromJournal` in the commit that wrote the rows, its status re-derives (`applied` at 0) and its `version` is bumped. The journal is read outside and the commit refuses when the credit's version moved, so every writer of a credit's rows bumps its version.",
    enforced_by: [SUPPLIER_REFUND_FOLDED],
    transaction: "settle-purchase-credit",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform: "total − Σ signed draws, by fold",
      },
    ],
  },
];

/** Raising the purchase lines back — shared by both void transactions. */
const creditToPurchaseRule = (
  id: "void-purchase-credit:credit-to-purchase" | "void-purchase-credit-from-xero:credit-to-purchase",
  transaction: "void-purchase-credit" | "void-purchase-credit-from-xero",
  enforcedBy: EnforcementRef,
  capped: string,
): CollectionRule => ({
  id,
  source: "purchase-credits",
  target: "purchases",
  mode: "co-write",
  invariant:
    "Voiding a supplier credit RE-bills its units, the bill void's mirror: each credit line raises its purchase line's `quantity_billed` by its quantity in the same commit, and the purchase's status re-derives. Only on the transition into void — a credit already void re-bills nothing. " +
    capped,
  enforced_by: [enforcedBy],
  transaction,
  fields: [
    {
      source: ["lines", "quantity"],
      target: ["lines", "quantity_billed"],
      transform: "+ quantity on the purchase line whose uid_product is the credit line's",
    },
  ],
});

const voidPurchaseCreditFromXeroRules: CollectionRule[] = [
  {
    id: "void-purchase-credit-from-xero:void-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    invariant:
      "A tracked supplier credit Xero reports VOIDED or DELETED retracts every live row drawing on it — its `bill_credit` allocations and its `supplier_refund`s — each with its reverser (`source_retracted`). Xero removes a note's allocations and payments before it can be voided, so these are rows whose removal CFS had not seen yet. No void row is appended: a void credit strands its balance rather than consuming it, as an AR credit note does.",
    enforced_by: [CREDIT_VOIDED_FROM_XERO],
    transaction: "void-purchase-credit-from-xero",
    fields: [
      {
        source: [],
        target: ["reverses"],
        transform: "each live draw on the credit gets its reverser, reason source_retracted",
      },
    ],
  },
  {
    id: "void-purchase-credit-from-xero:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "Each bill whose `bill_credit` row the void reverses is refolded in the same commit (`recomputePurchaseBillTotals`), so its `amount_credited_cents` falls and `amount_due_cents` rises by the reversed amount; its `version` is bumped. The commit is conditioned on each bill's version as read.",
    enforced_by: [CREDIT_VOIDED_FROM_XERO],
    transaction: "void-purchase-credit-from-xero",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform: "Σ live bill_credit − bill_credit_reversal, by fold",
      },
    ],
  },
  {
    id: "void-purchase-credit-from-xero:settlements-to-credit",
    source: "settlements",
    target: "purchase-credits",
    mode: "co-write",
    invariant:
      "The voided credit is refolded in the same commit: `status: void`, `remaining_credit_cents` its journal folded (the whole total, once every draw is reversed), `version` bumped.",
    enforced_by: [CREDIT_VOIDED_FROM_XERO],
    transaction: "void-purchase-credit-from-xero",
    fields: [
      {
        source: ["amount_cents"],
        target: ["remaining_credit_cents"],
        transform: "total − Σ signed draws, by fold",
      },
    ],
  },
  creditToPurchaseRule(
    "void-purchase-credit-from-xero:credit-to-purchase",
    "void-purchase-credit-from-xero",
    CREDIT_VOIDED_FROM_XERO,
    "Xero is the authority, so a void that would re-bill units the purchase has since CANCELED (a short close's credit, voided in Xero) is not refused: the line re-bills only up to `quantity − quantity_canceled`, and the excess is reported (`purchase_credit_void_overbilled`) — Xero then bills units CFS will never receive, which a person must re-credit.",
  ),
];

const voidPurchaseCreditRules: CollectionRule[] = [
  creditToPurchaseRule(
    "void-purchase-credit:credit-to-purchase",
    "void-purchase-credit",
    CREDIT_VOIDED_FROM_CFS,
    "An operator void is refused while any row draws on the credit (Xero refuses to void a note with an allocation or a payment), and refused when re-billing would exceed `quantity − quantity_canceled` — so it writes no settlement row.",
  ),
];

const createPurchaseBillTransaction: TransactionDefinition = {
  id: "create-purchase-bill",
  description:
    "Bills a purchase: either PUSHES a new ACCPAY (`CFS-BILL-n`, posted by a post-commit task with read-before-create) or LINKS an existing Xero bill or card payment, read from Xero rather than the caller. The bill moves its purchase lines' `quantity_billed` in the same transaction. A linked card payment is born paid, and a linked ACCPAY carries the payments Xero already reports, as `bill_payment` settlement rows in the same transaction — fires on: a link whose Xero document holds any payment.",
  steps: [
    "create-purchase-bill:bill-to-purchase",
    "create-purchase-bill:bill-to-settlements",
    "cowrite-thread:purchase-bills-to-thread",
    "cowrite-thread:thread-to-purchase-bills",
  ],
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
  steps: [
    "create-purchase-credit:credit-to-purchase",
    "cowrite-thread:purchase-credits-to-thread",
    "cowrite-thread:thread-to-purchase-credits",
  ],
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

const reversePurchaseCreditAllocationTransaction: TransactionDefinition = {
  id: "reverse-purchase-credit-allocation",
  description:
    "Undoes an allocation of a supplier credit that has not reached Xero: one `bill_credit_reversal` row retracting the unsynced `bill_credit`, the bill and the credit both refolded and version-bumped, in one commit conditioned on both documents' versions. Posts nothing to Xero, and the credit's push skips a reversed row. A row Xero already reports is refused. Fires on: every reversal that is not a replay.",
  steps: [
    "reverse-purchase-credit-allocation:reverser-to-settlements",
    "reverse-purchase-credit-allocation:settlements-to-bill",
    "reverse-purchase-credit-allocation:settlements-to-credit",
  ],
};

const settlePurchaseCreditTransaction: TransactionDefinition = {
  id: "settle-purchase-credit",
  description:
    "Reconciles the cash refunds Xero reports on a tracked supplier credit (its `Payments[]`, `APCREDITPAYMENT`) into the credit's journal — appends a `supplier_refund` for each one CFS has not recorded and reaps one Xero no longer lists — and refolds the credit in the same commit. Run by the Xero CREDITNOTE webhook (an ACCPAYCREDIT resolves `purchase-credits` by `xero_id`) and by a link of a credit Xero already shows refunded. One-directional: it never writes to Xero. Fires on: a refund added or removed in Xero.",
  steps: ["settle-purchase-credit:xero-to-settlements", "settle-purchase-credit:settlements-to-credit"],
};

const voidPurchaseCreditTransaction: TransactionDefinition = {
  id: "void-purchase-credit",
  description:
    "An operator voids a supplier credit nothing draws on: the posted Xero credit note is voided first (`POST /CreditNotes/{id}` `Status: VOIDED`), then one commit marks the credit void and re-bills its purchase lines. A pushed credit not yet posted is voided in CFS alone, and its push then posts nothing. Fires on: every void that is not a replay.",
  steps: ["void-purchase-credit:credit-to-purchase"],
};

const voidPurchaseCreditFromXeroTransaction: TransactionDefinition = {
  id: "void-purchase-credit-from-xero",
  description:
    "Mirrors a supplier credit Xero reports VOIDED or DELETED: reverses every live row drawing on it, refolds the bills those rows credited, marks the credit void and re-bills its purchase lines, in one commit conditioned on every document's version. Never writes to Xero. Fires on: the first webhook that sees the credit void.",
  steps: [
    "void-purchase-credit-from-xero:void-to-settlements",
    "void-purchase-credit-from-xero:settlements-to-bill",
    "void-purchase-credit-from-xero:settlements-to-credit",
    "void-purchase-credit-from-xero:credit-to-purchase",
  ],
};

const createPurchaseTransaction: TransactionDefinition = {
  id: "create-purchase",
  description:
    "Creates a purchase order: a supplier, a store, and one line per product with its quantity and amount, and cowrites its default thread. A purchase moves no stock and posts nothing to Xero; receipts and bills are their own writes. The document id is derived from the client's uuid_session, so a retried create lands on the same purchase. Every line is supply from this moment — a subrent over its hire window, a dated buy line as inbound from its expected date — so the create bumps `stock-locks/{P}` and rebuilds `stock/{P}` via STOCK_STEPS. On a SUBRENT only it also writes the purchase's return card, with its own default thread, as a card's first write does.",
  steps: [
    "cowrite-thread:purchases-to-thread",
    "cowrite-thread:thread-to-purchases",
    ...STOCK_STEPS,
    "purchase-card:purchases-to-card",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

const updatePurchaseTransaction: TransactionDefinition = {
  id: "update-purchase",
  description:
    "Amends a purchase's date, reference, notes or lines. On a BUY a line's quantity may not fall below what is received or billed, and its amount may not change once it has any receipt or bill — a price that moved after goods arrived is a short close plus a new purchase, because every receipt already carries its share of the old price; the update fires STOCK_STEPS, since a line's expected_date and unreceived quantity are inbound supply. On a SUBRENT a receipt carries no cost, so the amount and the hire end stay editable after receipt (a paid extension), and the update fires STOCK_STEPS and the return card, since the hire window is supply.",
  steps: [...STOCK_STEPS, "purchase-card:purchases-to-card"],
};

const closePurchaseTransaction: TransactionDefinition = {
  id: "close-purchase",
  description:
    "Short-closes (or, with nothing received, cancels) some or all of a purchase's lines: `quantity_canceled = quantity − quantity_received`. When that leaves a line billed beyond what it received, the same commit raises a pushed supplier credit (`short_close`) for the excess and lowers `quantity_billed` to `quantity_received`; after the commit the credit is pushed to Xero and allocated to the purchase's bills, newest first, one `allocate-purchase-credit` per bill. The raised credit gets its default thread in the same commit, as an operator-raised one does. Fires on: a close of an over-billed line. Every close lowers the closed line's supply, so it fires STOCK_STEPS: on a BUY the short-closed remainder stops being inbound. A SUBRENT's close is refused while units are unreturned; when it is allowed it also fires the return card, on a subrent only.",
  steps: [
    "close-purchase:excess-to-credit",
    "cowrite-thread:purchase-credits-to-thread",
    "cowrite-thread:thread-to-purchase-credits",
    ...STOCK_STEPS,
    "purchase-card:purchases-to-card",
  ],
};

const receivePurchaseTransaction: TransactionDefinition = {
  id: "receive-purchase",
  description:
    "Receives goods against a purchase: one movement per product naming the purchase in sources[] — a `purchase` costing its cumulative share of the line on a buy, a cost-forbidden `subrent_in` landing at the arrivals inbox on a subrent (which raises `quantity_rented_in` with `quantity_held`) — folded onto the ledger and the shelves through the one ledger writer, with the purchase's `quantity_received` moved in the same commit. Posts nothing to Xero. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: every receipt, since a receipt always moves quantity_held. The unit roster steps fire whenever the receipt names units — a buy or a subrent of a seeded serialized product, where a `subrent_in`'s opened history entry carries the purchase's `supplier`; the return card on a SUBRENT only.",
  steps: [
    "receive-purchase:receipt-to-purchase",
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
    "purchase-card:purchases-to-card",
  ],
};

const reversePurchaseReceiptTransaction: TransactionDefinition = {
  id: "reverse-purchase-receipt",
  description:
    "Reverses one receipt through its purchase: the reversal is the receipt's lines and cost negated, applied through the one ledger writer, and the purchase's `quantity_received` falls in the same commit. Posts nothing to Xero. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: every receipt reversal. The roster steps fire whenever the receipt named units, a subrent's included; the return card on a subrent only.",
  steps: [
    "reverse-purchase-receipt:receipt-to-purchase",
    "reverse-transaction:transaction-to-ledger",
    "reverse-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
    "purchase-card:purchases-to-card",
  ],
};

const returnPurchaseTransaction: TransactionDefinition = {
  id: "return-purchase",
  description:
    "Returns a subrent's units to the supplier (`POST /purchases/{uid}/returns`): one cost-forbidden `subrent_out` per product, from the shelves, naming the purchase in sources[] and folded through the one ledger writer — which lowers `quantity_held` and `quantity_rented_in` together and leaves owned basis untouched — with the purchase's `quantity_returned` moved in the same commit. Refused on a buy. Posts nothing to Xero. Rebuilds `stock/{P}` via STOCK_STEPS and moves the return card — fires on: every return. The unit roster steps fire whenever the return names units, each of which must be vendor-owned by this purchase's supplier.",
  steps: [
    "return-purchase:return-to-purchase",
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
    "purchase-card:purchases-to-card",
  ],
};

const reversePurchaseReturnTransaction: TransactionDefinition = {
  id: "reverse-purchase-return",
  description:
    "Reverses one return through its purchase: the `subrent_out`'s lines negated through the one ledger writer, and the purchase's `quantity_returned` falls in the same commit. Posts nothing to Xero. Rebuilds `stock/{P}` via STOCK_STEPS and moves the return card — fires on: every return reversal. The unit roster steps fire whenever the return named units.",
  steps: [
    "reverse-purchase-return:return-to-purchase",
    "reverse-transaction:transaction-to-ledger",
    "reverse-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
    "purchase-card:purchases-to-card",
  ],
};

/** Everything `propagation/purchases.ts` contributes to the catalog. */
export const purchases: PropagationModule = {
  rules: [
    ...receivePurchaseRules,
    ...reversePurchaseReceiptRules,
    ...returnPurchaseRules,
    ...reversePurchaseReturnRules,
    ...settleToPurchaseRules,
    ...purchaseCardRules,
    ...createPurchaseBillRules,
    ...settlePurchaseBillRules,
    settlementsToCreditRule("settle-purchase-bill:settlements-to-credit", "settle-purchase-bill"),
    ...voidPurchaseBillFromXeroRules,
    settlementsToCreditRule("void-purchase-bill-from-xero:settlements-to-credit", "void-purchase-bill-from-xero"),
    ...createPurchaseCreditRules,
    ...allocatePurchaseCreditRules,
    ...reversePurchaseCreditAllocationRules,
    ...closePurchaseRules,
    ...settlePurchaseCreditRules,
    ...voidPurchaseCreditRules,
    ...voidPurchaseCreditFromXeroRules,
  ],
  transactions: [
    createPurchaseTransaction,
    updatePurchaseTransaction,
    closePurchaseTransaction,
    receivePurchaseTransaction,
    reversePurchaseReceiptTransaction,
    returnPurchaseTransaction,
    reversePurchaseReturnTransaction,
    createPurchaseBillTransaction,
    settlePurchaseBillTransaction,
    voidPurchaseBillFromXeroTransaction,
    createPurchaseCreditTransaction,
    allocatePurchaseCreditTransaction,
    reversePurchaseCreditAllocationTransaction,
    settlePurchaseCreditTransaction,
    voidPurchaseCreditTransaction,
    voidPurchaseCreditFromXeroTransaction,
  ],
};
