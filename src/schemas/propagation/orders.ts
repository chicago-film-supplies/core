/**
 * Order propagation rules — create-order and update-order transactions.
 *
 * Traced from: api-cloudrun/src/services/orders.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-order ─────────────────────────────────────────────────

export const createOrderRules: CollectionRule[] = [
  {
    id: "create-order:org-to-order",
    source: "organizations",
    target: "orders",
    mode: "embed",
    invariant: "Orders carry a denormalized org snapshot so the UI never needs a join to display org name/billing",
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["organization", "uid"] },
      { source: ["name"], target: ["organization", "name"] },
      { source: ["crms_id"], target: ["organization", "crms_id"] },
      { source: ["xero_id"], target: ["organization", "xero_id"] },
      { source: ["billing_address"], target: ["organization", "billing_address"] },
    ],
  },
  {
    id: "create-order:products-to-order-items",
    source: "products",
    target: "orders",
    mode: "embed",
    invariant: "Line items inherit product type, stock_method, and default price from the product catalog",
    transaction: "create-order",
    fields: [
      { source: ["type"], target: ["items", "type"] },
      { source: ["stock_method"], target: ["items", "stock_method"] },
      { source: ["price", "base"], target: ["items", "price", "base"], transform: "fallback — used only when input omits price" },
      { source: ["price", "replacement"], target: ["items", "price", "replacement"], transform: "fallback — used only when input omits replacement" },
      { source: ["price", "taxes"], target: ["items", "price", "taxes"], transform: "fallback — denormalized TaxRef[] from product catalog, used when input omits taxes" },
      { source: ["name"], target: ["items", "name"], transform: "fallback — input name takes precedence" },
    ],
  },
  {
    id: "create-order:order-self-derive",
    source: "orders",
    target: "orders",
    mode: "derive",
    invariant: "Totals, query arrays, and order number are computed server-side to prevent client tampering",
    transaction: "create-order",
    fields: [
      { source: ["items"], target: ["totals"], transform: "calculateOrderTotals(items, taxes) → {subtotal, subtotal_discounted, discount_amount, taxes, transaction_fees, total}. Two-pass: computes pre-tax items first, then transaction fees from subtotal_discounted. transaction_fee items excluded from bookings/stock." },
      { source: ["items"], target: ["query_by_items"], transform: "consolidateItems(items) → product uids for search" },
      { source: ["destinations"], target: ["query_by_contacts"], transform: "flatten all contact uids from delivery/collection endpoints" },
      { source: ["destinations"], target: ["query_by_dates"], transform: "buildQueryByDates(destinations) — deduped Chicago YYYY-MM-DD boundary days across every destination's delivery + collection" },
      { source: [], target: ["number"], transform: "atomic increment of counters/orders.count" },
      { source: ["destinations"], target: ["destinations"], transform: "per-destination dates: each ISO string gets a Firestore timestamp companion (*_fs); getDuration → days_active/days_charged" },
      { source: [], target: ["bookings_breakdown"], transform: "sum of breakdowns across all freshly-built bookings — initial roll-up, maintained incrementally by update-booking thereafter. Sum of all values === sum of booking.quantity (invariant)." },
    ],
  },
  {
    id: "create-order:order-to-bookings",
    source: "orders",
    target: "bookings",
    mode: "co-write",
    invariant: "One booking per consolidated product per destination — tracks per-product stock lifecycle",
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["uid_order"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      { source: ["organization", "crms_id"], target: ["organization", "crms_id"] },
      { source: ["destinations", "delivery", "uid"], target: ["uid_destination_delivery"] },
      { source: ["destinations", "delivery", "uid"], target: ["destinations", "delivery", "uid"] },
      { source: ["destinations", "delivery", "address"], target: ["destinations", "delivery", "address"] },
      { source: ["destinations", "collection", "uid"], target: ["uid_destination_collection"] },
      { source: ["destinations", "collection", "uid"], target: ["destinations", "collection", "uid"] },
      { source: ["destinations", "collection", "address"], target: ["destinations", "collection", "address"] },
      { source: ["destinations", "dates"], target: ["dates"], transform: "buildBookingDates(destination.dates) — per booking's own destination. rental: delivery_start→start, collection_start→end; sale: delivery_start→start, end=null" },
      { source: ["items", "uid"], target: ["uid_product"], transform: "consolidated item uid (the product uid)" },
      { source: ["items", "name"], target: ["name"], transform: "from consolidated item" },
      { source: ["items", "quantity"], target: ["quantity"], transform: "sum of duplicate line items via consolidateItems()" },
      { source: ["items", "type"], target: ["type"], transform: "from consolidated item" },
      { source: ["items", "price", "total"], target: ["total_price"], transform: "sum across consolidated duplicates" },
      { source: ["items", "price", "total"], target: ["unit_price"], transform: "total_price / quantity" },
      { source: [], target: ["breakdown"], transform: "calculateBreakdown(status, type, quantity) — distributes quantity into status buckets (quoted/reserved/prepped/out/returned/lost/damaged)" },
    ],
  },
  {
    id: "create-order:ledger-to-bookings",
    source: "inventory-ledgers",
    target: "bookings",
    mode: "embed",
    invariant: "Bookings get store allocation from the inventory ledger to track where stock is drawn from",
    transaction: "create-order",
    fields: [
      { source: ["store_breakdown"], target: ["stores"], transform: "allocateBookingToStores() — draws quantity from default store first, then alphabetical" },
      { source: ["store_breakdown"], target: ["query_by_uid_store"], transform: "allocated store uids for search" },
      { source: ["store_breakdown"], target: ["shortage"], transform: "remaining quantity that couldn't be allocated" },
    ],
  },
  {
    id: "create-order:bookings-to-stock-summaries",
    source: "bookings",
    target: "stock-summaries",
    mode: "co-write",
    invariant: "Stock summaries aggregate all bookings for a product/date-range so availability is queryable without scanning bookings",
    transaction: "create-order",
    fields: [
      { source: [], target: ["bookings"], transform: "full booking document embedded in array — one summary per product per date range" },
      { source: ["breakdown"], target: ["bookings_breakdown"], transform: "sum of all booking breakdowns in this date range" },
      { source: ["breakdown"], target: ["quantity_booked"], transform: "reserved + prepped + out across all bookings" },
      { source: ["breakdown"], target: ["quantity_available"], transform: "quantity_held - quantity_booked - quantity_out_of_service" },
    ],
  },
  {
    id: "create-order:ledger-to-stock-summaries",
    source: "inventory-ledgers",
    target: "stock-summaries",
    mode: "embed",
    invariant: "Stock summaries carry inventory totals from the ledger so availability can be computed in one read",
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["uid_product"] },
      { source: ["type"], target: ["type"] },
      { source: ["quantity_held"], target: ["quantity_held"] },
      { source: ["quantity_in_service"], target: ["quantity_in_service"] },
      { source: ["quantity_out_of_service"], target: ["quantity_out_of_service"] },
      { source: ["store_breakdown"], target: ["store_breakdown"] },
      { source: ["store_breakdown", "uid_store"], target: ["query_by_uid_store"] },
    ],
  },
  {
    id: "create-order:stock-to-public-stock",
    source: "stock-summaries",
    target: "public-stock-summaries",
    mode: "derive",
    invariant: "Public stock summaries strip internal details (bookings, breakdowns) for webshop availability queries",
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["uid_product"], target: ["uid_product"] },
      { source: ["type"], target: ["type"] },
      { source: ["summary_type"], target: ["summary_type"] },
      { source: ["dates"], target: ["dates"] },
      { source: ["quantity_available"], target: ["quantity_available"] },
      { source: ["store_breakdown"], target: ["store_breakdown"], transform: "simplified to {uid_store, quantity} only — strips locations, name, default, crms_stock_level_id" },
      { source: ["query_by_uid_store"], target: ["query_by_uid_store"] },
    ],
  },
  {
    id: "create-order:order-to-cards",
    source: "orders",
    target: "cards",
    mode: "co-write",
    invariant: "Schedule projection — one event card per destination per position (start/end) drives the Dashboard's list/kanban/calendar/map views",
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["sources"], transform: "[{collection:'orders', uid}] — event card links back to its parent order" },
      { source: ["status"], target: ["status"], transform: "mapped: reserved/quoted→planned, active→active, complete→complete, canceled→canceled, draft→draft" },
      { source: ["number"], target: ["subject"], transform: "eventCardSubject(number, subject, action) → '#NUM - <Action> [Subject]'; action in {Deliver, Pickup, Return, Canceled} per (position, customer_collecting/returning, status)" },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      { source: ["destinations", "delivery"], target: ["destination"], transform: "full DocDestinationEndpointType for start events" },
      { source: ["destinations", "collection"], target: ["destination"], transform: "full DocDestinationEndpointType for end events" },
      { source: ["destinations", "dates", "delivery_start"], target: ["dates", "start"], transform: "start event start instant (from the card's own destination)" },
      { source: ["destinations", "dates", "delivery_end"], target: ["dates", "end"], transform: "start event end instant (from the card's own destination)" },
      { source: ["destinations", "dates", "collection_start"], target: ["dates", "start"], transform: "end event start instant (rental items only, from the card's own destination)" },
      { source: ["destinations", "dates", "collection_end"], target: ["dates", "end"], transform: "end event end instant (rental items only, from the card's own destination)" },
      { source: ["destinations", "customer_collecting", "customer_returning"], target: ["uid_list"], transform: "per-pair flag drives card list — field-service for deliver/pick_up, in-store for in_store_pickup/in_store_return" },
      { source: [], target: ["locked"], transform: "['card','subject','sources','destination','organization','attachments','status_auto'] — order-derived cards cannot be deleted, status follows pick progress, label/sources/destination/org/attachments cannot be edited via PATCH" },
    ],
  },
  {
    id: "create-order:order-to-fulfillment",
    source: "orders",
    target: "fulfillments",
    mode: "co-write",
    invariant: "Fulfillment clients see a sanitized order view — pricing, totals, invoices, tax profile, CRM/Xero ids, version, notes, and transaction_fee items are stripped",
    transaction: "create-order",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      { source: ["destinations"], target: ["destinations"], transform: "full DocDestination with per-destination dates + contacts retained" },
      { source: ["items"], target: ["items"], transform: "strips price, inclusion_type, zero_priced, crms_id; drops transaction_fee items entirely" },
      { source: ["subject"], target: ["subject"] },
      { source: ["reference"], target: ["reference"] },
      { source: ["query_by_items"], target: ["query_by_items"] },
      { source: ["query_by_contacts"], target: ["query_by_contacts"] },
      { source: ["query_by_dates"], target: ["query_by_dates"] },
    ],
  },
];

export const createOrderTransaction: TransactionDefinition = {
  id: "create-order",
  description: "Creates an order with bookings, stock summaries, event cards, and the sanitized fulfillment view in a single Firestore transaction. Skips bookings/cards for draft/canceled status. Cowrites default threads for the order and each event card (card threads carry two sources so they surface on both the card and its parent order's detail view).",
  steps: [
    "create-order:org-to-order",
    "create-order:products-to-order-items",
    "create-order:order-self-derive",
    "create-order:order-to-bookings",
    "create-order:ledger-to-bookings",
    "create-order:bookings-to-stock-summaries",
    "create-order:ledger-to-stock-summaries",
    "create-order:stock-to-public-stock",
    "create-order:order-to-cards",
    "create-order:order-to-fulfillment",
    "cowrite-thread:orders-to-thread",
    "cowrite-thread:thread-to-orders",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── update-order ─────────────────────────────────────────────────

export const updateOrderRules: CollectionRule[] = [
  {
    id: "update-order:org-to-order",
    source: "organizations",
    target: "orders",
    mode: "embed",
    invariant: "When the order's org reference changes, fetch fresh org data to keep the denormalized snapshot current",
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["organization", "uid"] },
      { source: ["name"], target: ["organization", "name"] },
      { source: ["crms_id"], target: ["organization", "crms_id"] },
      { source: ["xero_id"], target: ["organization", "xero_id"] },
      { source: ["billing_address"], target: ["organization", "billing_address"] },
    ],
  },
  {
    id: "update-order:order-self-derive",
    source: "orders",
    target: "orders",
    mode: "derive",
    invariant: "Totals, query arrays, and date timestamps recomputed on every update",
    transaction: "update-order",
    fields: [
      { source: ["items"], target: ["totals"], transform: "calculateOrderTotals(items, taxes) → {subtotal, subtotal_discounted, discount_amount, taxes, transaction_fees, total}" },
      { source: ["items"], target: ["query_by_items"], transform: "consolidateItems(items) → product uids" },
      { source: ["destinations"], target: ["query_by_contacts"], transform: "flatten contact uids" },
      { source: ["destinations"], target: ["query_by_dates"], transform: "buildQueryByDates(destinations)" },
      { source: ["destinations"], target: ["destinations"], transform: "per-destination dates recanonicalized: Timestamp.fromDate() companions (*_fs) + getDuration recompute" },
    ],
  },
  {
    id: "update-order:order-to-bookings",
    source: "orders",
    target: "bookings",
    mode: "co-write",
    invariant: "Bookings are diffed — created, updated, or deleted based on item/status/date/destination changes. Orphan bookings (bookings whose {order,product,destination} composite id no longer appears in the order) are deleted and their stock summaries zeroed.",
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["uid_order"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      { source: ["organization", "crms_id"], target: ["organization", "crms_id"] },
      { source: ["destinations", "delivery"], target: ["destinations", "delivery"], transform: "{uid, address}" },
      { source: ["destinations", "collection"], target: ["destinations", "collection"], transform: "{uid, address}" },
      { source: ["destinations", "dates"], target: ["dates"], transform: "buildBookingDates(destination.dates) — per booking's own destination, same logic as create" },
      { source: ["items"], target: [], transform: "consolidated items → uid_product, name, quantity, type, total_price, unit_price" },
      { source: [], target: ["breakdown"], transform: "calculateBreakdown(status, type, quantity) — preserves existing prepped/out/returned/lost/damaged counts" },
    ],
  },
  {
    id: "update-order:ledger-to-bookings",
    source: "inventory-ledgers",
    target: "bookings",
    mode: "embed",
    invariant: "Store allocation re-read from ledger on every booking update",
    transaction: "update-order",
    fields: [
      { source: ["store_breakdown"], target: ["stores"], transform: "allocateBookingToStores() — only for part-prepped/prepped/active status" },
      { source: ["store_breakdown"], target: ["query_by_uid_store"] },
      { source: ["store_breakdown"], target: ["shortage"] },
    ],
  },
  {
    id: "update-order:bookings-to-stock-summaries",
    source: "bookings",
    target: "stock-summaries",
    mode: "co-write",
    invariant: "All stock summaries for affected products are recalculated — both for updated and removed bookings",
    transaction: "update-order",
    fields: [
      { source: [], target: ["bookings"], transform: "full booking document embedded; removed bookings get zero breakdown" },
      { source: ["breakdown"], target: ["bookings_breakdown"] },
      { source: ["breakdown"], target: ["quantity_booked"] },
      { source: ["breakdown"], target: ["quantity_available"] },
    ],
  },
  {
    id: "update-order:stock-to-public-stock",
    source: "stock-summaries",
    target: "public-stock-summaries",
    mode: "derive",
    invariant: "Public stock summaries mirror internal summaries with simplified store breakdown",
    transaction: "update-order",
    fields: [
      { source: [], target: [], transform: "same as create-order — copies all fields, simplifies store_breakdown to {uid_store, quantity}" },
    ],
  },
  {
    id: "update-order:order-to-cards",
    source: "orders",
    target: "cards",
    mode: "co-write",
    invariant: "Event cards are rebuilt on every update — cards for removed destinations are deleted (and their threads cascade), cards for existing destinations are upserted in place. Preserves each card's user-editable fields (body, attachments, assignees) AND any progress-derived status (planned/active/complete/blocked) — order.status is only forced onto the card when the order transitions to draft or canceled (terminal). Active/reserved/quoted/complete order statuses don't clobber the card's per-pick auto-computed status (see update-booking:booking-to-cards).",
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["sources"], transform: "[{collection:'orders', uid}] — regenerated event cards link back to the parent order" },
      { source: ["status"], target: ["status"], transform: "draft→draft, canceled→canceled (force-override); other statuses preserve the card's existing progress-derived status" },
      { source: ["number"], target: ["subject"], transform: "eventCardSubject(number, subject, action) → '#NUM - <Action> [Subject]'" },
      { source: ["subject"], target: ["subject"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      { source: ["destinations", "delivery"], target: ["destination"], transform: "full DocDestinationEndpointType for start events" },
      { source: ["destinations", "collection"], target: ["destination"], transform: "full DocDestinationEndpointType for end events" },
      { source: ["destinations", "dates", "delivery_start"], target: ["dates", "start"] },
      { source: ["destinations", "dates", "delivery_end"], target: ["dates", "end"] },
      { source: ["destinations", "dates", "collection_start"], target: ["dates", "start"] },
      { source: ["destinations", "dates", "collection_end"], target: ["dates", "end"] },
    ],
  },
  {
    id: "update-order:order-to-fulfillment",
    source: "orders",
    target: "fulfillments",
    mode: "co-write",
    invariant: "Fulfillment view mirrors the order on every update — stripped of pricing, totals, invoices, tax profile, CRM/Xero ids, version, notes, and transaction_fee items",
    transaction: "update-order",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      { source: ["destinations"], target: ["destinations"], transform: "full DocDestination with per-destination dates + contacts retained" },
      { source: ["items"], target: ["items"], transform: "strips price, inclusion_type, zero_priced, crms_id; drops transaction_fee items entirely" },
      { source: ["subject"], target: ["subject"] },
      { source: ["reference"], target: ["reference"] },
      { source: ["query_by_items"], target: ["query_by_items"] },
      { source: ["query_by_contacts"], target: ["query_by_contacts"] },
      { source: ["query_by_dates"], target: ["query_by_dates"] },
    ],
  },
];

export const updateOrderTransaction: TransactionDefinition = {
  id: "update-order",
  description: "Updates an order, diffing items/status/dates to create/update/delete bookings, recalculate stock summaries, rebuild event cards, and refresh the fulfillment view.",
  steps: [
    "update-order:org-to-order",
    "update-order:order-self-derive",
    "update-order:order-to-bookings",
    "update-order:ledger-to-bookings",
    "update-order:bookings-to-stock-summaries",
    "update-order:stock-to-public-stock",
    "update-order:order-to-cards",
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

export const updateBookingRules: CollectionRule[] = [
  {
    id: "update-booking:booking-to-self",
    source: "bookings",
    target: "bookings",
    mode: "co-write",
    invariant: "Status and breakdown rewritten with optimistic version bump. When status flips to 'complete', the API enforces breakdown.returned + breakdown.lost + breakdown.damaged === booking.quantity.",
    transaction: "update-booking",
    fields: [
      { source: [], target: ["status"], transform: "from input.status (defaults to current)" },
      { source: [], target: ["breakdown"], transform: "merge of input.breakdown over current; deltas must be ≥ 0 for lost/damaged" },
      { source: [], target: ["version"], transform: "version + 1 (optimistic concurrency)" },
    ],
  },
  {
    id: "update-booking:booking-to-stock-summaries",
    source: "bookings",
    target: "stock-summaries",
    mode: "co-write",
    invariant: "Every booking breakdown change recomputes stock-summaries.bookings_breakdown and quantity_booked for the product (recalculateAllStockSummaries, source: 'booking').",
    transaction: "update-booking",
    fields: [
      { source: ["breakdown"], target: ["bookings_breakdown"] },
      { source: ["breakdown"], target: ["quantity_booked"], transform: "reserved + prepped + out across all bookings" },
      { source: [], target: ["quantity_available"], transform: "quantity_held - quantity_booked - quantity_out_of_service" },
    ],
  },
  {
    id: "update-booking:booking-to-out-of-service",
    source: "bookings",
    target: "out-of-service",
    mode: "co-write",
    invariant: "Non-zero increase in breakdown.lost or breakdown.damaged writes one OOS record per (booking, reason). If a non-complete OOS already exists for that pair (located via where('query_by_sources', 'array-contains', 'bookings:' + booking.uid) filtered by reason), its quantity is grown by the delta and a row appended to transactions[]. Otherwise a new OOS doc is cowritten with sources=[bookings, orders] and its default thread.",
    transaction: "update-booking",
    fields: [
      { source: [], target: ["sources"], transform: "[{collection:'bookings', uid: booking.uid, label: 'Booking #' + booking.number}, {collection:'orders', uid: booking.uid_order, label: 'Order #' + order.number}]" },
      { source: [], target: ["query_by_sources"], transform: "['bookings:' + booking.uid, 'orders:' + booking.uid_order]" },
      { source: ["uid_product"], target: ["uid_product"] },
      { source: [], target: ["reason"], transform: "'lost' or 'damaged' depending on which delta fired" },
      { source: [], target: ["quantity"], transform: "delta (or current quantity + delta when growing an existing record)" },
      { source: ["stores"], target: ["stores"], transform: "copied from booking.stores" },
      { source: [], target: ["dates", "start"], transform: "now (chicagoInstant)" },
    ],
  },
  {
    id: "update-booking:booking-to-order",
    source: "bookings",
    target: "orders",
    mode: "co-write",
    invariant: "Every booking update applies a delta to order.bookings_breakdown ('+= next.breakdown[k] - prev.breakdown[k]' for each key). Same transaction may also flip order.status: (a) reserved → active when the post-delta bookings_breakdown.out > 0 and order.status === 'reserved' (one-way; out returning to 0 does NOT revert to reserved), (b) active/reserved → complete when bookings_breakdown.quoted + reserved + prepped + out === 0 (every quantity has reached a terminal state). Single order read + write per booking PUT — no sibling-bookings query.",
    transaction: "update-booking",
    fields: [
      { source: ["breakdown"], target: ["bookings_breakdown"], transform: "delta-applied roll-up across all bookings on this order" },
      { source: [], target: ["status"], transform: "complete iff bookings_breakdown.{quoted,reserved,prepped,out} === 0; else active iff bookings_breakdown.out > 0 and prev status === 'reserved'" },
    ],
  },
  {
    id: "update-booking:booking-to-cards",
    source: "bookings",
    target: "cards",
    mode: "co-write",
    invariant: "Per-destination event card status follows pick progress. For each destination touched by a booking write, query sibling bookings for that destination per side (delivery for `:start` cards, collection for `:end` cards) and recompute status: start: pre_delivery=Σ(quoted+reserved+prepped); pre_delivery===0 → complete; out>0 → active; else planned. end: terminal=Σ(returned+lost+damaged); terminal===Σquantity → complete; (terminal>0 || still_out>0) → active; else planned. Manual `blocked` status is preserved (pick-progress writes never overwrite blocked unless the parent order itself transitions to canceled, which lives on update-order). `canceled` status is sourced exclusively from order.status. Sale-only destinations exclude their bookings from the end-side roll-up so the end card stays planned↔complete based on rental siblings only. Card writes bump version and validate via CardSchema; the lock value `status_auto` permits this server-internal write while still rejecting external PATCH attempts to change `status` to anything other than `blocked`.",
    transaction: "update-booking",
    fields: [
      { source: ["breakdown"], target: ["status"], transform: "computeCardStatusFromBookings(side, siblings, current) — see invariant" },
      { source: ["breakdown"], target: ["action"], transform: "computeCardActionFromBookings(side, siblings, current) — denormalized next fulfillment step for the card button: {source:'fulfillment', value:'prep'|'checkout'|'return'} or null on terminal/non-actionable status. start: reserved>0→prep; else prepped>0→checkout; else null. end (rentals only): out>0→return; else null." },
      { source: [], target: ["version"], transform: "incremented" },
    ],
  },
];

export const updateBookingTransaction: TransactionDefinition = {
  id: "update-booking",
  description: "Update a single booking's status or breakdown. Recalculates stock summaries; cowrites/grows OOS records for new lost/damaged deltas (which themselves recalculate the OOS-side of stock summaries and cowrite a default thread); applies a delta to order.bookings_breakdown and auto-completes the parent order when the roll-up shows every quantity has closed; recomputes per-destination event card status from sibling bookings.",
  steps: [
    "update-booking:booking-to-self",
    "update-booking:booking-to-stock-summaries",
    "update-booking:booking-to-out-of-service",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
    // OOS cowrites pull these in when a new OOS record is created:
    "create-out-of-service-record:sources-to-record",
    "create-out-of-service-record:record-to-stock-summaries",
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

export const bulkCheckoutOrderTransaction: TransactionDefinition = {
  id: "bulk-checkout-order",
  description: "Flip every booking on an order from reserved/prepped to active and move quantities into breakdown.out in one Firestore transaction. Reuses update-booking rules per row, including the per-destination card status recompute.",
  steps: [
    "update-booking:booking-to-self",
    "update-booking:booking-to-stock-summaries",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
  ],
};

export const bulkReturnOrderTransaction: TransactionDefinition = {
  id: "bulk-return-order",
  description: "Apply per-booking returned/lost/damaged deltas across the order in one Firestore transaction. Reuses update-booking rules per row, including OOS cowrite for any lost/damaged deltas and the per-destination card status recompute; final state may auto-complete the order.",
  steps: [
    "update-booking:booking-to-self",
    "update-booking:booking-to-stock-summaries",
    "update-booking:booking-to-out-of-service",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
    "create-out-of-service-record:sources-to-record",
    "create-out-of-service-record:record-to-stock-summaries",
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
  ],
};

// ── bulk-fulfillment-bookings ────────────────────────────────────
//
// PUT /fulfillments/{uid}/bookings — picker UI applies N booking transitions
// in one Firestore transaction. Reuses update-booking rules per row but with
// deduped stock-summary recalc per product, single order roll-up delta +
// auto-complete check, and one OOS counter allocation pass.

export const bulkFulfillmentBookingsTransaction: TransactionDefinition = {
  id: "bulk-fulfillment-bookings",
  description: "Apply N booking transitions for one order via the picker UI in one Firestore transaction. Reuses update-booking rules per row but with deduped stock-summary recalc per product (one unified-overlays call carrying both booking-side and OOS-side overlays), single order roll-up delta + auto-complete check, one OOS counter allocation pass, and one per-destination card status recompute pass.",
  steps: [
    "update-booking:booking-to-self",
    "update-booking:booking-to-stock-summaries",
    "update-booking:booking-to-out-of-service",
    "update-booking:booking-to-order",
    "update-booking:booking-to-cards",
    "create-out-of-service-record:sources-to-record",
    "create-out-of-service-record:record-to-stock-summaries",
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
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

export const processOrderDocsRules: CollectionRule[] = [
  {
    id: "process-order-docs:doc-to-cards",
    source: "orders/documents",
    target: "cards",
    mode: "fan-out",
    invariant: "After the packing-list PDF is uploaded to Uploadcare, the resulting uuid is written into the `attachments[]` of every order-derived card (sources contains {collection:'orders', uid: order.uid}). One attachment per card, identified by `type === 'packing'`. Replaces in place on each regeneration; locked from picker writes (server-internal write bypasses the `attachments` lock).",
    transaction: "process-order-docs",
    fields: [
      { source: ["uuid"], target: ["attachments", "uid"] },
      { source: ["mime"], target: ["attachments", "mime_type"] },
      { source: [], target: ["attachments", "type"], transform: "'packing' (constant)" },
      { source: [], target: ["attachments", "filename"], transform: "`Packing List #${order.number}.pdf`" },
      { source: [], target: ["attachments", "locked"], transform: "true (server-managed)" },
    ],
  },
];

export const processOrderDocsTransaction: TransactionDefinition = {
  id: "process-order-docs",
  description: "Async Cloud Task path: CRMS prepares the packing-list PDF, the API uploads it to Uploadcare, writes the order's documents subcollection, then fans the resulting Uploadcare uuid out to every order-derived event card so the picker UI can deep-link to the live PDF.",
  steps: [
    "process-order-docs:doc-to-cards",
  ],
};
