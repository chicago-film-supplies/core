import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for purchases (api-cloudrun#1220).
 *
 * The index behind manager's `/purchases` list: what CFS ORDERED from a
 * supplier. `number` is the `default_sorting_field` and is stored bare, as on
 * `credit-notes` — a prefixed display label would turn the sort field into a
 * string.
 *
 * 🔴 **`supplier.name` MUST stay `facet: false`.** manager's
 * `getQueryByStringFields` builds `query_by` from string fields that are
 * `!f.facet` and covered by a declared display column, so a faceted name drops
 * out of `query_by` and every search returns zero rows with no error. The same
 * line in `typesense/suppliers.ts` carries the full argument.
 *
 * `lines.name` is indexed so "which PO has product X" is one query. `notes` is
 * deliberately NOT declared — free text no list column needs; add it when
 * someone wants to search on it.
 *
 * ⚠️ `reference` is `optional: true` because its Zod leaf is `.nullable()`:
 * the translate path omits a null rather than sending one, and a non-optional
 * declaration over a nullable leaf is a permanent, invisible sync 400.
 */
export const purchases: TypesenseCollectionConfig = {
  alias: "purchases",
  version: 1,
  firestoreCollection: "purchases",
  collectionName: "purchases_v1",
  enabled: true,
  schema: {
    name: "purchases_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "supplier", type: "object" },
      { name: "supplier.uid", type: "string", facet: false, optional: true },
      { name: "supplier.name", type: "string", sort: true, stem: true, facet: false },
      { name: "store", type: "object" },
      { name: "store.uid", type: "string", facet: false, optional: true },
      { name: "store.name", type: "string", facet: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "lines", type: "object[]", optional: true },
      { name: "lines.uid_product", type: "string[]", facet: false, optional: true },
      { name: "lines.name", type: "string[]", stem: true, optional: true },
      { name: "total_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "total_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "date_fs", type: "int64", sort: true, index: true, facet: false },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "number",
  },
  synonyms: [],
  pulseShards: 1,
  displayDefaults: {
    columns: ["number", "date_fs", "supplier.name", "status", "total_cents"],
    filters: { status: [] },
  },
};
