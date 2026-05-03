/**
 * Tax document schema — Firestore collection: taxes
 *
 * Tax definitions used for computing item-level and order-level tax amounts.
 * Tax data is denormalized onto order items at order time.
 */
import { z } from "zod";
import { chicagoInstant } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  RateTypeEnum,
  type RateType,
} from "./common.ts";

/** A tax definition used for computing item-level and order-level tax amounts. */
export interface Tax {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  active: boolean;
  crms_id: number | null;
  valid_from: string;
  valid_from_fs: FirestoreTimestampType;
  valid_to: string | null;
  valid_to_fs: FirestoreTimestampType | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Tax. */
export const TaxSchema: z.ZodType<Tax> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(100),
  rate: z.number(),
  type: RateTypeEnum,
  active: z.boolean().default(true),
  crms_id: z.int().nullable().default(null),
  valid_from: chicagoInstant(),
  valid_from_fs: FirestoreTimestamp,
  valid_to: chicagoInstant().nullable().default(null),
  valid_to_fs: FirestoreTimestamp.nullable().default(null),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Tax",
  collection: "taxes",
  displayDefaults: {
    columns: ["name", "rate", "type", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input for creating a new tax definition. */
export interface CreateTaxInputType {
  name: string;
  rate: number;
  type: RateType;
  active?: boolean;
  valid_from: string;
  valid_to?: string | null;
}

/** Zod schema for CreateTaxInput. */
export const CreateTaxInput: z.ZodType<CreateTaxInputType> = z.object({
  name: z.string().min(1).max(100),
  rate: z.number(),
  type: RateTypeEnum,
  active: z.boolean().optional(),
  valid_from: chicagoInstant(),
  valid_to: chicagoInstant().nullable().optional(),
});

/** Input for updating an existing tax definition. */
export interface UpdateTaxInputType {
  uid: string;
  name?: string;
  rate?: number;
  type?: RateType;
  active?: boolean;
  valid_from?: string;
  valid_to?: string | null;
  version: number;
}

/** Zod schema for UpdateTaxInput. */
export const UpdateTaxInput: z.ZodType<UpdateTaxInputType> = z.object({
  uid: z.string(),
  name: z.string().min(1).max(100).optional(),
  rate: z.number().optional(),
  type: RateTypeEnum.optional(),
  active: z.boolean().optional(),
  valid_from: chicagoInstant().optional(),
  valid_to: chicagoInstant().nullable().optional(),
  version: z.int().min(0),
});
