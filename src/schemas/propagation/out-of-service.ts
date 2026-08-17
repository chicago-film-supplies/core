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
  ref: "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts:32",
  clause:
    "the EMPTY end — an ad-hoc create stores `sources: []` and `query_by_sources: []`, plus the derived `status`/`breakdown`/`uid_thread`. The two-source end comes from the booking path (bookings.test.ts:211, which cowrites two records); the one-source `[orders]` case and the sources↔query_by_sources parity are unchecked.",
  gates: true,
};

/**
 * The cowrite itself, asserted end-to-end on a real PUT: the movement exists
 * exactly once, carries the right type and quantity, links back through
 * `query_by_sources`, and draws FROM the shelf rather than from the record.
 */
const OOS_COWRITES_MOVEMENT: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts:157",
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
  ref: "core/tests/movements.test.ts:515",
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
    invariant: "Sources are a 0..N polymorphic list ({collection, uid, label}) — empty for ad-hoc, [orders] for manually-attached, [bookings, orders] when born from a booking PUT. query_by_sources is rebuilt from sources on every write for Firestore array-contains filtering.",
    enforced_by: [OOS_SOURCES_SHAPE],
    transaction: "create-out-of-service-record",
    fields: [
      { source: [], target: ["sources"], transform: "from input — caller supplies up to N {collection, uid, label} entries" },
      { source: ["sources"], target: ["query_by_sources"], transform: "sources.map(s => `${s.collection}:${s.uid}`)" },
      { source: [], target: ["uid_product"] },
      { source: [], target: ["reason"] },
      { source: [], target: ["quantity"] },
      { source: [], target: ["dates", "start"] },
      { source: [], target: ["stores"] },
    ],
  },
];

const createOutOfServiceTransaction: TransactionDefinition = {
  id: "create-out-of-service-record",
  description: "Creates an out-of-service record, rebuilds the affected product's `stock/{P}` projection, and cowrites a default thread for the record. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Creating an OOS record.",
  steps: [
    "create-out-of-service-record:sources-to-record",
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
    invariant: "Once derived status === 'complete' (breakdown.returned_to_service + breakdown.written_off === quantity), cowrite an inventory transaction in the same Firestore transaction — a 'return-to-service' for breakdown.returned_to_service > 0 and/or a 'write-off' for breakdown.written_off > 0. Each cowritten transaction follows the standard create-transaction rules (ledger update + locations update + stock recalc).",
    enforced_by: [OOS_COWRITES_MOVEMENT],
    transaction: "update-out-of-service-record",
    fields: [
      { source: ["uid_product"], target: ["uid_product"] },
      { source: ["breakdown", "returned_to_service"], target: ["quantity"], transform: "if > 0, build a return-to-service transaction" },
      { source: ["breakdown", "written_off"], target: ["quantity"], transform: "if > 0, build a write-off transaction" },
      { source: ["stores"], target: ["stores"], transform: "store/location allocation copied from oos.stores" },
      { source: ["uid"], target: ["source", "uid"], transform: "transaction.source points back at the OOS record" },
    ],
  },
  {
    id: "update-out-of-service-record:transactions-to-ledger",
    source: "transactions",
    target: "inventory-ledgers",
    mode: "derive",
    invariant: "Cowritten transactions cascade through the standard create-transaction:transaction-to-ledger path — applyTransactionToLedger updates quantity_held / quantity_in_service / quantity_out_of_service.",
    enforced_by: [OOS_LEDGER_PARTITION],
    transaction: "update-out-of-service-record",
    fields: [
      { source: ["quantity"], target: ["quantity_held"], transform: "± based on transaction type multiplier" },
      { source: ["quantity"], target: ["quantity_in_service"], transform: "+ for return-to-service; − for write-off" },
      { source: ["quantity"], target: ["quantity_out_of_service"], transform: "− on either return-to-service or write-off (the OOS bucket empties)" },
    ],
  },
];

const updateOutOfServiceTransaction: TransactionDefinition = {
  id: "update-out-of-service-record",
  description: "Updates an out-of-service record. Quantity changes rebuild the product's `stock/{P}` projection. When derived status reaches 'complete' with non-zero breakdown.returned_to_service or breakdown.written_off, cowrite the corresponding inventory transactions, which cascade through the ledger and stock update path. No back-propagation to the originating booking — the booking already records the loss in its own breakdown. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Any OOS quantity/date/status change — including a cancel, which drops the record from the array entirely.",
  steps: [
    ...STOCK_STEPS,
    "update-out-of-service-record:record-to-transactions",
    "update-out-of-service-record:transactions-to-ledger",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `out-of-service.ts` contributes to the propagation catalog. */
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
