/**
 * Synthesize sample documents from a Zod schema, so a test can drive the **real**
 * `applyPii` walker over every schema this package ships.
 *
 * ## Why this exists
 *
 * Every static PII guard we have keys off something *other* than the walker: the
 * name dictionary (`tests/pii.test.ts`), the tag reader (`readPiiTag`), the lint
 * walker (`collectLeafPaths`). Each one has, at some point, been green while
 * `applyPii` shipped the value raw — `Address`'s object-level tag, and then the
 * `comment::reactions.<key>.<key>.name` leaf behind a `z.record`. A static rule
 * cannot see a hole in the runtime, because *the runtime is the thing being
 * checked*. So: manufacture values, run the walker, and assert it actually
 * reaches every tagged leaf.
 *
 * ## The asymmetry that makes this sound
 *
 * This module reads **no `.meta()` at all**. The expected leaf set comes from
 * `collectLeafPaths`; this only manufactures values to walk. So a bug in here is
 * a false **RED**, never a false green — a missed key, a `null`, an empty
 * array/record, or a botched discriminator all mean "the walker was never offered
 * that path" ⇒ the reach test fails. It cannot invent coverage it does not have.
 *
 * It **fails closed** on any node type it does not know, mirroring
 * `collectLeafPaths`' `unhandled` contract: a silently-skipped node would make
 * every assertion built on these docs vacuous.
 *
 * ## Shape
 *
 * Each node returns a LIST of alternatives:
 * - **object** — zips its fields' alternative lists to the longest, so every
 *   union member appears in *some* document without a cartesian blow-up;
 * - **array** — collapses its element's alternatives into a single array literal,
 *   so `order::items[]`'s four union arms are all covered by one document;
 * - **record** — same, as a map under synthetic keys (`k0`, `k1`, …). The keys are
 *   deliberately NOT the literal `<key>`: the walker must emit `<key>` as the path
 *   segment on its own, and a key of `<key>` would let a walker that echoed the
 *   map key pass by accident;
 * - **union** — concatenates its members' alternatives;
 * - **leaf** — one value. Enums and literals emit a REAL member value, because
 *   `resolveUnionMember` narrows on exactly those.
 *
 * Values need not satisfy `.min()` / `.email()` / `.uuid()` — `applyPii` never
 * parses; it walks the schema, not the value.
 */
import type { z } from "zod";

interface ZodInternalDef {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  /** Value schema of a `z.record(keyType, valueType)`. */
  valueType?: z.ZodType;
  options?: z.ZodType[];
  /** `literal` def values (Zod 4 stores the literal set as an array). */
  values?: unknown[];
  /** Older / non-Zod-4 literal def shape. */
  value?: unknown;
  /** `enum` def — Zod 4 stores entries as a record `{member: member, ...}`. */
  entries?: Record<string, unknown>;
  /** Input side of a `ZodPipe`. */
  in?: z.ZodType;
}

function getDef(node: z.ZodType): ZodInternalDef {
  return (node as unknown as { _zod: { def: ZodInternalDef } })._zod.def;
}

/** Kept equal to `collectLeafPaths`' `TRANSPARENT_TYPES`. */
const TRANSPARENT: ReadonlySet<string> = new Set([
  "optional",
  "default",
  "nullable",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/**
 * The path segment `collectLeafPaths` emits for a record's value, and the one the
 * PII walker emits at runtime. Never used as an actual map key here — see above.
 */
export const KEY_MARKER = "<key>";

/** Same cap as `collectLeafPaths`. A recursive schema would otherwise hang. */
const MAX_DEPTH = 24;

/**
 * Manufacture the sample documents for a schema. Returns one document per
 * alternative — usually 1, more when the root's fields carry unions.
 *
 * @throws on any node type it does not know (fail-closed), and on a schema deeper
 *         than `collectLeafPaths`' own `maxDepth`.
 */
export function sampleValues(schema: z.ZodType, path = "", depth = 0): unknown[] {
  if (depth > MAX_DEPTH) {
    throw new Error(`sampleValues: depth cap (${MAX_DEPTH}) exceeded at "${path}"`);
  }
  const def = getDef(schema);

  if (TRANSPARENT.has(def.type) && def.innerType) {
    return sampleValues(def.innerType, path, depth + 1);
  }
  if (def.type === "pipe" && def.in) {
    return sampleValues(def.in, path, depth + 1);
  }

  if (def.type === "object") {
    if (!def.shape) throw new Error(`sampleValues: object with no shape at "${path}"`);
    const fields = Object.entries(def.shape).map(([key, child]) => {
      const childPath = path ? `${path}.${key}` : key;
      return [key, sampleValues(child, childPath, depth + 1)] as const;
    });
    // Zip to the longest field: every alternative of every field lands in SOME
    // document, and the document count stays linear rather than cartesian.
    const width = Math.max(1, ...fields.map(([, alts]) => alts.length));
    const docs: unknown[] = [];
    for (let i = 0; i < width; i++) {
      const doc: Record<string, unknown> = {};
      for (const [key, alts] of fields) {
        doc[key] = alts[Math.min(i, alts.length - 1)];
      }
      docs.push(doc);
    }
    return docs;
  }

  if (def.type === "array") {
    if (!def.element) throw new Error(`sampleValues: array with no element at "${path}"`);
    // One array carrying every element alternative — so a union-typed element
    // exercises all of its members in a single document.
    return [sampleValues(def.element, `${path}[]`, depth + 1)];
  }

  if (def.type === "record") {
    if (!def.valueType) throw new Error(`sampleValues: record with no valueType at "${path}"`);
    const alts = sampleValues(def.valueType, `${path}.${KEY_MARKER}`, depth + 1);
    const map: Record<string, unknown> = {};
    alts.forEach((value, i) => map[`k${i}`] = value);
    return [map];
  }

  if (def.type === "union") {
    if (!def.options) throw new Error(`sampleValues: union with no options at "${path}"`);
    return def.options.flatMap((member) => sampleValues(member, path, depth + 1));
  }

  return [leafValue(def, path)];
}

function leafValue(def: ZodInternalDef, path: string): unknown {
  switch (def.type) {
    case "string":
    case "template_literal":
    // `unknown` / `any` get a string on purpose: it is the value shape the walker
    // is most likely to be handed, and it makes a tag on them *look* honoured.
    // That trap is what `tests/pii.test.ts`'s static opaque-tag rule exists for —
    // it is not this module's job to catch it.
    case "unknown":
    case "any":
      return `SENTINEL::${path}`;
    case "number":
      return 1;
    case "bigint":
      return 1n;
    case "boolean":
      return true;
    case "date":
      return new Date(0);
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "literal": {
      // REQUIRED to be a real member: `resolveUnionMember` narrows on literals.
      const values = def.values ?? (def.value !== undefined ? [def.value] : []);
      if (values.length === 0) throw new Error(`sampleValues: literal with no value at "${path}"`);
      return values[0];
    }
    case "enum": {
      // Ditto — an enum is `resolveUnionMember`'s second-pass discriminator.
      const values = Object.values(def.entries ?? {});
      if (values.length === 0) throw new Error(`sampleValues: enum with no entries at "${path}"`);
      return values[0];
    }
    case "custom":
      // The only `z.custom` in core is `FirestoreTimestamp`.
      return { seconds: 0, nanoseconds: 0 };
    default:
      // FAIL CLOSED. A node type we cannot manufacture a value for would leave its
      // whole subtree unpopulated, and every assertion over these docs vacuous.
      throw new Error(`sampleValues: unhandled node type "${def.type}" at "${path}"`);
  }
}

/**
 * Resolve a `collectLeafPaths` path (`items[].name`, `reactions.<key>.<key>.name`)
 * against a produced document, returning every value found at it. Empty when the
 * generator never populated that leaf — which is what the reach test's companion
 * contract test asserts cannot happen.
 */
export function resolveLeafValues(doc: unknown, leafPath: string): unknown[] {
  let current: unknown[] = [doc];
  for (const segment of leafPath.split(".")) {
    const next: unknown[] = [];
    // `name`, `name[]`, `<key>`, `<key>[]` — resolve the base, then unwrap one
    // array level per trailing `[]` marker (a record OF arrays emits `<key>[]`).
    const base = segment.replace(/(\[\])+$/, "");
    const arrayDepth = (segment.length - base.length) / 2;
    for (const node of current) {
      if (!isPlainObject(node)) continue;
      let values: unknown[] = base === KEY_MARKER
        ? Object.values(node)
        : base in node
        ? [node[base]]
        : [];
      for (let d = 0; d < arrayDepth; d++) {
        values = values.flatMap((v) => (Array.isArray(v) ? v : []));
      }
      next.push(...values);
    }
    current = next;
  }
  return current.filter((v) => v !== undefined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
