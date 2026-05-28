/**
 * Browser-emitted log records ingested via `POST /client-logs`.
 *
 * Two schemas:
 * - {@link ClientLogEntrySchema} — a single entry in the batch
 * - {@link ClientLogBatchSchema} — the request body shape
 *
 * The server re-emits each entry as `msg: "client_log"` through the
 * structured logger (see `src/routes/clientLogs.ts` in api-cloudrun). For
 * the server-side typed-record shape — what flows through the registry and
 * the PII walker — see the `client_log` arm to be added when the manager
 * starts pre-scrubbing.
 *
 * The `data` field is empirically well-bounded in current logs
 * (auth_phase, page_view, stores_init, listener_error — see obs sweep
 * 2026-05-27) but the schema enforces a defensive cap to prevent a
 * malicious or buggy client from blowing up VictoriaLogs stream
 * cardinality.
 */

import { z } from "zod";

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
