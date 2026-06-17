/**
 * OAuth / token-lifecycle archetype.
 *
 * Absorbs every msg related to OAuth token issuance, refresh, expiry,
 * MCP-client OAuth flows, and per-integration token-exchange failures
 * (Xero, CRMS, Gmail/DMARC). Generalizes the per-msg `OAuthRefreshLogRecord`
 * (which stays in the registry pointing the canonical `oauth_refresh` arm).
 *
 * **PII posture**: no fields are tagged. Tokens (access/refresh) and
 * client secrets never appear in logs today (verified via the 2026-05-27
 * obs sweep) and the runtime denylist (`access_token`, `refresh_token`,
 * `client_secret`, `bearer`) defends against accidental future emission.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const OAUTH_EVENT_MSGS = [
  "oauth_401_retry",
  "oauth_alert_email_failed",
  "oauth_refresh_attempt",
  "oauth_refresh_chain_broken",
  "oauth_refresh_failed_response",
  "oauth_refresh_scheduled",
  "oauth_refresh_stale_task",
  "oauth_token_exchanged",
  "oauth_token_expired",
  "oauth_token_expired_refreshing",
  "oauth_token_refresh_skipped",
  "oauth_token_refreshed",
  "oauth_token_response",
  "mcp_oauth_authorize_staged",
  "mcp_oauth_client_registered",
  "mcp_oauth_code_consume_failed",
  "mcp_oauth_consent_approved",
  "mcp_oauth_consent_denied",
  "mcp_oauth_scope_denied",
  "mcp_oauth_token_invalid",
  "mcp_oauth_token_minted",
  "mcp_oauth_user_missing",
  "token_refresh_failed",
  "crms_token_exchange_failed",
  "xero_token_exchange_failed",
] as const;

/** Discriminated msg union for OAuth-archetype log records. */
export type OAuthEventMsg = (typeof OAUTH_EVENT_MSGS)[number];

/** Structured log entry for any OAuth / token-lifecycle event. */
export interface OAuthEventLogRecord {
  level: LogLevelType;
  msg: OAuthEventMsg;
  ts: string;
  service?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link OAuthEventLogRecord}. */
export const OAuthEventLogRecordSchema: z.ZodType<OAuthEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(OAUTH_EVENT_MSGS),
  service: z.string().optional(),
}).passthrough().meta({ title: "OAuthEventLogRecord" });
