import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for destinations. */
export const destinations: TypesenseCollectionConfig = {
  alias: "destinations",
  version: 5,
  firestoreCollection: "destinations",
  collectionName: "destinations_v5",
  schema: {
    name: "destinations_v5",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "mapbox_ids", type: "string[]", facet: true },
      ...typesenseAddressFields("address", { sortFull: true }),
      { name: "organizations", type: "object[]", optional: true },
      { name: "organizations.uid", type: "string[]", facet: false, optional: true },
      { name: "organizations.name", type: "string[]", stem: true, optional: true },
      { name: "products", type: "object[]", optional: true },
      { name: "products.uid", type: "string[]", facet: false, optional: true },
      { name: "products.name", type: "string[]", stem: true, optional: true },
      { name: "contacts", type: "object[]", optional: true },
      { name: "contacts.uid", type: "string[]", facet: false, optional: true },
      { name: "contacts.first_name", type: "string[]", stem: true, optional: true },
      { name: "contacts.middle_name", type: "string[]", stem: true, optional: true },
      { name: "contacts.last_name", type: "string[]", stem: true, optional: true },
      { name: "contacts.pronunciation", type: "string[]", stem: true, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "updated_at",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["address.full", "address.city", "address.region"],
    filters: {},
    sort: { column: null, direction: "desc" },
    group: null,
    facet: [],
  },
};
