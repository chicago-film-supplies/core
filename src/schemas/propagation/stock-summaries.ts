/**
 * Stock-summary propagation rules — the four edges that rebuild
 * `stock-summaries/{productUid}` and its public twin.
 *
 * A stock summary caches the *inputs* to an availability answer, and it has
 * exactly three of them: the ledger's `quantity_held` + `type`, the product's
 * live booking intervals, and its non-terminal OOS intervals. Every transaction
 * that rebuilds a summary moves all three, then projects the public doc — so the
 * same four edges recur, per transaction, and are minted here rather than
 * copy-pasted into six rule files.
 *
 * The old shape collapsed these into two vague rules ("recalculated from the
 * updated ledger", "same derivation as order rules") that named the ledger as
 * the only source, which is why the booking and OOS edges — the ones that
 * actually move on an order write — were invisible in the propagation graph.
 *
 * Traced from: api-cloudrun/src/lib/stockSummary.ts (`buildStockSummary`).
 */
import type { CollectionRule, EnforcementRef } from "./types.ts";

// ── What checks these four edges ────────────────────────────────────
//
// All four are minted per transaction, so their enforcement is minted here too
// — one edit site, ~30 rules. Each pointer below was opened and read; the
// `clause` records the part of the string it actually covers, which for the
// public twin is materially less than the string claims.

/**
 * The corpus detector. `audit-stock-summaries.ts` reloads every ledger, booking
 * and OOS record and rebuilds the expected projection from them, so its sources
 * are independent of the summary it is checking — it is not a fixed point.
 */
const LEDGER_EMBED: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock-summaries.ts:261",
  clause:
    "invariant 4 — `quantity_held` and `type` equal the ledger's, corpus-wide. Says nothing about which OTHER ledger fields were copied; that half is the schema below.",
  gates: true,
};

/**
 * The "store_breakdown is NOT copied" half is unrepresentable rather than
 * checked: `StockSummarySchema` is a `z.strictObject` with no such key, so a
 * summary carrying one is rejected by `validateBeforeWrite` before it lands.
 */
const NO_STORE_BREAKDOWN: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/stock-summary.ts:120",
  clause:
    "the `store_breakdown is NOT copied` half — the strictObject has no such key, so copying it is a write rejection, not a drift",
  gates: true,
};

const BOOKING_PROJECTION: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock-summaries.ts:273",
  clause:
    "invariant 5 — `bookings[]` is set-equal to the product's live (non-complete) bookings in BOTH directions, with per-entry interval bounds and every breakdown key compared",
  gates: true,
};

const OOS_PROJECTION: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock-summaries.ts:306",
  clause:
    "invariant 6 — `out_of_service[]` is set-equal to the product's live (non-terminal) OOS records in BOTH directions, with interval bounds and quantity/reason/status compared",
  gates: true,
};

/**
 * The interval MODEL — the half of these strings that is a claim about how the
 * stored shape is read, not about whether it is fresh. No corpus walk can see
 * it; it is a property of `computeAvailability`, and it is asserted directly.
 */
const INTERVAL_MODEL: EnforcementRef = {
  kind: "test",
  ref: "core/tests/availability.test.ts",
  clause:
    "the `raw intervals, never a per-window answer` half — *a span is NOT the min over its days* (a daily rollup oversells), *an open-ended (sale) booking blocks every later window*, and *an open-ended OOS record reduces every later window*",
  gates: true,
};

/**
 * ⚠️ The audit's twin check is REAL but PARTIAL, and the clause says which part.
 * It compares the stored twin against `toPublicStockSummary(summary)` — a
 * genuinely independent source, since the internal doc is a different document —
 * but only on `quantity_held`, `type` and `unavailable.length`. Two twins whose
 * entries differ entry-for-entry while agreeing in count pass it.
 */
const PUBLIC_TWIN_PROJECTION: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock-summaries.ts:336",
  clause:
    "invariant 7, PARTIALLY — `quantity_held`, `type` and the LENGTH of `unavailable[]` match the projection of the internal doc. Entry contents are not compared, so a per-entry interval or quantity drift is invisible to it.",
  gates: true,
};

/**
 * The anonymization half — the reason the twin exists — is asserted directly on
 * the projection function, not inferred from the schema alone.
 */
const PUBLIC_TWIN_ANONYMITY: EnforcementRef = {
  kind: "test",
  ref: "core/tests/availability.test.ts:277",
  clause:
    "the sanitization half — no `uid`, `number` or `reason` survives the projection, zero-quantity entries are dropped, and `computePublicAvailability` agrees with `computeAvailability` exactly",
  gates: true,
};

/**
 * And the anonymity is also unrepresentable: `PublicUnavailableEntry` is a
 * strictObject of exactly {start, start_fs, end, end_fs, quantity}, so there is
 * no field for a uid or a reason to be written into.
 */
const PUBLIC_TWIN_SHAPE: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/public-stock-summary.ts:51",
  clause:
    "the same sanitization half, as a write rejection — the entry strictObject has no uid/number/reason key at all",
  gates: true,
};

/**
 * The biconditional (`ledger ⟺ summary ⟺ public twin`, and the products leg)
 * is what the seed/teardown pair claims, and it is the audit's invariant 1.
 */
const SUMMARY_BICONDITIONAL: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock-summaries.ts:155",
  clause:
    "invariant 1, all four legs — `productHoldsStock` ⟺ ledger ⟺ summary ⟺ public twin, each direction reported separately (`ledger_without_summary`, `public_twin_without_summary`, `product_without_ledger`, `ledger_without_product_stock`)",
  gates: true,
};

/** The four edge suffixes, in the order `buildStockSummary` performs them. */
const EDGES = [
  "ledger-to-stock-summary",
  "bookings-to-stock-summary",
  "oos-to-stock-summary",
  "stock-summary-to-public",
] as const;

/**
 * The rule IDs this transaction fires when it rebuilds a stock summary — the
 * `steps` entries and the `rules_fired` array in the service must both use these.
 */
export function stockSummarySteps(transactionId: string): string[] {
  return EDGES.map((edge) => transactionId + ":" + edge);
}

/**
 * The seed/teardown pair, for transactions that create or destroy the summary
 * rather than rebuild it from bookings + OOS.
 *
 * **The invariant: a stock summary exists if and only if an inventory ledger
 * exists.** A product with a ledger always has exactly one summary doc and one
 * public twin, both keyed by its uid; a product without one (stock_method
 * "none", or a service/surcharge/replacement type) has neither. Under the old
 * window-keyed design a missing summary was self-healing — an unauthenticated
 * `GET /availability` would mint it on read — so deleting summaries and not
 * recreating them was invisible. There is no mint-on-read any more, so a delete
 * without a matching create is a *permanent* hole: the manager's `onSnapshot`
 * would sit on a doc that never appears. `audit-stock-summaries.ts` enforces the
 * biconditional in both directions.
 *
 * A brand-new product has no bookings and no OOS records by construction, so the
 * seed writes empty arrays with no queries — only the ledger embed and the public
 * projection actually move data.
 */
export function seedStockSummaryRules(
  transactionId: string,
  invariant: string,
): CollectionRule[] {
  const [ledgerEdge, , , publicEdge] = EDGES;
  return [
    {
      id: transactionId + ":" + ledgerEdge,
      source: "inventory-ledgers",
      target: "stock-summaries",
      mode: "co-write",
      invariant,
      enforced_by: [SUMMARY_BICONDITIONAL, LEDGER_EMBED],
      transaction: transactionId,
      fields: [
        { source: ["uid"], target: ["uid"], transform: "the summary's doc id IS the product uid" },
        { source: ["uid"], target: ["uid_product"] },
        { source: ["type"], target: ["type"] },
        { source: ["quantity_held"], target: ["quantity_held"] },
        { source: [], target: ["bookings"], transform: "[] — a product with no bookings yet" },
        { source: [], target: ["out_of_service"], transform: "[] — a product with no OOS records yet" },
      ],
    },
    {
      id: transactionId + ":" + publicEdge,
      source: "stock-summaries",
      target: "public-stock-summaries",
      mode: "derive",
      invariant:
        "The public twin is created and destroyed with its internal summary, always. Both branches of update-product previously deleted the summary and left the public twin behind — an orphan nobody could see, since only the internal doc is queried by uid_product.",
      enforced_by: [SUMMARY_BICONDITIONAL],
      transaction: transactionId,
      fields: [
        { source: ["quantity_held"], target: ["quantity_held"] },
        { source: ["type"], target: ["type"] },
        { source: [], target: ["unavailable"], transform: "[] — nothing consuming stock yet" },
      ],
    },
  ];
}

/** Where the deferred rebuild actually runs — the `trigger` on all four edges. */
const REBUILD_TRIGGER = "cloud-task:/tasks/rebuild-stock-summary";

/**
 * The four stock-summary rules for one transaction.
 *
 * **These are `fan-out`, not co-writes, as of 2026-08-02 (api-cloudrun#358).**
 * The rebuild used to run inside the originating Firestore transaction, where it
 * issued `bookings where uid_product == X` plus the matching `out-of-service`
 * query PER PRODUCT and then wrote into the bookings range it had just read. That
 * is the one lock shape Firestore resolves by BLOCKING the loser to its 25s
 * client deadline instead of aborting it, so the retry machinery never engages —
 * measured on cfs-dev-3100 2026-08-01, and 138 of prod's 315 deadline aborts in
 * the 30 days to 2026-08-02 were on `crms-opportunity-order` doing exactly this.
 * It also did not scale: the largest live order covers 61 distinct products, so
 * one PUT issued 122 range queries and 122 summary writes.
 *
 * It is deferrable because a stock summary is a projection with **no
 * server-side consumer** — every hard stock gate reads the ledger, the OOS
 * records or the shelf counts transactionally instead. So the atomicity traded
 * bought display consistency, not an invariant.
 *
 * What that means for these declarations, and why each field moved:
 *
 *  - `mode: "fan-out"` — "source changes propagate to targets via events", which
 *    is now literally true. The old `embed`/`derive` said the value moved as part
 *    of the same write.
 *  - `trigger` names the Cloud Task, so the graph says WHERE it runs.
 *  - **`transaction` is dropped.** That field means "grouped into this atomic
 *    operation" and would be the one outright false claim left. The ids stay in
 *    the owning definition's `steps` (the operation genuinely still causes them,
 *    and `getPropagationMarkdown`/the diagram generator both resolve rules by
 *    step id, so the edges keep rendering) — but nothing asserts atomicity.
 *
 * {@link seedStockSummaryRules} is deliberately NOT changed: the create-product
 * seed still writes the summary inside its own transaction, and it can, because
 * a brand-new product has no bookings and no OOS records so the seed issues no
 * queries at all. It is the co-write it says it is.
 *
 * @param transactionId - the TransactionDefinition id that CAUSES the rebuild,
 *   e.g. "create-order". Kept in the rule ids, since that is what the api-cloudrun
 *   task logs and what `propagationCoverage` greps for.
 * @param trigger - what causes the rebuild, woven into the invariants
 */
export function stockSummaryRules(
  transactionId: string,
  trigger: string,
): CollectionRule[] {
  return [
    {
      id: transactionId + ":ledger-to-stock-summary",
      source: "inventory-ledgers",
      target: "stock-summaries",
      mode: "fan-out",
      invariant:
        "The summary embeds the ledger's current quantity_held and product type. These are the only ledger fields availability needs — store_breakdown is NOT copied (no client reads a per-store split; the manager reads inventory-ledgers directly for that), so a store transfer, which moves stock between stores without changing quantity_held, correctly leaves the summary untouched.",
      enforced_by: [LEDGER_EMBED, NO_STORE_BREAKDOWN],
      trigger: REBUILD_TRIGGER,
      fields: [
        { source: ["quantity_held"], target: ["quantity_held"] },
        { source: ["type"], target: ["type"] },
      ],
    },
    {
      id: transactionId + ":bookings-to-stock-summary",
      source: "bookings",
      target: "stock-summaries",
      mode: "fan-out",
      invariant:
        trigger +
        " re-derives stock-summaries.bookings[] — every non-complete booking for the product, as an interval (start/end + their Firestore-timestamp twins) plus its breakdown. Stored as raw intervals, never as a per-window answer: quantity_booked for ANY window is Σ(reserved+prepped+out) over the entries overlapping it, so no window is privileged and none needs its own document. A sale booking carries end: null (a sold unit does not come back) and so keeps consuming stock in every later window until it completes.",
      enforced_by: [BOOKING_PROJECTION, INTERVAL_MODEL],
      trigger: REBUILD_TRIGGER,
      fields: [
        { source: ["uid"], target: ["bookings", "uid"] },
        { source: ["number"], target: ["bookings", "number"] },
        {
          source: ["type"],
          target: ["bookings", "type"],
          transform:
            "REQUIRED, not optional-with-a-fallback: heldByBooking excludes a sale booking's `out` units (they left ownership at the sale, so quantity_held already dropped and counting them again would double-subtract), and an optional field would mean two availability behaviours coexisting in one corpus — the exact thing this document exists to prevent. A summary is a pure projection, so it costs a rebuild rather than a backfill.",
        },
        { source: ["dates", "start"], target: ["bookings", "start"] },
        { source: ["dates", "start_fs"], target: ["bookings", "start_fs"] },
        { source: ["dates", "end"], target: ["bookings", "end"] },
        { source: ["dates", "end_fs"], target: ["bookings", "end_fs"] },
        { source: ["breakdown"], target: ["bookings", "breakdown"] },
      ],
    },
    {
      id: transactionId + ":oos-to-stock-summary",
      source: "out-of-service",
      target: "stock-summaries",
      mode: "fan-out",
      invariant:
        trigger +
        " re-derives stock-summaries.out_of_service[] — every non-terminal (not complete/canceled) OOS record for the product, as an interval plus its quantity/reason/status. Same interval model as bookings; an open-ended record (end: null) reduces availability in every window from its start onward.",
      enforced_by: [OOS_PROJECTION, INTERVAL_MODEL],
      trigger: REBUILD_TRIGGER,
      fields: [
        { source: ["uid"], target: ["out_of_service", "uid"] },
        { source: ["dates", "start"], target: ["out_of_service", "start"] },
        { source: ["dates", "start_fs"], target: ["out_of_service", "start_fs"] },
        { source: ["dates", "end"], target: ["out_of_service", "end"] },
        { source: ["dates", "end_fs"], target: ["out_of_service", "end_fs"] },
        { source: ["quantity"], target: ["out_of_service", "quantity"] },
        { source: ["reason"], target: ["out_of_service", "reason"] },
        { source: ["status"], target: ["out_of_service", "status"] },
      ],
    },
    {
      id: transactionId + ":stock-summary-to-public",
      source: "stock-summaries",
      target: "public-stock-summaries",
      mode: "fan-out",
      invariant:
        "The public twin is written in the same transaction, via toPublicStockSummary (@cfs/core/utils/availability) — the single definition of the sanitized shape. Bookings and OOS merge into one anonymous unavailable[] interval list (no uid, no booking number, no order, no OOS reason), carrying only the consuming quantity, so an outsider cannot tell 'booked' from 'in for repair' yet still derives the exact quantity_available for any window.",
      enforced_by: [PUBLIC_TWIN_PROJECTION, PUBLIC_TWIN_ANONYMITY, PUBLIC_TWIN_SHAPE],
      trigger: REBUILD_TRIGGER,
      fields: [
        { source: ["quantity_held"], target: ["quantity_held"] },
        { source: ["type"], target: ["type"] },
        {
          source: ["bookings"],
          target: ["unavailable"],
          transform: "anonymized interval + (reserved+prepped+out); zero-quantity entries dropped",
        },
        {
          source: ["out_of_service"],
          target: ["unavailable"],
          transform: "anonymized interval + quantity; merged into the same list",
        },
      ],
    },
  ];
}
