import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for destinations. */
export const destinations: TypesenseCollectionConfig = {
  alias: "destinations",
  version: 6,
  firestoreCollection: "destinations",
  collectionName: "destinations_v6",
  schema: {
    name: "destinations_v6",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "mapbox_ids", type: "string[]", facet: true },
      ...typesenseAddressFields("address", { sortFull: true }),
      // ── The property → unit tree ──────────────────────────────────────────
      //
      // ⚠️ **`path` is indexed NATIVELY, so there is no flat uid mirror on this
      // side.** `enable_nested_fields` is on above, so `filter_by: path.uid:=<P>`
      // answers "every unit of this property" with no extra field. The
      // Firestore-only `query_by_path` exists because `array-contains` compares
      // WHOLE elements and cannot match a uid inside an array of objects — a
      // limitation of the other store, not a shape this one needs.
      //
      // ⚠️ **`optional: true` is the EXPAND third.** `path` is absent on every
      // stored document until the migration runs; without the flag the sync
      // 400s on the first one.
      { name: "path", type: "object[]", optional: true },
      { name: "path.uid", type: "string[]", facet: true, optional: true },
      { name: "path.name", type: "string[]", stem: true, facet: false, optional: true },
      // The authoring-time jurisdiction SEED — stated on a property, absent on a
      // unit. 🔴 Indexed for the PICKER, which is the only reader it may ever
      // have: a rung in `resolveJurisdiction` re-opens api-cloudrun#591.
      { name: "jurisdiction", type: "string", facet: true, optional: true },
      // 🔴 **`organizations.*` and `products.*` were DELETED here**, the last
      // step of the four-step removal (api-cloudrun#654 / #782 A2). The writers
      // stopped, storage emptied, and on 2026-09-19 the key was ABSENT — not
      // empty — on 0 of 258 prod and 0 of 259 dev documents. Their
      // `destinations:organizations.name` DERIVED_FIELDS entry went with them.
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
  pulseShards: 1,
  displayDefaults: {
    columns: ["address.full", "address.city", "address.region"],
    filters: {},
  },
};
