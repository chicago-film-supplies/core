/**
 * Typesense/storage schema parity.
 *
 * Every collection carries two schemas that are edited independently and were
 * never compared: the Firestore storage schema (`src/schemas/<doc>.ts`) and the
 * Typesense collection config (`src/schemas/typesense/<doc>.ts`). When the index
 * declares a field required and the storage schema lets a doc omit it, that doc
 * can never index — Typesense rejects the upsert with a remote error that does
 * not name the document. This test is the preventive half of that; the runtime
 * half is `missingRequiredTypesenseFields` in api-cloudrun's
 * `lib/typesenseTranslate.ts`, which catches the same class pre-POST.
 *
 * ## Why `.default()` does not save you
 *
 * `validateBeforeWrite` (api-cloudrun `lib/validate.ts`) parses the doc and then
 * **discards `result.data`** — every writer writes the raw object, so
 * `FieldValue` sentinels survive the round trip. A schema `.default()` therefore
 * never materializes on a write: it makes the parse pass while the stored doc
 * stays missing the field. `products.eligible_shipping_ground` was exactly this,
 * and it produced 133 `sync_error`s over one retention window.
 *
 * So the question this test asks is not "does the field have a default" but
 * "does this member reject `undefined`" — `safeParse(undefined)`. That is the
 * semantically right question, and it also correctly flags a bare
 * `z.custom<T>()` with no validator, which accepts `undefined` while looking
 * nothing like an optional.
 *
 * ## Scope
 *
 * - **Every** entry in `typesenseSchemas`, including `enabled: false` ones.
 *   `threads` is disabled today and `threads.comment_count` was a live gap;
 *   scanning only enabled collections means provisioning `threads` or
 *   `bookings` later silently reintroduces the bug this test exists to prevent.
 * - **Top-level fields only.** Under an `object[]` parent the translated value
 *   is a flattened array, so a dotted name does not correspond to a storage
 *   member the way a top-level one does. Every failure observed in production
 *   so far has been top-level.
 *
 * ## What this test cannot see
 *
 * A stored doc that violates its own storage schema. Those reach Firestore
 * through paths that skip `validateBeforeWrite` — raw `ref.set` in test
 * helpers, narrow sentinel patches, `UNVALIDATED_COLLECTIONS`, scripts, the
 * prod→dev mirror — and no static check in this package can observe them.
 * That is what `api-cloudrun/scripts/audit-typesense-required-fields.ts` is for.
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

import { schemaFor } from "../src/schemas/mod.ts";
import { typesenseSchemas } from "../src/schemas/typesense/mod.ts";

/**
 * Known-and-accepted gaps, keyed `"<alias>.<field>"` with the reason as the
 * value — an entry cannot exist without a why. Same shape and same intent as
 * `AMBIGUOUS` in `tests/pii.test.ts`.
 *
 * The no-stale-entries test below is what makes this a ratchet rather than a
 * drawer: an exemption that outlives the gap it exempts reads as a considered
 * decision when it is really a leftover.
 */
const ALLOWED_GAPS: Record<string, string> = {
  "orders.dates": "Not a storage field at all — synthesized at index time by " +
    "`deriveOrderDateEnvelope` in api-cloudrun's `translateForTypesense`.",
  "fulfillments.dates": "Same as orders.dates — synthesized by " +
    "`deriveOrderDateEnvelope`, never stored.",
  "tags.count": "`.optional()` only because `validateBeforeWrite` strips a " +
    "top-level FieldValue sentinel by OMITTING the key, so a sentinel write " +
    "would reach `safeParse` as an absent field. Forward tolerance, not a live " +
    "case: api-cloudrun#243 moved both writers to a transactional " +
    "read-modify-write of a concrete number, and 45 prod / 45 dev tag docs all " +
    "hold one (measured 2026-08-10, zero records). The type is now plain " +
    "`z.int()` — the old `Record<FieldValue> | number` union was believed to be " +
    "what permitted a sentinel and was not; the optionality is. Marking it " +
    "`optional: true` in the Typesense config is also not obviously available " +
    "— it is `tags.default_sorting_field`, and the Typesense docs do not state " +
    "whether that may be optional. Verify against a scratch dev collection " +
    "before ever taking that route.",
  "tracking-categories.count": "Same as tags.count — an optional concrete " +
    "counter serving as `default_sorting_field`. 21 prod / 21 dev docs, all " +
    "concrete integers.",
};

/** A field the index requires that the storage schema does not guarantee. */
interface Gap {
  key: string;
  kind: "missing-from-schema" | "accepts-undefined";
  label: string;
}

// deno-lint-ignore no-explicit-any
function defOf(node: unknown): any {
  return (node as { _zod: { def: unknown } })._zod.def;
}

/**
 * Describe *why* a member accepts `undefined`, so the failure message names the
 * fix. Uses the `_zod.def` type discriminator for labelling only — the verdict
 * itself is always `safeParse(undefined)`.
 */
function describeMember(member: z.ZodType): string {
  const def = defOf(member);
  switch (def.type) {
    case "default":
      return `.default(${JSON.stringify(def.defaultValue)})`;
    case "prefault":
      return `.prefault(${JSON.stringify(def.defaultValue)})`;
    case "optional":
      return ".optional()";
    case "catch":
      return ".catch(…)";
    case "custom":
      return "z.custom() with no validator (accepts undefined)";
    default:
      return `.${def.type} — accepts undefined`;
  }
}

/** Every parity gap across every configured collection, enabled or not. */
function findGaps(): Gap[] {
  const gaps: Gap[] = [];

  for (const [alias, config] of Object.entries(typesenseSchemas)) {
    // `firestoreCollection` is a `CollectionName` — the lookup cannot miss.
    const storage = schemaFor(config.firestoreCollection);
    // A config pointed at a collection with no storage schema would make this
    // whole test silently blind for that collection, so it is a hard failure
    // rather than a skip.
    if (!storage) {
      gaps.push({
        key: `${alias}.*`,
        kind: "missing-from-schema",
        label: `no storage schema registered for firestoreCollection ` +
          `"${config.firestoreCollection}"`,
      });
      continue;
    }
    const shape = defOf(storage).shape as Record<string, z.ZodType> | undefined;
    if (!shape) {
      gaps.push({
        key: `${alias}.*`,
        kind: "missing-from-schema",
        label: `storage schema for "${config.firestoreCollection}" is not an object`,
      });
      continue;
    }

    for (const field of config.schema.fields) {
      if (field.optional === true) continue;
      if (field.name.includes(".")) continue;

      const key = `${alias}.${field.name}`;
      const member = shape[field.name];

      // Check A — the field exists in the storage schema at all. `templates.scope`
      // was this: required by the index, absent from the schema, 30 sync_errors.
      if (!member) {
        gaps.push({
          key,
          kind: "missing-from-schema",
          label: "not present in the storage schema's shape",
        });
        continue;
      }

      // Check B — the member rejects `undefined`.
      if (member.safeParse(undefined).success) {
        gaps.push({ key, kind: "accepts-undefined", label: describeMember(member) });
      }
    }
  }

  return gaps;
}

Deno.test("typesense parity: every required index field is guaranteed by the storage schema", () => {
  const unexpected = findGaps()
    .filter((gap) => !(gap.key in ALLOWED_GAPS))
    .sort((a, b) => a.key.localeCompare(b.key));

  assertEquals(
    unexpected.map((g) => `${g.key} — ${g.label}`),
    [],
    "These fields are declared required in a Typesense collection config but " +
      "the storage schema lets a document omit them, so such a document can " +
      "never index.\n\n" +
      "Fix by making the storage member required (drop the `.default()`; move " +
      "the form seed to `.meta({ initial: <value> })` if the create form " +
      "depended on it). Do NOT mark the field `optional: true` in the Typesense " +
      "config — that is a collection version bump and a full reindex.\n\n" +
      "If a writer genuinely cannot supply the field, add it to ALLOWED_GAPS " +
      "with the reason.\n\n" +
      unexpected.map((g) => `  ${g.key} — ${g.label}`).join("\n"),
  );
});

Deno.test("typesense parity: no stale ALLOWED_GAPS entry", () => {
  const live = new Set(findGaps().map((gap) => gap.key));
  const stale = Object.keys(ALLOWED_GAPS).filter((key) => !live.has(key)).sort();

  assertEquals(
    stale,
    [],
    "These ALLOWED_GAPS entries no longer describe a real gap — the storage " +
      "schema now guarantees the field, or the index no longer requires it. " +
      "Delete them; an exemption that outlives its gap reads as a decision " +
      "when it is a leftover.\n" +
      stale.map((k) => `  ${k}`).join("\n"),
  );
});

Deno.test("typesense parity: every ALLOWED_GAPS entry carries a non-trivial reason", () => {
  const unexplained = Object.entries(ALLOWED_GAPS)
    .filter(([, reason]) => reason.trim().length < 20)
    .map(([key]) => key)
    .sort();

  assertEquals(
    unexplained,
    [],
    `These ALLOWED_GAPS entries have no usable reason:\n${unexplained.join("\n")}`,
  );
});
