import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for users. */
export const users: TypesenseCollectionConfig = {
  alias: "users",
  version: 3,
  firestoreCollection: "users",
  collectionName: "users_v3",
  schema: {
    name: "users_v3",
    enable_nested_fields: false,
    token_separators: ["-", "+", " ", "@", "."],
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "email", type: "string", sort: true, index: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "first_name", type: "string", sort: true, stem: true, facet: false },
      { name: "middle_name", type: "string", stem: true, facet: false, optional: true },
      { name: "last_name", type: "string", sort: true, stem: true, facet: false, optional: true },
      { name: "pronunciation", type: "string", stem: true, facet: false, optional: true },
      { name: "roles", type: "string[]", facet: true, optional: true },
      { name: "email_verified", type: "bool", facet: true },
      { name: "uid_contact", type: "string", facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "email",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["email", "name", "roles"],
    filters: {},
    sort: { column: "email", direction: "asc" },
    group: null,
    facet: [],
  },
};
