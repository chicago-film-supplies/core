/**
 * System / lifecycle archetype — process-startup, unhandled errors,
 * health-check failures, retry attempts, dry-run skips, rate-limit
 * rejections, generic validation failures, and the auth-preview-served
 * signal. Catch-all for cross-cutting infrastructure msgs that don't
 * belong to any specific service.
 *
 * **PII posture**: none. Process-level diagnostics.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const SYSTEM_EVENT_MSGS = [
  /**
   * A `GET /db/{collection}` page ended early on the response size budget
   * rather than on `limit`. Carries `collection`, `limit`, `returned`,
   * `budget_chars`, `had_select`.
   *
   * Seam-level rather than MCP-level on purpose: the budget lives in
   * `services/dbRead.ts` and bounds every consumer of that seam — operator
   * scripts and plain HTTP callers as much as the MCP tools.
   */
  "db_page_clipped",
  "dev_guard_skip",
  "dry_run_skip",
  "rate_limit_exceeded",
  "retry_attempt",
  "startup_error",
  /**
   * The process is listening on its port. Carries `boot_ms` — process start to
   * listening, from the runtime's `performance.now()` — and `deno_version`.
   *
   * Exists because a container's boot is invisible otherwise: Cloud Run logs
   * when it starts an instance and when the startup probe passes, but not when
   * the process itself started, so the time cannot be split between the
   * platform and the runtime's module load (api-cloudrun#1324).
   */
  "startup_ready",
  /**
   * A request reached a Cloud Run service whose role does not serve its path —
   * a background route (`/tasks/*`, `/eventarc/mirror`, …) on the user-facing
   * `api` service, or a user-facing route on the `worker`. Carries
   * `service_role` (the service that received it), `route_tier` (the service
   * that should have) and `gate_mode` (`log` serves it anyway, `enforce` 404s).
   *
   * The gate is QoS, not auth, so a misroute is a routing defect rather than an
   * intrusion: it reads zero once every enqueuer and trigger targets the right
   * service, and that zero is what licenses `enforce` (api-cloudrun#1326).
   */
  "service_role_misroute",
  "unhandled_error",
  "health_check_firestore_error",
  "preview_served",
  "validation_failed",
] as const;

/** Discriminated msg union for System-archetype log records. */
export type SystemEventMsg = (typeof SYSTEM_EVENT_MSGS)[number];

/** Structured log entry for any system-lifecycle event. */
export interface SystemEventLogRecord {
  level: LogLevelType;
  msg: SystemEventMsg;
  ts: string;
  attempt?: number;
  boot_ms?: number;
  service_role?: "api" | "worker";
  route_tier?: "api" | "worker";
  gate_mode?: "log" | "enforce";
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link SystemEventLogRecord}. */
export const SystemEventLogRecordSchema: z.ZodType<SystemEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(SYSTEM_EVENT_MSGS),
  attempt: z.number().optional(),
  boot_ms: z.number().optional(),
  service_role: z.enum(["api", "worker"]).optional(),
  route_tier: z.enum(["api", "worker"]).optional(),
  gate_mode: z.enum(["log", "enforce"]).optional(),
}).passthrough().meta({ title: "SystemEventLogRecord" });
