/**
 * Transaction propagation rules — create-transaction.
 *
 * Traced from: api-cloudrun/src/services/transactions.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

export const createTransactionRules: CollectionRule[] = [
  {
    id: "create-transaction:transaction-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "Every inventory transaction immediately updates the ledger — the ledger is the source of truth for current stock levels",
    transaction: "create-transaction",
    fields: [
      { source: ["quantity"], target: ["quantity_held"], transform: "± based on transaction type multiplier" },
      { source: ["quantity"], target: ["quantity_in_service"], transform: "± based on transaction type multiplier" },
      { source: ["total_cost"], target: ["total_cost_basis"], transform: "± based on transaction type" },
      { source: ["total_cost"], target: ["average_unit_cost"], transform: "total_cost_basis / quantity_held" },
      { source: ["stores", "locations", "transactionQuantity"], target: ["store_breakdown", "locations", "quantity"], transform: "± per location" },
    ],
  },
  {
    id: "create-transaction:transaction-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant: "Locations track which products are stored there and how many, updated on every transaction",
    transaction: "create-transaction",
    fields: [
      { source: ["uid_product"], target: ["products", "uid"] },
      { source: [], target: ["products", "name"], transform: "product name looked up from product doc" },
      { source: ["stores", "locations", "transactionQuantity"], target: ["products", "quantity"], transform: "± per location" },
      { source: ["uid_product"], target: ["product_capacities", "uid"], transform: "creates capacity entry if missing, using location-type defaults" },
      { source: ["uid_product"], target: ["query_by_products"], transform: "adds product uid if missing" },
    ],
  },
  {
    id: "create-transaction:ledger-to-stock-summaries",
    source: "inventory-ledgers",
    target: "stock-summaries",
    mode: "co-write",
    invariant: "Stock summaries are recalculated from the updated ledger after every transaction",
    transaction: "create-transaction",
    fields: [
      { source: ["quantity_held"], target: ["quantity_held"] },
      { source: ["quantity_in_service"], target: ["quantity_in_service"] },
      { source: ["quantity_out_of_service"], target: ["quantity_out_of_service"] },
      { source: ["store_breakdown"], target: ["store_breakdown"] },
      { source: [], target: ["quantity_available"], transform: "quantity_held - quantity_booked - quantity_out_of_service" },
    ],
  },
  {
    id: "create-transaction:stock-to-public-stock",
    source: "stock-summaries",
    target: "public-stock-summaries",
    mode: "derive",
    invariant: "Public view updated whenever stock summaries change",
    transaction: "create-transaction",
    fields: [
      { source: [], target: [], transform: "same derivation as order rules — simplified store_breakdown" },
    ],
  },
];

export const createTransactionTransaction: TransactionDefinition = {
  id: "create-transaction",
  description: "Creates an inventory transaction, updates ledger quantities, location product tracking, recalculates all stock summaries for the product, and cowrites a default thread.",
  steps: [
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    "create-transaction:ledger-to-stock-summaries",
    "create-transaction:stock-to-public-stock",
    "cowrite-thread:transactions-to-thread",
    "cowrite-thread:thread-to-transactions",
  ],
};

// ── Update transaction (name-only changes) ──────────────────────

export const updateTransactionRules: CollectionRule[] = [
  {
    id: "update-transaction:names-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant: "When a transaction update only changes store/location names (no quantity changes), the names are written directly to location docs — skipping the full ledger reverse/reapply path. Eventarc afterLocationWrite then cascades to ledgers, stock summaries, bookings, and OOS records.",
    transaction: "update-transaction",
    fields: [
      { source: ["stores", "locations", "name"], target: ["name"] },
    ],
  },
];

export const updateTransactionTransaction: TransactionDefinition = {
  id: "update-transaction",
  description: "Updates an inventory transaction. If only store/location names changed (no quantity delta), writes names directly to location docs without ledger recalc. Full stock updates reuse create-transaction rules.",
  steps: [
    "update-transaction:names-to-locations",
  ],
};
