/**
 * Store-transfer propagation rules — create-store-transfer and put-away.
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
 * **A transfer deliberately has NO stock rule, and that is the point.**
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
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────

/**
 * "Net to ZERO by construction" is checked as construction, not as a number:
 * every transfer line carries BOTH endpoints, so the fold's `+to −from` sums to
 * zero for any quantity. The tests pin the two ways that could stop being true.
 */
const TRANSFER_NETS_TO_ZERO: EnforcementRef = {
  kind: "test",
  ref:
    "core/tests/movements.test.ts::a transfer leaves the basis exactly where it was (#286 defect 1)",
  clause:
    "the `neither creates nor destroys` half — a transfer leaves the basis exactly where it was (#286 defect 1) and a full-quantity transfer through `held = 0` preserves it (defect 2); upstream, a line that moves rather than enters or leaves ownership contributes nothing to the held delta",
  gates: true,
};

const TRANSFER_PAIRS_WHOLE_LINES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/unit/movementApplier.test.ts::a transfer pairs both sides into whole lines and rejects an imbalance",
  clause:
    "the `every line carries both endpoints` half — the writer pairs both sides into whole lines and REJECTS an imbalance, which is what makes the net-zero structural rather than incidental. Its end-to-end twin is `api-cloudrun/tests/integration/transactions/createStoreTransfer.test.ts`, steps `creates ONE transfer movement carrying both endpoints` and `rejects a transfer whose two sides disagree on quantity`.",
  gates: true,
};

const TRANSFER_NON_NEGATIVE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/unit/movementApplier.test.ts::assertLedgerNonNegative rejects an oversell at every level",
  clause:
    "the `assertLedgerNonNegative still runs` half — the assertion rejects an oversell at every level, so a transfer drawing more than a source shelf holds is refused",
  gates: true,
};

/**
 * The same-location degenerate case — the one the two-document shape needed an
 * absorb-between-legs dance for — is asserted on both sides of the fold.
 */
const TRANSFER_SAME_LOCATION_COMPOSES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/unit/movementApplier.test.ts::two lines on one location compose into ONE staged write (#287)",
  clause:
    "the `ONE staging pass, same location composes to net zero` half — two lines on one location compose into ONE staged write (#287), and in the ledger fold two lines naming the same location sum rather than collide, in `core/tests/movements.test.ts::two lines naming the same location sum rather than collide (#287)`",
  gates: true,
};

const createStoreTransferRules: CollectionRule[] = [
  {
    id: "create-store-transfer:transaction-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant:
      "quantity_held and quantity_in_service net to ZERO by construction — every line carries both endpoints, so a transfer moves stock and can neither create nor destroy it. Only store_breakdown actually moves. assertLedgerNonNegative still runs: a transfer taking more than a source location holds is rejected, because a shelf cannot go to −4 units.",
    enforced_by: [
      TRANSFER_NETS_TO_ZERO,
      TRANSFER_PAIRS_WHOLE_LINES,
      TRANSFER_NON_NEGATIVE,
    ],
    transaction: "create-store-transfer",
    fields: [
      {
        source: ["lines"],
        target: ["quantity_held"],
        transform:
          "net zero — each line subtracts at `from` and adds the same quantity at `to`",
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
    enforced_by: [TRANSFER_SAME_LOCATION_COMPOSES],
    transaction: "create-store-transfer",
    fields: [
      {
        source: ["lines", "location"],
        target: ["products", "quantity"],
        transform:
          "−quantity at the line's `from` location, +quantity at its `to`",
      },
      {
        source: ["uid_product"],
        target: ["query_by_products"],
        transform: "adds the product uid if missing",
      },
    ],
  },
];

const createStoreTransferTransaction: TransactionDefinition = {
  id: "create-store-transfer",
  description:
    "Moves stock between stores/locations as a single `transfer` movement whose lines pair each source location with a destination, applying them to the ledger (net zero on quantity_held) and rewriting the affected location documents. Deliberately touches neither `stock` (a transfer changes no availability answer) nor the cost basis (it has no cost object to mis-gate).",
  steps: [
    "create-store-transfer:transaction-to-ledger",
    "create-store-transfer:transaction-to-locations",
  ],
};

// ── put-away ───────────────────────────────────────────────────────
//
// Every arrival (a check-in, a damaged return, a unit back from a vendor)
// lands on its store's DEFAULT location, where it is counted and checked;
// a put-away is the separate step that shelves it (owner, 2026-09-27). Its
// unflagged units are an ordinary `transfer`. A record's FLAGGED units move as
// a `flag {r → r}` whose two ends differ, so the flag travels with the unit —
// and the record's derived `stores[]` follows it. Like a transfer it nets to
// zero on `quantity_held` and changes no availability answer, so it has no
// stock rule either.

const PUT_AWAY_UNFLAGGED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/locations/putAway.test.ts::put-away of unflagged units is one transfer, net zero on quantity_held",
  clause:
    "the unflagged half — one `transfer` whose lines pair the source location with each destination, leaving `quantity_held` unchanged",
  gates: true,
};

const PUT_AWAY_CARRIES_FLAG: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/locations/putAway.test.ts::put-away of a record's flagged units carries the flag to the destination",
  clause:
    "the flagged half — a `flag {r → r}` with `from ≠ to` moves the per-location `quantity_out_of_service` with the units, leaves the ledger's out-of-service total unchanged, and re-derives the record's `stores[]`",
  gates: true,
};

const FLAG_NEVER_STRANDED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/locations/putAway.test.ts::a plain transfer that would strand a flag is refused",
  clause:
    "the refusal half — `assertLedgerNonNegative` refuses any movement leaving a location with more flagged units than units, so a flagged unit can only move by a put-away",
  gates: true,
};

const putAwayRules: CollectionRule[] = [
  {
    id: "put-away:transaction-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant:
      "quantity_held and quantity_in_service net to ZERO — every line carries both endpoints. Unflagged units move by a `transfer`; a record's flagged units by a `flag {r → r}` whose ends differ, which moves each location's quantity_out_of_service with its units. No location may end holding more flagged units than units.",
    enforced_by: [PUT_AWAY_UNFLAGGED, PUT_AWAY_CARRIES_FLAG, FLAG_NEVER_STRANDED],
    transaction: "put-away",
    fields: [
      {
        source: ["lines", "location"],
        target: ["store_breakdown", "locations", "quantity"],
        transform: "− at the source location, + at each destination",
      },
      {
        source: ["service"],
        target: ["store_breakdown", "locations", "quantity_out_of_service"],
        transform: "a flag line moves its flagged count from the source location to the destination",
      },
    ],
  },
  {
    id: "put-away:transaction-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant:
      "Both endpoints of every line rewrite their location document's per-product quantity in ONE staging pass, exactly as a transfer does.",
    enforced_by: [PUT_AWAY_UNFLAGGED],
    transaction: "put-away",
    fields: [
      {
        source: ["lines", "location"],
        target: ["products", "quantity"],
        transform: "−quantity at the line's `from` location, +quantity at its `to`",
      },
    ],
  },
  {
    id: "put-away:transaction-to-out-of-service",
    source: "transactions",
    target: "out-of-service",
    mode: "co-write",
    invariant:
      "A record whose flagged units moved has its `stores[]` re-derived from its journal in the same commit, and its `version` bumped. Fires only when a line names a record.",
    enforced_by: [PUT_AWAY_CARRIES_FLAG],
    transaction: "put-away",
    fields: [
      {
        source: ["lines", "location"],
        target: ["stores"],
        transform: "re-derived from where the record's flagged units now stand",
      },
    ],
  },
];

const putAwayTransaction: TransactionDefinition = {
  id: "put-away",
  description:
    "Shelves one product's units off a location — typically the store's default location, where every arrival lands. Unflagged units move as one `transfer`; each named out-of-service record's flagged units move as a `flag {r → r}` with different ends, carrying the flag. Touches neither `stock` (no availability answer changes) nor the cost basis.",
  steps: [
    "put-away:transaction-to-ledger",
    "put-away:transaction-to-locations",
    "put-away:transaction-to-out-of-service",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/store-transfers.ts` contributes to the propagation catalog. */
export const storeTransfers: PropagationModule = {
  rules: [
    ...createStoreTransferRules,
    ...putAwayRules,
  ],
  transactions: [
    createStoreTransferTransaction,
    putAwayTransaction,
  ],
};
