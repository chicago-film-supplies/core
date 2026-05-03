/**
 * Log record schema — defines the structured log envelope.
 *
 * Every structured log emitted by the API matches this schema.
 * `.passthrough()` allows per-call data fields beyond the envelope.
 */
import { z } from "zod";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
/** Log severity level. */
export type LogLevelType = typeof LOG_LEVELS[number];

/** Structured log envelope emitted by the API. */
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

/** Zod schema for LogRecord. */
export const LogRecordSchema: z.ZodType<LogRecord> = z.object({
  level: z.enum(LOG_LEVELS),
  msg: z.string(),
  ts: z.string(),
  request_id: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  route: z.string().optional(),
  user_id: z.string().meta({ pii: "hash" }).optional(),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  duration_ms: z.number().optional(),
  dry_run: z.boolean().optional(),
}).passthrough().meta({ title: "LogRecord" });

// ── Propagation log record ──────────────────────────────────────────

const PROPAGATION_MODES = ["embed", "fan-out", "co-write", "derive", "reference"] as const;
const PROPAGATION_STATUSES = ["completed", "skipped", "failed"] as const;

/** Status outcome of a propagation rule execution. */
export type PropagationStatusType = typeof PROPAGATION_STATUSES[number];
/** Propagation strategy used by a rule. */
export type PropagationModeType = typeof PROPAGATION_MODES[number];

/** Structured log entry for a single propagation rule execution. */
export interface PropagationLogRecord {
  level: LogLevelType;
  msg: "propagation";
  ts: string;
  rule_id: string;
  source: string;
  target: string;
  mode: PropagationModeType;
  transaction?: string;
  fields_mapped: number;
  source_doc_id?: string;
  target_doc_id?: string;
  status: PropagationStatusType;
  duration_ms?: number;
  error?: string;
  rules_fired?: string[];
  rules_fired_count?: number;
  rules_expected?: number;
  target_counts?: Record<string, number>;
  target_count?: number;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for PropagationLogRecord. */
export const PropagationLogRecordSchema: z.ZodType<PropagationLogRecord> = z.object({
  level: z.enum(LOG_LEVELS),
  msg: z.literal("propagation"),
  ts: z.string(),
  rule_id: z.string(),
  source: z.string(),
  target: z.string(),
  mode: z.enum(PROPAGATION_MODES),
  transaction: z.string().optional(),
  fields_mapped: z.number(),
  source_doc_id: z.string().optional(),
  target_doc_id: z.string().optional(),
  status: z.enum(PROPAGATION_STATUSES),
  duration_ms: z.number().optional(),
  error: z.string().optional(),
  rules_fired: z.array(z.string()).optional(),
  rules_fired_count: z.number().optional(),
  rules_expected: z.number().optional(),
  target_counts: z.record(z.string(), z.number()).optional(),
  target_count: z.number().optional(),
  request_id: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  route: z.string().optional(),
  user_id: z.string().meta({ pii: "hash" }).optional(),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
}).passthrough().meta({ title: "PropagationLogRecord" });

// ── Transaction commit log record ────────────────────────────────────

const TRANSACTION_STATUSES = ["completed", "failed"] as const;

/** Status outcome of a Firestore transaction commit. */
export type TransactionStatusType = typeof TRANSACTION_STATUSES[number];

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
  dry_run?: boolean;
  [key: string]: unknown;
}

/** Zod schema for TransactionLogRecord. */
export const TransactionLogRecordSchema: z.ZodType<TransactionLogRecord> = z.object({
  level: z.enum(LOG_LEVELS),
  msg: z.literal("transaction"),
  ts: z.string(),
  tx_name: z.string(),
  status: z.enum(TRANSACTION_STATUSES),
  duration_ms: z.number(),
  write_count: z.number(),
  target_counts: z.record(z.string(), z.number()),
  estimated_json_bytes: z.number(),
  sample_doc_paths: z.array(z.string()).max(10),
  error_name: z.string().optional(),
  error_message: z.string().optional(),
  error_stack: z.string().optional(),
  request_id: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  route: z.string().optional(),
  user_id: z.string().meta({ pii: "hash" }).optional(),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  dry_run: z.boolean().optional(),
}).passthrough().meta({ title: "TransactionLogRecord" });

// ── Client log record ────────────────────────────────────────────────

const CLIENT_APPS = ["manager"] as const;
/** Identifier for a client application that emits logs. */
export type ClientAppType = typeof CLIENT_APPS[number];

/** A single log entry sent from a client application. */
export interface ClientLogEntry {
  level: LogLevelType;
  msg: string;
  ts: string;
  app: ClientAppType;
  page?: string;
  request_id?: string;
  data?: Record<string, unknown>;
}

/** Zod schema for ClientLogEntry. */
export const ClientLogEntrySchema: z.ZodType<ClientLogEntry> = z.object({
  level: z.enum(LOG_LEVELS),
  msg: z.string().max(100),
  ts: z.iso.datetime(),
  app: z.enum(CLIENT_APPS),
  page: z.string().max(500).optional(),
  request_id: z.string().max(100).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** A batch of client log entries submitted in a single request. */
export interface ClientLogBatch {
  logs: ClientLogEntry[];
}

/** Zod schema for ClientLogBatch. */
export const ClientLogBatchSchema: z.ZodType<ClientLogBatch> = z.object({
  logs: z.array(ClientLogEntrySchema).min(1).max(50),
});

// ── PII meta type ───────────────────────────────────────────────────

/**
 * PII classification for schema fields.
 *
 * Optional `.meta({ pii: "..." })` on any zod field:
 * - "none"   — safe field, no processing
 * - "mask"   — partial reveal (emails: j***@example.com, strings: last 4 chars)
 * - "hash"   — deterministic HMAC-SHA256
 * - "redact" — full removal → "[REDACTED]"
 */
export type PiiClassification = "none" | "mask" | "hash" | "redact";
