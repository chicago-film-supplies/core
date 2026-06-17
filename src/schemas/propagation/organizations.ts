/**
 * Organization propagation rules — create and update transactions.
 *
 * Traced from: api-cloudrun/src/services/organizations.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-organization ──────────────────────────────────────────

export const createOrganizationRules: CollectionRule[] = [
  {
    id: "create-org:org-to-contacts",
    source: "organizations",
    target: "contacts",
    mode: "co-write",
    invariant: "Contacts maintain a list of orgs they belong to for bidirectional navigation",
    transaction: "create-organization",
    fields: [
      { source: ["uid"], target: ["organizations", "uid"] },
      { source: ["name"], target: ["organizations", "name"] },
      { source: ["uid"], target: ["query_by_organizations"] },
    ],
  },
];

export const createOrganizationTransaction: TransactionDefinition = {
  id: "create-organization",
  description: "Creates an organization with bidirectional contact cross-references and a cowritten default thread. CRMS + Xero sync runs pre/post-transaction.",
  steps: [
    "create-org:org-to-contacts",
    "cowrite-thread:organizations-to-thread",
    "cowrite-thread:thread-to-organizations",
  ],
};

// ── update-organization ──────────────────────────────────────────

export const updateOrganizationRules: CollectionRule[] = [
  {
    id: "update-org:name-to-contacts",
    source: "organizations",
    target: "contacts",
    mode: "fan-out",
    invariant: "Contacts display their org names — must stay current when org is renamed",
    transaction: "update-organization",
    fields: [
      { source: ["name"], target: ["organizations", "name"] },
    ],
  },
  {
    id: "update-org:name-to-orders",
    source: "organizations",
    target: "orders",
    mode: "fan-out",
    invariant: "Active orders carry a denormalized org name that must stay current",
    transaction: "update-organization",
    trigger: "name change — targets active orders (not complete/canceled)",
    fields: [
      { source: ["name"], target: ["organization", "name"] },
    ],
  },
  {
    id: "update-org:billing-to-orders",
    source: "organizations",
    target: "orders",
    mode: "fan-out",
    invariant: "Active orders carry the org billing address for quote/invoice generation",
    transaction: "update-organization",
    trigger: "billing_address change — targets active orders",
    fields: [
      { source: ["billing_address"], target: ["organization", "billing_address"] },
    ],
  },
  {
    id: "update-org:name-to-invoices",
    source: "organizations",
    target: "invoices",
    mode: "fan-out",
    invariant: "Active invoices display the org name",
    transaction: "update-organization",
    trigger: "name change — targets active invoices (not paid/void)",
    fields: [
      { source: ["name"], target: ["organization", "name"] },
    ],
  },
  {
    id: "update-org:billing-to-invoices",
    source: "organizations",
    target: "invoices",
    mode: "fan-out",
    invariant: "Active invoices carry the org billing address",
    transaction: "update-organization",
    trigger: "billing_address change — targets active invoices",
    fields: [
      { source: ["billing_address"], target: ["organization", "billing_address"] },
    ],
  },
  {
    id: "update-org:contacts-change",
    source: "organizations",
    target: "contacts",
    mode: "co-write",
    invariant: "When an org's contact list changes, added/removed contacts update their org back-references",
    transaction: "update-organization",
    fields: [
      { source: [], target: ["organizations"], transform: "contacts added → add org ref {uid, name}" },
      { source: [], target: ["organizations"], transform: "contacts removed → remove org ref" },
      { source: [], target: ["query_by_organizations"], transform: "contacts added → add org uid" },
      { source: [], target: ["query_by_organizations"], transform: "contacts removed → remove org uid" },
    ],
  },
];

export const updateOrganizationTransaction: TransactionDefinition = {
  id: "update-organization",
  description: "Updates an organization with name/billing cascades to contacts, active orders, and active invoices. CRMS + Xero sync post-transaction.",
  steps: [
    "update-org:name-to-contacts",
    "update-org:name-to-orders",
    "update-org:billing-to-orders",
    "update-org:name-to-invoices",
    "update-org:billing-to-invoices",
    "update-org:contacts-change",
  ],
};
