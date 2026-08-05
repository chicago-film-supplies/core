/**
 * Invoice propagation rules — bidirectional invoice↔order cross-references.
 *
 * 1. create-invoice: co-writes invoice summary (uid, number, status) to each
 *    referenced order's `invoices` array and `query_by_invoices`.
 *
 * 2. update-invoice: co-writes status changes back to each order's `invoices`
 *    array entry when an invoice's status changes (e.g. issued → paid).
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
import type { CollectionRule, EnforcementRef, TransactionDefinition } from "./types.ts";

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

const INVOICE_BACKREF_STATUS_FOLLOWS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/invoices/invoices.test.ts:1053",
  clause:
    "the status half — settling an issued invoice flips it to `paid` AND the order's `invoices[0].status` follows in the same request. Covers the settlement path specifically, not every status transition.",
  gates: true,
};

/**
 * The selective-sync semantics are pure functions in `@cfs/core/utils/invoices`,
 * and they are where the override policy actually lives — so the tests over them
 * are the real enforcement, not an approximation of it.
 */
const SELECTIVE_SYNC_SEMANTICS: EnforcementRef = {
  kind: "test",
  ref: "core/tests/invoices.test.ts:461",
  clause:
    "the override policy, per helper — `syncOrderToInvoiceSelective` and `syncOrderItems` (scoped replace + `carryForwardOverrides` keeping `coa_revenue`/`xero_id`), `syncOrderDestinationsSelective` (adds tagged with `uid_order`, keeps overridden pairs, drops non-overridden removals, leaves other orders' pairs untouched), and `syncScalarWithOverride`/`syncObjectWithOverride` both directions. Does NOT cover the FREEZE predicate that decides which invoices are eligible.",
  gates: true,
};

const ORDER_SCOPED_REMOVAL: EnforcementRef = {
  kind: "test",
  ref: "core/tests/invoices.test.ts:244",
  clause:
    "the scoped-removal half — `removeOrderScopedItems` drops one order divider's whole subtree and keeps the other's. Says nothing about `query_by_orders` or the totals recompute that follow it.",
  gates: true,
};

// ── create-invoice ──────────────────────────────────────────────────

export const createInvoiceRules: CollectionRule[] = [
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

export const createInvoiceTransaction: TransactionDefinition = {
  id: "create-invoice",
  description: "Creates an invoice, co-writes invoice summary to each referenced order, and cowrites a default thread.",
  steps: [
    "create-invoice:invoice-to-orders",
    "cowrite-thread:invoices-to-thread",
    "cowrite-thread:thread-to-invoices",
  ],
};

// ── update-invoice (status → orders) ────────────────────────────────

export const updateInvoiceOrderRules: CollectionRule[] = [
  {
    id: "update-invoice:status-to-orders",
    source: "invoices",
    target: "orders",
    mode: "co-write",
    invariant: "Order invoice summaries stay current — when an invoice status changes (e.g. draft→issued, issued→paid), each order's invoices[] entry is updated atomically",
    enforced_by: [INVOICE_BACKREF_STATUS_FOLLOWS],
    trigger: "invoice status changes — targets orders referenced in query_by_orders",
    fields: [
      { source: ["status"], target: ["invoices", "status"], transform: "find matching entry in orders.invoices[] by uid, update its status" },
    ],
  },
];

export const updateInvoiceTransaction: TransactionDefinition = {
  id: "update-invoice",
  description: "Updates invoice status and co-writes status change to referenced orders",
  steps: ["update-invoice:status-to-orders"],
};

// ── update-order → invoices ────────────────────────────────────────

export const updateOrderInvoiceRules: CollectionRule[] = [
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
