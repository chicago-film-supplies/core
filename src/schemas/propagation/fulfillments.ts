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
 * ⚠️ **The two routes are TWO transactions, and this module named only one
 * until api-cloudrun#674.** `POST /reset` borrowed `update-fulfillment-items`
 * — both the transaction id and the rule — and every clause of
 * `update-fulfillment-items:items-self` misdescribes it: reset is a whole-
 * document REPLACE sourced from `orders`, so `source: "fulfillments"` and
 * `mode: "co-write"` are both wrong, and it rewrites seven more fields than
 * that rule's four. **A borrowed transaction id turns the drift check off
 * silently**, because `rules_expected` is read off the transaction the record
 * claims to be.
 *
 * 🔴 **Reset is NOT covered by the last paragraph below either.** That
 * paragraph sends order-sourced projection writes to the order rules, and reset
 * IS an order-sourced projection write — but it is initiated on the
 * FULFILLMENT, by a picker, against a `fulfillment.reset` permission, and no
 * order write is in flight. `update-order:order-to-fulfillment` describes a
 * cascade OUT OF an order write and could not honestly claim it.
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

// ── reset-fulfillment ────────────────────────────────────────────────

/**
 * Reset discards picker work and re-projects. The anchored step drives it
 * through the route and asserts the picker's substitution and quantity
 * override are gone and the order's own quantity is back.
 */
const RESET_REBUILDS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentEdits.test.ts::POST /reset clears picker work and re-projects",
  clause:
    "the rebuild half — after a picker substitution and a quantity override, the reset leaves no `path_substituted_for` line and restores the order's quantity, with `version` strictly greater than before. It does not assert the other six replaced fields.",
  gates: true,
};

const resetFulfillmentRules: CollectionRule[] = [
  {
    id: "reset-fulfillment:rebuild-from-order",
    // 🔴 The SOURCE is `orders`, not `fulfillments`. Reset reads the order and
    // rebuilds the whole document from it (`buildFulfillment(order)`); the
    // existing fulfillment is read only to carry `created_at` forward and to
    // check the caller's `version`. Declaring `fulfillments` here — which is
    // what borrowing `update-fulfillment-items:items-self` did — describes a
    // co-write of a document against itself, and the four fields that rule
    // lists are the ones a PICKER edit touches.
    source: "orders",
    target: "fulfillments",
    // ⚠️ `embed`, NOT `co-write`, and the difference is the one the borrowed
    // rule got wrong. `co-write` means source and target are written in the
    // same transaction; reset only READS the order. The fulfillment takes a
    // snapshot of it and owns that snapshot until the next projection — which
    // is `embed`. Its sibling `create-order:order-to-fulfillment` is correctly
    // `co-write` because the order write is what triggers it.
    mode: "embed",
    invariant:
      "Reset rebuilds the fulfillment wholesale from its order, discarding every " +
      "picker-authored value. `created_at` is carried forward from the stored " +
      "fulfillment and `version` is bumped off it so a concurrent picker session " +
      "409s; everything else is re-derived through the same `buildFulfillment` " +
      "projection the order path uses. No cascade to bookings, `stock`, or " +
      "inventory-ledgers.",
    enforced_by: [RESET_REBUILDS],
    transaction: "reset-fulfillment",
    // ⚠️ Thirteen mappings, against the borrowed rule's four. The list is
    // `buildFulfillment`'s projected literal plus the version bump — which is
    // why `query_by_*` are direct copies off the ORDER here rather than the
    // "recomputed from merged items" the picker-edit rule declares: only the
    // PUT path recomputes them.
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "name"], target: ["organization", "name"] },
      {
        source: ["destinations"],
        target: ["destinations"],
        transform: "full DocDestination with per-destination dates + contacts retained",
      },
      {
        source: ["items"],
        target: ["items"],
        transform:
          "strips price, inclusion_type, zero_priced, crms_id; drops transaction_fee items entirely; every picker quantity override and substitution is discarded",
      },
      { source: ["subject"], target: ["subject"] },
      { source: ["reference"], target: ["reference"] },
      { source: ["query_by_items"], target: ["query_by_items"] },
      { source: ["query_by_contacts"], target: ["query_by_contacts"] },
      { source: ["query_by_dates"], target: ["query_by_dates"] },
      {
        source: [],
        target: ["version"],
        transform: "incremented off the STORED fulfillment, not the order",
      },
    ],
  },
];

const resetFulfillmentTransaction: TransactionDefinition = {
  id: "reset-fulfillment",
  description:
    "Discard every picker-authored value on a fulfillment and rebuild the document " +
    "from its order. Optimistic concurrency via version; writes only the fulfillment " +
    "doc itself — no cascade.",
  steps: [
    "reset-fulfillment:rebuild-from-order",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/fulfillments.ts` contributes to the propagation catalog. */
export const fulfillments: PropagationModule = {
  rules: [
    ...updateFulfillmentItemsRules,
    ...resetFulfillmentRules,
  ],
  transactions: [
    updateFulfillmentItemsTransaction,
    resetFulfillmentTransaction,
  ],
};
