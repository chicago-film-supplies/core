/**
 * External-integration archetype — CRMS, Uploadcare, DMARC ingest,
 * Eventarc dispatch, Trello sync, devReplica mirror, draft-quote dispatch,
 * generic sync orchestration, geocoding via Mapbox, and other small
 * pipelines that don't warrant a per-service archetype.
 *
 * **PII posture**: `geocoding_failed` historically passed Mapbox payload
 * fragments that can contain street addresses — handled by Tier 2
 * (`billing_address` denylist key) when the field is named that way, and
 * by Tier 3 free-text scrub for `error_message`. No PII tags at the
 * schema level today.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const INTEGRATION_EVENT_MSGS = [
  "crms_invoice_items_uniqueness_violation",
  "crms_invoice_multidest_flat",
  "crms_invoice_multiple_orders_found",
  "crms_invoice_order_not_found",
  "crms_mark_paid_failed",
  "crms_product_not_found",
  "uploadcare_attachment_cleanup_failed",
  "uploadcare_draft_cleanup_failed",
  "uploadcare_file_not_found",
  "uploadcare_invoice_cleanup_failed",
  "uploadcare_invoice_version_cleanup_failed",
  "uploadcare_metadata_failed",
  "uploadcare_orphan_batch_failed",
  "uploadcare_orphan_cleanup_failed",
  "uploadcare_orphan_sweep_completed",
  "processUpload_delete_original_failed",
  "processUpload_no_file_id",
  "processUpload_skipped",
  "process_upload_failed",
  "dmarc_report_ingest_failed",
  "dmarc_report_processor_run",
  "eventarc_duplicate_event",
  "eventarc_processed",
  "trello_locked",
  "trello_newer_update_detected",
  "trello_no_new_updates",
  "trello_queue_error",
  "mirror_deleted",
  "mirror_failed",
  "mirror_set",
  "mirror_set_failed_terminal",
  "mirror_set_queue_failed",
  "draft_quote_skipped_deleted",
  "draft_quote_skipped_invalid_order",
  "draft_quote_superseded",
  "dns_record_check",
  "dns_record_check_resolve_failed",
  "sync_collection_completed",
  "sync_collection_skipped",
  "sync_started",
  "geocode_cache_write_failed",
  "geocode_poi_fallback",
  "geocoding_failed",
  "member_geocode_skipped",
  "user_name_cascade_batch",
  "customer_linking_failed",
] as const;

/** Discriminated msg union for Integration-archetype log records. */
export type IntegrationEventMsg = (typeof INTEGRATION_EVENT_MSGS)[number];

/** Structured log entry for any external-integration event. */
export interface IntegrationEventLogRecord {
  level: LogLevelType;
  msg: IntegrationEventMsg;
  ts: string;
  service?: string;
  document_path?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link IntegrationEventLogRecord}. */
export const IntegrationEventLogRecordSchema: z.ZodType<IntegrationEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(INTEGRATION_EVENT_MSGS),
  service: z.string().optional(),
  document_path: z.string().optional(),
}).passthrough().meta({ title: "IntegrationEventLogRecord" });
