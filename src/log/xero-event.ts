/**
 * Xero integration archetype — every msg emitted by the Xero sync paths
 * (`src/lib/xero.ts`, `src/services/webhooks/xero*`, quote/invoice/payment
 * sync). Token-exchange msgs (`xero_token_exchange_failed`) live in
 * `./oauth-event.ts`.
 *
 * **PII posture**: none today. Invoice numbers, payment ids, contact uids
 * are opaque external ids. Customer-facing email/name fields are not
 * logged from these msgs (verified via the obs sweep).
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Msg literals this archetype absorbs. */
export const XERO_EVENT_MSGS = [
  "xero_id_self_healed",
  "xero_invoice_issued",
  "xero_payment_already_synced",
  "xero_payment_appended",
  "xero_payment_backfilled",
  "xero_payment_processing_failed",
  "xero_payment_sync",
  "xero_payment_sync_skip",
  "xero_payment_webhook_received",
  "xero_quote_enqueue_failed",
  "xero_quote_self_throttle",
  "xero_quote_skip_draft",
  "xero_quote_skip_missing_order",
  "xero_quote_skip_no_org_crms_id",
  "xero_quote_synced",
  "xero_rate_limit",
  "xero_tracking_option_create_failed",
  "xero_tracking_option_update_failed",
  "xero_void_failed",
  "xero_void_requires_manual_action",
  "xero_webhook_invoice_not_found",
  "xero_webhook_no_invoice",
] as const;

/** Discriminated msg union for Xero-archetype log records. */
export type XeroEventMsg = (typeof XERO_EVENT_MSGS)[number];

/** Structured log entry for any Xero sync event. */
export interface XeroEventLogRecord {
  level: LogLevelType;
  msg: XeroEventMsg;
  ts: string;
  xero_invoice_id?: string;
  xero_payment_id?: string;
  xero_contact_id?: string;
  invoice_uid?: string;
  order_uid?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link XeroEventLogRecord}. */
export const XeroEventLogRecordSchema: z.ZodType<XeroEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(XERO_EVENT_MSGS),
  xero_invoice_id: z.string().optional(),
  xero_payment_id: z.string().optional(),
  xero_contact_id: z.string().optional(),
  invoice_uid: z.string().optional(),
  order_uid: z.string().optional(),
}).passthrough().meta({ title: "XeroEventLogRecord" });
