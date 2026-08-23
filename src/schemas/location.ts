/**
 * Location document schema — Firestore collection: locations
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Product capacity constraint for a location. */
export interface LocationProductCapacity {
  uid: string;
  max: number | null;
  max_default: number | null;
}

/** A product assigned to a location. */
export interface LocationProduct {
  uid: string;
  name: string;
  quantity: number;
  default: boolean;
}

/** A location document in Firestore. */
export interface Location {
  uid: string;
  uid_store: string;
  name: string;
  /**
   * Canonical uniqueness key — `normalizeLocationName(name)` from
   * `@cfs/core/utils/locations`. Backs the case- and separator-insensitive
   * "one active name per store" check on every write path. Optional so a
   * doc predating the backfill still validates on its next full-doc write:
   * `updateLocation`'s `{...existing, ...updates}` merge, `stageLocationUpdates`
   * / `stageLocationReversal`'s `transaction.set({...existing, …})`, and
   * `resyncLocationQuantities` all re-validate the whole doc, so a *required*
   * field would 500 on any not-yet-backfilled location. (The
   * `api-cloudrun/src/services/locationTypes.ts` cascade writes field-by-field
   * via `validatedPatch`, never a full-doc parse,
   * so it is not the constraint — do not narrow this optional window by it.)
   */
  name_key?: string;
  default: boolean;
  uid_location_type: string | null;
  product_capacities: LocationProductCapacity[];
  query_by_product_capacities: string[];
  active: boolean;
  products: LocationProduct[];
  query_by_products: string[];
  version: number;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Location. */
export const LocationSchema: z.ZodType<Location> = z.strictObject({
  uid: FirestoreId,
  uid_store: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  // Derived denorm (see the interface note). Optional through the backfill
  // window; no `.min(1)` because a name of pure separators normalizes to "".
  name_key: z.string().max(100).optional(),
  default: z.boolean().meta({ column: true, label: "Default" }),
  // Required-but-nullable, and every one of the 209 prod docs carries the KEY as
  // `null` (2026-08-23). A value census reads that as "dead"; it is not — the
  // writer is explicit and location types are simply unassigned. CLAUDE.md
  // § "Is a field dead?".
  uid_location_type: FirestoreId.nullable(),
  product_capacities: z.array(z.strictObject({
    uid: FirestoreId,
    max: z.int().nullable(),
    max_default: z.int().nullable(),
  })).default([]),
  query_by_product_capacities: z.array(z.string()).default([]),
  active: z.boolean().meta({ column: true, label: "Active" }),
  products: z.array(z.strictObject({
    uid: FirestoreId,
    name: z.string().meta({ column: true }),
    quantity: z.int().meta({ column: true, label: "Quantity" }),
    default: z.boolean(),
  })).default([]).meta({ label: "Products" }),
  query_by_products: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).meta({
  title: "Location",
  collection: "locations",
  displayDefaults: {
    columns: ["name", "active", "default"],
    filters: { active: [true] },
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a location. */
export interface CreateLocationInputType {
  uid: string;
  uid_store: string;
  name: string;
  uid_location_type?: string | null;
}
/** Input schema for creating a location. */
export const CreateLocationInput: z.ZodType<CreateLocationInputType> = z.object({
  uid: FirestoreId,
  uid_store: FirestoreId,
  name: z.string().min(1).max(100),
  uid_location_type: FirestoreId.nullable().optional(),
});

/** Input type for updating a location. */
export interface UpdateLocationInputType {
  uid: string;
  name?: string;
  default?: boolean;
  active?: boolean;
  version: number;
}
/** Input schema for updating a location. */
export const UpdateLocationInput: z.ZodType<UpdateLocationInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  default: z.boolean().optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});
