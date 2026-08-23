/**
 * Access-control archetype — role / RBAC / permission events and the
 * preview-role self-healing lifecycle. Touches user identity by uid.
 *
 * **PII posture**: `user_id` is `pii: "none"` per the inherited baseLogFields
 * policy (opaque internal id; retention-bounded; redactable on DSAR).
 * No other PII fields at this archetype level.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const ACCESS_CONTROL_EVENT_MSGS = [
  "rbac_registry_drift",
  "rbac_user_missing",
  "role_create_conflict",
  "role_created",
  "role_invalid_permission",
  "role_permission_unknown",
  "role_schema_invalid",
  "role_deleted",
  "role_renamed",
  "role_rename_pointer_sweep_disagreed",
  "role_update_not_found",
  "role_updated",
  "permission_denied",
  "service_oidc_observed",
  "preview_role_self_healed",
  "preview_role_started",
  "preview_role_stopped",
  "preview_role_subset_violation",
] as const;

/** Discriminated msg union for Access-Control-archetype log records. */
export type AccessControlEventMsg = (typeof ACCESS_CONTROL_EVENT_MSGS)[number];

/** Structured log entry for any RBAC / role / preview-role event. */
export interface AccessControlEventLogRecord {
  level: LogLevelType;
  msg: AccessControlEventMsg;
  ts: string;
  role_name?: string;
  permission?: string;
  /** Role rename: the name being moved away from. */
  role_name_old?: string;
  /** Role rename: the name being moved to. */
  role_name_new?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link AccessControlEventLogRecord}. */
export const AccessControlEventLogRecordSchema: z.ZodType<AccessControlEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(ACCESS_CONTROL_EVENT_MSGS),
  role_name: z.string().optional(),
  role_name_old: z.string().optional(),
  role_name_new: z.string().optional(),
  permission: z.string().optional(),
}).passthrough().meta({ title: "AccessControlEventLogRecord" });
