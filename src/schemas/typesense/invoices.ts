import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for invoices. */
export const invoices: TypesenseCollectionConfig = {
  alias: "invoices",
  version: 10,
  firestoreCollection: "invoices",
  collectionName: "invoices_v10",
  schema: {
    name: "invoices_v10",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "tax_profile", type: "string", facet: true },
      { name: "number_orders", type: "int64[]", optional: true },
      { name: "number_orders_str", type: "string[]", index: true, sort: false, facet: false, optional: true },
      { name: "subject", type: "string", stem: true, sort: true, optional: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "external_notes", type: "string", stem: true, optional: true },
      { name: "internal_notes", type: "string", stem: true, optional: true },
      { name: "organization", type: "object" },
      { name: "organization.uid", type: "string", facet: false, optional: true },
      { name: "organization.name", type: "string", sort: true, stem: true, facet: false },
      { name: "organization.crms_id", type: "int64", optional: true },
      { name: "organization.crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "organization.tax_profile", type: "string", facet: true, optional: true },
      { name: "organization.xero_id", type: "string", optional: true },
      ...typesenseAddressFields("organization.billing_address"),
      // Per-destination dates, snapshotted from each source order onto the
      // invoice's destination pairs (same `OrderDocDates` shape as orders, so
      // the `_fs` Timestamp companions already exist in Firestore). Only the
      // filterable epoch-ms arrays are projected — they back the date-range
      // filter on /invoices ("any destination delivering in the window").
      { name: "destinations", type: "object[]", optional: true },
      { name: "destinations.dates", type: "object[]", optional: true },
      { name: "destinations.dates.delivery_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.delivery_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.collection_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.collection_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.charge_start_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "destinations.dates.charge_end_fs", type: "int64[]", index: true, facet: false, optional: true },
      { name: "items", type: "object[]", optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      { name: "items.quantity", type: "int32[]", optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "totals", type: "object", optional: true },
      { name: "totals.total_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.total_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "totals.amount_paid_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_paid_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      // v9: the credit half of settlement. `_str` companions are auto-derived by
      // api-cloudrun's `lib/typesenseTranslate.ts`, so only the float is declared.
      { name: "totals.amount_credited_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_credited_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      // The void bucket (api-cloudrun#436). A voided invoice's value is annulled
      // rather than collected or written off, and it needs its own column for
      // the same reason `amount_credited_cents` does: "billed T / voided T /
      // due 0" is a different fact from "billed T / credited T / due 0", and
      // collapsing them is what made the void class invisible in the first place.
      { name: "totals.amount_void_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_void_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "totals.amount_due_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.amount_due_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "crms_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "crms_opportunity_ids", type: "int64[]", optional: true },
      { name: "xero_id", type: "string", optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "date_fs", type: "int64", sort: true, index: true, facet: false },
      { name: "due_date_fs", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "number",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["number", "organization.name", "reference", "subject", "status"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
};
