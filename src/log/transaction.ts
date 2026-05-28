/**
 * Firestore transaction commit log record — emitted once per
 * `db.runTransaction` invocation by `src/lib/instrumentedTransaction.ts` in
 * api-cloudrun, capturing per-collection write counts, estimated JSON
 * bytes, and (on failure) the error.
 *
 * `error_message` and `error_stack` carry empirical length caps:
 * `error_stack` is on 50–82% of all log records in production
 * (`typesense_sync_check_failed` retry storms — verified 2026-05-27);
 * unbounded stacks are an ingest-cost / cardinality risk regardless of
 * PII. Caps are conservative — they preserve the top of the stack which
 * is what diagnoses the failure, drop the deep-framework noise.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

const TRANSACTION_STATUSES = ["completed", "failed"] as const;

/** Status outcome of a Firestore transaction commit. */
export type TransactionStatusType = (typeof TRANSACTION_STATUSES)[number];

/** Structured log entry for a single Firestore transaction commit (success or failure). */
export interface TransactionLogRecord {
  level: LogLevelType;
  msg: "transaction";
  ts: string;
  tx_name: string;
  status: TransactionStatusType;
  duration_ms: number;
  write_count: number;
  target_counts: Record<string, number>;
  estimated_json_bytes: number;
  sample_doc_paths: string[];
  error_name?: string;
  error_message?: string;
  error_stack?: string;
  aborted?: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  dry_run?: boolean;
  [key: string]: unknown;
}

/** Zod schema for {@link TransactionLogRecord}. */
export const TransactionLogRecordSchema: z.ZodType<TransactionLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("transaction"),
  tx_name: z.string(),
  status: z.enum(TRANSACTION_STATUSES),
  duration_ms: z.number(),
  write_count: z.number(),
  target_counts: z.record(z.string(), z.number()),
  estimated_json_bytes: z.number(),
  sample_doc_paths: z.array(z.string()).max(10),
  error_name: z.string().max(200).optional(),
  error_message: z.string().max(500).optional(),
  error_stack: z.string().max(2048).optional(),
  aborted: z.boolean().optional(),
}).passthrough().meta({ title: "TransactionLogRecord" });
