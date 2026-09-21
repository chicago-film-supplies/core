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
import { type TypesenseCollectionConfig, typesenseAddressFields } from "./types.ts";

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

      // Destination — the WHOLE endpoint, generated.
      //
      // ⚠️ **This block was hand-written until 2026-09-19 and `cards` was the
      // only collection not calling `typesenseAddressFields`.** It declared
      // three leaves of eleven, no `destination.uid` and no `user_coordinates`
      // — and an undeclared leaf is DELETED at index time, not merely left
      // unindexed (`typesenseTranslate.ts`), so the drift was silent in both
      // directions. The generator reproduces the two facets this block already
      // had (`city`, `region`) verbatim and adds the rest, both geopoints
      // included. **Do not hand-roll it back.**
      //
      // The geopoints sit under `destination.address.*` because that is where
      // `Card.destination` stores them and what `translateForTypesense` rewrites
      // to a `[lat, lng]` tuple (`GEOPOINT_KEYS`). ⚠️ **A geopoint takes neither
      // `facet` nor `sort`** — Typesense refuses the collection outright.
      { name: "destination", type: "object", optional: true },
      { name: "destination.uid", type: "string", facet: true, index: true, optional: true },
      ...typesenseAddressFields("destination.address"),
      { name: "destination.instructions", type: "string", stem: true, optional: true },

      // Contact — name + phones, so a dispatcher can search the person a leg is
      // addressed to rather than only the address. `pii: "mask"` on these fields
      // governs LOG scrubbing and template goldens; it is not a storage or index
      // policy, and `cards.search` + `cards.read` is the authorization boundary
      // that applies here (owner, 2026-09-19).
      { name: "destination.contact", type: "object", optional: true },
      { name: "destination.contact.uid", type: "string", index: true, optional: true },
      { name: "destination.contact.first_name", type: "string", stem: true, optional: true },
      { name: "destination.contact.middle_name", type: "string", stem: true, optional: true },
      { name: "destination.contact.last_name", type: "string", stem: true, optional: true },
      { name: "destination.contact.pronunciation", type: "string", stem: true, optional: true },
      { name: "destination.contact.name", type: "string", stem: true, facet: true, optional: true },
      { name: "destination.contact.phones", type: "string[]", facet: true, optional: true },

      // Organization — the card's own org axis, and its ancestor path, so a
      // destination roll-up can scope by org without joining back to the order.
      { name: "organization", type: "object", optional: true },
      { name: "organization.uid", type: "string", facet: true, index: true, optional: true },
      { name: "organization.path.uid", type: "string[]", facet: true, index: true, optional: true },
      { name: "organization.path.name", type: "string[]", facet: true, index: true, optional: true },

      // The denormalized fulfillment verb the card surface buttons off.
      { name: "action.value", type: "string", facet: true, index: true, optional: true },

      // The `orders` source payload (`CardOrdersSource`) — which leg of the
      // order's pair this card is, and that leg's in-store flag. Stored, not
      // derived; present only on an event card.
      { name: "orders", type: "object", optional: true },
      { name: "orders.leg", type: "string", facet: true, index: true, optional: true },
      { name: "orders.customer_collecting", type: "bool", facet: true, index: true, optional: true },
      { name: "orders.customer_returning", type: "bool", facet: true, index: true, optional: true },
      // The same payload under the new source label (`CardFulfillmentsSource`).
      // Both are declared while both are legal; `orders.*` goes with P4 of
      // the api-cloudrun cards-from-fulfillments plan.
      { name: "fulfillments", type: "object", optional: true },
      { name: "fulfillments.leg", type: "string", facet: true, index: true, optional: true },
      { name: "fulfillments.customer_collecting", type: "bool", facet: true, index: true, optional: true },
      { name: "fulfillments.customer_returning", type: "bool", facet: true, index: true, optional: true },

      // The by-destination roll-up key — `cardPickBucket` (`@cfs/core/utils/cards`),
      // in `fulfillments:destinations.pick_bucket`'s vocabulary (a destination uid
      // or `customer-collect`), so one manager fold reads either facet.
      //
      // 🔴 **Derived at index time, and a SCALAR here where the fulfillments one
      // is an array.** A card IS one leg, so the element-*i*-of-a-sibling-array
      // correlation problem that forced the fulfillments key to index time does
      // not arise — but `destination.uid` alone cannot say "in-store", and the
      // store's own row would swallow 24 of 43 open prod cards (2026-09-20).
      // Absent on a to-do and on an event card not yet rebuilt with `orders`.
      { name: "pick_bucket", type: "string", facet: true, index: true, optional: true },

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
  pulseShards: 1,
  displayDefaults: {
    // `uid_list` and `uid_assignees` are not columns: they could only ever print
    // an opaque Firestore id.
    //
    // ⚠️ This comment used to add that they "stay FACETS, which is where that
    // resolution already lives", naming a `facet: ["uid_list", …]` entry beside
    // it. **No such resolution existed anywhere** (core#50). `getFilters()`
    // requires a covering declared column, which `uid_list` deliberately lacks,
    // so it was never offered as a filter either — and the `facet` key it sat in
    // had no reader at all, so nothing could contradict the claim. Both are gone.
    //
    // A list filter is still worth having. It needs option labels resolved
    // through the lists store — `useListsGroupKeys`, already wired for the
    // `uid_list` groupBy axis in `card.ts` — rather than the raw ids Typesense
    // returns, plus a declared column to carry the heading.
    columns: ["subject", "status", "date_fs", "created_by"],
    filters: {},
  },
};
