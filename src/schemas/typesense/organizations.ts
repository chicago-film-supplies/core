import type { TypesenseCollectionConfig } from "./types.ts";
import { typesenseAddressFields } from "./types.ts";

/** Typesense collection config for organizations. */
export const organizations: TypesenseCollectionConfig = {
  alias: "organizations",
  version: 15,
  firestoreCollection: "organizations",
  collectionName: "organizations_v15",
  schema: {
    name: "organizations_v15",
    enable_nested_fields: true,
    // `/` joins the composed name's segments (`ORG_NAME_DELIMITER`), so without
    // it a search for "Locations" cannot match
    // `Netflix Productions, LLC / Saturn Return / Locations` as one token run.
    token_separators: ["(", ")", "-", "+", " ", "/"],
    fields: [
      { name: "uid", type: "string", sort: true, facet: false },
      // ⚠️ **`optional: true` because `Organization.name` is being REMOVED**
      // (api-cloudrun#709). It is still fed by the stored scalar today and by
      // `composeOrgName(path)` once the producer lands; the flag is what lets
      // the corpus be purged between those two states without the sync 400ing.
      { name: "name", type: "string", sort: true, stem: true, facet: false, optional: true },
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
      // `query_by_path` mirror exists because Firestore's
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
      // 🔴 **DERIVED at index time for the SAME reason `level` is, and from the
      // one segment `level` cannot see: `path.at(-1).derived`.** A minted
      // `(default)` project indexes with `name = composeOrgName(path)`, and that
      // compose DROPS the derived segment — so the placeholder's label is
      // character-for-character its root's, and every org picker shows two rows
      // an operator cannot tell apart (api-cloudrun#791).
      //
      // 🔴 **The producer must run on the SOURCE, before `stripUndeclaredFields`.**
      // This config declares `path`, `path.uid` and `path.name` and never
      // `path.derived` — deliberately, and that line is not being crossed here
      // (see `api-cloudrun/.claude/skills/organization-tree/SKILL.md`). So by
      // `postProcess` the flag is already gone, and since `!undefined` is TRUE a
      // producer placed there would index `derived: false` CORPUS-WIDE with
      // nothing red. That is the `deliveries`/`pickups` shape, which indexed a
      // constant-true facet on 644 of 1,000 prod orders before anyone noticed.
      // `api-cloudrun/tests/unit/typesenseOrgLevel.test.ts` carries the
      // population assertion that makes the placement checkable rather than
      // merely documented.
      //
      // ⚠️ **`optional: true` matches `level`, and it has a SHARPER failure than
      // `level` does.** In Typesense a `filter_by` on an optional field excludes
      // documents that do not carry it — so a client filtering `derived:=false`
      // against an index that has not been reindexed yet gets an EMPTY picker,
      // where an absent `level` merely makes one filter return nothing. The
      // ordering that avoids it (core → api → reindex → verify the alias flip →
      // only then the client filter) is owned by
      // `api-cloudrun/.claude/plans/post-cutover-issue-roadmap.md`, because it
      // cannot be enforced from inside this file.
      { name: "derived", type: "bool", facet: true, optional: true },
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
      // 🔴 **`parentOptional` must be TRUE: `Organization.billing_address` is
      // `Address.nullable()` and always has been.** The config claimed the object
      // was required, and Typesense answers `HTTP 400 — Field billing_address has
      // an incorrect type` for a null. It never bit because every one of the 292
      // real customer records happened to carry an address — a present-tense
      // claim about the CORPUS, standing in for a claim about the SCHEMA, which
      // is the hazard `api-cloudrun/CLAUDE.md` names under Ratchet H.
      //
      // The org tree's 30 MINTED ancestors are the first documents to exercise
      // it: a minted root has no billing address by construction, so all 30
      // failed to index while every real organization synced fine. ⚠️ The same
      // 400 was already reachable through the API — `CreateOrganizationInput`
      // accepts a null `billing_address` — so this was a live latent defect, not
      // one the migration introduced.
      ...typesenseAddressFields("billing_address", { sortFull: true }),
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
    // 🔴 **Moved off `name` in v14, and Typesense forced the choice.** Probed
    // against a live dev collection 2026-08-28: creating a collection whose
    // `default_sorting_field` is an `optional: true` field is refused outright —
    // *"Default sorting field `name` cannot be an optional field."* — while the
    // same config with `optional: false` created cleanly. So `name` could not
    // become optional while it was the sort field, and it has to become optional
    // before the corpus can be purged.
    //
    // `updated_at` is `int64`, `sort: true` and the only non-optional sortable
    // numeric here. ⚠️ This is Typesense's TIE-BREAKER for relevance ranking,
    // not the table's default sort — that is `displayDefaults.sort` below, which
    // still reads `name` ascending.
    default_sorting_field: "updated_at",
  },
  synonyms: [],
  pulseShards: 1,
  displayDefaults: {
    columns: ["name", "contacts", "emails", "phones"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
};
