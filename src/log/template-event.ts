/**
 * Template / golden-diff / template-comment archetype — every msg emitted
 * from the templates service (`src/services/templates/`,
 * `src/lib/templates/`, comment-sync) and the golden-diff verifier.
 *
 * **PII posture**: none. Template uids, branch names, PR numbers,
 * commit shas, and OIDC subjects are not PII.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const TEMPLATE_EVENT_MSGS = [
  "fixture_saved",
  "fixture_deleted",
  "template_abandon_close_pr_failed",
  "template_component_file_missing",
  "template_component_no_content",
  "template_component_sidecar_parse_failed",
  "template_metadata_pr_opened",
  "template_metadata_close_pr_failed",
  "template_metadata_automerge_unavailable",
  "template_preview_store_failed",
  "template_preview_stored",
  "template_publish_affected",
  "template_publish_base_ref_rejected",
  "template_publish_no_merge_sha",
  "template_publish_noop",
  "template_publish_skipped_no_app",
  "template_publish_unknown_component",
  "template_rebuild_from_git",
  "template_release_auto_merge_failed",
  "template_render_config_parse_failed",
  "template_sandbox_diverged",
  "template_sandbox_fast_forwarded",
  "template_sandbox_force_resynced",
  "template_sync_skipped_no_app",
  "get_quote_template_failed",
  "golden_diff_oidc_identity_rejected",
  "golden_diff_oidc_unconfigured",
  "golden_diff_oidc_verify_failed",
  "golden_diff_result",
  "golden_verdict_persist_failed",
  "github_templates_no_merge_sha",
  "github_templates_publish_failed",
  "comment_sync_awaiting_create",
  "comment_sync_github_unconfigured",
  "comment_sync_no_pr",
  "comment_sync_posted",
] as const;

/** Discriminated msg union for Template-archetype log records. */
export type TemplateEventMsg = (typeof TEMPLATE_EVENT_MSGS)[number];

/** Structured log entry for any template / golden-diff event. */
export interface TemplateEventLogRecord {
  level: LogLevelType;
  msg: TemplateEventMsg;
  ts: string;
  template_uid?: string;
  template_version_uid?: string;
  branch?: string;
  pr_number?: number;
  commit_sha?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link TemplateEventLogRecord}. */
export const TemplateEventLogRecordSchema: z.ZodType<TemplateEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(TEMPLATE_EVENT_MSGS),
  template_uid: z.string().optional(),
  template_version_uid: z.string().optional(),
  branch: z.string().optional(),
  pr_number: z.number().optional(),
  commit_sha: z.string().optional(),
}).passthrough().meta({ title: "TemplateEventLogRecord" });
