/**
 * DMARC aggregate-report log record — one per record parsed from an
 * inbound DMARC aggregate report (emitted by the DMARC ingest pipeline in
 * api-cloudrun).
 *
 * This is the **dominant current PII surface in logs** as of 2026-05-27 —
 * 3,772 hits per field in prod over 4 days. `source_ip`, `header_from`,
 * and `org_name` are PII (or PII-adjacent) per GDPR (Recital 30: IP
 * addresses are online identifiers).
 *
 * Tagged accordingly so the schema-driven walker in `@cfs/schemas/pii`
 * masks them automatically — no per-call-site work needed.
 *
 * First-class subsystem: `DmarcSpoofingAttempt` and
 * `DmarcReportIngestFailed` vmalert rules already alert on these records
 * (`infra/observability/vmalert/rules-vlogs.yml` in api-cloudrun).
 */

import { z } from "zod";
import { baseLogFields, type LogLevelType } from "./base.ts";

/** Structured log entry for one record from a DMARC aggregate report. */
export interface DmarcAggregateLogRecord {
  level: LogLevelType;
  msg: "dmarc_aggregate_record";
  ts: string;
  source_ip: string;
  count: number;
  disposition: string;
  dkim_result: string;
  spf_result: string;
  dkim_aligned: boolean;
  spf_aligned: boolean;
  header_from: string;
  org_name: string;
  report_id: string;
  domain: string;
  date_range_begin: number;
  date_range_end: number;
  dmarc_pass: boolean;
  request_id?: string;
  method?: string;
  path?: string;
  route?: string;
  user_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

/** Zod schema for {@link DmarcAggregateLogRecord}. */
export const DmarcAggregateLogRecordSchema: z.ZodType<DmarcAggregateLogRecord> = z.object({
  ...baseLogFields,
  msg: z.literal("dmarc_aggregate_record"),
  // Sending-server IP. GDPR online identifier — mask.
  source_ip: z.string().meta({ pii: "mask" }),
  count: z.number(),
  disposition: z.string(),
  dkim_result: z.string(),
  spf_result: z.string(),
  dkim_aligned: z.boolean(),
  spf_aligned: z.boolean(),
  // The From: header domain in the messages this report covers. Mask to
  // avoid leaking third-party sender identities when reports cover
  // forwarded / spoofed mail.
  header_from: z.string().meta({ pii: "mask" }),
  // Reporting organization (e.g. "google.com"). Mask for the same reason.
  org_name: z.string().meta({ pii: "mask" }),
  report_id: z.string(),
  domain: z.string(),
  date_range_begin: z.number(),
  date_range_end: z.number(),
  dmarc_pass: z.boolean(),
}).passthrough().meta({ title: "DmarcAggregateLogRecord" });
