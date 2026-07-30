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
import type { XeroThrottleResetsAtSource } from "../xero-budget.ts";

/**
 * Msg literals this archetype absorbs.
 *
 * Quote-push terminal/diagnostic arms (added 2026-07 with the queue restore):
 * - `xero_quote_validation_rejected` — Xero returned 400 `ValidationException`.
 *   The task is dropped (handler returns 200) rather than retried 15×; a
 *   malformed payload never becomes well-formed on retry.
 * - `xero_quote_locked` — the quote sits in a state CFS refuses to move out of, so
 *   the push made ZERO Xero calls. This is the honest outcome that replaces the
 *   swallow: for 30 days every one of the 27 rejected transitions was ALSO logged
 *   `xero_quote_synced`, because the swallow fell through to the success path and
 *   advanced the push watermark. There is exactly one `reason`:
 *
 *     - `invoiced_terminal` — the quote is INVOICED and the target is not. Xero
 *       will actually *permit* INVOICED → SENT → DECLINED, and that is precisely
 *       the bug: we un-invoiced 3 live quotes that way. INVOICED is terminal for
 *       CFS regardless of what Xero tolerates. (There is deliberately no
 *       `accepted_locked` — an ACCEPTED quote is NOT write-locked; a canceled
 *       order's quote declines via the legal ACCEPTED → SENT → DECLINED walk.)
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
 *   and found nothing to do. Usually benign and expected: the deferred task derives
 *   issue-vs-void from the invoice DOC rather than from its payload, so a re-run (or
 *   a run after a human fixed the invoice by hand) is a no-op. At `error` level it
 *   means the re-deferral itself failed to enqueue — a genuinely dropped write.
 *
 *   Note what does NOT protect us here. Deriving intent from the doc keys on
 *   `xero_id == null`, and that means "CFS holds no receipt", NOT "Xero holds no
 *   invoice" — the two diverge, because the POST and the `xero_id` write-back are
 *   not atomic. Prod invoice 2312 proves it. What actually prevents a double-create
 *   is that the push POSTs, and Xero's `POST /Invoices` is upsert-by-InvoiceNumber;
 *   `PUT` would duplicate. The idempotency is Xero's, not ours.
 * - `xero_defer_escalated` — a deferred Xero write hit the re-deferral cap and was
 *   abandoned. `defer_attempt` is otherwise unbounded (the task handler returns 200,
 *   so Cloud Tasks' `max_attempts` never applies), which lets an unpushable write
 *   re-defer forever, silently. This is the event that makes that loud; it is always
 *   a dropped write needing a human.
 */
export const XERO_EVENT_MSGS = [
  "xero_id_self_healed",
  "xero_invoice_issued",
  "xero_invoice_push_skipped",
  // A number-keyed GET resolved a Xero twin for a CFS invoice with no `xero_id`.
  // `adopted` — a LIVE ACCREC twin was accepted and its GUID persisted onto the
  // invoice. `refused` — the only twin was VOIDED/DELETED and the CFS invoice is
  // not itself void, so the push made NO Xero write and left `xero_id` null
  // (prod 1859 is the exemplar). A refusal is a real divergence for the
  // reconcile script, never a create — see `selectXeroInvoiceTwin`.
  "xero_invoice_twin_adopted",
  "xero_invoice_twin_refused",
  // The CRMS invoice webhook found a tracked-inventory sale line short of stock
  // and posted an ACCPAY stock-adjustment bill to Xero. CFS persists no ACCPAY
  // doc, so this log is the ONLY audit trail: it carries the returned bill
  // `xero_invoice_id`, the `delta` posted, and the pre-bill `quantity_on_hand`.
  "xero_stock_adjustment_bill",
  "xero_payment_already_synced",
  "xero_payment_appended",
  "xero_payment_backfilled",
  "xero_payment_processing_failed",
  "xero_payment_sync",
  "xero_payment_sync_skip",
  "xero_payment_webhook_received",
  "xero_quote_enqueue_failed",
  "xero_quote_locked",
  "xero_quote_noop",
  "xero_quote_self_throttle",
  "xero_quote_skip_draft",
  "xero_quote_skip_missing_order",
  "xero_quote_skip_no_org_crms_id",
  "xero_quote_superseded",
  "xero_quote_synced",
  "xero_quote_tax_unmapped",
  // NOTE: `xero_quote_transition_rejected` was REMOVED. It was the log the old
  // swallow emitted when Xero refused a Status hop — and that swallow then fell
  // through to `xero_quote_synced`, so the two fired together 27 times in 30 days
  // and a failure was indistinguishable from a success. The push no longer attempts
  // a transition Xero cannot make (`planXeroQuotePush`), so a refusal is not an
  // expected outcome any more: it is either `xero_quote_locked` (foreseen, no call
  // made) or a genuine 400 → `xero_quote_validation_rejected`.
  "xero_quote_validation_rejected",
  "xero_quota_exhausted",
  "xero_rate_limit",
  "xero_write_deferred",
  "xero_defer_escalated",
  "xero_tracking_option_create_failed",
  // A line was about to be pushed carrying an `xero_tracking_option_id` that
  // matches no known Xero tracking option, so CFS omitted the `Tracking`
  // element rather than sending it. This log is the ONLY signal that the line
  // landed unclassified: Xero **silently drops** a `Tracking` element whose
  // `TrackingOptionID` doesn't resolve — no 400, the push returns 200, and the
  // line shows up untracked in every report grouped by product line. 29 of 547
  // prod products carried such a dead id (2026-07-29), minted by a delete +
  // recreate of the option and by a hardcoded uuid in `createReplacementDoc`.
  //
  // Deliberately a warn, not a throw. Money resolves or fails; reporting
  // metadata degrades and says so. Carries `xero_tracking_option_id` +
  // `product_uid` + `item_name`, and whichever of `invoice_uid`/`order_uid`
  // identifies the document being pushed.
  "xero_tracking_option_unresolved",
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
  /** Quote-push identity + state. Emitted by the whole quote path (`synced`,
   * `noop`, `locked`, `superseded`); previously carried only by passthrough. */
  xero_quote_id?: string | null;
  order_number?: number;
  current_status?: string | null;
  target_status?: string;
  /**
   * Why this arm fired. Deliberately a free string, not one enum: each msg owns
   * its own value space (`already_pushed` for `noop`, `accepted_locked` /
   * `invoiced_terminal` for `locked`, `day`/`minute` for `self_throttle`), and a
   * query is always scoped by `msg` anyway.
   */
  reason?: string;
  /**
   * Xero's raw `Retry-After` on a 429, in seconds — **un-clamped**. The in-process
   * sleep clamps this to 5 min so a server-side bug can't pin a worker, but the
   * clamped value must never be used for *scheduling*: on a day-429 the raw value
   * is the real time-to-reset and routinely exceeds the clamp. Logging the raw
   * value is what makes `resets_at` auditable after the fact.
   */
  retry_after_s?: number;
  /** How `resets_at` was determined — reported, inferred rollover, or an assumed
   * 60s minute window. See {@link XeroThrottleResetsAtSource}. */
  resets_at_source?: XeroThrottleResetsAtSource;
  /** Which Xero window refused the call: the daily cap vs a minute/concurrent limit. */
  throttle_reason?: "day_budget" | "minute_limit";
  /** How many times a deferred write has now been re-deferred. */
  defer_attempt?: number;
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
  xero_quote_id: z.string().nullable().optional(),
  order_number: z.number().optional(),
  current_status: z.string().nullable().optional(),
  target_status: z.string().optional(),
  reason: z.string().optional(),
  retry_after_s: z.number().optional(),
  resets_at_source: z.enum(["retry_after", "inferred_rollover", "assumed_minute"]).optional(),
  throttle_reason: z.enum(["day_budget", "minute_limit"]).optional(),
  defer_attempt: z.number().optional(),
  resets_at: z.string().optional(),
  day_remaining: z.number().optional(),
  critical: z.boolean().optional(),
  outcome: z.enum(["created", "deduped", "skipped"]).optional(),
}).passthrough().meta({ title: "XeroEventLogRecord" });
