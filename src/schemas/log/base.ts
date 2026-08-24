/**
 * Shared envelope fields spread into every typed log record arm.
 *
 * Centralizes the per-record overhead (level, ts, correlation IDs, route
 * metadata, user_id) so each archetype schema declares only its
 * msg-specific payload + msg literal.
 *
 * `user_id` carries `pii: "none"` by design — opaque internal Firestore
 * uids are not hashed in logs. Rationale:
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
 * `error_name` / `error_message` / `error_stack` are LOGGER-SUPPLIED, not
 * caller-supplied: `logError(msg, err, fields)` decomposes the Error itself, so
 * any arm reachable through that shim carries them whether or not it declares
 * them. They live here for that reason — the same one `subject` gives.
 *
 * ⚠️ **Their absence from the envelope was minting synonyms.** Only `sync` and
 * `transaction` declared them, so five other msgs settled on a *different* name
 * for the same value: measured against prod over 90 days, `error` 720 records
 * against `error_message`'s 20,326, with every one of the five assigning
 * `err.message` to it. Declaring `error` on those arms would have blessed the
 * drift in the schema; promoting the real name here is what makes the rename
 * available to them instead.
 *
 * The caps are the empirical ones both prior declarations already used (200 /
 * 500 / 2048) — `error_stack` rides 50–82% of production records, so this is a
 * cost bound, not a validation nicety.
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
 *
 * ⚠️ **The annotation is required, not decorative.** Without it JSR's syntactic
 * declaration emitter has twelve Zod expressions it cannot write down — the
 * same class that published `readonly parentable_by;` with no type at all from
 * `schemas/common.ts` (core#44). Deriving it from {@link BaseLogFields} rather
 * than hand-listing twelve Zod types is what stops the two drifting: `-?` makes
 * every key REQUIRED here, so a field added to the interface and forgotten in
 * this object is a compile error, while the indexed access keeps `| undefined`
 * for the optional ones so `.optional()` still type-checks.
 */
export const baseLogFields: {
  readonly [K in keyof BaseLogFields]-?: z.ZodType<BaseLogFields[K]>;
} = {
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
  error_name: z.string().max(200).optional(),
  error_message: z.string().max(500).optional(),
  error_stack: z.string().max(2048).optional(),
};

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
  error_name?: string;
  error_message?: string;
  error_stack?: string;
}
