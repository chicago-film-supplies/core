/**
 * Product propagation rules — create-product and update-product transactions.
 *
 * Traced from: api-cloudrun/src/services/products.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── create-product ───────────────────────────────────────────────

export const createProductRules: CollectionRule[] = [
  {
    id: "create-product:product-to-tags",
    source: "products",
    target: "tags",
    mode: "co-write",
    invariant: "Tags track which products reference them for reverse lookup and count display",
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
    invariant: "Tracking categories track which products are assigned for Xero reporting",
    transaction: "create-product",
    fields: [
      { source: ["uid"], target: ["products", "uid"] },
      { source: ["name"], target: ["products", "name"] },
      { source: [], target: ["count"], transform: "FieldValue.increment(1)" },
    ],
  },
  {
    id: "create-product:product-to-components",
    source: "products",
    target: "products",
    mode: "co-write",
    invariant: "Component products maintain a full back-reference entry in their component_of array and query_by_component_of for lookups",
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
    invariant: "Products with tracked stock (bulk/serialized) need an inventory ledger from day one",
    transaction: "create-product",
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["type"], target: ["type"] },
      { source: ["stock_method"], target: ["stock_method"] },
    ],
  },
  {
    id: "create-product:product-to-webshop",
    source: "products",
    target: "webshop-products",
    mode: "co-write",
    invariant: "Webshop products are a public-safe subset of the product catalog for the online store",
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
    invariant: "When a product's tracking category changes, old category loses the ref and new one gains it",
    transaction: "update-product",
    fields: [
      { source: [], target: ["products"], transform: "old tracking category → remove product, decrement count" },
      { source: [], target: ["products"], transform: "new tracking category → add product, increment count" },
    ],
  },
  {
    id: "update-product:stock-method-change",
    source: "products",
    target: "inventory-ledgers",
    mode: "co-write",
    invariant: "Changing stock method to 'none' deletes the ledger; changing from 'none' creates one",
    transaction: "update-product",
    fields: [
      { source: ["stock_method"], target: [], transform: "delete ledger if 'none', create empty ledger if 'bulk'/'serialized'" },
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
      { source: ["price", "base"], target: ["items", "price", "base"] },
      { source: ["price", "replacement"], target: ["items", "price", "replacement"] },
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
  ],
};
