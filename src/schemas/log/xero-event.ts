/**
 * Xero integration archetype — every msg emitted by the Xero sync paths
 * (`api-cloudrun/src/lib/xero.ts`, `src/services/webhooks/xero*`, quote/invoice/payment
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
  // ── Movement bills (CFS as the ORIGINATOR of inventory movements) ──
  //
  // The push channel that makes the CFS movement journal — not CRMS, and not a
  // synthetic after-the-fact adjustment — the thing that authors an ACCPAY bill.
  // Every arm carries `movement_uid` + `movement_number`; the successful ones
  // also carry the returned bill `xero_invoice_id`, which is what lands on
  // `transactions.xero_id`.
  //
  // Deliberately NOT reusing the quote/invoice arms. `xero_quote_validation_rejected`
  // is already borrowed by the invoice handler, and a third subject on it makes
  // the alert unqueryable.
  //
  // A movement bill posted. `reason` carries the posting shape it resolved to.
  "xero_bill_pushed",
  // The push re-read the movement and found nothing to do — it already carries an
  // `xero_id`, or `xeroPostingFor` returned `skip` (an `opening_balance`, a `sale`
  // whose cost is COGS on the ACCREC side, a refunded return, a custody-only
  // step). Benign and expected: intent is derived from the DOCUMENT, not the
  // payload, so a re-run is a no-op. `reason` is the skip reason.
  "xero_bill_push_skipped",
  // Adopt-or-create found an existing ACCPAY bill for this `CFS-MOV-{number}` and
  // adopted its GUID instead of POSTing a second one.
  //
  // 🔴 This arm is load-bearing in a way the ACCREC one is not. `POST /Invoices`
  // upserts on `InvoiceNumber` for **ACCREC only** — for ACCPAY it does not, so
  // nothing but this read-before-write stands between a redelivered task and a
  // DUPLICATE live bill. `maxConcurrentDispatches: 1` does not prevent it:
  // attempt 2 reads `xero_id == null` exactly as attempt 1 did, and attempts 4–5
  // fall outside Xero's ~6-minute `Idempotency-Key` window.
  "xero_bill_twin_adopted",
  // Xero returned a 400 `ValidationException`. Terminal — the handler returns 200
  // rather than retrying, because a malformed payload never becomes well-formed.
  //
  // ⚠️ An `Idempotency-Key` 400 is a FALSE terminal: Xero returns 400 on *same
  // key, changed body* inside the 6-minute window. The body must be a pure
  // function of the frozen movement — take `DueDate` from `movement.date`, never
  // from `now` — or a real bill is silently dropped here.
  "xero_bill_validation_rejected",
  // A CFS-side terminal: an unmapped posting account, a supplier with no
  // `ContactID`, a product with no `xero_code`, a cost-bearing movement on a
  // product type that bears no stock. Permanent, and detected BEFORE any Xero
  // call, so it is not a Xero `ValidationException`.
  //
  // 🔴 **This arm needs an alert rule beside it.** The 200-drop plus an alert on
  // the error log IS the DLQ substitute; without the alert the 200 is a silent
  // loss of a bill nothing will ever retry.
  "xero_bill_terminal",
  // The movement committed but its push task could not be enqueued. Swallowed
  // and logged rather than 500ing on a write that landed — movements are
  // append-only and never rewritten, so there is no "next touch" to self-heal on.
  // The scheduler-driven sweep over `xero_id == null` is the backstop, and this
  // arm is how you know it has work to do. Needs an alert.
  "xero_bill_enqueue_failed",
  // ── Purchase bills (api-cloudrun#1210) ──
  // The purchase's OWN bill (`purchase-bills/{uid}`, `CFS-BILL-{n}`), not a
  // movement bill. Its own arms rather than the `xero_bill_*` ones, for the
  // reason above: two subjects on one msg make the alert unqueryable. Every arm
  // carries `uid_purchase_bill` + `purchase_bill_number`.
  //
  // A pushed bill posted; `xero_invoice_id` is the ACCPAY's InvoiceID.
  "purchase_bill_pushed",
  // The push re-read the bill and found nothing to do (it already carries an
  // `xero_id`, it is linked, or it is gone). `reason` says which.
  "purchase_bill_push_skipped",
  // Read-before-create found a live ACCPAY under `CFS-BILL-{n}` and adopted it —
  // the only guard between a redelivered task and a duplicate live bill, since
  // `POST /Invoices` does not upsert ACCPAY.
  "purchase_bill_twin_adopted",
  // A permanent refusal: Xero's 400, or a CFS-side terminal found before any
  // Xero call (a product with no Xero code on an inventory line). The handler
  // 200-drops it, so this arm carries an alert.
  "purchase_bill_push_rejected",
  // The bill committed but its push task could not be enqueued. The daily
  // bill sweep is the backstop; this arm carries an alert.
  "purchase_bill_enqueue_failed",
  // ── Supplier credits (api-cloudrun#1210) ──
  // The purchase's supplier credit (`purchase-credits/{uid}`, an ACCPAYCREDIT
  // numbered `CFS-SCR-{n}`). Its own arms for the reason the bill has its own.
  // Every arm carries `uid_purchase_credit` + `purchase_credit_number`.
  //
  // A pushed credit posted; `xero_credit_note_id` is the CreditNoteID.
  "purchase_credit_pushed",
  // The push re-read the credit and found no note to post (already carries an
  // `xero_id`, linked, or gone). `reason` says which. Allocations may still push.
  "purchase_credit_push_skipped",
  // Read-before-create found a live ACCPAYCREDIT under `CFS-SCR-{n}` and adopted it.
  "purchase_credit_twin_adopted",
  // A permanent refusal before or at Xero (a dead twin, a product with no Xero
  // code, a 400). The handler 200-drops it, so this arm carries an alert.
  "purchase_credit_push_rejected",
  // The credit or an allocation committed but the push task could not be
  // enqueued. The daily sweep is the backstop; this arm carries an alert.
  "purchase_credit_enqueue_failed",
  // A CFS allocation of the credit to a bill was PUT to Xero. Carries
  // `settlement_uid` + `uid_purchase_bill` + `xero_invoice_id`.
  "purchase_credit_allocation_pushed",
  // A short close raised a credit and could not allocate it to one of the
  // purchase's bills (the credit committed; the close's response says so).
  // Carries `uid_purchase_bill`. Re-sending the same close retries it.
  "purchase_credit_allocation_failed",
  // ── Settlements (the `settlements` journal) ──
  // A settlement document was written from a Xero payment or credit-note
  // allocation. Carries `settlement_uid` + `settlement_type`.
  "xero_settlement_synced",
  // Xero stopped reporting a settlement CFS holds, so the reap appended a
  // reverser (`reason: "source_retracted"`) rather than tombstoning. A real
  // event with a real date, which is why it is an append and not a status flip.
  "xero_settlement_reaped",
  // A Xero payment whose id matches only a REVERSED settlement. Treated as
  // unmatched and appended fresh (self-healing, Xero being the source of truth
  // for payments) — but it means the reap and Xero now disagree, and that is
  // worth a human knowing rather than being repaired invisibly.
  "xero_settlement_resurrected",
  // A seam CFS cannot clear via the API: money moved, or a refusal stands, and
  // only a person in the Xero UI can resolve it. One arm, one helper
  // (`reportManualXeroIntervention`), so adding a seam is an enum member rather
  // than a new alert. Until credit-note origination ships, EVERY credit note in
  // the business is created by hand in Xero and silently changes a CFS
  // invoice's balance — `credit_created_out_of_band` is that signal.
  "xero_manual_intervention_required",
  // ── Credit notes ──
  // A CREDITNOTE webhook carried a note numbered above `counters/credit-notes`,
  // so `raiseFloor` moved the counter up to it (api-cloudrun#1207 item 3b). Xero
  // is a live second numberer: a note made in its UI takes the next CN number,
  // and without this CFS's next mint collides with it. Emitted only when the
  // counter MOVED, so its rate is the rate of notes made in Xero. Carries
  // `credit_note_number`, `counter_from` and `counter_to`.
  "credit_note_counter_raised",
  // A CREDITNOTE webhook's `Payments[]` (cash refunds) was reconciled into the
  // journal as `refund` settlements (api-cloudrun#1207). Carries
  // `xero_credit_note_id` and the counts of rows appended, linked and reaped.
  "xero_credit_note_refunds_synced",
  "xero_payment_already_synced",
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
  // `PUT /TaxRates` (Xero's createTaxRates) failed, or the read-before-create
  // that precedes it did. Warn rather than throw, matching the sibling above:
  // the caller returns `null` and the operator retries from the manager, and a
  // half-created tax rate costs nothing — it is inert clutter in a dropdown
  // until something stores its `TaxType`, not a duplicated money record.
  "xero_tax_rate_create_failed",
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
  // `uid_product` + `item_name`, and whichever of `invoice_uid`/`uid_order`
  // identifies the document being pushed.
  "xero_tracking_option_unresolved",
  "xero_tracking_option_update_failed",
  "xero_void_failed",
  "xero_void_requires_manual_action",
  "xero_webhook_invoice_not_found",
  "xero_webhook_no_invoice",
  // An ACCPAY webhook for a bill CFS does not track (api-cloudrun#1210) — the
  // tenant's company payables ("July Loan"), a movement's `CFS-MOV-*` bill, or a
  // supplier bill nobody has linked to a purchase yet. Informational: it RETURNS
  // rather than fails, so Xero does not redeliver it. Its own arm because it is
  // NOT `xero_webhook_invoice_not_found` — an ACCPAY is never looked up among
  // CFS invoices at all, by id or by number. Carries `xero_invoice_id` +
  // `xero_invoice_number` + `xero_status`.
  "xero_untracked_accpay",
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
  xero_credit_note_id?: string;
  xero_contact_id?: string;
  /** The settlement document written, reaped or resurrected. */
  settlement_uid?: string;
  settlement_type?: string;
  credit_note_number?: string;
  /** `credit_note_counter_raised`: the counter before and after the raise. */
  counter_from?: number;
  counter_to?: number;
  /** `xero_credit_note_refunds_synced`: rows this call appended, linked and reaped. */
  refunds_appended?: number;
  refunds_linked?: number;
  refunds_reaped?: number;
  /** The movement whose bill was pushed. Its uid IS the document id. */
  movement_uid?: string;
  /**
   * `Movement.number` — what `CFS-MOV-{number}` is keyed on.
   *
   * Never reused, which is what makes it safe as a Xero `InvoiceNumber`: Xero
   * frees a number on VOID/DELETE (prod holds four duplicate-number ACCREC pairs
   * that way), so a reusable key would let a voided bill's number be re-minted.
   */
  movement_number?: number;
  /** The purchase bill a `purchase_bill_*` arm is about. Its uid IS the document id. */
  uid_purchase_bill?: string;
  /** `PurchaseBill.number` — what `CFS-BILL-{number}` is keyed on. Never reused. */
  purchase_bill_number?: number;
  /** The supplier credit a `purchase_credit_*` arm is about. Its uid IS the document id. */
  uid_purchase_credit?: string;
  /** `PurchaseCredit.number` — what `CFS-SCR-{number}` is keyed on. Never reused. */
  purchase_credit_number?: number;
  /** Which manual-intervention seam fired. @see `xero_manual_intervention_required` */
  seam?: string;
  /** What a human must do about it — carried into the alert annotation. */
  remedy?: string;
  xero_url?: string;
  xero_error?: string;
  invoice_number?: number;
  invoice_uid?: string;
  /** The order a quote push or a tracked line belongs to. */
  uid_order?: string;
  /**
   * @deprecated Use {@link uid_order}. Still declared so the alert bridge can
   * read both spellings while emitters move; removed (with the bridge) 90 days
   * after the api release that renames the last emitter.
   */
  order_uid?: string;
  /**
   * The product behind a pushed line (`xero_tracking_option_unresolved` and
   * the tracking-option family).
   */
  uid_product?: string;
  /**
   * @deprecated Use {@link uid_product}. Never declared on this arm before,
   * though most `product_uid` emitters are Xero msgs; declared now only so the
   * bridge has a typed field, and removed with {@link order_uid}.
   */
  product_uid?: string;
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
  xero_credit_note_id: z.string().optional(),
  xero_contact_id: z.string().optional(),
  settlement_uid: z.string().optional(),
  settlement_type: z.string().optional(),
  credit_note_number: z.string().optional(),
  counter_from: z.number().optional(),
  counter_to: z.number().optional(),
  refunds_appended: z.number().optional(),
  refunds_linked: z.number().optional(),
  refunds_reaped: z.number().optional(),
  movement_uid: z.string().optional(),
  movement_number: z.number().optional(),
  uid_purchase_bill: z.string().optional(),
  purchase_bill_number: z.number().optional(),
  uid_purchase_credit: z.string().optional(),
  purchase_credit_number: z.number().optional(),
  seam: z.string().optional(),
  remedy: z.string().optional(),
  xero_url: z.string().optional(),
  xero_error: z.string().optional(),
  invoice_number: z.number().optional(),
  invoice_uid: z.string().optional(),
  uid_order: z.string().optional(),
  /** @deprecated Use `uid_order`. */
  order_uid: z.string().optional(),
  uid_product: z.string().optional(),
  /** @deprecated Use `uid_product`. */
  product_uid: z.string().optional(),
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
