/**
 * Tag document schema — Firestore collection: tags
 */
import { z } from "zod";
import { ActorRef, type ActorRefType, type FirestoreFieldValue, type FirestoreTimestampType, TimestampFields, type UidNameRefType, UidNameRef } from "./common.ts";

/** A tag document in Firestore. */
export interface Tag {
  uid: string;
  name: string;
  count?: Record<string, FirestoreFieldValue> | number;
  products?: UidNameRefType[];
  query_by_products?: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for Tag. */
export const TagSchema: z.ZodType<Tag> = z.strictObject({
  uid: z.string(),
  name: z.string().min(1).max(100),
  count: z.union([z.record(z.string(), z.custom<FirestoreFieldValue>()), z.number()]).optional(),
  products: z.array(UidNameRef).default([]).optional(),
  query_by_products: z.array(z.string()).default([]).optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Tag",
  collection: "tags",
  displayDefaults: {
    columns: ["name", "count", "products.name"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a tag. */
export interface CreateTagInputType {
  uid?: string;
  name: string;
}
/** Input schema for creating a tag. */
export const CreateTagInput: z.ZodType<CreateTagInputType> = z.object({
  uid: z.string().optional(),
  name: z.string().min(1).max(100),
});

/** Input type for updating a tag. */
export interface UpdateTagInputType {
  uid: string;
  name: string;
  version: number;
}
/** Input schema for updating a tag. */
export const UpdateTagInput: z.ZodType<UpdateTagInputType> = z.object({
  uid: z.string(),
  name: z.string().min(1).max(100),
  version: z.int().min(0),
});

/** Input type for deleting a tag. */
export interface DeleteTagInputType {
  uid: string;
}
/** Input schema for deleting a tag. */
export const DeleteTagInput: z.ZodType<DeleteTagInputType> = z.object({
  uid: z.string(),
});
