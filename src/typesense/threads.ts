import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for threads.
 *
 * Reserved slot — threads aren't currently indexed (Phase 1 searches comments
 * directly; thread-level search can pivot off comment hits). `enabled: false`
 * so provisioning skips this collection; the schema exists only to keep the
 * `threads.search` permission mapped in `SEARCH_PERMISSION_BY_ALIAS`.
 */
export const threads: TypesenseCollectionConfig = {
  alias: "threads",
  version: 1,
  firestoreCollection: "threads",
  collectionName: "threads_v1",
  enabled: false,
  schema: {
    name: "threads_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "sources", type: "object[]" },
      { name: "sources.collection", type: "string[]", facet: true },
      { name: "sources.uid", type: "string[]", facet: true, index: true },
      { name: "title", type: "string", stem: true, optional: true },
      { name: "last_message_preview", type: "string", stem: true, optional: true },
      { name: "last_message_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "comment_count", type: "int32", sort: true, facet: false },
      { name: "created_by", type: "object" },
      { name: "created_by.uid", type: "string", facet: true, index: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "last_message_at",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["sources.collection", "title", "last_message_preview", "last_message_at", "comment_count"],
    filters: {},
    sort: { column: "last_message_at", direction: "desc" },
    group: null,
    facet: [],
  },
};
