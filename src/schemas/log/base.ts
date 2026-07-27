/**
 * Shared envelope fields spread into every typed log record arm.
 *
 * Centralizes the per-record overhead (level, ts, correlation IDs, route
 * metadata, user_id) so each archetype schema declares only its
 * msg-specific payload + msg literal.
 *
 * `user_id` carries `pii: "none"` by design — opaque internal Firestore
 * uids are not hashed in logs. Rationale (settled in the logger PII
 * planning session, see `.claude/HANDOFF-logger-pii-typed-records.md` in
 * api-cloudrun):
 *
 * - **GDPR**: hashing with a key the controller retains is *pseudonymization*
 *   (Recital 26 + Art 4(5)), not anonymization — stays in scope. The real
 *   compliance levers are retention (Art 5(1)(e)) and a redact-by-user_id
 *   workflow for DSAR (Art 17).
 * - **SOC 2**: raw user attribution is generally *expected* by auditors
 *   (CC6.1, CC7.2, CC7.3); hashing hurts incident-response forensics.
 * - **Operationally**: hashing breaks `user_id:"..."` LogsQL queries
 *   documented in api-cloudrun CLAUDE.md.
 *
 * If compliance posture changes, retag here once and every arm inherits.
 *
 * `subject` is the namespaced id of the *thing a request is about* — the
 * external or domain identifier that no read/write trail can ever carry because
 * it is not a Firestore document (`crms_opportunity:1234`, `xero_invoice:…`).
 * It lives on the envelope precisely so it rides EVERY record a request emits —
 * `transaction`, `sync_error`, `retry_attempt`, the request summary — from one
 * adoption point rather than 91 call sites. Also `pii: "none"`: these are
 * opaque third-party record ids, not personal data, and the whole value is that
 * `subject:"…"` is directly queryable in LogsQL.
 */

import { z } from "zod";

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** Log severity level. */
export type LogLevelType = (typeof LOG_LEVELS)[number];

/** Zod enum for log levels — exported for reuse in arm schemas. */
export const LogLevelEnum: z.ZodType<LogLevelType> = z.enum(LOG_LEVELS);

/**
 * Common envelope fields shared by every typed log record arm.
 * Spread via `...baseLogFields` in each archetype schema.
 */
export const baseLogFields = {
  level: LogLevelEnum,
  ts: z.string(),
  request_id: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  route: z.string().optional(),
  user_id: z.string().meta({
    pii: "none",
    note: "opaque internal id; retention-bounded; redactable on DSAR",
  }).optional(),
  subject: z.string().meta({
    pii: "none",
    note: "namespaced id of the thing a request is about, e.g. crms_opportunity:1234",
  }).optional(),
  trace_id: z.string().optional(),
  span_id: z.string().optional(),
  duration_ms: z.number().optional(),
  dry_run: z.boolean().optional(),
} as const;

/**
 * TypeScript shape of {@link baseLogFields} — for use in archetype
 * interfaces that want to declare the envelope explicitly.
 */
export interface BaseLogFields {
  level: LogLevelType;
  ts: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  subject?: string;
  trace_id?: string;
  span_id?: string;
  duration_ms?: number;
  dry_run?: boolean;
}
