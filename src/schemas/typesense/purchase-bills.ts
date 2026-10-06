import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for purchase bills (api-cloudrun#1220) — the
 * supplier's ACCPAY bill against one purchase.
 *
 * ⚠️ **Not the purchase skeleton.** A bill has no `store` and no `status`, and
 * its `lines` are `PurchaseDocumentLine` — `uid_product`, `quantity`,
 * `amount_cents`, no `name` — so declaring either here would fail field
 * resolution. `direct_lines` (freight and the like) are not declared.
 *
 * `uid_purchase` is indexed but not faceted: a purchase's own bills are a
 * Firestore `where`, not a search, and this field exists so a search can
 * still be narrowed by it.
 *
 * `supplier.name` stays `facet: false` — see `typesense/suppliers.ts`.
 * `xero_id` and `reference` are `optional: true` because their Zod leaves are
 * `.nullable()`.
 */
export const purchaseBills: TypesenseCollectionConfig = {
  alias: "purchase-bills",
  version: 1,
  firestoreCollection: "purchase-bills",
  collectionName: "purchase-bills_v1",
  enabled: true,
  schema: {
    name: "purchase-bills_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "uid_purchase", type: "string", index: true, facet: false },
      { name: "supplier", type: "object" },
      { name: "supplier.uid", type: "string", facet: false, optional: true },
      { name: "supplier.name", type: "string", sort: true, stem: true, facet: false },
      { name: "origin", type: "string", facet: true },
      { name: "xero_document", type: "string", facet: true },
      { name: "xero_id", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "lines", type: "object[]", optional: true },
      { name: "lines.uid_product", type: "string[]", facet: false, optional: true },
      { name: "totals", type: "object", optional: true },
      { name: "totals.total_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.total_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "totals.amount_paid_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_paid_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "totals.amount_credited_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_credited_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "totals.amount_void_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_void_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "totals.amount_due_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_due_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "date_fs", type: "int64", sort: true, index: true, facet: false },
      { name: "due_date_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "number",
  },
  synonyms: [],
  pulseShards: 1,
  displayDefaults: {
    columns: [
      "number",
      "date_fs",
      "due_date_fs",
      "supplier.name",
      "reference",
      "totals.total_cents",
      "totals.amount_due_cents",
    ],
    filters: {},
  },
};
