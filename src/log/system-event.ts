/**
 * System / lifecycle archetype — process-startup, unhandled errors,
 * health-check failures, retry attempts, dry-run skips, generic
 * validation failures, and the auth-preview-served signal. Catch-all
 * for cross-cutting infrastructure msgs that don't belong to any
 * specific service.
 *
 * **PII posture**: none. Process-level diagnostics.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const SYSTEM_EVENT_MSGS = [
  "dev_guard_skip",
  "dry_run_skip",
  "retry_attempt",
  "startup_error",
  "unhandled_error",
  "health_check_firestore_error",
  "preview_served",
  "validation_failed",
] as const;

/** Discriminated msg union for System-archetype log records. */
export type SystemEventMsg = (typeof SYSTEM_EVENT_MSGS)[number];

/** Structured log entry for any system-lifecycle event. */
export interface SystemEventLogRecord {
  level: LogLevelType;
  msg: SystemEventMsg;
  ts: string;
  attempt?: number;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link SystemEventLogRecord}. */
export const SystemEventLogRecordSchema: z.ZodType<SystemEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(SYSTEM_EVENT_MSGS),
  attempt: z.number().optional(),
}).passthrough().meta({ title: "SystemEventLogRecord" });
