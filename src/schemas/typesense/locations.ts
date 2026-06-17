import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for locations. */
export const locations: TypesenseCollectionConfig = {
  alias: "locations",
  version: 5,
  firestoreCollection: "locations",
  collectionName: "locations_v5",
  schema: {
    name: "locations_v5",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "uid_store", type: "string", facet: false },
      { name: "active", type: "bool", sort: true, facet: true },
      { name: "default", type: "bool", sort: true, facet: true, optional: true },
      { name: "uid_location_type", type: "string", facet: false, optional: true },
      { name: "products", type: "object[]", optional: true },
      { name: "products.uid", type: "string[]", facet: false, optional: true },
      { name: "products.name", type: "string[]", stem: true, facet: false, optional: true },
      { name: "products.quantity", type: "int32[]", facet: false, optional: true },
      { name: "products.default", type: "bool[]", facet: true, optional: true },
      { name: "product_capacities", type: "object[]", optional: true },
      { name: "product_capacities.uid", type: "string[]", facet: false, optional: true },
      { name: "product_capacities.max", type: "int32[]", optional: true },
      { name: "product_capacities.max_default", type: "int32[]", optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "created_at",
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
