import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for template *families* (git-canonical system).
 *
 * Indexes the thin family doc — identity + rollups, no content. Content lives
 * in git and is projected into `templates-versions` (not indexed here). Bumped
 * to v2 when the family shape changed (dropped `scope`/`source`/per-version
 * fields; added `git_path`/`surfaces`/`uid_active`/rollups).
 */
export const templates: TypesenseCollectionConfig = {
  alias: "templates",
  version: 2,
  firestoreCollection: "templates",
  collectionName: "templates_v2",
  schema: {
    name: "templates_v2",
    fields: [
      { name: "uid", type: "string", sort: true },
      { name: "git_path", type: "string", facet: true },
      { name: "name", type: "string", sort: true, stem: true },
      { name: "collection_source", type: "string", facet: true },
      { name: "collection_target", type: "string", facet: true },
      { name: "surfaces", type: "string[]", facet: true },
      { name: "uid_active", type: "string", optional: true },
      { name: "version_count", type: "int32", sort: true },
      { name: "version", type: "int32", sort: true },
      { name: "created_at", type: "int64", sort: true },
      { name: "updated_at", type: "int64", sort: true },
    ],
    default_sorting_field: "updated_at",
  },
  synonyms: [],
  pulseShards: 1,
  displayDefaults: {
    columns: ["name", "collection_source", "collection_target", "surfaces"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
};
