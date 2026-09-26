/**
 * Out-of-service propagation rules.
 *
 * `create-out-of-service-record` — direct admin POST or born from a booking
 * update (warehouse marks items lost/damaged on check-in). Cowrites a default
 * thread; rebuilds the product's stock projection (`buildStockSummary`), which
 * re-derives `out_of_service[]` from the live non-terminal records.
 *
 * `update-out-of-service-record` — operator/system PUT moves units between
 * `breakdown` buckets, sets `dates.end`, or cancels the record. Top-level
 * `status` is server-derived from `breakdown` + `number` + `canceled_at`
 * (only `"canceled"` is operator-set). When the derived status reaches
 * `"complete"` and `breakdown.returned_to_service > 0` or
 * `breakdown.written_off > 0`, an inventory transaction is cowritten so the
 * ledger movement is the same source of truth any other manual transaction
 * would produce. Per the OOS lifecycle, the booking that originated the loss
 * is NOT updated — the booking already records the loss in its own
 * breakdown.
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";
import { STOCK_STEPS } from "./stock.ts";

// ── What checks these rules ─────────────────────────────────────────

/**
 * ⚠️ The 0..N `sources` shape is asserted at its two ENDS and not in the
 * middle. The empty (ad-hoc) case is asserted directly on a create, and the
 * two-source case falls out of the booking path that mints records with
 * `[bookings, orders]`. The `[orders]` manually-attached case is asserted
 * nowhere, and nothing walks the corpus for `query_by_sources` disagreeing with
 * `sources`.
 */
const OOS_SOURCES_SHAPE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts::POST /out-of-service-records — creates record + thread",
  clause:
    "the EMPTY end — an ad-hoc create stores `sources: []` and `query_by_sources: []`, plus the derived `status`/`breakdown`/`uid_thread`. The two-source end comes from the booking path (`bookings.test.ts::returns 1 + loses 1 + damages 1 → cowrites two OOS records and auto-completes order`); the one-source `[orders]` case and the sources↔query_by_sources parity are unchecked.",
  gates: true,
};

/**
 * The cowrite itself, asserted end-to-end on a real PUT: the movement exists
 * exactly once, carries the right type and quantity, links back through
 * `query_by_sources`, and draws FROM the shelf rather than from the record.
 */
const OOS_COWRITES_MOVEMENT: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts::PUT — moves all units to written_off (derives complete) → cowrites write_off transaction",
  clause:
    "the WRITE-OFF arm — deriving `complete` cowrites exactly one `write_off` movement for the full quantity, linked by `query_by_sources`, drawing `from` a locations doc with `to: null`. The `return-to-service` arm of the same rule is not asserted.",
  gates: true,
};

/**
 * The ledger consequence is the applier's, and its own suite states this
 * invariant almost verbatim.
 */
const OOS_LEDGER_PARTITION: EnforcementRef = {
  kind: "test",
  ref:
    "core/tests/movements.test.ts::units at an OOS record leave service without leaving ownership",
  clause:
    "the ledger half — units at an OOS record leave service without leaving ownership, returning to service restores the in-service count, and `in_service`/`out_of_service` always partition `held`",
  gates: true,
};

const createOutOfServiceRules: CollectionRule[] = [
  {
    id: "create-out-of-service-record:sources-to-record",
    source: "out-of-service",
    target: "out-of-service",
    mode: "co-write",
    invariant:
      "Sources are a 0..N polymorphic list ({collection, uid, label}) — empty for ad-hoc, [orders] for manually-attached, [bookings, orders] when born from a booking PUT. query_by_sources is rebuilt from sources on every write for Firestore array-contains filtering.",
    enforced_by: [OOS_SOURCES_SHAPE],
    transaction: "create-out-of-service-record",
    fields: [
      {
        source: [],
        target: ["sources"],
        transform:
          "from input — caller supplies up to N {collection, uid, label} entries",
      },
      {
        source: ["sources"],
        target: ["query_by_sources"],
        transform: "sources.map(s => `${s.collection}:${s.uid}`)",
      },
      { source: [], target: ["uid_product"] },
      { source: [], target: ["reason"] },
      { source: [], target: ["quantity"] },
      { source: [], target: ["dates", "start"] },
    ],
  },
  {
    id: "create-out-of-service-record:record-to-transactions",
    source: "out-of-service",
    target: "transactions",
    mode: "co-write",
    invariant:
      "A record that is in effect (a pinned start) is born from ONE movement written in the same batch: a `flag` `{null → reason}` on the shelves its units are on for damaged/cleaning/maintenance, a `send_away` `{null → lost}` off the shelf for lost. The record takes that movement's id and number — no movement, no record — so a retried create with the same uuid_session lands on the same id. A record not yet in effect (future start) writes no movement: its units are still in service, and its window is reserved on stock/{P} through the record.",
    enforced_by: [OOS_COWRITES_MOVEMENT],
    transaction: "create-out-of-service-record",
    fields: [
      { source: ["uid_product"], target: ["uid_product"] },
      { source: ["quantity"], target: ["quantity"] },
      {
        source: ["reason"],
        target: ["service", "to"],
        transform: "the record's reason — flag for a flag reason, send_away for lost",
      },
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "the movement's sources[] names the record; the record's uid IS the movement's id",
      },
      {
        source: ["stores"],
        target: ["lines"],
        transform: "the record's stores[] is DERIVED from these lines, never typed by an operator",
      },
    ],
  },
  {
    id: "create-out-of-service-record:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "derive",
    invariant:
      "The born-with movement folds through the one ledger writer: a flag moves out_of_service_breakdown[reason] and the shelf's quantity_out_of_service; a send_away takes the units off the shelf and counts them at the record. quantity_held does not move either way.",
    enforced_by: [OOS_LEDGER_PARTITION],
    transaction: "create-out-of-service-record",
    fields: [
      {
        source: ["quantity"],
        target: ["quantity_out_of_service"],
        transform: "+ quantity, filed under the reason",
      },
      {
        source: ["quantity"],
        target: ["quantity_in_service"],
        transform: "− quantity",
      },
    ],
  },
];

const createOutOfServiceTransaction: TransactionDefinition = {
  id: "create-out-of-service-record",
  description:
    "Creates an out-of-service record from the movement that puts its units out of service (a flag on the shelf, or a send_away to the record for a loss), rebuilds the affected product's `stock/{P}` projection, and cowrites a default thread for the record. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Creating an OOS record.",
  steps: [
    "create-out-of-service-record:sources-to-record",
    "create-out-of-service-record:record-to-transactions",
    "create-out-of-service-record:transactions-to-ledger",
    ...STOCK_STEPS,
    "cowrite-thread:out-of-service-to-thread",
    "cowrite-thread:thread-to-out-of-service",
  ],
};

const updateOutOfServiceRules: CollectionRule[] = [
  {
    id: "update-out-of-service-record:record-to-transactions",
    source: "out-of-service",
    target: "transactions",
    mode: "co-write",
    invariant:
      "Each bucket change is posted in the save that makes it, as the movement that makes it true, read against the record's journal so only the DIFFERENCE is written: into `flagged` a flag {null → reason}; flagged → `away` a send_away; `away` → `returned_to_service` a return_to_service; flagged → `returned_to_service` a clearing flag {reason → null}; into `written_off` a write_off (from the record for away units, from the shelf for flagged ones, clearing their flag); out of `written_off` a reversal. A `reason` edit among damaged/cleaning/maintenance is a flag {old → new}. Every movement names the record in sources[].",
    enforced_by: [OOS_COWRITES_MOVEMENT],
    transaction: "update-out-of-service-record",
    fields: [
      { source: ["uid_product"], target: ["uid_product"] },
      {
        source: ["breakdown", "flagged"],
        target: ["service"],
        transform: "units entering or leaving flagged move a shelf flag",
      },
      {
        source: ["breakdown", "away"],
        target: ["lines"],
        transform: "units entering away leave the shelf for the record; leaving it, they come back",
      },
      {
        source: ["breakdown", "returned_to_service"],
        target: ["quantity"],
        transform: "a return_to_service or a clearing flag, sized by the journal",
      },
      {
        source: ["breakdown", "written_off"],
        target: ["quantity"],
        transform: "a write_off, or a reversal of one, sized by the journal",
      },
      {
        source: ["reason"],
        target: ["service", "to"],
        transform: "an in-place reason edit is a flag {old → new}",
      },
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "the movement's sources[] points back at the OOS record",
      },
    ],
  },
  {
    id: "update-out-of-service-record:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "derive",
    invariant:
      "Cowritten movements fold through the one ledger writer — applyMovementToLedger moves quantity_held (a write-off only), the per-reason out_of_service_breakdown, the shelf's quantity_out_of_service, and quantity_in_service = held − out of service.",
    enforced_by: [OOS_LEDGER_PARTITION],
    transaction: "update-out-of-service-record",
    fields: [
      {
        source: ["quantity"],
        target: ["quantity_held"],
        transform: "± based on transaction type multiplier",
      },
      {
        source: ["quantity"],
        target: ["quantity_in_service"],
        transform: "+ for a return to service or a cleared flag; − for a new flag",
      },
      {
        source: ["quantity"],
        target: ["quantity_out_of_service"],
        transform:
          "the sum of out_of_service_breakdown, which each movement's service axis moves",
      },
    ],
  },
];

const updateOutOfServiceTransaction: TransactionDefinition = {
  id: "update-out-of-service-record",
  description:
    "Updates an out-of-service record. Every bucket change and in-place reason edit is posted as the movement that makes it true (flag, send_away, return_to_service, write_off, or a reversal), which cascades through the one ledger writer and the stock update path. No back-propagation to the originating booking — the booking already records the loss in its own breakdown. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Any OOS quantity/date/status change — including a cancel, which drops the record from the array entirely.",
  steps: [
    ...STOCK_STEPS,
    "update-out-of-service-record:record-to-transactions",
    "update-out-of-service-record:transactions-to-ledger",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/out-of-service.ts` contributes to the propagation catalog. */
export const outOfService: PropagationModule = {
  rules: [
    ...createOutOfServiceRules,
    ...updateOutOfServiceRules,
  ],
  transactions: [
    createOutOfServiceTransaction,
    updateOutOfServiceTransaction,
  ],
};
