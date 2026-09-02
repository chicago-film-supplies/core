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
// ⭐ **They now have a CORPUS detector too** (api-cloudrun#711).
// `audit-denorm-freshness.ts` carries six organization rows comparing each
// stored copy against `composeOrgName(path)` re-derived from the source, scoped
// to exactly what each cascade claims to maintain — the order and invoice rows
// import the cascade's own frozen-status predicates rather than restating them.
//
// ⚠️ **It found 63 stale denorms on prod the first time it ran**, all of them
// tree-migration residue: the migration rewrote `path` in place, so no rename
// fired, so nothing carried the new composed label to the copies. That is the
// exact failure this comment used to say nobody would notice — *"caught by
// nothing until someone reads a stale name on screen"* — and it went unnoticed
// for a day because the only thing that could have seen it did not exist.

const ORG_CONTACT_BACKREF: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - adds a contact and cross-references it",
  clause:
    "the membership half in both directions, across four steps of `Organizations CRUD` — the anchored one adds a contact and cross-references it; `PUT - removes a contact and cleans cross-reference`, `PUT - creates a new contact inline via newContacts` and `POST - an unknown contact uid is created, not rejected (#364)` carry the rest. No corpus detector covers the back-reference. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const ORG_NAME_TO_CONTACTS_TEST: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates name change to linked contacts",
  clause:
    "the rename reaching the linked contacts' embedded org entry, on THAT write. The corpus half is beside it.",
  gates: true,
};

/** The corpus half — api-cloudrun#711. */
const ORG_NAME_TO_CONTACTS_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
  clause:
    "row `update-org:name-to-contacts` — every `contacts.organizations[].name` against `composeOrgName(path)` re-derived from the organization, over ALL edges (a contact is not an issued document, so nothing about it is frozen). It also reports an edge naming an organization that no longer exists.",
  gates: true,
};

const ORG_NAME_TO_CONTACTS: EnforcementRef[] = [ORG_NAME_TO_CONTACTS_TEST, ORG_NAME_TO_CONTACTS_CORPUS];

const ORG_NAME_TO_ORDERS_TEST: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates name change to active orders",
  clause:
    "the rename reaching an ACTIVE order's `organization.path`, on THAT write — the CHAIN, since api-cloudrun `d06095a3`; the label is composed from it. The corpus half is beside it.",
  gates: true,
};

/** The corpus half — api-cloudrun#711. */
const ORG_NAME_TO_ORDERS_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
  clause:
    "row `update-org:name-to-orders` — `orders.organization.path` against the organization's own chain, scoped to NON-TERMINAL orders by the cascade's own predicate (`ORG_CASCADE_FROZEN_ORDER_STATUSES`, imported rather than restated). ⚠️ It compared `{name, path}` for one commit and was NARROWED in the same commit that stopped the writer: a freshness check on a field nothing keeps fresh is noise by construction, and it would bury the `path` signal beside it. Drift on a terminal order is counted separately and never fails: prod carries 469 of those and they are the design.",
  gates: true,
};

const ORG_NAME_TO_ORDERS: EnforcementRef[] = [ORG_NAME_TO_ORDERS_TEST, ORG_NAME_TO_ORDERS_CORPUS];

const ORG_BILLING_TO_ORDERS_TEST: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates billing_address change to active orders",
  clause:
    "the billing-address change reaching an active order's embedded snapshot, on THAT write. The corpus half is beside it.",
  gates: true,
};

/** The corpus half — api-cloudrun#711. */
const ORG_BILLING_TO_ORDERS_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
  clause:
    "row `update-org:billing-to-orders` — `orders.organization.billing_address` against the organization's own, same non-terminal scope. Structural equality, so a key-order difference is not drift.",
  gates: true,
};

const ORG_BILLING_TO_ORDERS: EnforcementRef[] = [ORG_BILLING_TO_ORDERS_TEST, ORG_BILLING_TO_ORDERS_CORPUS];

const ORG_NAME_TO_INVOICES_TEST: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates name change to active invoices",
  clause:
    "the rename reaching an active invoice's `organization.path`, on THAT write. The corpus half is beside it.",
  gates: true,
};

/** The corpus half — api-cloudrun#711. */
const ORG_NAME_TO_INVOICES_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
  clause:
    "row `update-org:name-to-invoices` — same comparison, scoped to UNSETTLED invoices by `SETTLED_STATUSES`.",
  gates: true,
};

const ORG_NAME_TO_INVOICES: EnforcementRef[] = [ORG_NAME_TO_INVOICES_TEST, ORG_NAME_TO_INVOICES_CORPUS];

/**
 * The order-derived pair (api-cloudrun#711, api-cloudrun#717).
 *
 * ⚠️ **The detector's oracle is the parent ORDER, not the organization**, and
 * that is deliberately STRONGER than the rule it enforces. A booking is not a
 * billing document — it has no customer of its own and carries no money a name
 * could misattribute — so there is no point in time at which one disagreeing
 * with its own order was correct, and the check needs no status predicate.
 * Comparing against the live organization instead would flag every booking on a
 * terminal order whose customer has since been renamed (~879 of 1,000 prod
 * orders), which is the detector nobody keeps switched on.
 *
 * It also catches a SECOND writer this rule does not describe: an order
 * repointed to a different organization, which strands its bookings the same way
 * and is fixed in `updateOrder`'s booking-rebuild gate.
 */
const ORG_NAME_TO_ORDER_CHILDREN_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
  clause:
    "rows `bookings←orders` and `fulfillments←orders` — each order-derived `organization` snapshot against its own order's, unfiltered. 171 bookings + 28 fulfillments repaired 2026-08-29 after an earlier repair rewrote their orders and left them behind.",
  gates: true,
};

const ORG_BILLING_TO_INVOICES_TEST: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::PUT - propagates billing_address change to active invoices",
  clause:
    "the billing-address change reaching an active invoice, on THAT write. The corpus half is beside it.",
  gates: true,
};

/** The corpus half — api-cloudrun#711. */
const ORG_BILLING_TO_INVOICES_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
  clause:
    "row `update-org:billing-to-invoices` — same comparison and scope as the name row.",
  gates: true,
};

const ORG_BILLING_TO_INVOICES: EnforcementRef[] = [ORG_BILLING_TO_INVOICES_TEST, ORG_BILLING_TO_INVOICES_CORPUS];

const ORG_TAX_AXES_TO_ORDERS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/organizations.test.ts",
  clause:
    "an org tax-AXES change (`jurisdiction_claim` / `tax_exempt`) RE-PRICING every non-terminal, un-invoiced order — not merely re-stamping the snapshot. Unlike its five siblings this cascade moves money, so the assertion is on `items[].price.taxes` and `totals`, not on a copied string. Its corpus detector is a DIFFERENT one from theirs and stays so: `api-cloudrun/scripts/audit-order-tax-snapshot.ts` walks both directions (snapshot vs live org, and stored taxes vs recomputed), which is a re-COMPUTATION rather than a string comparison.",
  gates: true,
};

const ORG_NODE_TO_TREE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/unit/organizationTreeCoverage.test.ts",
  clause:
    "that `computeOrganizationNode` is the ONE author of `path`/`query_by_path` — no writer in `src/` or `scripts/` builds either array by hand. The four one-document invariants are enforced by `OrganizationSchema`'s own refinement at every `validateBeforeWrite`, so they need no separate walker; this ratchet covers the authorship rule the schema cannot see. Hermetic, in `deno task gate`.",
  gates: true,
};

const ORG_NAME_TO_DESCENDANTS_TEST: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/organizations.test.ts",
  clause:
    "a node's own rename rewriting `path[i].name` on every descendant. ⚠️ The fan-out resolves its population with `where(\"query_by_path\", \"array-contains\", uid)` — a RANGE READ, so it must run OUTSIDE the transaction that writes those nodes, which is exactly the overlap `ContendedRangeError` refuses. Max measured descendant count is 11 (Netflix).",
  gates: true,
};

/**
 * The corpus half — `audit-organization-tree.ts` arm 5.
 *
 * ⚠️ **`path[i].name` needs no row in `audit-denorm-freshness.ts` and must not
 * get one.** Arm 5 already compares every node's `path.slice(0, -1)` to its
 * parent's own `path`, segment by segment including `name`, over the whole
 * corpus — so a stale ancestor segment is caught at the highest node carrying
 * it. A second implementation would be a second oracle for one fact.
 */
const ORG_NAME_TO_DESCENDANTS_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-organization-tree.ts",
  clause:
    "arm 5 — `validateOrganizationTree` over every node, asserting `path.slice(0, -1)` equals the parent's own `path` on uid, name AND derived. It plants a violation of every arm on each invocation, so a walker that stopped reaching the corpus reddens rather than reporting clean.",
  gates: true,
};

const ORG_NAME_TO_DESCENDANTS: EnforcementRef[] = [
  ORG_NAME_TO_DESCENDANTS_TEST,
  ORG_NAME_TO_DESCENDANTS_CORPUS,
];

const ORG_REPARENT_TO_DESCENDANTS: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/organizations.test.ts",
  clause:
    "a re-parent rewriting the whole subtree's `path` and `query_by_path`, with `path.slice(0, -1)` still equal to each node's parent's path afterwards. Paired with `api-cloudrun/scripts/audit-organization-tree.ts`, which re-asserts every invariant over both environments and exits non-zero on a violation — arm 5 is the corpus half of this rule, and it self-tests every arm on each invocation. The six older org rules now have their own detector too (api-cloudrun#711).",
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
      { source: ["path"], target: ["organizations", "name"] },
      { source: ["uid"], target: ["query_by_organizations"] },
    ],
  },
  {
    id: "create-org:node-to-tree",
    source: "organizations",
    target: "organizations",
    mode: "co-write",
    invariant:
      "A node's `path` is `[...its RESOLVED parent's path, itself]` — derived from the parent that EXISTS, never from a chain the client sent, so a chain that skips, misnames or over-claims an intermediate cannot survive a write. A create with no `uid_parent` is a root. ⚠️ **The API never MINTS an ancestor**, which is why this rule is not called `mint-ancestors`: a create names a parent that already exists or it is a root, and the only writer that invents a node is api-cloudrun's one-shot tree migration script (`scripts/migrate-organization-tree.ts` — not yet written), which logs no propagation and makes no CRMS or Xero call. A rule id no writer fires is a claim the coverage ratchet correctly refuses.",
    enforced_by: [ORG_NODE_TO_TREE],
    transaction: "create-organization",
    fields: [
      { source: ["path"], target: ["path"] },
      { source: ["path"], target: ["query_by_path"] },
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
    "create-org:node-to-tree",
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
    enforced_by: ORG_NAME_TO_CONTACTS,
    transaction: "update-organization",
    fields: [
      { source: ["path"], target: ["organizations", "name"] },
    ],
  },
  {
    id: "update-org:name-to-orders",
    source: "organizations",
    target: "orders",
    mode: "fan-out",
    // ⭐ **The CHAIN, not the composed label** — api-cloudrun `201773b2` +
    // `d06095a3`. The cascade used to move `organization.name` and leave
    // `organization.path` behind, which is what api-cloudrun#772 was: one block
    // carrying two policies. It now moves the chain alone, and every reader
    // composes `composeOrgName(path)` from it. The rule id keeps its name
    // because a propagation id is a stable key, not a description.
    invariant:
      "Active orders carry the customer's frozen org CHAIN, and every label is composed from it — so the chain must stay current",
    enforced_by: ORG_NAME_TO_ORDERS,
    transaction: "update-organization",
    trigger: "name or re-parent change — targets active orders (not complete/canceled)",
    fields: [
      { source: ["path"], target: ["organization", "path"] },
    ],
  },
  {
    id: "update-org:billing-to-orders",
    source: "organizations",
    target: "orders",
    mode: "fan-out",
    invariant:
      "Active orders carry the org billing address for quote/invoice generation",
    enforced_by: ORG_BILLING_TO_ORDERS,
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
    // Same move as `update-org:name-to-orders` above, same commits.
    invariant: "Active invoices carry the customer's frozen org CHAIN, and display a label composed from it",
    enforced_by: ORG_NAME_TO_INVOICES,
    transaction: "update-organization",
    trigger: "name or re-parent change — targets active invoices (not paid/void)",
    fields: [
      { source: ["path"], target: ["organization", "path"] },
    ],
  },
  {
    id: "update-org:name-to-bookings",
    source: "organizations",
    target: "bookings",
    mode: "fan-out",
    invariant: "A booking's organization snapshot follows its own order's",
    enforced_by: [ORG_NAME_TO_ORDER_CHILDREN_CORPUS],
    transaction: "update-organization",
    trigger:
      "name change — fans out over the orders the cascade rewrote, which is already scoped to non-terminal. A terminal order's snapshot is frozen, so its bookings stay in agreement and there is nothing to write.",
    fields: [
      { source: ["path"], target: ["organization", "name"] },
    ],
  },
  {
    id: "update-org:name-to-fulfillments",
    source: "organizations",
    target: "fulfillments",
    mode: "fan-out",
    invariant: "A fulfillment's organization snapshot follows its own order's",
    enforced_by: [ORG_NAME_TO_ORDER_CHILDREN_CORPUS],
    transaction: "update-organization",
    trigger: "name change — one fulfillment per rewritten order, keyed by the order's uid",
    fields: [
      { source: ["path"], target: ["organization", "name"] },
    ],
  },
  {
    id: "update-org:billing-to-invoices",
    source: "organizations",
    target: "invoices",
    mode: "fan-out",
    invariant: "Active invoices carry the org billing address",
    enforced_by: ORG_BILLING_TO_INVOICES,
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
  enforced_by: ORG_NAME_TO_DESCENDANTS,
  transaction: "update-organization",
  fields: [
    { source: ["path"], target: ["path"] },
  ],
};

const reparentRules: CollectionRule[] = [
  {
    id: "reparent-org:tree-to-descendants",
    source: "organizations",
    target: "organizations",
    mode: "fan-out",
    invariant:
      "Re-parenting a node rewrites `path` and `query_by_path` on the node and its whole subtree, recomputed through `computeOrganizationNode` rather than patched. ⚠️ Stored copies of the tree on OTHER collections are NOT rewritten: an edge stores the addressed node's uid only, and a document snapshot's `path` is frozen at write time deliberately — a re-parent must not rewrite history on an issued document.",
    enforced_by: [ORG_REPARENT_TO_DESCENDANTS],
    transaction: "reparent-organization",
    fields: [
      { source: ["path"], target: ["path"] },
      { source: ["path"], target: ["query_by_path"] },
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
    "update-org:name-to-bookings",
    "update-org:name-to-fulfillments",
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
