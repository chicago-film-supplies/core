/**
 * Order propagation rules — create-order and update-order transactions.
 *
 * Traced from: api-cloudrun/src/services/orders.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";
import { STOCK_STEPS } from "./stock.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// Shared because create-order and update-order assert the same things about the
// same edges. Each was opened and read; where the enforcement covers less than
// the string claims, the `clause` says so rather than the pointer implying
// coverage it does not have.

/**
 * "Denormalized org snapshot" and "computed server-side to prevent client
 * tampering" are the same mechanism seen from two ends: the INPUT schema has no
 * channel for either. `CreateOrderInput`/`UpdateOrderInput` accept
 * `organization: { uid }` and nothing else, and carry no `totals`, `number`,
 * `query_by_*` or `bookings_breakdown` key at all — and they are `z.object()`,
 * so a client that sends one has it stripped before the service runs.
 */
const ORDER_INPUT_HAS_NO_CHANNEL: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/order.ts::export const CreateOrderInput",
  clause:
    "the `server-side, not client-supplied` half — `CreateOrderInput` (anchored) and its update twin `UpdateOrderInput` expose no key for any derived value, so tampering is unrepresentable rather than rejected",
  gates: true,
};

/**
 * ⚠️ PARTIAL, and the gap is worth naming: the test asserts `uid` and `name`
 * refresh when the reference changes, and nothing asserts `crms_id`, `xero_id`
 * or `billing_address`. No corpus detector covers any of them either —
 * `audit-denorm-freshness.ts` holds twelve embedded-name rows and an
 * organizations→orders row is not one of them, though the table is exactly the
 * shape that would hold it.
 */
const ORG_SNAPSHOT_REFRESH: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/orders/orders.test.ts::PUT - updates organization on order",
  clause:
    "2 of the snapshot's 5 fields — `organization.uid` and `.name` are re-read when the reference changes. `crms_id`, `xero_id` and `billing_address` are asserted nowhere, and no corpus detector covers their freshness. Runs in `deno task test` (pre-push), not in CI. ⚠️ The line number this ref carried until 2026-08-18 sat in an unrelated step's request payload (`PUT - destination-only edit rebuilds bookings at new UID`) and resolved cleanly the whole time.",
  gates: true,
};

const ORDER_TOTALS_MATH: EnforcementRef = {
  kind: "test",
  ref: "core/tests/orders.test.ts::calculateOrderTotals",
  clause:
    "the `totals` half — seven `calculateOrderTotals` cases including the two-pass transaction fee off `subtotal_discounted`, over a `calculateItemSubtotal` verified against exact rational arithmetic on 300k random lines",
  gates: true,
};

/**
 * The order NUMBER half has its own suite, and it is the strong one: gap-free
 * and duplicate-free under overlapping creates, the counter read from the last
 * slot, no gap when a create throws after allocating, and a dry-run that
 * reports a number without advancing.
 */
const ORDER_NUMBER_COUNTER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/orders/orders.test.ts::overlapping creates are gap-free and duplicate-free",
  clause:
    "the `order number` half only — allocation is gap-free and duplicate-free under overlapping creates, and exactly one number is burned per committed order. Says nothing about totals or the query arrays. Three sibling steps in the same `Order number sequence` test carry the read position, the throw-after-allocation case and the dry-run.",
  gates: true,
};

/**
 * The one-booking-per-(product, destination) cardinality is not policed; it is
 * unrepresentable. `bookings.uid` IS the composite `{order}:{item}:{dest}`,
 * `BookingId` is a template-literal type over that shape, and
 * `assertValidForWrite` rejects any write whose `uid` differs from its doc id —
 * so a second booking for the same triple is the SAME document.
 */
const BOOKING_ID_IS_THE_CARDINALITY: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/_uid.ts::export const BookingId",
  clause:
    "the `one booking per consolidated product per destination` half — the doc id is the triple, so a duplicate is an overwrite rather than a second row",
  gates: true,
};

const BOOKING_DIFF_TESTS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/orders/orders.test.ts::PUT - canceling order deletes EVERY booking, incl. non-item-matched ones (#722)",
  clause:
    "the diff half, across four steps of `Orders CRUD` — the anchored one is cancel deleting EVERY booking including non-item-matched ones; `PUT - updates items and recalculates bookings`, `PUT - destination UID change deletes orphan bookings` and `PUT - destination-only edit rebuilds bookings at new UID` carry the rest",
  gates: true,
};

/**
 * The "and their stock projection zeroed" half, from the other side.
 *
 * ⚠️ Re-pointed at `audit-stock.ts` when the legacy pair was deleted, and the
 * CLAUSE changed with it rather than being translated. The old check was
 * `booking_stale_in_summary` — a summary still *naming* a booking that is no
 * longer live — and naming is exactly what the pre-reduced projection no longer
 * does: its entries are anonymous. The equivalent evidence is now the `extra`
 * side of the fold's multiset diff, which is what an un-zeroed orphan's leftover
 * interval shows up as.
 */
const ORPHAN_BOOKING_LEAVES_NO_STOCK_ENTRY: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock.ts::unavailable_stale",
  clause:
    "the `stock projection zeroed` half — invariant 4's `extra` side (`unavailable_stale`) fires on any `stock/{P}` carrying an interval the live bookings and OOS records do not account for, which is exactly what an un-zeroed orphan leaves behind",
  gates: true,
};

/**
 * ⚠️ NOT A GATE, and its own header says otherwise. `audit-unsourceable-bookings.ts`
 * opens with *"That makes this audit a gate, not a report"* and contains no
 * exit-code path at all — it prints its findings and returns 0. Measured on prod
 * 2026-07-28 before repair: 274 of 513 live bookings carried no allocated
 * location. So it is a diagnostic that reads as a guarantee.
 */
const BOOKING_ALLOCATION_DIAGNOSTIC: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-unsourceable-bookings.ts",
  clause:
    "reports bookings whose units cannot be traced to a shelf — but it has NO exit-code path, so it cannot fail, despite its own header calling itself a gate. Read the output; do not rely on the exit status.",
  gates: false,
};

/**
 * The fulfillment view's "stripped of …" clause is a schema fact, not a
 * behaviour: `FulfillmentSchema` is a strictObject with no `totals`,
 * `invoices`, `tax_profile`, `notes`, `crms_id` or `xero_id` key, and
 * `FULFILLMENT_LINE_ITEM_TYPES` omits `transaction_fee`, so a fee line fails
 * the discriminated union. A leak is a rejected write.
 */
const FULFILLMENT_SHAPE_STRIPS: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/fulfillment.ts::export const FulfillmentSchema",
  clause:
    "every `stripped` clause — the strictObject has no key for the financial fields and `FULFILLMENT_LINE_ITEM_TYPES` has no `transaction_fee` member, so both the field strip and the item drop are write rejections",
  gates: true,
};

const FULFILLMENT_STRIP_ASSERTED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/orders/orders.test.ts::POST - creates a quoted order with a rental item and generates bookings",
  clause:
    "the same strip, asserted positively on a real create — `totals`/`invoices`/`tax_profile`/`notes` absent from the projection and `price` absent from its line item. ⚠️ The line number this ref carried until 2026-08-18 sat in the PRECEDING step (`POST - creates a draft order with no items`), which asserts none of that.",
  gates: true,
};

/**
 * The card rebuild's semantics live in the reconciler, and its unit suite is
 * where they are actually decided — including every clause that reads as a
 * caveat: which statuses force onto the card and which do not, manual `blocked`
 * surviving a self-heal, and the sale/service exclusions on the end side.
 */
const EVENT_CARD_RECONCILE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/eventCardReconcile.test.ts",
  clause:
    "the rebuild's decision table — a reserved order emits start + end cards carrying `locked:['card']`; a draft order deletes all cards and their orphan threads; cards whose order lost every booking are deleted; stale status self-heals from bookings while a manual `blocked` survives it; a service line does not block end completion; and an unchanged upsert is SKIPPED rather than rewritten (#230). Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/** The preservation half, end-to-end against real Firestore. */
const EVENT_CARD_PRESERVED_ON_UPDATE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/orders/orders.test.ts::PUT - non-items update preserves event cards + their deterministic threads (#227)",
  clause:
    "the `preserves user-editable fields` half at its hardest case — a subject-only PUT leaves the booking rebuild EMPTY, and the cards and their deterministic threads must survive it rather than being torn down (#227). Does not cover the per-field preservation of body/attachments/assignees individually.",
  gates: true,
};

const OOS_COWRITTEN_FROM_BOOKING: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/bookings/bookings.test.ts::returns 1 + loses 1 + damages 1 → cowrites two OOS records and auto-completes order",
  clause:
    "the CREATE branch — one PUT returning 1, losing 1 and damaging 1 cowrites TWO OOS records, one per reason. The GROW branch (an existing non-complete record for the same (booking, reason) having its quantity raised by the delta) is not exercised.",
  gates: true,
};

/**
 * The journal's own detector, and the strongest thing pointed at in this file:
 * it folds each booking's events back through the same identity the writer
 * claims (`net[k] = Σ to − Σ from`) and diffs against the stored breakdown.
 * Independent by construction — the events are a different collection.
 */
const CUSTODY_REPLAY: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-custody-replay.ts",
  clause:
    "the `one movement per type per booking, idempotent under replay` half — every booking with a log is reproduced by folding it, over the five FULFILLMENT keys. `quoted`/`reserved` are deliberately out of scope (they follow order status, not a physical event). Exits 1 on any divergence.",
  gates: true,
};

/**
 * ⚠️ GATES ONLY UNDER `--strict`. `audit-ledger-replay.ts` computes
 * `failed = strict && findings.length > 0`, so a default run exits 0 while
 * printing findings — deliberately, because it carries a standing baseline of
 * 39 prod / 36 dev ledgers that have never reconciled. A pointer at the default
 * invocation is a pointer at something that cannot fail.
 */
const LEDGER_REPLAY: EnforcementRef = {
  kind: "audit",
  ref:
    "api-cloudrun/scripts/audit-ledger-replay.ts::const failed = strict && findings.length > 0",
  clause:
    "the `ledger is a fold over the journal` half — replays every product's movements through `applyMovementToLedger` into an empty ledger and diffs. Exits non-zero ONLY with `--strict`; the default run exits 0 against a standing baseline of 39 prod / 36 dev non-reconciling ledgers.",
  gates: false,
};

/**
 * The applier's own unit suite covers this invariant almost clause for clause —
 * including the two that read as caveats rather than behaviours (the store is
 * read from the location; a negative row warns and does not throw).
 */
const MOVEMENT_APPLIER: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/movementApplier.test.ts",
  clause:
    "the location-staging clauses — the product row moves by the line's signed quantity, staging never rewrites name/type/default, the store is READ from the location (#307), an unknown location throws rather than being created, stock may leave an inactive bin but never enter one, two lines on one location compose into ONE write, and a negative row warns without throwing. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const LEDGER_NON_NEGATIVE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/unit/movementApplier.test.ts::assertLedgerNonNegative rejects an oversell at every level",
  clause:
    "the `assertLedgerNonNegative` half ONLY — the assertion itself rejects a negative at all four levels (held, in-service, per-store, per-location). ⚠️ **`runs on the FINAL state` is NOT covered by it**: that an intermediate leg may dip without tripping the check is a property of the CALL SITE (`api-cloudrun/src/services/bookings.ts`, the loop over `ctx.ledgersTouched` after every `applyBookingUpdate` in the chunk), and no test asserts a sequence whose intermediate ledger goes negative.",
  gates: true,
};

const CARD_STATUS_MATH: EnforcementRef = {
  kind: "test",
  ref: "core/tests/cards.test.ts",
  clause:
    "the status + action arithmetic, exhaustively — both sides' thresholds, `blocked`/`canceled` preservation, and every exclusion the string names (sale-only destinations, service and surcharge lines) as its own case. Does NOT cover the sibling QUERY that feeds it, only the function applied to the siblings.",
  gates: true,
};

const ORDER_ROLLUP_DELTA: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/bookings/bookings.test.ts::returns 1 + loses 1 + damages 1 → cowrites two OOS records and auto-completes order",
  clause:
    "the delta + auto-complete half — the anchored step closes every quantity (return + loss + damage) and DOES auto-complete; the sibling step `returns 1 of 3 — order roll-up updated, no OOS, no auto-complete` is the partial return that moves `order.bookings_breakdown` by exactly the delta and does not complete. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

// ── create-order ─────────────────────────────────────────────────

const createOrderRules: CollectionRule[] = [
  {
    id: "create-order:org-to-order",
    source: "organizations",
    target: "orders",
    mode: "embed",
    invariant:
      "Orders carry a denormalized org snapshot so the UI never needs a join to display org name/billing",
    enforced_by: [ORDER_INPUT_HAS_NO_CHANNEL, ORG_SNAPSHOT_REFRESH],
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["organization", "uid"] },
      { source: ["name"], target: ["organization", "name"] },
      { source: ["crms_id"], target: ["organization", "crms_id"] },
      { source: ["xero_id"], target: ["organization", "xero_id"] },
      {
        source: ["billing_address"],
        target: ["organization", "billing_address"],
      },
    ],
  },
  {
    id: "create-order:products-to-order-items",
    source: "products",
    target: "orders",
    mode: "embed",
    invariant:
      "Line items inherit product type, stock_method, and default price from the product catalog",
    transaction: "create-order",
    fields: [
      { source: ["type"], target: ["items", "type"] },
      { source: ["stock_method"], target: ["items", "stock_method"] },
      {
        source: ["price", "base_cents"],
        target: ["items", "price", "base_cents"],
        transform: "fallback — used only when input omits price",
      },
      {
        source: ["price", "replacement_cents"],
        target: ["items", "price", "replacement_cents"],
        transform: "fallback — used only when input omits replacement",
      },
      {
        source: ["price", "taxes"],
        target: ["items", "price", "taxes"],
        transform:
          "fallback — denormalized TaxRef[] from product catalog, used when input omits taxes",
      },
      {
        source: ["name"],
        target: ["items", "name"],
        transform: "fallback — input name takes precedence",
      },
    ],
  },
  {
    id: "create-order:order-self-derive",
    source: "orders",
    target: "orders",
    mode: "derive",
    invariant:
      "Totals, query arrays, and order number are computed server-side to prevent client tampering",
    enforced_by: [
      ORDER_INPUT_HAS_NO_CHANNEL,
      ORDER_TOTALS_MATH,
      ORDER_NUMBER_COUNTER,
    ],
    transaction: "create-order",
    fields: [
      {
        source: ["items"],
        target: ["totals"],
        transform:
          "calculateOrderTotals(items, taxes) → {subtotal, subtotal_discounted, discount_amount, taxes, transaction_fees, total}. Two-pass: computes pre-tax items first, then transaction fees from subtotal_discounted. transaction_fee items excluded from bookings/stock.",
      },
      {
        source: ["items"],
        target: ["query_by_items"],
        transform: "consolidateItems(items) → product uids for search",
      },
      {
        source: ["destinations"],
        target: ["query_by_contacts"],
        transform:
          "flatten all contact uids from delivery/collection endpoints",
      },
      {
        source: ["destinations"],
        target: ["query_by_dates"],
        transform:
          "buildQueryByDates(destinations) — deduped Chicago YYYY-MM-DD boundary days across every destination's delivery + collection",
      },
      {
        source: [],
        target: ["number"],
        transform: "atomic increment of counters/orders.count",
      },
      {
        source: ["destinations"],
        target: ["destinations"],
        transform:
          "per-destination dates: each ISO string gets a Firestore timestamp companion (*_fs); getDuration → days_active/days_charged",
      },
      {
        source: [],
        target: ["bookings_breakdown"],
        transform:
          "sum of breakdowns across all freshly-built bookings — initial roll-up, maintained incrementally by update-booking thereafter. Sum of all values === sum of booking.quantity (invariant).",
      },
    ],
  },
  {
    id: "create-order:order-to-bookings",
    source: "orders",
    target: "bookings",
    mode: "co-write",
    invariant:
      "One booking per consolidated product per destination — tracks per-product stock lifecycle",
    enforced_by: [BOOKING_ID_IS_THE_CARDINALITY],
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["uid_order"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["organization", "crms_id"],
        target: ["organization", "crms_id"],
      },
      {
        source: ["destinations", "delivery", "uid"],
        target: ["uid_destination_delivery"],
      },
      {
        source: ["destinations", "delivery", "uid"],
        target: ["destinations", "delivery", "uid"],
      },
      {
        source: ["destinations", "delivery", "address"],
        target: ["destinations", "delivery", "address"],
      },
      {
        source: ["destinations", "collection", "uid"],
        target: ["uid_destination_collection"],
      },
      {
        source: ["destinations", "collection", "uid"],
        target: ["destinations", "collection", "uid"],
      },
      {
        source: ["destinations", "collection", "address"],
        target: ["destinations", "collection", "address"],
      },
      {
        source: ["destinations", "dates"],
        target: ["dates"],
        transform:
          "buildBookingDates(destination.dates) — per booking's own destination. rental: delivery_start→start, collection_start→end; sale: delivery_start→start, end=null",
      },
      {
        source: ["items", "uid"],
        target: ["uid_product"],
        transform: "consolidated item uid (the product uid)",
      },
      {
        source: ["items", "name"],
        target: ["name"],
        transform: "from consolidated item",
      },
      {
        source: ["items", "quantity"],
        target: ["quantity"],
        transform: "sum of duplicate line items via consolidateItems()",
      },
      {
        source: ["items", "type"],
        target: ["type"],
        transform: "from consolidated item",
      },
      {
        source: ["items", "price", "total_cents"],
        target: ["total_price_cents"],
        transform: "sum across consolidated duplicates",
      },
      {
        source: ["items", "price", "total_cents"],
        target: ["unit_price_cents"],
        transform:
          "consolidateItems() — total_price_cents ÷ quantity, rounded once, half away from zero. A stored denorm for the per-line fact table: unit_price_cents × quantity ≠ total_price_cents and the residual is discarded on purpose (total_price_cents is the authoritative figure)",
      },
      {
        source: [],
        target: ["breakdown"],
        transform:
          "calculateBreakdown(status, type, quantity) — distributes quantity into status buckets (quoted/reserved/prepped/out/returned/lost/damaged)",
      },
    ],
  },
  {
    id: "create-order:ledger-to-bookings",
    source: "inventory-ledgers",
    target: "bookings",
    mode: "embed",
    invariant:
      "Bookings get store allocation from the inventory ledger to track where stock is drawn from",
    enforced_by: [BOOKING_ALLOCATION_DIAGNOSTIC],
    transaction: "create-order",
    fields: [
      {
        source: ["store_breakdown"],
        target: ["stores"],
        transform:
          "allocateBookingToStores() — draws quantity from default store first, then alphabetical",
      },
      {
        source: ["store_breakdown"],
        target: ["query_by_uid_store"],
        transform: "allocated store uids for search",
      },
      {
        source: ["store_breakdown"],
        target: ["shortage"],
        transform: "remaining quantity that couldn't be allocated",
      },
    ],
  },
  {
    id: "create-order:order-to-cards",
    source: "orders",
    target: "cards",
    mode: "co-write",
    invariant:
      "Schedule projection — one event card per destination per position (start/end) drives the Dashboard's list/kanban/calendar/map views",
    enforced_by: [EVENT_CARD_RECONCILE],
    transaction: "create-order",
    fields: [
      {
        source: ["uid"],
        target: ["sources"],
        transform:
          "[{collection:'orders', uid}] — event card links back to its parent order",
      },
      {
        source: ["status"],
        target: ["status"],
        transform:
          "mapped: reserved/quoted→planned, active→active, complete→complete, canceled→canceled, draft→draft",
      },
      {
        source: ["number"],
        target: ["subject"],
        transform:
          "eventCardSubject(number, subject, action) → '#NUM - <Action> [Subject]'; action in {Deliver, Pickup, Return, Canceled} per (position, customer_collecting/returning, status)",
      },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["destinations", "delivery"],
        target: ["destination"],
        transform: "full DocDestinationEndpointType for start events",
      },
      {
        source: ["destinations", "collection"],
        target: ["destination"],
        transform: "full DocDestinationEndpointType for end events",
      },
      {
        source: ["destinations", "dates", "delivery_start"],
        target: ["dates", "start"],
        transform:
          "start event start instant (from the card's own destination)",
      },
      {
        source: ["destinations", "dates", "delivery_end"],
        target: ["dates", "end"],
        transform: "start event end instant (from the card's own destination)",
      },
      {
        source: ["destinations", "dates", "collection_start"],
        target: ["dates", "start"],
        transform:
          "end event start instant (rental items only, from the card's own destination)",
      },
      {
        source: ["destinations", "dates", "collection_end"],
        target: ["dates", "end"],
        transform:
          "end event end instant (rental items only, from the card's own destination)",
      },
      // ⚠️ One mapping listing a parent and two of its children as if they were
      // a path. They are siblings UNDER a destination, so each is its own
      // mapping (#568).
      {
        source: ["destinations", "customer_collecting"],
        target: ["uid_list"],
        transform:
          "per-pair flag drives card list — field-service for deliver, in-store for in_store_pickup",
      },
      {
        source: ["destinations", "customer_returning"],
        target: ["uid_list"],
        transform:
          "per-pair flag drives card list — field-service for pick_up, in-store for in_store_return",
      },
      {
        source: [],
        target: ["locked"],
        transform:
          "['card','subject','sources','destination','organization','attachments','status_auto'] — order-derived cards cannot be deleted, status follows pick progress, label/sources/destination/org/attachments cannot be edited via PATCH",
      },
    ],
  },
  {
    id: "create-order:order-to-fulfillment",
    source: "orders",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "Fulfillment clients see a sanitized order view — pricing, totals, invoices, tax profile, CRM/Xero ids, version, notes, and transaction_fee items are stripped",
    enforced_by: [FULFILLMENT_SHAPE_STRIPS, FULFILLMENT_STRIP_ASSERTED],
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["destinations"],
        target: ["destinations"],
        transform:
          "full DocDestination with per-destination dates + contacts retained",
      },
      {
        source: ["items"],
        target: ["items"],
        transform:
          "strips price, inclusion_type, zero_priced, crms_id; drops transaction_fee items entirely",
      },
      { source: ["subject"], target: ["subject"] },
      { source: ["reference"], target: ["reference"] },
      { source: ["query_by_items"], target: ["query_by_items"] },
      { source: ["query_by_contacts"], target: ["query_by_contacts"] },
      { source: ["query_by_dates"], target: ["query_by_dates"] },
    ],
  },
];

const createOrderTransaction: TransactionDefinition = {
  id: "create-order",
  description:
    "Creates an order with bookings, the `stock/{P}` projection, event cards, and the sanitized fulfillment view in a single Firestore transaction. Skips bookings/cards for draft/canceled status. Cowrites default threads for the order and each event card (card threads carry two sources so they surface on both the card and its parent order's detail view). Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Creating an order's bookings.",
  steps: [
    "create-order:org-to-order",
    "create-order:products-to-order-items",
    "create-order:order-self-derive",
    "create-order:order-to-bookings",
    "create-order:ledger-to-bookings",
    ...STOCK_STEPS,
    "create-order:order-to-cards",
    "create-order:order-to-fulfillment",
    "cowrite-thread:orders-to-thread",
    "cowrite-thread:thread-to-orders",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── update-order ─────────────────────────────────────────────────

const updateOrderRules: CollectionRule[] = [
  {
    id: "update-order:org-to-order",
    source: "organizations",
    target: "orders",
    mode: "embed",
    invariant:
      "When the order's org reference changes, fetch fresh org data to keep the denormalized snapshot current",
    enforced_by: [ORDER_INPUT_HAS_NO_CHANNEL, ORG_SNAPSHOT_REFRESH],
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["organization", "uid"] },
      { source: ["name"], target: ["organization", "name"] },
      { source: ["crms_id"], target: ["organization", "crms_id"] },
      { source: ["xero_id"], target: ["organization", "xero_id"] },
      {
        source: ["billing_address"],
        target: ["organization", "billing_address"],
      },
    ],
  },
  {
    id: "update-order:order-self-derive",
    source: "orders",
    target: "orders",
    mode: "derive",
    invariant:
      "Totals, query arrays, and date timestamps recomputed on every update",
    enforced_by: [ORDER_INPUT_HAS_NO_CHANNEL, ORDER_TOTALS_MATH],
    transaction: "update-order",
    fields: [
      {
        source: ["items"],
        target: ["totals"],
        transform:
          "calculateOrderTotals(items, taxes) → {subtotal, subtotal_discounted, discount_amount, taxes, transaction_fees, total}",
      },
      {
        source: ["items"],
        target: ["query_by_items"],
        transform: "consolidateItems(items) → product uids",
      },
      {
        source: ["destinations"],
        target: ["query_by_contacts"],
        transform: "flatten contact uids",
      },
      {
        source: ["destinations"],
        target: ["query_by_dates"],
        transform: "buildQueryByDates(destinations)",
      },
      {
        source: ["destinations"],
        target: ["destinations"],
        transform:
          "per-destination dates recanonicalized: Timestamp.fromDate() companions (*_fs) + getDuration recompute",
      },
    ],
  },
  {
    id: "update-order:order-to-bookings",
    source: "orders",
    target: "bookings",
    mode: "co-write",
    invariant:
      "Bookings are diffed — created, updated, or deleted based on item/status/date/destination changes. Orphan bookings (bookings whose {order,product,destination} composite id no longer appears in the order) are deleted and their `stock/{P}` projections zeroed.",
    enforced_by: [
      BOOKING_ID_IS_THE_CARDINALITY,
      BOOKING_DIFF_TESTS,
      ORPHAN_BOOKING_LEAVES_NO_STOCK_ENTRY,
    ],
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["uid_order"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["organization", "crms_id"],
        target: ["organization", "crms_id"],
      },
      {
        source: ["destinations", "delivery"],
        target: ["destinations", "delivery"],
        transform: "{uid, address}",
      },
      {
        source: ["destinations", "collection"],
        target: ["destinations", "collection"],
        transform: "{uid, address}",
      },
      {
        source: ["destinations", "dates"],
        target: ["dates"],
        transform:
          "buildBookingDates(destination.dates) — per booking's own destination, same logic as create",
      },
      {
        source: ["items"],
        target: [],
        transform:
          "consolidated items → uid_product, name, quantity, type, total_price_cents, unit_price_cents",
      },
      {
        source: [],
        target: ["breakdown"],
        transform:
          "calculateBreakdown(status, type, quantity) — preserves existing prepped/out/returned/lost/damaged counts",
      },
    ],
  },
  {
    id: "update-order:ledger-to-bookings",
    source: "inventory-ledgers",
    target: "bookings",
    mode: "embed",
    invariant: "Store allocation re-read from ledger on every booking update",
    enforced_by: [BOOKING_ALLOCATION_DIAGNOSTIC],
    transaction: "update-order",
    fields: [
      {
        source: ["store_breakdown"],
        target: ["stores"],
        transform:
          "allocateBookingToStores() — only for part-prepped/prepped/active status",
      },
      { source: ["store_breakdown"], target: ["query_by_uid_store"] },
      { source: ["store_breakdown"], target: ["shortage"] },
    ],
  },
  {
    id: "update-order:order-to-cards",
    source: "orders",
    target: "cards",
    mode: "co-write",
    invariant:
      "Event cards are rebuilt on every update — cards for removed destinations are deleted (and their threads cascade), cards for existing destinations are upserted in place. Preserves each card's user-editable fields (body, attachments, assignees) AND any progress-derived status (planned/active/complete/blocked) — order.status is only forced onto the card when the order transitions to draft or canceled (terminal). Active/reserved/quoted/complete order statuses don't clobber the card's per-pick auto-computed status (see update-booking:booking-to-cards).",
    enforced_by: [EVENT_CARD_RECONCILE, EVENT_CARD_PRESERVED_ON_UPDATE],
    transaction: "update-order",
    fields: [
      {
        source: ["uid"],
        target: ["sources"],
        transform:
          "[{collection:'orders', uid}] — regenerated event cards link back to the parent order",
      },
      {
        source: ["status"],
        target: ["status"],
        transform:
          "draft→draft, canceled→canceled (force-override); other statuses preserve the card's existing progress-derived status",
      },
      {
        source: ["number"],
        target: ["subject"],
        transform:
          "eventCardSubject(number, subject, action) → '#NUM - <Action> [Subject]'",
      },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["destinations", "delivery"],
        target: ["destination"],
        transform: "full DocDestinationEndpointType for start events",
      },
      {
        source: ["destinations", "collection"],
        target: ["destination"],
        transform: "full DocDestinationEndpointType for end events",
      },
      {
        source: ["destinations", "dates", "delivery_start"],
        target: ["dates", "start"],
      },
      {
        source: ["destinations", "dates", "delivery_end"],
        target: ["dates", "end"],
      },
      {
        source: ["destinations", "dates", "collection_start"],
        target: ["dates", "start"],
      },
      {
        source: ["destinations", "dates", "collection_end"],
        target: ["dates", "end"],
      },
    ],
  },
  {
    id: "update-order:order-to-fulfillment",
    source: "orders",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "Fulfillment view mirrors the order on every update — stripped of pricing, totals, invoices, tax profile, CRM/Xero ids, version, notes, and transaction_fee items",
    enforced_by: [FULFILLMENT_SHAPE_STRIPS, FULFILLMENT_STRIP_ASSERTED],
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["destinations"],
        target: ["destinations"],
        transform:
          "full DocDestination with per-destination dates + contacts retained",
      },
      {
        source: ["items"],
        target: ["items"],
        transform:
          "strips price, inclusion_type, zero_priced, crms_id; drops transaction_fee items entirely",
      },
      { source: ["subject"], target: ["subject"] },
      { source: ["reference"], target: ["reference"] },
      { source: ["query_by_items"], target: ["query_by_items"] },
      { source: ["query_by_contacts"], target: ["query_by_contacts"] },
      { source: ["query_by_dates"], target: ["query_by_dates"] },
    ],
  },
];

const updateOrderTransaction: TransactionDefinition = {
  id: "update-order",
  description:
    "Updates an order, diffing items/status/dates to create/update/delete bookings, rebuild the `stock/{P}` projection, rebuild event cards, and refresh the fulfillment view. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Adding, changing or removing an order's bookings — a removed booking is simply absent from the rebuilt array.",
  steps: [
    "update-order:org-to-order",
    "update-order:order-self-derive",
    "update-order:order-to-bookings",
    "update-order:ledger-to-bookings",
    ...STOCK_STEPS,
    "update-order:order-to-cards",
    // Shared steps, declared in `cards.ts` and fired here: a minted event card
    // gets its thread cowritten by the same helper `create-card` uses. Measured
    // undeclared in prod 2026-08-17 (`update-order` wrote `threads`), and
    // `services/orders.ts` was already PUSHING both ids into `rules_fired`
    // against a definition that declared neither.
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
    "update-order:order-to-fulfillment",
    "update-order:items-to-invoices",
    "update-order:status-to-invoices",
  ],
};

// ── update-booking ────────────────────────────────────────────────
//
// Single-booking PUT used by the fulfillment view to check items in/out and
// to record returned/lost/damaged quantities. Co-located here (not in its
// own file) because it lives entirely under the `order` aggregate root.

const updateBookingRules: CollectionRule[] = [
  {
    id: "update-booking:booking-to-self",
    source: "bookings",
    target: "bookings",
    mode: "co-write",
    // The completion identity here used to omit `out`, and that is not a
    // rounding-off — it is the opposite answer for every non-rental booking. A
    // sold unit does not come back, so checkout IS its terminal state; requiring
    // it to be `returned` would make every sale booking uncloseable. The code's
    // own error message says "returned + lost + damaged + out", so the string was
    // in verbatim contradiction with the guard it described, at `/docs`.
    //
    // It also omitted the two guards that run on EVERY write rather than only at
    // completion — the breakdown sum and the monotonic lost/damaged floor. Those
    // are the ones an operator actually hits.
    //
    // `sale` semantics are load-bearing across stock.ts:264 (the reduced
    // quantity's `out unless sale` rule) and orders.ts:349; a reader who took
    // this string literally would have contradicted both.
    invariant:
      "Status and breakdown rewritten with an optimistic version bump. Three guards, and only the last is about completion: (1) breakdown must always sum to booking.quantity; (2) breakdown.lost and breakdown.damaged may never DECREASE through this endpoint — reduce the OOS record instead; (3) when status flips to 'complete', the terminal count must equal quantity, where terminal is returned + lost + damaged for a RENTAL and returned + lost + damaged + out for every non-rental type (sale, service, surcharge), because a sold unit does not come back and checkout is its terminal state.",
    transaction: "update-booking",
    enforced_by: [{
      kind: "assertion",
      ref:
        "api-cloudrun/src/services/bookings.ts::async function applyBookingUpdate(",
      clause:
        "all three guards, at the single write path — ValidationError on each",
      gates: true,
    }],
    fields: [
      {
        source: [],
        target: ["status"],
        transform: "from input.status (defaults to current)",
      },
      {
        source: [],
        target: ["breakdown"],
        transform:
          "merge of input.breakdown over current; deltas must be ≥ 0 for lost/damaged",
      },
      {
        source: [],
        target: ["version"],
        transform: "version + 1 (optimistic concurrency)",
      },
    ],
  },
  {
    id: "update-booking:booking-to-out-of-service",
    source: "bookings",
    target: "out-of-service",
    mode: "co-write",
    invariant:
      "Non-zero increase in breakdown.lost or breakdown.damaged writes one OOS record per (booking, reason). If a non-complete OOS already exists for that pair (located via where('query_by_sources', 'array-contains', 'bookings:' + booking.uid) filtered by reason), its quantity is grown by the delta and a row appended to transactions[]. Otherwise a new OOS doc is cowritten with sources=[bookings, orders] and its default thread.",
    enforced_by: [OOS_COWRITTEN_FROM_BOOKING],
    transaction: "update-booking",
    fields: [
      {
        source: [],
        target: ["sources"],
        transform:
          "[{collection:'bookings', uid: booking.uid, label: 'Booking #' + booking.number}, {collection:'orders', uid: booking.uid_order, label: 'Order #' + order.number}]",
      },
      {
        source: [],
        target: ["query_by_sources"],
        transform: "['bookings:' + booking.uid, 'orders:' + booking.uid_order]",
      },
      { source: ["uid_product"], target: ["uid_product"] },
      {
        source: [],
        target: ["reason"],
        transform: "'lost' or 'damaged' depending on which delta fired",
      },
      {
        source: [],
        target: ["quantity"],
        transform:
          "delta (or current quantity + delta when growing an existing record)",
      },
      {
        source: ["stores"],
        target: ["stores"],
        transform: "copied from booking.stores",
      },
      {
        source: [],
        target: ["dates", "start"],
        transform: "now (chicagoInstant)",
      },
    ],
  },
  {
    id: "update-booking:booking-to-transactions",
    source: "bookings",
    target: "transactions",
    mode: "co-write",
    invariant:
      "A breakdown change appends movement events. The picker sends an ABSOLUTE breakdown; `deriveCustodyTransitions` translates the delta into at most one movement PER TYPE per booking — `prep`, then `check_out` (rental) or `sale`, or `check_in` / `sale_return` / `mark_damaged` / `mark_lost` on the way back. Each event's document id is the derived `{uid_session}|{type}|{booking uid}`, which is what makes the append idempotent under the client's retry: a replay resolves onto the same documents and is accepted when its content hash matches, rejected 409 when it does not. An un-prepped check-out is normalized as an implicit `prep` followed by a `check_out` so neither type occurs twice in one session. A sale's units lost or damaged in transit emit NOTHING — ownership dropped at the sale, so placing them at an out-of-service record would drive quantity_in_service negative. Only the fulfillment ladder emits: `orders`/`opportunity` writers project a breakdown from order STATUS, and quoted→reserved→prepped all sit at a locations doc, so nothing moves.",
    enforced_by: [CUSTODY_REPLAY],
    transaction: "update-booking",
    fields: [
      { source: ["uid_product"], target: ["uid_product"] },
      { source: ["uid"], target: ["uid_booking"] },
      {
        source: ["breakdown"],
        target: ["custody"],
        transform: "{from, to} breakdown keys of the transition",
      },
      {
        source: ["breakdown"],
        target: ["quantity"],
        transform: "units the transition moved",
      },
      {
        source: ["stores"],
        target: ["lines"],
        transform:
          "the booking's own allocation where it still holds, else allocateBookingToStores over the live ledger; placed on `from` or `to` per the type's MOVEMENT_CONTRACTS entry",
      },
      {
        source: [],
        target: ["number"],
        transform:
          "one contiguous allocateNumbers('transactions') range per chunk",
      },
      {
        source: [],
        target: ["sources"],
        transform:
          "[{collection:'orders', …}, {collection:'bookings', …}] plus the OOS record for a mark_lost/mark_damaged",
      },
    ],
  },
  {
    id: "update-booking:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant:
      "Each emitted movement is folded onto its product's ledger by the ONE applier, threading the ledger across rows so a second booking of the same product allocates against the shelf the first already drew from (which is why chunks are grouped by product). A rental check-out moves units locations→bookings and leaves `quantity_held` untouched; a `sale` is one-sided (locations→outside) and drops it, removing the weighted-average share of the basis rather than the operator's number; `mark_lost`/`mark_damaged` move bookings→out-of-service, which is what finally makes `quantity_out_of_service` and `out_of_service_breakdown` non-zero. The ledger is written only for products a movement actually moved. `assertLedgerNonNegative` runs on the FINAL state, so an intermediate leg may dip.",
    enforced_by: [LEDGER_REPLAY, LEDGER_NON_NEGATIVE],
    transaction: "update-booking",
    fields: [
      {
        source: ["lines"],
        target: ["quantity_held"],
        transform:
          "Σ (to ? +q : 0) + (from ? −q : 0) — conservation is structural",
      },
      {
        source: ["lines"],
        target: ["quantity_in_service"],
        transform: "quantity_held − quantity_out_of_service",
      },
      {
        source: ["lines"],
        target: ["quantity_out_of_service"],
        transform: "units at an out-of-service record",
      },
      {
        source: ["lines"],
        target: ["store_breakdown"],
        transform:
          "per-location quantity, with store name/default refreshed from the store document",
      },
      {
        source: ["cost"],
        target: ["total_cost_basis_cents"],
        transform:
          "sale only: −costOfUnits(basis, held, units), computed in integer cents before the quantity moves",
      },
      {
        source: ["cost"],
        target: ["average_unit_cost"],
        transform:
          "total_cost_basis_cents ÷ quantity_held, rounded once — a 4dp RATE, not cents",
      },
    ],
  },
  {
    id: "update-booking:transactions-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant:
      "The same fold stages the location documents, so a shelf count finally means units physically present rather than units owned — the defect that made `locations` overstate by whatever was out on jobs. Touches `products[].quantity`, `query_by_products` and `updated_at` only; name, active, default, type and capacities belong to createLocation/updateLocation. A line names only a location and its store is READ from the location document, so a cross-store placement is inexpressible rather than guarded (#307). A negative row is logged, never clamped and never thrown on — the authoritative guard is the ledger assertion, and throwing here would wedge future edits shut on exactly the drifted docs a resync must repair.",
    enforced_by: [MOVEMENT_APPLIER],
    transaction: "update-booking",
    fields: [
      {
        source: ["lines"],
        target: ["products"],
        transform:
          "quantity += (to ? +q : 0) + (from ? −q : 0) for the movement's product",
      },
      {
        source: ["uid_product"],
        target: ["query_by_products"],
        transform: "appended when the shelf has not held this product before",
      },
    ],
  },
  {
    id: "update-booking:booking-to-order",
    source: "bookings",
    target: "orders",
    mode: "co-write",
    invariant:
      "Every booking update applies a delta to order.bookings_breakdown ('+= next.breakdown[k] - prev.breakdown[k]' for each key). Same transaction may also flip order.status: (a) reserved → active when the post-delta bookings_breakdown.out > 0 and order.status === 'reserved' (one-way; out returning to 0 does NOT revert to reserved), (b) active/reserved → complete when bookings_breakdown.quoted + reserved + prepped + out === 0 (every quantity has reached a terminal state). Single order read + write per booking PUT — no sibling-bookings query.",
    enforced_by: [ORDER_ROLLUP_DELTA],
    transaction: "update-booking",
    fields: [
      {
        source: ["breakdown"],
        target: ["bookings_breakdown"],
        transform: "delta-applied roll-up across all bookings on this order",
      },
      {
        source: [],
        target: ["status"],
        transform:
          "complete iff bookings_breakdown.{quoted,reserved,prepped,out} === 0; else active iff bookings_breakdown.out > 0 and prev status === 'reserved'",
      },
    ],
  },
  {
    id: "update-booking:booking-to-cards",
    source: "bookings",
    target: "cards",
    mode: "co-write",
    invariant:
      "Per-destination event card status follows pick progress. For each destination touched by a booking write, query sibling bookings for that destination per side (delivery for `:start` cards, collection for `:end` cards) and recompute status: start: pre_delivery=Σ(quoted+reserved+prepped); pre_delivery===0 → complete; out>0 → active; else planned. end: terminal=Σ(returned+lost+damaged); terminal===Σquantity → complete; (terminal>0 || still_out>0) → active; else planned. Manual `blocked` status is preserved (pick-progress writes never overwrite blocked unless the parent order itself transitions to canceled, which lives on update-order). `canceled` status is sourced exclusively from order.status. Sale-only destinations exclude their bookings from the end-side roll-up so the end card stays planned↔complete based on rental siblings only. Card writes bump version and validate via CardSchema; the lock value `status_auto` permits this server-internal write while still rejecting external PATCH attempts to change `status` to anything other than `blocked`.",
    enforced_by: [CARD_STATUS_MATH],
    transaction: "update-booking",
    fields: [
      {
        source: ["breakdown"],
        target: ["status"],
        transform:
          "computeCardStatusFromBookings(side, siblings, current) — see invariant",
      },
      {
        source: ["breakdown"],
        target: ["action"],
        transform:
          "computeCardActionFromBookings(side, siblings, current) — denormalized next fulfillment step for the card button: {source:'fulfillment', value:'prep'|'checkout'|'return'} or null on terminal/non-actionable status. start: reserved>0→prep; else prepped>0→checkout; else null. end (rentals only): out>0→return; else null.",
      },
      { source: [], target: ["version"], transform: "incremented" },
    ],
  },
];

const updateBookingTransaction: TransactionDefinition = {
  id: "update-booking",
  description:
    "Update a single booking's status or breakdown. Appends the movement events the breakdown change represents and folds them onto the product's inventory ledger and its location documents — the fulfillment ladder's half of the journal. Recalculates `stock/{P}` projections FROM the post-movement ledger; cowrites/grows OOS records for new lost/damaged deltas (which themselves recalculate the OOS-side of `stock/{P}` projections and cowrite a default thread); applies a delta to order.bookings_breakdown and auto-completes the parent order when the roll-up shows every quantity has closed; recomputes per-destination event card status from sibling bookings. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Every booking breakdown change.",
  steps: [
    "update-booking:booking-to-self",
    ...STOCK_STEPS,
    "update-booking:booking-to-out-of-service",
    "update-booking:booking-to-transactions",
    "update-booking:transactions-to-ledger",
    "update-booking:transactions-to-locations",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
    // OOS cowrites pull these in when a new OOS record is created:
    "create-out-of-service-record:sources-to-record",
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
  ],
};

// ── bulk-checkout-order / bulk-return-order ───────────────────────
//
// Convenience wrappers over N update-booking calls inside one Firestore
// transaction. POST /orders/{uid}/checkout flips every reserved/prepped
// booking to active and moves quantities into breakdown.out. POST
// /orders/{uid}/return applies caller-supplied returned/lost/damaged
// deltas per booking.

const bulkCheckoutOrderTransaction: TransactionDefinition = {
  id: "bulk-checkout-order",
  description:
    "Flip every booking on an order from reserved/prepped to active and move quantities into breakdown.out in one Firestore transaction. Reuses update-booking rules per row, including the per-destination card status recompute.",
  steps: [
    "update-booking:booking-to-self",
    ...STOCK_STEPS,
    "update-booking:booking-to-transactions",
    "update-booking:transactions-to-ledger",
    "update-booking:transactions-to-locations",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
  ],
};

const bulkReturnOrderTransaction: TransactionDefinition = {
  id: "bulk-return-order",
  description:
    "Apply per-booking returned/lost/damaged deltas across the order in one Firestore transaction. Reuses update-booking rules per row, including OOS cowrite for any lost/damaged deltas and the per-destination card status recompute; final state may auto-complete the order.",
  steps: [
    "update-booking:booking-to-self",
    ...STOCK_STEPS,
    "update-booking:booking-to-out-of-service",
    "update-booking:booking-to-transactions",
    "update-booking:transactions-to-ledger",
    "update-booking:transactions-to-locations",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
    "create-out-of-service-record:sources-to-record",
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
  ],
};

// ── bulk-fulfillment-bookings ────────────────────────────────────
//
// PUT /fulfillments/{uid}/bookings — picker UI applies N booking transitions
// in one Firestore transaction. Reuses update-booking rules per row but with
// deduped stock rebuild per product, single order roll-up delta +
// auto-complete check, and one OOS counter allocation pass.

const bulkFulfillmentBookingsTransaction: TransactionDefinition = {
  id: "bulk-fulfillment-bookings",
  description:
    "Apply N booking transitions for one order via the picker UI in one Firestore transaction. Reuses update-booking rules per row but with deduped stock rebuilds per product (one unified-overlays call carrying both booking-side and OOS-side overlays), single order roll-up delta + auto-complete check, one OOS counter allocation pass, and one per-destination card status recompute pass.",
  steps: [
    "update-booking:booking-to-self",
    ...STOCK_STEPS,
    "update-booking:booking-to-out-of-service",
    "update-booking:booking-to-transactions",
    "update-booking:transactions-to-ledger",
    "update-booking:transactions-to-locations",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
    "create-out-of-service-record:sources-to-record",
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
  ],
};

// ── finalize-order ─────────────────────────────────────────────────
//
// The idempotent recompute that runs after a batch of booking writes: it
// re-derives the order's roll-up + status, mirrors the fulfillment view, and
// recomputes per-destination card status from the committed bookings. Callers
// that fold its rules into their OWN record pass `emitPropagationLog: false`
// (`bulk-*` do); the standalone caller is `POST /tasks/finalize-order`, the
// retry ladder that runs when the in-request finalize never got there.
//
// ⚠️ **It is declared because it is LOGGED, and it was logged undeclared.**
// `logTransactionPropagation` resolves an unknown id to `rules_expected: 0`
// (`tx?.steps.length ?? 0`), so the drift warn it exists to raise could never
// fire on this path — and the api's static guard could not see it, because the
// id reaches the logger through a variable (`options.transactionName ??
// "finalize-order"`) rather than as a literal. api-cloudrun#503.

const finalizeOrderTransaction: TransactionDefinition = {
  id: "finalize-order",
  description:
    "Recompute an order from its committed bookings: roll-up + auto-complete status, the sanitized fulfillment mirror, and per-destination event card status. Idempotent — re-running against unchanged bookings writes nothing. Runs in-request after a bulk booking write and again from the finalize Cloud Task.",
  steps: [
    "update-booking:booking-to-order",
    "update-order:order-to-fulfillment",
    "update-booking:booking-to-cards",
  ],
};

// ── process-order-docs ─────────────────────────────────────────────
//
// Async fanout: after `processOrderDocs` uploads a fresh packing-list PDF to
// Uploadcare and writes orders/{uid}/documents/{docUid}, the Cloud Run task
// finds every order-derived event card (cards.where(sources array-contains
// {collection:'orders', uid: order.uid})) and writes/replaces the attachment
// whose `type === "packing"` with the new uuid + filename. Replaces in place
// on each regeneration; the previous uuid is already cleaned by the
// processOrderDocs orphan-uuid sweep, so the card never references a deleted
// file. Server-internal write — bypasses CARD_LOCK on `attachments`.

const processOrderDocsRules: CollectionRule[] = [
  {
    id: "process-order-docs:doc-to-cards",
    source: "orders/documents",
    target: "cards",
    mode: "fan-out",
    invariant:
      "After the packing-list PDF is uploaded to Uploadcare, the resulting uuid is written into the `attachments[]` of every order-derived card (sources contains {collection:'orders', uid: order.uid}). One attachment per card, identified by `type === 'packing'`. Replaces in place on each regeneration; locked from picker writes (server-internal write bypasses the `attachments` lock).",
    transaction: "process-order-docs",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-card-attachments.ts",
      clause:
        "all four clauses — the fan-out reaching every in-scope card, the one-per-card cardinality, the mime_type/filename/locked conformance, and the reverse orphan check. `size_bytes` is excluded on purpose: the writer hard-codes 0, so asserting it would compare the implementation with itself",
      gates: true,
    }],
    fields: [
      { source: ["uuid"], target: ["attachments", "uid"] },
      { source: ["mime"], target: ["attachments", "mime_type"] },
      {
        source: [],
        target: ["attachments", "type"],
        transform: "'packing' (constant)",
      },
      {
        source: [],
        target: ["attachments", "filename"],
        transform: "`Packing List #${order.number}.pdf`",
      },
      {
        source: [],
        target: ["attachments", "locked"],
        transform: "true (server-managed)",
      },
    ],
  },
];

const processOrderDocsTransaction: TransactionDefinition = {
  id: "process-order-docs",
  description:
    "Async Cloud Task path: CRMS prepares the packing-list PDF, the API uploads it to Uploadcare, writes the order's documents subcollection, then fans the resulting Uploadcare uuid out to every order-derived event card so the picker UI can deep-link to the live PDF.",
  steps: [
    "process-order-docs:doc-to-cards",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `orders.ts` contributes to the propagation catalog. */
export const orders: PropagationModule = {
  rules: [
    ...createOrderRules,
    ...updateOrderRules,
    ...updateBookingRules,
    ...processOrderDocsRules,
  ],
  transactions: [
    createOrderTransaction,
    updateOrderTransaction,
    updateBookingTransaction,
    bulkCheckoutOrderTransaction,
    bulkReturnOrderTransaction,
    bulkFulfillmentBookingsTransaction,
    finalizeOrderTransaction,
    processOrderDocsTransaction,
  ],
};
