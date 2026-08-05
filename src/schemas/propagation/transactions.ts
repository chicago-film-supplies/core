/**
 * Movement propagation rules — create-transaction + reverse-transaction.
 *
 * A movement is an **event**, so the two transactions here are the only two that
 * exist: you append one, or you append the one that negates it. There is no
 * `update-transaction` definition any more — the old one described a three-branch
 * reverse-then-reapply that undid a document's ledger and location contribution
 * and wrote a new one in its place, and that whole shape is gone. What survives of
 * `PUT /transactions/{uid}` writes `reference` on the movement document and
 * nothing else, which propagates nowhere and therefore has nothing to describe.
 *
 * Two rules were deleted rather than repaired:
 *
 *  - `update-transaction:names-to-locations` declared
 *    `{source: ["stores","locations","name"], target: ["name"]}` — a
 *    client-sent location name writing the `locations` document's own name. That
 *    is the bin-rename path an inventory write should never have had; a movement
 *    references a location by uid and touches only its `products[]`.
 *  - `update-transaction:transaction-to-{ledger,locations}` described the
 *    reverse-then-reapply. `reverse-transaction` below replaces it, and the
 *    difference is the point: a reversal is not a corrective pass that has to
 *    mirror the forward pass by hand (that mirroring is what #284 was), it is a
 *    movement whose lines are the original's swapped, applied forward through the
 *    same fold.
 *
 * Traced from: api-cloudrun/src/services/transactions.ts
 */
import type { CollectionRule, EnforcementRef, TransactionDefinition } from "./types.ts";
import { stockSummaryRules, stockSummarySteps } from "./stock-summaries.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// The applier is one function, so both transactions and both edges are checked
// by the same three things. ⚠️ `audit-location-defaults.ts` looks like it owns
// the locations edge and does NOT: it never reads `transactions` at all, though
// its own header and `lib/locationIntegrity.ts` both claim it does. It is
// deliberately not cited here.

/**
 * The fold's own suite, and it covers the ledger invariant clause for clause —
 * including the two that read as design notes rather than behaviours (a
 * transfer cannot touch the basis; in_service and out_of_service partition
 * held). The cost clause rests on a 200k-draw sweep against exact rational
 * arithmetic, with a fail-closed companion that sweeps the average-then-multiply
 * form and asserts it DISAGREES.
 */
const MOVEMENT_FOLD: EnforcementRef = {
  kind: "test",
  ref: "core/tests/movements.test.ts",
  clause:
    "the whole ledger fold — conservation with no cross-line term, the weighted-average share removed on a cost-bearing decrease (`costOfUnits` over 200k random draws + its fail-closed companion), a transfer leaving the basis exactly where it was (#286), the store/location identity stamped from the documents rather than the movement (#307), and `in_service`/`out_of_service` partitioning `held`",
  gates: true,
};

/** The reversal's own identity, asserted on the negation itself. */
const REVERSAL_IS_THE_NEGATION: EnforcementRef = {
  kind: "test",
  ref: "core/tests/movements.test.ts:82",
  clause:
    "the `lines ARE the original's, swapped` half — `negateLines` swaps both sides and is its own inverse, and a reversal exactly cancels the original's held delta. This is what makes `applied FORWARD through the same fold` true rather than aspirational.",
  gates: true,
};

const MOVEMENT_LOCATION_STAGING: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/movementApplier.test.ts:176",
  clause:
    "the locations edge — the product row moves by the line's signed quantity, staging never rewrites name/type/default, an unknown location throws rather than being created, and two lines on one location compose into ONE staged write (#287). Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const REVERSAL_LOCATIONS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/transactions/reversalLocations.test.ts:75",
  clause:
    "the reversal's locations clause end-to-end — every touched shelf returns to its prior count, stock may be pulled back OUT of a deactivated bin, stock may never be placed INTO one, and a uid-drifted location doc is repointed rather than wedged shut",
  gates: true,
};

/**
 * ⚠️ GATES ONLY UNDER `--strict` — `failed = strict && findings.length > 0`, so
 * the default run exits 0 while printing, against a standing baseline of 39
 * prod / 36 dev ledgers that have never reconciled.
 */
const LEDGER_REPLAY: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-ledger-replay.ts:238",
  clause:
    "the corpus half of `the ledger is a fold over the journal` — replays every product's movements through `applyMovementToLedger` into an empty ledger and diffs against what is stored. Exits non-zero ONLY with `--strict`; the default run exits 0 against a standing baseline of 39 prod / 36 dev non-reconciling ledgers.",
  gates: false,
};

const LEDGER_NON_NEGATIVE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/movementApplier.test.ts:232",
  clause:
    "the `assertLedgerNonNegative` half — the assertion rejects an oversell at every level (held, in-service, per-store, per-location)",
  gates: true,
};

/** The ledger edge, shared by the forward and the reversing transaction. */
function ledgerRule(
  transactionId: string,
  invariant: string,
  enforced_by: EnforcementRef[],
): CollectionRule {
  return {
    id: transactionId + ":transaction-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant,
    enforced_by,
    transaction: transactionId,
    fields: [
      {
        source: ["lines"],
        target: ["quantity_held"],
        transform:
          "Σ per line of (location.to ? +quantity : 0) + (location.from ? −quantity : 0) — conservation is structural, so a half-move is inexpressible",
      },
      {
        source: ["lines"],
        target: ["quantity_in_service"],
        transform: "units whose place is a locations doc or a booking",
      },
      {
        source: ["lines"],
        target: ["quantity_out_of_service"],
        transform: "units whose place is an out-of-service record",
      },
      {
        source: ["lines"],
        target: ["out_of_service_breakdown"],
        transform: "keyed by the OOS record's reason, supplied by the caller",
      },
      {
        source: ["cost", "amount"],
        target: ["total_cost_basis"],
        transform:
          "an increase adds the supplied acquisition cost; a cost-bearing decrease removes the weighted-average share captured BEFORE the quantity moves, in integer cents. A type whose contract forbids cost never touches the basis — which is why a transfer cannot corrupt it (#286)",
      },
      {
        source: ["cost", "amount"],
        target: ["average_unit_cost"],
        transform: "total_cost_basis ÷ quantity_held, rounded half-up once, at the end",
      },
      {
        source: ["lines", "location"],
        target: ["store_breakdown", "locations", "quantity"],
        transform:
          "± per line endpoint. The owning store, its name and its default flag are READ from the locations/stores documents, never from the movement — so ledger and location cannot disagree (#307)",
      },
      {
        source: [],
        target: ["query_by_uid_store"],
        transform: "rebuilt from the resulting store_breakdown",
      },
      {
        source: [],
        target: ["query_by_uid_location"],
        transform: "rebuilt from the resulting store_breakdown",
      },
    ],
  };
}

/** The locations edge, shared by the forward and the reversing transaction. */
function locationsRule(
  transactionId: string,
  invariant: string,
  enforced_by: EnforcementRef[],
): CollectionRule {
  return {
    id: transactionId + ":transaction-to-locations",
    source: "transactions",
    target: "locations",
    mode: "co-write",
    invariant,
    enforced_by,
    transaction: transactionId,
    fields: [
      { source: ["uid_product"], target: ["products", "uid"] },
      {
        source: [],
        target: ["products", "name"],
        transform: "product name looked up from the product doc",
      },
      {
        source: ["lines", "location"],
        target: ["products", "quantity"],
        transform: "+quantity at the line's `to` location, −quantity at its `from`",
      },
      {
        source: ["uid_product"],
        target: ["query_by_products"],
        transform: "adds the product uid if missing",
      },
    ],
  };
}

export const createTransactionRules: CollectionRule[] = [
  ledgerRule(
    "create-transaction",
    "Every movement immediately folds onto the ledger: quantity from its lines, cost from its cost object. The ledger is the source of truth for current stock levels, and it is a fold over the journal rather than a separately-maintained total.",
    [MOVEMENT_FOLD, LEDGER_NON_NEGATIVE, LEDGER_REPLAY],
  ),
  locationsRule(
    "create-transaction",
    "Locations track which products sit on which shelf. A movement writes ONLY products[]/query_by_products/updated_at — never name, active, default, uid_location_type or the capacities, which belong to createLocation/updateLocation. A movement cannot create a location either: it references one by uid, and a missing one is a 404.",
    [MOVEMENT_LOCATION_STAGING],
  ),
  ...stockSummaryRules(
    "create-transaction",
    "A movement that moves quantity_held (a pure placement move, which leaves quantity_held untouched, skips the rebuild)",
  ),
];

export const createTransactionTransaction: TransactionDefinition = {
  id: "create-transaction",
  description:
    "Appends a movement to the journal, folds its lines onto the inventory ledger and the location documents, and rebuilds the product's stock summary when quantity_held actually moved. The document id is the derived {uid_session}|{type}|{subject}, so a retried create resolves to the same document instead of appending a second event.",
  steps: [
    "create-transaction:transaction-to-ledger",
    "create-transaction:transaction-to-locations",
    ...stockSummarySteps("create-transaction"),
  ],
};

// ── Reverse transaction ─────────────────────────────────────────

export const reverseTransactionRules: CollectionRule[] = [
  ledgerRule(
    "reverse-transaction",
    "A reversal restores the ledger exactly, because its lines ARE the original's with `from` and `to` swapped and its cost is the basis the applier actually moved (not the number the operator typed). It is applied FORWARD through the same fold — there is no reversing code path to keep in step with the forward one.",
    [REVERSAL_IS_THE_NEGATION, MOVEMENT_FOLD, LEDGER_REPLAY],
  ),
  locationsRule(
    "reverse-transaction",
    "The negated lines put the units back on the shelves they came from. An outbound side may name a deactivated bin: pulling stock out of a dead or mis-stored location is exactly the corrective action, so only an INBOUND side into an inactive location is rejected.",
    [REVERSAL_LOCATIONS, MOVEMENT_LOCATION_STAGING],
  ),
  ...stockSummaryRules(
    "reverse-transaction",
    "A reversal that moves quantity_held (reversing a pure placement move leaves quantity_held untouched and skips the rebuild)",
  ),
];

export const reverseTransactionTransaction: TransactionDefinition = {
  id: "reverse-transaction",
  description:
    "Negates a movement by appending a new one whose lines are the original's, swapped. The original document is never touched — that is the difference between a journal and an editable ledger. Nothing about the effect is client-supplied, so a reversal cannot silently disagree with what it reverses; the caller supplies only a session, a reference and an optional date.",
  steps: [
    "reverse-transaction:transaction-to-ledger",
    "reverse-transaction:transaction-to-locations",
    ...stockSummarySteps("reverse-transaction"),
  ],
};
