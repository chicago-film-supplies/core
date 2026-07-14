/**
 * Transaction propagation rules — create-transaction + update-transaction.
 *
 * Traced from: api-cloudrun/src/services/transactions.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";
import { stockSummaryRules, stockSummarySteps } from "./stock-summaries.ts";

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
  ...stockSummaryRules(
    "create-transaction",
    "An inventory transaction that moves quantity_held (a pure location move, which leaves quantity_held untouched, skips the rebuild)",
  ),
];

export const createTransactionTransaction: TransactionDefinition = {
  id: "create-transaction",
  description: "Creates an inventory transaction, updates ledger quantities and location product tracking, rebuilds the product's stock summary when quantity_held moved, and cowrites a default thread.",
  steps: [
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    ...stockSummarySteps("create-transaction"),
    "cowrite-thread:transactions-to-thread",
    "cowrite-thread:thread-to-transactions",
  ],
};

// ── Update transaction ──────────────────────────────────────────

export const updateTransactionRules: CollectionRule[] = [
  {
    id: "update-transaction:names-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant: "When a transaction update only changes store/location names (no quantity changes), the names are written directly to location docs — skipping the full ledger reverse/reapply path. Eventarc afterLocationWrite then cascades the rename to ledgers, bookings, and OOS records. It does NOT cascade to stock-summaries: the summary carries no store_breakdown, so there is no location name on it to rename.",
    transaction: "update-transaction",
    fields: [
      { source: ["stores", "locations", "name"], target: ["name"] },
    ],
  },
  {
    id: "update-transaction:transaction-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "A stock-changing update reverses the previous transaction out of the ledger and applies the new one, in the same Firestore transaction.",
    transaction: "update-transaction",
    fields: [
      { source: ["quantity"], target: ["quantity_held"], transform: "reverse(prev) then apply(next), each ± by type multiplier" },
      { source: ["quantity"], target: ["quantity_in_service"], transform: "reverse(prev) then apply(next)" },
      { source: ["total_cost"], target: ["total_cost_basis"], transform: "reverse(prev) then apply(next)" },
      { source: ["total_cost"], target: ["average_unit_cost"], transform: "total_cost_basis / quantity_held" },
      { source: ["stores", "locations", "transactionQuantity"], target: ["store_breakdown", "locations", "quantity"], transform: "± per location" },
    ],
  },
  {
    id: "update-transaction:transaction-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant: "A stock-changing update rewrites the location docs for both the old and the new placement — a location dropped from the new stores[] still gets its reversal written (#284).",
    transaction: "update-transaction",
    fields: [
      { source: ["stores", "locations", "transactionQuantity"], target: ["products", "quantity"], transform: "reversal of prev merged with the forward pass; forward wins where both touch a location" },
    ],
  },
  ...stockSummaryRules(
    "update-transaction",
    "A transaction update that moves quantity_held (a name-only or location-only edit leaves quantity_held untouched and skips the rebuild)",
  ),
];

export const updateTransactionTransaction: TransactionDefinition = {
  id: "update-transaction",
  description: "Updates an inventory transaction. A name-only change (no quantity delta) writes names straight to the location docs with no ledger touch. A stock change reverses the previous transaction out of the ledger and locations, applies the new one, and rebuilds the product's stock summary when quantity_held actually moved.",
  steps: [
    "update-transaction:names-to-locations",
    "update-transaction:transaction-to-ledger",
    "update-transaction:transaction-to-locations",
    ...stockSummarySteps("update-transaction"),
  ],
};
