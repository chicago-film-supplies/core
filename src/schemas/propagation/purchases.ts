/**
 * Purchase propagation (api-cloudrun#1210).
 *
 * A purchase is the out-of-service record's shape: a parent document whose
 * HISTORY is the journal. Its receipts are movements naming it in `sources[]` —
 * `purchase` on a buy, `subrent_in` on a subrent — and each moves the line's
 * INBOUND BOOKING (`bookings-inbound`) in the same commit: `ordered → received`
 * on a receipt, `stocked → sent_back` on a `subrent_out` return, `stocked →
 * lost | damaged` on the `return_to_supplier` settles an out-of-service
 * record's PUT writes. What a line has received and returned is DERIVED from
 * that custody (one-document-model C8 retired the line buckets
 * `quantity_received` / `quantity_returned`); the one co-written bucket left
 * is `quantity_billed`, a recount (see *Billing*).
 *
 * ⚠️ **The rule ids below still say `…-to-purchase`** although their target is
 * the inbound booking: renaming them is the C13 vocabulary survey's, in the
 * beta whose api commit emits the new ids (`propagationCoverage` has no
 * pending list).
 *
 * ⚠️ **The arm is per ITEM since api-cloudrun#1407** — there is no document
 * `kind`, so "a buy" and "a subrent" below mean a buy ITEM and a subrent ITEM,
 * and one purchase may carry both. A "line" is an item.
 *
 * ## What a receipt reuses, and what it adds
 *
 * Receiving folds onto the ledger, the shelves and the unit roster EXACTLY as a
 * manual `purchase` movement does, so the receipt transactions name the movement
 * rules `create-transaction:*` / `reverse-transaction:*` and the shared
 * {@link STOCK_STEPS} as steps rather than minting a ledger rule per
 * transaction. The one edge they add is the custody: the movement moves its
 * line's inbound booking in the same commit.
 *
 * ## What a BUY's create, update and close propagate: inbound supply
 *
 * On a buy, `create-purchase` and `update-purchase` move no stock and post
 * nothing to Xero. But a dated buy line is INBOUND supply for its unreceived
 * remainder (api-cloudrun#1228), so a create, a `delivery_start` (its pair's
 * expected arrival, C8) or quantity edit, and a close each change supply: they bump `stock-locks/{P}` and rebuild
 * `stock/{P}` through {@link STOCK_STEPS}. ⚠️ An edit or a close can LOWER
 * supply, which is the direction that oversells, so the bump is not optional.
 * A close lowers the document's own line quantities and reaches its bills by the
 * three-way sync (`close-purchase:purchase-to-bills`).
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
 * its purchase lines' `quantity_billed`.
 *
 * ⚠️ **That bucket is RECOUNTED** (api-cloudrun#1441). A bill line's quantity
 * changes, so a delta releases the wrong number when that bill is voided. Every write that adds or
 * voids a bill or credit, or edits a bill line's quantity, recalculates the count
 * from the purchase's live documents in the same commit: the shared steps
 * `purchase-billed:bills-to-purchase` and `purchase-billed:credits-to-purchase`,
 * referenced as `RECOUNT_STEPS`. It is one rule with several firing contexts,
 * not one per transaction, for the reason `STOCK_STEPS` is. A recount moves no
 * status and so no return card: a purchase's status is custody-only (7a C7,
 * rulings 55 and 56) and the purchase finalize writes it.
 *
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
/** The reversal lever, asserted together with the refusal of the standalone path. */

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

/**
 * Returned is bounded by what came in — by the movement contract, now that both
 * are custody (C8): a return or settle moves units OFF `stocked`, which only a
 * receipt and a put-away fill.
 */
const RETURN_BOUNDED: EnforcementRef = {
  kind: "zod",
  ref: "core/src/schemas/transaction.ts::function checkMovementContract",
  clause:
    "a `subrent_out` moves `stocked → sent_back` and a `return_to_supplier` settles `stocked → lost | damaged` on the inbound ladder, so a unit can only go back once it has come in",
  gates: true,
};

/**
 * The settle end to end on a real record PUT. ⚠️ The anchor names the
 * api-cloudrun integration step the settle writer adds (api-cloudrun#1360,
 * plan Phase 2 D4); until it lands, api-cloudrun's `enforcedByResolves`
 * reports it unresolved — a forcing function on that phase.
 */
const SETTLE_MOVES_THE_BOOKING: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/subrents.test.ts::settle — a damaged rented unit and a lost one go back to the supplier from their records, and the PO closes",
  clause:
    "each settle is one `return_to_supplier` naming the record, the purchase, its supplier, the Subrent row and its inbound booking; the booking moves stocked → lost | damaged in the same commit, the return card follows from the finalize, quantity_rented_in falls and the owned basis does not; lowering the bucket writes the settle's typed undo and restores all three; a settle naming no purchase or row, a Buy row, another product's row, or more than the booking holds stocked is refused",
  gates: true,
};

/**
 * A settle, from the OUT-OF-SERVICE side: the record PUT is its lever, so the
 * rule is the `update-out-of-service-record` transaction's (declared in
 * `propagation/out-of-service.ts`), and it lives here beside the other writers
 * of a subrent's returned custody — as `propagation/invoices.ts` holds `update-order:*`.
 */
const settleToInboundBookingRules: CollectionRule[] = [
  {
    id: "update-out-of-service-record:record-to-inbound-booking",
    source: "out-of-service",
    target: "bookings-inbound",
    mode: "co-write",
    invariant:
      "A rise in a record's `returned_to_supplier` settles that many RENTED units on the Subrent row the save names (`uid_purchase` + `path_source_item`, input-only, ruling 65): one `return_to_supplier` naming the record, the purchase (exactly one), its supplier, the row and the row's inbound booking, written in ONE commit with that booking's `settle_lost` (`stocked → lost`) or `settle_damaged` (`stocked → damaged`) step by the record's reason (none for a unit received damaged, ruling 64), through core's `applyInboundCustodyActions`. The purchase, its receipt and its return card follow from the committed booking (`finalize-purchase`). Refused on a row that is not a Subrent of the record's product, on a row with no inbound booking, on a reason the inbound ladder has no key for (cleaning, maintenance), past what the booking holds `stocked`, and past the ledger's `quantity_rented_in`. Lowering the bucket walks back the newest settles with their TYPED undo, `return_to_supplier_undo`, each naming the settle it undoes in sources[] and moving that booking back in the same commit. A settle carries no cost and posts nothing to Xero; what the supplier charges for the unit is a line on its bill.",
    enforced_by: [RETURN_BOUNDED, SETTLE_MOVES_THE_BOOKING],
    transaction: "update-out-of-service-record",
    fields: [
      {
        source: ["breakdown", "returned_to_supplier"],
        target: ["breakdown", "lost"],
        transform: "± the bucket's change off `stocked`, onto `lost` or `damaged` by the record's reason, on the booking of the row the settle names",
      },
      {
        source: ["uid"],
        target: ["source"],
        transform: "the settle's sources[] names the record AND the purchase the booking's `source` names; the purchase finds it through query_by_sources",
      },
    ],
  },
];

/** The card's status/action rules, asserted directly on their table. */
const PURCHASE_CARD_TABLE: EnforcementRef = {
  kind: "test",
  ref: "core/tests/card.test.ts::computeCardStatusFromPurchase / computeCardActionFromPurchase — the table",
  clause: "status and action are derived from the purchase's subrent rows' custody (`custodyBySourceItem`): planned → active while units are out → complete when nothing is in custody or still coming; canceled with the purchase",
  gates: true,
};

/** The card's shape, held by the card refine. */
const PURCHASE_CARD_SHAPE: EnforcementRef = {
  kind: "zod",
  ref: "core/src/schemas/card.ts::function checkPurchaseCard",
  clause: "the payload names exactly ONE purchase source, is never also an event card, and a purchase action sits only on it",
  gates: true,
};

const INBOUND_RECONCILE: EnforcementRef = {
  kind: "assertion",
  ref: "api-cloudrun/src/lib/inboundBookingReconcile.ts::reconcileInboundBookings",
  clause:
    "one booking per (purchase, product, leg, signature) grain a Buy or Subrent row books; physical quantity from the receipt rows, quantity_ordered from the purchase lines; history carried, the rest planned; a grain the purchase no longer implies kept at quantity_ordered 0 while it holds history, else deleted",
  gates: true,
};

const RECEIPT_SYNC: EnforcementRef = {
  kind: "assertion",
  ref: "api-cloudrun/src/lib/purchaseReceiptSync.ts::syncReceiptContent",
  clause:
    "the three-way merge over purchaseReceiptSharedFields: an untouched row follows the purchase, a receiver's row quantity stays; a removed row is kept at quantity_ordered 0 while its grain holds custody history",
  gates: true,
};

/**
 * The custody projection every purchase write and every inbound custody step
 * runs (one-document-model 7a, W2): purchase → receipt → inbound bookings →
 * purchase. One rule per edge with several firing contexts, referenced as
 * `PURCHASE_CUSTODY_STEPS`, for the reason `STOCK_STEPS` is one: the hole a
 * per-transaction copy would vary on is a transaction id, not a collection.
 */
const purchaseCustodyRules: CollectionRule[] = [
  {
    id: "purchase-custody:purchase-to-receipt",
    source: "purchases",
    target: "purchase-receipts",
    mode: "co-write",
    invariant:
      "`purchase-receipts/{uid}` is the purchase's custody projection, written in the same commit as every purchase write: its rows are the purchase's dividers and Buy / Subrent rows, merged three-way over the shared fields (`purchaseReceiptSharedFields`) so a receiver's row quantity survives a purchase edit; `number`, `status` and `reference` are copies; `due_at` and `query_by_uid_store` are derived from the inbound bookings. A missing receipt is created by the next write.",
    enforced_by: [RECEIPT_SYNC],
    fields: [
      { source: ["items"], target: ["items"], transform: "syncReceiptContent — dividers and Buy / Subrent rows, quantity_ordered the purchase's" },
      { source: ["destinations"], target: ["destinations"], transform: "each pair follows its divider" },
      { source: ["supplier"], target: ["supplier"], transform: "taken whole (an atom)" },
      { source: ["subject"], target: ["subject"] },
      { source: ["status"], target: ["status"], transform: "a copy" },
      { source: ["number"], target: ["number"], transform: "a copy" },
    ],
  },
  {
    id: "purchase-custody:receipt-to-inbound-bookings",
    source: "purchase-receipts",
    target: "bookings-inbound",
    mode: "co-write",
    invariant:
      "A purchase's inbound bookings reconcile from its receipt and its lines in the same commit: one booking per (purchase, product, leg, component signature) grain of a Buy or Subrent row (a kit header books nothing), its `quantity` the receipt rows' physical count, `quantity_ordered` the purchase lines', its breakdown `calculateInboundBreakdown` over the purchase status (history carried, the rest `ordered`; none on a canceled purchase). A grain the purchase no longer implies is kept at `quantity_ordered: 0` while it holds custody history and deleted while it is plan only. A Buy and a Subrent of one product on one leg are refused, since they would share a booking.",
    enforced_by: [INBOUND_RECONCILE],
    fields: [
      { source: ["items", "quantity"], target: ["quantity"], transform: "Σ receipt row quantity at the grain; the breakdown follows calculateInboundBreakdown" },
      { source: ["items", "quantity_ordered"], target: ["quantity_ordered"], transform: "Σ purchase line quantity at the grain" },
      { source: ["destinations", "dates"], target: ["dates"], transform: "buildBookingDates over the row's pair — a Buy from delivery_start, open-ended; a Subrent its hire" },
    ],
  },
  {
    id: "purchase-custody:inbound-bookings-to-purchase",
    source: "bookings-inbound",
    target: "purchases",
    mode: "co-write",
    invariant:
      "A purchase's `status` and `bookings_breakdown` are read off its inbound bookings in the commit that writes them: `derivePurchaseStatus` (canceled is authored; otherwise complete once every booking is closed, a purchase booking nothing included, rulings 55 and 61) and the bookings' breakdowns summed.",
    enforced_by: [INBOUND_RECONCILE],
    fields: [
      { source: ["breakdown"], target: ["bookings_breakdown"], transform: "Σ every booking's breakdown" },
      { source: ["breakdown"], target: ["status"], transform: "derivePurchaseStatus(stored, bookings)" },
    ],
  },
];

/** The inbound lever, asserted at its one implementation. */
const INBOUND_LEVER: EnforcementRef = {
  kind: "assertion",
  ref: "api-cloudrun/src/services/inboundBookings.ts::applyInboundBookingUpdates",
  clause:
    "each action row moves its inbound booking by `applyInboundCustodyActions` and writes ONE movement per transition naming the booking (uid_booking), its custody pair and its row (path_source_item), under the row's sub-session, through the ledger writer's ownership stager; the booking write and every movement land in one batch conditioned on the booking's read time; a stale version is a 409, a short bucket a 400",
  gates: true,
};

/**
 * The inbound lever's own edge (one-document-model W3): a custody step on an
 * inbound booking writes its movement. The movement's fold onto the ledger and
 * the shelves is `create-transaction`'s, which the lever's transaction lists.
 */
const RECEIVE_DAMAGED_RECORD: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/receiveDamagedRecord.test.ts::receive_damaged opens a record keyed on its flag, sourced to the purchase and its inbound booking",
  clause:
    "a `receive_damaged` step opens ONE out-of-service record keyed on its `receive_flag` movement's id and numbered by it, reason `damaged`, its units flagged on the staging shelf (away on an uncounted product), sourced to the purchase and the inbound booking and never `bookings:`, with its default thread, in the lever's batch; `planReceiveDamagedUndo` cancels the row's records newest first, whole, and a partial undo re-opens the remainder on a new record inheriting the oldest consumed one's details and shelf (the outbound loss undo's rule, api-cloudrun#1218); a resolved or mark-less record is refused. Hermetic; the lever's batch is type-checked only until the window converts test",
  gates: true,
};

const updateInboundBookingRules: CollectionRule[] = [
  {
    id: "update-inbound-booking:booking-to-transactions",
    source: "bookings-inbound",
    target: "transactions",
    mode: "co-write",
    invariant:
      "Every inbound custody step is ONE movement written in the commit that moves the booking: its type is the rule's arm for the booking's line type (`INBOUND_CUSTODY_RULES`), it names the booking in uid_booking, the step's custody pair, the purchase row in path_source_item and the purchase in sources[], and its id is `{row sub-session}|{type}|{booking}`, so a retried request lands on the same movement. A Buy's receipt costs the row's cumulative target less what the journal holds for the row; a `purchase_undo` relieves the basis newest first. The booking's breakdown is the net of its movements (`net[k] === breakdown[k]` over INBOUND_HISTORY_KEYS).",
    enforced_by: [INBOUND_LEVER],
    transaction: "update-inbound-booking",
    fields: [
      { source: ["breakdown"], target: ["custody"], transform: "the action's rule pair, `from → to`" },
      { source: ["uid"], target: ["uid_booking"] },
      { source: ["source"], target: ["sources"], transform: "the purchase the booking's source names" },
    ],
  },
  {
    id: "update-inbound-booking:booking-to-out-of-service",
    source: "bookings-inbound",
    target: "out-of-service",
    mode: "co-write",
    invariant:
      "A unit received damaged (`receive_damaged`, ruling 80) opens one out-of-service record per step: its id and number are the step's `receive_flag` movement's, its reason `damaged`, its units flagged where the receipt put them (away on an uncounted product), its sources the purchase and the inbound booking (never `bookings:`, which core reads as the outbound owner), its supplier the purchase's, with its default thread. `receive_damaged_undo` cancels the row's open records newest first, whole (or the one `uid_out_of_service` names), and re-opens what it did not undo on a new record under the remainder sub-session, inheriting the oldest consumed record's details and shelf, as the outbound loss undo does (api-cloudrun#1218); a record with resolved units, or one no receipt of this row opened, is a 400.",
    enforced_by: [RECEIVE_DAMAGED_RECORD],
    transaction: "update-inbound-booking",
    fields: [
      { source: ["breakdown", "damaged"], target: ["breakdown", "flagged"], transform: "the step's quantity; `away` on an uncounted product" },
      { source: ["units", "damaged"], target: ["units", "flagged"], transform: "serialized only: the step's named units" },
      {
        source: [],
        target: ["sources"],
        transform: "[{collection:'purchases', uid, label: 'PO-' + number}, {collection:'bookings-inbound', uid: booking.uid, label}]",
      },
    ],
  },
];

/** The custody projection's steps, as its firing transactions name them. */
const PURCHASE_CUSTODY_STEPS = [
  "purchase-custody:purchase-to-receipt",
  "purchase-custody:receipt-to-inbound-bookings",
  "purchase-custody:inbound-bookings-to-purchase",
] as const;

const purchaseCardRules: CollectionRule[] = [
  {
    id: "purchase-card:purchases-to-card",
    source: "purchases",
    target: "cards",
    mode: "co-write",
    invariant:
      "Every purchase holding a SUBRENT item has exactly one \"return to supplier\" card, id `derivedDocId(\"purchase-return-card:\" + uid)`, written in the SAME commit as every write of the purchase that could move it (create, update, close, and every custody step on its inbound bookings) and never by a client. Its status, action and date are derived from its subrent rows' custody (the journal, C8) by `computeCardStatusFromPurchase` / `computeCardActionFromPurchase` / `purchaseCardDue` (@cfs/core/utils/cards); its kind is the `purchases` source PAYLOAD (`isPurchaseCard`), not the bare source, so a hand-authored to-do that links a PO is never taken over. A purchase with no subrent item has no card.",
    enforced_by: [PURCHASE_CARD_TABLE, PURCHASE_CARD_SHAPE],
    fields: [
      { source: ["status"], target: ["status"], transform: "computeCardStatusFromPurchase(purchase, card.status)" },
      { source: ["items", "quantity"], target: ["status"], transform: "see status — received > returned on any row is `active`; complete once every row received its quantity and returned it (row custody from the journal, C8)" },
      { source: ["items", "path"], target: ["action"], transform: "computeCardActionFromPurchase — return_to_supplier while any row has units in custody" },
      { source: ["destinations", "dates", "collection_end"], target: ["dates", "start"], transform: "purchaseCardDue — the earliest due-back among open lines, read off each line's pair" },
      { source: ["number"], target: ["purchases", "number"] },
      { source: ["supplier"], target: ["purchases", "supplier"] },
      { source: ["uid"], target: ["sources"], transform: "[{ collection: \"purchases\", uid }]" },
    ],
  },
];

/** The bill co-write, asserted on a pushed bill billed in two parts. */
const BILL_MOVES_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBills.test.ts::push — two bills move quantity_billed and each line costs its cumulative share",
  clause:
    "each bill recounts its purchase lines' quantity_billed in the same commit; each line is priced at its cumulative share, so the bills of a fully billed line sum to its amount_cents exactly",
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

/** The pair-date follow on a bill — the invoice's rule, in the order's date shape (api-cloudrun#1469). */
const BILL_PAIR_DATES_FOLLOW: EnforcementRef = {
  kind: "test",
  ref:
    "core/tests/purchase-documents.test.ts::syncPurchaseToBills: a bill whose one window equals its hire FOLLOWS a hire move; an edited window stays (api-cloudrun#1469)",
  clause:
    "a purchase hire move reaches a bill pair per field: its possession bounds follow while the bill never overrode them, its single window follows when it equalled the purchase's previous window or the bill's own hire (`followPossession`), an edited window stays, and the day counts are recomputed",
  gates: true,
};

/** The purchase → bill merge semantics — pure, in `@cfs/core/utils/purchase-documents`. */
const PURCHASE_BILL_SYNC_SEMANTICS: EnforcementRef = {
  kind: "test",
  ref: "core/tests/purchase-documents.test.ts::syncPurchaseToBills",
  clause:
    "the three-way policy per field: a pushed, live, unsettled bill line takes the purchase line's new value of each shared field read off the two schemas (`purchaseBillSharedLineFields`) unless the bill's differs from the PREVIOUS purchase's; a line's quantity, amount_cents and dates are homonyms and the bill's `units` are bill-only, so line quantities never move; a followed discount lands as the bill line's share of it, and a changed bill is re-priced whole by `priceDocument`'s stated-total arm; a linked, frozen or voided bill is skipped whole. The bill's PAIR dates merge per field as an invoice's do: a bill whose single charge window still equals its hire follows a purchase hire move, and a bill whose window was edited keeps it (api-cloudrun#1469). Does NOT cover the writer's point-get of `query_by_bills` or the post-commit Xero edit push.",
  gates: true,
};

const updatePurchaseBillRules: CollectionRule[] = [
  {
    id: "update-purchase:purchase-to-bills",
    source: "purchases",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "A pushed, unsettled bill stays in step with its purchase: each line follows the purchase line it projects on every shared field the bill has not overridden (D5, the order → invoice rule). Its pairs follow the same way, AS AN INVOICE'S DO (api-cloudrun#1469, reversing \"never follow\"): a hire move reaches a bill whose dates still equal the purchase's previous ones, and a bill whose single charge window still equals its own hire moves with it; a window the operator edited is what the SUPPLIER billed and stays. The bill's units and line quantities never follow. A linked bill is Xero's and is never written; a settled or voided one is frozen.",
    enforced_by: [PURCHASE_BILL_SYNC_SEMANTICS, BILL_PAIR_DATES_FOLLOW],
    transaction: "update-purchase",
    trigger:
      "an item's name, description, type, price (formula, rates, discount), ledger_account, uid_tracking_category, tax class or attribution changes on the purchase, or a pair's dates do — targets every bill in `query_by_bills` that is pushed (or linked and just compared equal with Xero), has no money settlement and is not voided",
    fields: [
      {
        source: ["items"],
        target: ["items"],
        transform:
          "match each bill line to its purchase line by its path under the purchase's `purchase` divider (or its `path_purchase_item` move pointer) — the order → invoice sync's own engine (`syncScopedDestinations` with `payableScopedSync`); mergeSharedFields(prev purchase line, next purchase line, bill line) over the classification of (PurchaseSchema, PurchaseBillSchema), each purchase line first projected to the bill line's shape at the bill line's quantity (`projectPurchaseLineForBill`), so its discount is that quantity's share. A line keeps its net amount (a homonym); the changed bill is then priced by `priceDocument` (payable arm), whose stated-total arm states each line's money from that amount and its discount.",
      },
      {
        source: ["items"],
        target: ["totals"],
        transform: "total_cents = Σ line money (`priceDocument`, payable arm); amount_due_cents moves with it",
      },
      {
        source: ["destinations", "dates"],
        target: ["destinations", "dates"],
        transform:
          "per field within the purchase's scope, matched by pair.uid (`syncScopedDestinations` with `PAYABLE_PAIR_SIDE`, the invoice's `mergePairOn`): mergeSharedFields over the four bounds and `charge_windows`, then `resolveMergedPairDates` — `followPossession` moves a single window that equalled the bill's own possession, and `canonicalChargeWindows` recounts `days_active` and each window's days",
      },
    ],
  },
];

const createPurchaseBillRules: CollectionRule[] = [
  {
    id: "create-purchase-bill:bill-to-purchase",
    source: "purchase-bills",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Every bill product line bills ONE purchase line: it sits at `[purchase uid, ...that line's path]` under the purchase's `purchase` divider and takes its uid (never joined by product: one product may sit on two lines), or names it by the move pointer `path_purchase_item`, and is defaulted from it by `projectPurchaseLineToBillLine` (`@cfs/core/utils/purchase-documents`). A FLAT line is counted by the recount (`purchase-billed:bills-to-purchase`) and priced at `flatShareCents(line.amount_cents, line.quantity, billed_before, billed_after)` — never a client input — so the bills of a fully billed line sum to its amount exactly. A TIME line is billed by counts: the bill writer seeds `remainingTimeCounts` (the pair's metered counts less what live bills already bill there) and `priceDocument` prices `rates × counts`. Billing past what was ordered is LEGAL and flagged by the purchase↔bill diff, never refused (D5, reversing #1396). The bill's uid is appended to the purchase's `query_by_bills` in the same commit. A LINKED bill's lines are projected the same way for attribution; its total is Xero's and is exempt.",
    enforced_by: [BILL_MOVES_THE_BUCKET],
    transaction: "create-purchase-bill",
    fields: [
      {
        source: ["uid"],
        target: ["query_by_bills"],
        transform:
          "appended (arrayUnion) so the purchase → bill sync can point-get every bill inside the purchase writer's transaction rather than range-read them; a void leaves it, because a voided bill is still the purchase's and liveness is read off the bill",
      },
      {
        source: ["query_by_purchases"],
        target: ["uid"],
        transform: "the bill names its purchases — its `purchase` dividers' uids (`deriveQueryByPurchases`)",
      },
      {
        source: ["items", "amount_cents"],
        target: ["items", "amount_cents"],
        transform:
          "flatShareCents(line.amount_cents, line.quantity, billed_before, billed_before + quantity) — read from the purchase line, never written to it",
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
    "a tracked ACCPAY that Xero reports VOIDED or DELETED retracts every live bill_payment, appends one bill_void for total_cents, folds the bill to amount_due_cents 0 and recounts each billed purchase line's quantity_billed without it, all in one commit; a redelivered void moves nothing",
  gates: true,
};

/** An operator void, asserted with its refusals. */
const BILL_VOIDED_FROM_CFS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBillSettlements.test.ts::void from CFS — a bill nothing settles voids in Xero and releases its lines; one with a live payment is refused",
  clause:
    "voiding a pushed bill from CFS voids the posted Xero bill, then appends one bill_void for total_cents, stamps voided_at, folds the bill to amount_due_cents 0 and recounts each billed purchase line's quantity_billed without it, in one commit; a bill purchaseBillVoidRefusal refuses is refused before Xero is called",
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

const voidPurchaseBillRules: CollectionRule[] = [
  {
    id: "void-purchase-bill:void-to-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    invariant:
      "An operator's void appends ONE `bill_void` for the bill's `total_cents`, so its due is derived as 0 rather than assigned. There is nothing to retract: a bill any payment or allocation has settled is refused (`purchaseBillVoidRefusal`). The row is keyed as the Xero void's is (`nextBillVoidSettlementId`), so the webhook that follows the Xero void finds it and moves nothing.",
    enforced_by: [BILL_VOIDED_FROM_CFS],
    transaction: "void-purchase-bill",
    fields: [
      {
        source: ["totals", "total_cents"],
        target: ["amount_cents"],
        transform: "the bill_void row annuls the whole bill",
      },
    ],
  },
  {
    id: "void-purchase-bill:settlements-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "The voided bill's `totals` are its journal folded: `amount_void_cents === total_cents`, everything else 0, in the commit that wrote the row.",
    enforced_by: [BILL_VOIDED_FROM_CFS],
    transaction: "void-purchase-bill",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_void_cents"],
        transform: "the bill_void row, by fold",
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
];

/** The credit co-write, asserted on a pushed credit un-billing part of a line. */
const CREDIT_UNBILLS_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCredits.test.ts::push — a credit un-bills its items at their cumulative share",
  clause:
    "each credit recounts its purchase lines' quantity_billed in the same commit; a pushed credit line naming no bill line is priced from the line's billed pool (`purchaseLineCreditCents`: a share of what live bills net of live credits hold, or a stated amount, capped at the pool), and one naming a bill line first-come from that line's own money (`billLineCreditCents`), so a bill and the credit of all its units sum to zero; un-billing past quantity_billed is refused",
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

/** The $0 bill closure folds as a count, reversibly. */
const BILL_CLOSURE_FOLD: EnforcementRef = {
  kind: "test",
  ref: "core/tests/purchases.test.ts::a $0 bill closes and reopens as a count",
  clause: "a `bill_closure` row folds +1 into closure_count, its reversal −1, and the status follows the derivation",
  gates: true,
};

const closePurchaseBillRules: CollectionRule[] = [
  {
    id: "close-purchase-bill:closure-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "An operator closes a $0 bill by appending a `bill_closure` row, the twin of an invoice's `closure`: it moves no money, so the bill reads `paid` only through `closure_count`. Xero marks every $0 document PAID on issue, so Xero's verdict never decides this.",
    enforced_by: [BILL_CLOSURE_FOLD],
    transaction: "close-purchase-bill",
    fields: [
      { source: [], target: ["totals", "closure_count"], transform: "+1 — the contract multiplier folded through `counts_into`" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals — `issued` → `paid`" },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
  {
    id: "reopen-purchase-bill:reversal-to-bill",
    source: "settlements",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "Reopening a closed $0 bill appends a `bill_closure_reversal`: `closure_count` is a fold rather than a latch, so the bill reads `issued` and unfreezes with no stored flag.",
    enforced_by: [BILL_CLOSURE_FOLD],
    transaction: "reopen-purchase-bill",
    fields: [
      { source: [], target: ["totals", "closure_count"], transform: "−1 — the contract multiplier folded through `counts_into`" },
      { source: [], target: ["status"], transform: "deriveInvoiceStatus over the folded totals — `paid` → `issued`" },
      { source: [], target: ["version"], transform: "+1" },
    ],
  },
];

const createPurchaseCreditRules: CollectionRule[] = [
  {
    id: "create-purchase-credit:credit-to-purchase",
    source: "purchase-credits",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Every credit line UN-bills some quantity of ONE purchase line — the line at its path under the purchase's `purchase` divider, or its `path_purchase_item` move pointer; the recount (`purchase-billed:credits-to-purchase`) lowers the count. Un-billing past `quantity_billed` is refused. A PUSHED credit line is priced at `flatShareCents(line.amount_cents, line.quantity, billed_after, billed_before)` — the share of the range it un-bills — so a bill and a credit of all its units net to zero. A LINKED credit's lines are priced the same way for attribution; its total is Xero's.",
    enforced_by: [CREDIT_UNBILLS_THE_BUCKET],
    transaction: "create-purchase-credit",
    fields: [
      {
        source: ["query_by_sources"],
        target: ["uid"],
        transform: "the credit names its purchase",
      },
    ],
  },
];

const closePurchaseRules: CollectionRule[] = [
  {
    id: "close-purchase:purchase-to-bills",
    source: "purchases",
    target: "purchase-bills",
    mode: "co-write",
    invariant:
      "A close is a quantity edit, so it reaches the purchase's bills by the same three-way rule as any purchase edit: an untouched line on a pushed, unsettled bill follows the lowered quantity and amount, and is removed when the line is canceled to 0 unless that would leave the bill with no lines. An edited, linked, settled or void bill keeps its line, and the diff reports it.",
    enforced_by: [PURCHASE_BILL_SYNC_SEMANTICS],
    transaction: "close-purchase",
    fields: [
      {
        source: ["items"],
        target: ["items"],
        transform: "the order → invoice sync's own engine (`syncScopedDestinations`), run on the closed purchase",
      },
      {
        source: ["items"],
        target: ["totals"],
        transform: "total_cents = Σ line money (`priceDocument`, payable arm); amount_due_cents moves with it",
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
      "The credit's `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal`, written in the allocation's commit, and its status re-derives (`applied` at 0). Its `version` is bumped.",
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
      "The credit's `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal`, written in the reversal's commit, and its status re-derives (an `applied` credit with balance again is `issued`). Its `version` is bumped.",
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
    "Every supplier credit whose `bill_credit` rows this commit appends, reverses or stamps is refolded in the SAME commit: `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal`, its status re-derives and its `version` is bumped — so a credit's balance never trails its journal, whichever writer moved it.",
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
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::void from Xero — a voided credit reaps its draws, refolds its bills and re-bills its purchase items",
  clause:
    "a tracked supplier credit Xero reports VOIDED or DELETED becomes void; every live row drawing on it is reversed (source_retracted), each bill those rows credited is refolded in the same commit, and each purchase line's quantity_billed is recounted without the credit; a redelivery writes nothing",
  gates: true,
};

/** An operator void, asserted with its refusal. */
const CREDIT_VOIDED_FROM_CFS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::void from CFS — a credit nothing draws on voids in Xero and re-bills; one with a live allocation is refused",
  clause:
    "voiding a supplier credit from CFS voids the posted Xero credit note, then marks the credit void and recounts its purchase lines' quantity_billed in one commit; a credit with any live allocation or refund is refused before Xero is called; a void that re-bills units the purchase has since canceled is legal and over-bills the line (D5)",
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
      "The credit's `remaining_credit_cents` is its journal folded by `creditRemainingFromJournal` in the commit that wrote the rows, its status re-derives (`applied` at 0) and its `version` is bumped. The journal is read outside and the commit refuses when the credit's version moved, so every writer of a credit's rows bumps its version.",
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
];

/** The recount itself, against hand-stated counts. */
const BILLED_RECOUNT: EnforcementRef = {
  kind: "test",
  ref: "core/tests/purchase-documents.test.ts::recomputePurchaseQuantityBilled: live bills net of live credits, floored at 0",
  clause:
    "a flat line's count is Σ live bill line quantities − Σ live credit line quantities joined on the full path, floored at 0, through an edited quantity, a void, a $0 void and a voided credit; a time line stays null. Does NOT cover the writer reading the complete set inside its transaction.",
  gates: true,
};

// ── Discovery mirrors on the purchase (6e-0a) ───────────────────────

const purchaseMirrorRules: CollectionRule[] = [
  {
    id: "update-purchase-bill:status-to-purchases",
    source: "purchase-bills",
    target: "purchases",
    mode: "co-write",
    invariant:
      "Every purchase a bill bills (`query_by_purchases`) carries it in `bills[]`, whose uids are exactly `query_by_bills`, and the entry's number and status CONVERGE on the bill. CONVERGENT, not co-written: the writer that moves a bill's status (create, settle, void, close, reopen, a credit allocation, the Xero webhook) converges each purchase by compare-and-set after its own commit, unconditionally and gated on disagreement, and the `purchase-bills` eventarc backstop repairs whatever it missed. The twin of `update-invoice:status-to-orders`. A void bill stays listed at `void`.",
    enforced_by: [DOC_REF_MERGE, DOC_REF_AUDIT],
    trigger: "any bill write that moves its status — targets the purchases in its `query_by_purchases`",
    fields: [
      { source: ["status"], target: ["bills", "status"], transform: "upsertDocRef — added when absent, rewritten when it disagrees, never removed" },
      { source: ["number"], target: ["bills", "number"], transform: "converged by the same merge" },
      { source: [], target: ["version"], transform: "HELD, as the invoice mirror holds the order's" },
    ],
  },
  {
    id: "update-purchase-credit:status-to-purchases",
    source: "purchase-credits",
    target: "purchases",
    mode: "co-write",
    invariant:
      "The purchase a supplier credit is raised on (its first `sources` entry) carries it in `credits[]` and `query_by_credits`, and the entry's number and status CONVERGE on the credit — the twin of `update-credit-note:note-to-orders`. CONVERGENT: converged by compare-and-set after the writer's own commit, with the `purchase-credits` eventarc backstop. A void credit stays listed at `void`.",
    enforced_by: [DOC_REF_MERGE, DOC_REF_AUDIT],
    trigger: "any supplier-credit write — targets the purchase it was raised on",
    fields: [
      { source: ["uid"], target: ["query_by_credits"], transform: "added when absent; never removed" },
      { source: ["status"], target: ["credits", "status"], transform: "upsertDocRef — added when absent, rewritten when it disagrees" },
      { source: ["number"], target: ["credits", "number"], transform: "converged by the same merge" },
      { source: [], target: ["version"], transform: "HELD" },
    ],
  },
];

const purchaseBilledRules: CollectionRule[] = [
  {
    id: "purchase-billed:bills-to-purchase",
    source: "purchase-bills",
    target: "purchases",
    mode: "co-write",
    invariant:
      "A FLAT purchase line's `quantity_billed` is recounted from the purchase's live documents (`recomputePurchaseQuantityBilled`): Σ live bill line quantities − Σ live credit line quantities, joined on the full purchase line key (`purchaseLineKeyOf`: a line's path under its purchase divider, or its move pointer), floored at 0, written in the same commit as the bill or credit that moved it. So a bill line's quantity edit moves the count (5→3 frees 2 units; 5→8 reads over-billed, which the purchase ↔ bill diff flags), and a void releases what the bill says NOW, not what it said when it was created. A voided bill stays in `query_by_bills` and stops counting. A later bill of the same units is priced at its cumulative share of the new range, so the live bills of a line can sum to its amount ±1¢. A TIME line counts nothing: `quantity_billed` stays null.",
    enforced_by: [BILLED_RECOUNT, BILL_MOVES_THE_BUCKET, BILL_VOIDED, BILL_VOIDED_FROM_CFS],
    fields: [
      {
        source: ["items", "quantity"],
        target: ["items", "quantity_billed"],
        transform: "Σ over the live bills, on the purchase line each bill line bills (`purchaseLineKeyOf`: its path under the purchase divider, or its move pointer)",
      },
      {
        source: ["voided_at"],
        target: ["items", "quantity_billed"],
        transform: "a voided bill counts nothing (`purchaseBillIsLive`)",
      },
    ],
  },
  {
    id: "purchase-billed:credits-to-purchase",
    source: "purchase-credits",
    target: "purchases",
    mode: "co-write",
    invariant:
      "The other half of the recount: every live credit line is subtracted from the purchase line it credits (`purchaseLineKeyOf`), and a voided credit stops being subtracted, so its units read billed again. Voiding a credit from Xero is never refused and is uncapped: a void that re-bills units the purchase has since CANCELED (a short close's credit, voided in Xero) over-bills the line, which is legal and flagged by the purchase ↔ bill diff (D5), never trimmed. An operator void is refused only while a row draws on the credit, since Xero refuses to void a note with an allocation or a payment. A credit left with no live bill under it floors the count at 0, and the diff shows the unfloored number.",
    enforced_by: [BILLED_RECOUNT, CREDIT_UNBILLS_THE_BUCKET, CREDIT_VOIDED_FROM_XERO, CREDIT_VOIDED_FROM_CFS],
    fields: [
      {
        source: ["items", "quantity"],
        target: ["items", "quantity_billed"],
        transform: "− Σ over the live credits, on the purchase line each credit line credits (`purchaseLineKeyOf`)",
      },
      {
        source: ["status"],
        target: ["items", "quantity_billed"],
        transform: "a void credit counts nothing (`purchaseCreditIsLive`)",
      },
    ],
  },
];

/**
 * The recount as its firing transactions name it. `STOCK_STEPS`'s shape, and
 * file-local because no other module fires it. Billing holds no purchase open
 * (ruling 61), so a recount writes no status and the return card, which reads
 * custody, does not follow it (7a C7).
 */
const RECOUNT_STEPS = [
  "purchase-billed:bills-to-purchase",
  "purchase-billed:credits-to-purchase",
] as const;

const createPurchaseBillTransaction: TransactionDefinition = {
  id: "create-purchase-bill",
  description:
    "Bills a purchase: either PUSHES a new ACCPAY (`CFS-BILL-n`, posted by a post-commit task with read-before-create) or LINKS an existing Xero bill or card payment, read from Xero rather than the caller. The bill recounts its purchase lines' `quantity_billed` in the same transaction. A linked card payment is born paid, and a linked ACCPAY carries the payments Xero already reports, as `bill_payment` settlement rows in the same transaction — fires on: a link whose Xero document holds any payment.",
  steps: [
    "create-purchase-bill:bill-to-purchase",
    "create-purchase-bill:bill-to-settlements",
    "cowrite-thread:purchase-bills-to-thread",
    "cowrite-thread:thread-to-purchase-bills",
    ...RECOUNT_STEPS,
    "update-purchase-bill:status-to-purchases",
  ],
};

const updatePurchaseBillTransaction: TransactionDefinition = {
  id: "update-purchase-bill",
  description:
    "Edits a PUSHED, unsettled bill (`PUT /purchase-bills/{uid}`, D5): any line's shared field may be overridden until the bill settles, exactly the invoice rule; the writer re-prices the edited bill with `priceDocument` (payable arm), whose stated-total arm states each line's money from its amount and discount. Refused on a linked bill (Xero is authoritative) and, per field class, on a frozen one (`PURCHASE_BILL_FIELD_FREEZE`). The accepted edit is pushed to Xero after the commit by the ACCPAY edit push — GET-modify-POST against Xero's own InvoiceID, hash-gated so an unchanged body pushes nothing. Editing a flat line's quantity recounts the purchase's `quantity_billed` and bumps its version in the same commit — fires on: an edit that moves a line's count.",
  steps: [...RECOUNT_STEPS],
};

const settlePurchaseBillTransaction: TransactionDefinition = {
  id: "settle-purchase-bill",
  description:
    "Reconciles the payments Xero reports on a tracked ACCPAY into the bill's journal — appends a `bill_payment` for each one CFS has not recorded and reaps one Xero no longer lists — and folds the bill's totals in the same commit. Run by the Xero INVOICE webhook (an ACCPAY resolves `purchase-bills` by `xero_id`, never a CFS invoice) and by the daily open-bill sweep. One-directional: it never writes to Xero. Fires on: a payment added or removed in Xero.",
  steps: [
    "settle-purchase-bill:xero-to-settlements",
    "settle-purchase-bill:settlements-to-bill",
    "settle-purchase-bill:settlements-to-credit",
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

const voidPurchaseBillTransaction: TransactionDefinition = {
  id: "void-purchase-bill",
  description:
    "An operator voids a pushed bill nothing has settled: a bill Xero holds is voided there first, then one commit appends one `bill_void` for its total, stamps `voided_at`, folds the bill to nothing due and recounts its purchase lines. A bill with no `xero_id` is voided in CFS alone, and its push then posts nothing. If the commit loses a race after Xero voided, the webhook's `void-purchase-bill-from-xero` finishes it. Refused by `purchaseBillVoidRefusal`, before Xero is called. A void Xero throttles changes nothing and re-runs from a task. Fires on: every void that is not a replay.",
  steps: [
    "void-purchase-bill:void-to-settlements",
    "void-purchase-bill:settlements-to-bill",
    ...RECOUNT_STEPS,
    "update-purchase-bill:status-to-purchases",
  ],
};

const closePurchaseBillTransaction: TransactionDefinition = {
  id: "close-purchase-bill",
  description: "Mark Paid on a $0 bill: appends a `bill_closure` row and folds `closure_count` and the status onto the bill.",
  steps: ["close-purchase-bill:closure-to-bill", "update-purchase-bill:status-to-purchases"],
};

const reopenPurchaseBillTransaction: TransactionDefinition = {
  id: "reopen-purchase-bill",
  description: "Undoes Mark Paid on a $0 bill: appends a `bill_closure_reversal` row and folds `closure_count` and the status onto the bill.",
  steps: ["reopen-purchase-bill:reversal-to-bill", "update-purchase-bill:status-to-purchases"],
};

const voidPurchaseBillFromXeroTransaction: TransactionDefinition = {
  id: "void-purchase-bill-from-xero",
  description:
    "Mirrors a bill Xero reports VOIDED or DELETED: retracts its live payments, appends one `bill_void` for its total, stamps `voided_at`, folds the bill to nothing due and recounts its purchase lines' `quantity_billed`, in one commit. The `markInvoiceVoidedFromXero` twin. Never writes to Xero. Fires on: the first webhook that sees the bill void.",
  steps: [
    "void-purchase-bill-from-xero:void-to-settlements",
    "void-purchase-bill-from-xero:settlements-to-bill",
    "void-purchase-bill-from-xero:settlements-to-credit",
    ...RECOUNT_STEPS,
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

const createPurchaseCreditTransaction: TransactionDefinition = {
  id: "create-purchase-credit",
  description:
    "Records a supplier credit against a purchase: either PUSHES a new ACCPAYCREDIT (`CFS-SCR-n`, posted by a post-commit task with read-before-create) or LINKS one entered in Xero, read from Xero rather than the caller. Each credit line un-bills its purchase line, and `quantity_billed` is recounted in the same transaction. The credit is written holding its whole total; allocations are their own writes — a linked credit's existing Xero allocations arrive through the bills they name.",
  steps: [
    "create-purchase-credit:credit-to-purchase",
    "cowrite-thread:purchase-credits-to-thread",
    "cowrite-thread:thread-to-purchase-credits",
    ...RECOUNT_STEPS,
    "update-purchase-credit:status-to-purchases",
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
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
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
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

const settlePurchaseCreditTransaction: TransactionDefinition = {
  id: "settle-purchase-credit",
  description:
    "Reconciles the cash refunds Xero reports on a tracked supplier credit (its `Payments[]`, `APCREDITPAYMENT`) into the credit's journal — appends a `supplier_refund` for each one CFS has not recorded and reaps one Xero no longer lists — and refolds the credit in the same commit. Run by the Xero CREDITNOTE webhook (an ACCPAYCREDIT resolves `purchase-credits` by `xero_id`) and by a link of a credit Xero already shows refunded. One-directional: it never writes to Xero. Fires on: a refund added or removed in Xero.",
  steps: ["settle-purchase-credit:xero-to-settlements", "settle-purchase-credit:settlements-to-credit", "update-purchase-credit:status-to-purchases"],
};

const voidPurchaseCreditTransaction: TransactionDefinition = {
  id: "void-purchase-credit",
  description:
    "An operator voids a supplier credit nothing draws on: the posted Xero credit note is voided first (`POST /CreditNotes/{id}` `Status: VOIDED`), then one commit marks the credit void and recounts its purchase lines. A pushed credit not yet posted is voided in CFS alone, and its push then posts nothing. Fires on: every void that is not a replay.",
  steps: [...RECOUNT_STEPS, "update-purchase-credit:status-to-purchases"],
};

const voidPurchaseCreditFromXeroTransaction: TransactionDefinition = {
  id: "void-purchase-credit-from-xero",
  description:
    "Mirrors a supplier credit Xero reports VOIDED or DELETED: reverses every live row drawing on it, refolds the bills those rows credited, marks the credit void and recounts its purchase lines, in one commit conditioned on every document's version. Never writes to Xero. Fires on: the first webhook that sees the credit void.",
  steps: [
    "void-purchase-credit-from-xero:void-to-settlements",
    "void-purchase-credit-from-xero:settlements-to-bill",
    "void-purchase-credit-from-xero:settlements-to-credit",
    ...RECOUNT_STEPS,
    "update-purchase-bill:status-to-purchases",
    "update-purchase-credit:status-to-purchases",
  ],
};

const createPurchaseTransaction: TransactionDefinition = {
  id: "create-purchase",
  description:
    "Creates a purchase order: a supplier, a store, and items of any arm (buy, subrent, charge, replacement — one purchase may mix them, and one product may sit on two items), and cowrites its default thread. A purchase moves no stock and posts nothing to Xero; receipts and bills are their own writes. The document id is derived from the client's uuid_session, so a retried create lands on the same purchase. Every subrent and dated buy item is supply from this moment — a subrent over its hire window, a buy as inbound from its expected date — so the create bumps `stock-locks/{P}` and rebuilds `stock/{P}` via STOCK_STEPS. When it holds a SUBRENT item it also writes the purchase's return card, with its own default thread, as a card's first write does.",
  steps: [
    "cowrite-thread:purchases-to-thread",
    "cowrite-thread:thread-to-purchases",
    ...STOCK_STEPS,
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

const updatePurchaseTransaction: TransactionDefinition = {
  id: "update-purchase",
  description:
    "Amends a purchase's date, reference, notes or items, matched by item uid. On a BUY item the quantity may not fall below what is received or billed, and its amount may not change once it has any receipt or bill — a price that moved after goods arrived is a short close plus a new purchase, because every receipt already carries its share of the old price; the update fires STOCK_STEPS, since a buy item's pair's delivery_start and its unreceived quantity are inbound supply. On a SUBRENT item a receipt carries no cost, so the amount and the hire end stay editable after receipt (a paid extension), and the update fires STOCK_STEPS and the return card, since the hire window is supply. An amend that adds a purchase's FIRST subrent item writes its return card in the same commit, with the card's own default thread, as a create does. Every pushed, unsettled bill named in `query_by_bills` is synced in the same commit (D5) — fires on: an item's shared field changing while such a bill exists — and each bill it changes is re-pushed to Xero after the commit by the ACCPAY edit push.",
  steps: [
    ...STOCK_STEPS,
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
    "update-purchase:purchase-to-bills",
  ],
};

const closePurchaseTransaction: TransactionDefinition = {
  id: "close-purchase",
  description:
    "Closes some or all of a purchase's lines — a close is a quantity edit (ruling 47): a buy or subrent line lowers its quantity to what its row received, a flat charge to what was billed, restating its money, and a line left with nothing is REMOVED (its inbound booking kept while it holds custody, deleted while it is plan only); a time charge ends its pair's charge window (ruling 63). A close that would leave no line is a CANCEL: the purchase reads canceled (authored, ruling 55), its lines stay as they stand, and every plan-only inbound booking goes — refused while any booking holds live custody (`inboundCancelRefusal`). The lowered lines reach the purchase's bills by the three-way sync. Raises no credit: billed beyond what was received is a diff entry.",
  steps: [
    "close-purchase:purchase-to-bills",
    ...STOCK_STEPS,
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
    ...RECOUNT_STEPS,
  ],
};

const updateInboundBookingTransaction: TransactionDefinition = {
  id: "update-inbound-booking",
  description:
    "The inbound lever (`PUT /purchase-receipts/{uid}/bookings`, ruling 75): operator custody steps on a purchase's inbound bookings — receive, put away, send back, a flag on arrival, and each one's undo. A flag on arrival opens an out-of-service record (ruling 80); its undo cancels it, re-opening any remainder. A settle is the out-of-service record's (`update-out-of-service-record:record-to-inbound-booking`), not this lever's. Each step writes its movement and folds it onto the ledger and the shelves through the one ledger writer, claiming `stock-locks/{P}`; then the purchase is finalized from its committed bookings. A receipt posts nothing to Xero. Fires on: every custody step on an inbound booking. The unit roster steps fire when a step names units.",
  steps: [
    "update-inbound-booking:booking-to-transactions",
    "update-inbound-booking:booking-to-out-of-service",
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    ...STOCK_STEPS,
    "units:transactions-to-roster",
    "units:transactions-to-units",
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
  ],
};

const finalizePurchaseTransaction: TransactionDefinition = {
  id: "finalize-purchase",
  description:
    "Recompute a purchase from its committed inbound bookings — the twin of `finalize-order`: `bookings_breakdown` and the custody-only status, the receipt projection, and the return card. Idempotent: re-running against unchanged bookings writes nothing. Runs in-request after an inbound lever write.",
  steps: [
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
  ],
};

/** Everything `propagation/purchases.ts` contributes to the catalog. */
export const purchases: PropagationModule = {
  rules: [
    ...purchaseMirrorRules,
    ...settleToInboundBookingRules,
    ...purchaseCardRules,
    ...purchaseCustodyRules,
    ...updateInboundBookingRules,
    ...updatePurchaseBillRules,
    ...createPurchaseBillRules,
    ...settlePurchaseBillRules,
    settlementsToCreditRule("settle-purchase-bill:settlements-to-credit", "settle-purchase-bill"),
    ...voidPurchaseBillRules,
    ...closePurchaseBillRules,
    ...voidPurchaseBillFromXeroRules,
    settlementsToCreditRule("void-purchase-bill-from-xero:settlements-to-credit", "void-purchase-bill-from-xero"),
    ...createPurchaseCreditRules,
    ...allocatePurchaseCreditRules,
    ...reversePurchaseCreditAllocationRules,
    ...closePurchaseRules,
    ...settlePurchaseCreditRules,
    ...voidPurchaseCreditFromXeroRules,
    ...purchaseBilledRules,
  ],
  transactions: [
    createPurchaseTransaction,
    updatePurchaseTransaction,
    closePurchaseTransaction,
    updateInboundBookingTransaction,
    finalizePurchaseTransaction,
    createPurchaseBillTransaction,
    updatePurchaseBillTransaction,
    settlePurchaseBillTransaction,
    voidPurchaseBillTransaction,
    closePurchaseBillTransaction,
    reopenPurchaseBillTransaction,
    voidPurchaseBillFromXeroTransaction,
    createPurchaseCreditTransaction,
    allocatePurchaseCreditTransaction,
    reversePurchaseCreditAllocationTransaction,
    settlePurchaseCreditTransaction,
    voidPurchaseCreditTransaction,
    voidPurchaseCreditFromXeroTransaction,
  ],
};
