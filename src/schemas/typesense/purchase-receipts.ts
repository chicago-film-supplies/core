import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/**
 * Typesense collection config for purchase receipts (one-document-model 7a) —
 * the twin of `fulfillments` on the supplier side: what is ARRIVING and what is
 * held for send-back, per purchase, with no price.
 *
 * Mirrors the receipt document as stored (`PurchaseReceiptSchema`), which the
 * purchase writers project and the inbound lever's finalize keeps current. The
 * index behind a receipts list (the custody page, ruling 29): searched on
 * `receipts.search`, so the warehouse role, which holds `receipts.read` and no
 * `purchases.read`, gets a list rather than an empty page — the trap
 * `fulfillment.read` without `fulfillment.search` set on the outbound side.
 *
 * `number` is the `default_sorting_field` (the purchase's, never null);
 * `due_at_fs` is a click-to-sort column, optional because a closed receipt's
 * is null. `supplier.name` stays `facet: false` so it remains in `query_by`
 * (see `typesense/purchases.ts`).
 */
export const purchaseReceipts: TypesenseCollectionConfig = {
  alias: "purchase-receipts",
  version: 1,
  firestoreCollection: "purchase-receipts",
  collectionName: "purchase-receipts_v1",
  enabled: true,
  schema: {
    name: "purchase-receipts_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "supplier", type: "object" },
      { name: "supplier.uid", type: "string", facet: false, optional: true },
      { name: "supplier.name", type: "string", sort: true, stem: true, facet: false },
      { name: "subject", type: "string", sort: true, stem: true, optional: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "destinations", type: "object[]" },
      { name: "destinations.delivery", type: "object[]", optional: true },
      ...typesenseAddressFields("destinations.delivery.address", { array: true }),
      { name: "destinations.delivery.uid", type: "string[]", optional: true },
      { name: "destinations.collection", type: "object[]", optional: true },
      ...typesenseAddressFields("destinations.collection.address", { array: true }),
      { name: "destinations.collection.uid", type: "string[]", optional: true },
      { name: "destinations.dates", type: "object[]", optional: true },
      { name: "destinations.dates.delivery_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.collection_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.collection_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "items", type: "object[]", optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "items.quantity", type: "int32[]", optional: true },
      { name: "items.path", type: "string[]", optional: true, facet: false },
      { name: "due_at_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "number",
  },
  synonyms: [],
  pulseShards: 1,
  displayDefaults: {
    columns: ["number", "supplier.name", "subject", "status", "due_at_fs"],
    filters: { status: [] },
  },
};
