import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/**
 * Typesense collection config for the sanitized fulfillment order view.
 *
 * Mirrors `orders` by uid but strips all pricing, totals, tax profile,
 * invoice refs, CRM/Xero ids, and financial line-item fields. The default
 * sort is `number` (non-optional, always set) because Typesense rejects
 * optional fields as default_sorting_field; the fulfillment UI overrides
 * this at query time via `displayDefaults.sort` to order by delivery date.
 */
export const fulfillments: TypesenseCollectionConfig = {
  alias: "fulfillments",
  version: 7,
  firestoreCollection: "fulfillments",
  collectionName: "fulfillments_v7",
  schema: {
    name: "fulfillments_v7",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "deliveries", type: "bool", facet: true, optional: true },
      { name: "pickups", type: "bool", facet: true, optional: true },
      { name: "has_conflicts", type: "bool", facet: true, optional: true },
      { name: "subject", type: "string", sort: true, stem: true, optional: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "organization", type: "object" },
      { name: "organization.uid", type: "string", facet: true, optional: true },
      { name: "organization.name", type: "string", sort: true, stem: true, facet: false },
      { name: "dates", type: "object" },
      { name: "dates.delivery_start_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.delivery_end_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.collection_start_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.collection_end_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.charge_start_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "dates.charge_end_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "destinations", type: "object[]" },
      { name: "destinations.delivery", type: "object[]", optional: true },
      ...typesenseAddressFields("destinations.delivery.address", { array: true }),
      { name: "destinations.delivery.instructions", type: "string[]", stem: true, optional: true },
      { name: "destinations.delivery.uid", type: "string[]", optional: true },
      { name: "destinations.delivery.contact", type: "object[]", optional: true },
      { name: "destinations.delivery.contact.uid", type: "string[]", facet: false, optional: true },
      { name: "destinations.delivery.contact.first_name", type: "string[]", stem: true, optional: true },
      { name: "destinations.delivery.contact.middle_name", type: "string[]", stem: true, optional: true },
      { name: "destinations.delivery.contact.last_name", type: "string[]", stem: true, optional: true },
      { name: "destinations.delivery.contact.pronunciation", type: "string[]", stem: true, optional: true },
      { name: "destinations.collection", type: "object[]", optional: true },
      ...typesenseAddressFields("destinations.collection.address", { array: true }),
      { name: "destinations.collection.instructions", type: "string[]", stem: true, optional: true },
      { name: "destinations.collection.uid", type: "string[]", optional: true },
      { name: "destinations.collection.contact", type: "object[]", optional: true },
      { name: "destinations.collection.contact.uid", type: "string[]", facet: false, optional: true },
      { name: "destinations.collection.contact.first_name", type: "string[]", stem: true, optional: true },
      { name: "destinations.collection.contact.middle_name", type: "string[]", stem: true, optional: true },
      { name: "destinations.collection.contact.last_name", type: "string[]", stem: true, optional: true },
      { name: "destinations.collection.contact.pronunciation", type: "string[]", stem: true, optional: true },
      { name: "destinations.dates", type: "object[]", optional: true },
      { name: "destinations.dates.delivery_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.delivery_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.collection_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.collection_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.charge_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.charge_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.days_active", type: "int32[]", optional: true },
      { name: "destinations.dates.days_charged", type: "int32[]", optional: true },
      // The by-destination roll-up key, one entry per destination pair.
      //
      // 🔴 **Customer collect is its OWN bucket, and it has to be settled at
      // INDEX time.** Typesense cannot correlate element *i* of
      // `destinations.delivery.uid` with element *i* of a sibling array, so a
      // document-level flag cannot say WHICH leg is a collect — and without the
      // split one warehouse row swallows the answer (prod: 621 of 1,000 legs).
      // Deriving the key per leg makes that defect unrepresentable rather than
      // policed.
      //
      // ⚠️ **Produced by `coerceArrayFields`, NOT `postProcess`** — see the
      // `fulfillments:destinations.pick_bucket` entry in
      // `tests/typesenseFieldCoverage.test.ts`. `customer_collecting` is not a
      // declared field here, so `stripUndeclaredFields` deletes it, and a
      // producer running after the strip reads `undefined` for every leg.
      { name: "destinations.pick_bucket", type: "string[]", facet: true, optional: true },
      { name: "items", type: "object[]", optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      { name: "items.quantity", type: "int32[]", optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "items.description", type: "string[]", stem: true, optional: true },
      { name: "items.stock_method", type: "string[]", facet: true, optional: true },
      { name: "items.path", type: "string[]", optional: true, facet: false },
      { name: "items.order_number", type: "int32[]", optional: true },
      { name: "items.uid_order", type: "string[]", optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "number",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["number", "organization.name", "subject", "dates.delivery_start_fs", "dates.collection_start_fs", "status"],
    filters: { status: [] },
    sort: { column: "dates.delivery_start_fs", direction: "desc" },
  },
};
