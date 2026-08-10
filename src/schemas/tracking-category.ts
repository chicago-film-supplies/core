/**
 * TrackingCategory document schema — Firestore collection: tracking-categories
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { ActorRef, type ActorRefType, type FirestoreTimestampType, TimestampFields, UidNameRef, type UidNameRefType } from "./common.ts";

/** A tracking category document in Firestore. */
export interface TrackingCategory {
  uid: string;
  name: string;
  /**
   * Number of products carrying this. A **plain integer**, and the union it
   * replaced (a record of Firestore FieldValue sentinels, or a number) is why the two
   * writers still had to cast: every one reads `(x as number) ?? 0`.
   *
   * `?` is load-bearing and stays. `validateBeforeWrite` strips a top-level
   * FieldValue sentinel by OMITTING the key, so a sentinel write reaches
   * `safeParse` as an absent field — which is what the optionality permits, and
   * what the record arm was mistakenly believed to. Nothing sends one today
   * (api-cloudrun#243 moved both writers to a transactional read-modify-write,
   * because the non-merge `set` in flush would collapse a sentinel to its bare
   * operand), so this is forward tolerance, not a live case.
   */
  count?: number;
  crms_product_group_id?: number;
  crms_service_group_id?: number;
  crms_product_group_name: string;
  products: Record<string, UidNameRefType>;
  xero_tracking_option_id: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for TrackingCategory. */
export const TrackingCategorySchema: z.ZodType<TrackingCategory> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  count: z.int().optional().meta({ column: true, label: "Count" }),
  crms_product_group_id: z.int().optional(),
  crms_service_group_id: z.int().optional(),
  crms_product_group_name: z.string(),
  products: z.record(z.string(), UidNameRef).meta({ label: "Products" }),
  xero_tracking_option_id: z.uuid().nullable(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Tracking Category",
  collection: "tracking-categories",
  displayDefaults: {
    columns: ["name", "count"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a tracking category. */
export interface CreateTrackingCategoryInputType {
  uid: string;
  name: string;
  crms_product_group_id: number;
  crms_product_group_name: string;
}
/** Input schema for creating a tracking category. */
export const CreateTrackingCategoryInput: z.ZodType<CreateTrackingCategoryInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100),
  crms_product_group_id: z.int(),
  crms_product_group_name: z.string(),
});

/** Input type for updating a tracking category. */
export interface UpdateTrackingCategoryInputType {
  uid: string;
  name: string;
  version: number;
}
/** Input schema for updating a tracking category. */
export const UpdateTrackingCategoryInput: z.ZodType<UpdateTrackingCategoryInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100),
  version: z.int().min(0),
});
