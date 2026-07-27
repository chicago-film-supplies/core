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
  /**
   * What the transaction READ, in the order it asked — and the only field that can say
   * what it is *stuck on*.
   *
   * `sample_doc_paths` records what it WROTE, which is the wrong set for diagnosing a
   * hang: Firestore takes its pessimistic lock at `tx.get()`, so a blocked transaction
   * is waiting on a READ and has staged no writes at all — which is exactly how
   * api-cloudrun#335 was misdiagnosed twice, in both directions.
   *
   * NOTE this used to add "the write counts accumulate across Firestore's internal
   * contention retries". They do NOT: `runInstrumentedTransaction` re-seeds the
   * accumulator at the top of every attempt (`instrumentedTransaction.ts` —
   * `lastCounts = createEmptyCounts()` inside the `db.runTransaction` callback), so
   * every count on this record describes the LAST attempt alone. Reading the old
   * claim the other way — segmenting failures by `write_count` as if it were a
   * cumulative progress marker — is a live analysis trap (api-cloudrun#358).
   *
   * Entries are appended BEFORE each read is awaited, so on a deadline abort the LAST
   * entry is the read that never returned: the contended document, named. That is what
   * finally identified `counters/transactions`.
   */
  read_paths?: string[];
  /**
   * Read OPERATIONS issued, uncapped — one round trip each, so a `getAll` of 99 refs
   * is 1. The measurement `read_paths` cannot be: that field is a truncated trail
   * whose job is naming the contended doc, and a count derived from it caps at 20,
   * exactly where an N+1 gets interesting.
   */
  read_count?: number;
  /**
   * Read operations per collection — the read-side mirror of `target_counts`, and the
   * field an N+1 assertion should pin. Per-collection, never the total: a transaction's
   * total has a constant floor of unrelated reads and is not invariant by design, so
   * only `read_counts.<collection>` is predictable from a fixture.
   */
  read_counts?: Record<string, number>;
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
  read_paths: z.array(z.string()).max(20).optional(),
  read_count: z.number().optional(),
  read_counts: z.record(z.string(), z.number()).optional(),
  error_name: z.string().max(200).optional(),
  error_message: z.string().max(500).optional(),
  error_stack: z.string().max(2048).optional(),
  aborted: z.boolean().optional(),
}).passthrough().meta({ title: "TransactionLogRecord" });
