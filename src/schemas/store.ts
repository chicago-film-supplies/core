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
  crms_store_id: number;
  version: number;
  active: boolean;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Store. */
export const StoreSchema: z.ZodType<Store> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100),
  // Required (no `.default()`) because the Typesense config declares them so
  // and a `.default()` never materializes on a write — see the note in
  // `product.ts`. `active` carries `initial` so the create form still seeds
  // `true`.
  default: z.boolean(),
  default_location: UidNameRef.nullable().default(null),
  crms_store_id: z.number(),
  version: z.int().min(0).default(0),
  active: z.boolean().meta({ initial: true }),
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
  crms_store_id: z.number(),
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
  crms_store_id: z.number().optional(),
  default: z.boolean().optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});
