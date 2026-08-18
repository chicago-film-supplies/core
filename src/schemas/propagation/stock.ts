/**
 * Stock propagation rules — the three edges that rebuild `stock/{productUid}`.
 *
 * `stock/{P}` caches the *inputs* to an availability answer, and it has exactly
 * three of them: the ledger's `quantity_held`, the product's live booking
 * intervals, and its non-terminal OOS intervals. Every transaction that rebuilds
 * the projection moves all three, so the same three edges recur, per
 * transaction, and are minted here rather than copy-pasted into six rule files.
 *
 * ⚠️ **THREE edges, not four — the public twin is gone.** `stock-summaries` and
 * `public-stock-summaries` collapsed into this one collection: the entries are
 * **pre-reduced and anonymous** (`{start, end, quantity, kind}`), so there is
 * nothing left to sanitize and no second document to project into. That deleted
 * the `stock-summary-to-public` edge outright, along with the three
 * `PUBLIC_TWIN_*` enforcement refs — one of which (`PUBLIC_TWIN_PROJECTION`)
 * only ever compared `unavailable.length`, so two twins differing entry-for-entry
 * while agreeing in count passed it. One document under one security rule
 * (`allow read: if true`) replaces the pair.
 *
 * ⚠️ **And the fold collapsed the two source edges' CHECKS into one.** The old
 * shape stored bookings and OOS records in separate arrays, so the audit checked
 * each against its own source; `unavailable[]` interleaves both, so invariant 4
 * is a single multiset diff covering both — which is why `BOOKING_PROJECTION`
 * and `OOS_PROJECTION` are now one `FOLD` ref rather than two. The edges stay
 * separate because the *sources* are still separate.
 *
 * Traced from: api-cloudrun/src/lib/stockSummary.ts (`buildStockSummary` →
 * `assembleStockResult`).
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
} from "./types.ts";

// ── What checks these three edges ───────────────────────────────────
//
// All three edges are declared ONCE and fired by many transactions, so their
// enforcement is declared once too — one edit site, four rules. ⚠️ This said
// "seven transactions" until 2026-08-18 and the real figure was ELEVEN by then:
// a count of firing contexts goes stale every time a transaction adds
// {@link STOCK_STEPS}, which is precisely why it should not be written here.
// `scripts/audit-propagation-corpus.ts` derives it. Each pointer below was opened and read against
// `audit-stock.ts` as it stands, NOT translated from the `audit-stock-summaries.ts`
// refs it replaces: that audit checked a different document with a different
// shape, and two of its invariants have no counterpart here.

/**
 * The corpus detector. `audit-stock.ts` reloads every ledger, booking and OOS
 * record and rebuilds the expected projection from them, so its sources are
 * independent of the projection it is checking — it is not a fixed point.
 */
const LEDGER_EMBED: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock.ts::quantity_held_stale",
  clause:
    "invariant 3 — `quantity_held` equals the ledger's, corpus-wide (`quantity_held_stale`). ⚠️ There is NO `type` half any more: `stock/{P}` carries no `type` field, which is what makes the old `type_stale` drift unrepresentable rather than merely unchecked.",
  gates: true,
};

/**
 * The "store_breakdown is NOT copied" half is unrepresentable rather than
 * checked: `StockSchema` is a `z.strictObject` with no such key, so a projection
 * carrying one is rejected by `validateBeforeWrite` before it lands.
 */
const NO_STORE_BREAKDOWN: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/stock.ts::export const StockSchema",
  clause:
    "the `store_breakdown is NOT copied` half — the strictObject has no such key, so copying it is a write rejection, not a drift",
  gates: true,
};

/**
 * ONE ref for both source edges, because the pre-reduced array interleaves them.
 * A booking entry and an OOS entry are the same shape once reduced (they differ
 * only in `kind`), so the audit cannot check them separately and does not try —
 * it recomputes the whole fold and compares as a multiset, in both directions.
 */
const FOLD: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-stock.ts::unavailable_stale",
  clause:
    "invariant 4 — `unavailable[]` is multiset-equal to the fold recomputed from the product's live (non-complete) bookings AND its non-terminal OOS records, in BOTH directions (`missing` / `extra`, reported as `unavailable_stale`). Covers the booking and OOS edges together, since the reduced entries are indistinguishable by shape.",
  gates: true,
};

/**
 * The interval MODEL — the half of these strings that is a claim about how the
 * stored shape is read, not about whether it is fresh. No corpus walk can see
 * it; it is a property of `computeStockAvailability`, and it is asserted directly.
 */
const INTERVAL_MODEL: EnforcementRef = {
  kind: "test",
  ref: "core/tests/stock.test.ts",
  clause:
    "the `raw intervals, never a per-window answer` half — *a span is NOT the min over its days* (a daily rollup oversells), *an open-ended (sale) booking blocks every later window*, and *an open-ended OOS record reduces every later window*",
  gates: true,
};

/**
 * The biconditional (`productHoldsStock` ⟺ ledger ⟺ `stock/{P}` ⟺
 * `stock-locks/{P}`) is what the seed/teardown pair claims, and it is the
 * audit's invariant 1.
 */
const STOCK_BICONDITIONAL: EnforcementRef = {
  kind: "audit",
  ref:
    "api-cloudrun/scripts/audit-stock.ts::── 1. The biconditional, all four legs",
  clause:
    "invariant 1, every leg in both directions — `productHoldsStock` ⟺ ledger ⟺ `stock/{P}` ⟺ `stock-locks/{P}`, each reported separately (`product_without_ledger`, `ledger_without_stock_product`, `ledger_without_stock`, `ledger_without_token`, `stock_without_ledger`, `token_without_ledger`). The TOKEN leg is the one with teeth: `stageStockClaim` PATCHES `stock-locks/{P}` and Firestore's `update` does not upsert, so a ledger without a token fails every claim against that product with NOT_FOUND.",
  gates: true,
};

/**
 * The three shared stock edges, in the order `assembleStockResult` performs them.
 *
 * ⚠️ **These are STEP IDS other modules reference, and that is why this file has
 * a second export.** The one-module-per-file convention (`types.ts`
 * `PropagationModule`) is about what a file contributes to the *catalog*; a
 * shared `as const` step tuple is the sanctioned companion, because the
 * alternative is the same three ids hand-copied into every transaction that
 * rebuilds the projection, across four files — the exact defect the convention
 * exists to remove, and a cost that GROWS with each new firing context rather
 * than sitting at the "39 across seven transactions" this line used to assert.
 *
 * A plain literal, deliberately: `[...X, "y"] as const` is the spread form that
 * JSR's declaration emitter truncates (core#43), and this has no spread.
 */
export const STOCK_STEPS = [
  "stock:ledger-to-stock",
  "stock:bookings-to-stock",
  "stock:oos-to-stock",
] as const;

/**
 * Where the rebuild actually runs — the `trigger` on all three shared edges.
 *
 * ⚠️ **INLINE, post-commit, in the same request** — not on the queue. This used
 * to read `cloud-task:/tasks/rebuild-stock-summary`, and that was true of the
 * intermediate state only. The queue still exists and is still declared, but it
 * is a **retry ladder** now: `enqueueStockSummaryRebuilds` is `await`ed
 * post-commit by the originating write, bounded-parallel, with a per-product
 * try/catch on both arms. Naming the task here would put the wrong location in
 * the propagation graph.
 */
const REBUILD_TRIGGER =
  "inline:post-commit (retry ladder: cloud-task:/tasks/rebuild-stock-summary)";

/**
 * The stock projection's edges — THREE rules, fired by every transaction that
 * moves stock, plus the seed. **Do not write the number of them here** (item 17):
 * it was "seven" and was eleven by 2026-08-18. Derive it with
 * `scripts/audit-propagation-corpus.ts`.
 *
 * ⚠️ **These used to be minted PER TRANSACTION, and were 21 rules of a corpus
 * that stood at 173 when the collapse landed (2026-08-17; it has moved since —
 * this is history, not a current figure).** `stockRules(transactionId, trigger)`
 * produced seven
 * near-identical copies of the same three edges: every `enforced_by` ref was a
 * shared module const, `trigger` was a shared constant, and only the id prefix
 * and one prose fragment varied. They were never 21 rules — they are three
 * rules fired from many transactions, and that relation was *already* modelled by
 * `TransactionDefinition.steps[]`, which is where it now lives alone.
 *
 * **The varying prose moved to the transactions.** A string like *"Every
 * booking breakdown change"* answers **when this fires**, not **what must be
 * true** — it is a trigger wearing an invariant's clothes. Each transaction's
 * `description` now carries its own gating condition, including the two that
 * are load-bearing: a pure placement movement leaves `quantity_held` untouched
 * and skips the rebuild, and cancelling an OOS record drops it from the array
 * entirely.
 *
 * **These are `fan-out`, not co-writes (api-cloudrun#358).** The rebuild used to
 * run inside the originating Firestore transaction, where it issued `bookings
 * where uid_product == X` plus the matching `out-of-service` query PER PRODUCT
 * and then wrote into the bookings range it had just read. That is the one lock
 * shape Firestore resolves by BLOCKING the loser to its client deadline instead
 * of aborting it, so the retry machinery never engages — measured on
 * cfs-dev-3100 2026-08-01, and 138 of prod's 315 deadline aborts in the 30 days
 * to 2026-08-02 were on `crms-opportunity-order` doing exactly this. It also did
 * not scale: the largest live order covers 61 distinct products, so one PUT
 * issued 122 range queries and 122 summary writes.
 *
 * It is deferrable because the projection has **no server-side consumer that
 * needs it transactionally** — the OOS cap reads the OOS records, the allocator
 * reads the ledger, and the oversell gate (`src/lib/stockGate.ts`) reads its own
 * inputs under a `stock-locks/{P}` precondition rather than reading this
 * document. So the atomicity traded bought display consistency, not an invariant.
 *
 * ⚠️ **`transaction` is deliberately absent on the three shared edges.** That
 * field means "grouped into this atomic operation", and with many firing
 * contexts it could only ever name one of them — it would be the single
 * outright false claim in the file. The ids live in each owning definition's
 * `steps`, and `getPropagationMarkdown` and the diagram generator both resolve
 * rules by step id, so every edge still renders under every transaction.
 */
const rules: CollectionRule[] = [
  {
    id: "stock:ledger-to-stock",
    source: "inventory-ledgers",
    target: "stock",
    mode: "fan-out",
    invariant:
      "The projection embeds the ledger's current quantity_held. That is the only ledger field availability needs — store_breakdown is NOT copied (no client reads a per-store split; the manager reads inventory-ledgers directly for that), so a store transfer, which moves stock between stores without changing quantity_held, correctly leaves the projection untouched. `type` is not copied either: the ledger's existence already answers the only question a projection needed it for.",
    enforced_by: [LEDGER_EMBED, NO_STORE_BREAKDOWN],
    trigger: REBUILD_TRIGGER,
    fields: [
      { source: ["quantity_held"], target: ["quantity_held"] },
    ],
  },
  {
    id: "stock:bookings-to-stock",
    source: "bookings",
    target: "stock",
    mode: "fan-out",
    invariant:
      'The booking half of stock.unavailable[] is re-derived from every live booking for the product, PRE-REDUCED to an anonymous {start, end, quantity, kind:"booking"} interval by `unavailableFromBooking` (@cfs/core/utils/stock). Stored as raw intervals, never as a per-window answer: quantity_booked for ANY window is Σ quantity over the entries overlapping it, so no window is privileged and none needs its own document. A sale booking carries end: null (a sold unit does not come back) and so keeps consuming stock in every later window until it completes. Entries are ANONYMOUS by design — a booking\'s doc id is orderUid:productUid:destUid, so a uid-keyed entry would let an anonymous reader join across products and read off who booked what.',
    enforced_by: [FOLD, INTERVAL_MODEL],
    trigger: REBUILD_TRIGGER,
    fields: [
      { source: ["dates", "start"], target: ["unavailable", "start"] },
      { source: ["dates", "end"], target: ["unavailable", "end"] },
      {
        source: ["breakdown"],
        target: ["unavailable", "quantity"],
        transform:
          'reserved + prepped, PLUS out unless type === "sale" — a sale\'s out units left ownership at the sale movement, which already dropped quantity_held, so counting them again double-subtracts. The rule lives in `unavailableFromBooking` and ONLY there, shared verbatim with the browser and the oversell gate.',
      },
      {
        source: ["status"],
        target: [],
        transform:
          "the LIVENESS filter, not a stored field — a `complete` booking reduces to null and the entry is DROPPED rather than stored as a zero (it would affect no answer while disclosing that something exists). Folding liveness and zero-quantity into one function is the point: as two separate rules they could disagree, and a completed sale left in the array consumes stock forever.",
      },
      {
        source: [],
        target: ["unavailable", "kind"],
        transform:
          '"booking" — the ONE non-quantitative fact a public reader learns, kept so the operator stock panel can split Booked from Out Of Service without a second document',
      },
    ],
  },
  {
    id: "stock:oos-to-stock",
    source: "out-of-service",
    target: "stock",
    mode: "fan-out",
    invariant:
      "The OOS half of stock.unavailable[] is re-derived from every non-terminal (not complete/canceled) OOS record for the product, pre-reduced by `unavailableFromOOS` to the same anonymous interval shape. Same interval model as bookings; an open-ended record (end: null) reduces availability in every window from its start onward. ⚠️ An OOS record claims its FULL quantity until terminal: a 5-unit record with breakdown.returned_to_service = 3 still claims 5, and reducing from the breakdown looks like a cleanup and is a live oversell.",
    enforced_by: [FOLD, INTERVAL_MODEL],
    trigger: REBUILD_TRIGGER,
    fields: [
      { source: ["dates", "start"], target: ["unavailable", "start"] },
      { source: ["dates", "end"], target: ["unavailable", "end"] },
      { source: ["quantity"], target: ["unavailable", "quantity"] },
      {
        source: ["status"],
        target: [],
        transform:
          "the liveness filter — `complete` (every unit written off or returned to service) and `canceled` (the operator voided the record) both hold zero units, so neither survives the reducer",
      },
      {
        source: ["reason"],
        target: [],
        transform:
          "DELIBERATELY DROPPED. It was the twin's whole reason for existing: an outsider must not be able to tell `booked` from `in for repair`. `kind` says only which of the two it is.",
      },
      {
        source: [],
        target: ["unavailable", "kind"],
        transform: '"oos"',
      },
    ],
  },
  {
    // The seed/teardown edge. Inlined here from the former `seedStockRules()`
    // factory, and re-prefixed `stock:` so no file declares another file's id.
    //
    // ⚠️ **Kept SEPARATE from the three above, and it is a co-write, not a
    // fan-out.** The create-product seed writes the projection inside its own
    // transaction and legitimately can: a brand-new product has no bookings and
    // no OOS records, so the seed issues no queries at all and none of #358's
    // lock shape applies. It is the co-write it says it is.
    id: "stock:seed-ledger-to-stock",
    source: "inventory-ledgers",
    target: "stock",
    mode: "co-write",
    invariant:
      "A product that gets an inventory ledger gets a `stock/{P}` projection and a `stock-locks/{P}` token in the same transaction — all three are created and destroyed together. The projection starts empty (no bookings, no OOS) and carries the ledger's quantity_held. Under the old window-keyed design a missing summary was self-healing, because an unauthenticated `GET /availability` minted it on read; there is no mint-on-read any more, so a delete without a matching create is a PERMANENT hole and the manager's `onSnapshot` would sit on a document that never appears. A missing TOKEN is worse than a hole, since the product cannot be claimed at all.",
    enforced_by: [STOCK_BICONDITIONAL, LEDGER_EMBED],
    fields: [
      {
        source: ["uid"],
        target: ["uid"],
        transform: "the projection's doc id IS the product uid",
      },
      { source: ["uid"], target: ["uid_product"] },
      { source: ["quantity_held"], target: ["quantity_held"] },
      {
        source: [],
        target: ["unavailable"],
        transform: "[] — a product with no bookings and no OOS records yet",
      },
      {
        source: [],
        target: ["claim_seq"],
        transform:
          "0 — matching the token `seedStockLock` writes alongside. It has never been claimed, so the projection is trivially current.",
      },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────

/** Everything `stock.ts` contributes to the propagation catalog. */
export const stock: PropagationModule = {
  rules,
  transactions: [],
};
