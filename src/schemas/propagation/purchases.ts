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
 * `quantity_received` / `quantity_returned`), and what it has billed is the
 * billing fold over its bills and credits (ruling 42 retired `quantity_billed`;
 * see *Billing*). No co-written bucket is left.
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
 * A bill is its own document (`purchase-bills`). What a purchase line has
 * billed is DERIVED, never stored (ruling 42): the billing fold over the
 * purchase's live bills net of its live credits (`purchaseBillingFold`), floored
 * at 0 where a reader acts on it (`actedBilledUnits`), unfloored in the diff.
 * So a bill or credit write moves no count on the purchase; a void releases
 * what the bill says NOW, because the fold reads the bill as it stands. A bill
 * create still writes its purchase, appending `query_by_bills`
 * (`create-purchase-bill:bill-to-purchase`), so a writer can point-get every
 * bill; a credit converges `query_by_credits` after its commit
 * (`update-purchase-credit:status-to-purchases`).
 *
 * A card payment linked as a bill is BORN PAID: the same transaction appends its
 * one `payment` row and folds it, so its due is 0 from the first write. The
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

/**
 * The inbound swap rider (C16, rulings 81-83): receiving a `same_trip` exchange
 * line takes X back in the same request, bounded by its claims less the
 * take-back forwards already sourced to the exchange line's booking.
 */
const EXCHANGE_TAKE_BACK: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/purchases/receiptExchange.test.ts::receiving a same_trip exchange line sends one back and flags and settles one in one request",
  clause:
    "a `same_trip` exchange of 2 (1 `cleaning`, 1 `damaged`): receiving the exchange line writes a `subrent_out` for the cleaning unit and, for the damaged one, a standalone `flag` opening a record sourced to the purchase and X's inbound booking plus its `return_to_supplier` settle, every take-back movement naming the exchange line's booking in sources[]; a second partial receive takes nothing more",
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
      "A unit received damaged (`receive_damaged`, ruling 80) opens one out-of-service record per step: its id and number are the step's `receive_flag` movement's, its reason `damaged`, its units flagged where the receipt put them (away on an uncounted product), its sources the purchase and the inbound booking (never `bookings:`, which core reads as the outbound owner), its supplier the purchase's, with its default thread. `receive_damaged_undo` cancels the row's open records newest first, whole (or the one `uid_out_of_service` names), and re-opens what it did not undo on a new record under the remainder sub-session, inheriting the oldest consumed record's details and shelf, as the outbound loss undo does (api-cloudrun#1218); a record with resolved units, or one no receipt of this row opened, is a 400. " +
      "A `damaged` exchange TAKE-BACK (C16, rulings 81-83) is the second writer: received on a `same_trip` exchange line, it first settles X's units received damaged on their own records (no custody step, ruling 64), then flags X's clean `stocked` units in place on a NEW record (a standalone `flag`, sourced to the record and X's inbound booking, never a purchase) and settles that record (`return_to_supplier`, `stocked → damaged`) in the same commit, so no record is born terminal. Every take-back movement names the exchange line's inbound booking in sources[]; the record never does.",
    enforced_by: [RECEIVE_DAMAGED_RECORD, EXCHANGE_TAKE_BACK],
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

/** A receipt-authored exchange leg is one write (ruling 82), the fulfillment route's twin. */
const RECEIPT_EXCHANGE_LEG_IS_ATOMIC: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/purchases/receiptExchange.test.ts::POST /exchanges on a receipt stages the leg, its divider and its exchange line",
  clause:
    "one call stores the pair (with its `exchange` block and the parent's endpoints), the destination divider keyed on the pair uid and the exchange line under it carrying `exchanged_for`; a stale `version` is a 409",
  gates: true,
};

const createReceiptExchangeRules: CollectionRule[] = [
  {
    id: "create-receipt-exchange:leg-self",
    source: "purchase-receipts",
    target: "purchase-receipts",
    mode: "co-write",
    invariant:
      "A receiver-staged exchange on a subrent (ruling 82) is ONE write: the exchange pair, its destination divider and its exchange lines land together, with `version` bumped and the derived fields (`due_at`, the `query_by_*` arrays) re-derived from what is about to be stored. It is the one writer that adds a pair the receipt's purchase does not have, admissible because the exchange is a fact about what the supplier DID. The inbound bookings follow as an INPUT to `reconcileInboundBookings` (the receipt's stored-only pairs), converged best-effort after commit, as the fulfillment route's are.",
    enforced_by: [RECEIPT_EXCHANGE_LEG_IS_ATOMIC],
    transaction: "create-receipt-exchange",
    fields: [
      { source: ["destinations"], target: ["destinations"], transform: "the exchange pair appended" },
      { source: ["items"], target: ["items"], transform: "the leg's divider and exchange lines appended" },
      { source: ["version"], target: ["version"], transform: "incremented" },
      { source: [], target: ["query_by_dates"], transform: "recomputed from the merged destinations" },
      { source: [], target: ["query_by_contacts"], transform: "recomputed from the merged destinations" },
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

/** The bill create, asserted on a pushed bill billed in two parts. */
const BILL_MOVES_THE_BUCKET: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBills.test.ts::push — two bills each cost their cumulative share of the line",
  clause:
    "each bill line is priced at its cumulative share, starting where the billing fold over the purchase's other documents stands, so the bills of a fully billed line sum to its amount_cents exactly; the bill's uid is appended to query_by_bills in the same commit",
  gates: true,
};

/** The born-paid card bill, asserted on a linked SPEND. */
const CARD_BILL_BORN_PAID: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseBills.test.ts::link a card payment — the bill is born paid by one payment row",
  clause:
    "a linked bank_transaction bill appends exactly one payment row for its whole total in the same commit, keyed from the BankTransactionID, so amount_due_cents is 0 on the first write and a replay appends nothing",
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

/** The row-move re-point, asserted at the purchase writer (ruling 65a). */
const ROW_MOVE_REPOINT: EnforcementRef = {
  kind: "assertion",
  ref: "api-cloudrun/src/services/purchases.ts::updatePurchase",
  clause:
    "the writer pairs the stored and next lines (`purchaseRowMoves`, the order's `pairItemsAcrossRebuild`), refuses a touched row whose booking grain would change (`assertMovesKeepTheirGrain`), reads the purchase's whole journal as a claimed range, and re-points every movement naming a moved row to its new path in the same commit, each patch checked by `assertMovementPatch`; a bill or credit still billing a moved row where it stood (settled, linked, or any credit) refuses the move (`assertBillingFollowedMoves`)",
  gates: true,
};

const updatePurchaseBillRules: CollectionRule[] = [
  {
    id: "update-purchase:purchase-to-movement-paths",
    source: "purchases",
    target: "transactions",
    mode: "co-write",
    invariant:
      "A purchase row that MOVES within its booking grain (between groups of its pair; one-document-model ruling 65a, owner 2026-11-12) takes its movements with it: in the commit that moves the row, every movement whose `path_source_item` names the row's old path names its new one. `path_source_item` is a POINTER (`journal: \"annotation\"`), so the patch changes nothing a custody or ledger replay reads. A move that changes the grain (another pair, a component out of its kit) is refused while the row holds a receipt, a return or a bill; so is one a bill or credit that cannot follow (settled, linked and not cleared, or any credit) still bills where it stood.",
    enforced_by: [ROW_MOVE_REPOINT],
    transaction: "update-purchase",
    trigger: "a received, returned or billed purchase row's path changes within its pair",
    fields: [
      { source: ["items", "path"], target: ["path_source_item"], transform: "the row's new path, through the old → new map the writer pairs" },
    ],
  },
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
          "match each bill line to its purchase line by its path under the purchase's `purchase` divider (or its `path_source_item` move pointer) — the order → invoice sync's own engine (`syncScopedDestinations` with `payableScopedSync`); mergeSharedFields(prev purchase line, next purchase line, bill line) over the classification of (PurchaseSchema, PurchaseBillSchema), each purchase line first projected WHOLE to the bill row's shape, from unit 0 (`projectPurchaseRowForBill`); `quantity`, `amount_cents`, `price.stated_cents` and `out_of_service` merge as ONE `stated_total` group, so a partial bill keeps all four. The changed bill is then priced by `priceDocument` (payable arm), whose stated-total arm states each line's money from that amount and its discount.",
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
      "Every bill product line bills ONE purchase line: it sits at `[purchase uid, ...that line's path]` under the purchase's `purchase` divider and takes its uid (never joined by product: one product may sit on two lines), or names it by the move pointer `path_source_item`, and is defaulted from it by `projectPurchaseLineToBillLine` (`@cfs/core/utils/purchase-documents`). A FLAT line is priced at `lineUnitsCents(line, billed_before, billed_after)`, the one line-money function, where `billed_before` is what the billing fold over the purchase's other documents bills at the line (`actedBilledUnits`, ruling 42) — never a client input — so the bills of a fully billed line sum to its amount exactly. A TIME line is billed by counts, never-billed units first (`splitBillTime` over the purchase's account, clipped at the bill date): those units at the line's own path, metered over the bill's pair, and time owed on units earlier bills billed as an extension section (`billExtensionSections`, ruling 89); `priceDocument` prices `rates × counts`. Billing past what was ordered is LEGAL and flagged by the purchase↔bill diff, never refused (D5, reversing #1396). The bill's uid is appended to the purchase's `query_by_bills` in the same commit. A LINKED bill's lines are projected the same way for attribution; its total is Xero's and is exempt.",
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
          "lineUnitsCents(line, billed_before, billed_before + quantity) — the one line-money function over the purchase line, read from it, never written to it",
      },
    ],
  },
  {
    id: "create-purchase-bill:bill-to-settlements",
    source: "purchase-bills",
    target: "settlements",
    mode: "co-write",
    invariant:
      "A linked `bank_transaction` bill — a card payment, BORN PAID — appends exactly one `payment` row (reason `paid`, `xero_id` the SPEND's BankTransactionID, which is both the bill and its payment) for its whole total in the bill's commit, and the bill's totals are that row folded by `recomputeSettlementTotals('payable', …)`. A linked ACCPAY appends one `payment` row per payment Xero already reports. A pushed bill appends nothing: it is unpaid when written.",
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
        target: ["billing", "uid"],
        transform: "the row settles the bill (`billing.collection: \"purchase-bills\"`)",
      },
      {
        source: ["supplier", "uid"],
        target: ["uid_counterparty"],
        transform: "denormalized for per-supplier reporting",
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

/** A credit Xero reports VOIDED, asserted with a live allocation to reap. */
const CREDIT_VOIDED_FROM_XERO: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/purchases/purchaseCreditSettlements.test.ts::void from Xero — a voided credit reaps its draws, refolds its bills and re-bills its purchase items",
  clause:
    "a tracked supplier credit Xero reports VOIDED or DELETED becomes void; every live row drawing on it is reversed (source_retracted), each bill those rows credited is refolded in the same commit, and the billing fold stops subtracting the credit; a redelivery writes nothing",
  gates: true,
};

const voidPurchaseCreditFromXeroRules: CollectionRule[] = [
  {
    id: "void-purchase-credit-from-xero:void-to-settlements",
    source: "purchase-credits",
    target: "settlements",
    mode: "co-write",
    invariant:
      "A tracked supplier credit Xero reports VOIDED or DELETED retracts every live row drawing on it — its `credit` allocations and its `refund`s — each with its reverser (`source_retracted`). Xero removes a note's allocations and payments before it can be voided, so these are rows whose removal CFS had not seen yet. No void row is appended: a void credit strands its balance rather than consuming it, as an AR credit note does.",
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
      "Each bill whose `credit` row the void reverses is refolded in the same commit (`recomputeSettlementTotals('payable', …)`), so its `amount_credited_cents` falls and `amount_due_cents` rises by the reversed amount; its `version` is bumped. The commit is conditioned on each bill's version as read.",
    enforced_by: [CREDIT_VOIDED_FROM_XERO],
    transaction: "void-purchase-credit-from-xero",
    fields: [
      {
        source: ["amount_cents"],
        target: ["totals", "amount_credited_cents"],
        transform: "Σ live credit − credit_reversal, by fold",
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

// ── Discovery mirrors on the purchase (6e-0a) ───────────────────────

const purchaseMirrorRules: CollectionRule[] = [
  {
    id: "update-purchase-bill:status-to-purchases",
    source: "purchase-bills",
    target: "purchases",
    mode: "co-write",
    side: "payable",
    invariant:
      "Every purchase a bill bills (`query_by_purchases`) carries it in `bills[]`, whose uids are exactly `query_by_bills`, and the entry's number and status CONVERGE on the bill. CONVERGENT, not co-written: the writer that moves a bill's status (create, issue, settle, void, close, reopen, a credit allocation, the Xero webhook) converges each purchase by compare-and-set after its own commit, unconditionally and gated on disagreement, and the `purchase-bills` eventarc backstop repairs whatever it missed. The twin of `update-invoice:status-to-orders`. A void bill stays listed at `void`.",
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
    side: "payable",
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

const createPurchaseBillTransaction: TransactionDefinition = {
  id: "create-purchase-bill",
  description:
    "Bills one or more purchases (`POST /purchase-bills`, `query_by_purchases`): either creates a PUSHED bill, born `draft` with its number and NOTHING posted to Xero until it is issued (`update-purchase-bill`; rulings 41, 160), or LINKS an existing Xero bill or card payment, read from Xero rather than the caller. The bill's uid is appended to each of its purchases' `query_by_bills` in the same transaction; what a line has billed is the billing fold, so nothing is counted on the purchase (ruling 42). A linked card payment is born paid, and a linked ACCPAY carries the payments Xero already reports, as `payment` settlement rows in the same transaction — fires on: a link whose Xero document holds any payment.",
  steps: [
    "create-purchase-bill:bill-to-purchase",
    "create-purchase-bill:bill-to-settlements",
    "cowrite-thread:purchase-bills-to-thread",
    "cowrite-thread:thread-to-purchase-bills",
    "update-purchase-bill:status-to-purchases",
  ],
};

const updatePurchaseBillTransaction: TransactionDefinition = {
  id: "update-purchase-bill",
  description:
    "Edits a PUSHED, unsettled bill (`PUT /purchase-bills/{uid}`, D5), and ISSUES a draft one (`status: \"issued\"`, the invoice's twin, ruling 160), which enqueues its first Xero post and converges the bill's status onto its purchases — fires on: an issue. Any line's shared field may be overridden until the bill settles, exactly the invoice rule; the writer re-prices the edited bill with `priceDocument` (payable arm), whose stated-total arm states each line's money from its amount and discount. Refused on a linked bill (Xero is authoritative) and, per field class, on a frozen one (`PURCHASE_BILL_FIELD_FREEZE`). The accepted edit is pushed to Xero after the commit by the ACCPAY edit push — GET-modify-POST against Xero's own InvoiceID, hash-gated so an unchanged body pushes nothing. Editing a line's quantity moves what the billing fold bills at its purchase line, and nothing is written to the purchase (ruling 42).",
  steps: ["update-purchase-bill:status-to-purchases"],
};

const createPurchaseCreditTransaction: TransactionDefinition = {
  id: "create-purchase-credit",
  description:
    "Records a supplier credit against a purchase: either PUSHES a new ACCPAYCREDIT (`CFS-SCR-n`, posted by a post-commit task with read-before-create) or LINKS one entered in Xero, read from Xero rather than the caller. Each credit line UN-bills some quantity of ONE purchase line (its path under the purchase's `purchase` divider, or its `path_source_item` move pointer), which the billing fold subtracts (ruling 42); nothing is written to the purchase in the commit. Un-billing past what the fold bills at the line is refused. A PUSHED credit line is priced by the one line-money function over the range it un-bills, so a bill and a credit of all its units net to zero; a LINKED credit's total is Xero's. The credit is written holding its whole total; allocations are their own writes — a linked credit's existing Xero allocations arrive through the bills they name.",
  steps: [
    "cowrite-thread:purchase-credits-to-thread",
    "cowrite-thread:thread-to-purchase-credits",
    "update-purchase-credit:status-to-purchases",
  ],
};

const voidPurchaseCreditTransaction: TransactionDefinition = {
  id: "void-purchase-credit",
  description:
    "An operator voids a supplier credit nothing draws on: the posted Xero credit note is voided first (`POST /CreditNotes/{id}` `Status: VOIDED`), then one commit marks the credit void; the billing fold stops subtracting it. A pushed credit not yet posted is voided in CFS alone, and its push then posts nothing. Fires on: every void that is not a replay.",
  steps: ["update-purchase-credit:status-to-purchases"],
};

const voidPurchaseCreditFromXeroTransaction: TransactionDefinition = {
  id: "void-purchase-credit-from-xero",
  description:
    "Mirrors a supplier credit Xero reports VOIDED or DELETED: reverses every live row drawing on it, refolds the bills those rows credited, marks the credit void, in one commit conditioned on every document's version. Never writes to Xero. Fires on: the first webhook that sees the credit void.",
  steps: [
    "void-purchase-credit-from-xero:void-to-settlements",
    "void-purchase-credit-from-xero:settlements-to-bill",
    "void-purchase-credit-from-xero:settlements-to-credit",
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
    "update-purchase:purchase-to-movement-paths",
  ],
};

// ── extend-subrent / undo-extend-subrent (one-document-model ruling 57) ──
//
// POST /purchases/{uid}/extensions — CFS keeps some of a subrent leg's units
// past the supplier's collection. The twin of `extend-rental` on the inbound
// ladder: the units stay on the shelf, only the BOOKING holding them moves,
// because an inbound booking's window IS its leg's dates. So the write is a
// purchase edit (leg B, the kept quantity moved onto it, a flat line's money
// split and the extension charge added) plus a custody re-attribution an
// ordinary purchase edit never makes. Its own ids, so the drift check stays on;
// it reuses the `update-purchase` and `purchase-custody` rules the edit fires.

const SUBRENT_EXTENSION_TESTS = "api-cloudrun/tests/integration/purchases/subrentExtension.test.ts";

const SUBRENT_REBOOK_MOVES_CUSTODY: EnforcementRef = {
  kind: "test",
  ref: `${SUBRENT_EXTENSION_TESTS}::an extension moves stocked custody to leg B, not stock`,
  clause:
    "A's inbound booking falls by k `stocked` and B's holds `stocked: k`, the receipt keeps no row at quantity_ordered: 0, each row's received count follows its units, and supply holds the physical count",
  gates: true,
};

const SUBRENT_REBOOK_JOURNAL: EnforcementRef = {
  kind: "test",
  ref: `${SUBRENT_EXTENSION_TESTS}::one session holds subrent_rebook_out on A and subrent_rebook_in on B`,
  clause:
    "one subrent_rebook_out on A's booking naming A's row and one subrent_rebook_in on B's naming B's row per moved row, in one session, the out numbered first, the in naming A in sources[] under bookings-inbound",
  gates: true,
};

const SUBRENT_UNDO_ROUND_TRIP: EnforcementRef = {
  kind: "test",
  ref: `${SUBRENT_EXTENSION_TESTS}::extend then undo restores the purchase, its bookings and supply`,
  clause:
    "after an extension and its undo, A's inbound bookings hold the pre-extension stocked counts, B's bookings and pair are gone, and the purchase's rows and quantities equal the pre-extension purchase",
  gates: true,
};

const SUBRENT_CUSTODY_REPLAY: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-custody-replay.ts",
  clause:
    "every inbound booking's breakdown is the net of its journal, the subrent rebook pair included (`classifyInboundReplay`); every non-`ok` inbound verdict fails",
  gates: true,
};

const extendSubrentRules: CollectionRule[] = [
  {
    id: "extend-subrent:rebook-to-inbound-bookings",
    source: "purchases",
    target: "bookings-inbound",
    mode: "co-write",
    invariant:
      "For each inbound booking grain a moved row belongs to, A's booking gives up k units of `stocked` and leg B's (the same grain on the new leg) is created holding `stocked: k`. The rebook is applied to the purchase's stored-booking view and per-row custody BEFORE the floors, the receipt sync and the reconcile read them, so the receipt keeps no `quantity_ordered: 0` row, B's booking carries its units rather than ordering k fresh ones, and the row floors read each row's units where they now stand. k never exceeds A's `stocked` at that grain, and the receipt row must agree with the purchase row. On a serialized product the operator names the units, each in A's `units.stocked`.",
    enforced_by: [SUBRENT_REBOOK_MOVES_CUSTODY],
    transaction: "extend-subrent",
    fields: [
      { source: ["items", "quantity"], target: ["breakdown", "stocked"], transform: "A: stocked − k; B: stocked = k" },
      { source: ["destinations", "dates"], target: ["dates"], transform: "B's booking takes leg B's window: A's delivery, the extension's collection" },
    ],
  },
  {
    id: "extend-subrent:inbound-bookings-to-transactions",
    source: "bookings-inbound",
    target: "transactions",
    mode: "co-write",
    invariant:
      "The re-attribution is journaled per moved ROW as a pair in one session: `subrent_rebook_out` on A's booking (custody {stocked → null}, `path_source_item` A's row) and `subrent_rebook_in` on B's ({null → stocked}, B's row, `sources[]` naming A under `bookings-inbound` exactly once). No lines and no ledger effect: nothing moved physically. On a serialized product both halves name the units and the roster is folded in the purchase transaction. The out half takes the lower number.",
    enforced_by: [SUBRENT_REBOOK_JOURNAL, SUBRENT_CUSTODY_REPLAY],
    transaction: "extend-subrent",
    fields: [
      { source: ["uid"], target: ["uid_booking"] },
      { source: ["breakdown", "stocked"], target: ["quantity"], transform: "k, the units re-attributed" },
      { source: [], target: ["sources"], transform: "[{purchases}, {bookings-inbound: the other leg's}] on both halves" },
    ],
  },
  {
    id: "undo-extend-subrent:rebook-to-inbound-bookings",
    source: "purchases",
    target: "bookings-inbound",
    mode: "co-write",
    invariant:
      "For each inbound booking on leg B, its `stocked` (every unit it holds; nothing else may be non-zero) returns to leg A's booking at the same grain, which gains it or is re-created holding it, and B's falls to zero and is deleted by the reconcile as plan-only. Refused unless B is still exactly what the extension made (only `subrent_rebook_in` on its bookings, nothing sent back or settled since, no live bill billing B). A flat line's money merges back as the sum of A's and B's amounts, the extension charge included.",
    enforced_by: [SUBRENT_UNDO_ROUND_TRIP],
    transaction: "undo-extend-subrent",
    fields: [
      { source: ["items", "quantity"], target: ["breakdown", "stocked"], transform: "A: stocked + k; B: deleted" },
    ],
  },
  {
    id: "undo-extend-subrent:inbound-bookings-to-transactions",
    source: "bookings-inbound",
    target: "transactions",
    mode: "co-write",
    invariant:
      "The return is journaled as the reverse pair per row in one session: `subrent_rebook_out` on B's booking and `subrent_rebook_in` on A's, `sources[]` naming B under `bookings-inbound`. No lines and no ledger effect; on a serialized product both halves name the units.",
    enforced_by: [SUBRENT_UNDO_ROUND_TRIP, SUBRENT_CUSTODY_REPLAY],
    transaction: "undo-extend-subrent",
    fields: [
      { source: ["uid"], target: ["uid_booking"] },
      { source: ["breakdown", "stocked"], target: ["quantity"], transform: "k, the units returned to A" },
    ],
  },
];

const extendSubrentTransaction: TransactionDefinition = {
  id: "extend-subrent",
  description:
    "Extends part of a subrent leg (ruling 57): mints leg B (A's delivery, a new collection), moves the chosen rows' quantities from A to B, splits a flat line's amount at the partition and adds the extension charge, and re-attributes the kept units' custody from A's inbound bookings to B's with a `subrent_rebook_out`/`subrent_rebook_in` pair, all in the purchase write's one transaction. Otherwise runs the `update-purchase` cascade unchanged: the receipt, the inbound bookings and the status, supply via STOCK_STEPS, the return card and the bill sync.",
  steps: [
    "extend-subrent:rebook-to-inbound-bookings",
    "extend-subrent:inbound-bookings-to-transactions",
    "units:transactions-to-roster",
    ...STOCK_STEPS,
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
    "update-purchase:purchase-to-bills",
  ],
};

const undoExtendSubrentTransaction: TransactionDefinition = {
  id: "undo-extend-subrent",
  description:
    "Undoes a subrent extension: merges leg B's rows back onto leg A (core `mergeLegBack`, a flat line's amounts summed), deletes B, and re-attributes B's custody to A's inbound bookings with the reverse pair, in the purchase write's one transaction. Refused unless B is still exactly what the extension made. Otherwise runs the `update-purchase` cascade unchanged.",
  steps: [
    "undo-extend-subrent:rebook-to-inbound-bookings",
    "undo-extend-subrent:inbound-bookings-to-transactions",
    "units:transactions-to-roster",
    ...STOCK_STEPS,
    ...PURCHASE_CUSTODY_STEPS,
    "purchase-card:purchases-to-card",
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
  ],
};

const updateInboundBookingTransaction: TransactionDefinition = {
  id: "update-inbound-booking",
  description:
    "The inbound lever (`PUT /purchase-receipts/{uid}/bookings`, ruling 75): operator custody steps on a purchase's inbound bookings — receive, put away, send back, a flag on arrival, and each one's undo. A flag on arrival opens an out-of-service record (ruling 80); its undo cancels it, re-opening any remainder. A settle is the out-of-service record's (`update-out-of-service-record:record-to-inbound-booking`), and reaches this lever only as an exchange TAKE-BACK: receiving a `same_trip` exchange line takes X back in the same request (C16, rulings 81-83) — a `send_back` for a `cleaning`/`maintenance` entry, and for `damaged` a settle of X's units received damaged then a flag and settle of clean stock; on a serialized X the operator sends those actions, paired with the receive. Each step writes its movement and folds it onto the ledger and the shelves through the one ledger writer, claiming `stock-locks/{P}`; then the purchase is finalized from its committed bookings. A receipt posts nothing to Xero. Fires on: every custody step on an inbound booking. The unit roster steps fire when a step names units.",
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

const createReceiptExchangeTransaction: TransactionDefinition = {
  id: "create-receipt-exchange",
  description:
    "Stage a mid-hire EXCHANGE on a purchase receipt (`POST /purchase-receipts/{uid}/exchanges`, ruling 82), the twin of `create-fulfillment-exchange`: a destination pair carrying `exchange: { uid_pair, disposition }`, its divider, and the exchange line(s) under it naming — through `exchanged_for` — the subrent rows they go out against, each entry with its `reason`. Optimistic concurrency via `version`; writes the receipt only. A purchase has ONE card and an exchange leg never drives its due date, so no card step.\n\n" +
    "🔴 The inbound BOOKINGS that follow are not a step: the leg reaches `reconcileInboundBookings` as an INPUT (the receipt's stored-only pairs), converged best-effort after commit, so the next purchase write books it whether or not the converge wins. X is NOT touched here: for `same_trip` it moves when the exchange line is received (the inbound rider, `update-inbound-booking`); for `send_now` by an ordinary send-back later.",
  steps: ["create-receipt-exchange:leg-self"],
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
    ...createReceiptExchangeRules,
    ...updatePurchaseBillRules,
    ...extendSubrentRules,
    ...createPurchaseBillRules,
    ...closePurchaseRules,
    ...voidPurchaseCreditFromXeroRules,
  ],
  transactions: [
    createPurchaseTransaction,
    updatePurchaseTransaction,
    extendSubrentTransaction,
    undoExtendSubrentTransaction,
    closePurchaseTransaction,
    updateInboundBookingTransaction,
    createReceiptExchangeTransaction,
    finalizePurchaseTransaction,
    createPurchaseBillTransaction,
    updatePurchaseBillTransaction,
    createPurchaseCreditTransaction,
    voidPurchaseCreditTransaction,
    voidPurchaseCreditFromXeroTransaction,
  ],
};
