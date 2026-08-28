/**
 * Organization propagation rules — create and update transactions.
 *
 * Traced from: api-cloudrun/src/services/organizations.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// Every rule in this file has a dedicated step in the org suite that asserts the
// TARGET document after the write, which is the difference that matters: a
// cascade reaching zero targets is indistinguishable from one with nothing to
// do unless something reads the other side.
//
// ⚠️ None of them has a CORPUS detector. `audit-denorm-freshness.ts` holds
// twelve embedded-name rows and none is organizations→{orders, invoices,
// contacts}, though the table is exactly the shape that would hold them — so a
// cascade that stops firing in production is caught by nothing until someone
// reads a stale name on screen.

const ORG_CONTACT_BACKREF: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - adds a contact and cross-references it",
  clause:
    "the membership half in both directions, across four steps of `Organizations CRUD` — the anchored one adds a contact and cross-references it; `PUT - removes a contact and cleans cross-reference`, `PUT - creates a new contact inline via newContacts` and `POST - an unknown contact uid is created, not rejected (#364)` carry the rest. No corpus detector covers the back-reference. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const ORG_NAME_TO_CONTACTS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates name change to linked contacts",
  clause:
    "the rename reaching the linked contacts' embedded org entry. Writer-path only — no corpus walk exists for this denorm.",
  gates: true,
};

const ORG_NAME_TO_ORDERS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates name change to active orders",
  clause:
    "the rename reaching an ACTIVE order's `organization.name`. Writer-path only; `audit-denorm-freshness.ts` has no organizations→orders row, so corpus staleness is undetected.",
  gates: true,
};

const ORG_BILLING_TO_ORDERS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates billing_address change to active orders",
  clause:
    "the billing-address change reaching an active order's embedded snapshot. Writer-path only.",
  gates: true,
};

const ORG_NAME_TO_INVOICES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates name change to active invoices",
  clause:
    "the rename reaching an active invoice's `organization.name`. Writer-path only.",
  gates: true,
};

const ORG_BILLING_TO_INVOICES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates billing_address change to active invoices",
  clause:
    "the billing-address change reaching an active invoice. Writer-path only.",
  gates: true,
};

const ORG_TAX_AXES_TO_ORDERS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/organizations.test.ts",
  clause:
    "an org tax-AXES change (`jurisdiction_claim` / `tax_exempt`) RE-PRICING every non-terminal, un-invoiced order — not merely re-stamping the snapshot. Unlike its five siblings this cascade moves money, so the assertion is on `items[].price.taxes` and `totals`, not on a copied string. Paired with a corpus detector, which the name/billing rules do not have: `api-cloudrun/scripts/audit-order-tax-snapshot.ts` walks both directions (snapshot vs live org, and stored taxes vs recomputed).",
  gates: true,
};

const ORG_MINT_ANCESTORS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/organizationTreeCoverage.test.ts",
  clause:
    "that `computeOrganizationNode` is the ONE author of `path`/`query_by_organizations` — no writer in `src/` or `scripts/` builds either array by hand. The four one-document invariants are enforced by `OrganizationSchema`'s own refinement at every `validateBeforeWrite`, so they need no separate walker; this ratchet covers the authorship rule the schema cannot see. Hermetic, in `deno task gate`.",
  gates: true,
};

const ORG_NAME_TO_DESCENDANTS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/organizations.test.ts",
  clause:
    "a node's own rename rewriting `path[i].name` on every descendant. ⚠️ The fan-out resolves its population with `where(\"query_by_organizations\", \"array-contains\", uid)` — a RANGE READ, so it must run OUTSIDE the transaction that writes those nodes, which is exactly the overlap `ContendedRangeError` refuses. Max measured descendant count is 11 (Netflix).",
  gates: true,
};

const ORG_REPARENT_TO_DESCENDANTS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/organizations.test.ts",
  clause:
    "a re-parent rewriting the whole subtree's `path` and `query_by_organizations`, with `path.slice(0, -1)` still equal to each node's parent's path afterwards. Paired with a corpus detector — `api-cloudrun/scripts/audit-organization-tree.ts` re-asserts every invariant over both environments and exits non-zero on a violation, which none of the six older org rules has.",
  gates: true,
};

// ── create-organization ──────────────────────────────────────────

const createOrganizationRules: CollectionRule[] = [
  {
    id: "create-org:org-to-contacts",
    source: "organizations",
    target: "contacts",
    mode: "co-write",
    invariant:
      "Contacts maintain a list of orgs they belong to for bidirectional navigation",
    enforced_by: [ORG_CONTACT_BACKREF],
    transaction: "create-organization",
    fields: [
      { source: ["uid"], target: ["organizations", "uid"] },
      { source: ["name"], target: ["organizations", "name"] },
      { source: ["uid"], target: ["query_by_organizations"] },
    ],
  },
  {
    id: "create-org:mint-ancestors",
    source: "organizations",
    target: "organizations",
    mode: "co-write",
    invariant:
      "A node's `path` is `[...its RESOLVED parent's path, itself]` — derived from the parent that exists, never from a chain the client sent. Where an ancestor does not exist yet it is MINTED, carrying `derived: true` and a `derived_from` provenance so a later realignment can find the population.",
    enforced_by: [ORG_MINT_ANCESTORS],
    transaction: "create-organization",
    fields: [
      { source: ["path"], target: ["path"] },
      { source: ["path"], target: ["query_by_organizations"] },
      { source: ["uid"], target: ["derived_from", "source_uid"] },
    ],
  },
];

const createOrganizationTransaction: TransactionDefinition = {
  id: "create-organization",
  description:
    "Creates an organization with bidirectional contact cross-references and a cowritten default thread. CRMS + Xero sync runs pre/post-transaction.",
  steps: [
    "create-org:org-to-contacts",
    "create-org:mint-ancestors",
    "cowrite-thread:organizations-to-thread",
    "cowrite-thread:thread-to-organizations",
  ],
};

// ── update-organization ──────────────────────────────────────────

const updateOrganizationRules: CollectionRule[] = [
  {
    id: "update-org:name-to-contacts",
    source: "organizations",
    target: "contacts",
    mode: "fan-out",
    invariant:
      "Contacts display their org names — must stay current when org is renamed",
    enforced_by: [ORG_NAME_TO_CONTACTS],
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
    invariant:
      "Active orders carry a denormalized org name that must stay current",
    enforced_by: [ORG_NAME_TO_ORDERS],
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
    invariant:
      "Active orders carry the org billing address for quote/invoice generation",
    enforced_by: [ORG_BILLING_TO_ORDERS],
    transaction: "update-organization",
    trigger: "billing_address change — targets active orders",
    fields: [
      {
        source: ["billing_address"],
        target: ["organization", "billing_address"],
      },
    ],
  },
  {
    id: "update-org:name-to-invoices",
    source: "organizations",
    target: "invoices",
    mode: "fan-out",
    invariant: "Active invoices display the org name",
    enforced_by: [ORG_NAME_TO_INVOICES],
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
    enforced_by: [ORG_BILLING_TO_INVOICES],
    transaction: "update-organization",
    trigger: "billing_address change — targets active invoices",
    fields: [
      {
        source: ["billing_address"],
        target: ["organization", "billing_address"],
      },
    ],
  },
  {
    id: "update-org:tax-axes-to-orders",
    source: "organizations",
    target: "orders",
    mode: "fan-out",
    invariant:
      "An order's stored line taxes are computed under its organization's current tax AXES — `jurisdiction_claim` supplies the level-2 jurisdiction and `tax_exempt` zeroes the result — unless a destination names its own",
    enforced_by: [ORG_TAX_AXES_TO_ORDERS],
    transaction: "update-organization",
    trigger:
      "a `jurisdiction_claim` or `tax_exempt` change — targets non-terminal orders that carry no invoice. An invoiced order is skipped: its money is already committed downstream, and `POST /orders/{uid}/tax-resync` is the deliberate repair path for it.",
    fields: [
      {
        source: ["jurisdiction_claim"],
        target: ["organization", "jurisdiction_claim"],
      },
      { source: ["tax_exempt"], target: ["organization", "tax_exempt"] },
      // ⚠️ **One entry per AXIS, not one entry naming both.** `source` is a
      // dotted PATH — `["jurisdiction_claim", "tax_exempt"]` resolves as
      // `jurisdiction_claim.tax_exempt` and matches no field, which
      // `tests/propagation.test.ts` catches. The enum was one field and so
      // needed one entry; two axes need two, on each of the two targets.
      {
        source: ["jurisdiction_claim"],
        target: ["items", "price", "taxes"],
        transform:
          "materializeDocumentTax over `documentTaxContext({ organization, documentExempt, destinations, origin, taxes, at })` — a PURE function of (items, axes, destinations, origin, catalog, asOf), which is what makes it safe under `convergeCascade`'s idempotent-apply contract",
      },
      {
        source: ["tax_exempt"],
        target: ["items", "price", "taxes"],
        transform:
          "the same materializeDocumentTax call — the exemption axis zeroes what the jurisdiction axis resolves, so both move the same target and neither is sufficient alone",
      },
      {
        source: ["jurisdiction_claim"],
        target: ["totals"],
        transform: "calculateOrderTotals after the reprice",
      },
      {
        source: ["tax_exempt"],
        target: ["totals"],
        transform: "calculateOrderTotals after the reprice",
      },
    ],
  },
  {
    id: "update-org:contacts-change",
    source: "organizations",
    target: "contacts",
    mode: "co-write",
    invariant:
      "When an org's contact list changes, added/removed contacts update their org back-references",
    enforced_by: [ORG_CONTACT_BACKREF],
    transaction: "update-organization",
    fields: [
      {
        source: [],
        target: ["organizations"],
        transform: "contacts added → add org ref {uid, name}",
      },
      {
        source: [],
        target: ["organizations"],
        transform: "contacts removed → remove org ref",
      },
      {
        source: [],
        target: ["query_by_organizations"],
        transform: "contacts added → add org uid",
      },
      {
        source: [],
        target: ["query_by_organizations"],
        transform: "contacts removed → remove org uid",
      },
    ],
  },
];

const nameToDescendantsRule: CollectionRule = {
  id: "update-org:name-to-descendants",
  source: "organizations",
  target: "organizations",
  mode: "fan-out",
  invariant:
    "Every descendant embeds this node's name in its own `path`, so a rename must rewrite `path[i].name` on all of them. ⚠️ It pushes each affected LEAF's Xero contact rename (one call per leaf — Xero renders an invoice's contact from the live contact record, so CFS never touches a Xero invoice to rename a customer), and only where the COMPOSED name actually changed.",
  enforced_by: [ORG_NAME_TO_DESCENDANTS],
  transaction: "update-organization",
  fields: [
    { source: ["name"], target: ["path"] },
  ],
};

const reparentRules: CollectionRule[] = [
  {
    id: "reparent-org:tree-to-descendants",
    source: "organizations",
    target: "organizations",
    mode: "fan-out",
    invariant:
      "Re-parenting a node rewrites `path` and `query_by_organizations` on the node and its whole subtree, recomputed through `computeOrganizationNode` rather than patched. ⚠️ Stored copies of the tree on OTHER collections are NOT rewritten: an edge stores the addressed node's uid only, and a document snapshot's `path` is frozen at write time deliberately — a re-parent must not rewrite history on an issued document.",
    enforced_by: [ORG_REPARENT_TO_DESCENDANTS],
    transaction: "reparent-organization",
    fields: [
      { source: ["path"], target: ["path"] },
      { source: ["path"], target: ["query_by_organizations"] },
    ],
  },
];

const reparentOrganizationTransaction: TransactionDefinition = {
  id: "reparent-organization",
  description:
    "Moves an organization node to a new parent (or promotes it to a root), rewriting its subtree's `path`. Its OWN transaction rather than a borrowed `update-organization`: it fires the tree rewrite plus every name and snapshot rule once per descendant, so `rules_expected` genuinely differs — and a borrowed transaction id turns the drift warning off silently.",
  steps: [
    "reparent-org:tree-to-descendants",
    "update-org:name-to-descendants",
    "update-org:name-to-contacts",
    "update-org:name-to-orders",
    "update-org:name-to-invoices",
  ],
};

const updateOrganizationTransaction: TransactionDefinition = {
  id: "update-organization",
  description:
    "Updates an organization with name/billing cascades to contacts, active orders, and active invoices. CRMS + Xero sync post-transaction.",
  steps: [
    "update-org:name-to-contacts",
    "update-org:name-to-orders",
    "update-org:billing-to-orders",
    "update-org:name-to-invoices",
    "update-org:billing-to-invoices",
    "update-org:tax-axes-to-orders",
    "update-org:contacts-change",
    "update-org:name-to-descendants",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/organizations.ts` contributes to the propagation catalog. */
export const organizations: PropagationModule = {
  rules: [
    ...createOrganizationRules,
    ...updateOrganizationRules,
    nameToDescendantsRule,
    ...reparentRules,
  ],
  transactions: [
    createOrganizationTransaction,
    updateOrganizationTransaction,
    reparentOrganizationTransaction,
  ],
};
