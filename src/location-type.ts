/**
 * LocationType document schema — Firestore collection: location-types
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Product capacity constraint for a location type. */
export interface LocationTypeProductCapacity {
  uid: string;
  max: number | null;
}

/** Physical dimensions for a location type. */
export interface LocationTypeDimensions {
  width?: number;
  depth?: number;
  height?: number;
  weight_capacity?: number;
}

/** A location type document in Firestore. */
export interface LocationType {
  uid: string;
  name: string;
  product_capacities: LocationTypeProductCapacity[];
  query_by_product_capacities?: string[];
  dimensions?: LocationTypeDimensions | null;
  version: number;
  active: boolean;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for LocationType. */
export const LocationTypeSchema: z.ZodType<LocationType> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(100),
  product_capacities: z.array(z.strictObject({
    uid: z.string(),
    max: z.number().nullable(),
  })).default([]),
  query_by_product_capacities: z.array(z.string()).default([]).optional(),
  dimensions: z.strictObject({
    width: z.number().optional(),
    depth: z.number().optional(),
    height: z.number().optional(),
    weight_capacity: z.number().optional(),
  }).nullable().optional(),
  version: z.int().min(0).default(0),
  active: z.boolean().default(true),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Location Type",
  collection: "location-types",
  displayDefaults: {
    columns: ["name", "product_capacities", "dimensions"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a location type. */
export interface CreateLocationTypeInputType {
  name: string;
  product_capacities?: Record<string, { max: number }>;
  dimensions?: { width?: number; depth?: number; height?: number; weight_capacity?: number } | null;
}
/** Input schema for creating a location type. */
export const CreateLocationTypeInput: z.ZodType<CreateLocationTypeInputType> = z.object({
  name: z.string().min(1).max(100),
  product_capacities: z.record(z.string(), z.object({ max: z.number() })).optional(),
  dimensions: z.object({
    width: z.number().optional(),
    depth: z.number().optional(),
    height: z.number().optional(),
    weight_capacity: z.number().optional(),
  }).nullable().optional(),
});

/** Input type for updating a location type. */
export interface UpdateLocationTypeInputType {
  uid: string;
  name?: string;
  product_capacities?: Record<string, { max: number | null }>;
  dimensions?: { width?: number; depth?: number; height?: number; weight_capacity?: number } | null;
  active?: boolean;
  version: number;
}
/** Input schema for updating a location type. */
export const UpdateLocationTypeInput: z.ZodType<UpdateLocationTypeInputType> = z.object({
  uid: z.string(),
  name: z.string().min(1).max(100).optional(),
  product_capacities: z.record(z.string(), z.object({ max: z.number().nullable() })).optional(),
  dimensions: z.object({
    width: z.number().optional(),
    depth: z.number().optional(),
    height: z.number().optional(),
    weight_capacity: z.number().optional(),
  }).nullable().optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});
