/**
 * Cloud Tasks archetype — emitted by `src/lib/cloudTasks.ts` around queue
 * lifecycle (create / cancel / drain / configuration).
 *
 * **PII posture**: none. Queue names, task ids, document paths are not PII.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const CLOUD_TASK_EVENT_MSGS = [
  "cloud_task_already_exists",
  "cloud_task_cancel_error",
  "cloud_task_cancel_failed",
  "cloud_task_canceled",
  "cloud_task_create_failed",
  "cloud_task_created",
  "cloud_task_not_configured",
  "cloud_task_payload_rejected",
  "cloud_task_sa_unavailable",
] as const;

/** Discriminated msg union for Cloud-Task-archetype log records. */
export type CloudTaskEventMsg = (typeof CLOUD_TASK_EVENT_MSGS)[number];

/** Structured log entry for any Cloud Tasks lifecycle event. */
export interface CloudTaskEventLogRecord {
  level: LogLevelType;
  msg: CloudTaskEventMsg;
  ts: string;
  queue?: string;
  task_name?: string;
  document_path?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link CloudTaskEventLogRecord}. */
export const CloudTaskEventLogRecordSchema: z.ZodType<CloudTaskEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(CLOUD_TASK_EVENT_MSGS),
  queue: z.string().optional(),
  task_name: z.string().optional(),
  document_path: z.string().optional(),
}).passthrough().meta({ title: "CloudTaskEventLogRecord" });
