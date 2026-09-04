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

const ORG_MINT_DERIVED_PROJECT: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/organizations/organizations.test.ts::POST - a department naming an ORGANIZATION mints the derived (default) project between them",
  clause:
    "the mint on the first department, the REUSE on the second (asserted as a count of the parent's derived children, which is the only thing that separates reuse from a silent duplicate — invariant 6 would refuse neither), and that a department created under a PROJECT mints nothing. The minted node's `crms_id`/`xero_id` are asserted null against the mocked CRMS/Xero, which is what proves it did not recurse through the create path. ⚠️ No corpus detector: `scripts/audit-organization-tree.ts` arm 0 would catch a MALFORMED mint but cannot see a missing one, since a department that was never created leaves nothing behind. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
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
      // ⭐ **The `["organizations","name"]` mapping is GONE, not repointed**
      // (api-cloudrun#782). The edge stores the addressed uid alone and the label
      // is composed from the organization wherever it is produced, so there is no
      // second field for this co-write to author. What remains is the membership
      // itself plus its flat `array-contains` mirror — which is the whole of what
      // this edge ever meant.
      { source: ["uid"], target: ["query_by_organizations"] },
    ],
  },
  {
    id: "create-org:node-to-tree",
    source: "organizations",
    target: "organizations",
    mode: "co-write",
    invariant:
      "A node's `path` is `[...its RESOLVED parent's path, itself]` — derived from the parent that EXISTS, never from a chain the client sent, so a chain that skips, misnames or over-claims an intermediate cannot survive a write. A create with no `uid_parent` is a root. ⚠️ **This rule covers THE NODE BEING CREATED and nothing else.** It once carried a second claim — that the API never mints an ancestor, the only inventor being a one-shot migration script — and both halves of that expired: the script was written, run and deleted, and the live create path now mints a derived `(default)` project when a department names a depth-1 parent. That mint is `create-org:mint-derived-project`, deliberately its OWN id rather than folded in here, because it writes a DIFFERENT document — an ancestor, which is neither this node nor a descendant — and because `path → path` below would otherwise mean two documents at once.",
    enforced_by: [ORG_NODE_TO_TREE],
    transaction: "create-organization",
    fields: [
      { source: ["path"], target: ["path"] },
      { source: ["path"], target: ["query_by_path"] },
      // ⚠️ **This mapping describes a MINTED node, and it is the one field here
      // that this rule does not author on an ordinary create.** It is left in
      // place because `create-org:mint-derived-project` writes the node whose
      // `derived_from.source_uid` this is, and the two rules co-write one tree
      // in one transaction — see that rule for who sets it.
      { source: ["uid"], target: ["derived_from", "source_uid"] },
    ],
  },
  {
    id: "create-org:mint-derived-project",
    source: "organizations",
    target: "organizations",
    mode: "co-write",
    invariant:
      "A DEPARTMENT may name an ORGANIZATION as its parent, and the server supplies the project level in between. Invariant 8 is a biconditional — a non-derived depth-3 node must name a `department-types` entry and nothing shallower may — so a department needs a project above it; requiring the operator to invent one first is two documents and two round trips through a blank form. So when `uid_department_type` is set and the resolved parent is at depth 1, this REUSES the parent's existing derived project or MINTS one: `name: \"(default)\"`, `derived: true`, `derived_from: { source_uid: <the new department>, reason: \"minted-project\" }`. `composeOrgName` drops a derived segment, so the label reads `Waterloo West Productions LLC / Grip` and no `(default)` reaches an invoice, a Xero contact or a picker. ⚠️ **REUSE-FIRST is load-bearing, not an optimisation**: invariant 6 scopes sibling-name uniqueness to NON-derived siblings, so a second `(default)` would not be refused — it would silently coexist. 🔴 **The mint must NOT recurse through the create path**: that POSTs a live CRMS member and creates a live Xero contact, and a derived ancestor carries `crms_id: null` / `xero_id: null` by construction. It is written as a plain document in the same transaction, the way the retired migration did, with its own co-written thread.",
    enforced_by: [ORG_MINT_DERIVED_PROJECT],
    transaction: "create-organization",
    trigger: "a create carrying `uid_department_type` whose resolved parent is at depth 1",
    fields: [
      { source: ["path"], target: ["path"] },
      { source: ["path"], target: ["query_by_path"] },
      { source: ["uid"], target: ["derived_from", "source_uid"] },
      { source: ["uid"], target: ["derived_from", "reason"] },
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
    // ⚠️ Conditional — it fires only for a department naming a depth-1 parent.
    // `propagationCoverage` resolves a step from the `rules_fired` binding at the
    // call site and follows a `push`, so a conditional arm satisfies it exactly
    // as `create-org:org-to-contacts` already does.
    "create-org:mint-derived-project",
    "cowrite-thread:organizations-to-thread",
    "cowrite-thread:thread-to-organizations",
  ],
};

// ── update-organization ──────────────────────────────────────────

const updateOrganizationRules: CollectionRule[] = [
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
      // ⭐ **The CHAIN, and only the chain — `name` is gone from these blocks as of
      // api-cloudrun#782 (population A1).** What actually reaches a booking is
      // its own ORDER's snapshot, which this cascade has just rewritten; the
      // `organizations` source named here is that value one hop upstream.
      // Carrying the chain is what lets a reader call `composeOrgName` locally,
      // with no join, and it preserves the invariant above by construction —
      // the booking holds the order's chain, so it cannot disagree with it.
      // `name` is removed from this list at contract time.
      { source: ["path"], target: ["organization", "path"] },
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
      // The chain — see `update-org:name-to-bookings`.
      { source: ["path"], target: ["organization", "path"] },
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
        // ⭐ **`{uid}`, not `{uid, name}`** (api-cloudrun#782, core `72a7820`).
        // The edge's `name` was DELETED from `ContactSchema`, which is a
        // `z.strictObject` — so this line did not merely describe a field that
        // had stopped being maintained, it described a write the schema now
        // REFUSES. The label is composed from the organization wherever it is
        // produced; the edge carries the addressed uid alone.
        transform: "contacts added → add org ref {uid}",
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
      "Re-parenting a node rewrites `path` and `query_by_path` on the node and its whole subtree, recomputed through `computeOrganizationNode` rather than patched. ⚠️ **An EDGE is still not rewritten — but a document SNAPSHOT now is** (api-cloudrun#767). `contacts.organizations[]` and `destinations.organizations[]` store the addressed node's uid alone, so a move has nothing to push at them. An order and an invoice store the CHAIN, and a move is precisely what replaces every ancestor above the node's own segment — so this transaction also fires `update-org:name-to-orders` / `-to-invoices` down the whole moved subtree. 🔴 **\"Frozen at write time\" survives and is what bounds it**: the freeze is a property of the DOCUMENT'S LIFECYCLE, not of the field, so the cascade is scoped to non-terminal orders and unsettled invoices and an ISSUED document is still never rewritten by a move.",
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
    "update-org:name-to-orders",
    "update-org:name-to-invoices",
    // ⚠️ **Added because they now FIRE, not to widen the declaration**
    // (api-cloudrun#789). A booking and a fulfillment copy their order's chain,
    // and `syncOrderDerivedOrganization`'s invariant is that a child holding its
    // order's chain cannot disagree with it — so once a move rewrites an order's
    // chain, it must run. They shipped firing under this transaction while
    // declared only on `update-organization`; nothing checks fired-⊄-declared, so
    // this is the declaration catching up.
    "update-org:name-to-bookings",
    "update-org:name-to-fulfillments",
    // ⚠️ **Added for the same reason, one tier later** (api-cloudrun#801). A move
    // changes which ancestors a node has, so a node that INHERITS its billing
    // address resolves to a different one afterwards — and its live orders and
    // invoices froze the old answer. `updateOrganization` now re-resolves the
    // moved subtree whenever the moved node states no address of its own, which
    // fires both billing rules under this transaction.
    //
    // 🔴 **`rules_expected` is `steps.length` — a COUNT — and the standing drift
    // query is `rules_fired_count:<rules_expected`.** So an omission here does
    // not merely understate the docs, it LOWERS THE THRESHOLD the detector
    // compares against: six declared while eight fire means a later regression
    // where the billing arm stops firing reports 6 of 6 and reads healthy. This
    // declaration is the oracle for that failure.
    //
    // ⚠️ Nothing checks fired-⊄-declared — `deno task gate` is green with these
    // firing undeclared — so the omission is silent in both directions.
    "update-org:billing-to-orders",
    "update-org:billing-to-invoices",
  ],
};

const updateOrganizationTransaction: TransactionDefinition = {
  id: "update-organization",
  description:
    "Updates an organization with name/billing cascades to contacts, active orders, and active invoices. CRMS + Xero sync post-transaction.",
  steps: [
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
