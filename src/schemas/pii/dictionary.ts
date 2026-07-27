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
  // DELIBERATELY ABSENT: `description`, `reference`, `label`, `subject` (#35).
  //
  // All four were measured as dictionary candidates and rejected on the domain
  // call, not on churn cost. They carry business identifiers and catalog text —
  // PO numbers, destination names, product and equipment wording — not customer
  // data. Adding them would flag ~63 leaves that would all be annotated
  // `pii: "none"`, which buys enforcement of a rule that has nothing to enforce.
  //
  // The one thing that reading DID surface is now fixed: every
  // `items[].description` in the package (order, invoice, fulfillment and their
  // input schemas) had drifted into three different answers — `mask` on the
  // order/invoice docs, untagged on fulfillment and the invoice inputs. They all
  // say `pii: "none"` now. See `OrderDocLineItem.description`.
  //
  // `subject` is worth one caveat if this is ever revisited: it is bimodal.
  // `card::subject`, `recurrence::prototype.subject` and the two log arms are
  // email subject lines and card titles that stay `mask`; the order / invoice /
  // booking / fulfillment `subject` fields are business labels. A dictionary
  // entry cannot tell those apart, which is a second reason it is not one.
]);

/** Field name treated as sensitive only inside contact / org / user-adjacent schemas. */
export const SENSITIVE_NAME_FIELD = "name";

/**
 * Schema-sensitive names that are deliberately NOT in `RUNTIME_DENYLIST`.
 *
 * The two sets do different jobs and are allowed to differ — but only here, and
 * only on purpose. `tests/pii.test.ts` asserts
 *
 *     RUNTIME_DENYLIST ⊇ (SENSITIVE_EXACT \ AMBIGUOUS)
 *
 * so adding a name to the schema dictionary now forces a decision about the
 * runtime scrubber instead of silently letting the two drift. It also asserts
 * the reverse — every name here must still BE schema-sensitive — so a stale
 * exemption cannot outlive the dictionary entry it exempts.
 *
 * Each entry earns its place by being a false-positive magnet in an untyped log
 * payload, where the scrubber matches raw key names with no schema context:
 *
 * - `address` — logs legitimately carry `delivery_address`, `store_address`.
 * - `name` — `store_name`, `collection_name`, `template_name`. The single
 *   noisiest token there is; this is why the schema side gates it on
 *   {@link NAME_SENSITIVE} rather than matching it everywhere.
 * - `title` — a thread title is user text, but `.meta({ title })` is *schema
 *   metadata* and `title` is a routine ops field. Unusable as a runtime key.
 * - `filename` — PII in `template_previews` only because a template author can
 *   interpolate an organization name into it. As a raw log key it is almost
 *   always a script, bundle, or render artefact, and redacting those blinds ops.
 * - `user_id` — in the dictionary so a NEW `user_id` field is forced to make an
 *   explicit call, but every existing one is tagged `pii: "none"`: it is an
 *   internal Firestore uid, not customer data, and it is a deliberate log
 *   correlation key. Redacting it at runtime would be actively harmful.
 */
export const AMBIGUOUS: ReadonlySet<string> = new Set([
  "address",
  "name",
  "title",
  "filename",
  "user_id",
]);

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
