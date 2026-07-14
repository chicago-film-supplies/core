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

/**
 * Field names that MUST carry a `pii` meta when they appear at any depth in a
 * schema — matched against EVERY segment of a leaf's path, not just the last.
 *
 * The any-segment rule is load-bearing: `address` and `billing_address` are
 * object-typed everywhere in core, so they are never a leaf's own name. A
 * leaf-only match would make those two entries dead letters and would miss an
 * untagged address container entirely — which is the exact class of bug the
 * `Address` object-level tag was introduced to fix.
 */
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
  // Below: names the codebase ALREADY hand-tags but the dictionary could not
  // enforce, so the tags were decorative. Each was measured to cost zero new
  // annotations before being added — except `filename`, which cost exactly one
  // (`template_previews::filename`, which a template author can interpolate an
  // organization name into via `renderConfig.filename`).
  "first_name",
  "middle_name",
  "last_name",
  "pronunciation",
  "body_text",
  "title",
  "instructions",
  "filename",
]);

/** Field name treated as sensitive only inside contact / org / user-adjacent schemas. */
export const SENSITIVE_NAME_FIELD = "name";

/**
 * Schemas in which a bare `name` field is a PERSON or ORGANIZATION name rather
 * than a label, keyed by `schemas`-record key or by exported input-schema name.
 *
 * This replaces the `nameIsSensitive` boolean that used to live in
 * `tests/pii.test.ts`'s hand-maintained schema tuple. It has to be explicit:
 * `name` means a customer in `contact`, and a catalog product in `product`, and
 * nothing structural distinguishes them. Defaults to FALSE for any schema not
 * listed — an unlisted schema's `name` is treated as a label.
 *
 * A parent-segment heuristic is not a substitute: a root-level `name` has no
 * parent segment, so it would silently drop `contact::name` itself.
 */
export const NAME_SENSITIVE: ReadonlySet<string> = new Set([
  "contact",
  "contacts",
  "organization",
  "organizations",
  "user",
  "users",
  "CreateContactInput",
  "UpdateContactInput",
  "NewContactInput",
  "CreateOrganizationInput",
  "UpdateOrganizationInput",
]);
