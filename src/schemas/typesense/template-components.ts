import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for template-*component* families (git-canonical
 * system). Indexes the thin component family doc — identity + rollups, no
 * content (content lives in git, projected into `templates-versions`, not
 * indexed here). Backs the components list + the register form's `depends_on`
 * picker. A component is thinner than a template family: no
 * source/target/surfaces.
 */
export const templateComponents: TypesenseCollectionConfig = {
  alias: "template-components",
  version: 1,
  firestoreCollection: "template-components",
  collectionName: "template-components_v1",
  schema: {
    name: "template-components_v1",
    fields: [
      { name: "uid", type: "string", sort: true },
      { name: "git_path", type: "string", facet: true },
      { name: "name", type: "string", sort: true, stem: true },
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
    columns: ["name", "git_path", "version_count"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
};
