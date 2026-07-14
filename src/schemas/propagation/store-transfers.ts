/**
 * Store-transfer propagation rules — create-store-transfer + update-store-transfer.
 *
 * A store transfer moves units between stores/locations. It is written as a
 * **pair** of inventory transactions sharing one transfer number — a
 * `transfer_decrease` leg out of the source and a `transfer_increase` leg into
 * the destination — applied to the ledger back-to-back.
 *
 * **These transactions deliberately have NO stock-summary rule, and that is the
 * point.** The pair nets to exactly zero on the ledger's scalars: the same
 * `quantity` leaves and arrives, so `quantity_held` is unchanged by
 * construction. The stock summary embeds `quantity_held` and `type` and nothing
 * else about placement — no `store_breakdown` — so a transfer cannot change any
 * availability answer, and rebuilding the summary would be pure write
 * amplification on the hottest doc in the system. What a transfer *does* change
 * (which shelf the units sit on) lives on `inventory-ledgers` and `locations`,
 * which is exactly where the manager reads it from.
 *
 * These definitions exist because store transfers previously had no propagation
 * rules and no `logTransactionPropagation` call at all — they wrote the ledger,
 * the locations and two transaction docs entirely off the propagation graph.
 *
 * Traced from: api-cloudrun/src/services/storeTransfers.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

export const createStoreTransferRules: CollectionRule[] = [
  {
    id: "create-store-transfer:transfer-to-transactions",
    source: "transactions",
    target: "transactions",
    mode: "co-write",
    invariant: "A transfer is two transaction docs written atomically: a `transfer_decrease` leg carrying stores_from and a `transfer_increase` leg carrying stores_to. They share one number allocated from counters/transactions, and each leg's source.uid points at the other, so either leg can find its partner.",
    transaction: "create-store-transfer",
    fields: [
      { source: ["stores_from"], target: ["stores"], transform: "the transfer_decrease leg" },
      { source: ["stores_to"], target: ["stores"], transform: "the transfer_increase leg" },
      { source: ["quantity"], target: ["quantity"], transform: "both legs move the same quantity — enforced by assertQuantityMatchesLocations on each side" },
      { source: [], target: ["source", "number"], transform: "one number for both legs, allocated after the last read" },
      { source: [], target: ["source", "uid"], transform: "each leg points at the other leg's uid" },
    ],
  },
  {
    id: "create-store-transfer:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "Both legs are applied to the ledger in one transaction. quantity_held and quantity_in_service net to ZERO (equal and opposite multipliers) — a transfer moves stock, it never creates or destroys it. Only store_breakdown actually moves. assertLedgerNonNegative still runs: a transfer that takes more than a source location holds is rejected, because a shelf cannot go to −4 units.",
    transaction: "create-store-transfer",
    fields: [
      { source: ["quantity"], target: ["quantity_held"], transform: "net zero — −quantity (decrease leg) then +quantity (increase leg)" },
      { source: ["stores", "locations", "transactionQuantity"], target: ["store_breakdown", "locations", "quantity"], transform: "− at the source locations, + at the destination locations" },
      { source: [], target: ["query_by_uid_location"], transform: "rebuilt from the post-transfer store_breakdown" },
    ],
  },
  {
    id: "create-store-transfer:transactions-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant: "Both legs rewrite their location docs' per-product quantities. The outbound leg is staged first and absorbed back into the read set before the inbound leg is staged, so a transfer whose two legs touch the SAME location composes correctly instead of the second leg overwriting the first.",
    transaction: "create-store-transfer",
    fields: [
      { source: ["stores", "locations", "transactionQuantity"], target: ["products", "quantity"], transform: "± per location; outbound staged then absorbed, then inbound staged on top" },
      { source: ["uid_product"], target: ["query_by_products"], transform: "adds the product uid if missing" },
    ],
  },
];

export const createStoreTransferTransaction: TransactionDefinition = {
  id: "create-store-transfer",
  description: "Moves stock between stores/locations by writing a transfer_decrease + transfer_increase transaction pair, applying both to the ledger (net zero on quantity_held) and rewriting the affected location docs. Deliberately does NOT touch stock-summaries — the summary carries no store_breakdown, so a transfer cannot change any availability answer.",
  steps: [
    "create-store-transfer:transfer-to-transactions",
    "create-store-transfer:transactions-to-ledger",
    "create-store-transfer:transactions-to-locations",
  ],
};

// ── update-store-transfer ────────────────────────────────────────

export const updateStoreTransferRules: CollectionRule[] = [
  {
    id: "update-store-transfer:transfer-to-transactions",
    source: "transactions",
    target: "transactions",
    mode: "co-write",
    invariant: "Both legs are located by (uid_product, source.number) — exactly 2 docs must come back or the update aborts. Both are rewritten with the new quantity/date/stores and version-bumped together.",
    transaction: "update-store-transfer",
    fields: [
      { source: ["stores_from"], target: ["stores"], transform: "onto the transfer_decrease leg" },
      { source: ["stores_to"], target: ["stores"], transform: "onto the transfer_increase leg" },
      { source: ["quantity"], target: ["quantity"], transform: "both legs" },
      { source: [], target: ["version"], transform: "version + 1 on both legs (optimistic concurrency, checked on the decrease leg)" },
    ],
  },
  {
    id: "update-store-transfer:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "Unconditional reverse-then-reapply: both original legs are reversed out of the ledger, then both new legs applied. The re-apply is unconditional on purpose — the old `quantity || date changed` gate skipped it for a store/location-only edit, so the reversal stood alone and the new placement was silently discarded. Still net zero on quantity_held.",
    transaction: "update-store-transfer",
    fields: [
      { source: ["quantity"], target: ["quantity_held"], transform: "reverse(both prev legs) then apply(both new legs) — net zero either way" },
      { source: ["stores", "locations", "transactionQuantity"], target: ["store_breakdown", "locations", "quantity"], transform: "reversal of the old placement, then the new placement" },
    ],
  },
  {
    id: "update-store-transfer:transactions-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant: "Four passes over the location docs — reverse old-out, reverse old-in, apply new-out, apply new-in — absorbing each pass back into the read set between EVERY consecutive pass, so the degenerate case (one location appearing in all four legs) composes instead of clobbering (#284).",
    transaction: "update-store-transfer",
    fields: [
      { source: ["stores", "locations", "transactionQuantity"], target: ["products", "quantity"], transform: "revOut → revIn → fwdOut → fwdIn, each absorbed before the next is staged" },
    ],
  },
];

export const updateStoreTransferTransaction: TransactionDefinition = {
  id: "update-store-transfer",
  description: "Edits an existing store transfer: locates both legs by transfer number, reverses the original placement out of the ledger and location docs, and applies the new one. Net zero on quantity_held, so — like create — it deliberately does NOT touch stock-summaries.",
  steps: [
    "update-store-transfer:transfer-to-transactions",
    "update-store-transfer:transactions-to-ledger",
    "update-store-transfer:transactions-to-locations",
  ],
};
