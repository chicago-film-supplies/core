/**
 * Propagation log record — one per cascade rule execution OR per atomic
 * transaction commit (see `api-cloudrun/src/lib/logPropagation.ts` in api-cloudrun for
 * the two emission paths).
 *
 * Validated at construction time in `logPropagation()` /
 * `logTransactionPropagation()` before emission.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";
// ⚠️ Imported, not redeclared. These five used to be written out again here, so
// the catalog's vocabulary and this record's enum agreed by coincidence and a
// sixth mode added to one would not have failed anything (Tier 1 item 9). The
// catalog DEFINES a propagation mode; this record only reports one.
import { PROPAGATION_MODES } from "../propagation/types.ts";

const PROPAGATION_STATUSES = ["completed", "skipped", "failed"] as const;

/** Status outcome of a propagation rule execution. */
export type PropagationStatusType = (typeof PROPAGATION_STATUSES)[number];
/** Propagation strategy used by a rule. */
export type PropagationModeType = (typeof PROPAGATION_MODES)[number];

/**
 * Structured log entry for a propagation event.
 *
 * ⚠️ **Two record shapes share this arm, and the five rule-derived fields are
 * what tell them apart.** A RULE record (`rule_id`, `source`, `target`, `mode`,
 * `fields_declared`) describes one edge; a TRANSACTION record describes a
 * transaction that legitimately propagated nothing and therefore has no rule to
 * derive them from.
 *
 * Those five used to be REQUIRED, which made *"this path ran and correctly
 * cascaded nothing"* unrepresentable — and the three spellings that grew around
 * the hole are the evidence it mattered. `logTransactionPropagation`
 * short-circuited an empty `rules_fired` into a bare `log.warn`, so
 * `createTransaction`/`reverseTransaction`/`createStoreTransfer` reported an
 * idempotent replay as **drift** (*"No propagation rules fired but transaction
 * expects 2"*); `syncXeroPayments` suppressed the record entirely and the replay
 * became invisible; and `updateFulfillmentItems` gave up and emitted under a
 * different archetype. `status: "skipped"` was in the enum the whole time and
 * no transaction could reach it.
 */
export interface PropagationLogRecord {
  level: LogLevelType;
  msg: "propagation";
  ts: string;
  /** Absent on a transaction record that fired no rules. */
  rule_id?: string;
  /** Absent on a transaction record that fired no rules. */
  source?: string;
  /** Absent on a transaction record that fired no rules. */
  target?: string;
  /** Absent on a transaction record that fired no rules. */
  mode?: PropagationModeType;
  transaction?: string;
  /**
   * How many field mappings the fired rule DECLARES.
   *
   * ⚠️ Renamed from `fields_mapped`, which read as a measurement and was a
   * declaration echo: its one producer is `rule.fields.length`, so it is a
   * constant per rule id and identical on every record forever. It can never
   * disagree with anything. Absent on a transaction record that fired no rules.
   */
  fields_declared?: number;
  source_doc_id?: string;
  target_doc_id?: string;
  status: PropagationStatusType;
  duration_ms?: number;
  error?: string;
  rules_fired?: string[];
  rules_fired_count?: number;
  rules_expected?: number;
  target_counts?: Record<string, number>;
  target_count?: number;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link PropagationLogRecord}. */
export const PropagationLogRecordSchema: z.ZodType<PropagationLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("propagation"),
  rule_id: z.string().optional(),
  source: z.string().optional(),
  target: z.string().optional(),
  mode: z.enum(PROPAGATION_MODES).optional(),
  transaction: z.string().optional(),
  fields_declared: z.number().optional(),
  source_doc_id: z.string().optional(),
  target_doc_id: z.string().optional(),
  status: z.enum(PROPAGATION_STATUSES),
  error: z.string().max(2048).optional(),
  rules_fired: z.array(z.string()).optional(),
  rules_fired_count: z.number().optional(),
  rules_expected: z.number().optional(),
  target_counts: z.record(z.string(), z.number()).optional(),
  target_count: z.number().optional(),
}).passthrough().meta({ title: "PropagationLogRecord" });
