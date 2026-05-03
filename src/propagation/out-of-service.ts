/**
 * Out-of-service propagation rules.
 *
 * `create-out-of-service-record` — direct admin POST or born from a booking
 * update (warehouse marks items lost/damaged on check-in). Cowrites a default
 * thread; updates stock-summaries via the OOS pass of recalculateAllStockSummaries.
 *
 * `update-out-of-service-record` — flip `complete`, set `dates.end`, move
 * quantities between return-to-service and write-off. When `complete: true`
 * is set with non-zero return-to-service or write-off, an inventory transaction
 * is cowritten so the ledger movement is the same source of truth that any
 * other manual transaction would produce. Per the OOS lifecycle, the booking
 * that originated the loss is NOT updated — the booking already records the
 * loss in its own breakdown.
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

export const createOutOfServiceRules: CollectionRule[] = [
  {
    id: "create-out-of-service-record:sources-to-record",
    source: "out-of-service",
    target: "out-of-service",
    mode: "co-write",
    invariant: "Sources are a 0..N polymorphic list ({collection, uid, label}) — empty for ad-hoc, [orders] for manually-attached, [bookings, orders] when born from a booking PUT. query_by_sources is rebuilt from sources on every write for Firestore array-contains filtering.",
    transaction: "create-out-of-service-record",
    fields: [
      { source: [], target: ["sources"], transform: "from input — caller supplies up to N {collection, uid, label} entries" },
      { source: ["sources"], target: ["query_by_sources"], transform: "sources.map(s => `${s.collection}:${s.uid}`)" },
      { source: [], target: ["uid_product"] },
      { source: [], target: ["reason"] },
      { source: [], target: ["quantity"] },
      { source: [], target: ["dates", "start"] },
      { source: [], target: ["stores"] },
    ],
  },
  {
    id: "create-out-of-service-record:record-to-stock-summaries",
    source: "out-of-service",
    target: "stock-summaries",
    mode: "co-write",
    invariant: "Creating an OOS record updates stock-summaries.out_of_service_breakdown and quantity_out_of_service for the product (recalculateAllStockSummaries('outOfService', ledger, recordUid, { reason, quantity }))",
    transaction: "create-out-of-service-record",
    fields: [
      { source: ["reason"], target: ["out_of_service_breakdown"], transform: "incremented by quantity at the matching reason key" },
      { source: ["quantity"], target: ["quantity_out_of_service"], transform: "+= quantity" },
      { source: [], target: ["quantity_available"], transform: "quantity_held - quantity_booked - quantity_out_of_service" },
    ],
  },
];

export const createOutOfServiceTransaction: TransactionDefinition = {
  id: "create-out-of-service-record",
  description: "Creates an out-of-service record, recomputes the affected product's stock-summaries, and cowrites a default thread for the record.",
  steps: [
    "create-out-of-service-record:sources-to-record",
    "create-out-of-service-record:record-to-stock-summaries",
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
  ],
};

export const updateOutOfServiceRules: CollectionRule[] = [
  {
    id: "update-out-of-service-record:record-to-stock-summaries",
    source: "out-of-service",
    target: "stock-summaries",
    mode: "co-write",
    invariant: "OOS quantity changes recompute stock-summaries.out_of_service_breakdown and quantity_out_of_service.",
    transaction: "update-out-of-service-record",
    fields: [
      { source: ["reason"], target: ["out_of_service_breakdown"], transform: "delta applied at the matching reason key" },
      { source: ["quantity"], target: ["quantity_out_of_service"], transform: "delta" },
    ],
  },
  {
    id: "update-out-of-service-record:record-to-transactions",
    source: "out-of-service",
    target: "transactions",
    mode: "co-write",
    invariant: "Marking complete: true cowrites an inventory transaction in the same Firestore transaction — a 'return-to-service' for quantity_return_to_service > 0, and/or a 'write-off' for quantity_write_off > 0. Each cowritten transaction follows the standard create-transaction rules (ledger update + locations update + stock-summary recalc).",
    transaction: "update-out-of-service-record",
    fields: [
      { source: ["uid_product"], target: ["uid_product"] },
      { source: ["quantity_return_to_service"], target: ["quantity"], transform: "if > 0, build a return-to-service transaction" },
      { source: ["quantity_write_off"], target: ["quantity"], transform: "if > 0, build a write-off transaction" },
      { source: ["stores"], target: ["stores"], transform: "store/location allocation copied from oos.stores" },
      { source: ["uid"], target: ["source", "uid"], transform: "transaction.source points back at the OOS record" },
    ],
  },
  {
    id: "update-out-of-service-record:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "derive",
    invariant: "Cowritten transactions cascade through the standard create-transaction:transaction-to-ledger path — applyTransactionToLedger updates quantity_held / quantity_in_service / quantity_out_of_service.",
    transaction: "update-out-of-service-record",
    fields: [
      { source: ["quantity"], target: ["quantity_held"], transform: "± based on transaction type multiplier" },
      { source: ["quantity"], target: ["quantity_in_service"], transform: "+ for return-to-service; − for write-off" },
      { source: ["quantity"], target: ["quantity_out_of_service"], transform: "− on either return-to-service or write-off (the OOS bucket empties)" },
    ],
  },
];

export const updateOutOfServiceTransaction: TransactionDefinition = {
  id: "update-out-of-service-record",
  description: "Updates an out-of-service record. Quantity changes recompute stock summaries. Marking complete: true with non-zero return-to-service or write-off cowrites the corresponding inventory transactions, which cascade through the ledger and stock-summary update path. No back-propagation to the originating booking — the booking already records the loss in its own breakdown.",
  steps: [
    "update-out-of-service-record:record-to-stock-summaries",
    "update-out-of-service-record:record-to-transactions",
    "update-out-of-service-record:transactions-to-ledger",
  ],
};
