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
  /** Value schema of a `z.record(keyType, valueType)` — for dynamic-key paths. */
  valueType?: z.ZodType;
  entries?: Record<string, string>;
  format?: string;
  in?: z.ZodType;
  out?: z.ZodType;
  /** Member schemas of a `z.union()` / `z.discriminatedUnion()`. */
  options?: z.ZodType[];
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
 * when the node is not an object. (Object-only — does not descend into records;
 * `getServerSortableColumns` walks fixed object shapes, not dynamic maps.)
 */
function getShape(node: z.ZodType): Record<string, z.ZodType> | null {
  const unwrapped = unwrapZod(node);
  return getDef(unwrapped).shape ?? null;
}

/**
 * Resolve one path segment against the current node (after unwrapping):
 *  - object → the named field on its shape (`null` if absent);
 *  - `z.record(keyType, valueType)` → the record's VALUE schema, consuming the
 *    segment as a dynamic key (so `reactions.<emoji>.<uid>.name` resolves
 *    through `z.record(z.record(ActorRef))` to the `name` field);
 *  - anything else (array, scalar, …) → `null`.
 */
function descendSegment(node: z.ZodType, seg: string): z.ZodType | null {
  const def = getDef(unwrapZod(node));
  if (def.type === "record") return def.valueType ?? null;
  return def.shape?.[seg] ?? null;
}

/**
 * Resolve a dotted field path (e.g. `"dates.end"`, `"reactions.❤️.u1.name"`) to
 * the leaf schema. Each segment descends through an object shape or a record's
 * value type after unwrapping. Returns `null` when any segment is missing or
 * when the traversal hits a non-object/non-record node before exhausting the
 * path (e.g. an array-index segment — not modelled).
 *
 * `opts.unwrap` (default `true`) controls the LEAF only: when `true` the leaf's
 * Optional/Default/Nullable/etc. wrappers are stripped (callers reading the
 * inner type / `.meta()`); when `false` the leaf is returned AS DECLARED — use
 * this to validate a write VALUE against the field, so a `null` write to a
 * `.nullable()` field (or `undefined` to an `.optional()` one) is accepted.
 * Intermediate segments are always unwrapped (needed to descend).
 */
export function resolveZodField(
  schema: z.ZodType,
  fieldPath: string,
  opts?: { unwrap?: boolean },
): z.ZodType | null {
  const segments = fieldPath.split(".");
  let n: z.ZodType = schema;
  for (const seg of segments) {
    const next = descendSegment(n, seg);
    if (!next) return null;
    n = next;
  }
  return (opts?.unwrap ?? true) ? unwrapZod(n) : n;
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

// ── collectLeafPaths ─────────────────────────────────────────────────

/**
 * Nodes that annotate the schema below them without changing its shape. Walked
 * through transparently, accumulating `.meta()` on the way down: `.meta()`
 * registers on the *instance it is called on*, so `f(z.string()).nullable()` and
 * `f(z.string().nullable())` land the meta on different nodes and only a merge
 * finds both. (Same lesson as `hasPii` in `tests/pii.test.ts`.)
 */
const TRANSPARENT_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "default",
  "nullable",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/**
 * Node types emitted as leaves. Atomic — none of them can hide a subtree, which
 * is what makes it safe to stop here. Anything not in this set and not descended
 * below lands in `unhandled` (see {@link collectLeafPaths}).
 */
const LEAF_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "enum",
  "literal",
  "template_literal",
  "custom",
  "unknown",
  "any",
  "null",
  "undefined",
  "date",
  "bigint",
]);

/** A scalar leaf reached by {@link collectLeafPaths}. */
export interface LeafPath {
  /** Dotted path with container markers: `pdf_versions[].uploadcare_uuid`,
   *  `images[]`, `golden_results[].image_uuids.candidate`, `content.<key>`. */
  path: string;
  /** The leaf node, wrappers stripped. */
  node: z.ZodType;
  /** `_zod.def.type` of the stripped leaf. */
  type: string;
  /** `_zod.def.format` when present (`"uuid"`, `"datetime"`, `"email"`, …). */
  format?: string;
  /** Merged `.meta()` from the leaf and every transparent wrapper above it. */
  meta: Record<string, unknown>;
}

/** Result of {@link collectLeafPaths}. `unhandled` MUST be empty — see below. */
export interface CollectLeafPathsResult {
  leaves: LeafPath[];
  /** Nodes the walker refused to interpret. A non-empty array means the walk is
   *  incomplete and any assertion built on `leaves` is unsound. */
  unhandled: Array<{ path: string; type: string }>;
}

/**
 * Walk a schema and collect every scalar leaf with its dotted path and merged
 * meta. Backs the Uploadcare authoring lint (`schemas/uploadcare/`) — a third
 * meta-collecting walker alongside `applyPii` and `getServerSortableColumns`,
 * neither of which is reusable here (the latter is depth-capped at 1 and skips
 * arrays entirely).
 *
 * **It fails CLOSED.** A walker that emits unrecognised nodes as leaves would
 * silently swallow their subtree — a field named `attachments` typed
 * `z.tuple([...])` would vanish from the walk and be invisible to every
 * assertion built on it. So the type allowlist is two-sided: descend the known
 * containers, emit the known scalars, and push everything else into
 * `unhandled`, which callers are expected to assert is empty.
 *
 * Traversal:
 * - **transparent wrappers** (`optional`, `default`, `nullable`, `prefault`,
 *   `catch`, `readonly`, `nonoptional`) and **pipes** (`def.in` — the input side
 *   of `chicagoInstant()` et al) are walked through, merging meta at each level;
 * - **object** → each field, `path.key`;
 * - **array** → the element, `path[]`;
 * - **record** → the value type, `path.<key>` (dynamic keys aren't enumerable);
 * - **union / discriminatedUnion** → every member at the *same* path, deduped by
 *   (path, node identity) so shared nodes are visited once.
 *
 * Meta does **not** cross a container boundary: an object's schema-level
 * `.meta({ title, collection })` must not leak onto its fields, and by symmetry
 * an annotation on an array node does not reach its element. Annotate the leaf.
 *
 * `maxDepth` defaults to **24**. Wrappers are nodes, so depth counts them: the
 * deepest chain in core today measures 10, and an obvious-looking 12 would have
 * been one `.optional().nullable()` away from silently truncating. Hitting the
 * cap pushes a `__depth_cap__` entry into `unhandled` rather than returning
 * quietly.
 */
export function collectLeafPaths(
  schema: z.ZodType,
  opts?: { maxDepth?: number },
): CollectLeafPathsResult {
  const maxDepth = opts?.maxDepth ?? 24;
  const leaves: LeafPath[] = [];
  const unhandled: Array<{ path: string; type: string }> = [];
  /** (path → nodes already visited at it) — dedupes union members and, as a
   *  side effect, makes a self-referential schema terminate. */
  const visited = new Map<string, Set<z.ZodType>>();

  function walk(
    node: z.ZodType,
    path: string,
    depth: number,
    inherited: Record<string, unknown>,
  ): void {
    if (depth > maxDepth) {
      unhandled.push({ path, type: "__depth_cap__" });
      return;
    }

    let seenAtPath = visited.get(path);
    if (!seenAtPath) {
      seenAtPath = new Set();
      visited.set(path, seenAtPath);
    }
    if (seenAtPath.has(node)) return;
    seenAtPath.add(node);

    const def = getDef(node);
    const own = getNodeMeta(node);
    const meta = own ? { ...inherited, ...own } : inherited;

    if (TRANSPARENT_TYPES.has(def.type) && def.innerType) {
      walk(def.innerType, path, depth + 1, meta);
      return;
    }
    if (def.type === "pipe" && def.in) {
      walk(def.in, path, depth + 1, meta);
      return;
    }

    if (def.type === "object") {
      if (!def.shape) {
        unhandled.push({ path, type: def.type });
        return;
      }
      for (const [key, child] of Object.entries(def.shape)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1, {});
      }
      return;
    }
    if (def.type === "array") {
      if (!def.element) {
        unhandled.push({ path, type: def.type });
        return;
      }
      walk(def.element, `${path}[]`, depth + 1, {});
      return;
    }
    if (def.type === "record") {
      if (!def.valueType) {
        unhandled.push({ path, type: def.type });
        return;
      }
      walk(def.valueType, `${path}.<key>`, depth + 1, {});
      return;
    }
    if (def.type === "union") {
      if (!def.options) {
        unhandled.push({ path, type: def.type });
        return;
      }
      for (const option of def.options) {
        walk(option, path, depth + 1, meta);
      }
      return;
    }

    if (LEAF_TYPES.has(def.type)) {
      leaves.push({
        path,
        node,
        type: def.type,
        ...(def.format ? { format: def.format } : {}),
        meta,
      });
      return;
    }

    unhandled.push({ path, type: def.type });
  }

  walk(schema, "", 0, {});
  return { leaves, unhandled };
}
