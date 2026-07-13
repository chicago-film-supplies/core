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

/**
 * Msg literals this archetype absorbs.
 *
 * Quote-push terminal/diagnostic arms (added 2026-07 with the queue restore):
 * - `xero_quote_validation_rejected` — Xero returned 400 `ValidationException`.
 *   The task is dropped (handler returns 200) rather than retried 15×; a
 *   malformed payload never becomes well-formed on retry.
 * - `xero_quote_transition_rejected` — a Status POST was rejected by Xero's
 *   quote state machine and swallowed as idempotent. Previously silent, which
 *   made a masked failure indistinguishable from success.
 * - `xero_quote_tax_unmapped` — an order item carries a tax uid with no Xero
 *   TaxType mapping. Previously `throw` → 500 → 15 retries.
 * - `xero_quote_noop` — the Xero quote is already at the target Status; no
 *   write was issued.
 *
 * Quota-gate arms (added 2026-07 with the daily-budget gate):
 * - `xero_quota_exhausted` — a call was refused **pre-flight**, before touching
 *   Xero, because the persisted day budget was at/below the caller's floor.
 *   Carries `resets_at` so the deferral's schedule is auditable.
 * - `xero_write_deferred` — a Xero write that could not run now was re-enqueued
 *   past the day reset under a distinct `xq-defer-…` task name. The `outcome`
 *   field is load-bearing: a `"deduped"` here is the intended storm-coalescing,
 *   but a `"skipped"` would be a silently-dropped write.
 * - `xero_quote_superseded` — the order's push-determining state changed between
 *   enqueue and execution, so the task returned without issuing ANY Xero call.
 * - `xero_invoice_push_skipped` — `/tasks/push-xero-invoice` re-read the invoice
 *   and found nothing to do. Usually benign and expected: the deferred task is
 *   idempotent because it derives issue-vs-void from the invoice DOC rather than
 *   from its payload, so a re-run (or a run after a human fixed the invoice by
 *   hand) is a no-op instead of a double-create in Xero. At `error` level it
 *   means the re-deferral itself failed to enqueue — a genuinely dropped write.
 */
export const XERO_EVENT_MSGS = [
  "xero_id_self_healed",
  "xero_invoice_issued",
  "xero_invoice_push_skipped",
  "xero_payment_already_synced",
  "xero_payment_appended",
  "xero_payment_backfilled",
  "xero_payment_processing_failed",
  "xero_payment_sync",
  "xero_payment_sync_skip",
  "xero_payment_webhook_received",
  "xero_quote_enqueue_failed",
  "xero_quote_noop",
  "xero_quote_self_throttle",
  "xero_quote_skip_draft",
  "xero_quote_skip_missing_order",
  "xero_quote_skip_no_org_crms_id",
  "xero_quote_superseded",
  "xero_quote_synced",
  "xero_quote_tax_unmapped",
  "xero_quote_transition_rejected",
  "xero_quote_validation_rejected",
  "xero_quota_exhausted",
  "xero_rate_limit",
  "xero_write_deferred",
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
  /**
   * Xero's raw `Retry-After` on a 429, in seconds — **un-clamped**. The in-process
   * sleep clamps this to 5 min so a server-side bug can't pin a worker, but the
   * clamped value must never be used for *scheduling*: on a day-429 the raw value
   * is the real time-to-reset and routinely exceeds the clamp. Logging the raw
   * value is what makes `resets_at` auditable after the fact.
   */
  retry_after_s?: number;
  /** How `resets_at` was determined — a reported value vs an inferred rollover. */
  resets_at_source?: "retry_after" | "inferred_rollover";
  /** When the Xero day window rolls over (ISO). */
  resets_at?: string;
  /** Calls left in the tenant's day window at decision time. */
  day_remaining?: number;
  /** Whether the refused/deferred call was on the reserved money path. */
  critical?: boolean;
  /**
   * Cloud Tasks outcome of a deferral. Load-bearing: `"deduped"` is the intended
   * storm-coalescing, but `"skipped"` means the write was silently dropped.
   */
  outcome?: "created" | "deduped" | "skipped";
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
  retry_after_s: z.number().optional(),
  resets_at_source: z.enum(["retry_after", "inferred_rollover"]).optional(),
  resets_at: z.string().optional(),
  day_remaining: z.number().optional(),
  critical: z.boolean().optional(),
  outcome: z.enum(["created", "deduped", "skipped"]).optional(),
}).passthrough().meta({ title: "XeroEventLogRecord" });
