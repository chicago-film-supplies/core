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
 *
 * `reclassify-out-of-service-record` — the one exception: a REASON edit among
 * damaged/cleaning/maintenance on a record a booking's mark opened. The
 * booking's buckets are the condition its units came back in, and the operator
 * is correcting that, so the booking moves with the record (custody-actions
 * gap G3). It runs through the booking lever, so the booking, the record and
 * the flag movement land in one commit. Only the units still FLAGGED on a shelf
 * take the new reason: when some are away, written off or returned to service,
 * the record SPLITS (api-cloudrun#1164) — the original keeps its uid, its old
 * reason and every non-flagged unit as history, and a sibling holds the
 * re-described units. That holds for a standalone record too
 * (`update-out-of-service-record`), where it is the same split by another door.
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
    "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts::POST /out-of-service-records — creates record + thread: damaged in the building is ONE flag, flagged where the units stand",
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
    "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts::PUT — moves all units to written_off (derives complete) → cowrites write_off transaction, relieving the bucket AND the shelf",
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

/**
 * The standalone half of the same split: no booking, so the assertion is the two
 * records and the one flag that names both.
 */
const OOS_SPLIT_STANDALONE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/out-of-service/outOfService.test.ts::PUT — a reason edit on a standalone record with resolved units SPLITS it: only the flagged units take the new reason",
  clause:
    "the original keeps its uid, old reason and the resolved units; a sibling holds the flagged ones under the new reason; ONE flag names [sibling, original]; a save with no flagged unit is refused",
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
      {
        source: ["units"],
        target: ["units"],
        transform:
          "serialized only: the units the record takes, picked from unflagged shelf units (a flag) or named by the booking's mark (a loss)",
      },
      {
        source: ["units"],
        target: ["lines", "units"],
        transform:
          "partitioned across the lines by shelf",
      },
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
    "units:transactions-to-roster",
  ],
};

const updateOutOfServiceRules: CollectionRule[] = [
  {
    id: "update-out-of-service-record:record-to-transactions",
    source: "out-of-service",
    target: "transactions",
    mode: "co-write",
    invariant:
      "Each bucket change is posted in the save that makes it, as the movement that makes it true, read against the record's journal so only the DIFFERENCE is written: into `flagged` a flag {null → reason}; flagged → `away` a send_away; `away` → `returned_to_service` a return_to_service; flagged → `returned_to_service` a clearing flag {reason → null}; into `written_off` a write_off (from the record for away units, from the shelf for flagged ones, clearing their flag); out of `written_off` a reversal. A `reason` edit among damaged/cleaning/maintenance is a flag {old → new} on the FLAGGED units only; when some units are away, written off or returned to service the record SPLITS (see `update-out-of-service-record:record-to-record`). Every movement names the record in sources[].",
    enforced_by: [OOS_COWRITES_MOVEMENT],
    transaction: "update-out-of-service-record",
    fields: [
      {
        source: ["units"],
        target: ["units"],
        transform:
          "serialized only: exactly the units whose bucket changed between the stored sets and the input's — a set is a fact, so the diff guesses nothing",
      },
      {
        source: ["units"],
        target: ["lines", "units"],
        transform:
          "partitioned across the lines by shelf",
      },
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
        transform: "an in-place reason edit is a flag {old → new} on the flagged units, splitting the rest onto the original",
      },
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "the movement's sources[] points back at the OOS record",
      },
    ],
  },
  {
    id: "update-out-of-service-record:record-to-record",
    source: "out-of-service",
    target: "out-of-service",
    mode: "co-write",
    invariant:
      "A `reason` edit on a record with 0 < flagged < quantity SPLITS it: only the units still flagged on a shelf take the new reason, and everything else stays on the ORIGINAL under the old reason as history. The original keeps its uid and its non-flagged units (its quantity falls by the flagged count and its flagged bucket empties); a SIBLING is minted for the flagged units, its uid and number those of the ONE flag movement that re-describes them, and that flag names [sibling, original] in sources[] — the first record receives and the rest give, so a shelf is attributed to the sibling and taken from the original. With flagged equal to quantity the edit stays in place on one record; with none flagged it is refused (no unit is on a shelf to re-describe). A splitting reason edit must come alone in its save.",
    enforced_by: [OOS_SPLIT_STANDALONE],
    transaction: "update-out-of-service-record",
    fields: [
      {
        source: [],
        target: ["units"],
        transform:
          "the input's next sets; a reason edit that splits the record PARTITIONS units.flagged onto the sibling, and the flag {old → new} movement names them",
      },
      {
        source: ["quantity"],
        target: ["quantity"],
        transform: "original.quantity − flagged; the sibling's quantity is the flagged count",
      },
      {
        source: ["breakdown", "flagged"],
        target: ["breakdown", "flagged"],
        transform: "the original's flagged bucket empties; the sibling's holds the flagged count",
      },
      {
        source: ["reason"],
        target: ["reason"],
        transform: "the sibling takes the new reason; the original keeps the old one",
      },
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "the split flag's sources[] names [sibling, original]; the sibling's uid IS that flag's id",
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
    "Updates an out-of-service record. Every bucket change and in-place reason edit is posted as the movement that makes it true (flag, send_away, return_to_service, write_off, or a reversal), which cascades through the one ledger writer and the stock update path. No back-propagation to the originating booking — the booking already records the loss in its own breakdown — except a reason edit on a booking-raised record, which is `reclassify-out-of-service-record`. A reason edit with units already away, written off or returned splits the record. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: Any OOS quantity/date/status change — including a cancel, which drops the record from the array entirely.",
  steps: [
    ...STOCK_STEPS,
    "update-out-of-service-record:record-to-transactions",
    "update-out-of-service-record:record-to-record",
    "update-out-of-service-record:transactions-to-ledger",
    "units:transactions-to-roster",
    "units:transactions-to-units",
  ],
};

// ── reclassify-out-of-service-record (custody-actions gap G3) ────────

/**
 * The delegation, asserted end to end on a real record PUT: the booking's
 * buckets, the flag movement's custody and service, and the record's reason all
 * move in the one commit.
 */
const RECLASSIFY_MOVES_THE_BOOKING: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/out-of-service/reclassify.test.ts::PUT /out-of-service — reclassifying a booking-raised damaged record to cleaning moves the booking damaged → cleaning in one commit",
  clause:
    "the booking reads damaged − q, cleaning + q; ONE flag movement carries custody {damaged → cleaning}, service {damaged → cleaning} and uid_booking, in place on the record's flagged shelves; the record's reason and version move; the ledger's out-of-service total does not",
  gates: true,
};

/**
 * The split, asserted end to end on a real record PUT: cleared and away units
 * stay on the original under the old reason, the flagged ones move to a sibling,
 * and the booking moves by the flagged count only.
 */
const RECLASSIFY_SPLITS_THE_RECORD: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/out-of-service/reclassify.test.ts::PUT /out-of-service — reclassifying a booking-raised record with cleared and away units SPLITS it: only the flagged units take the new reason",
  clause:
    "the original keeps its uid, old reason and the cleared and away units; a sibling holds the flagged ones under the new reason; ONE flag naming [sibling, original] carries the flagged quantity; the booking moves by the flagged count only",
  gates: true,
};

const reclassifyOutOfServiceRules: CollectionRule[] = [
  {
    id: "reclassify-out-of-service-record:record-to-booking",
    source: "out-of-service",
    target: "bookings",
    mode: "co-write",
    invariant:
      "A reason edit among damaged/cleaning/maintenance on a record whose mark movement carries custody on a booking moves that booking's bucket by the record's FLAGGED count (breakdown[old] − q, breakdown[new] + q), written through the booking lever in the same commit as the record and ONE flag {old → new} that carries custody {old → new} and uid_booking. A cleared, written-off or away unit is not re-described (no movement happened to it): when any exist the record SPLITS (`reclassify-out-of-service-record:record-to-record`) and q is the flagged count; with none flagged the edit is refused (400). A record the booking's mark did not open (legacy auto-id, or one POSTed with the booking in sources) never moves the booking.",
    enforced_by: [RECLASSIFY_MOVES_THE_BOOKING],
    transaction: "reclassify-out-of-service-record",
    fields: [
      {
        source: ["units", "flagged"],
        target: ["units"],
        transform:
          "the booking's reclassify_X_to_Y action names the units, which move from the X set to the Y set",
      },
      {
        source: ["reason"],
        target: ["breakdown"],
        transform: "breakdown[old reason] − flagged, breakdown[new reason] + flagged — the flagged count, which is record.quantity only when nothing has been resolved",
      },
      {
        source: ["reason"],
        target: ["version"],
        transform: "the booking lever bumps it, as for any custody change",
      },
    ],
  },
  {
    id: "reclassify-out-of-service-record:record-to-record",
    source: "out-of-service",
    target: "out-of-service",
    mode: "co-write",
    invariant:
      "When 0 < flagged < quantity the record SPLITS in the booking lever's commit: the ORIGINAL keeps its uid, its old reason and every non-flagged unit (away, written off, returned to service), so its journal, its found-after-write-off fold and the invoice lines billing it stay true; a SIBLING takes the flagged units under the new reason, its uid and number those of the reclassify flag. That flag names [sibling, original, order, booking] in sources[], and the first record receives while the rest give — one convention, because an in-place flag nets to nothing on a single record. Billing is advised, never refused: an original billed for more than it now holds raises `oos_overbilled` on that invoice's next save.",
    enforced_by: [RECLASSIFY_SPLITS_THE_RECORD],
    transaction: "reclassify-out-of-service-record",
    fields: [
      {
        source: [],
        target: ["units"],
        transform:
          "a split moves the named flagged units onto the sibling record",
      },
      {
        source: ["quantity"],
        target: ["quantity"],
        transform: "original.quantity − flagged; the sibling's quantity is the flagged count",
      },
      {
        source: ["breakdown", "flagged"],
        target: ["breakdown", "flagged"],
        transform: "the original's flagged bucket empties; the sibling's holds the flagged count",
      },
      {
        source: ["reason"],
        target: ["reason"],
        transform: "the sibling takes the new reason; the original keeps the old one",
      },
      {
        source: ["uid"],
        target: ["sources", "uid"],
        transform: "the flag's sources[] names [sibling, original, order, booking]; the sibling's uid IS the flag's id",
      },
    ],
  },
];

const reclassifyOutOfServiceTransaction: TransactionDefinition = {
  id: "reclassify-out-of-service-record",
  description:
    "A reason edit on a booking-raised out-of-service record, delegated from `PUT /out-of-service/{uid}` to the booking lever so the booking's bucket, the record's reason and the flag movement commit together (a record with resolved units splits, and the sibling is written in the same commit); finalize then recomputes the order roll-up, the fulfillment mirror and the cards. Rebuilds `stock/{P}` via {@link STOCK_STEPS} — fires on: a reason change among damaged/cleaning/maintenance on a record a booking's mark opened.",
  steps: [
    "reclassify-out-of-service-record:record-to-booking",
    "reclassify-out-of-service-record:record-to-record",
    "update-booking:booking-to-self",
    ...STOCK_STEPS,
    "update-booking:booking-to-transactions",
    "update-booking:transactions-to-ledger",
    "update-booking:transactions-to-locations",
    "update-booking:booking-to-order",
    "update-order:order-to-fulfillment",
    "update-booking:booking-to-cards",
    "units:transactions-to-roster",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/out-of-service.ts` contributes to the propagation catalog. */
export const outOfService: PropagationModule = {
  rules: [
    ...createOutOfServiceRules,
    ...updateOutOfServiceRules,
    ...reclassifyOutOfServiceRules,
  ],
  transactions: [
    createOutOfServiceTransaction,
    updateOutOfServiceTransaction,
    reclassifyOutOfServiceTransaction,
  ],
};
