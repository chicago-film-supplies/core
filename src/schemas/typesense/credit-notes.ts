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
  version: 2,
  firestoreCollection: "credit-notes",
  collectionName: "credit-notes_v2",
  // ENABLED 2026-08-07. This was `false` with a note saying "flip in Phase 6,
  // alongside the search UI", and it is worth recording why that instruction was
  // superseded rather than simply followed: **its stated reason had expired.**
  //
  // The reason given was that a trigger and a search key would be "infrastructure
  // for an empty index", because the collection "holds no documents until the
  // bootstrap imports the 12 existing Xero notes". That bootstrap has since run —
  // measured 2026-08-07, `credit-notes` holds **12 documents in BOTH envs**. So
  // the index is not empty, and the condition the note was waiting on is met.
  //
  // The manager search UI is still unbuilt, which is the half of that note still
  // true. Enabling ahead of it is deliberate and is the cheaper order: the
  // eventarc trigger keeps the index correct from now on, so the UI arrives to a
  // warm, already-synced index instead of needing a backfill on the day it ships.
  //
  // ⚠️ Enabling is NOT a one-line change — it has two hard consumers, and both go
  // red if they are not updated in the same lockstep bump:
  //   1. `infra/main.tf` → `local.typesense_collections` must gain "credit-notes"
  //      (api-cloudrun's `typesenseTriggerCoverage` pins the two lists together).
  //   2. `creditNotes.search` must come OUT of `UNUSED_PERMISSIONS` in
  //      api-cloudrun's `permissionCoverage.test.ts` — `SEARCHABLE_COLLECTIONS`
  //      filters on `enabled !== false`, so flipping this registers the search
  //      route and the permission stops being unused.
  // And operationally: a NEW collection needs a cold-start reindex, and THEN a
  // re-run of search-key provisioning — deploy-time provisioning skips an alias
  // that did not exist when it ran.
  enabled: true,
  schema: {
    name: "credit-notes_v2",
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
      // NOT optional since api-cloudrun#489, matching the orders config: every
      // stored snapshot carries a profile, so an absent value here would mean
      // an indexing bug rather than a document mid-backfill — and Typesense
      // refusing the document is the honest report of that.
      { name: "organization.tax_profile", type: "string", facet: true },
      { name: "organization.xero_id", type: "string", optional: true },
      ...typesenseAddressFields("organization.billing_address"),
      { name: "items", type: "object[]", optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      { name: "items.quantity", type: "int32[]", optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "items.coa_revenue", type: "int32[]", facet: true, optional: true },
      { name: "totals", type: "object", optional: true },
      { name: "totals.total_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "totals.total_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "remaining_credit_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "remaining_credit_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
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
    columns: [
      "number",
      "date_fs",
      "organization.name",
      "reason",
      "totals.total_cents",
      "remaining_credit_cents",
    ],
    filters: { status: [] },
    sort: { column: "number", direction: "desc" },
  },
};
