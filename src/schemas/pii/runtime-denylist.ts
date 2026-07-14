/**
 * Runtime key-name denylist for the structured logger's untyped-passthrough
 * scrub tier. Recursive **exact-key** match (NOT substring) against log
 * payload keys; matching values are redacted in-place.
 *
 * Curated set, intentionally different from the schema-enforcement
 * dictionary (`./dictionary.ts`):
 *
 * - **Drops** ambiguous tokens like `name` and bare `address` — too noisy
 *   in logs that legitimately carry `store_name`, `collection_name`,
 *   `delivery_address`, etc. Schema-level PII tags handle the
 *   contact/org/user cases via the walker; runtime denylist is the safety
 *   net for the un-schematized passthrough surface.
 * - **Adds** transport / secret / network identifiers that are never schema
 *   fields but absolutely flow through log payloads (Authorization headers,
 *   OAuth tokens, request-source IPs).
 *
 * Empirically validated against 316k log records (dev + prod, 2026-05-23 →
 * 2026-05-27): no `email` / `phone` / `address` / `password` / `token` keys
 * appear in current logs at all — but `source_ip` and `header_from` do
 * (DMARC ingest, 3,772 hits each in prod), which is why those are here.
 *
 * The `_debug` suffix convention is intentionally OUT of this denylist's
 * purview: `*_debug` fields are an internal-diagnostics marker, not a
 * sensitivity marker — `refreshed_at_debug` and friends are deliberately
 * present in logs for ops correlation.
 */
export const RUNTIME_DENYLIST: ReadonlySet<string> = new Set([
  // Schema dictionary subset (unambiguous in any context).
  //
  // This block is not curated by hand any more — `tests/pii.test.ts` asserts
  // RUNTIME_DENYLIST ⊇ (SENSITIVE_EXACT \ AMBIGUOUS), so every schema-sensitive
  // name that is not explicitly exempted in `AMBIGUOUS` MUST appear here. Add a
  // name to the schema dictionary and the test tells you to make a call about
  // this list; it can no longer drift silently.
  "email",
  "emails",
  "password",
  "password_hash",
  "token",
  "phones",
  "billing_address",
  "external_notes",
  "internal_notes",
  // Person-name parts. Unambiguous: a log key literally called `first_name`
  // holds a first name. (`name` itself is the opposite — see AMBIGUOUS.)
  "first_name",
  "middle_name",
  "last_name",
  "pronunciation",
  // User-authored free text — comment/card bodies and delivery instructions.
  "body_text",
  "instructions",
  // Transport / secret keys (never schema fields, but appear in log payloads)
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "secret",
  "access_token",
  "refresh_token",
  "client_secret",
  "bearer",
  // Network identifiers (GDPR PII — IP addresses + email-from headers)
  "source_ip",
  "ip",
  "header_from",
]);
