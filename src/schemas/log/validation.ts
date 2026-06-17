/**
 * Schema-validation failure log record — emitted by
 * `validateBeforeWrite` in api-cloudrun when a Firestore-bound document
 * fails its schema check.
 *
 * The `issues` array mirrors Zod's `error.issues` shape: `path`, `code`,
 * `message`, and (for `unrecognized_keys`) `keys`. Empirically (2026-05-27
 * obs sweep) these issues carry no value echoes — only paths and codes —
 * so the immediate PII risk is low. The structural risk remains for
 * `invalid_value` issue codes and custom refinements that interpolate
 * values into the message; the regex free-text scrub in the logger
 * defends against those.
 *
 * `issues` is capped to defend against pathological validation failures
 * (e.g. a malformed import producing thousands of issues per record).
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Single Zod issue, structurally. */
export interface ValidationIssue {
  path?: (string | number)[];
  code?: string;
  message?: string;
  keys?: string[];
  expected?: string;
  [key: string]: unknown;
}

/** Structured log entry for a schema validation failure. */
export interface ValidationErrorLogRecord {
  level: LogLevelType;
  msg: "validation_error";
  ts: string;
  label: string;
  issues: ValidationIssue[];
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

const ValidationIssueSchema: z.ZodType<ValidationIssue> = z.object({
  path: z.array(z.union([z.string(), z.number()])).optional(),
  code: z.string().optional(),
  message: z.string().max(500).optional(),
  keys: z.array(z.string()).optional(),
  expected: z.string().optional(),
}).passthrough();

/** Zod schema for {@link ValidationErrorLogRecord}. */
export const ValidationErrorLogRecordSchema: z.ZodType<ValidationErrorLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("validation_error"),
  label: z.string(),
  issues: z.array(ValidationIssueSchema).max(50),
}).passthrough().meta({ title: "ValidationErrorLogRecord" });
