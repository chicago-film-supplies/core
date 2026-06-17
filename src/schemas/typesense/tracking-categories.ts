import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for tracking categories. */
export const trackingCategories: TypesenseCollectionConfig = {
  alias: "tracking-categories",
  version: 5,
  firestoreCollection: "tracking-categories",
  collectionName: "tracking-categories_v5",
  schema: {
    name: "tracking-categories_v5",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "crms_product_group_name", type: "string", sort: true, stem: true, facet: false },
      { name: "count", type: "int32", sort: true, index: true, facet: false },
      { name: "crms_product_group_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_product_group_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "crms_service_group_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_service_group_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "xero_tracking_option_id", type: "string", optional: true },
      { name: "products", type: "object[]", optional: true },
      { name: "products.uid", type: "string[]", facet: false, optional: true },
      { name: "products.name", type: "string[]", stem: true, facet: false, optional: true },
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
  displayDefaults: {
    columns: ["name", "count", "products.name"],
    filters: {},
    sort: { column: "name", direction: "asc" },
    group: null,
    facet: [],
  },
};
