/**
 * Typesense archetype — every msg emitted from the
 * `src/services/reindexTypesense.ts` pipeline and its helpers.
 *
 * **PII posture**: none. Collection names, alias names, document_ids
 * (Firestore-uid-shaped opaque ids) are not PII. The `error_message`
 * field (when present) is length-capped + email/phone-masked by Tier 3.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const TYPESENSE_EVENT_MSGS = [
  "typesense_alias_mismatch",
  "typesense_batch_import_failed",
  "typesense_build_delete_failed",
  "typesense_cleanup_old_collections_failed",
  "typesense_collection_created",
  "typesense_count_mismatch",
  "typesense_delete",
  "typesense_import_failed",
  "typesense_orphan_delete_failed",
  "typesense_parent_keys_missing",
  "typesense_parent_keys_parse_failed",
  "typesense_purge_orphans_failed",
  "typesense_reindex_enqueued",
  "typesense_reindex_superseded",
  "typesense_reindex_swapped",
  "typesense_scoped_key_parent_missing",
  "typesense_swap_alias_failed",
  "typesense_sync_check_failed",
  "typesense_sync_synonyms_failed",
  "typesense_synonyms_synced",
  "typesense_translate_failed",
  "typesense_upsert",
] as const;

/** Discriminated msg union for Typesense-archetype log records. */
export type TypesenseEventMsg = (typeof TYPESENSE_EVENT_MSGS)[number];

/** Structured log entry for any Typesense pipeline event. */
export interface TypesenseEventLogRecord {
  level: LogLevelType;
  msg: TypesenseEventMsg;
  ts: string;
  collection?: string;
  typesense_collection?: string;
  document_id?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link TypesenseEventLogRecord}. */
export const TypesenseEventLogRecordSchema: z.ZodType<TypesenseEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(TYPESENSE_EVENT_MSGS),
  collection: z.string().optional(),
  typesense_collection: z.string().optional(),
  document_id: z.string().optional(),
}).passthrough().meta({ title: "TypesenseEventLogRecord" });
