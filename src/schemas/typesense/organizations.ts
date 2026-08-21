import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for organizations. */
export const organizations: TypesenseCollectionConfig = {
  alias: "organizations",
  version: 11,
  firestoreCollection: "organizations",
  collectionName: "organizations_v11",
  schema: {
    name: "organizations_v11",
    enable_nested_fields: true,
    token_separators: ["(", ")", "-", "+", " "],
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "description", type: "string", stem: true, optional: true },
      { name: "crms_id", type: "int64", sort: true, index: true, facet: false },
      { name: "crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "xero_id", type: "string", facet: false, optional: true },
      // 🔴 **These two replace `tax_profile`, and adding them is what makes the
      // removal safe rather than merely tidy.** `OrderOrg.tsx` attaches a
      // customer from SEARCH and seeds the order's organization snapshot from
      // the Typesense document it holds — so an index that carries neither the
      // enum nor the axes shows the order taxed at the ORIGIN for one
      // round-trip, and translating the enum client-side is the second
      // implementation api-cloudrun#486 exists to prevent. `OrderDetail`'s
      // attach path holds the whole Firestore document and never needed this.
      //
      // `optional: true` on both because both are `.optional()` on
      // `Organization` through the expand step — the parity test's check B is
      // exactly that correspondence.
      { name: "jurisdiction_claim", type: "string", facet: true, optional: true },
      { name: "tax_exempt", type: "bool", facet: true, optional: true },
      { name: "emails", type: "string[]", stem: true, optional: true },
      { name: "phones", type: "string[]", optional: true },
      ...typesenseAddressFields("billing_address", { sortFull: true, parentOptional: false }),
      { name: "contacts", type: "object[]" },
      { name: "contacts.uid", type: "string[]", facet: false, optional: true },
      { name: "contacts.first_name", type: "string[]", stem: true, facet: false, optional: true },
      { name: "contacts.middle_name", type: "string[]", stem: true, facet: false, optional: true },
      { name: "contacts.last_name", type: "string[]", stem: true, facet: false, optional: true },
      { name: "contacts.pronunciation", type: "string[]", stem: true, facet: false, optional: true },
      { name: "contacts.roles", type: "string[]", facet: false, optional: true },
      { name: "created_by", type: "object", optional: true },
      { name: "created_by.uid", type: "string", facet: true, optional: true },
      { name: "created_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "updated_by", type: "object", optional: true },
      { name: "updated_by.uid", type: "string", facet: true, optional: true },
      { name: "updated_by.name", type: "string", sort: true, stem: true, facet: true, optional: true },
      { name: "last_order", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "created_at", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "updated_at", type: "int64", sort: true, index: true, facet: false },
    ],
    default_sorting_field: "name",
  },
  synonyms: [],
  displayDefaults: {
    columns: ["name", "contacts", "emails", "phones"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
};
