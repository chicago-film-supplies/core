import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for templates. */
export const templates: TypesenseCollectionConfig = {
  alias: "templates",
  version: 1,
  firestoreCollection: "templates",
  collectionName: "templates_v1",
  schema: {
    name: "templates_v1",
    fields: [
      { name: "uid", type: "string", sort: true },
      { name: "uid_template", type: "string", facet: true },
      { name: "name", type: "string", sort: true, stem: true },
      { name: "collection_source", type: "string", facet: true },
      { name: "collection_target", type: "string", facet: true },
      { name: "scope", type: "string", facet: true },
      { name: "version", type: "int32", sort: true },
      { name: "version_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "source_filename", type: "string", optional: true },
      { name: "created_at", type: "int64", sort: true },
      { name: "updated_at", type: "int64", sort: true },
      // source field intentionally excluded — too large for search index
    ],
    default_sorting_field: "updated_at",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["name", "collection_source", "collection_target", "scope"],
    filters: {},
    sort: { column: "name", direction: "asc" },
    group: null,
    facet: [],
  },
};
