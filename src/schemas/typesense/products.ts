import type { TypesenseCollectionConfig } from "./types.ts";

/** Typesense collection config for products. */
export const products: TypesenseCollectionConfig = {
  alias: "products",
  version: 15,
  firestoreCollection: "products",
  collectionName: "products_v15",
  schema: {
    name: "products_v15",
    enable_nested_fields: true,
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "description", type: "string", stem: true, optional: true },
      { name: "tracking_category_name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "type", type: "string", facet: true, sort: true, stem: true },
      { name: "stock_method", type: "string", facet: true, sort: true, stem: true },
      { name: "active", type: "bool", sort: true, facet: true },
      { name: "component_only", type: "bool", sort: true, facet: true },
      { name: "eligible_delivery", type: "bool", sort: true, facet: true },
      { name: "eligible_in_store_pickup", type: "bool", sort: true, facet: true },
      { name: "eligible_shipping_ground", type: "bool", sort: true, facet: true },
      { name: "eligible_shipping_air", type: "bool", sort: true, facet: true },
      { name: "price", type: "object", optional: true },
      { name: "price.base_cents", type: "int64", optional: true, money: true },
      { name: "price.replacement_cents", type: "int64", optional: true, money: true },
      { name: "price.coa_revenue", type: "int32", facet: true, optional: true },
      { name: "price.taxes", type: "object[]", optional: true },
      { name: "price.taxes.uid", type: "string[]", facet: true, optional: true },
      { name: "price.taxes.name", type: "string[]", optional: true },
      { name: "price.taxes.rate", type: "float[]", optional: true },
      { name: "price.taxes.type", type: "string[]", optional: true },
      { name: "price.formula", type: "string", facet: true, optional: true },
      { name: "price.discountable", type: "bool", facet: true, optional: true },
      { name: "webshop", type: "object", optional: true },
      { name: "webshop.available", type: "bool", facet: true, optional: true },
      { name: "webshop.description", type: "string", optional: true },
      { name: "alternates", type: "object[]", optional: true },
      { name: "alternates.uid", type: "string[]", facet: false, optional: true },
      { name: "alternates.name", type: "string[]", stem: true, optional: true },
      { name: "crms_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "uid_tracking_category", type: "string", facet: true, optional: true },
      { name: "uid_linked_replacement", type: "string", optional: true },
      { name: "uid_linked_rental", type: "string", optional: true },
      { name: "xero_id", type: "string", optional: true },
      { name: "xero_tracking_option_id", type: "string", optional: true },
      { name: "crms_rate_id", type: "int64", optional: true },
      { name: "crms_linked_rental_id", type: "int64", optional: true },
      { name: "crms_linked_replacement_id", type: "int64", optional: true },
      { name: "crms_linked_replacement_rate_id", type: "int64", optional: true },
      { name: "shipping", type: "object", optional: true },
      { name: "shipping.weight", type: "float", optional: true },
      { name: "shipping.height", type: "float", optional: true },
      { name: "shipping.width", type: "float", optional: true },
      { name: "shipping.length", type: "float", optional: true },
      { name: "shipping.air_hazardous", type: "bool", facet: true, optional: true },
      { name: "shipping.air_un", type: "float", optional: true },
      { name: "tags", type: "object[]", optional: true },
      { name: "tags.uid", type: "string[]", facet: true, optional: true },
      { name: "tags.name", type: "string[]", stem: true, facet: true, optional: true },
      { name: "components", type: "object[]", optional: true },
      { name: "components.uid", type: "string[]", optional: true },
      { name: "components.path", type: "string[]", optional: true },
      { name: "components.name", type: "string[]", optional: true },
      { name: "components.quantity", type: "float[]", optional: true },
      { name: "components.active", type: "bool[]", facet: true, optional: true },
      { name: "components.type", type: "string[]", facet: true, optional: true },
      { name: "components.stock_method", type: "string[]", facet: true, optional: true },
      { name: "components.crms_id", type: "int64[]", optional: true },
      { name: "components.crms_accessory_id", type: "int64[]", optional: true },
      { name: "components.description", type: "string[]", optional: true },
      { name: "components.inclusion_type", type: "string[]", facet: true, optional: true },
      { name: "components.zero_priced", type: "bool[]", facet: true, optional: true },
      { name: "components.price", type: "object[]", optional: true },
      { name: "components.price.base_cents", type: "int64[]", optional: true, money: true },
      { name: "components.price.replacement_cents", type: "int64[]", optional: true, money: true },
      { name: "components.price.coa_revenue", type: "int32[]", facet: true, optional: true },
      { name: "components.price.taxes", type: "object[]", optional: true },
      { name: "components.price.taxes.uid", type: "string[]", optional: true },
      { name: "components.price.taxes.name", type: "string[]", optional: true },
      { name: "components.price.taxes.rate", type: "float[]", optional: true },
      { name: "components.price.taxes.type", type: "string[]", optional: true },
      { name: "components.price.formula", type: "string[]", facet: true, optional: true },
      { name: "components.price.discountable", type: "bool[]", facet: true, optional: true },
      { name: "component_of", type: "object[]", optional: true },
      { name: "component_of.uid", type: "string[]", optional: true },
      { name: "component_of.path", type: "string[]", optional: true },
      { name: "component_of.name", type: "string[]", optional: true },
      { name: "component_of.quantity", type: "float[]", optional: true },
      { name: "component_of.active", type: "bool[]", facet: true, optional: true },
      { name: "component_of.type", type: "string[]", facet: true, optional: true },
      { name: "component_of.stock_method", type: "string[]", facet: true, optional: true },
      { name: "component_of.crms_id", type: "int64[]", optional: true },
      { name: "component_of.crms_accessory_id", type: "int64[]", optional: true },
      { name: "component_of.description", type: "string[]", optional: true },
      { name: "component_of.inclusion_type", type: "string[]", facet: true, optional: true },
      { name: "component_of.zero_priced", type: "bool[]", facet: true, optional: true },
      { name: "component_of.price", type: "object[]", optional: true },
      { name: "component_of.price.base_cents", type: "int64[]", optional: true, money: true },
      { name: "component_of.price.replacement_cents", type: "int64[]", optional: true, money: true },
      { name: "component_of.price.coa_revenue", type: "int32[]", facet: true, optional: true },
      { name: "component_of.price.taxes", type: "object[]", optional: true },
      { name: "component_of.price.taxes.uid", type: "string[]", optional: true },
      { name: "component_of.price.taxes.name", type: "string[]", optional: true },
      { name: "component_of.price.taxes.rate", type: "float[]", optional: true },
      { name: "component_of.price.taxes.type", type: "string[]", optional: true },
      { name: "component_of.price.formula", type: "string[]", facet: true, optional: true },
      { name: "component_of.price.discountable", type: "bool[]", facet: true, optional: true },
      { name: "crms_stock_level_ids", type: "int64[]", optional: true },
      { name: "query_by_components", type: "string[]", facet: true, optional: true },
      { name: "query_by_component_of", type: "string[]", facet: true, optional: true },
      // `images` is declared as a nested object array, NOT as the flat
      // `query_by_images` mirror that Firestore needs.
      //
      // That asymmetry is the whole reason `deleteQueryByFields` strips every
      // `query_by_*` key on the way out: Firestore cannot query inside an object
      // array, so it needs the denormalized mirror; Typesense CAN, so the mirror
      // would be redundant duplication here. Declare the sub-fields and query
      // them directly — same shape as `contacts.organizations.*`,
      // `cards.sources.*`, `bookings.stores.*`.
      //
      // Every sub-field must be `optional`, and for the same reason as the note
      // on `cards.sources.*`: a product with no images, or a fresh image row
      // whose cutout/alt/dimensions are still null, would otherwise 400 the
      // upsert. Verified against dev Typesense 2026-07-25 — a null sub-value in
      // an optional field is dropped by Typesense rather than rejected, so a
      // brand-new row indexes cleanly.
      //
      // Sub-field types are ARRAY types because the parent is `object[]`:
      // Typesense flattens `images[].uuid` to `images.uuid = [...]`.
      //
      // Verified queryable: `filter_by=images.uuid:=<id>` and
      // `images.uuid_cutout:=<id>` both resolve (the `array-contains`
      // equivalent), and `query_by=images.alt` makes alt text full-text
      // searchable — which the flat mirror could never have offered.
      //
      // `computeSchemaHash` sees the retype from the old `images: string[]` and
      // forces a full reindex under a new collection version; Typesense cannot
      // retype a field in place. The #352 fan-out cap applies.
      { name: "images", type: "object[]", optional: true },
      { name: "images.uuid", type: "string[]", facet: false, optional: true },
      { name: "images.uuid_cutout", type: "string[]", facet: false, optional: true },
      { name: "images.alt", type: "string[]", stem: true, optional: true },
      { name: "images.width", type: "int32[]", optional: true },
      { name: "images.height", type: "int32[]", optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
    ],
    default_sorting_field: "name",
  },
  synonyms: [
    { id: "garbage-trash", synonyms: ["garbage", "trash"] },
    { id: "walkie-radio", synonyms: ["walkie", "radio"] },
    { id: "hotspot-mifi", synonyms: ["hotspot", "mifi"] },
    { id: "can-bin", synonyms: ["can", "bin"] },
  ],
  displayDefaults: {
    columns: ["name", "type", "tracking_category_name", "tags.name", "components.name", "component_of.name", "alternates.name"],
    filters: { type: ["rental", "sale", "service"], active: [true] },
    sort: { column: "name", direction: "asc" },
    group: null,
    facet: [],
  },
};
