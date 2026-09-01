import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for bookings. */
export const bookings: TypesenseCollectionConfig = {
  alias: "bookings",
  version: 5,
  firestoreCollection: "bookings",
  collectionName: "bookings_v5",
  enabled: true,
  schema: {
    name: "bookings_v5",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "uid_product", type: "string", facet: false },
      { name: "uid_order", type: "string", facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "crms_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "crms_product_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_product_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "type", type: "string", facet: true },
      { name: "name", type: "string", sort: true, stem: true },
      { name: "subject", type: "string", sort: true, stem: true, optional: true },
      { name: "organization", type: "object" },
      { name: "organization.uid", type: "string", facet: false, optional: true },
      { name: "organization.name", type: "string", sort: true, stem: true, facet: false },
      { name: "organization.crms_id", type: "int64", optional: true },
      { name: "organization.crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "breakdown", type: "object" },
      { name: "breakdown.out", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.prepped", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.returned", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.quoted", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.reserved", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.lost", type: "int32", sort: true, index: true, facet: false },
      { name: "breakdown.damaged", type: "int32", sort: true, index: true, facet: false },
      { name: "quantity", type: "int32", sort: true, index: true, facet: false },
      { name: "shortage", type: "int32", sort: true, index: true, facet: false, optional: true },
      { name: "total_price_cents", type: "int64", sort: true, index: true, facet: false, optional: true, money: true },
      { name: "unit_price_cents", type: "int64", sort: true, index: true, facet: false, optional: true, money: true },
      { name: "dates", type: "object" },
      { name: "dates.start_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.end_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.charge_start_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.charge_end_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
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
  // 8, because one checkout commits ~135 bookings in a single transaction
  // and every one of them writes a pulse. A HYPOTHESIS to be set by the burst
  // test, not a defended number — sharding costs every connected client a read
  // per pulse write, so the right value is the smallest that clears contention.
  pulseShards: 8,
  displayDefaults: {
    // `breakdown.*` in `BOOKING_BREAKDOWN_KEYS` lifecycle order, and read
    // INSTEAD of inferring a stage from `status` — a booking can read
    // `status: "reserved"` while `breakdown.out` is non-zero, which is exactly
    // the split the stock panel's Booked tab exists to show.
    //
    // `quoted` is deliberately absent: `heldByBooking` excludes it, so it is
    // outside the `Available + Booked + OOS = Held` identity and showing it
    // beside the three terms that ARE in the sum would read as a fourth.
    columns: [
      "number",
      "name",
      "status",
      "organization.name",
      "quantity",
      "breakdown.reserved",
      "breakdown.prepped",
      "breakdown.out",
      "dates.start_fs",
      "dates.end_fs",
    ],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
};
