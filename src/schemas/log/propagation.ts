/**
 * Propagation log record — one per cascade rule execution OR per atomic
 * transaction commit (see `src/lib/logPropagation.ts` in api-cloudrun for
 * the two emission paths).
 *
 * Validated at construction time in `logPropagation()` /
 * `logTransactionPropagation()` before emission.
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

const PROPAGATION_MODES = ["embed", "fan-out", "co-write", "derive", "reference"] as const;
const PROPAGATION_STATUSES = ["completed", "skipped", "failed"] as const;

/** Status outcome of a propagation rule execution. */
export type PropagationStatusType = (typeof PROPAGATION_STATUSES)[number];
/** Propagation strategy used by a rule. */
export type PropagationModeType = (typeof PROPAGATION_MODES)[number];

/** Structured log entry for a single propagation rule execution. */
export interface PropagationLogRecord {
  level: LogLevelType;
  msg: "propagation";
  ts: string;
  rule_id: string;
  source: string;
  target: string;
  mode: PropagationModeType;
  transaction?: string;
  fields_mapped: number;
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
  rule_id: z.string(),
  source: z.string(),
  target: z.string(),
  mode: z.enum(PROPAGATION_MODES),
  transaction: z.string().optional(),
  fields_mapped: z.number(),
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
