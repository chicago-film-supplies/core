/**
 * Typesense collection config for cards.
 *
 * Enabled from day one — unlike threads which is reserved (disabled) slot.
 * Supports list/agenda search, kanban filter-by-status, calendar range by
 * `date_fs`, and map views via `destination.address.address_coordinates`.
 *
 * ⚠️ **Both of those were dead from the day they were declared, until
 * 2026-08-09.** The config named a flat `date` string and a
 * `destination.coordinates` geopoint; `Card` is a `z.strictObject` carrying
 * neither (`dates.start`/`dates.end` + `date_fs`, and the geopoint nested under
 * `destination.address.address_coordinates`). So `date` was always absent,
 * `date_epoch` — derived from it at index time — was `null` on all 1,097 prod
 * cards, and the geopoint never existed. Nothing failed: a declared field that
 * no document populates is indistinguishable from an absent one in a search
 * response, which is exactly why `tests/typesenseFieldCoverage.test.ts` now
 * asserts every declared field resolves against the storage schema.
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

      // Dates — `date_fs` is the stored Firestore Timestamp companion of
      // `dates.start`, translated to epoch ms by `translateObject`. That gives
      // the calendar range filter (`date_fs:>=X && date_fs:<=Y`) and sort
      // directly off a stored field, with no index-time derivation to keep in
      // step. `dates.start` itself is deliberately NOT declared: it is a
      // Chicago-offset ISO string, and range-filtering it is the
      // lexicographic-date trap this field exists to avoid.
      { name: "date_fs", type: "int64", sort: true, index: true, facet: false, optional: true },

      // Destination — lat/lng + city/state for map view + region facets.
      // The geopoint sits at `destination.address.address_coordinates` because
      // that is the key `translateForTypesense` rewrites to a `[lat, lng]` tuple
      // (`GEOPOINT_KEYS`), and it is where `Card.destination` actually stores it.
      { name: "destination.address.city", type: "string", facet: true, optional: true },
      { name: "destination.address.region", type: "string", facet: true, optional: true },
      { name: "destination.address.address_coordinates", type: "geopoint", optional: true },

      // Polymorphic sources — object[] with nested facets for
      // "all cards touching order X" and "all cards touching any order".
      // The `sources` array is required (always present) but may be empty:
      // manual to-do cards legitimately carry no source. Typesense can't
      // flatten the nested facets out of an empty array, so the nested
      // `sources.*` fields are optional — otherwise a source-less card 400s
      // on upsert ("Field `sources.uid` ... not found in the document").
      { name: "sources", type: "object[]" },
      { name: "sources.collection", type: "string[]", facet: true, index: true, optional: true },
      { name: "sources.uid", type: "string[]", facet: true, index: true, optional: true },

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
    columns: ["subject", "status", "date_fs", "uid_list", "uid_assignees"],
    filters: {},
    sort: { column: "position", direction: "asc" },
    group: null,
    facet: ["uid_list", "status", "sources.collection"],
  },
};
