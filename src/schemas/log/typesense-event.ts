/**
 * Typesense archetype — every msg emitted from the
 * `api-cloudrun/src/services/reindexTypesense.ts` pipeline and its helpers.
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
  // Emitted once per collection per sync run, HEALTHY OR NOT — see the
  // `TypesenseSyncOutcome` docblock for why the healthy rows are the point.
  "typesense_sync_state",
  "typesense_sync_synonyms_failed",
  "typesense_synonyms_synced",
  "typesense_translate_failed",
  "typesense_upsert",
] as const;

/** Discriminated msg union for Typesense-archetype log records. */
export type TypesenseEventMsg = (typeof TYPESENSE_EVENT_MSGS)[number];

/**
 * What one collection's sync pass did — the payload of `typesense_sync_state`.
 *
 * ⚠️ **`"ok"` is the load-bearing member, not the boring one.** The whole reason
 * this record exists is that the sync used to speak only when something went
 * wrong, which makes a presence rule self-latch: it fires, the condition clears,
 * and nothing ever says so. A state emitted on every pass lets a rule assert the
 * healthy shape and — separately — assert that the pass ran at all.
 *
 * The members are the branches the check can take, and they are deliberately
 * distinguishable rather than collapsed into ok/not-ok: `deferred` means the run
 * hit its deadline or repair budget and this collection goes to the head of the
 * next rotation, which is normal operation, while `repair_failed` is not.
 */
export const TYPESENSE_SYNC_OUTCOMES = [
  /** Alias current, no drift — nothing to do. */
  "ok",
  /** A rebuild was enqueued (schema moved, alias missing, alias stale, bulk drift). */
  "enqueued",
  /** A rebuild was already queued for this exact build; the task name collapsed it. */
  "deduped",
  /** Per-doc drift was found and fixed in band. */
  "repaired",
  /** Per-doc repair was attempted and some documents did not converge. */
  "repair_failed",
  /** Deadline or repair budget reached — this collection waits for the next run. */
  "deferred",
  /** The pass threw for this collection. */
  "failed",
] as const;

/** One collection's outcome in a sync pass. */
export type TypesenseSyncOutcome = (typeof TYPESENSE_SYNC_OUTCOMES)[number];

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
  /** `typesense_sync_state` — what this collection's pass did. */
  outcome?: TypesenseSyncOutcome;
  /** `typesense_sync_state` — the alias points at the schema-current build. */
  alias_current?: boolean;
  /** `typesense_sync_state` — consecutive builds since the last promotion. */
  reindex_attempts?: number;
  /** `typesense_sync_state` — documents written since the last reindex. */
  updates?: number;
  [key: string]: unknown;
}

/**
 * Zod schema for {@link TypesenseEventLogRecord}.
 *
 * ⚠️ **The four `typesense_sync_state` fields are declared rather than left to
 * `.passthrough()`, and that is the point of declaring them.** An alert keys on
 * `reindex_attempts`, so it must key on a field something constrains: passthrough
 * would let a float or a string reach the rule, which then compares silently and
 * wrongly. They stay OPTIONAL because this archetype absorbs 23 msgs and only one
 * of them carries these — the constraint is on the shape when present, not on
 * every record.
 */
export const TypesenseEventLogRecordSchema: z.ZodType<TypesenseEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(TYPESENSE_EVENT_MSGS),
  collection: z.string().optional(),
  typesense_collection: z.string().optional(),
  document_id: z.string().optional(),
  outcome: z.enum(TYPESENSE_SYNC_OUTCOMES).optional(),
  alias_current: z.boolean().optional(),
  reindex_attempts: z.int().min(0).optional(),
  updates: z.int().min(0).optional(),
}).passthrough().meta({ title: "TypesenseEventLogRecord" });
