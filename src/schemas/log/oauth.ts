/**
 * OAuth-refresh log record — emitted by integration token managers
 * (Xero, CRMS, Gmail) when refreshing access tokens.
 *
 * Common shape across services (28k+ records in prod over 4 days per the
 * 2026-05-27 obs sweep, indicating it's hot on the periodic refresh
 * path). `grant_type`, `expires_in`, `scope`, `token_type`,
 * `token_age_hours` are OAuth metadata — none PII. The actual
 * `access_token` / `refresh_token` values do NOT appear in logs today
 * (confirmed by the obs sweep) and never should — the runtime denylist
 * defends against future regressions.
 *
 * `refreshed_at_debug` is the documented `_debug` suffix convention
 * (intentionally in logs for ops correlation; outside the runtime
 * denylist's scope).
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Structured log entry for an OAuth token refresh. */
export interface OAuthRefreshLogRecord {
  level: LogLevelType;
  msg: "oauth_refresh";
  ts: string;
  service: string;
  grant_type?: string;
  scope?: string;
  token_type?: string;
  expires_in?: number;
  token_age_hours?: number;
  refreshed_at_debug?: string;
  recovered?: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link OAuthRefreshLogRecord}. */
export const OAuthRefreshLogRecordSchema: z.ZodType<OAuthRefreshLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("oauth_refresh"),
  service: z.string(),
  grant_type: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  token_age_hours: z.number().optional(),
  refreshed_at_debug: z.string().optional(),
  recovered: z.boolean().optional(),
}).passthrough().meta({ title: "OAuthRefreshLogRecord" });
