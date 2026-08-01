import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/**
 * Typesense collection config for credit notes.
 *
 * `number` is the `default_sorting_field` and is stored bare — `CN-` is
 * presentation only. A prefixed string number would make this field a string
 * and break the sort outright, which is the concrete reason the schema stores an
 * int rather than a display label.
 *
 * There is deliberately **no `settlements` collection here**: settlements are
 * reached by query (`where("uid_invoice","==",…)`), not by search, and a journal
 * with no free-text field has nothing to match on.
 */
export const creditNotes: TypesenseCollectionConfig = {
  alias: "credit-notes",
  version: 1,
  firestoreCollection: "credit-notes",
  collectionName: "credit-notes_v1",
  schema: {
    name: "credit-notes_v1",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      // The reporting axis the whole reason enum exists for — facetable so
      // "what did we credit for early returns" is one query, not a regex over
      // free text the way it is in Odoo.
      { name: "reason", type: "string", facet: true },
      { name: "tax_profile", type: "string", facet: true },
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
      { name: "items", type: "object[]", optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      { name: "items.quantity", type: "int32[]", optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "items.coa_revenue", type: "int32[]", facet: true, optional: true },
      { name: "totals", type: "object", optional: true },
      { name: "totals.total", type: "float", sort: true, optional: true },
      { name: "totals.total_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "remaining_credit", type: "float", sort: true, optional: true },
      { name: "remaining_credit_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "query_by_sources", type: "string[]", facet: false, optional: true },
      { name: "xero_credit_note_id", type: "string", optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "date_fs", type: "int64", sort: true, index: true, facet: false },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "number",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["number", "date_fs", "organization.name", "reason", "totals.total", "remaining_credit"],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
    group: null,
    facet: [],
  },
};
