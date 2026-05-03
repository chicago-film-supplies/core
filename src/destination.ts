/**
 * Destination document schema — Firestore collection: destinations
 */
import { z } from "zod";
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
  uid: z.string(),
  ...NamePartsFields,
  name: NameField,
});

/** Full Firestore document for a destination (a physical address used in orders). */
export interface Destination {
  uid: string;
  address: AddressType | null;
  mapbox_ids: string[];
  organizations?: UidNameRefType[];
  query_by_organizations?: string[];
  products?: UidNameRefType[];
  query_by_products?: string[];
  contacts?: DestinationContactRefType[];
  query_by_contacts?: string[];
  version: number;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for Destination. */
export const DestinationSchema: z.ZodType<Destination> = z.strictObject({
  uid: z.string(),
  address: Address,
  mapbox_ids: z.array(z.string()).default([]),
  organizations: z.array(UidNameRef).default([]).optional(),
  query_by_organizations: z.array(z.string()).default([]).optional(),
  products: z.array(UidNameRef).default([]).optional(),
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
