/**
 * Schema-driven PII walker. Given a record and the Zod schema it conforms
 * to, walks the schema's `.meta({ pii })` tags and applies the supplied
 * strategy's leaf transform to each tagged field.
 *
 * Built on `../zod-walk.ts`. Unwraps `Optional` / `Nullable` / `Default` /
 * `Prefault` / `Catch` wrappers so that `z.email().meta({pii:"mask"}).optional()`
 * is treated as a `mask`-tagged email at the field position.
 *
 * - **Arrays of primitives** with a `pii`-tagged element schema: applies
 *   the transform per-element (e.g. `z.array(Email)`).
 * - **Arrays of objects**: recurses into each element using the element schema.
 * - **Nested objects**: recurses, applying the same walker logic.
 * - **`z.record()`**: recurses into every entry against the record's VALUE
 *   schema. The path segment is the literal `<key>`, never the map key — a map
 *   key is exactly as arbitrary as an array index (which the array arm likewise
 *   omits), and it matches the grammar `collectLeafPaths` emits.
 * - **Bare unions** (a union in a field position, not just as an array element):
 *   narrowed to the member matching the value's literal/enum discriminator, then
 *   walked.
 * - **`.passthrough()` extras / un-shaped values**: left untouched — the runtime
 *   key-name denylist tier (separate, in the logger) handles those.
 *
 * Inside a TAGGED subtree the walker **fails closed**: a container it cannot
 * descend (a `z.custom`, a `z.date`, a union no discriminator resolves) is
 * `[REDACTED]` wholesale rather than passed through raw. A tag the walker cannot
 * honour must not quietly ship the value.
 *
 * The {@link PiiStrategy} interface is the seam for non-logger consumers —
 * notably the upcoming templates golden-diff fixture sanitizer, which
 * reuses this same walker with a strategy that emits plausible synthetic
 * fakes instead of `[REDACTED]`. The walker has no opinion about what the
 * leaf transform does; it only routes by classification.
 *
 * @example
 *   const strategy = createLoggerStrategy(Deno.env.get("LOG_HMAC_KEY"));
 *   const masked = applyPii(record, DmarcAggregateLogRecordSchema, strategy);
 *   //                            ^ walker discovers `source_ip: pii:"mask"`,
 *   //                              `header_from: pii:"mask"` automatically.
 */

import type { z } from "zod";
import { readMetaThroughWrappers, unwrapNonArray, unwrapZod } from "../zod-walk.ts";
import type { PiiClassification } from "./classification.ts";
import { mask, redact } from "./transforms.ts";

/**
 * Read a field's `pii` classification, checking every wrapper level.
 *
 * The one reader for both the runtime walker and the schema-drift test
 * (`tests/pii.test.ts`) — they used to disagree about *where* a tag lives (the
 * test walked the wrapper chain, the walker unwrapped first and read only the
 * final node), which is exactly how `Address`'s object-level `pii: "mask"`
 * stayed green in the test while doing nothing at runtime.
 */
export function readPiiTag(node: z.ZodType): PiiClassification | undefined {
  return readMetaThroughWrappers<PiiClassification>(node, "pii");
}

// ── Strategy interface ──────────────────────────────────────────────

/**
 * How to transform a leaf value given its PII classification. Consumers
 * provide their own strategy; the structured logger uses
 * {@link createLoggerStrategy} below.
 *
 * The walker calls `apply` with the leaf value, the field's classification,
 * and the dotted field path (for strategies that want path-dependent output
 * like the fixture sanitizer's deterministic fakes).
 *
 * `apply` is also offered every CONTAINER inside a tagged subtree (the tagged
 * object itself, each nested object/array within it, and each ENTRY of a nested
 * `z.record`, at `path.<key>`) before the walker recurses into it. An untagged
 * record's own object is never offered — only its entries, and only once a tag
 * is in scope. Return the value unchanged to let the walker keep descending to
 * the leaves; return anything else to replace the container wholesale and stop
 * the descent. The fixture sanitizer uses this to null a whole `Coordinates`
 * object — a leaf-by-leaf transform cannot, because `latitude` is a `z.number()`
 * and there is no in-band "absent" value for it.
 */
export interface PiiStrategy {
  apply(value: unknown, classification: PiiClassification, fieldPath: string): unknown;
}

/**
 * Default strategy for the structured logger.
 *
 * - `mask`   → partial reveal via {@link mask}
 * - `redact` → literal `[REDACTED]`
 * - `hash`   → calls `hashFn(value)` if supplied; otherwise FAIL-CLOSED to
 *              `redact()` (never raw passthrough, never throws). Logging
 *              must never throw, so a missing key degrades gracefully.
 * - `none`   → pass through unchanged
 *
 * **Non-string SCALARS under a tag fail closed** — a number or boolean is
 * `[REDACTED]`, not passed through. It used to pass through, which meant a
 * numeric leaf inside a tagged subtree was never scrubbed:
 * `Address.address_coordinates` is a 6dp geocode (≈0.11 m) and went to the log
 * raw. That was survivable only while no log record schema embedded an
 * `Address`, an invariant nothing enforced (it is now pinned by
 * `tests/log-imports.test.ts`) and which was never the real guarantee anyway —
 * a log arm can write `z.number().meta({pii:"mask"})` inline without importing
 * anything at all.
 *
 * Two deliberate passthroughs remain:
 *
 * - **`null` / `undefined`** — they carry no PII, and callers rely on the
 *   absent-stays-absent contract.
 * - **Containers (objects and arrays)** — returned by reference so the walker
 *   keeps descending to the leaves. This is load-bearing, not an oversight:
 *   {@link PiiStrategy} is offered every container before descent and treats a
 *   changed return value as "replace this wholesale and stop", so redacting here
 *   would collapse a masked `Address` to a single `"[REDACTED]"` string and
 *   destroy the `city` / `region` / `country_name` `pii: "none"` opt-outs inside
 *   it.
 *
 * Returning a container by reference is therefore a *descend* instruction, never
 * a passthrough — and the walker holds up its end: a tagged container it cannot
 * descend (an OBJECT-shaped scalar such as a `Date` or a Firestore `Timestamp`)
 * is redacted by {@link applyPii} itself rather than emitted raw. It used to be
 * emitted raw; nothing in this file guaranteed otherwise except the observation
 * that no schema had one under a tag.
 *
 * @param hashFn Optional sync HMAC function. The api-cloudrun logger
 *               supplies `(v) => nodeHash(v, LOG_HMAC_KEY)`; browser
 *               consumers omit it (no sync HMAC available — manager
 *               pre-scrub should only use `mask` / `redact` classifications
 *               in its records).
 */
export function createLoggerStrategy(hashFn?: (value: string) => string): PiiStrategy {
  return {
    apply(value, classification) {
      if (classification === "none") return value;
      if (value === null || value === undefined) return value;
      // Containers descend; see the note above. MUST be by reference.
      if (typeof value === "object") return value;
      // Any other non-string scalar under a tag: fail closed.
      if (typeof value !== "string") return redact();

      switch (classification) {
        case "mask":
          return mask(value);
        case "redact":
          return redact();
        case "hash":
          return hashFn ? hashFn(value) : redact();
        default:
          return value;
      }
    },
  };
}

// ── Walker internals ────────────────────────────────────────────────

interface ZodInternalDef {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  /** Value schema of a `z.record(keyType, valueType)`. */
  valueType?: z.ZodType;
  options?: z.ZodType[];
  /** `discriminatedUnion` only — the key Zod itself discriminates on. */
  discriminator?: string;
  /** `literal` def values (Zod 4 stores the literal set as an array). */
  values?: unknown[];
  /** Older / non-Zod-4 literal def shape. */
  value?: unknown;
  /** `enum` def — Zod 4 stores entries as a record `{member: member, ...}`. */
  entries?: Record<string, unknown>;
}

/**
 * The path segment a record's entries are reported under. A dynamic map key is
 * exactly as arbitrary as an array index — and the array arm deliberately emits
 * no index, because the fixture sanitizer seeds its deterministic fakes on
 * `(path, value)` and a reordered array would otherwise reseed every one of them
 * and churn every golden. Also the grammar `collectLeafPaths` already emits, so
 * the lint's leaf set and the runtime's offered paths are directly comparable.
 */
const RECORD_KEY_SEGMENT = "<key>";

function getDef(node: z.ZodType): ZodInternalDef {
  return (node as unknown as { _zod: { def: ZodInternalDef } })._zod.def;
}

function getShape(node: z.ZodType): Record<string, z.ZodType> | null {
  return getDef(unwrapZod(node)).shape ?? null;
}

/**
 * The value set a discriminated-union member accepts at each of its
 * literal/enum-valued keys — the map Zod builds to discriminate with.
 */
function getPropValues(node: z.ZodType): Record<string, Set<unknown>> | undefined {
  return (node as unknown as { _zod?: { propValues?: Record<string, Set<unknown>> } })._zod?.propValues;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve a union schema down to the single member matching `record`'s shape.
 * Returns the matched member, or `null` if `node` isn't a union or no member
 * discriminates. We never guess: a member with no discriminator is skipped, and
 * an unresolved union fails closed at the call site.
 *
 * Two paths, and the first is the one that should fire:
 *
 * 1. **`z.discriminatedUnion()`** — `def.discriminator` names the key and each
 *    member's `propValues` holds the values it claims. That is Zod's own
 *    dispatch table, so the answer is exact rather than inferred. Every item
 *    union (order, invoice, fulfillment) takes this path.
 * 2. **`z.union()` of objects** — no dispatch table exists, so fall back to
 *    scanning members for literal/enum-valued keys. Still reached by real
 *    schemas (`TypesenseSynonymSchema`), so it stays.
 */
function resolveUnionMember(
  node: z.ZodType,
  record: Record<string, unknown>,
): z.ZodType | null {
  const def = getDef(unwrapZod(node));
  if (def.type !== "union" || !def.options) return null;

  if (def.discriminator !== undefined) {
    const key = def.discriminator;
    const value = record[key];
    for (const member of def.options) {
      if (getPropValues(member)?.[key]?.has(value)) return member;
    }
    return null;
  }
  // Pass 1 — prefer a member whose literal discriminator(s) match exactly.
  // Pass 2 — fall back to a member whose enum discriminator includes the value.
  for (const passRequiresLiteral of [true, false]) {
    for (const member of def.options) {
      const memberShape = getShape(member);
      if (!memberShape) continue;
      let hasDiscriminator = false;
      let allMatched = true;
      for (const [key, fieldSchema] of Object.entries(memberShape)) {
        const fieldDef = getDef(unwrapZod(fieldSchema));
        let expected: unknown[] | null = null;
        if (fieldDef.type === "literal") {
          // Zod 4 literals carry a `values` array; older builds use `value`.
          expected = fieldDef.values ?? (fieldDef.value !== undefined ? [fieldDef.value] : []);
        } else if (!passRequiresLiteral && fieldDef.type === "enum" && fieldDef.entries) {
          expected = Object.values(fieldDef.entries);
        }
        if (!expected) continue;
        // Skip optional/nullable discriminators the record doesn't carry —
        // an absent value is "match by absence", not a mismatch. Without this
        // an optional enum (e.g. an order line item's `inclusion_type`) would
        // wrongly disqualify every member.
        const recValue = record[key];
        if (recValue === undefined || recValue === null) continue;
        hasDiscriminator = true;
        if (!expected.includes(recValue)) {
          allMatched = false;
          break;
        }
      }
      if (hasDiscriminator && allMatched) return member;
    }
  }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Recursively apply the strategy's PII transforms to every field in
 * `record` whose schema position carries a `.meta({ pii })` tag.
 *
 * Returns a shallow-cloned record at each object level — never mutates the
 * input. Safe to call on the same record repeatedly; idempotent for mask /
 * redact (hash is deterministic).
 */
export function applyPii<T extends object>(
  record: T,
  schema: z.ZodType<T>,
  strategy: PiiStrategy,
): T {
  return walkObject(record as Record<string, unknown>, schema, strategy, "") as T;
}

function walkObject(
  record: Record<string, unknown>,
  schema: z.ZodType,
  strategy: PiiStrategy,
  prefix: string,
): Record<string, unknown> {
  // If the schema is a union (e.g. an items-array element), narrow to the
  // member that matches `record`'s literal-discriminated shape, then walk.
  // Without this an order's items[] union would skip every member's tagged
  // fields (regression: the 2026-05-28 fixture-sanitizer audit).
  const narrowed = resolveUnionMember(schema, record) ?? schema;
  const shape = getShape(narrowed);
  if (!shape) return record;
  const out: Record<string, unknown> = { ...record };
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const value = out[key];
    if (value === null || value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    out[key] = transformField(value, fieldSchema, strategy, path);
  }
  return out;
}

/**
 * Apply a classification inherited from a `pii`-tagged node to a value of any
 * shape: scalars go to the strategy, containers are walked so the tag reaches
 * every leaf inside them.
 *
 * A tag on an OBJECT (`Address` is `.strictObject({…}).nullable().meta({pii:"mask"})`)
 * used to be handed straight to the strategy, and every strategy opens with
 * `if (typeof value !== "string") return value` — so the object came back
 * untouched and the tag was a no-op. Recurse instead.
 *
 * The strategy still gets first refusal on a container: it is called with the
 * object/array, and if it returns something other than what it was given, that
 * replacement wins and we do not recurse. That is the seam the fixture
 * sanitizer needs to null a whole `Coordinates` object (a 6dp geocode is
 * precise location data, and nulling `latitude` alone would fail `z.number()`
 * on the way back in). A strategy that ignores non-strings just falls through
 * to the recursion below.
 *
 * Children — object fields, array elements, record entries alike — go through
 * {@link applyInherited}, which is where a child's OWN tag overrides the
 * inherited one and where `pii: "none"` opts that child out.
 */
function applyTagged(
  value: unknown,
  schema: z.ZodType,
  pii: PiiClassification,
  strategy: PiiStrategy,
  path: string,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value !== "object") return strategy.apply(value, pii, path);

  // Containers: strategy first refusal, then walk.
  const replaced = strategy.apply(value, pii, path);
  if (replaced !== value) return replaced;

  const unwrapped = unwrapNonArray(schema);
  const def = getDef(unwrapped);

  if (Array.isArray(value)) {
    const elem = def.element;
    // No element schema (an array value under a tagged non-array node) — nothing
    // to descend with. Fail closed, same reasoning as the `!shape` note below.
    if (!elem) return redact();
    return value.map((v) => applyInherited(v, elem, pii, strategy, path));
  }

  // Record — must precede `getShape`, which is `null` for one. Every entry is
  // walked against the record's value schema, under the literal `<key>` segment.
  if (def.type === "record" && def.valueType) {
    return walkRecord(value as Record<string, unknown>, def.valueType, strategy, path, pii);
  }

  // A bare union is narrowed to the member the value discriminates to, exactly
  // as `walkObject` does; without this a tagged union would land on `!shape`.
  const narrowed = resolveUnionMember(unwrapped, value as Record<string, unknown>);
  const shape = getShape(narrowed ?? unwrapped);

  // FAIL CLOSED. We are inside a tagged subtree, the strategy declined first
  // refusal (it handed back the same reference, which is its way of saying
  // "descend"), and we cannot descend: a `z.custom` (a Firestore `Timestamp`), a
  // `z.date`, a union no discriminator resolves. Passing the value through raw is
  // the one remaining way a `pii` tag can be decorative — so don't.
  //
  // In the fixture-capture flow this makes `saveFixture`'s Zod re-parse fail (a
  // string where an object is declared) and the capture 422. That is the point: a
  // tag the walker cannot honour must not silently ship real PII into git.
  //
  // Scoped to `applyTagged` deliberately — never `transformField`. Redacting an
  // UNTAGGED undescendable node would nuke `card.body` (Tiptap), `deleted_at`
  // timestamps, `transaction.crms_sync`, and much else. Zero schemas reach this
  // arm today (measured: every own-tag in the package sits on a string or an
  // object).
  //
  // `strategy.apply` is NOT called a second time here: first refusal already ran.
  if (!shape) return redact();

  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, childSchema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    out[key] = applyInherited(out[key], childSchema, pii, strategy, `${path}.${key}`);
  }
  return out;
}

/**
 * Hand a value the classification inherited from a `pii`-tagged ancestor, letting
 * the value's OWN tag win where it has one.
 *
 * The one place the override rule lives, so the object arm, the array arm and the
 * record arm cannot drift apart — they had: the array arm never read the
 * element's own tag at all, and the object arm treated a child's `pii: "none"` as
 * a hard `continue` that pruned the entire subtree below it. Tagging a container
 * `none` silently exempted everything beneath it.
 *
 * `none` opts out THIS NODE, not its subtree. Re-entering {@link transformField}
 * (rather than skipping) lets every tag BELOW the opted-out node still govern. For
 * a `none` SCALAR leaf (`Address.city`) `transformField` falls straight through to
 * `return value` and the strategy is never called — byte-identical to the old
 * `continue`, which is what keeps the explicit opt-out an opt-out.
 */
function applyInherited(
  value: unknown,
  schema: z.ZodType,
  inherited: PiiClassification,
  strategy: PiiStrategy,
  path: string,
): unknown {
  const effective = readPiiTag(schema) ?? inherited;
  if (effective === "none") return transformField(value, schema, strategy, path);
  return applyTagged(value, schema, effective, strategy, path);
}

/**
 * Walk every entry of a `z.record` against the record's VALUE schema.
 *
 * `inherited` absent — the record itself is untagged, so each entry re-enters
 * {@link transformField} and only tags at or below the value schema govern.
 * `inherited` present — we are inside a tagged subtree, so the tag is pushed down
 * to each entry (which gets its own first refusal at `path.<key>`).
 */
function walkRecord(
  value: Record<string, unknown>,
  valueSchema: z.ZodType,
  strategy: PiiStrategy,
  path: string,
  inherited?: PiiClassification,
): Record<string, unknown> {
  const entryPath = path ? `${path}.${RECORD_KEY_SEGMENT}` : RECORD_KEY_SEGMENT;
  const out: Record<string, unknown> = { ...value };
  for (const key of Object.keys(out)) {
    const entry = out[key];
    if (entry === null || entry === undefined) continue;
    out[key] = inherited === undefined
      ? transformField(entry, valueSchema, strategy, entryPath)
      : applyInherited(entry, valueSchema, inherited, strategy, entryPath);
  }
  return out;
}

function transformField(
  value: unknown,
  fieldSchema: z.ZodType,
  strategy: PiiStrategy,
  path: string,
): unknown {
  // The field's own PII tag takes precedence. Read it through the whole wrapper
  // chain — `.nullable().meta({pii})` parks the tag on the ZodNullable, which an
  // unwrap-then-read misses entirely.
  const pii = readPiiTag(fieldSchema);

  if (pii && pii !== "none") {
    return applyTagged(value, fieldSchema, pii, strategy, path);
  }

  const unwrapped = unwrapNonArray(fieldSchema);
  const def = getDef(unwrapped);

  // Array: delegate per element. `transformField` already dispatches on tag /
  // object / union / record, so the array arm composes with every arm below it
  // for free — arrays of records, arrays of unions, nested arrays. The path
  // carries NO index, deliberately (see {@link RECORD_KEY_SEGMENT}).
  if (def.type === "array" && def.element && Array.isArray(value)) {
    const elem = def.element;
    return value.map((v) =>
      v === null || v === undefined ? v : transformField(v, elem, strategy, path)
    );
  }

  // Record — descend the value schema. Tags below a record used to be decorative:
  // `getShape` is `null` for a record, so the walk stopped here and every tagged
  // leaf under `comment.reactions` went to the log and into git unscrubbed.
  if (def.type === "record" && def.valueType && isPlainObject(value)) {
    return walkRecord(value, def.valueType, strategy, path);
  }

  // Object OR bare union — `walkObject` handles both (it narrows a union first).
  if (((def.type === "object" && def.shape) || def.type === "union") && isPlainObject(value)) {
    return walkObject(value, unwrapped, strategy, path);
  }

  return value;
}
