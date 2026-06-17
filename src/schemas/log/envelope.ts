/**
 * Generic log-record envelope — for OpenAPI documentation only.
 *
 * Registered as the `LogRecord` OpenAPI component
 * (`src/app.ts` in api-cloudrun) so consumers of the spec can see the
 * baseline shape every emitted log carries. NOT used for runtime
 * validation: the structured logger does not safeParse against this — it
 * dispatches by msg literal through the typed-record registry
 * (see {@link MSG_SCHEMA_REGISTRY} in `./mod.ts`).
 *
 * Kept `.passthrough()` + index-signature because the spec needs to
 * advertise that per-call data fields beyond the envelope are allowed.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Structured log envelope emitted by the API (OpenAPI shape). */
export interface LogRecord {
  level: LogLevelType;
  msg: string;
  ts: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  duration_ms?: number;
  dry_run?: boolean;
  [key: string]: unknown;
}

/** Zod schema for {@link LogRecord} — generic envelope, OpenAPI-only. */
export const LogRecordSchema: z.ZodType<LogRecord> = z.object({
  ...baseLogFields,
  msg: z.string(),
}).passthrough().meta({ title: "LogRecord" });
