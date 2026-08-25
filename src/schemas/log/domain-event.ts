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
  // `readStoreDestination` found NO default store, so an order carrying
  // `uid_store: null` fell back to the customer's own address rather than the
  // store's. ⚠️ Emitted at `warn` rather than thrown deliberately: in prod a
  // refusal would take out every customer-pickup order, so the fallback stands
  // and the condition is reported instead. It used to be entirely silent, which
  // is why api-cloudrun#586 sat unnoticed in dev — a harness clobber was
  // invisible until someone read an affected order. `{ store_uid }` names the
  // store that was ASKED for, absent when the lookup was "whichever is default".
  "store_destination_no_default",
  // The order fan-out's change guard declined a write that touched only
  // excluded fields (api-cloudrun#407). Sibling of the product one below, and
  // the same `debug` level: it is a development aid, suppressed in prod by
  // `LOG_LEVEL=info`. `{ order_uid, reason }`.
  "after_order_write_no_changes",
  "after_product_write_no_changes",
  "after_product_write_not_found",
  "after_product_write_skip_create",
  "update_order_no_changes",
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
  // An `order.invoices[]` entry disagreed with the invoice document and was
  // converged. `source:"writer"` = a CFS service write repaired a ref a
  // *change*-gated fan-out would have skipped; `source:"backstop"` = the
  // eventarc reconciler repaired one, which in steady state means something
  // wrote `invoice.status` outside a CFS service (a `scripts/repair-*.ts`) or
  // `createSettlement` crashed between its invoice CAS and its order fan-out.
  // Steady-state `backstop` volume IS the bug report — alerted on in
  // `infra/observability/vmalert/rules-vlogs.yml`. `{ order_uid, invoice_uid,
  // source, status_from, status_to, number_changed }`. Emitted from
  // `api-cloudrun/src/lib/orderInvoiceMirror.ts`'s two callers in api-cloudrun
  // (`services/orderInvoiceMirror.ts`, `services/invoices.ts`). api#453.
  "order_invoice_mirror_repaired",
  // A denorm cascade resolved its target ids OUTSIDE its transaction (so the
  // collection leaves `contended_ranges` — api-cloudrun#423) and then re-scanned
  // after committing to repair anything that scan could not have seen. Emitted
  // once per converge pass that found a straggler; SILENT when it found none,
  // which is the steady state. `still_appearing` non-empty escalates to `warn`
  // and means ids kept arriving through the repair — the source is being written
  // continuously and another round would not converge either.
  // `{ tx_name, source_doc_id, repaired_counts, written_counts, still_appearing }`.
  // Emitted from `api-cloudrun/src/lib/cascadeScan.ts` in api-cloudrun.
  "cascade_converged",
  "location_cascade_skip",
  // updateTransaction / updateStoreTransfer reversing the previous version out
  // of a location doc found the doc or its product row missing, or repointed a
  // uid-drifted doc. Pure drift signals the caller can't remediate — logged, not
  // thrown. `{ location_id, uid_product, reason, expected_decrement }`. Emitted
  // from `api-cloudrun/src/lib/transactionHelpers.ts` in api-cloudrun.
  "location_reversal_skip",
  // A location doc's `products[].quantity` went negative after a reversal —
  // only possible if its stored base was already drifted. Detector for the drift
  // `resyncLocationQuantities` repairs; does not throw. `{ location_id,
  // uid_product, quantity }`. Emitted from `api-cloudrun/src/lib/transactionHelpers.ts`.
  "location_quantity_negative",
  "stock_recalc_item_added",
  "stock_recalc_item_modified",
  "stock_recalc_item_removed",
  "stock_recalc_items",
  "stock_recalc_status_changed",
  // A product is oversold at some instant — `worstStockAvailability` over the
  // rebuilt `stock/{P}` projection reports `quantity_available < 0`. This is the
  // **operator advisory** half of the oversell policy (api-cloudrun#510 P4): the
  // operator, order and CRMS paths deliberately never refuse a claim (#424 —
  // shortage is the intended signal, and a refusal on the CRMS webhook is a 400
  // to something that retries forever), so this is what records the fact instead
  // of blocking it.
  //
  // Emitted **post-commit from the rebuild**, not from a pre-write gate, and that
  // is a cost decision worth keeping: the rebuild already holds the projection,
  // so the check is arithmetic on a document in hand — zero extra reads — while a
  // pre-write gate would add two queries per product to every order write (~61
  // products on the largest live order, on a request already measured at ~5.5 s —
  // api-cloudrun#508). Post-commit is also the more accurate of the two, since it
  // sees the state that actually landed.
  //
  // `{ product_uid, quantity_held, quantity_booked, quantity_out_of_service,
  // quantity_available, since, reason }`, at `warn`. `since` is the ISO instant
  // the worst point opens, or null when open-ended entries alone carry it.
  // Emitted from `api-cloudrun/src/services/stockSummaryRebuild.ts` in api-cloudrun.
  "stock_oversold",
  // Fulfillment picker accepted a quantity edit on a `custom-*` line
  // item. Custom uids regenerate on the next CRMS opportunity sync, so
  // the override is lossy — this is the explicit warning trail. Emitted
  // from `api-cloudrun/src/services/fulfillmentEdits.ts` in api-cloudrun.
  "fulfillment_custom_item_qty_override",
  // One recurrence threw while the nightly sweep advanced its horizon
  // (api-cloudrun#549 D6-B). `materializeHorizonAll` absorbs the throw and
  // carries on — correct, because `recurrence-horizon-nightly` retries the
  // WHOLE sweep (`retry_count = 3`) and a 5xx would redo every recurrence that
  // had just succeeded. The retry unit and the failure unit are different sizes.
  //
  // ⚠️ **The swallow was SILENT until this arm existed**: `services/recurrences.ts`
  // imported no logger at all, the handler returns 200 unconditionally, and the
  // only trace was an `errors` count in a response body nothing reads. So
  // `retry_count = 3` is dead config for this failure mode and a recurrence could
  // stop advancing EVERY NIGHT, FOREVER, with nothing errored, logged or alerted.
  // The alert (`RecurrenceHorizonFailed`) groups by `recurrence_uid`, because
  // "one failed once" and "the same one has failed for a month" are the same
  // count and completely different incidents.
  //
  // `{ recurrence_uid, error_name, error_message, error_stack }`, at `error`.
  // Emitted from `api-cloudrun/src/services/recurrences.ts` in api-cloudrun.
  "recurrence_horizon_failed",
  // A document PRICED on a `(jurisdiction × item type)` tax cell whose REVIEW
  // window had run out — the engine fell forward to the most recent version at
  // or before the document's instant and said so (`UnreviewedTaxWarning` in
  // `@cfs/core/utils/taxes`). api-cloudrun#618.
  //
  // ⚠️ **An unreviewed rate is not a known-wrong one** (owner): what lapsed is
  // the confirmation, not the number, and most renewals change nothing. This is
  // a prompt to look, which is why it is a `warn` and why nothing is blocked.
  //
  // ⚠️ **This replaced `tax_expired_skipped`, and the rename is the design
  // change.** That record meant "a write was REFUSED and ACKed", because the
  // engine used to throw. The throw was an outage: a document resolves the
  // catalog at its own instant, and for an ORDER that instant is the earliest
  // DELIVERY START — a future date — so a finite `applied_to` refused every
  // booking past it rather than scheduling a review. Nothing is refused now.
  //
  // `warn`, not `error`: the document priced, the money is what an open-ended
  // window would have produced, and the remedy is an operator confirming a rate
  // that is probably unchanged. `tax_expiry_check` (integration archetype) is the standing-condition
  // record `TaxExpired` escalates on; this one names the DOCUMENT that used the
  // stale rate, which is what makes the blast radius answerable after the fact.
  //
  // One record per CELL, not per line — core dedupes, because a 61-line order
  // resolving one lapsed cell would otherwise bury the surface it is reported
  // on. `{ order_uid | invoice_uid | product_uid | crms_id, operation,
  // jurisdiction, item_type, tax_uid, tax_name, rate, expired_at, as_of }`.
  "tax_priced_on_unreviewed_rate",

  // An order→invoice destination sync REMOVED an invoice pair that carried a
  // `jurisdiction` — i.e. the field that priced that pair's lines is gone, and
  // the replacement projection resolves whatever the ORDER says.
  // api-cloudrun#663.
  //
  // ⚠️ **Emitted only for `reason: "key_names_no_order_pair"`**, which is the
  // half nobody chose. With a `prev` the order genuinely deleted a pair the
  // invoice had not edited, and warning on that would fire on every legitimate
  // deletion until the record was ignored. Without one, `pairsMatch` never ran:
  // the invoice's payload was dropped without being compared to anything, so
  // "the operator's override was preserved" was never even asked.
  //
  // `warn`, not `error`: the write succeeds and the invoice still prices — on a
  // different jurisdiction than the one somebody stated. Measured on prod
  // 2026-08-24, 14 of 989 invoice pairs are exposed and 4 are reachable.
  //
  // ⚠️ **The reason this exists at all is that the loss was previously TOTALLY
  // silent** — no error, no log, a changed tax rate on an issued invoice. The
  // fix for the drop itself is the pair re-key (the divider's uid becomes the
  // join key, so an address change stops moving the key); this record is what
  // makes the interim measurable and what will show the population going to
  // zero when that lands.
  //
  // `{ invoice_uid, order_uid, jurisdiction, delivery_uid, collection_uid }`.
  "invoice_destination_override_dropped",
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
  /**
   * The recurrence a record is about. Declared rather than left to the index
   * signature below: it is CALLER-supplied, and the #22 ruling is that a
   * caller-supplied field earns a declaration whatever `[key: string]: unknown`
   * would tolerate. ⚠️ The declaration buys type-safety and discoverability on
   * this name only — `recurrence_uidd` still compiles, because the index
   * signature admits any name. Deleting that signature is the real fix and is
   * not this field's to make.
   */
  recurrence_uid?: string;
  document_path?: string;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  /**
   * `order_invoice_mirror_repaired` — the `order.invoices[]` status the mirror
   * converged FROM and TO. ⚠️ **Nullable, not merely optional**: the emitter
   * writes `converged.status_changed?.from ?? null`, so a repair that changed
   * the number but not the status carries an explicit `null` rather than an
   * absent key.
   */
  status_from?: string | null;
  status_to?: string | null;
  /**
   * `stock_oversold` — the PEAK-instant figures, not a window's. A negative
   * `quantity_available` here is a physical impossibility (more units out at one
   * instant than exist), which is why the alert is keyed on it and not on the
   * far larger set a window-based comparison would flag.
   */
  quantity_held?: number;
  quantity_available?: number;
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
  store_uid: z.string().optional(),
  recurrence_uid: z.string().optional(),
  document_path: z.string().optional(),
  status_from: z.string().nullable().optional(),
  status_to: z.string().nullable().optional(),
  quantity_held: z.int().optional(),
  quantity_available: z.int().optional(),
}).passthrough().meta({ title: "DomainEventLogRecord" });
