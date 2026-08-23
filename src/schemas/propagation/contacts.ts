/**
 * Contact propagation rules — create and update transactions.
 *
 * Traced from: api-cloudrun/src/services/contacts.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// The three NAME/PHONE cascades already carry their pointers inline (they are
// rows in `audit-denorm-freshness.ts`, two of them measured VACUOUS). What
// follows covers the membership and linking rules, which have no corpus
// detector at all — only the writer path.

const CONTACT_ORG_BACKREF: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/contacts/contacts.test.ts::PUT - removing an org strips the contact back-ref",
  clause:
    "the org-list diff, all three shapes, across four steps — the anchored one removes; `PUT - adding an org pushes the contact back-ref`, `PUT - swapping orgs in one call removes old + adds new back-refs` and `PUT - adding a nonexistent org returns 404` carry the rest. No corpus detector covers the resulting membership. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const CONTACT_ORG_BACKREF_AT_CREATE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/contacts/contacts.test.ts::POST - creates a contact with organization cross-reference",
  clause:
    "the same membership at CREATE — a contact created with an organization cross-reference appears on the org side too",
  gates: true,
};

const CONTACT_NAME_TO_USER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/contacts/contacts.test.ts::PUT - propagates name change to the linked user",
  clause:
    "the rename reaching the linked user's `name`. Writer-path only — `audit-actor-ref-names.ts` audits the ActorRef denorms fanned out FROM a user, not the contact→user edge feeding it.",
  gates: true,
};

// ── create-contact ───────────────────────────────────────────────

const createContactRules: CollectionRule[] = [
  {
    id: "create-contact:contact-to-orgs",
    source: "contacts",
    target: "organizations",
    mode: "co-write",
    invariant:
      "Organizations maintain a list of contacts for bidirectional navigation",
    enforced_by: [CONTACT_ORG_BACKREF_AT_CREATE],
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
    invariant:
      "When a contact is created with an email matching an existing user, link bidirectionally",
    transaction: "create-contact",
    fields: [
      { source: ["uid"], target: ["uid_contact"] },
    ],
  },
];

const createContactTransaction: TransactionDefinition = {
  id: "create-contact",
  description:
    "Creates a contact with bidirectional organization cross-references, optional user link, and a cowritten default thread.",
  steps: [
    "create-contact:contact-to-orgs",
    "create-contact:link-to-user",
    "cowrite-thread:contacts-to-thread",
    "cowrite-thread:thread-to-contacts",
  ],
};

// ── update-contact ───────────────────────────────────────────────

const updateContactRules: CollectionRule[] = [
  {
    id: "update-contact:name-to-orgs",
    source: "contacts",
    target: "organizations",
    mode: "fan-out",
    invariant: "Organizations display contact names in their contacts list",
    transaction: "update-contact",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `organizations←contacts` — all four name parts AND the derived `name`, compared against contacts/{uid} rather than against the ref's own fields",
      gates: true,
    }],
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
    invariant:
      "Active orders embed delivery/collection contact names in destinations",
    transaction: "update-contact",
    trigger: "name change — targets active orders (not canceled/complete)",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `orders←contacts`. VACUOUS TODAY: all 1,974 stored destination legs carry contact:null in both envs (re-measured 2026-08-16), so this compares nothing — the cascade is real but has never had a target. The reason is that every stored order is CRMS-authored and CRMS states no destination contact; `createOrder` reads one straight off the request, so the population is live the moment the manager mints an order",
      gates: false,
    }],
    fields: [
      {
        source: ["first_name"],
        target: ["destinations", "delivery", "contact", "first_name"],
      },
      {
        source: ["middle_name"],
        target: ["destinations", "delivery", "contact", "middle_name"],
      },
      {
        source: ["last_name"],
        target: ["destinations", "delivery", "contact", "last_name"],
      },
      {
        source: ["pronunciation"],
        target: ["destinations", "delivery", "contact", "pronunciation"],
      },
      {
        source: ["first_name"],
        target: ["destinations", "collection", "contact", "first_name"],
      },
      {
        source: ["middle_name"],
        target: ["destinations", "collection", "contact", "middle_name"],
      },
      {
        source: ["last_name"],
        target: ["destinations", "collection", "contact", "last_name"],
      },
      {
        source: ["pronunciation"],
        target: ["destinations", "collection", "contact", "pronunciation"],
      },
    ],
  },
  {
    id: "update-contact:phones-to-orders",
    source: "contacts",
    target: "orders",
    mode: "fan-out",
    invariant:
      "Active orders embed delivery/collection contact phones for logistics",
    transaction: "update-contact",
    trigger: "phones change — targets active orders",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `orders←contacts` (phones). VACUOUS TODAY for the same reason as the name row above",
      gates: false,
    }],
    fields: [
      {
        source: ["phones"],
        target: ["destinations", "delivery", "contact", "phones"],
      },
      {
        source: ["phones"],
        target: ["destinations", "collection", "contact", "phones"],
      },
    ],
  },
  {
    id: "update-contact:orgs-change",
    source: "contacts",
    target: "organizations",
    mode: "co-write",
    invariant:
      "When a contact's org list changes, added/removed orgs update their contact back-references",
    enforced_by: [CONTACT_ORG_BACKREF],
    transaction: "update-contact",
    fields: [
      {
        source: [],
        target: ["contacts"],
        transform:
          "orgs added → add contact ref {uid, first_name, middle_name, last_name, pronunciation, roles: []}",
      },
      {
        source: [],
        target: ["contacts"],
        transform: "orgs removed → remove contact ref",
      },
      {
        source: [],
        target: ["query_by_contacts"],
        transform: "orgs added → add contact uid",
      },
      {
        source: [],
        target: ["query_by_contacts"],
        transform: "orgs removed → remove contact uid",
      },
    ],
  },
  {
    id: "update-contact:name-to-user",
    source: "contacts",
    target: "users",
    mode: "fan-out",
    invariant: "A contact's name stays in sync with its linked user's name",
    enforced_by: [CONTACT_NAME_TO_USER],
    transaction: "update-contact",
    trigger:
      "first_name/middle_name/last_name/pronunciation change on a contact with uid_user set",
    fields: [
      { source: ["first_name"], target: ["first_name"] },
      { source: ["middle_name"], target: ["middle_name"] },
      { source: ["last_name"], target: ["last_name"] },
      { source: ["pronunciation"], target: ["pronunciation"] },
    ],
  },
];

const updateContactTransaction: TransactionDefinition = {
  id: "update-contact",
  description:
    "Updates a contact with name cascades to organizations, active order destinations, and linked user; phone cascades to active orders; and bidirectional org membership maintenance.",
  steps: [
    "update-contact:name-to-orgs",
    "update-contact:name-to-orders",
    "update-contact:phones-to-orders",
    "update-contact:orgs-change",
    "update-contact:name-to-user",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/contacts.ts` contributes to the propagation catalog. */
export const contacts: PropagationModule = {
  rules: [
    ...createContactRules,
    ...updateContactRules,
  ],
  transactions: [
    createContactTransaction,
    updateContactTransaction,
  ],
};
