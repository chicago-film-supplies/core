/**
 * Keys that the runtime scrubber MUST preserve untouched, regardless of
 * value content. Protects against accidental over-scrubbing — without this
 * allowlist, a `request_id` UUID that happens to match a regex pattern
 * could be redacted, breaking trace correlation across logs.
 *
 * Strictly limited to structural / diagnostic fields that are *definitionally*
 * not personal data:
 *
 * - log envelope fields (`level`, `msg`, `ts`)
 * - correlation IDs (`request_id`, `trace_id`, `span_id`)
 * - HTTP routing metadata (`route`, `method`, `path`, `status`)
 * - timing / size measurements (`duration_ms`, `write_count`, etc.)
 * - schema-event identifiers (`tx_name`, `rule_id`, `source_doc_id`, `collection`)
 *
 * Any field whose value is *user-supplied* (even if it currently appears
 * benign) belongs in the schema as a `pii`-tagged field instead, NOT here.
 */
export const SAFE_PASSTHROUGH: ReadonlySet<string> = new Set([
  // Envelope
  "level",
  "msg",
  "ts",
  // Correlation
  "request_id",
  "trace_id",
  "span_id",
  // HTTP
  "route",
  "method",
  "path",
  "status",
  // Timing / size
  "duration_ms",
  "write_count",
  "estimated_json_bytes",
  "fields_declared",
  "rules_fired_count",
  "rules_expected",
  "target_count",
  "dry_run",
  // Event identifiers (opaque, never PII)
  "tx_name",
  "rule_id",
  "source_doc_id",
  "target_doc_id",
  "collection",
  "transaction",
  "source",
  "target",
  "mode",
]);
