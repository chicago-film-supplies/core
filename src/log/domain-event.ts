/**
 * Domain-event archetype — order/product/invoice/organization lifecycle
 * events, item-path invariant violations, location cascades, stock
 * recalcs, and per-aggregate webhook receive failures (handled as
 * domain-level outcomes since they're about whether a domain doc was
 * created/updated successfully).
 *
 * **PII posture**: none at the archetype level. The aggregate uids
 * (order/invoice/product/organization) are opaque Firestore ids.
 * Organization names CAN appear in passthrough fields but are not
 * tagged — domain ops legitimately log them for traceability and the
 * value is low for an attacker.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const DOMAIN_EVENT_MSGS = [
  "afterOrderWrite_order_not_found",
  "after_product_write_no_changes",
  "after_product_write_not_found",
  "after_product_write_skip_create",
  "update_order_no_changes",
  "order_docs_failed",
  "order_docs_skipped",
  "order_invoice_count_high",
  "invoice_created",
  "invoice_org_bootstrapped_from_crms",
  "invoice_pdf_not_found",
  "invoice_pdf_skip",
  "invoice_updated",
  "payment_added",
  "payment_updated",
  "organization_check_failed",
  "organization_no_crms_id",
  "organization_no_xero_id",
  "receive_invoice_hook_failed",
  "receive_member_update_failed",
  "receive_opportunity_hook_failed",
  "receive_quarantine_hook_failed",
  "item_path_invariant_failed",
  "location_cascade_skip",
  "stock_recalc_item_added",
  "stock_recalc_item_modified",
  "stock_recalc_item_removed",
  "stock_recalc_items",
  "stock_recalc_status_changed",
  "stock_summaries_pruned",
] as const;

/** Discriminated msg union for Domain-archetype log records. */
export type DomainEventMsg = (typeof DOMAIN_EVENT_MSGS)[number];

/** Structured log entry for any domain-aggregate lifecycle event. */
export interface DomainEventLogRecord {
  level: LogLevelType;
  msg: DomainEventMsg;
  ts: string;
  order_uid?: string;
  invoice_uid?: string;
  product_uid?: string;
  organization_uid?: string;
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

/** Zod schema for {@link DomainEventLogRecord}. */
export const DomainEventLogRecordSchema: z.ZodType<DomainEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(DOMAIN_EVENT_MSGS),
  order_uid: z.string().optional(),
  invoice_uid: z.string().optional(),
  product_uid: z.string().optional(),
  organization_uid: z.string().optional(),
  document_path: z.string().optional(),
}).passthrough().meta({ title: "DomainEventLogRecord" });
