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
  // 8, and MEASURED rather than assumed — one checkout commits ~135 bookings in
  // a single transaction and every one of them writes a pulse.
  //
  // Burst test, dev, 2026-09-01: 135 writes at 24 in flight, three runs, via
  // `manager/e2e/scripts/probe-pulse-burst.ts`.
  //
  // | shards | wall  | p50 / p95 / max ms | contention aborts | billed reads per tab |
  // |--------|-------|--------------------|-------------------|----------------------|
  // | 1      | 2.49s | 401 / 530 / 618    | 0                 | 135 of 135 writes    |
  // | 2      | 1.29s | 199 / 330 / 415    | 0                 | 135 of 135 writes    |
  // | 4      | 0.79s | 103 / 193 / 235    | 0                 | 135 of 135 writes    |
  // | 8      | 0.73s |  81 / 241 / 335    | 0                 | 135 of 135 writes    |
  //
  // Three things the measurement settled, two of them against the guess that
  // wrote this number:
  //
  // 1. **Contention never appears as an abort** — zero at every shard count,
  //    including 135 writes onto ONE document. It appears as LATENCY: a single
  //    pulse document sustains ~55 writes/s, so an unsharded burst drains at
  //    2.5s and adds ~400ms to every Eventarc sync request that is holding a
  //    Cloud Run slot open. Eight shards make that 81ms.
  // 2. **Billed reads per burst per tab equal the LANDED WRITES, at every shard
  //    count** — 135 of 135, every run. The backend coalesces nothing at this
  //    rate, so the read side does not discriminate between shard counts at
  //    all. The plan expected this column to be what argued the number DOWN;
  //    it is flat. What a shard does cost is one document in the whole-
  //    collection snapshot every client loads once per connect.
  // 3. **135 pulses collapse to ONE client refresh** (2 searches — the Booked
  //    tab's in-window and out-of-window pair), which is `createStaleSignal`'s
  //    400ms trailing window working at burst scale.
  //
  // So 8 stands: the only axis that moves is per-write latency inside the sync
  // handler, and it improves monotonically for seven extra documents read once
  // per connect. Re-run the probe before changing it.
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
