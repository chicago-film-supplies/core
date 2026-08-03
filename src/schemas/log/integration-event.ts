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
  // A CRMS webhook resolved a doc by an external id via a first-wins
  // `where(field,"==",…).docs[0]` query and found MORE THAN ONE match — crms_id
  // is assumed unique per collection but not enforced, so a duplicate (e.g. a
  // leaked test orphan, or a real data-integrity drift) would otherwise bind the
  // wrong doc silently. Emitted (warn) at the products/organizations binds that
  // lack a size>1 guard; carries `collection` + `filter_value` + `count`. #342.
  "crms_multiple_matches_found",
  "crms_invoice_order_not_found",
  // A CRMS invoice line's `subtotal` was derived from its `charge_total` by
  // inverting the discount, and re-applying the discount to that subtotal does
  // NOT reproduce the charge total within a cent. The gross-up itself is exact
  // integer arithmetic (api-cloudrun#415), so a drift here is a statement about
  // CRMS's own data — its `charge_total` and `discount_percent` disagree — not
  // about CFS's arithmetic. Carries `crms_id`, `line`, `rate`, `charge_total`,
  // `subtotal` and `drift_cents`. Retire with CRMS.
  "crms_discount_roundtrip_drift",
  "crms_mark_paid_failed",
  "crms_product_not_found",
  "uploadcare_draft_cleanup_failed",
  "uploadcare_file_not_found",
  "uploadcare_invoice_cleanup_failed",
  "uploadcare_orphan_batch_failed",
  "uploadcare_orphan_cleanup_failed",
  "uploadcare_orphan_sweep_completed",
  // A CDN file was uploaded but the transaction that would have recorded a
  // reference to it failed ambiguously (e.g. a lost commit ack), so we
  // deliberately do NOT delete it — the write may have landed. Left for the
  // orphan sweep to reap; deleting here risks a live order with dead PDF links.
  "uploadcare_upload_abandoned",
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
  "mirror_skipped_stale",
  "draft_quote_skipped_deleted",
  "draft_quote_skipped_invalid_order",
  "draft_quote_superseded",
  "dns_record_check",
  "dns_record_check_resolve_failed",
  "location_integrity_check",
  "location_integrity_check_failed",
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
