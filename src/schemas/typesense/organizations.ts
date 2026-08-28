import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for organizations. */
export const organizations: TypesenseCollectionConfig = {
  alias: "organizations",
  version: 12,
  firestoreCollection: "organizations",
  collectionName: "organizations_v12",
  schema: {
    name: "organizations_v12",
    enable_nested_fields: true,
    // `/` joins the composed name's segments (`ORG_NAME_DELIMITER`), so without
    // it a search for "Locations" cannot match
    // `Netflix Productions, LLC / Saturn Return / Locations` as one token run.
    token_separators: ["(", ")", "-", "+", " ", "/"],
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      { name: "name", type: "string", sort: true, stem: true, facet: false },
      { name: "description", type: "string", stem: true, optional: true },
      // `optional: true` because `Organization.crms_id` is now NULLABLE: a
      // minted root or project has no CRMS counterpart and must not create one.
      // Without this the sync 400s on the first non-leaf node.
      { name: "crms_id", type: "int64", sort: true, index: true, facet: false, optional: true },
      { name: "crms_id_str", type: "string", index: true, sort: false, facet: false, optional: true },
      { name: "xero_id", type: "string", facet: false, optional: true },
      // ── The tree ──────────────────────────────────────────────────────────
      //
      // ⚠️ **`path` is indexed NATIVELY, so there is no flat uid mirror on this
      // side.** `enable_nested_fields` is already on above and `contacts.uid` is
      // declared exactly this way, so `filter_by: path.uid:=<rootUid>` answers
      // "every descendant of X" with no extra field. The Firestore-only
      // `query_by_organizations` mirror exists because Firestore's
      // `array-contains` compares WHOLE elements and cannot match a uid inside
      // an array of objects — that is a limitation of the other store, not a
      // shape this one needs.
      //
      // ⚠️ **`path.uid` / `path.name` are filter-only, NOT declared columns.**
      // The manager's derived-surface rules are not symmetric: a *filter* needs
      // `facet: true` plus a declared column covering it, while a *Firestore*
      // filter needs a declared column of enum/bool/date kind OUTSIDE any array
      // — which these are not. They are read by hand-written store queries
      // (`ContactOrganizations.tsx` already filters on `uid`, which is
      // `facet: false`), because the facet-plus-column rule binds the GENERIC
      // filter surface rather than a hand-written `filter_by`.
      { name: "path", type: "object[]", optional: true },
      { name: "path.uid", type: "string[]", facet: false, optional: true },
      { name: "path.name", type: "string[]", stem: true, facet: false, optional: true },
      // 🔴 **DERIVED at index time, and it has to be.** Typesense cannot facet
      // on an array's LENGTH, and the level is `ORG_LEVELS[path.length - 1]` —
      // there is no stored `level` and there must not be, or it could disagree
      // with `path`. This is a PROJECTION rebuilt from Firestore by
      // `syncTypesenseCollections()`, never a second authority.
      //
      // A declared column (`TYPESENSE_ROLLUP_COLUMNS.organizations`) and
      // `facet: true`, which together are what make `filter_by: level:=department`
      // legal on the org picker through the generic filter surface rather than
      // an undeclared filter the manager's surface rules refuse.
      { name: "level", type: "string", facet: true, optional: true },
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
