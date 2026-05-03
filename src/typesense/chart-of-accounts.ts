import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for chart of accounts. */
export const chartOfAccounts: TypesenseCollectionConfig = {
  alias: "chart-of-accounts",
  version: 4,
  firestoreCollection: "chart-of-accounts",
  collectionName: "chart-of-accounts_v4",
  schema: {
    name: "chart-of-accounts_v4",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "code", type: "int32", sort: true, index: true, facet: true },
      { name: "code_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "type", type: "string", facet: true },
      { name: "default_tax_profile", type: "string", facet: false },
      { name: "description", type: "string", stem: true, optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "code",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["code", "name", "type"],
    filters: { type: [] },
    sort: { column: "code", direction: "asc" },
    group: null,
    facet: [],
  },
};
