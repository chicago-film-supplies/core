/**
 * TrackingCategory document schema — Firestore collection: tracking-categories
 */
import { z } from "zod";
import { ActorRef, type ActorRefType, type FirestoreFieldValue, type FirestoreTimestampType, TimestampFields, UidNameRef, type UidNameRefType } from "./common.ts";

/** A tracking category document in Firestore. */
export interface TrackingCategory {
  uid: string;
  name: string;
  count?: Record<string, FirestoreFieldValue> | number;
  crms_product_group_id?: number;
  crms_service_group_id?: number;
  crms_product_group_name: string;
  products: Record<string, UidNameRefType>;
  xero_tracking_option_id: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for TrackingCategory. */
export const TrackingCategorySchema: z.ZodType<TrackingCategory> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(100),
  count: z.union([z.record(z.string(), z.custom<FirestoreFieldValue>()), z.number()]).optional(),
  crms_product_group_id: z.number().optional(),
  crms_service_group_id: z.number().optional(),
  crms_product_group_name: z.string(),
  products: z.record(z.string(), UidNameRef),
  xero_tracking_option_id: z.string().nullable(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Tracking Category",
  collection: "tracking-categories",
  displayDefaults: {
    columns: ["name", "count", "products"],
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
  uid: z.string(),
  name: z.string().min(1).max(100),
  crms_product_group_id: z.number(),
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
  uid: z.string(),
  name: z.string().min(1).max(100),
  version: z.int().min(0),
});
