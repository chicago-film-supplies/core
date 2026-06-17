import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for stores. */
export const stores: TypesenseCollectionConfig = {
  alias: "stores",
  version: 2,
  firestoreCollection: "stores",
  collectionName: "stores_v2",
  schema: {
    name: "stores_v2",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "default", type: "bool", sort: true, facet: true },
      { name: "active", type: "bool", sort: true, facet: true },
      { name: "default_location", type: "object", optional: true },
      { name: "default_location.uid", type: "string", optional: true },
      { name: "default_location.name", type: "string", optional: true },
      { name: "crms_store_id", type: "int64", sort: true, index: true, facet: false },
      { name: "crms_store_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "default",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["name", "active", "default"],
    filters: { active: [true] },
    sort: { column: "name", direction: "asc" },
    group: null,
    facet: [],
  },
};
