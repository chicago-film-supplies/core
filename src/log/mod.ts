/**
 * Structured log record schemas, the discriminated-union surface
 * (`TypedLogRecord`), and the runtime msg→schema registry
 * (`MSG_SCHEMA_REGISTRY`).
 *
 * Phase 0 ships the first ~10 archetype arms (request, propagation,
 * transaction, client, dmarc, sync_error, validation_error,
 * email_send_failed / email_sent, oauth_refresh). The big-bang Phase 3
 * migration adds the remaining ~90 arms as call sites convert; the
 * coverage test in api-cloudrun (`tests/unit/logRecordCoverage.test.ts`,
 * Phase 2) enforces every emitted `msg` literal has a corresponding
 * registry entry.
 *
 * Imported as `@cfs/schemas/log` by api-cloudrun (and re-exported from
 * `@cfs/schemas`).
 */

import type { z } from "zod";

// Generic envelope (OpenAPI-only — registered in api-cloudrun's app.ts).
export { LogRecordSchema, type LogRecord } from "./envelope.ts";

// Shared envelope fields + log-level type.
export { LogLevelEnum, type BaseLogFields, type LogLevelType } from "./base.ts";

// PII vocabulary re-export — kept here for backward compat with the
// pre-split log.ts which exported PiiClassification at this path.
export type { PiiClassification } from "../pii/classification.ts";

// Archetype arms — one file per archetype. Each exports a TS interface +
// a Zod schema. Each is `.passthrough()` for forgiveness during the
// big-bang migration; tighten in a follow-up after Phase 3 lands.
export {
  PropagationLogRecordSchema,
  type PropagationLogRecord,
  type PropagationModeType,
  type PropagationStatusType,
} from "./propagation.ts";

export {
  TransactionLogRecordSchema,
  type TransactionLogRecord,
  type TransactionStatusType,
} from "./transaction.ts";

export {
  ClientLogBatchSchema,
  ClientLogEntrySchema,
  type ClientAppType,
  type ClientLogBatch,
  type ClientLogEntry,
} from "./client.ts";

export {
  RequestLogRecordSchema,
  type RequestLogRecord,
} from "./request.ts";

export {
  DmarcAggregateLogRecordSchema,
  type DmarcAggregateLogRecord,
} from "./dmarc.ts";

export {
  SyncErrorLogRecordSchema,
  type SyncErrorLogRecord,
} from "./sync.ts";

export {
  ValidationErrorLogRecordSchema,
  type ValidationErrorLogRecord,
  type ValidationIssue,
} from "./validation.ts";

export {
  EmailSendFailedLogRecordSchema,
  EmailSentLogRecordSchema,
  type EmailSendFailedLogRecord,
  type EmailSentLogRecord,
} from "./email.ts";

export {
  OAuthRefreshLogRecordSchema,
  type OAuthRefreshLogRecord,
} from "./oauth.ts";

// ── Discriminated union over typed arms ─────────────────────────────

import { DmarcAggregateLogRecordSchema } from "./dmarc.ts";
import { EmailSendFailedLogRecordSchema, EmailSentLogRecordSchema } from "./email.ts";
import { OAuthRefreshLogRecordSchema } from "./oauth.ts";
import { PropagationLogRecordSchema } from "./propagation.ts";
import { RequestLogRecordSchema } from "./request.ts";
import { SyncErrorLogRecordSchema } from "./sync.ts";
import { TransactionLogRecordSchema } from "./transaction.ts";
import { ValidationErrorLogRecordSchema } from "./validation.ts";

import type { DmarcAggregateLogRecord } from "./dmarc.ts";
import type { EmailSendFailedLogRecord, EmailSentLogRecord } from "./email.ts";
import type { OAuthRefreshLogRecord } from "./oauth.ts";
import type { PropagationLogRecord } from "./propagation.ts";
import type { RequestLogRecord } from "./request.ts";
import type { SyncErrorLogRecord } from "./sync.ts";
import type { TransactionLogRecord } from "./transaction.ts";
import type { ValidationErrorLogRecord } from "./validation.ts";

/**
 * Discriminated union of every typed log record, keyed by the `msg`
 * literal. The new `logTyped<R extends TypedLogRecord>` API in
 * api-cloudrun's `src/lib/logger.ts` constrains its argument to this
 * union — TS narrows to the matching arm based on the supplied `msg`,
 * giving compile-time enforcement that every field is correctly named
 * and typed.
 *
 * Adding a new arm requires:
 *   1. Define schema + interface in `./<archetype>.ts`
 *   2. Re-export both above
 *   3. Add to this union
 *   4. Add to {@link MSG_SCHEMA_REGISTRY} below
 *
 * The `log-records.test.ts` coverage test asserts union ↔ registry
 * symmetry so it's impossible to add one without the other.
 */
export type TypedLogRecord =
  | DmarcAggregateLogRecord
  | EmailSendFailedLogRecord
  | EmailSentLogRecord
  | OAuthRefreshLogRecord
  | PropagationLogRecord
  | RequestLogRecord
  | SyncErrorLogRecord
  | TransactionLogRecord
  | ValidationErrorLogRecord;

/**
 * Runtime msg → schema lookup. The structured logger's `emit()` reads
 * `record.msg`, looks up the matching schema here, and (if present)
 * passes the record through the schema-driven PII walker in
 * `@cfs/schemas/pii` before stringification.
 *
 * Records whose `msg` is NOT in this registry fall through to the
 * runtime key-name denylist tier (forward defense). The coverage test
 * in api-cloudrun keeps the registry exhaustive over what the source
 * tree emits.
 */
export const MSG_SCHEMA_REGISTRY: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ["dmarc_aggregate_record", DmarcAggregateLogRecordSchema as z.ZodType],
  ["email_send_failed", EmailSendFailedLogRecordSchema as z.ZodType],
  ["email_sent", EmailSentLogRecordSchema as z.ZodType],
  ["oauth_refresh", OAuthRefreshLogRecordSchema as z.ZodType],
  ["propagation", PropagationLogRecordSchema as z.ZodType],
  ["request", RequestLogRecordSchema as z.ZodType],
  ["sync_error", SyncErrorLogRecordSchema as z.ZodType],
  ["transaction", TransactionLogRecordSchema as z.ZodType],
  ["validation_error", ValidationErrorLogRecordSchema as z.ZodType],
]);
