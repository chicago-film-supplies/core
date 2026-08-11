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
  /**
   * RANGE reads per collection — the subset of `read_counts` that took an index-range
   * lock rather than a single-document one, i.e. reads issued against a `Query` or a
   * `CollectionReference` rather than a `DocumentReference`. A `getAll` is N point
   * reads and is correctly excluded.
   *
   * The distinction is the one that decides whether concurrent peers can deadlock.
   * Measured on cfs-dev-3100 2026-08-01: two transactions that both range-read a
   * collection and both write INTO it hold shared range locks they must each upgrade to
   * exclusive, and Firestore resolves that by BLOCKING to the 25s client deadline rather
   * than aborting — so the retry machinery never engages. Two transactions that
   * range-read a collection and write ELSEWHERE both commit in under 600ms.
   *
   * Derived at the read site, deliberately NOT from `read_paths`: that field caps at 20
   * entries and folds repeats, so a counter derived from it would silently stop
   * measuring exactly where the fan-out gets interesting. Same reason `read_count` was
   * split out.
   */
  range_reads?: Record<string, number>;
  /**
   * Collections this transaction both RANGE-READ and WROTE — `keys(range_reads) ∩
   * keys(target_counts)`, and the deadlock-class signature above, named.
   *
   * Non-empty escalates the record to `warn`. The read-side sibling of
   * `WARN_BYTES`/`WARN_WRITES`, and the durable one: a volume threshold has to be
   * re-derived as the corpus grows, while a SHAPE invariant survives untouched.
   *
   * **Emitted on BOTH paths — completed and aborted.** An earlier note here claimed an
   * abort always carries `write_count: 0` and so never reports the field; measured false
   * on prod `cfs-3100` (2026-08-11, 30d): 19 aborted records carry `contended_ranges`, at
   * `write_count: 2`. An abort that names its overlap is the strongest signal the field
   * produces — it identifies what blocked the transaction, not merely what could.
   *
   * It is still a property of the CODE rather than of the traffic, so a successful run of
   * the same path reports the same overlap. Do not read a *quiet* path as a safe one: a
   * fan-out gated on a real field change reports nothing on a run that changes nothing
   * (measured 4 of 19 `crms-member-organization` runs), so an alert keyed on "every run
   * reports it" would be wrong.
   */
  contended_ranges?: string[];
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
  range_reads: z.record(z.string(), z.number()).optional(),
  contended_ranges: z.array(z.string()).max(20).optional(),
  error_name: z.string().max(200).optional(),
  error_message: z.string().max(500).optional(),
  error_stack: z.string().max(2048).optional(),
  aborted: z.boolean().optional(),
}).passthrough().meta({ title: "TransactionLogRecord" });
