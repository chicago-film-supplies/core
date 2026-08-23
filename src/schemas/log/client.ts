/**
 * Browser-emitted log records ingested via `POST /client-logs` and the
 * server-side typed-record shape they're re-emitted as.
 *
 * Three schemas, two directions:
 *
 * **Wire format (manager → api):**
 * - {@link ClientLogEntrySchema} — a single entry in the batch
 * - {@link ClientLogBatchSchema} — the request body shape
 *
 * **Server-emitted format (api → VictoriaLogs):**
 * - {@link ClientLogRecordSchema} — what flows through `MSG_SCHEMA_REGISTRY`
 *   and the PII walker. The api's `api-cloudrun/src/routes/clientLogs.ts` re-emits
 *   each entry via `logTyped({ msg: "client_log", ... })` with the
 *   `entry.data` payload spread to the top level. Common PII-shaped keys
 *   (`email`, `to`, `subject`) are declared here with `pii: "mask"` so
 *   Tier 1 schema-driven scrub partial-masks them
 *   (`alice@example.com → a****@example.com`) instead of falling through
 *   to Tier 2's full redact (`[REDACTED]`). Unknown top-level keys still
 *   fall through to Tier 2 / Tier 3 as forward defense.
 *
 * The `data` field is empirically well-bounded in current logs
 * (auth_phase, page_view, stores_init, listener_error — see obs sweep
 * 2026-05-27) but the schema enforces a defensive cap to prevent a
 * malicious or buggy client from blowing up VictoriaLogs stream
 * cardinality.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType as BaseLogLevelType } from "./base.ts";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
/** Log severity level (re-declared here to keep this file self-contained). */
type LogLevelType = (typeof LOG_LEVELS)[number];

const CLIENT_APPS = ["manager"] as const;
/** Identifier for a client application that emits logs. */
export type ClientAppType = (typeof CLIENT_APPS)[number];

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

/**
 * Zod schema for {@link ClientLogEntry}.
 *
 * The `data` field is capped at 20 top-level keys + 4 KB stringified to
 * defend against runaway client-side payloads. Manager logs in practice
 * carry ≤5 keys and <500 bytes per entry, so this cap is far above the
 * legitimate ceiling.
 */
export const ClientLogEntrySchema: z.ZodType<ClientLogEntry> = z.object({
  level: z.enum(LOG_LEVELS),
  msg: z.string().max(100),
  ts: z.iso.datetime(),
  app: z.enum(CLIENT_APPS),
  page: z.string().max(500).optional(),
  request_id: z.string().max(100).optional(),
  data: z.record(z.string(), z.unknown())
    .refine(
      (d) => Object.keys(d).length <= 20,
      { message: "data must have at most 20 top-level keys" },
    )
    .refine(
      (d) => {
        try { return JSON.stringify(d).length <= 4096; } catch { return false; }
      },
      { message: "data exceeds 4 KB serialized" },
    )
    .optional(),
});

/** A batch of client log entries submitted in a single request. */
export interface ClientLogBatch {
  logs: ClientLogEntry[];
}

/** Zod schema for {@link ClientLogBatch}. */
export const ClientLogBatchSchema: z.ZodType<ClientLogBatch> = z.object({
  logs: z.array(ClientLogEntrySchema).min(1).max(50),
});

// ── Server-emitted form ─────────────────────────────────────────────

/**
 * Server-emitted log record for browser-shipped events.
 *
 * `api-cloudrun/src/routes/clientLogs.ts` re-emits each ingested
 * {@link ClientLogEntry} as `msg: "client_log"` with the wire entry's
 * envelope rewritten into `client_*` namespaced fields (`client_msg`,
 * `client_ts`, `client_level` — to avoid collision with the server
 * envelope's `msg`/`ts`/`level`) and the `data` payload spread to the
 * top level. PII-shaped passthrough keys are declared here with their
 * `pii: "mask"` meta so the schema walker masks them partial-form
 * instead of Tier 2 fully redacting.
 */
export interface ClientLogRecord {
  level: BaseLogLevelType;
  msg: "client_log";
  ts: string;
  source: "browser";
  app: ClientAppType;
  client_msg: string;
  client_ts: string;
  client_level: BaseLogLevelType;
  page?: string;
  request_id?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  // PII-shaped passthrough fields — when these appear at the top level
  // (spread from the wire entry's `data` payload), the schema-driven
  // walker partial-masks them. Unknown keys still flow through and are
  // caught by Tier 2 / Tier 3 as forward defense.
  email?: string;
  to?: string;
  subject?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link ClientLogRecord}. */
export const ClientLogRecordSchema: z.ZodType<ClientLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("client_log"),
  source: z.literal("browser"),
  app: z.enum(CLIENT_APPS),
  client_msg: z.string().max(100),
  client_ts: z.iso.datetime(),
  client_level: z.enum(LOG_LEVELS),
  // Partial-reveal mask. The CFS-owned receiving address pattern
  // (verify@/reset@/invite@/alerts@/...chicagofilmsupplies.com) shows
  // up as the email_from sender and is intentionally left raw on the
  // EmailSent/EmailSendFailed arms; here `email` is whoever the
  // operator is acting ON (e.g. invitee email from the manager's
  // InviteUser flow) — PII.
  email: z.string().meta({ pii: "mask" }).optional(),
  to: z.string().meta({ pii: "mask" }).optional(),
  subject: z.string().meta({ pii: "mask" }).optional(),
}).passthrough().meta({ title: "ClientLogRecord" });
