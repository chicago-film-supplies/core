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
  // `src/lib/orderInvoiceMirror.ts`'s two callers in api-cloudrun
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
  // Emitted from `src/lib/cascadeScan.ts` in api-cloudrun.
  "cascade_converged",
  "location_cascade_skip",
  // updateTransaction / updateStoreTransfer reversing the previous version out
  // of a location doc found the doc or its product row missing, or repointed a
  // uid-drifted doc. Pure drift signals the caller can't remediate — logged, not
  // thrown. `{ location_id, uid_product, reason, expected_decrement }`. Emitted
  // from `src/lib/transactionHelpers.ts` in api-cloudrun.
  "location_reversal_skip",
  // A location doc's `products[].quantity` went negative after a reversal —
  // only possible if its stored base was already drifted. Detector for the drift
  // `resyncLocationQuantities` repairs; does not throw. `{ location_id,
  // uid_product, quantity }`. Emitted from `src/lib/transactionHelpers.ts`.
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
  // Emitted from `src/services/stockSummaryRebuild.ts` in api-cloudrun.
  "stock_oversold",
  // Fulfillment picker accepted a quantity edit on a `custom-*` line
  // item. Custom uids regenerate on the next CRMS opportunity sync, so
  // the override is lossy — this is the explicit warning trail. Emitted
  // from `src/services/fulfillmentEdits.ts` in api-cloudrun.
  "fulfillment_custom_item_qty_override",
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
