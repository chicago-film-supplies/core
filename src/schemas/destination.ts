/**
 * Destination document schema — Firestore collection: destinations
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  Address,
  type AddressType,
  type FirestoreTimestampType,
  NameField,
  type NameParts,
  NamePartsFields,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";

/**
 * Organization reference embedded in a destination document — **the uid alone**.
 *
 * 🔴 **Its OWN type rather than the shared `UidNameRef`, and that is not
 * cosmetic.** `UidNameRef` also backs `tags`, `products` and `alternates` in
 * `product.ts`, `webshop-product.ts` and `tag.ts`, none of which is part of this
 * campaign; removing `name` from it would have changed all four at once.
 * Population A2 of api-cloudrun#782 — see
 * {@link ContactOrganizationType} for why the edge composes rather than stores,
 * and for the four-step removal this is the last step of.
 *
 * ⭐ **This edge was the campaign's clearest evidence, because nothing ever
 * maintained it.** `contacts.organizations[].name` had a cascade and agreed with
 * `composeOrgName(path)` on 214 of 214 prod edges; this one had none, and
 * **218 of 470 disagreed** — fossils like
 * `"20th Television - Deli Boys - S2: Locations"` against the live
 * `"20th Television / Deli Boys S2 / Locations"` (measured 2026-09-02, both
 * environments). A denormalization with no cascade is not a cheaper
 * denormalization; it is a stale one.
 *
 * ⚠️ **`organizations[]` means *the org that first created this address***, not
 * every org that uses it — all three match branches of `findOrCreateDestination`
 * return the found uid and write nothing back. That is unchanged here, and it is
 * why the array has no `query_by_*` mirror (see the field comment below).
 */
export interface DestinationOrganizationRefType {
  uid: string;
}

/** Zod schema for an organization reference embedded in a destination. */
export const DestinationOrganizationRef: z.ZodType<DestinationOrganizationRefType> = z.strictObject({
  uid: FirestoreId,
});

/**
 * Contact reference embedded in a destination document.
 *
 * Mirrors the split-name shape used in `organizations.contacts[]` so that the
 * Typesense `destinations_v5` collection can index the same `first_name /
 * middle_name / last_name / pronunciation` fields without an adapter. `name`
 * is the server-derived display string (see `deriveName` in common.ts).
 */
export interface DestinationContactRefType extends NameParts {
  uid: string;
  name: string;
}

/** Zod schema for a contact reference embedded in a destination. */
export const DestinationContactRef: z.ZodType<DestinationContactRefType> = z.strictObject({
  uid: FirestoreId,
  ...NamePartsFields,
  name: NameField,
});

/** Full Firestore document for a destination (a physical address used in orders). */
export interface Destination {
  uid: string;
  address: AddressType | null;
  mapbox_ids: string[];
  organizations?: DestinationOrganizationRefType[];
  products?: UidNameRefType[];
  contacts?: DestinationContactRefType[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Destination. */
export const DestinationSchema: z.ZodType<Destination> = z.strictObject({
  uid: FirestoreId,
  address: Address,
  // Required (no `.default([])`): the Typesense config declares it so, and a
  // `.default()` never materializes on a write — see the note in `product.ts`.
  mapbox_ids: z.array(z.string()),
  // ⚠️ **No `query_by_*` twin on ANY of these three, and the absence is the
  // decision** (api-cloudrun#650). A flat uid mirror exists so Firestore's
  // `array-contains` can match a uid nested inside an array of objects — which
  // is why `contacts.query_by_organizations` and `organizations.query_by_path`
  // both carry one and must keep it. On `destinations` the three mirrors had no
  // writer and no reader, and were stripped from both corpora on 2026-08-28
  // (188 documents each for `organizations`/`products`, 166 for `contacts`).
  //
  // 🔴 They are not merely unused — wiring them up would have been WRONG. All
  // three match branches of `findOrCreateDestination` return the found uid and
  // write nothing back, so `organizations[]` means *"the org that first created
  // this address"*, not *"every org that uses it"*. A mirror cannot be more
  // correct than the array it mirrors, and a faithful mirror of an incomplete
  // array is worse than none because it reads as authoritative. The
  // ancestor-scoped picker that these were kept for is a read-only search
  // surface, and Typesense already indexes `organizations.uid` directly.
  organizations: z.array(DestinationOrganizationRef).optional().meta({ label: "Organizations" }),
  products: z.array(UidNameRef).optional().meta({ label: "Products" }),
  // `contacts`: declared ahead of use. 192 of 458 prod destinations carried the
  // key, none with an element (2026-08-23) — the feature has not shipped.
  // Deliberately carries no issue; this line is the record.
  // CLAUDE.md § "Is a field dead?".
  contacts: z.array(DestinationContactRef).optional(),
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).meta({
  title: "Destination",
  collection: "destinations",
  displayDefaults: {
    columns: ["address.full", "address.city", "address.region"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
