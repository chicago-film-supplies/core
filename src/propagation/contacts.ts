/**
 * Contact propagation rules — create and update transactions.
 *
 * Traced from: api-cloudrun/src/services/contacts.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-contact ───────────────────────────────────────────────

export const createContactRules: CollectionRule[] = [
  {
    id: "create-contact:contact-to-orgs",
    source: "contacts",
    target: "organizations",
    mode: "co-write",
    invariant: "Organizations maintain a list of contacts for bidirectional navigation",
    transaction: "create-contact",
    fields: [
      { source: ["uid"], target: ["contacts", "uid"] },
      { source: ["first_name"], target: ["contacts", "first_name"] },
      { source: ["middle_name"], target: ["contacts", "middle_name"] },
      { source: ["last_name"], target: ["contacts", "last_name"] },
      { source: ["pronunciation"], target: ["contacts", "pronunciation"] },
      { source: ["uid"], target: ["query_by_contacts"] },
    ],
  },
  {
    id: "create-contact:link-to-user",
    source: "contacts",
    target: "users",
    mode: "co-write",
    invariant: "When a contact is created with an email matching an existing user, link bidirectionally",
    transaction: "create-contact",
    fields: [
      { source: ["uid"], target: ["uid_contact"] },
    ],
  },
];

export const createContactTransaction: TransactionDefinition = {
  id: "create-contact",
  description: "Creates a contact with bidirectional organization cross-references, optional user link, and a cowritten default thread.",
  steps: [
    "create-contact:contact-to-orgs",
    "create-contact:link-to-user",
    "cowrite-thread:contacts-to-thread",
    "cowrite-thread:thread-to-contacts",
  ],
};

// ── update-contact ───────────────────────────────────────────────

export const updateContactRules: CollectionRule[] = [
  {
    id: "update-contact:name-to-orgs",
    source: "contacts",
    target: "organizations",
    mode: "fan-out",
    invariant: "Organizations display contact names in their contacts list",
    transaction: "update-contact",
    fields: [
      { source: ["first_name"], target: ["contacts", "first_name"] },
      { source: ["middle_name"], target: ["contacts", "middle_name"] },
      { source: ["last_name"], target: ["contacts", "last_name"] },
      { source: ["pronunciation"], target: ["contacts", "pronunciation"] },
    ],
  },
  {
    id: "update-contact:name-to-orders",
    source: "contacts",
    target: "orders",
    mode: "fan-out",
    invariant: "Active orders embed delivery/collection contact names in destinations",
    transaction: "update-contact",
    trigger: "name change — targets active orders (not canceled/complete)",
    fields: [
      { source: ["first_name"], target: ["destinations", "delivery", "contact", "first_name"] },
      { source: ["middle_name"], target: ["destinations", "delivery", "contact", "middle_name"] },
      { source: ["last_name"], target: ["destinations", "delivery", "contact", "last_name"] },
      { source: ["pronunciation"], target: ["destinations", "delivery", "contact", "pronunciation"] },
      { source: ["first_name"], target: ["destinations", "collection", "contact", "first_name"] },
      { source: ["middle_name"], target: ["destinations", "collection", "contact", "middle_name"] },
      { source: ["last_name"], target: ["destinations", "collection", "contact", "last_name"] },
      { source: ["pronunciation"], target: ["destinations", "collection", "contact", "pronunciation"] },
    ],
  },
  {
    id: "update-contact:phones-to-orders",
    source: "contacts",
    target: "orders",
    mode: "fan-out",
    invariant: "Active orders embed delivery/collection contact phones for logistics",
    transaction: "update-contact",
    trigger: "phones change — targets active orders",
    fields: [
      { source: ["phones"], target: ["destinations", "delivery", "contact", "phones"] },
      { source: ["phones"], target: ["destinations", "collection", "contact", "phones"] },
    ],
  },
  {
    id: "update-contact:orgs-change",
    source: "contacts",
    target: "organizations",
    mode: "co-write",
    invariant: "When a contact's org list changes, added/removed orgs update their contact back-references",
    transaction: "update-contact",
    fields: [
      { source: [], target: ["contacts"], transform: "orgs added → add contact ref {uid, first_name, middle_name, last_name, pronunciation, roles: []}" },
      { source: [], target: ["contacts"], transform: "orgs removed → remove contact ref" },
      { source: [], target: ["query_by_contacts"], transform: "orgs added → add contact uid" },
      { source: [], target: ["query_by_contacts"], transform: "orgs removed → remove contact uid" },
    ],
  },
  {
    id: "update-contact:name-to-user",
    source: "contacts",
    target: "users",
    mode: "fan-out",
    invariant: "A contact's name stays in sync with its linked user's name",
    transaction: "update-contact",
    trigger: "first_name/middle_name/last_name/pronunciation change on a contact with uid_user set",
    fields: [
      { source: ["first_name"], target: ["first_name"] },
      { source: ["middle_name"], target: ["middle_name"] },
      { source: ["last_name"], target: ["last_name"] },
      { source: ["pronunciation"], target: ["pronunciation"] },
    ],
  },
];

export const updateContactTransaction: TransactionDefinition = {
  id: "update-contact",
  description: "Updates a contact with name cascades to organizations, active order destinations, and linked user; phone cascades to active orders; and bidirectional org membership maintenance.",
  steps: [
    "update-contact:name-to-orgs",
    "update-contact:name-to-orders",
    "update-contact:phones-to-orders",
    "update-contact:orgs-change",
    "update-contact:name-to-user",
  ],
};
