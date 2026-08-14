/**
 * Product propagation rules — create-product and update-product transactions.
 *
 * Traced from: api-cloudrun/src/services/products.ts
 */
import type { CollectionRule, EnforcementRef, TransactionDefinition } from "./types.ts";
import { seedStockRules } from "./stock.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// `audit-component-graph.ts` names these four rules in its own header and says
// which clause of each it can decide, so the pointers below are its statement
// rather than a re-derivation of it.

/** Properties 1 + 2 — the two readings of the same relationship. */
const COMPONENT_RECIPROCITY: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-component-graph.ts",
  clause:
    "properties 1 + 2 — `P.components ∋ C ⟺ C.component_of ∋ P`, and the flat `query_by_components` / `query_by_component_of` arrays equalling their entry sets. The two are deliberately separate: they are the same relationship read as entries and as the uid array the cascade's own fan-out query uses, so neither can certify the other. Exit 0 clean / 1 defects / 2 INCONCLUSIVE.",
  gates: true,
};

/** Properties 3 + 4 + 5 — the unconditional half of the catalog cascade. */
const COMPONENT_CATALOG_CASCADE: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-component-graph.ts",
  clause:
    "properties 3 + 4 + 5 — every entry's catalog fields (`name`, `active`, `type`, `stock_method`, `crms_id`) equal `products/{uid}`'s, `alternates[].name` likewise, and a component `path` anchors at `path[0]` with every segment resolving. The path property is asserted DIRECTLY rather than by recomputing and comparing — the fixed-point hole that let `audit-item-paths.ts` certify 79 wrong items.",
  gates: true,
};

/**
 * ⚠️ The BUSINESS-field half of `component-entry-to-parents` is undecidable
 * from a snapshot, and the audit says so rather than guessing. A parent that
 * deliberately prices its bundled component differently is indistinguishable, in
 * stored data, from one whose cascade was missed — both read as "parent value ≠
 * component's own value". Separating them needs the pre-update value, which
 * nothing retains. So the audit reports those divergences as INFORMATIONAL and
 * never fails on them, and this pointer claims only the catalog clause.
 */
const COMPONENT_ENTRY_CATALOG_ONLY: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-component-graph.ts",
  clause:
    "the CATALOG clause only. The override-aware business fields (`price`, `quantity`, `inclusion_type`, `zero_priced`, `description`) are reported INFORMATIONAL and never fail the run — no snapshot property separates a deliberate override from a missed cascade, and asserting equality would report every legitimate override as a defect (`audit-booking-prices.ts` is the cautionary case, measuring its own claim violated ~38% of the time).",
  gates: true,
};

const COMPONENT_RECIPROCITY_TESTED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/products/updateProductPropagation.test.ts:556",
  clause:
    "the writer path — adding and removing components maintains `component_of` back-refs on the affected products, including the webshop mirror. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/**
 * ⚠️ COUNT ONLY. `audit-denorm-counts.ts` compares `tag.count` to
 * `tag.products.length` — a denorm against its own sibling array. **It never
 * reads `products`**, so a tag whose `products[]` names a product that no
 * longer references it passes cleanly. The membership half is the pointer
 * below, and that one cannot fail.
 */
const DENORM_COUNT: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-denorm-counts.ts",
  clause:
    "the `count display` half ONLY — stored `count` equals the length of the doc's own membership array. It reads neither `products` nor any product's tag list, so it says nothing about whether the membership itself is right.",
  gates: true,
};

/**
 * ⚠️ NOT A GATE. `audit-data-integrity.ts` really does check membership in both
 * directions (its sections 2, 4 and 5: tracking-category→product stale entries,
 * product→tag orphan refs, tag→product stale entries) — and it ends on a bare
 * `Deno.exit()`, which is exit 0 unconditionally. It reports; it cannot fail.
 */
const DENORM_MEMBERSHIP: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-data-integrity.ts:104",
  clause:
    "the `track which products reference them` half — orphan and stale entries in both directions. But the script closes with a bare `Deno.exit()`, so it ALWAYS exits 0: read its output, never its status.",
  gates: false,
};

/**
 * The Xero-membership half is the one that fails silently: Xero accepts a line
 * whose `TrackingOptionID` is unknown, returns 200, and DISCARDS the element, so
 * the line reports as untracked revenue with nothing recording it. Shape
 * validation cannot see that — a dead uuid is a well-formed uuid — which is why
 * this audit checks MEMBERSHIP against the live tenant.
 */
const XERO_TRACKING_MEMBERSHIP: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-xero-tracking-options.ts",
  clause:
    "six independent assertions over the registration — `option_dead` (not a live Xero option), `option_null` (active product with none), `denorm_stale` (option ≠ its own category's), `orphan_option` (no category link, so the true value is unrecoverable), `category_option_dead`, and a three-way `count_drift` (`count` vs `products{}` size vs the real back-refs). Exit 0 / 1 / 2 INCONCLUSIVE — a quota-refused run cannot be mistaken for a passing one.",
  gates: true,
};

/** The replacement-registration clause, asserted where it was broken. */
const REPLACEMENT_REGISTRATION: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/products/products.test.ts:179",
  clause:
    "the auto-minted-replacement clause specifically — the replacement doc carries the SAME `uid_tracking_category`, `tracking_category_name` and `xero_tracking_option_id` as the Replacements category, is present in that category's `products{}` under its own uid and name, and is counted. It also asserts NEGATIVELY against the hardcoded dead option uuid that produced the 8 broken prod replacements.",
  gates: true,
};

const TAG_CASCADE_TESTED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/products/updateProductPropagation.test.ts:99",
  clause:
    "the writer path — a tag-list change `[T1,T2] → [T2,T3]` updates the tag documents, their counts, and the webshop mirror in one write",
  gates: true,
};

const TRACKING_CATEGORY_MOVE_TESTED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/products/updateProductPropagation.test.ts:206",
  clause:
    "all three arms of the reverse denorm — a category move rewrites BOTH `tracking_category_name` and `xero_tracking_option_id` (not just the Xero option), a `null` clear performs the two different operations the nullable/optional split requires, and a product missing its registration self-heals on the next name write",
  gates: true,
};

const SUMMARY_BICONDITIONAL_TESTED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/products/updateProductPropagation.test.ts:360",
  clause:
    "both branches, in both directions — `bulk→none` deletes the ledger AND the summaries, `none→bulk` creates a ledger on a rental and nothing on a non-stock type, `surcharge→rental` at `stock_method:'none'` is a 200 rather than a 500, and `rental→sale` carrying `stock_method:'none'` drops the stale ledger",
  gates: true,
};

const WEBSHOP_MIRROR_TESTED: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/products/products.test.ts:791",
  clause:
    "the twin's lifecycle and one field — `webshop.available` true creates the mirror, false deletes it, and a description edit reaches it; a name change reaches the mirrors of RELATED products too (updateProductPropagation.test.ts:670). Which fields are public-safe is the schema's business, not this test's.",
  gates: true,
};

/**
 * The public-safe SUBSET is a schema fact: `WebshopProductSchema` is a
 * strictObject, so a field it does not name cannot be written to the twin at
 * all.
 */
const WEBSHOP_SHAPE_IS_THE_SUBSET: EnforcementRef = {
  kind: "construction",
  ref: "core/src/schemas/webshop-product.ts:114",
  clause:
    "the `public-safe subset` half — the strictObject names the publishable fields, so anything outside it is a rejected write rather than a leak",
  gates: true,
};

// ── create-product ───────────────────────────────────────────────

export const createProductRules: CollectionRule[] = [
  {
    id: "create-product:product-to-tags",
    source: "products",
    target: "tags",
    mode: "co-write",
    invariant: "Tags track which products reference them for reverse lookup and count display",
    enforced_by: [DENORM_COUNT, DENORM_MEMBERSHIP],
    transaction: "create-product",
    fields: [
      { source: ["uid"], target: ["products", "uid"] },
      { source: ["name"], target: ["products", "name"] },
      { source: [], target: ["count"], transform: "FieldValue.increment(1)" },
    ],
  },
  {
    id: "create-product:product-to-tracking-categories",
    source: "products",
    target: "tracking-categories",
    mode: "co-write",
    invariant:
      "Tracking categories track which products are assigned for Xero reporting. The registration covers the auto-minted replacement product too: a rental product mints `Replacement: {name}` in the same transaction, and that doc gets the SAME three tracking fields — so it must be registered in `products{}` and counted alongside its parent. For as long as it wasn't, `createReplacementDoc` hardcoded one dead option uuid and omitted the category link entirely, so every minted replacement was born with an id resolving to nothing in Xero (8 in prod) and the Replacements category's `count` under-reported by the same number.",
    enforced_by: [REPLACEMENT_REGISTRATION, XERO_TRACKING_MEMBERSHIP, DENORM_COUNT],
    transaction: "create-product",
    fields: [
      { source: ["uid"], target: ["products", "uid"] },
      { source: ["name"], target: ["products", "name"] },
      { source: [], target: ["count"], transform: "FieldValue.increment(1)" },
      {
        source: ["uid_linked_replacement"],
        target: ["products"],
        transform: "the minted replacement is registered + counted in its own category, and carries uid_tracking_category + tracking_category_name + xero_tracking_option_id read from that category doc",
      },
    ],
  },
  {
    id: "create-product:product-to-components",
    source: "products",
    target: "products",
    mode: "co-write",
    invariant: "Component products maintain a full back-reference entry in their component_of array and query_by_component_of for lookups",
    enforced_by: [COMPONENT_RECIPROCITY, COMPONENT_RECIPROCITY_TESTED],
    transaction: "create-product",
    fields: [
      { source: ["uid", "name", "type", "stock_method", "price"], target: ["component_of"], transform: "adds full ProductComponent entry to component_of array with path" },
      { source: ["uid"], target: ["query_by_component_of"], transform: "appends parent uid to query_by_component_of array" },
    ],
  },
  {
    id: "create-product:product-to-ledger",
    source: "products",
    target: "inventory-ledgers",
    mode: "co-write",
    // "bulk/serialized" named only `stock_method` and was therefore a FOURTH
    // spelling of a predicate that already has one. `productHoldsStock`
    // (`api-cloudrun/src/lib/productStock.ts:37`) is `type ∈ {rental, sale} &&
    // stock_method !== "none"` — the `type` half is missing above, so a
    // `service` product with stock_method "bulk" reads as needing a ledger and
    // does not get one.
    //
    // That file's header exists specifically to record that `services/products.ts`
    // once carried three inconsistent spellings of this and that "adding a fourth
    // answer is how the drift in #310 recurs". This string was the fourth answer,
    // published to /docs.
    invariant:
      "A product needs an inventory ledger from day one exactly when it can physically hold units — type is 'rental' or 'sale' AND stock_method is not 'none' (the `productHoldsStock` predicate). Neither half alone decides it: a service product is never stocked whatever its stock_method, and a rental with stock_method 'none' is not tracked.",
    transaction: "create-product",
    enforced_by: [
      {
        kind: "audit",
        ref: "api-cloudrun/scripts/audit-stock.ts:225",
        clause:
          "the whole predicate against the corpus — it imports productHoldsStock itself and reports `product_without_ledger` in both directions, so this covers the invariant rather than a clause of it (exit 1 on any violation)",
        gates: true,
      },
      {
        kind: "test",
        ref: "api-cloudrun/tests/unit/productStock.test.ts",
        clause: "the predicate's own truth table, including the type half that the old wording dropped",
        gates: true,
      },
    ],
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["type"], target: ["type"] },
      { source: ["stock_method"], target: ["stock_method"] },
    ],
  },
  ...seedStockRules(
    "create-product",
    "A product that gets an inventory ledger gets a `stock/{P}` projection and a `stock-locks/{P}` token in the same transaction — all three are created and destroyed together. The projection starts empty (no bookings, no OOS) and carries the ledger's quantity_held.",
  ),
  {
    id: "create-product:product-to-webshop",
    source: "products",
    target: "webshop-products",
    mode: "co-write",
    invariant: "Webshop products are a public-safe subset of the product catalog for the online store",
    enforced_by: [WEBSHOP_SHAPE_IS_THE_SUBSET, WEBSHOP_MIRROR_TESTED],
    transaction: "create-product",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["name"], target: ["name"] },
      { source: ["description"], target: ["description"] },
      { source: ["type"], target: ["type"] },
      { source: ["stock_method"], target: ["stock_method"] },
      { source: ["active"], target: ["active"] },
      { source: ["price"], target: ["price"], transform: "strips coa_revenue field" },
      { source: ["tags"], target: ["tags"], transform: "copies tag refs" },
      { source: ["components"], target: ["components"], transform: "strips crms fields from component entries" },
      { source: ["component_of"], target: ["component_of"], transform: "strips crms fields from component_of entries" },
      { source: ["query_by_components"], target: ["query_by_components"] },
      { source: ["query_by_component_of"], target: ["query_by_component_of"] },
      { source: ["alternates"], target: ["alternates"] },
      { source: ["query_by_alternates"], target: ["query_by_alternates"] },
      { source: ["shipping"], target: ["shipping"] },
      { source: ["webshop"], target: ["webshop"] },
    ],
  },
];

export const createProductTransaction: TransactionDefinition = {
  id: "create-product",
  description: "Creates a product with tag/category cross-refs, optional inventory ledger, webshop fan-out, and a cowritten default thread. CRMS + Xero sync runs post-transaction.",
  steps: [
    "create-product:product-to-tags",
    "create-product:product-to-tracking-categories",
    "create-product:product-to-components",
    "create-product:product-to-ledger",
    "create-product:ledger-to-stock",
    "create-product:product-to-webshop",
    "cowrite-thread:products-to-thread",
    "cowrite-thread:thread-to-products",
  ],
};

// ── update-product ───────────────────────────────────────────────

export const updateProductRules: CollectionRule[] = [
  {
    id: "update-product:catalog-to-components",
    source: "products",
    target: "products",
    mode: "co-write",
    invariant: "Product catalog field changes (name, active, type, stock_method, crms_id) cascade unconditionally to matching entries in other products' components/component_of arrays, looked up via query_by_components array-contains",
    enforced_by: [COMPONENT_CATALOG_CASCADE],
    transaction: "update-product",
    fields: [
      { source: ["name"], target: ["component_of", "name"], transform: "updates name in matching entries of parent products' component_of array" },
      { source: ["name"], target: ["components", "name"], transform: "updates name in matching entries of child products' components array" },
      { source: ["active"], target: ["component_of", "active"] },
      { source: ["active"], target: ["components", "active"] },
      { source: ["type"], target: ["component_of", "type"] },
      { source: ["type"], target: ["components", "type"] },
      { source: ["stock_method"], target: ["component_of", "stock_method"] },
      { source: ["stock_method"], target: ["components", "stock_method"] },
      { source: ["crms_id"], target: ["component_of", "crms_id"] },
      { source: ["crms_id"], target: ["components", "crms_id"] },
      { source: ["name"], target: ["alternates", "name"], transform: "updates name in alternate products" },
    ],
  },
  {
    id: "update-product:components-to-components",
    source: "products",
    target: "products",
    mode: "co-write",
    invariant: "When a product's direct components are added or removed, component_of and query_by_component_of are maintained on affected component products",
    enforced_by: [COMPONENT_RECIPROCITY, COMPONENT_RECIPROCITY_TESTED],
    transaction: "update-product",
    fields: [
      { source: [], target: ["component_of"], transform: "components removed → remove parent entry from component's component_of array" },
      { source: [], target: ["component_of"], transform: "components added → add full ProductComponent entry to component's component_of array with path" },
      { source: [], target: ["query_by_component_of"], transform: "components removed → remove parent uid; components added → append parent uid" },
    ],
  },
  {
    id: "update-product:component-entry-to-parents",
    source: "products",
    target: "products",
    mode: "co-write",
    invariant: "When a product modifies a component entry, parent products (from component_of) have their matching entries updated — catalog fields always; business fields (price, qty, inclusion_type, zero_priced, description) only if parent value matches source's pre-update value (override detection via field-level diff)",
    enforced_by: [COMPONENT_ENTRY_CATALOG_ONLY],
    transaction: "update-product",
    fields: [
      { source: ["components", "name"], target: ["components", "name"], transform: "catalog field — always update" },
      { source: ["components", "active"], target: ["components", "active"], transform: "catalog field — always update" },
      { source: ["components", "type"], target: ["components", "type"], transform: "catalog field — always update" },
      { source: ["components", "stock_method"], target: ["components", "stock_method"], transform: "catalog field — always update" },
      { source: ["components", "crms_id"], target: ["components", "crms_id"], transform: "catalog field — always update" },
      { source: ["components", "price"], target: ["components", "price"], transform: "business field — update only if parent value matches old value" },
      { source: ["components", "quantity"], target: ["components", "quantity"], transform: "business field — update only if parent value matches old value" },
      { source: ["components", "inclusion_type"], target: ["components", "inclusion_type"], transform: "business field — update only if parent value matches old value" },
      { source: ["components", "zero_priced"], target: ["components", "zero_priced"], transform: "business field — update only if parent value matches old value" },
      { source: ["components", "description"], target: ["components", "description"], transform: "business field — update only if parent value matches old value" },
    ],
  },
  {
    id: "update-product:name-to-locations",
    source: "products",
    target: "locations",
    mode: "co-write",
    invariant: "Location product lists show product names — must stay current",
    transaction: "update-product",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `locations←products` — the NAME clause only; this rule copies no other field",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["products", "name"] },
    ],
  },
  {
    id: "update-product:name-to-tags",
    source: "products",
    target: "tags",
    mode: "co-write",
    invariant: "Tags display product names in their product list",
    transaction: "update-product",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `tags←products` — every tags.products[].name vs products/{uid}.name",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["products", "name"] },
    ],
  },
  {
    id: "update-product:name-to-tracking-categories",
    source: "products",
    target: "tracking-categories",
    mode: "co-write",
    invariant: "Tracking categories display product names",
    transaction: "update-product",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `tracking-categories←products` — the products{} record is keyed by uid, so each entry is compared by key",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["products", "name"] },
    ],
  },
  {
    id: "update-product:to-webshop",
    source: "products",
    target: "webshop-products",
    mode: "co-write",
    invariant: "All public-facing product fields propagate to the webshop on every update",
    enforced_by: [WEBSHOP_SHAPE_IS_THE_SUBSET, WEBSHOP_MIRROR_TESTED],
    transaction: "update-product",
    fields: [
      { source: ["name"], target: ["name"] },
      { source: ["active"], target: ["active"] },
      { source: ["price"], target: ["price"], transform: "strips coa_revenue" },
      { source: ["tags"], target: ["tags"] },
      { source: ["components"], target: ["components"], transform: "strips crms fields from component entries" },
      { source: ["component_of"], target: ["component_of"], transform: "strips crms fields from component_of entries" },
      { source: ["query_by_components"], target: ["query_by_components"] },
      { source: ["query_by_component_of"], target: ["query_by_component_of"] },
      { source: ["alternates"], target: ["alternates"] },
      { source: ["query_by_alternates"], target: ["query_by_alternates"] },
      { source: ["webshop"], target: ["webshop"] },
    ],
  },
  {
    id: "update-product:tags-to-tags",
    source: "products",
    target: "tags",
    mode: "co-write",
    invariant: "When a product's tag list changes, old tags lose the product ref and new tags gain it",
    enforced_by: [TAG_CASCADE_TESTED, DENORM_COUNT, DENORM_MEMBERSHIP],
    transaction: "update-product",
    fields: [
      { source: [], target: ["products"], transform: "tags removed → remove product ref, decrement count" },
      { source: [], target: ["products"], transform: "tags added → add product ref, increment count" },
    ],
  },
  {
    id: "update-product:tracking-category-change",
    source: "products",
    target: "tracking-categories",
    mode: "co-write",
    invariant:
      "When a product's tracking category changes, old category loses the ref and new one gains it — AND the product's two denorms of that category (`tracking_category_name`, `xero_tracking_option_id`) are rewritten from the target doc in the same transaction. The reverse denorm is the half that was missing: for as long as it was absent a category move left the old name and the old Xero option id on the product, and the stale option is what ships to Xero on the next push. Clearing the category (`uid_tracking_category: null`) sets `xero_tracking_option_id: null` and unsets `tracking_category_name` — nullable vs optional differ in the storage schema, so the clear path is two different operations, not one.",
    enforced_by: [TRACKING_CATEGORY_MOVE_TESTED, DENORM_COUNT, DENORM_MEMBERSHIP],
    transaction: "update-product",
    fields: [
      { source: [], target: ["products"], transform: "old tracking category → remove product, decrement count" },
      { source: [], target: ["products"], transform: "new tracking category → add product, increment count" },
      { source: ["uid_tracking_category"], target: [], transform: "reverse denorm → product.tracking_category_name = category.name" },
      {
        source: ["uid_tracking_category"],
        target: [],
        transform: "reverse denorm → product.xero_tracking_option_id = category.xero_tracking_option_id (null when the category has no option yet, or when the category is cleared)",
      },
    ],
  },
  {
    id: "update-product:stock-method-change",
    source: "products",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "Changing stock_method to 'none' deletes the ledger AND the product's `stock/{P}` projection and its `stock-locks/{P}` token; changing away from 'none' creates all three. The projection and the token exist if and only if the ledger does — see seedStockRules. The old rule described only the ledger, while the code also deleted summaries (and leaked their public twins).",
    enforced_by: [SUMMARY_BICONDITIONAL_TESTED],
    transaction: "update-product",
    fields: [
      { source: ["stock_method"], target: [], transform: "delete ledger if 'none', create empty ledger if 'bulk'/'serialized'" },
      { source: ["stock_method"], target: [], transform: "stock/{uid} + stock-locks/{uid} deleted or seeded in lockstep with the ledger. The TOKEN leg is the one with teeth: stageStockClaim PATCHES it and update does not upsert, so a ledger left without one fails every claim against that product." },
    ],
  },
  {
    id: "update-product:type-change",
    source: "products",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "Changing type to service/surcharge/replacement deletes the ledger, the `stock/{P}` projection and the `stock-locks/{P}` token — none of those types hold stock. Changing to rental/sale creates the ledger when moving from a non-stock type, and the summary is (re)seeded rather than deleted: a rental→sale flip keeps its ledger, so deleting its summary would leave a permanent hole now that there is no mint-on-read to backfill it. The summary's `type` field follows the product's.",
    enforced_by: [SUMMARY_BICONDITIONAL_TESTED],
    transaction: "update-product",
    fields: [
      { source: ["type"], target: [], transform: "delete ledger + summary + public twin for service/surcharge/replacement" },
      { source: ["type"], target: [], transform: "create ledger + summary + public twin when entering rental/sale from a non-stock type" },
      { source: ["type"], target: ["type"], transform: "the summary's type field tracks the product's on a rental↔sale flip" },
    ],
  },
];

// ── update-product fan-out to orders ─────────────────────────────

export const updateProductOrderRules: CollectionRule[] = [
  {
    id: "update-product:product-to-draft-orders",
    source: "products",
    target: "orders",
    mode: "fan-out",
    invariant: "Draft orders stay current with the product catalog — once quoted/reserved the embedded snapshot is locked in",
    trigger: "onUpdate:products",
    fields: [
      { source: ["type"], target: ["items", "type"], transform: "patch matching items where status = draft and item.uid matches product uid" },
      { source: ["stock_method"], target: ["items", "stock_method"] },
      { source: ["price", "base_cents"], target: ["items", "price", "base_cents"] },
      { source: ["price", "replacement_cents"], target: ["items", "price", "replacement_cents"] },
      { source: ["price", "taxes"], target: ["items", "price", "taxes"], transform: "denormalized TaxRef[] from product catalog" },
      { source: ["name"], target: ["items", "name"] },
    ],
  },
];

export const updateProductTransaction: TransactionDefinition = {
  id: "update-product",
  description: "Updates a product with cascading name changes to components/alternates/locations/tags/tracking-categories, tag/category cross-ref diffs, and webshop fan-out.",
  steps: [
    "update-product:catalog-to-components",
    "update-product:components-to-components",
    "update-product:component-entry-to-parents",
    "update-product:name-to-locations",
    "update-product:name-to-tags",
    "update-product:name-to-tracking-categories",
    "update-product:to-webshop",
    "update-product:tags-to-tags",
    "update-product:tracking-category-change",
    "update-product:stock-method-change",
    "update-product:type-change",
  ],
};
