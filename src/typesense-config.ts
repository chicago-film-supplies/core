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
  current_collection: z.string(),
  schema_hash: z.string(),
  updates: z.number().optional(),
  last_reindex: FirestoreTimestamp.optional(),
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
