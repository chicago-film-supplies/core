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

// ── Phase 3 archetypes (one schema per family; many msgs each) ──────

export {
  ACCESS_CONTROL_EVENT_MSGS,
  AccessControlEventLogRecordSchema,
  type AccessControlEventLogRecord,
  type AccessControlEventMsg,
} from "./access-control-event.ts";
export {
  CALENDAR_EVENT_MSGS,
  CalendarEventLogRecordSchema,
  type CalendarEventLogRecord,
  type CalendarEventMsg,
} from "./calendar-event.ts";
export {
  CLOUD_TASK_EVENT_MSGS,
  CloudTaskEventLogRecordSchema,
  type CloudTaskEventLogRecord,
  type CloudTaskEventMsg,
} from "./cloud-task-event.ts";
export {
  DOMAIN_EVENT_MSGS,
  DomainEventLogRecordSchema,
  type DomainEventLogRecord,
  type DomainEventMsg,
} from "./domain-event.ts";
export {
  INTEGRATION_EVENT_MSGS,
  IntegrationEventLogRecordSchema,
  type IntegrationEventLogRecord,
  type IntegrationEventMsg,
} from "./integration-event.ts";
export {
  MCP_EVENT_MSGS,
  McpEventLogRecordSchema,
  type McpEventLogRecord,
  type McpEventMsg,
} from "./mcp-event.ts";
export {
  OAUTH_EVENT_MSGS,
  OAuthEventLogRecordSchema,
  type OAuthEventLogRecord,
  type OAuthEventMsg,
} from "./oauth-event.ts";
export {
  SYSTEM_EVENT_MSGS,
  SystemEventLogRecordSchema,
  type SystemEventLogRecord,
  type SystemEventMsg,
} from "./system-event.ts";
export {
  TEMPLATE_EVENT_MSGS,
  TemplateEventLogRecordSchema,
  type TemplateEventLogRecord,
  type TemplateEventMsg,
} from "./template-event.ts";
export {
  TYPESENSE_EVENT_MSGS,
  TypesenseEventLogRecordSchema,
  type TypesenseEventLogRecord,
  type TypesenseEventMsg,
} from "./typesense-event.ts";
export {
  USER_SESSION_EVENT_MSGS,
  UserSessionEventLogRecordSchema,
  type UserSessionEventLogRecord,
  type UserSessionEventMsg,
} from "./user-session-event.ts";
export {
  XERO_EVENT_MSGS,
  XeroEventLogRecordSchema,
  type XeroEventLogRecord,
  type XeroEventMsg,
} from "./xero-event.ts";

// ── Discriminated union over typed arms ─────────────────────────────

import { DmarcAggregateLogRecordSchema } from "./dmarc.ts";
import { EmailSendFailedLogRecordSchema, EmailSentLogRecordSchema } from "./email.ts";
import { OAuthRefreshLogRecordSchema } from "./oauth.ts";
import { PropagationLogRecordSchema } from "./propagation.ts";
import { RequestLogRecordSchema } from "./request.ts";
import { SyncErrorLogRecordSchema } from "./sync.ts";
import { TransactionLogRecordSchema } from "./transaction.ts";
import { ValidationErrorLogRecordSchema } from "./validation.ts";

import {
  ACCESS_CONTROL_EVENT_MSGS as ACCESS_MSGS,
  AccessControlEventLogRecordSchema,
} from "./access-control-event.ts";
import {
  CALENDAR_EVENT_MSGS as CALENDAR_MSGS,
  CalendarEventLogRecordSchema,
} from "./calendar-event.ts";
import {
  CLOUD_TASK_EVENT_MSGS as CLOUD_MSGS,
  CloudTaskEventLogRecordSchema,
} from "./cloud-task-event.ts";
import {
  DOMAIN_EVENT_MSGS as DOMAIN_MSGS,
  DomainEventLogRecordSchema,
} from "./domain-event.ts";
import {
  INTEGRATION_EVENT_MSGS as INTEGRATION_MSGS,
  IntegrationEventLogRecordSchema,
} from "./integration-event.ts";
import {
  MCP_EVENT_MSGS as MCP_MSGS,
  McpEventLogRecordSchema,
} from "./mcp-event.ts";
import {
  OAUTH_EVENT_MSGS as OAUTH_MSGS,
  OAuthEventLogRecordSchema,
} from "./oauth-event.ts";
import {
  SYSTEM_EVENT_MSGS as SYSTEM_MSGS,
  SystemEventLogRecordSchema,
} from "./system-event.ts";
import {
  TEMPLATE_EVENT_MSGS as TEMPLATE_MSGS,
  TemplateEventLogRecordSchema,
} from "./template-event.ts";
import {
  TYPESENSE_EVENT_MSGS as TYPESENSE_MSGS,
  TypesenseEventLogRecordSchema,
} from "./typesense-event.ts";
import {
  USER_SESSION_EVENT_MSGS as USER_SESSION_MSGS,
  UserSessionEventLogRecordSchema,
} from "./user-session-event.ts";
import {
  XERO_EVENT_MSGS as XERO_MSGS,
  XeroEventLogRecordSchema,
} from "./xero-event.ts";

import type { DmarcAggregateLogRecord } from "./dmarc.ts";
import type { EmailSendFailedLogRecord, EmailSentLogRecord } from "./email.ts";
import type { OAuthRefreshLogRecord } from "./oauth.ts";
import type { PropagationLogRecord } from "./propagation.ts";
import type { RequestLogRecord } from "./request.ts";
import type { SyncErrorLogRecord } from "./sync.ts";
import type { TransactionLogRecord } from "./transaction.ts";
import type { ValidationErrorLogRecord } from "./validation.ts";

import type { AccessControlEventLogRecord } from "./access-control-event.ts";
import type { CalendarEventLogRecord } from "./calendar-event.ts";
import type { CloudTaskEventLogRecord } from "./cloud-task-event.ts";
import type { DomainEventLogRecord } from "./domain-event.ts";
import type { IntegrationEventLogRecord } from "./integration-event.ts";
import type { McpEventLogRecord } from "./mcp-event.ts";
import type { OAuthEventLogRecord } from "./oauth-event.ts";
import type { SystemEventLogRecord } from "./system-event.ts";
import type { TemplateEventLogRecord } from "./template-event.ts";
import type { TypesenseEventLogRecord } from "./typesense-event.ts";
import type { UserSessionEventLogRecord } from "./user-session-event.ts";
import type { XeroEventLogRecord } from "./xero-event.ts";

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
  | ValidationErrorLogRecord
  // Phase 3 archetypes (one type per family; each arm's `msg` is a
  // union of the family's literals — TS narrows to family shape).
  | AccessControlEventLogRecord
  | CalendarEventLogRecord
  | CloudTaskEventLogRecord
  | DomainEventLogRecord
  | IntegrationEventLogRecord
  | McpEventLogRecord
  | OAuthEventLogRecord
  | SystemEventLogRecord
  | TemplateEventLogRecord
  | TypesenseEventLogRecord
  | UserSessionEventLogRecord
  | XeroEventLogRecord;

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
  // Phase 0 — per-msg schemas (one msg literal, one schema arm)
  ["dmarc_aggregate_record", DmarcAggregateLogRecordSchema as z.ZodType],
  ["email_send_failed", EmailSendFailedLogRecordSchema as z.ZodType],
  ["email_sent", EmailSentLogRecordSchema as z.ZodType],
  ["oauth_refresh", OAuthRefreshLogRecordSchema as z.ZodType],
  ["propagation", PropagationLogRecordSchema as z.ZodType],
  ["request", RequestLogRecordSchema as z.ZodType],
  ["sync_error", SyncErrorLogRecordSchema as z.ZodType],
  ["transaction", TransactionLogRecordSchema as z.ZodType],
  ["validation_error", ValidationErrorLogRecordSchema as z.ZodType],
  // Phase 3 — archetype schemas (many msg literals share one schema arm)
  ...ACCESS_MSGS.map((m) => [m, AccessControlEventLogRecordSchema as z.ZodType] as const),
  ...CALENDAR_MSGS.map((m) => [m, CalendarEventLogRecordSchema as z.ZodType] as const),
  ...CLOUD_MSGS.map((m) => [m, CloudTaskEventLogRecordSchema as z.ZodType] as const),
  ...DOMAIN_MSGS.map((m) => [m, DomainEventLogRecordSchema as z.ZodType] as const),
  ...INTEGRATION_MSGS.map((m) => [m, IntegrationEventLogRecordSchema as z.ZodType] as const),
  ...MCP_MSGS.map((m) => [m, McpEventLogRecordSchema as z.ZodType] as const),
  ...OAUTH_MSGS.map((m) => [m, OAuthEventLogRecordSchema as z.ZodType] as const),
  ...SYSTEM_MSGS.map((m) => [m, SystemEventLogRecordSchema as z.ZodType] as const),
  ...TEMPLATE_MSGS.map((m) => [m, TemplateEventLogRecordSchema as z.ZodType] as const),
  ...TYPESENSE_MSGS.map((m) => [m, TypesenseEventLogRecordSchema as z.ZodType] as const),
  ...USER_SESSION_MSGS.map((m) => [m, UserSessionEventLogRecordSchema as z.ZodType] as const),
  ...XERO_MSGS.map((m) => [m, XeroEventLogRecordSchema as z.ZodType] as const),
]);
