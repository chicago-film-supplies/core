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
import type { CollectionRule } from "./types.ts";

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
      transaction: transactionId,
      fields: [
        { source: ["quantity_held"], target: ["quantity_held"] },
        { source: ["type"], target: ["type"] },
        { source: [], target: ["unavailable"], transform: "[] — nothing consuming stock yet" },
      ],
    },
  ];
}

/**
 * The four stock-summary rules for one transaction.
 *
 * @param transactionId - the owning TransactionDefinition id, e.g. "create-order"
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
      mode: "embed",
      invariant:
        "The summary embeds the ledger's current quantity_held and product type. These are the only ledger fields availability needs — store_breakdown is NOT copied (no client reads a per-store split; the manager reads inventory-ledgers directly for that), so a store transfer, which moves stock between stores without changing quantity_held, correctly leaves the summary untouched.",
      transaction: transactionId,
      fields: [
        { source: ["quantity_held"], target: ["quantity_held"] },
        { source: ["type"], target: ["type"] },
      ],
    },
    {
      id: transactionId + ":bookings-to-stock-summary",
      source: "bookings",
      target: "stock-summaries",
      mode: "derive",
      invariant:
        trigger +
        " re-derives stock-summaries.bookings[] — every non-complete booking for the product, as an interval (start/end + their Firestore-timestamp twins) plus its breakdown. Stored as raw intervals, never as a per-window answer: quantity_booked for ANY window is Σ(reserved+prepped+out) over the entries overlapping it, so no window is privileged and none needs its own document. A sale booking carries end: null (a sold unit does not come back) and so keeps consuming stock in every later window until it completes.",
      transaction: transactionId,
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
      mode: "derive",
      invariant:
        trigger +
        " re-derives stock-summaries.out_of_service[] — every non-terminal (not complete/canceled) OOS record for the product, as an interval plus its quantity/reason/status. Same interval model as bookings; an open-ended record (end: null) reduces availability in every window from its start onward.",
      transaction: transactionId,
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
      mode: "derive",
      invariant:
        "The public twin is written in the same transaction, via toPublicStockSummary (@cfs/core/utils/availability) — the single definition of the sanitized shape. Bookings and OOS merge into one anonymous unavailable[] interval list (no uid, no booking number, no order, no OOS reason), carrying only the consuming quantity, so an outsider cannot tell 'booked' from 'in for repair' yet still derives the exact quantity_available for any window.",
      transaction: transactionId,
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
