/**
 * Zod 4 schema traversal helpers.
 *
 * Zod 4 exposes internals via `_zod.def`; the public `.unwrap()` API returns
 * the element type on `ZodArray`, which breaks "is this an array of X?" checks.
 * These helpers navigate via the def type discriminator so behaviour is
 * predictable across Optional / Default / Nullable / Prefault / Catch wrappers.
 */
import { z } from "zod";
import { FirestoreTimestamp } from "./common.ts";

const WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "default",
  "nullable",
  "prefault",
  "catch",
]);

interface ZodInternalDef {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  entries?: Record<string, string>;
  format?: string;
  in?: z.ZodType;
  out?: z.ZodType;
}

function getDef(node: z.ZodType): ZodInternalDef {
  return (node as unknown as { _zod: { def: ZodInternalDef } })._zod.def;
}

/**
 * Unwrap wrapper nodes (Optional, Default, Nullable, Prefault, Catch) to reach
 * the inner schema where `.meta()` was called. Does not descend into arrays,
 * records, or objects.
 */
export function unwrapZod(node: z.ZodType): z.ZodType {
  let n = node;
  while (true) {
    const def = getDef(n);
    if (WRAPPER_TYPES.has(def.type) && def.innerType) {
      n = def.innerType;
      continue;
    }
    return n;
  }
}

/**
 * Like {@link unwrapZod} but stops at `ZodArray`. In Zod 4, `ZodArray.unwrap()`
 * returns the element type; callers that need to detect "is this an array?"
 * use this variant so the array node is preserved.
 */
export function unwrapNonArray(node: z.ZodType): z.ZodType {
  let n = node;
  while (true) {
    const def = getDef(n);
    if (def.type === "array") return n;
    if (WRAPPER_TYPES.has(def.type) && def.innerType) {
      n = def.innerType;
      continue;
    }
    return n;
  }
}

/**
 * Read the metadata registered on a node via `.meta(...)`. Returns `null` when
 * no meta has been registered. Does not unwrap — pass the already-unwrapped
 * node when reading field-level meta.
 */
export function getNodeMeta(node: z.ZodType): Record<string, unknown> | null {
  const entry = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
  return entry ?? null;
}

/**
 * Resolve the object shape for a node by unwrapping wrappers. Returns `null`
 * when the node is not an object.
 */
function getShape(node: z.ZodType): Record<string, z.ZodType> | null {
  const unwrapped = unwrapZod(node);
  return getDef(unwrapped).shape ?? null;
}

/**
 * Resolve a dotted field path (e.g. `"dates.end"`) to the leaf schema. Each
 * segment is looked up on the current object's shape after unwrapping.
 * Returns `null` when any segment is missing or when the traversal hits a
 * non-object node before exhausting the path.
 */
export function resolveZodField(
  schema: z.ZodType,
  fieldPath: string,
): z.ZodType | null {
  const segments = fieldPath.split(".");
  let n: z.ZodType = schema;
  for (const seg of segments) {
    const shape = getShape(n);
    if (!shape) return null;
    const next = shape[seg];
    if (!next) return null;
    n = next;
  }
  return unwrapZod(n);
}

/**
 * Convenience: resolve a dotted path and read its meta in one call. Returns
 * `null` when the path is unresolvable or the leaf has no meta.
 */
export function resolveFieldMeta(
  schema: z.ZodType,
  fieldPath: string,
): Record<string, unknown> | null {
  const node = resolveZodField(schema, fieldPath);
  return node ? getNodeMeta(node) : null;
}

/**
 * Follow `def.in` through a pipe chain to the underlying schema. Used when a
 * caller cares about the type discriminator (string vs number vs …) of a field
 * that went through `.transform()` — e.g. Chicago-canonicalized datetime fields
 * produced by `chicagoInstant()` / `chicagoStartOfDay()`, which return a
 * `ZodPipe` with the `z.iso.datetime()` on the input side.
 *
 * Deliberately separate from `unwrapZod` so that pipe-level `.meta()` (used
 * for `serverSortVia` annotations) stays discoverable via `getNodeMeta` —
 * callers that want the type look through pipes, callers that want meta do not.
 */
function unwrapPipes(node: z.ZodType): z.ZodType {
  let n = node;
  while (true) {
    const def = getDef(n);
    if (def.type === "pipe" && def.in) {
      n = def.in;
      continue;
    }
    return n;
  }
}

/**
 * True when `node` is an ISO datetime, ISO date, or `FirestoreTimestamp` —
 * including when those types are wrapped in a `.transform()` pipe (e.g.
 * `chicagoInstant()`, `chicagoStartOfDay()`). Takes an already-unwrapped node
 * (see {@link unwrapZod} / {@link unwrapNonArray}); callers that have only a
 * schema + path should use {@link isDateField} instead.
 */
export function isDateLikeNode(node: z.ZodType): boolean {
  if (node === FirestoreTimestamp) return true;
  const inner = unwrapPipes(node);
  if (inner === FirestoreTimestamp) return true;
  const def = getDef(inner);
  return def.type === "string" &&
    (def.format === "datetime" || def.format === "date");
}

/**
 * True when the schema's leaf at `fieldPath` is an ISO datetime, ISO date, or
 * the `FirestoreTimestamp` custom type. Unwraps Optional/Default/Nullable and
 * sees through `.transform()` pipes, so neither modifiers nor Chicago
 * datetime factories (`chicagoInstant`, `chicagoStartOfDay`) mask the
 * underlying type.
 */
export function isDateField(schema: z.ZodType, fieldPath: string): boolean {
  const node = resolveZodField(schema, fieldPath);
  return node ? isDateLikeNode(node) : false;
}

/**
 * Return the values of a `ZodEnum` in declaration order. Throws when passed a
 * non-enum schema — callers should pass the enum directly (e.g.
 * `enumValues(CardStatusEnum)`), not a wrapped schema.
 */
export function enumValues<T extends string>(schema: z.ZodType<T>): T[] {
  const def = getDef(schema as unknown as z.ZodType);
  if (def.type !== "enum" || !def.entries) {
    throw new Error("enumValues requires a ZodEnum schema");
  }
  return Object.values(def.entries) as T[];
}

/**
 * Walk a document schema and collect all fields annotated with
 * `.meta({ serverSortVia: "<firestore_field>" })`. Used by list views to
 * discover which columns can drive a server-side `orderBy` clause and which
 * Firestore field the sort maps to (often an `_fs` timestamp sibling).
 *
 * Descends one level into nested objects (matching the column walker depth).
 * Arrays are not traversed.
 */
export function getServerSortableColumns(
  schema: z.ZodType,
): Record<string, string> {
  const out: Record<string, string> = {};

  function walk(node: z.ZodType, prefix: string, depth: number) {
    const shape = getShape(node);
    if (!shape) return;
    for (const [key, raw] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const inner = unwrapNonArray(raw);
      const def = getDef(inner);
      if (def.type === "array") continue;

      const meta = getNodeMeta(inner);
      const via = meta?.serverSortVia;
      if (typeof via === "string") out[path] = via;

      if (def.type === "object" && depth < 1) {
        walk(inner, path, depth + 1);
      }
    }
  }

  walk(schema, "", 0);
  return out;
}
