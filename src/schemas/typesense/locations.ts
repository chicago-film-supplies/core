import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for locations.
 *
 * v6 (api-cloudrun#1302 phase 5): the `default` facet — a copy of the store
 * pointer, now retired from the document — is replaced by `role`
 * (`storage | staging`), required on every location since phase 3.
 */
export const locations: TypesenseCollectionConfig = {
  alias: "locations",
  version: 6,
  firestoreCollection: "locations",
  collectionName: "locations_v6",
  schema: {
    name: "locations_v6",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "uid_store", type: "string", facet: false },
      { name: "active", type: "bool", sort: true, facet: true },
      { name: "role", type: "string", sort: true, facet: true },
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
  pulseShards: 1,
  displayDefaults: {
    columns: ["name", "active", "role"],
    filters: { active: [true] },
  },
};
