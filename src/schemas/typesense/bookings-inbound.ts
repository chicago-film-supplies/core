import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/**
 * Typesense collection config for inbound bookings (one-document-model 7a) —
 * the twin of `bookings` on the supplier ladder, searched on `receipts.search`.
 *
 * Its own index, never rows in `bookings`: every reader of that alias reads a
 * row as outbound DEMAND (the stock panel's Booked tab, its breakdown columns),
 * and an inbound row is a purchase's custody of SUPPLY, on a ladder whose
 * shared spellings (`lost`, `damaged`) mean different places. The same reason
 * the documents live in their own collection.
 *
 * `source.uid` is the purchase. There is no supplier snapshot (C5): a list
 * that needs the supplier joins on the purchase. `breakdown.*` follows
 * `INBOUND_BREAKDOWN_KEYS`; `quoted` and the two transit keys are stated at
 * zero and nothing writes them yet (rulings 2, 56), so they are declared for
 * the day they move but left out of the default columns.
 */
export const bookingsInbound: TypesenseCollectionConfig = {
  alias: "bookings-inbound",
  version: 1,
  firestoreCollection: "bookings-inbound",
  collectionName: "bookings-inbound_v1",
  enabled: true,
  schema: {
    name: "bookings-inbound_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "uid_product", type: "string", facet: false },
      { name: "source", type: "object" },
      { name: "source.uid", type: "string", facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "type", type: "string", facet: true },
      { name: "name", type: "string", sort: true, stem: true },
      { name: "quantity", type: "int32", sort: true, index: true, facet: false },
      { name: "quantity_ordered", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown", type: "object" },
      { name: "breakdown.quoted", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.ordered", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.transit_inbound", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.received", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.stocked", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.transit_outbound", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.sent_back", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.lost", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.damaged", type: "int32", sort: true, index: true, facet: false },
      { name: "dates", type: "object" },
      { name: "dates.start_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.end_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "destinations", type: "object", optional: true },
      { name: "destinations.delivery", type: "object", optional: true },
      { name: "destinations.delivery.uid", type: "string", optional: true },
      ...typesenseAddressFields("destinations.delivery.address"),
      { name: "destinations.collection", type: "object", optional: true },
      { name: "destinations.collection.uid", type: "string", optional: true },
      ...typesenseAddressFields("destinations.collection.address"),
      { name: "stores", type: "object[]", optional: true },
      { name: "stores.uid_store", type: "string[]", facet: false, optional: true },
      { name: "stores.name", type: "string[]", stem: true, optional: true },
      { name: "stores.quantity", type: "int32[]", optional: true },
      { name: "uid_destination_delivery", type: "string", facet: false, optional: true },
      { name: "uid_destination_collection", type: "string", facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "updated_at",
  },
  synonyms: [],
  // One purchase's receipt per lever request, measured at well under a hundred
  // lines at 7a's census — not the outbound checkout's ~135-booking burst that
  // put `bookings` at 8. Re-measure with the pulse probe before raising it.
  pulseShards: 1,
  displayDefaults: {
    columns: [
      "number",
      "name",
      "type",
      "status",
      "quantity",
      "breakdown.ordered",
      "breakdown.received",
      "breakdown.stocked",
      "breakdown.sent_back",
      "dates.start_fs",
      "dates.end_fs",
    ],
    filters: { status: [] },
  },
};
