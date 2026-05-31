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
  name: z.string().min(1).max(100),
  default: z.boolean(),
  uid_location_type: FirestoreId.nullable(),
  product_capacities: z.array(z.strictObject({
    uid: FirestoreId,
    max: z.number().nullable(),
    max_default: z.number().nullable(),
  })).default([]),
  query_by_product_capacities: z.array(z.string()).default([]),
  active: z.boolean(),
  products: z.array(z.strictObject({
    uid: FirestoreId,
    name: z.string(),
    quantity: z.number(),
    default: z.boolean(),
  })).default([]),
  query_by_products: z.array(z.string()).default([]),
  version: z.int().min(0).default(0),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
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
