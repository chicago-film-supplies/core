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
 *    reference, or organization change, unpaid invoices (payments.length === 0)
 *    referencing the order via query_by_orders are updated — items and
 *    destinations scoped by order are selectively synced (respecting
 *    invoice-side overrides); scalar fields co-write only if the invoice
 *    value still matches the prev order value (else the invoice-side edit
 *    is treated as an override and kept). When an order is canceled, its
 *    scoped items, destinations, and uid are removed from unpaid invoices.
 *
 * Traced from: api-cloudrun/src/services/invoices.ts, orders.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-invoice ──────────────────────────────────────────────────

export const createInvoiceRules: CollectionRule[] = [
  {
    id: "create-invoice:invoice-to-orders",
    source: "invoices",
    target: "orders",
    mode: "co-write",
    invariant: "Orders carry a denormalized array of their invoices so the UI can show invoice status without a collection-group query",
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
    trigger: "items, destinations, subject, reference, or organization change on order — targets invoices where query_by_orders contains order uid AND payments is empty",
    fields: [
      { source: ["uid"], target: ["items", "uid_order"], transform: "match order divider by uid_order to scope item removal/rebuild" },
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
    trigger: "status change to canceled — targets invoices where query_by_orders contains order uid AND payments is empty",
    fields: [
      { source: ["uid"], target: ["query_by_orders"], transform: "remove order uid from query_by_orders array" },
      { source: ["uid"], target: ["items"], transform: "remove order divider and all items under its path scope" },
      { source: ["uid"], target: ["destinations"], transform: "remove destination pairs scoped to this order (uid_order match)" },
      { source: [], target: ["totals"], transform: "recalculate totals after scoped removal" },
    ],
  },
];
