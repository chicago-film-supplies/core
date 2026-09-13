/**
 * Utility to derive initial/blank values from a Zod schema's structure.
 * Replaces hand-authored .meta({ initial }) blobs with schema-driven generation.
 */
import type { z } from "zod";
import { getNodeMeta } from "./zod-walk.ts";

const SKIP: unique symbol = Symbol("skip");

// deno-lint-ignore no-explicit-any
function resolveField(schema: any): unknown {
  // `.meta({ initial })` wins over everything below. It exists because the
  // storage schemas deliberately dropped their `.default()`s: a `.default()`
  // never materializes on a write (`validateBeforeWrite` discards `result.data`
  // so FieldValue sentinels survive), which let a doc reach Typesense missing a
  // field the index declares required. Dropping it makes the writer explicit —
  // but `.default()` was ALSO the form seed read here, and for the five
  // `z.boolean().default(true)` fields the type-derived zero is `false`, which
  // would have shipped new products inactive, undeliverable and not
  // pickup-eligible with nothing failing. `initial` carries the form intent
  // without carrying the parse-time behaviour.
  const meta = getNodeMeta(schema);
  if (meta && meta.initial !== undefined) return meta.initial;

  const def = schema._zod.def;

  switch (def.type) {
    case "default":
      return def.defaultValue;
    case "optional": {
      const inner = resolveField(def.innerType);
      return inner === SKIP ? SKIP : inner;
    }
    case "nullable":
      return null;
    case "pipe":
      // Produced by `.transform()` — resolve against the input side, which is
      // where a factory's own `.meta({ initial })` and `.default()` live. ⚠️ For
      // the date factories (`chicagoInstant`, `chicagoStartOfDay`) that input
      // side is an ISO-datetime string, which now resolves to SKIP rather than
      // to a seeded epoch — see `case "string"`.
      return resolveField(def.in);
    case "string":
      // 🔴 **A date gets NO seed, because there is no right one to give.** This
      // returned the epoch until core#107, and the epoch is not nullish — so it
      // survives every `input.x ?? <server default>` on the writer side rather
      // than letting the default fire. That is how 8 prod invoices reached
      // `due_date: 1969-12-31` (the Chicago-offset canonicalization of
      // `1970-01-01T00:00:00Z`), 7 of them AUTHORISED in the live Xero AR ledger
      // at ~57 years overdue. An ABSENT key is what the writer's `??` is
      // looking for.
      //
      // A field that genuinely wants a seed carries `.meta({ initial })` — but
      // that takes a static literal, so "today" is not expressible there and the
      // FORM must author it. Both live surfaces already do: `manager/src/components/settings/TaxManager.tsx`
      // (`applied_from`) and `manager/src/components/cards/MakeRecurringModal.tsx` (`active_from`).
      if (def.format === "datetime") return SKIP;
      if (def.format === "date") return SKIP;
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "record":
      return {};
    case "enum": {
      const values = Object.values(def.entries);
      return values.length > 0 ? values[0] : SKIP;
    }
    case "literal":
      return def.values[0];
    case "object": {
      const result: Record<string, unknown> = {};
      for (const [key, fieldSchema] of Object.entries(schema.shape)) {
        const val = resolveField(fieldSchema);
        if (val !== SKIP) {
          result[key] = val;
        }
      }
      return result;
    }
    case "union": {
      for (const option of def.options) {
        const val = resolveField(option);
        if (val !== SKIP) return val;
      }
      return SKIP;
    }
    case "custom":
      return SKIP;
    default:
      return SKIP;
  }
}

/**
 * Walk a Zod schema and produce an initial/blank object for form binding.
 *
 * Derives values from schema structure: `""` for strings, `0` for numbers,
 * `false` for booleans, `[]` for arrays, `{}` for records, `null` for
 * nullables, first value for enums, and recursion for objects.
 * Fields with `.default()` use the default value.
 * Custom types (e.g. FirestoreTimestamp) are omitted.
 *
 * A field annotated `.meta({ initial: <value> })` uses that value instead, at
 * any level — it is checked before the type switch, and because wrapper nodes
 * recurse, an annotation on the leaf is found through `.optional()` and
 * `.transform()` pipes too. Use it when the form seed and the parse-time
 * default must differ (see the note in `resolveField`).
 *
 * ## The return is `Partial`, and that is not conservatism — it is the truth
 *
 * The result is missing required fields, so `z.output<S>` would be a lie.
 * Four separate holes put it there, and each is visible above:
 *
 * - **`custom` nodes are omitted entirely** (`SKIP`). `FirestoreTimestamp` is
 *   `z.custom`, and `TimestampFields` puts `created_at`/`updated_at` on
 *   essentially every document schema — so *every* document's initial value is
 *   missing at least two required fields. `tests/initial.test.ts` asserts
 *   `"created_at" in result === false`, so this is pinned, not incidental.
 * - **A `union` collapses to its first resolvable arm**, so reading a property
 *   that only exists on another arm is a type error the `Partial` correctly
 *   reports rather than hides.
 * - **The partial is shallow.** Nested objects are partial in fact but typed
 *   complete, because the walk recurses while the type does not.
 * - **Every date and datetime field is omitted** (`SKIP`), as of core#107. A
 *   seeded epoch is not nullish, so it defeats the writer's
 *   `input.x ?? <default>`; an absent key is what lets that default fire. This
 *   is the widest of the four — 22 of the 222 object schemas exported from
 *   `src/schemas/mod.ts` seeded an epoch before it (measured 2026-09-13), and every
 *   `chicagoInstant()` / `chicagoStartOfDay()` field reaches it through `pipe`.
 *   `tests/initial.test.ts` sweeps all of them, so this is pinned by value
 *   rather than by location.
 *
 * `pipe` resolving the *input* side no longer produces a value for a date at
 * all — the input side of both date factories is an ISO-datetime string, which
 * SKIPs. For a non-date transform it remains latent: those are
 * `z.ZodType<string, string>`, so In ≡ Out today.
 */
export function getInitialValues<S extends z.ZodType>(schema: S): Partial<z.output<S>> {
  const result = resolveField(schema);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("getInitialValues requires an object schema");
  }
  return result as Partial<z.output<S>>;
}
