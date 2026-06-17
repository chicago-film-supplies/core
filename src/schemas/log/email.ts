/**
 * Outbound-email log records — emitted by `src/lib/email.ts` in
 * api-cloudrun around the Resend REST call.
 *
 * Empirically (2026-05-27 obs sweep) these `msg` values did NOT fire over
 * a 14-day window in either env, so the leak path is theoretical today.
 * Tagged conservatively anyway so when traffic ramps post-launch the
 * masking is already in place — recipient addresses (`to`), subjects,
 * and the full Resend error response body all carry user-facing
 * identifiers when they appear.
 *
 * `to` is the recipient address (PII — mask).
 * `subject` may carry account / order context (mask).
 * `body` (Resend error response) may echo the recipient or other
 *     account data (redact — debugging value is low, exposure surface
 *     is high).
 * `email_from` is one of the CFS-controlled sender addresses
 *     (`verify@…`, `reset@…`, `invite@…`, `alerts@…`) — not PII.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Structured log entry for a failed outbound email. */
export interface EmailSendFailedLogRecord {
  level: LogLevelType;
  msg: "email_send_failed";
  ts: string;
  status: number;
  body?: string;
  email_from: string;
  to?: string;
  subject?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link EmailSendFailedLogRecord}. */
export const EmailSendFailedLogRecordSchema: z.ZodType<EmailSendFailedLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("email_send_failed"),
  status: z.number(),
  // Full Resend error response — may echo the recipient address.
  body: z.string().max(2048).meta({ pii: "redact" }).optional(),
  email_from: z.string(),
  // Recipient address — partial mask preserves debuggability without exposure.
  to: z.string().meta({ pii: "mask" }).optional(),
  // Subject may carry order numbers, account hints — mask defensively.
  subject: z.string().max(200).meta({ pii: "mask" }).optional(),
}).passthrough().meta({ title: "EmailSendFailedLogRecord" });

/** Structured log entry for a successful outbound email. */
export interface EmailSentLogRecord {
  level: LogLevelType;
  msg: "email_sent";
  ts: string;
  email_from: string;
  to?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link EmailSentLogRecord}. */
export const EmailSentLogRecordSchema: z.ZodType<EmailSentLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("email_sent"),
  email_from: z.string(),
  to: z.string().meta({ pii: "mask" }).optional(),
}).passthrough().meta({ title: "EmailSentLogRecord" });
