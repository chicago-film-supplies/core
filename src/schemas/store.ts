/**
 * Store document schema — Firestore collection: stores
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { type FirestoreTimestampType, TimestampFields, UidNameRef, type UidNameRefType } from "./common.ts";

/** A store document in Firestore. */
export interface Store {
  uid: string;
  name: string;
  default: boolean;
  default_location: UidNameRefType | null;
  /**
   * The `destinations/{uid}` this store sells FROM — its origin for sourcing.
   *
   * Illinois **origin sourcing**: where CFS is not registered to collect in the
   * destination's jurisdiction, the sale is deemed to occur at the selling
   * location, so a Naperville delivery is taxed at this store's jurisdiction.
   * That is a rule, not a fallback — merging it with the out-of-state case
   * (which is **nexus**, a genuinely different legal reason) untaxes every
   * non-Chicago Illinois delivery.
   *
   * ⚠️ **A bare `uid_x`, deliberately NOT a `UidNameRef` like its sibling
   * `default_location`.** A `Destination` has no `name` field to denormalize;
   * `address.full` is the closest thing and it both exceeds the 100-char cap
   * and is `pii: "mask"`.
   *
   * ⚠️ **Not the same fact as `booking.uid_store`**, which records *which
   * store's stock filled this line*, per line, from `storeAllocation`. Origin
   * sourcing is a property of the DOCUMENT.
   *
   * Optional through api-cloudrun#409 Phase 1.
   */
  uid_destination?: string | null;
  crms_store_id: number;
  version: number;
  active: boolean;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Store. */
export const StoreSchema: z.ZodType<Store> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  // Required (no `.default()`) because the Typesense config declares them so
  // and a `.default()` never materializes on a write — see the note in
  // `product.ts`. `active` carries `initial` so the create form still seeds
  // `true`.
  default: z.boolean().meta({ column: true, label: "Default" }),
  default_location: UidNameRef.nullable().default(null).meta({ label: "Default Location" }),
  // No `column: true` — `display-columns.test.ts` bans a heading ending in
  // "Uid", and there is no name to show in its place (see the docblock).
  uid_destination: FirestoreId.nullable().optional(),
  crms_store_id: z.int(),
  version: z.int().min(0).default(0),
  active: z.boolean().meta({ initial: true, column: true, label: "Active" }),
  ...TimestampFields,
}).meta({
  title: "Store",
  collection: "stores",
  displayDefaults: {
    columns: ["name", "active", "default"],
    filters: { active: [true] },
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a store. */
export interface CreateStoreInputType {
  uid: string;
  name: string;
  crms_store_id: number;
  default?: boolean;
}
/** Input schema for creating a store. */
export const CreateStoreInput: z.ZodType<CreateStoreInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100),
  crms_store_id: z.int(),
  default: z.boolean().optional(),
});

/** Input type for updating a store. */
export interface UpdateStoreInputType {
  uid: string;
  name?: string;
  crms_store_id?: number;
  default?: boolean;
  active?: boolean;
  version: number;
}
/** Input schema for updating a store. */
export const UpdateStoreInput: z.ZodType<UpdateStoreInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  crms_store_id: z.int().optional(),
  default: z.boolean().optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});
