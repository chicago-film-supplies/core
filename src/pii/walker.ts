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
import { getNodeMeta, unwrapNonArray, unwrapZod } from "../zod-walk.ts";
import type { PiiClassification } from "./classification.ts";
import { mask, redact } from "./transforms.ts";

// ── Strategy interface ──────────────────────────────────────────────

/**
 * How to transform a leaf value given its PII classification. Consumers
 * provide their own strategy; the structured logger uses
 * {@link createLoggerStrategy} below.
 *
 * The walker calls `apply` with the leaf value, the field's classification,
 * and the dotted field path (for strategies that want path-dependent output
 * like the fixture sanitizer's deterministic fakes).
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
 * Non-string values are passed through unchanged — the schema's PII tags
 * only apply to string leaves (number / boolean fields cannot carry PII
 * directly; arrays and objects are recursed into by the walker, not handed
 * to the strategy).
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
      if (typeof value !== "string") return value;
      switch (classification) {
        case "mask":
          return mask(value);
        case "redact":
          return redact();
        case "hash":
          return hashFn ? hashFn(value) : redact();
        case "none":
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
}

function getDef(node: z.ZodType): ZodInternalDef {
  return (node as unknown as { _zod: { def: ZodInternalDef } })._zod.def;
}

function getShape(node: z.ZodType): Record<string, z.ZodType> | null {
  return getDef(unwrapZod(node)).shape ?? null;
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
  const shape = getShape(schema);
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

function transformField(
  value: unknown,
  fieldSchema: z.ZodType,
  strategy: PiiStrategy,
  path: string,
): unknown {
  // The field's own PII tag (after unwrapping Optional / Default / Nullable / etc.)
  // takes precedence — apply the leaf transform and short-circuit recursion.
  const unwrapped = unwrapNonArray(fieldSchema);
  const meta = getNodeMeta(unwrapped);
  const pii = meta?.pii as PiiClassification | undefined;

  if (pii && pii !== "none") {
    if (Array.isArray(value)) {
      return value.map((v) => strategy.apply(v, pii, path));
    }
    return strategy.apply(value, pii, path);
  }

  const def = getDef(unwrapped);

  // Array of objects (or array of pii-tagged primitives): recurse per-element.
  if (def.type === "array" && def.element && Array.isArray(value)) {
    const elem = def.element;
    const elemUnwrapped = unwrapNonArray(elem);
    const elemMeta = getNodeMeta(elemUnwrapped);
    const elemPii = elemMeta?.pii as PiiClassification | undefined;
    if (elemPii && elemPii !== "none") {
      return value.map((v) => strategy.apply(v, elemPii, path));
    }
    const elemDef = getDef(elemUnwrapped);
    if (elemDef.type === "object" && elemDef.shape) {
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
