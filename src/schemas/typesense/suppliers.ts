import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for suppliers.
 *
 * Powers the manager's `<SearchSelect collection="suppliers" filters="active:=true">`
 * on the transaction form — which is the only reason this collection is indexed
 * at all. It is a couple of dozen documents, so capacity is a non-issue and the
 * open VM-capacity question (api-cloudrun#726) is untouched.
 *
 * 🔴 **`name` MUST stay `facet: false`, and it is the single line that decides
 * whether the picker works.** `getQueryByStringFields`
 * (`manager/src/stores/schemas.ts`) builds `query_by` from string fields that
 * are `!f.facet` *and* covered by a declared display column. A faceted `name`
 * is filtered out, `query_by` comes back empty, and every search returns zero
 * rows **with no error**.
 *
 * `default_sorting_field: "name"` — a string, following
 * `tracking-categories.ts`. Do NOT mint a synthetic int: `chart-of-accounts`
 * sorts on an int because its `code` was already one, and `tags.count` is
 * labelled a HAZARD in `core/tests/typesenseFieldCoverage.test.ts` precisely because the
 * first document written without it fails to index. `Supplier.name` is required
 * and non-nullable, which is what a `default_sorting_field` needs.
 *
 * ⚠️ **`xero_id` is `optional: true` because its Zod leaf is `.nullable()`.** A
 * non-optional declaration over a nullable leaf is the
 * `organizations.billing_address` failure — an HTTP 400 that makes sync fail
 * permanently and invisibly.
 */
export const suppliers: TypesenseCollectionConfig = {
  alias: "suppliers",
  version: 1,
  firestoreCollection: "suppliers",
  collectionName: "suppliers_v1",
  schema: {
    name: "suppliers_v1",
    // `created_by` / `updated_by` are objects.
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "active", type: "bool", sort: true, facet: true },
      { name: "xero_id", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "name",
  },
  synonyms: [],
  pulseShards: 1,
  displayDefaults: {
    columns: ["name", "active"],
    filters: { active: [true] },
    sort: { column: "name", direction: "asc" },
  },
};
