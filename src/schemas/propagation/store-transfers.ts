/**
 * Store-transfer propagation rules — create-store-transfer.
 *
 * **A transfer is ONE movement now, not a document pair.** It used to be written
 * as a `transfer_decrease` leg out of the source and a `transfer_increase` leg
 * into the destination, sharing a number and pointing at each other, purely
 * because a single row could not say "out of A, into B". A line's
 * `location: {from, to}` says exactly that, so the pair, the shared number, the
 * back-references and the `create-store-transfer:transfer-to-transactions` rule
 * that described them all collapse into one document with one rule per target.
 *
 * There is no `update-store-transfer` either. Editing a transfer is a reversal
 * plus a new transfer, like any other movement — so the four-pass
 * reverse-old-out / reverse-old-in / apply-new-out / apply-new-in dance that
 * `update-store-transfer:transactions-to-locations` existed to describe (#284,
 * #172) has nothing left to describe.
 *
 * **A transfer deliberately has NO stock-summary rule, and that is the point.**
 * Its lines net to exactly zero on `quantity_held` — the same units leave and
 * arrive — and the summary embeds `quantity_held` and `type` and nothing about
 * placement, so a transfer cannot change any availability answer. Rebuilding the
 * summary would be pure write amplification on the hottest doc in the system.
 * What a transfer *does* change (which shelf the units sit on) lives on
 * `inventory-ledgers` and `locations`, which is where the manager reads it.
 *
 * It also has no `cost` object at all, which is what makes #286 — a costed
 * transfer corrupting the basis — structurally impossible rather than gated by
 * a `hasCosts(type)` check that could be got wrong.
 *
 * Traced from: api-cloudrun/src/services/storeTransfers.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

export const createStoreTransferRules: CollectionRule[] = [
  {
    id: "create-store-transfer:transaction-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant:
      "quantity_held and quantity_in_service net to ZERO by construction — every line carries both endpoints, so a transfer moves stock and can neither create nor destroy it. Only store_breakdown actually moves. assertLedgerNonNegative still runs: a transfer taking more than a source location holds is rejected, because a shelf cannot go to −4 units.",
    transaction: "create-store-transfer",
    fields: [
      {
        source: ["lines"],
        target: ["quantity_held"],
        transform: "net zero — each line subtracts at `from` and adds the same quantity at `to`",
      },
      {
        source: ["lines", "location"],
        target: ["store_breakdown", "locations", "quantity"],
        transform:
          "− at the source location, + at the destination. Each location's owning store, name and default flag are read from the locations/stores documents, so a transfer cannot claim a store that does not own the shelf (#307).",
      },
      {
        source: [],
        target: ["query_by_uid_location"],
        transform: "rebuilt from the post-transfer store_breakdown",
      },
    ],
  },
  {
    id: "create-store-transfer:transaction-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant:
      "Both endpoints of every line rewrite their location document's per-product quantity in ONE staging pass. A transfer whose two ends are the SAME location composes to a net zero on that document instead of the second leg overwriting the first — which is what needed the absorb-between-legs dance when the two ends were two documents.",
    transaction: "create-store-transfer",
    fields: [
      {
        source: ["lines", "location"],
        target: ["products", "quantity"],
        transform: "−quantity at the line's `from` location, +quantity at its `to`",
      },
      {
        source: ["uid_product"],
        target: ["query_by_products"],
        transform: "adds the product uid if missing",
      },
    ],
  },
];

export const createStoreTransferTransaction: TransactionDefinition = {
  id: "create-store-transfer",
  description:
    "Moves stock between stores/locations as a single `transfer` movement whose lines pair each source location with a destination, applying them to the ledger (net zero on quantity_held) and rewriting the affected location documents. Deliberately touches neither stock-summaries (a transfer changes no availability answer) nor the cost basis (it has no cost object to mis-gate).",
  steps: [
    "create-store-transfer:transaction-to-ledger",
    "create-store-transfer:transaction-to-locations",
  ],
};
