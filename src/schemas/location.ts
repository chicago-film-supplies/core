/**
 * Location document schema — Firestore collection: locations
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  FirestoreTimestamp,
  type FirestoreTimestampType,
  LocationRoleEnum,
  type LocationRoleType,
} from "./common.ts";

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
  /**
   * Whether this location is one of the product's **default storage
   * locations** — where it is put away, and the shelf the allocators draw from
   * first. The source of truth for that fact; the ledger's
   * `store_breakdown[].locations[].default` is its per-product copy. A product
   * has exactly ONE per store, only on a `storage` location (ruling 11,
   * corrected 2026-10-13); it may be STORED on several. One schema parse sees
   * one location, so the count is enforced by the API's single writer and its
   * audit, not here.
   */
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
  /**
   * A COPY of the store pointer: true exactly when `store.default_location`
   * names this location. Not a product's default — that is
   * `products[].default`. Scheduled for removal (api-cloudrun#1302 phase 5);
   * read `store.default_location` instead, and add no new readers.
   */
  default: boolean;
  /**
   * `storage` or `staging` ({@link LocationRoleEnum}). **Optional through
   * api-cloudrun#1302's rollout** (`z.strictObject` has no safe direction, so a
   * new key is optional until the deploy that declares it is live, every writer
   * stamps it, and the corpus is backfilled). Absent means `storage`
   * ({@link locationRole}). Becomes required in phase 3.
   */
  role?: LocationRoleType;
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
  // Optional until api-cloudrun#1302 phase 3 — see the interface note.
  role: LocationRoleEnum.optional().meta({ column: true, label: "Role" }),
  // Required-but-nullable, and every one of the 209 prod docs carries the KEY as
  // `null` (2026-08-23). A value census reads that as "dead"; it is not — the
  // writer is explicit and location types are simply unassigned. CLAUDE.md
  // § "Is a field dead?".
  uid_location_type: FirestoreId.nullable(),
  product_capacities: z.array(z.strictObject({
    uid: FirestoreId,
    max: z.int().nullable(),
    max_default: z.int().nullable(),
  })),
  query_by_product_capacities: z.array(z.string()),
  active: z.boolean().meta({ column: true, label: "Active" }),
  products: z.array(z.strictObject({
    uid: FirestoreId,
    name: z.string().meta({ column: true }),
    quantity: z.int().meta({ column: true, label: "Quantity" }),
    default: z.boolean(),
  })).meta({ label: "Products" }),
  query_by_products: z.array(z.string()),
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
  /** Absent means the writer stamps `storage`. */
  role?: LocationRoleType;
  uid_location_type?: string | null;
}
/** Input schema for creating a location. */
export const CreateLocationInput: z.ZodType<CreateLocationInputType> = z.object({
  uid: FirestoreId,
  uid_store: FirestoreId,
  name: z.string().min(1).max(100),
  role: LocationRoleEnum.optional(),
  uid_location_type: FirestoreId.nullable().optional(),
});

/** Input type for updating a location. */
export interface UpdateLocationInputType {
  uid: string;
  name?: string;
  default?: boolean;
  /**
   * Refused by the API while the location holds stock, or while a store
   * pointer or a product's default names it (api-cloudrun#1302 §1).
   */
  role?: LocationRoleType;
  active?: boolean;
  version: number;
}
/** Input schema for updating a location. */
export const UpdateLocationInput: z.ZodType<UpdateLocationInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  default: z.boolean().optional(),
  role: LocationRoleEnum.optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});

/**
 * Set or clear ONE product's default-storage flag at ONE location
 * (`locations/{uid}.products[uid_product].default`) — the only writer of that
 * fact outside a rebuild script (api-cloudrun#1302 §2).
 *
 * **A set MOVES the flag**: a product has exactly one default storage location
 * per store (ruling 11, corrected 2026-10-13), so setting it here clears it on
 * the product's other locations at that store in the same write. A clear
 * touches this location only. The API refuses a set on a location whose role
 * is not `storage`, or on an inactive one. The ledger's per-product copy is
 * refreshed by a post-commit cascade.
 */
export interface SetLocationProductDefaultInputType {
  /** The location. */
  uid: string;
  uid_product: string;
  default: boolean;
  /** The location's `version`, for optimistic concurrency. */
  version: number;
}
/** Input schema for {@link SetLocationProductDefaultInputType}. */
export const SetLocationProductDefaultInput: z.ZodType<SetLocationProductDefaultInputType> = z.object({
  uid: FirestoreId,
  uid_product: FirestoreId,
  default: z.boolean(),
  version: z.int().min(0),
});
