import type { TypesenseCollectionConfig } from "./types.ts";

/**
 * Typesense collection config for purchases (api-cloudrun#1220).
 *
 * The index behind manager's `/purchases` list: what CFS ORDERED from a
 * supplier. `number` is the `default_sorting_field` and is stored bare, as on
 * `credit-notes` — a prefixed display label would turn the sort field into a
 * string.
 *
 * 🔴 **`supplier.name` MUST stay `facet: false`.** manager's
 * `getQueryByStringFields` builds `query_by` from string fields that are
 * `!f.facet` and covered by a declared display column, so a faceted name drops
 * out of `query_by` and every search returns zero rows with no error. The same
 * line in `typesense/suppliers.ts` carries the full argument.
 *
 * `items.name` is indexed so "which PO has product X" is one query. `notes` is
 * deliberately NOT declared — free text no list column needs; add it when
 * someone wants to search on it.
 *
 * ⚠️ `reference` is `optional: true` because its Zod leaf is `.nullable()`:
 * the translate path omits a null rather than sending one, and a non-optional
 * declaration over a nullable leaf is a permanent, invisible sync 400.
 *
 * v2 (subrent purchase orders) added a `kind` facet and
 * `lines.quantity_returned`.
 *
 * v3 (api-cloudrun#1407, the invoice shape): `lines` → `items` and the document
 * `kind` is retired. The buy/subrent split is now the `items.type` facet — the
 * invoice's `items.type`, nested rather than a top-level mirror, so there is no
 * derived Typesense field to declare. Every `items.*` field is `optional: true`
 * because the arms disagree: a direct item names no product (and, until v5,
 * only a subrent item carried `quantity_returned`).
 *
 * v4 (one-document-model 6e-0a, ruling 32): the `bills[]` and `credits[]`
 * discovery mirrors, `{ uid, number, status }` each, status faceted. Every field
 * is `optional: true` through the expand, so a purchase stored before the
 * backfill still indexes.
 *
 * v5 (one-document-model 7a, C8): the `store` snapshot becomes `uid_store`, a
 * facet the manager labels from its stores cache (the order's key), and
 * `items.quantity_returned` goes: a line's custody lives on its inbound
 * booking. `total_cents` stays until 6e-0b1 (ruling 62). It also gains `subject`,
 * the order's field on the payable side (owner, 2026-11-11), declared as the
 * order's and invoice's are; and `items.uid_product` becomes `items.uid`, the
 * one key a line names its product by (owner, 2026-11-11).
 */
export const purchases: TypesenseCollectionConfig = {
  alias: "purchases",
  version: 5,
  firestoreCollection: "purchases",
  collectionName: "purchases_v5",
  enabled: true,
  schema: {
    name: "purchases_v5",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "number", type: "int64", sort: true, index: true, facet: false },
      { name: "number_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "status", type: "string", facet: true },
      { name: "supplier", type: "object" },
      { name: "supplier.uid", type: "string", facet: false, optional: true },
      { name: "supplier.name", type: "string", sort: true, stem: true, facet: false },
      { name: "uid_store", type: "string", facet: true },
      { name: "subject", type: "string", stem: true, sort: true, optional: true },
      { name: "reference", type: "string", stem: true, sort: true, optional: true },
      { name: "items", type: "object[]", optional: true },
      { name: "items.type", type: "string[]", facet: true, optional: true },
      { name: "items.uid", type: "string[]", facet: false, optional: true },
      { name: "items.name", type: "string[]", stem: true, optional: true },
      // 6e-0a (ruling 32): the bill and supplier-credit mirrors, the twins of
      // `orders.invoices` / `orders.credit_notes`; optional through the expand.
      { name: "bills", type: "object[]", optional: true },
      { name: "bills.uid", type: "string[]", optional: true },
      { name: "bills.number", type: "int64[]", optional: true },
      { name: "bills.status", type: "string[]", facet: true, optional: true },
      { name: "credits", type: "object[]", optional: true },
      { name: "credits.uid", type: "string[]", optional: true },
      { name: "credits.number", type: "int64[]", optional: true },
      { name: "credits.status", type: "string[]", facet: true, optional: true },
      { name: "total_cents", type: "int64", sort: true, optional: true, money: true },
      { name: "total_cents_str", type: "string", index: true, sort: false, facet: false, optional: true },
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
    columns: ["number", "date_fs", "supplier.name", "subject", "status", "total_cents"],
    filters: { status: [] },
  },
};
