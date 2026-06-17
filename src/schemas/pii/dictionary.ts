/**
 * Sensitive field-name dictionary for schema-time PII enforcement.
 *
 * Imported by `tests/pii.test.ts` to assert that every matching field in
 * document and input schemas carries a `.meta({ pii: ... })` annotation.
 *
 * IMPORTANT: this is the *schema-enforcement* set, not the runtime denylist.
 * The schema set tolerates ambiguous tokens like `address` and `name`
 * because the enforcement walker disambiguates by surrounding schema
 * context (e.g. `name` is only sensitive inside contact/org/user schemas —
 * see `SENSITIVE_NAME_FIELD` + the `nameIsSensitive` flag in `pii.test.ts`).
 *
 * For the runtime key-name scrubber, see `./runtime-denylist.ts` — a
 * *curated* set that drops the ambiguous tokens and adds transport / secret
 * / network identifiers that are never schema fields but absolutely appear
 * in log payloads (Authorization headers, OAuth tokens, source IPs, etc.).
 */

/** Field names that MUST carry a `pii` meta when they appear at any depth in a schema. */
export const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  "email",
  "emails",
  "password",
  "password_hash",
  "token",
  "user_id",
  "phones",
  "billing_address",
  "address",
  "external_notes",
  "internal_notes",
]);

/** Field name treated as sensitive only inside contact / org / user-adjacent schemas. */
export const SENSITIVE_NAME_FIELD = "name";
