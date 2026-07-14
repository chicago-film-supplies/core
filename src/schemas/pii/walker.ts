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
 * - **`.passthrough()` / `z.record()` / un-shaped values**: left untouched —
 *   the runtime key-name denylist tier (separate, in the logger) handles
 *   those.
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
 * object itself, and each nested object/array within it) before the walker
 * recurses into it. Return the value unchanged to let the walker keep
 * descending to the leaves; return anything else to replace the container
 * wholesale and stop the descent. The fixture sanitizer uses this to null a
 * whole `Coordinates` object — a leaf-by-leaf transform cannot, because
 * `latitude` is a `z.number()` and there is no in-band "absent" value for it.
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
 *   it. The consequence, by construction, is that an OBJECT-shaped scalar (a
 *   `Date`, a Firestore `Timestamp`) still passes through raw — no schema has
 *   one under a tag today.
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
  options?: z.ZodType[];
  /** `literal` def values (Zod 4 stores the literal set as an array). */
  values?: unknown[];
  /** Older / non-Zod-4 literal def shape. */
  value?: unknown;
  /** `enum` def — Zod 4 stores entries as a record `{member: member, ...}`. */
  entries?: Record<string, unknown>;
}

function getDef(node: z.ZodType): ZodInternalDef {
  return (node as unknown as { _zod: { def: ZodInternalDef } })._zod.def;
}

function getShape(node: z.ZodType): Record<string, z.ZodType> | null {
  return getDef(unwrapZod(node)).shape ?? null;
}

/**
 * Resolve a union schema down to the single member that matches `record`'s
 * shape, using `literal` and `enum` fields as discriminators (e.g.
 * `type: "rental"` against an `OrderItemType` enum in one member and
 * `type: "destination"` against a `z.literal("destination")` in another).
 * Returns the matched member, or `null` if `node` isn't a union or no member
 * discriminates. Members without any discriminator field are skipped — we
 * never guess.
 */
function resolveUnionMember(
  node: z.ZodType,
  record: Record<string, unknown>,
): z.ZodType | null {
  const def = getDef(unwrapZod(node));
  if (def.type !== "union" || !def.options) return null;
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
 * A child's OWN tag overrides the inherited one, so a `pii: "none"` leaf inside
 * a masked object (`Address.city`) opts out.
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
    return value.map((v) =>
      elem ? applyTagged(v, elem, pii, strategy, path) : strategy.apply(v, pii, path)
    );
  }

  const shape = getShape(unwrapped);
  if (!shape) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [key, childSchema] of Object.entries(shape)) {
    if (!(key in out)) continue;
    const childPath = `${path}.${key}`;
    const childPii = readPiiTag(childSchema) ?? pii;
    if (childPii === "none") continue;
    out[key] = applyTagged(out[key], childSchema, childPii, strategy, childPath);
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

  // Array of objects (or array of pii-tagged primitives): recurse per-element.
  if (def.type === "array" && def.element && Array.isArray(value)) {
    const elem = def.element;
    const elemPii = readPiiTag(elem);
    if (elemPii && elemPii !== "none") {
      return value.map((v) => applyTagged(v, elem, elemPii, strategy, path));
    }
    const elemUnwrapped = unwrapNonArray(elem);
    const elemDef = getDef(elemUnwrapped);
    if (
      (elemDef.type === "object" && elemDef.shape) ||
      elemDef.type === "union"
    ) {
      // `walkObject` handles both: a plain object element walks the element's
      // shape, a union element is narrowed by `resolveUnionMember` first.
      return value.map((v) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? walkObject(v as Record<string, unknown>, elem, strategy, path)
          : v
      );
    }
    return value;
  }

  // Nested object — recurse.
  if (
    def.type === "object" && def.shape &&
    value !== null && typeof value === "object" && !Array.isArray(value)
  ) {
    return walkObject(value as Record<string, unknown>, unwrapped, strategy, path);
  }

  return value;
}
