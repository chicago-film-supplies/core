/**
 * Fulfillment propagation rules — picker-driven edits to fulfillments/{uid}.
 *
 * Picker writes (PUT /fulfillments/{uid}/items, POST /fulfillments/{uid}/reset)
 * mutate only the fulfillment doc itself. They do NOT cascade to bookings,
 * stock-summaries, or inventory-ledgers — fulfillment is operational only;
 * bookings/stock/ledger track the *promise*, not the *physical pick*. Drift
 * between allocation and physical pick is an out-of-band reconciliation
 * problem, not in scope here.
 *
 * Order-side projection writes to fulfillments (createOrder / updateOrder /
 * opportunity webhook) live under the order rules — see `update-order:order-to-fulfillment`.
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── update-fulfillment-items ─────────────────────────────────────────

export const updateFulfillmentItemsRules: CollectionRule[] = [
  {
    id: "update-fulfillment-items:items-self",
    source: "fulfillments",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "Picker writes mutate items + version + query_by_* on the same doc atomically. " +
      "No cascade to bookings, stock-summaries, or inventory-ledgers — picker work is " +
      "operational only and does not change the financial promise.",
    transaction: "update-fulfillment-items",
    fields: [
      { source: ["items"], target: ["items"] },
      { source: ["version"], target: ["version"], transform: "incremented" },
      { source: [], target: ["query_by_items"], transform: "recomputed from merged items" },
      { source: [], target: ["query_by_contacts"], transform: "recomputed from merged items" },
    ],
  },
];

export const updateFulfillmentItemsTransaction: TransactionDefinition = {
  id: "update-fulfillment-items",
  description:
    "Picker write to a fulfillment's items. Validates against the underlying order " +
    "and Product.alternates[], applies optimistic concurrency via version, and " +
    "writes only the fulfillment doc itself — no cascade.",
  steps: [
    "update-fulfillment-items:items-self",
  ],
};
