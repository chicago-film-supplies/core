/**
 * Sync-error log record — emitted by integration sync paths (Xero, CRMS,
 * Mapbox, etc.) when a non-fatal sync operation fails.
 *
 * Common pattern in api-cloudrun: a webhook handler or scheduled sync
 * catches a per-document failure, records it via `logError("sync_error",
 * err, { sync_service, document_path, operation })`, and continues with
 * the next document. The aggregator alert
 * (`infra/observability/vmalert/rules.yml`) groups these by `sync_service`
 * for alerting.
 *
 * `error_message` / `error_stack` carry length caps for the same
 * cost/cardinality reason as in `./transaction.ts`.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Structured log entry for a sync-pipeline failure. */
export interface SyncErrorLogRecord {
  level: LogLevelType;
  msg: "sync_error";
  ts: string;
  sync_service: string;
  document_path?: string;
  operation?: string;
  error_name?: string;
  error_message?: string;
  error_stack?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link SyncErrorLogRecord}. */
export const SyncErrorLogRecordSchema: z.ZodType<SyncErrorLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("sync_error"),
  sync_service: z.string(),
  document_path: z.string().optional(),
  operation: z.string().optional(),
  error_name: z.string().max(200).optional(),
  error_message: z.string().max(500).optional(),
  error_stack: z.string().max(2048).optional(),
}).passthrough().meta({ title: "SyncErrorLogRecord" });
