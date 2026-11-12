import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for supplier credits (api-cloudrun#1220) — the
 * `purchase-credits` collection, a supplier's ACCPAY credit against one
 * purchase.
 *
 * ⚠️ **Not the purchase skeleton**, for the same reasons as
 * `typesense/purchase-bills.ts`: no `store`. v2 moved `lines` + `direct_lines`
 * to one `items` array, as on the bill. A credit's `items` may be EMPTY (a $0
 * credit), which is one more reason every `items*` field is optional.
 *
 * v3 (one-document-model Phase 4): `uid_purchase` is gone with the stored key.
 *
 * v4 (one-document-model 7a): `items.uid_product` → `items.uid`. A line names its
 * product by its uid (owner, 2026-11-11); only a service line keeps a
 * `uid_product`, as attribution.
 * `query_by_sources` is not indexed (the indexer strips every `query_by_*`), as
 * on `credit-notes`.
 *
 * `remaining_credit_cents` is the "what credit is left" column; `reason` is
 * faceted for the same reporting reason it is on `credit-notes`.
 *
 * `supplier.name` stays `facet: false` — see `typesense/suppliers.ts`.
 * `xero_id` and `reference` are `optional: true` because their Zod leaves are
 * `.nullable()`.
 */
export const purchaseCredits: TypesenseCollectionConfig = {
  alias: "purchase-credits",
  version: 4,
  firestoreCollection: "purchase-credits",
  collectionName: "purchase-credits_v4",
  enabled: true,
  schema: {
    name: "purchase-credits_v4",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "supplier", type: "object" },
      { name: "supplier.uid", type: "string", facet: false, optional: true },
      { name: "supplier.name", type: "string", sort: true, stem: true, facet: false },
      { name: "origin", type: "string", facet: true },
      { name: "reason", type: "string", facet: true },
      { name: "status", type: "string", facet: true },
      { name: "xero_id", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "items", type: "object[]", optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      { name: "total_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "total_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "remaining_credit_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "remaining_credit_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
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
  pulseShards: 1,
  displayDefaults: {
    columns: [
      "number",
      "date_fs",
      "supplier.name",
      "reason",
      "total_cents",
      "remaining_credit_cents",
    ],
    filters: { status: [] },
  },
};
