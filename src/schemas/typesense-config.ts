/**
 * TypesenseConfig document schema — Firestore collection: typesense
 *
 * One doc per Typesense collection, tracks reindex state and schema hash.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

export interface TypesenseConfigReindexStats {
  total: number;
  success: number;
  failed: number;
  errors?: string[];
}

export interface TypesenseConfig {
  uid: string;
  current_collection: string;
  schema_hash: string;
  /**
   * The schema hash the reindex worker should build toward, stamped by
   * startup detection when it differs from the live `schema_hash`. The
   * coordination key for the serialized reindex worker (a version field,
   * last-writer-wins — not a lock). `schema_hash` only advances to this
   * value once a build for it swaps in successfully.
   */
  intended_hash?: string;
  updates?: number;
  last_reindex?: FirestoreTimestampType;
  last_reindex_stats?: TypesenseConfigReindexStats;
  reindex_attempts?: number;
}

const ReindexStats = z.object({
  total: z.number(),
  success: z.number(),
  failed: z.number(),
  errors: z.array(z.string()).optional(),
});

export const TypesenseConfigSchema: z.ZodType<TypesenseConfig> = z.strictObject({
  uid: z.string(),
  current_collection: z.string().meta({ column: true, label: "Collection" }),
  schema_hash: z.string(),
  intended_hash: z.string().optional(),
  updates: z.number().optional().meta({ column: true, label: "Updates" }),
  last_reindex: FirestoreTimestamp.optional().meta({ column: true, label: "Last Reindex" }),
  last_reindex_stats: ReindexStats.optional(),
  reindex_attempts: z.number().optional(),
}).meta({
  title: "TypesenseConfig",
  collection: "typesense",
  displayDefaults: {
    columns: ["current_collection", "last_reindex", "updates"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
