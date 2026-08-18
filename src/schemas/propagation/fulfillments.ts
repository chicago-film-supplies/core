/**
 * Fulfillment propagation rules — picker-driven edits to fulfillments/{uid}.
 *
 * Picker writes (PUT /fulfillments/{uid}/items, POST /fulfillments/{uid}/reset)
 * mutate only the fulfillment doc itself. They do NOT cascade to bookings,
 * `stock`, or inventory-ledgers — fulfillment is operational only;
 * bookings/stock/ledger track the *promise*, not the *physical pick*. Drift
 * between allocation and physical pick is an out-of-band reconciliation
 * problem, not in scope here.
 *
 * Order-side projection writes to fulfillments (createOrder / updateOrder /
 * opportunity webhook) live under the order rules — see `update-order:order-to-fulfillment`.
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

/**
 * The positive half — items merged, `version` bumped, a stale version 409s.
 */
const PICKER_WRITE_ATOMIC: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentEdits.test.ts::PUT /items reduces qty + bumps version",
  clause:
    "the `items + version` half — the anchored step lands a quantity reduction and bumps `version`; the sibling step `PUT /items with stale version returns 409` rejects a stale one. The `query_by_*` recompute is not asserted.",
  gates: true,
};

/**
 * ⚠️ The NEGATIVE half is asserted only for BOOKINGS, though the step is named
 * for more. It snapshots the order's bookings and re-checks count + `version`
 * after a picker write; it never reads `stock` or
 * `inventory-ledgers`. So "no cascade" is measured on one of the three
 * collections the invariant names.
 */
const PICKER_WRITE_NO_CASCADE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentEdits.test.ts::picker writes do NOT cascade to bookings/stock",
  clause:
    "the `no cascade` half, for BOOKINGS ONLY — booking count and per-booking `version` are unchanged after a picker write. Despite the step's name it reads neither `stock` nor `inventory-ledgers`, so those two thirds of the claim are unmeasured.",
  gates: true,
};

// ── update-fulfillment-items ─────────────────────────────────────────

const updateFulfillmentItemsRules: CollectionRule[] = [
  {
    id: "update-fulfillment-items:items-self",
    source: "fulfillments",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "Picker writes mutate items + version + query_by_* on the same doc atomically. " +
      "No cascade to bookings, `stock`, or inventory-ledgers — picker work is " +
      "operational only and does not change the financial promise.",
    enforced_by: [PICKER_WRITE_ATOMIC, PICKER_WRITE_NO_CASCADE],
    transaction: "update-fulfillment-items",
    fields: [
      { source: ["items"], target: ["items"] },
      { source: ["version"], target: ["version"], transform: "incremented" },
      {
        source: [],
        target: ["query_by_items"],
        transform: "recomputed from merged items",
      },
      {
        source: [],
        target: ["query_by_contacts"],
        transform: "recomputed from merged items",
      },
    ],
  },
];

const updateFulfillmentItemsTransaction: TransactionDefinition = {
  id: "update-fulfillment-items",
  description:
    "Picker write to a fulfillment's items. Validates against the underlying order " +
    "and Product.alternates[], applies optimistic concurrency via version, and " +
    "writes only the fulfillment doc itself — no cascade.",
  steps: [
    "update-fulfillment-items:items-self",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `fulfillments.ts` contributes to the propagation catalog. */
export const fulfillments: PropagationModule = {
  rules: [
    ...updateFulfillmentItemsRules,
  ],
  transactions: [
    updateFulfillmentItemsTransaction,
  ],
};
