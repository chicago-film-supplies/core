/**
 * Invoice propagation rules — bidirectional invoice↔order cross-references.
 *
 * 1. create-invoice: co-writes invoice summary (uid, number, status) to each
 *    referenced order's `invoices` array and `query_by_invoices`.
 *
 * 2. update-invoice: CONVERGES each order's `invoices` array entry on the
 *    invoice document — on every invoice write, not only when the status moved.
 *    The cash-settlement writers declare their own transactions in
 *    `./settlements.ts`; they used to borrow this one.
 *
 * 3. update-order → invoices: when an order's items, destinations, subject,
 *    reference, or organization change, unsettled invoices (no unreversed
 *    settlement)
 *    referencing the order via query_by_orders are updated — items and
 *    destinations scoped by order are selectively synced (respecting
 *    invoice-side overrides); scalar fields co-write only if the invoice
 *    value still matches the prev order value (else the invoice-side edit
 *    is treated as an override and kept). When an order is canceled, its
 *    scoped items, destinations, and uid are removed from unpaid invoices.
 *
 * Traced from: api-cloudrun/src/services/invoices.ts, orders.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────

/**
 * The forward half of the cross-reference, asserted on a real create: the
 * order's `invoices[]` entry and its `query_by_invoices` array both appear.
 */
const INVOICE_BACKREF_CREATED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/invoices/invoices.test.ts:217",
  clause:
    "3 of the entry's 4 fields — `invoices.length`, `invoices[0].uid`, `invoices[0].status` and the whole `query_by_invoices` array. `invoices[0].number` is not asserted. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/**
 * The mirror merge itself, as a pure function over typed inputs.
 *
 * Deliberately a **unit** test on `convergeInvoiceRefs` rather than an
 * integration assertion on one writer's happy path — mirroring how the reverse
 * (order→invoice) direction enforces on pure functions in
 * `core/tests/invoices.test.ts`. An integration pointer certifies the path it
 * drives and nothing else, which is exactly how EIGHT writers came to share one
 * pointer that admitted in its own `clause` that it covered a single transition
 * (api-cloudrun#453). "Has a pointer" and "is enforced" are different
 * predicates, and only the first is checked mechanically.
 */
const MIRROR_CONVERGES: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/orderInvoiceMirror.test.ts:42",
  clause:
    "the merge, writer-independently — the named entry is rewritten when (and only when) it disagrees, the INPUT ARRAY IDENTITY comes back when it agrees (the no-write contract every caller gates on), no ref is added or removed, and `number` converges without reporting a status change. Hermetic, in `deno task gate`. Says nothing about whether any given writer calls it — that is what `MIRROR_HAS_ONE_AUTHOR` is for.",
  gates: true,
};

/**
 * That every writer routes through the one merge, rather than spelling it again.
 *
 * ⚠️ A **location** ratchet, and on its own that is not enough: Ratchet G pinned
 * the money `_str` renderer to exactly one file, stayed green, and that one file
 * was wrong — every money mirror in both environments rendered 100× until
 * 2026-08-08. A single source of truth guarantees ONE implementation, never a
 * correct one. It is listed here only ALONGSIDE `MIRROR_CONVERGES`.
 */
const MIRROR_HAS_ONE_AUTHOR: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/orderInvoiceMirrorCoverage.test.ts",
  clause:
    "the one-author clause — no second copy of the mirror merge in `src/`, every `src/` file writing the `invoices:` key onto an order is catalogued, and every `scripts/` file writing `invoices/` is catalogued with the note that its mirror converges via the backstop. Structural only: says nothing about what the merge produces.",
  gates: true,
};

const INVOICE_BACKREF_STATUS_FOLLOWS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/invoices/invoices.test.ts:1053",
  clause:
    "one writer end-to-end — settling an issued invoice flips it to `paid` AND the order's `invoices[0].status` follows in the same request. The settlement path specifically; the other seven writers are covered by `MIRROR_CONVERGES` + `MIRROR_HAS_ONE_AUTHOR` rather than by this.",
  gates: true,
};

/**
 * That the mirror converges when it has ALREADY drifted — the property no
 * change-gated writer can have, and the one whose absence made api-cloudrun#453
 * permanent rather than transient.
 */
const MIRROR_CONVERGES_WHEN_STALE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/invoices/orderInvoiceMirror.test.ts",
  clause:
    "the convergence clause end-to-end — a stale mirror is repaired by an invoice write that does NOT move status; an invoice write that changes nothing writes no order document; and the post-crash state of `createSettlement` (invoice CAS'd to `paid`, mirror left at `issued`) converges. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/**
 * The selective-sync semantics are pure functions in `@cfs/core/utils/invoices`,
 * and they are where the override policy actually lives — so the tests over them
 * are the real enforcement, not an approximation of it.
 */
const SELECTIVE_SYNC_SEMANTICS: EnforcementRef = {
  kind: "test",
  ref: "core/tests/invoices.test.ts::syncOrderToInvoiceSelective",
  clause:
    "the override policy, per helper — `syncOrderToInvoiceSelective` and `syncOrderItems` (scoped replace + `carryForwardOverrides` keeping `coa_revenue`/`xero_id`), `syncOrderDestinationsSelective` (adds tagged with `uid_order`, keeps overridden pairs, drops non-overridden removals, leaves other orders' pairs untouched), and `syncScalarWithOverride` both directions. Does NOT cover the FREEZE predicate that decides which invoices are eligible.",
  gates: true,
};

const ORDER_SCOPED_REMOVAL: EnforcementRef = {
  kind: "test",
  ref: "core/tests/invoices.test.ts::removeOrderScopedItems",
  clause:
    "the scoped-removal half — `removeOrderScopedItems` drops one order divider's whole subtree and keeps the other's. Says nothing about `query_by_orders` or the totals recompute that follow it.",
  gates: true,
};

// ── create-invoice ──────────────────────────────────────────────────

const createInvoiceRules: CollectionRule[] = [
  {
    id: "create-invoice:invoice-to-orders",
    source: "invoices",
    target: "orders",
    mode: "co-write",
    invariant: "Orders carry a denormalized array of their invoices so the UI can show invoice status without a collection-group query",
    enforced_by: [INVOICE_BACKREF_CREATED],
    transaction: "create-invoice",
    fields: [
      { source: ["uid"], target: ["invoices", "uid"] },
      { source: ["number"], target: ["invoices", "number"] },
      { source: ["status"], target: ["invoices", "status"] },
      { source: ["uid"], target: ["query_by_invoices"], transform: "append invoice uid to array" },
    ],
  },
];

const createInvoiceTransaction: TransactionDefinition = {
  id: "create-invoice",
  description: "Creates an invoice, co-writes invoice summary to each referenced order, and cowrites a default thread.",
  steps: [
    "create-invoice:invoice-to-orders",
    "cowrite-thread:invoices-to-thread",
    "cowrite-thread:thread-to-invoices",
  ],
};

// ── update-invoice (status → orders) ────────────────────────────────

const updateInvoiceOrderRules: CollectionRule[] = [
  {
    id: "update-invoice:status-to-orders",
    source: "invoices",
    target: "orders",
    mode: "co-write",
    invariant:
      "Every order's `invoices[]` entry CONVERGES on the invoice document — each writer rewrites the entry whenever it disagrees, not merely when the invoice's own status moved, and an eventarc reconciler repairs whatever was written outside a CFS service. This is a convergence guarantee, NOT an atomic one: `createSettlement` splits its invoice CAS from its order fan-out across two commits by design, so there is a real window in which the two disagree. Stating it as atomic (as this rule did until api-cloudrun#453) asserts an impossibility and hides the seam the backstop exists to close.",
    enforced_by: [
      MIRROR_CONVERGES,
      MIRROR_CONVERGES_WHEN_STALE,
      MIRROR_HAS_ONE_AUTHOR,
      INVOICE_BACKREF_STATUS_FOLLOWS,
    ],
    trigger:
      "any invoice write — targets orders referenced in query_by_orders. Deliberately NOT gated on the status having changed: a change-gate means a mirror that has already drifted can never be repaired, however many times the invoice is settled, resynced or webhook-updated, which is why all 86 stale prod refs survived a week of ordinary traffic.",
    fields: [
      {
        source: ["status"],
        target: ["invoices", "status"],
        transform:
          "convergeInvoiceRefs — find the entry in orders.invoices[] by uid and rewrite it IF it disagrees; the input array's identity is returned when it agrees, so no order document is written. `uid` is the match key and is never rewritten.",
      },
      {
        source: ["number"],
        target: ["invoices", "number"],
        transform:
          "converged by the same merge. Free: `invoiceSig` inside `xeroQuoteContentHash` reads `uid:status` only, so a number repair cannot move the Xero quote hash — which is what makes it safe to fold api-cloudrun#451's drift class in here rather than needing its own pass.",
      },
      {
        source: [],
        target: ["version"],
        transform:
          "HELD, deliberately. A version bump's only job is to 409 a concurrent editor, and there is no edit to defend: `updateOrder` cloneDeeps a fresh in-transaction read and transaction.sets it without ever assigning `invoices`, so a stale client physically cannot revert a mirror repair.",
      },
    ],
  },
];

const updateInvoiceTransaction: TransactionDefinition = {
  id: "update-invoice",
  description:
    "Updates an invoice's own fields and converges the invoices[] mirror on every referenced order. Fired by `updateInvoice` and by the CRMS void webhook. The settlement writers used to borrow this id and now declare their own — see `propagation/settlements.ts` for why that matters to the drift check.",
  steps: ["update-invoice:status-to-orders"],
};

// ── update-order → invoices ────────────────────────────────────────

const updateOrderInvoiceRules: CollectionRule[] = [
  {
    id: "update-order:items-to-invoices",
    source: "orders",
    target: "invoices",
    mode: "co-write",
    invariant: "Unpaid invoices stay in sync with their source orders — items and destinations scoped by order are selectively synced (respecting invoice-side overrides); scalar fields (subject, reference, organization) co-write only while the invoice value still matches the prev order value",
    enforced_by: [SELECTIVE_SYNC_SEMANTICS],
    trigger: "items, destinations, subject, reference, or organization change on order — targets invoices where query_by_orders contains order uid AND the invoice has no unreversed settlement (an active CREDIT freezes it too: re-syncing items under a credit re-bakes the drift the credit exists to separate)",
    fields: [
      { source: ["uid"], target: ["items", "uid"], transform: "match order divider by uid (= source order id) to scope item removal/rebuild" },
      { source: ["items"], target: ["items"], transform: "selective sync: compare prev order items to current invoice items by path — update only non-overridden items, add new items, remove deleted non-overridden items. Invoice-only fields (coa_revenue, tracking_category, xero_id, xero_tracking_option_id) are preserved." },
      { source: ["items"], target: ["totals"], transform: "recalculate totals server-side after item sync" },
      { source: ["destinations"], target: ["destinations"], transform: "selective sync within uid_order scope: match pairs by (delivery.uid, collection.uid) — update only non-overridden pairs, add new pairs (tagged with uid_order), remove deleted non-overridden pairs. Leaves pairs from other orders untouched." },
      { source: ["subject"], target: ["subject"], transform: "scalar co-write: overwrite only if invoice.subject deep-equals the prev order.subject; mismatch is treated as an invoice-side override and kept" },
      { source: ["reference"], target: ["reference"], transform: "scalar co-write: same override policy as subject" },
      { source: ["organization"], target: ["organization"], transform: "object co-write on (uid, name, xero_id, billing_address): overwrite only if the compared shape matches the prev order.organization snapshot; invoice.organization.tax_profile is preserved (invoice-owned)" },
    ],
  },
  {
    id: "update-order:status-to-invoices",
    source: "orders",
    target: "invoices",
    mode: "co-write",
    invariant: "When an order is canceled, unpaid invoices referencing it remove the order's scoped items, destinations, and uid from query_by_orders",
    enforced_by: [ORDER_SCOPED_REMOVAL],
    trigger: "status change to canceled — targets invoices where query_by_orders contains order uid AND the invoice has no unreversed settlement (payment or credit)",
    fields: [
      { source: ["uid"], target: ["query_by_orders"], transform: "remove order uid from query_by_orders array" },
      { source: ["uid"], target: ["items"], transform: "remove order divider and all items under its path scope" },
      { source: ["uid"], target: ["destinations"], transform: "remove destination pairs scoped to this order (uid_order match)" },
      { source: [], target: ["totals"], transform: "recalculate totals after scoped removal" },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `invoices.ts` contributes to the propagation catalog. */
export const invoices: PropagationModule = {
  rules: [
    ...createInvoiceRules,
    ...updateInvoiceOrderRules,
    ...updateOrderInvoiceRules,
  ],
  transactions: [
    createInvoiceTransaction,
    updateInvoiceTransaction,
  ],
};
