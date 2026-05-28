/**
 * User-session archetype — invite lifecycle, session preload / replacement,
 * and Turnstile (Cloudflare CAPTCHA) verification. Closest archetype to
 * user identity events; reserved for adding PII tags in a follow-up if
 * obs surfaces issues.
 *
 * **PII posture**: `user_id` is `pii: "none"` (inherited). The msgs in
 * this set don't currently emit email/phone/name in their data payloads
 * (verified in source). Reserving the archetype boundary so future
 * additions can be tagged here without spreading PII concerns across the
 * generic catch-all.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const USER_SESSION_EVENT_MSGS = [
  "invite_accepted",
  "invite_created",
  "invite_preview",
  "session_replaced_on_invite_accept",
  "session_user_preload",
  "turnstile_verification_failed",
] as const;

/** Discriminated msg union for User-Session-archetype log records. */
export type UserSessionEventMsg = (typeof USER_SESSION_EVENT_MSGS)[number];

/** Structured log entry for any user-session / invite / turnstile event. */
export interface UserSessionEventLogRecord {
  level: LogLevelType;
  msg: UserSessionEventMsg;
  ts: string;
  invite_uid?: string;
  session_uid?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link UserSessionEventLogRecord}. */
export const UserSessionEventLogRecordSchema: z.ZodType<UserSessionEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(USER_SESSION_EVENT_MSGS),
  invite_uid: z.string().optional(),
  session_uid: z.string().optional(),
}).passthrough().meta({ title: "UserSessionEventLogRecord" });
