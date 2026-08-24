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
  // A component whose PRODUCT has no CRMS counterpart. A CRMS accessory row
  // carries `related_id: <crms product id>`, so a CFS-native component has
  // nothing for it to point at and CRMS refuses the create outright — HTTP 422
  // `related_name can't be blank`, observed on all five bottled-water SKUs the
  // moment `Bottled Water ( /bottle )` became their unit (api-cloudrun#596).
  //
  // ⚠️ **A SKIP, not a failure, and the distinction is the point.** No CRMS
  // order can ever reference a CFS-only structural unit, so there is nothing to
  // keep in step; attempting the create instead logged an ERROR on every write
  // of those products, forever. DEBUG: the outcome is correct and the line
  // exists so the condition stays countable. Carries `product_uid` and
  // `component_uid`. Retire with CRMS.
  "crms_accessory_skipped",
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
  // The 15-minute state record under the settlement projection
  // (api-cloudrun#546). Emitted on EVERY run including clean ones, because the
  // question the alert asks is "is the projection still a fold of its journal",
  // and a rule that counted complaint-events could not tell a clean run from a
  // run that never happened.
  //
  // Steady state is `drifted: 0`. Non-zero is a bug report about a WRITER — a
  // journal row whose projection never landed — and it does not self-heal:
  // `syncXeroSettlement` skips its projection write when no delta moved, which
  // is exactly the case for a row already in the journal. 120 prod invoices sat
  // that way undetected until 2026-08-20.
  "settlement_totals_sweep",
  // The state check over Illinois' published tax rates (api-cloudrun#600).
  // Emitted on EVERY run including clean ones, for the reason the two sweeps
  // above are: an alert that counted complaints could not tell a matching
  // corpus from a job that stopped running, and this one guards a rate CFS
  // bills against.
  //
  // ⚠️ Its subject is an EXTERNAL publication, not CFS's own data, which makes
  // the failure mode different from a sweep's: the source is a fixed-width file
  // with no published byte offsets and no versioning, so a layout change looks
  // exactly like "no rate moved". `divergent: 0` is only meaningful beside
  // `checked: 4` — a run that parsed nothing must report `checked: 0` and be
  // alerted on, never reported clean.
  //
  // Steady state is `divergent: 0, pending: 0`. Non-zero `divergent` means CFS
  // is billing a rate Illinois does not publish; non-zero `pending` means a
  // change is dated and not yet applied, which is the case that gives an
  // operator lead time instead of a back-dated repair.
  "il_tax_rate_check",
  // The daily state record over the tax catalog's own expiry (api-cloudrun#618).
  // Emitted on EVERY run including clean ones, for the reason the sweeps above
  // are: a rule counting complaints cannot tell a healthy catalog from a job
  // that stopped running.
  //
  // ⚠️ **It is the COMPLEMENT of `il_tax_rate_check`, not a duplicate.** That
  // one diffs CFS's rates against Illinois' published file and covers 29.9% of
  // the tax CFS collects with zero human input. It cannot reach Chicago Rental
  // Tax — 70.1% of all tax ever collected — because the 15% is the City of
  // Chicago lease transaction tax and is published in no machine-readable form.
  // Detection cannot reach the 70%; an expiry can, at the cost of two operator
  // review sessions a year.
  //
  // Steady state is `expired: 0`. Non-zero `expired` is BOTH a money-path defect
  // and an order-taking outage — the pricing engine refuses an expired cell
  // rather than billing it at zero — so it alerts at critical.
  // `expiring_soon` is the lead-time signal and alerts at warning.
  // `{ checked, expiring_soon, expired, sample }`.
  "tax_expiry_check",
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
  /**
   * Convergence lag in milliseconds — **source commit → cascade complete**.
   *
   * Emitted by `eventarc_processed` only (api-cloudrun `routes/eventarc.ts`),
   * as `Date.now() - Date.parse(ce-time)`. It is the only convergence latency
   * this system records, and it is what campaign Tier 2 #22 exists to collect:
   * without it, *"how stale may a denorm legitimately be before it is a bug?"*
   * has no answer and every async repair's SLA is a guess.
   *
   * ⚠️ **Not handler duration.** `msg:"request"` already carries that for the
   * same events and it answers a different question. ⚠️ **Absent rather than
   * zero** when `ce-time` is missing or unparseable — a zero would sit in the
   * distribution as a real, impossibly-fast convergence.
   *
   * ⚠️ **DECLARED HERE ON PURPOSE, rather than riding `.passthrough()`.** The
   * first cut of #22 leaned on the index signature below. Openness on this
   * record is meant for what the LOGGER merges from AsyncLocalStorage; a
   * caller-supplied field earns a declaration — the same argument §6b of the
   * propagation campaign made about `PropagationContext`, where 46 call sites
   * satisfied a "required" field through an index signature rather than because
   * of it.
   *
   * ⚠️ **Be precise about what this buys, because it is less than it looks.**
   * Measured, not assumed: `lag_ms: "5"` is a compile error (TS2322) and the
   * Zod arm rejects a negative — but **`lag_msec: 5` still compiles**, because
   * `[key: string]: unknown` below admits any name. So this declaration gives
   * type-safety and discoverability on the RIGHT name, and **no protection
   * against a misspelling**. The only fix for that is deleting the index
   * signature, which ~100 message types currently depend on — including this
   * record's own `collection`, `doc_id` and `operation`. Worth doing; not worth
   * smuggling into a two-week measurement.
   *
   * ✅ **Kept, and the measurement it was time-boxed for is taken**
   * (api-cloudrun#573, closed 2026-08-22). Prod, 7 days: p50 329 ms, p95
   * 1,131 ms, p99 1,912 ms, worst 23,279 ms, and 0.41% of records over three
   * seconds. `eventarc_processed` now emits at `info` only at or above 3,000 ms
   * (`LAG_INFO_THRESHOLD_MS`, api-cloudrun `api-cloudrun/src/routes/eventarc.ts`) and at
   * `debug` below it, so the field's volume no longer tracks workload — which
   * is what made keeping it cheap enough to stop arguing about.
   */
  lag_ms?: number;
  // ── Scheduled-watch counters ─────────────────────────────────────
  // `il_tax_rate_check`, `tax_expiry_check`, `settlement_totals_sweep`,
  // `stock_summary_sweep`. Each emits on EVERY run including clean ones, so
  // these are the state an alert reads — not an event count.
  /** Cells / rows / ledgers examined this run. A `checked: 0` run is a finding. */
  checked?: number;
  /** `il_tax_rate_check` — cells whose published rate disagrees with the catalog. */
  divergent?: number;
  /** `il_tax_rate_check` — cells whose change has not taken effect yet. */
  pending?: number;
  /** `tax_expiry_check` — cells past their review window / approaching it. */
  expired?: number;
  expiring_soon?: number;
  /** `settlement_totals_sweep` — invoices whose stored projection disagrees. */
  drifted?: number;
  /** `settlement_totals_sweep` — invoices the fold could not reproduce. */
  unreproduced?: number;
  /** `settlement_totals_sweep` — carried #575 pins that no longer reproduce. */
  pins_stale?: number;
  /** `stock_summary_sweep` — projections repaired / that failed to repair. */
  repaired?: number;
  failed?: number;

  // ── DNS drift watch (`dns_record_check{,_resolve_failed}`) ────────
  /** The watched record's key, name and RR type. */
  record?: string;
  name?: string;
  kind?: string;
  /** Hash of what resolved, and of what was expected. */
  hash?: string;
  expected_hash?: string;
  /**
   * ⚠️ **The STRING `"true"` / `"false"`, not a boolean, and deliberately so.**
   * VictoriaLogs has no first-class boolean for log fields, so the
   * `DnsRecordDrift` rule's `filter drift:"true"` needs unambiguous semantics.
   * Typing this `boolean` would be the obvious-looking change that silently
   * empties that alert.
   */
  drift?: "true" | "false";

  // ── Location integrity watch (`location_integrity_check`) ─────────
  /** Which invariant the scan violated, on which document, and how. */
  invariant?: string;
  doc_id?: string;
  detail?: string;

  // ── Uploadcare orphan sweep (`uploadcare_orphan_sweep_completed`) ─
  /** Which corpus partition the run scanned (`prod`, `dev`, …). */
  partition?: string;
  files_scanned?: number;
  orphans_found?: number;
  deleted?: number;
  /** Orphans excluding the CI golden set — what the spike alert keys on. */
  orphans_excluding_golden?: number;
  /** Set when the anomaly breaker downgraded the run to report-only. */
  abort_reason?: string;
  /** Duplicate-filename displacement within the document-PDF set. */
  displacement_files?: number;
  displacement_groups?: number;
  displacement_group_names?: string[];

  // ── Shared across several integration msgs ────────────────────────
  /**
   * The LOGICAL Firestore collection. ⚠️ Not a Typesense physical index name —
   * that is `typesense_collection` on the typesense arm, and conflating the two
   * put 28 build names like `orders_v24_2ed14c9e` into this field until
   * 2026-08-24.
   *
   * ⚠️ **Still `string` rather than the plural-only subset of `CollectionName`,
   * which is what the campaign wants.** The narrowing needs a RUNTIME list for
   * the Zod side, and `core/tests/log-imports.test.ts` forbids a value import of
   * the schema barrel from `log/` — so the choice is a second hand-maintained
   * list (the drift this campaign exists to kill) or a design decision that
   * belongs with the rest of Phase 1. Measured helper: the corpus carries ZERO
   * singular collection values over 90 days in both envs, so the plural subset
   * does fit the data.
   */
  collection?: string;
  /** Why a best-effort step gave up — a short enum-ish token, not a message. */
  reason?: string;
  /** `dmarc_report_ingest_failed` — the Gmail message the report arrived on. */
  message_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link IntegrationEventLogRecord}. */
export const IntegrationEventLogRecordSchema: z.ZodType<IntegrationEventLogRecord> = z.object({
  ...baseLogFields,
  msg: z.enum(INTEGRATION_EVENT_MSGS),
  service: z.string().optional(),
  document_path: z.string().optional(),
  // See the field's docstring on the interface: declared rather than passed
  // through, so a misspelling fails instead of silently collecting nothing.
  lag_ms: z.number().nonnegative().optional(),
  checked: z.int().optional(),
  divergent: z.int().optional(),
  pending: z.int().optional(),
  expired: z.int().optional(),
  expiring_soon: z.int().optional(),
  drifted: z.int().optional(),
  unreproduced: z.int().optional(),
  pins_stale: z.int().optional(),
  repaired: z.int().optional(),
  failed: z.int().optional(),
  record: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  hash: z.string().optional(),
  expected_hash: z.string().optional(),
  drift: z.enum(["true", "false"]).optional(),
  invariant: z.string().optional(),
  doc_id: z.string().optional(),
  detail: z.string().optional(),
  partition: z.string().optional(),
  files_scanned: z.int().optional(),
  orphans_found: z.int().optional(),
  deleted: z.int().optional(),
  orphans_excluding_golden: z.int().optional(),
  abort_reason: z.string().optional(),
  displacement_files: z.int().optional(),
  displacement_groups: z.int().optional(),
  displacement_group_names: z.array(z.string()).optional(),
  collection: z.string().optional(),
  reason: z.string().optional(),
  message_id: z.string().optional(),
}).passthrough().meta({ title: "IntegrationEventLogRecord" });
