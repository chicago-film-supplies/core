/**
 * Tag document schema — Firestore collection: tags
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { ActorRef, type ActorRefType, type FirestoreTimestampType, TimestampFields, type UidNameRefType, UidNameRef } from "./common.ts";

/** A tag document in Firestore. */
export interface Tag {
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
  products?: UidNameRefType[];
  query_by_products?: string[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Tag. */
export const TagSchema: z.ZodType<Tag> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  count: z.int().optional().meta({ column: true, label: "Count" }),
  products: z.array(UidNameRef).default([]).optional().meta({ label: "Products" }),
  query_by_products: z.array(z.string()).default([]).optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
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
  uid: FirestoreId.optional(),
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
  uid: FirestoreId,
  name: z.string().min(1).max(100),
  version: z.int().min(0),
});

/** Input type for deleting a tag. */
export interface DeleteTagInputType {
  uid: string;
}
/** Input schema for deleting a tag. */
export const DeleteTagInput: z.ZodType<DeleteTagInputType> = z.object({
  uid: FirestoreId,
});
