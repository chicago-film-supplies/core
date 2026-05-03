/**
 * Typesense collection config for cards.
 *
 * Enabled from day one — unlike threads which is reserved (disabled) slot.
 * Supports list/agenda search, kanban filter-by-status, calendar range by
 * `date_epoch`, and map views via `destination.coordinates` (geopoint).
 *
 * `date_epoch` is a Typesense-only derived field (ms since Unix epoch,
 * computed from the Firestore `date_fs` Timestamp during sync in
 * api-cloudrun/src/lib/typesense.ts's per-collection mapper). It enables
 * range filters (`date_epoch:>=X && date_epoch:<=Y`) without the string-date
 * comparison pitfalls of YYYY-MM-DD lexicographic sort.
 */
import type { TypesenseCollectionConfig } from "./types.ts";

export const cards: TypesenseCollectionConfig = {
  alias: "cards",
  version: 1,
  firestoreCollection: "cards",
  collectionName: "cards_v1",
  enabled: true,
  schema: {
    name: "cards_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "uid_list", type: "string", facet: true, index: true },
      { name: "status", type: "string", facet: true, index: true },
      { name: "position", type: "float", sort: true, index: true, facet: false },

      // Search fields
      { name: "subject", type: "string", stem: true },
      { name: "body_text", type: "string", stem: true, optional: true },

      // Dates — `date` is the source of truth (YYYY-MM-DD string), kept as
      // string for display + int64 epoch for range filter/sort
      { name: "date", type: "string", facet: true, optional: true },
      { name: "date_epoch", type: "int64", sort: true, index: true, facet: false, optional: true },

      // Destination — flattened lat/lng + city/state for map view + region facets
      { name: "destination.address.city", type: "string", facet: true, optional: true },
      { name: "destination.address.region", type: "string", facet: true, optional: true },
      { name: "destination.coordinates", type: "geopoint", optional: true },

      // Polymorphic sources — object[] with nested facets for
      // "all cards touching order X" and "all cards touching any order"
      { name: "sources", type: "object[]" },
      { name: "sources.collection", type: "string[]", facet: true, index: true },
      { name: "sources.uid", type: "string[]", facet: true, index: true },

      // People
      { name: "uid_thread", type: "string", facet: false, index: true },
      { name: "uid_assignees", type: "string[]", facet: true, index: true, optional: true },

      // Recurrence hooks (always null in Phase 0)
      { name: "recurrence_parent_uid", type: "string", facet: true, index: true, optional: true },

      { name: "created_by", type: "object" },
      { name: "created_by.uid", type: "string", facet: true, index: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "position",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["subject", "status", "date", "uid_list", "uid_assignees"],
    filters: {},
    sort: { column: "position", direction: "asc" },
    group: null,
    facet: ["uid_list", "status", "sources.collection"],
  },
};
