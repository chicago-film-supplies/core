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
  // A CRMS invoice line pairs to its source-order line by `uid`, and that uid
  // identifies more than one line on at least one side — so the k-th-occurrence
  // tiebreak `adoptOrderDividerStructure` applies is a guess, not a fact (`uid`
  // is not a row identity; it repeats within one document on 18% of prod
  // orders). Warn rather than throw: the guess is stable across re-deliveries
  // because CRMS preserves line order, and refusing the whole invoice over an
  // ambiguity that resolves the same way every time would be worse. Carries
  // `invoice_number`, `crms_invoice_id`, `count` and `uids`. api-cloudrun#480.
  //
  // It replaces `crms_invoice_multidest_flat`, which warned that a
  // multi-destination order's invoice had been left FLAT because synthesizing
  // structure from CRMS data is unsound. Nothing is synthesized any more — the
  // order's whole divider skeleton is adopted — so the fallback it reported no
  // longer exists.
  "crms_invoice_ambiguous_line_pairing",
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
  // A CRMS invoice line stored a `subtotal` that its own price fields cannot
  // reproduce, and nothing recovered the missing day factor —
  // `resolveInvoiceChargeableDays` found neither a source-order line nor a
  // decomposition that lands on the stored money exactly. `CrmsInvoiceItem`
  // carries no `chargeable_days` (only `CrmsOpportunityItem` does), so the
  // invoice webhook wrote `null` beside a `charge_total`-derived subtotal with
  // the factor baked in — 1,303 of 8,918 prod lines, and the next reprice of a
  // non-terminal one silently drops the factor (api-cloudrun#433). This is the
  // detector that did not exist: the corpus went unnoticed because nothing ever
  // compared a stored subtotal against the function that claims to produce it.
  // Carries `crms_id`, `line`, `base`, `quantity`, `subtotal` and `computed`.
  // Retire with CRMS.
  "crms_invoice_chargeable_days_unresolved",
  // A CRMS invoice resync reached an invoice that money has already settled, so
  // its `items` and `totals` were carried forward untouched rather than
  // re-priced. Everything else CRMS sends — subject, reference, dates, notes,
  // organization — still lands; none of those can move money.
  //
  // The freeze exists because the absence of one is api-cloudrun#437. All 16
  // class-2 invoices were re-priced by CFS on 2026-08-08, years after Xero was
  // invoiced, and each stored `total_cents` is exactly what CFS recomputes today
  // from current product and tax configuration. `amount_paid_cents` (correct,
  // and agreeing with Xero) then no longer reached the new total, leaving a
  // phantom receivable on an invoice already marked paid. `services/orders.ts`
  // has refused the same thing at both its resync sites from the start.
  //
  // INFO, not warn: on a settled invoice this is the correct outcome, and the
  // line exists so an operator asking "why did my CRMS edit not land?" gets an
  // answer. Carries `invoice_number`, `crms_invoice_id` and `invoice_status`.
  // Retire with CRMS.
  "crms_invoice_reprice_frozen",
  "crms_mark_paid_failed",
  // `mark_paid` was refused because the CRMS invoice is ALREADY paid, so the
  // desired end state already holds and the call is a no-op rather than a
  // failure. Operators mark an invoice paid in CRMS by hand to produce a paid
  // invoice document, and Xero's bank transactions — the authority — run about a
  // day behind, so by the time the Xero payment webhook fires the record is
  // frequently already paid (api-cloudrun#360: 238 events in 90 days).
  //
  // ⚠️ It is classified from the RECORD, never from the response. CRMS refuses
  // this with a bare 401 and `You are not authorized to access this page.` —
  // byte-identical to a genuine auth failure — so the demotion re-reads the
  // invoice and keys on `status == 20` (probed live on invoice 1072,
  // 2026-08-15). Demoting on the status code alone would silence a real
  // credential outage on the money path.
  //
  // INFO, not warn: same reasoning as `crms_invoice_reprice_frozen` above — the
  // outcome is correct, and the line exists so the condition stays countable
  // after it stops being an error. Carries `invoice_uid` and `crms_id`.
  // Retire with CRMS.
  "crms_mark_paid_noop",
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
  // The backstop under the DEFERRED stock rebuild (api-cloudrun#358). The
  // rebuild's enqueue is post-commit and therefore not transactional with Firestore,
  // so a crash or an exhausted retry budget leaves a summary stale with nothing
  // scheduled to fix it. Steady state is `repaired: 0` — a non-zero count is a bug
  // report about a writer, not routine maintenance, which is why the emission
  // escalates to `warn` on any repair at all rather than reporting volume at info.
  "stock_summary_sweep",
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
