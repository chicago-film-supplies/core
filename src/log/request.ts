/**
 * HTTP request summary log record — one per request, emitted by
 * `src/middleware/logging.ts` in api-cloudrun after the response is sent.
 *
 * Skips `/health` to avoid load-balancer noise. Carries no PII directly;
 * the envelope's `user_id` (from session, populated via AsyncLocalStorage)
 * is the only user identifier and is intentionally retained raw (see
 * `./base.ts` for the GDPR / SOC 2 rationale).
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Structured log entry for a completed HTTP request. */
export interface RequestLogRecord {
  level: LogLevelType;
  msg: "request";
  ts: string;
  route: string;
  status: number;
  duration_ms: number;
  request_id?: string;
  method?: string;
  path?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  dry_run?: boolean;
  [key: string]: unknown;
}

/** Zod schema for {@link RequestLogRecord}. */
export const RequestLogRecordSchema: z.ZodType<RequestLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("request"),
  route: z.string(),
  status: z.number(),
  duration_ms: z.number(),
}).passthrough().meta({ title: "RequestLogRecord" });
