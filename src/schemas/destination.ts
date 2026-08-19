/**
 * Destination document schema — Firestore collection: destinations
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  Address,
  type AddressType,
  type FirestoreTimestampType,
  JurisdictionEnum,
  type JurisdictionType,
  NameField,
  type NameParts,
  NamePartsFields,
  TimestampFields,
  UidNameRef,
  type UidNameRefType,
} from "./common.ts";

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
  /**
   * The tax jurisdiction goods delivered here are sourced to — the **most
   * specific** of the three levels, and the only one an operator authors
   * directly. `null`/absent falls through to the organization's
   * `default_jurisdiction`, then to `deriveJurisdiction(address)`.
   *
   * ⚠️ **ONE nullable field, not a derived/override pair.** Derivation never
   * writes here, so it cannot clobber an operator's value, and there is nothing
   * for a stored derived copy to go stale against — `deriveJurisdiction` is
   * pure and runs at read time.
   *
   * ⚠️ **A destination is SHARED.** It carries `organizations[]`/`contacts[]`
   * back-refs, so editing this affects every FUTURE document using the address.
   * Existing documents are protected by the snapshot on `order.destinations[]`
   * — reprice a live order from the snapshot, never from the master.
   *
   * Optional through api-cloudrun#409 Phase 1: every new tax field is additive.
   */
  jurisdiction?: JurisdictionType | null;
  organizations?: UidNameRefType[];
  query_by_organizations?: string[];
  products?: UidNameRefType[];
  query_by_products?: string[];
  contacts?: DestinationContactRefType[];
  query_by_contacts?: string[];
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
  jurisdiction: JurisdictionEnum.nullable().optional().meta({
    column: true,
    label: "Jurisdiction",
  }),
  organizations: z.array(UidNameRef).default([]).optional().meta({ label: "Organizations" }),
  query_by_organizations: z.array(z.string()).default([]).optional(),
  products: z.array(UidNameRef).default([]).optional().meta({ label: "Products" }),
  query_by_products: z.array(z.string()).default([]).optional(),
  contacts: z.array(DestinationContactRef).default([]).optional(),
  query_by_contacts: z.array(z.string()).default([]).optional(),
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
