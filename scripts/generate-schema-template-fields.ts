/**
 * Generates static template schema field metadata from Zod schemas.
 *
 * Walks each template collection schema and outputs a typed
 * Record<collection, SchemaField[]> to
 * src/schemas/template-schema-fields.generated.ts — committed, not gitignored.
 *
 * **Engine: Zod 4's public `z.toJSONSchema()`.** Earlier revisions poked
 * `schema._zod.def` directly — an internal API with no stability guarantee that
 * could break silently on a Zod upgrade. We now convert once to JSON Schema and
 * walk *that*, using the public `override` hook to carry across the two things
 * JSON Schema alone cannot express:
 *
 * 1. **PII** — `z.meta({ pii: "redact" })` leaves are stamped `x-omit` and are
 *    dropped from the output entirely (they must never reach a template author).
 *    Only `redact` is omitted; `mask`/`hash` fields are deliberately shown.
 * 2. **Firestore Timestamps** — `z.custom()` is unrepresentable, so
 *    `unrepresentable: "any"` renders it as a bare `{}` that is indistinguishable
 *    from `any`/`unknown`/`function`. We stamp `x-timestamp` on the custom node
 *    instead and label from that.
 *
 * `io: "input"` resolves `.transform()` pipes (chicagoInstant / chicagoStartOfDay)
 * to their input side, so business datetimes label as `string` rather than `pipe`.
 *
 * Run: deno task generate-schema-template-fields
 */
import { z } from "zod";
import { schemas } from "../src/schemas/mod.ts";
import { TEMPLATE_SOURCE_COLLECTIONS } from "../src/schemas/template.ts";

// ── JSON Schema node model ──────────────────────────────────────────

/** Marker: this leaf is `pii: "redact"` — omit it from the reference entirely. */
const OMIT = "x-omit";
/** Marker: this leaf is a `z.custom()` Firestore Timestamp. */
const TIMESTAMP = "x-timestamp";
/** Marker: this field's outermost wrapper is `.optional()`. */
const OPTIONAL = "x-optional";

interface JsonNode {
  type?: string | string[];
  properties?: Record<string, JsonNode>;
  required?: string[];
  items?: JsonNode;
  anyOf?: JsonNode[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | JsonNode;
  propertyNames?: JsonNode;
  $ref?: string;
  [OMIT]?: boolean;
  [TIMESTAMP]?: boolean;
  [OPTIONAL]?: boolean;
}

type Defs = Record<string, JsonNode>;

/**
 * Convert a Zod schema to JSON Schema, stamping the two markers the plain
 * conversion loses (see the module doc).
 */
function toJson(schema: z.ZodType): { root: JsonNode; defs: Defs } {
  const root = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      const zodSchema = ctx.zodSchema as z.ZodType;
      const node = ctx.jsonSchema as JsonNode;

      // Public metadata API — no internal poking.
      const meta = zodSchema.meta() as { pii?: string } | undefined;
      if (meta?.pii === "redact") node[OMIT] = true;

      // The wrapper *kind* is the one thing with no public accessor, and JSON
      // Schema cannot round-trip either of these two:
      const def = (zodSchema as unknown as { _zod?: { def?: { type?: string } } })._zod?.def;

      // A Firestore Timestamp is a z.custom() — unrepresentable, so it would
      // otherwise emit an anonymous `{}` indistinguishable from any/unknown.
      if (def?.type === "custom") node[TIMESTAMP] = true;

      // Optionality: `.default(x)` and `.default(x).optional()` are BYTE-IDENTICAL
      // in JSON Schema (both carry `default` and drop out of `required`), and a
      // `.default()` over a `.transform()` pipe loses its `default` key entirely
      // under `io: "input"`. Neither the `required` array nor the `default` key
      // can therefore recover "is this field optional?". Stamping the outermost
      // `.optional()` wrapper is what preserves it.
      if (def?.type === "optional") node[OPTIONAL] = true;
    },
  }) as JsonNode & { $defs?: Defs };

  return { root, defs: root.$defs ?? {} };
}

/**
 * Resolve a `$ref` against `$defs`. Zod inlines reused schemas by default, so
 * refs only appear for recursive shapes — this is defensive, not load-bearing.
 * Sibling keys on the referencing node (e.g. a stamped marker) win over the
 * target's.
 */
function deref(node: JsonNode, defs: Defs, depth = 0): JsonNode {
  if (!node.$ref || depth > 10) return node;
  const key = node.$ref.replace(/^#\/\$defs\//, "");
  const target = defs[key];
  if (!target) return node;
  const { $ref: _drop, ...siblings } = node;
  return deref({ ...target, ...siblings }, defs, depth + 1);
}

/** Is this the `{ type: "null" }` branch a `.nullable()` contributes? */
function isNullNode(node: JsonNode): boolean {
  return node.type === "null";
}

/**
 * Split a `.nullable()` node into its non-null inner shape + a nullable flag.
 * A genuine union keeps its remaining branches (labelled `union` downstream).
 */
function stripNull(node: JsonNode): { inner: JsonNode; nullable: boolean } {
  if (!node.anyOf) return { inner: node, nullable: false };
  const nonNull = node.anyOf.filter((b) => !isNullNode(b));
  if (nonNull.length === node.anyOf.length) return { inner: node, nullable: false };
  if (nonNull.length === 1) return { inner: nonNull[0], nullable: true };
  return { inner: { anyOf: nonNull }, nullable: true };
}

/**
 * Does this property carry a `pii: "redact"` leaf anywhere under its wrapper
 * chain? Mirrors the wrappers the old Zod-side check recursed through:
 * optional/default (marker sits on the node), nullable (marker sits inside
 * `anyOf`), array (marker sits on `items`).
 */
function hasPiiRedact(node: JsonNode, defs: Defs, depth = 0): boolean {
  if (depth > 6) return false;
  const n = deref(node, defs);
  if (n[OMIT]) return true;
  if (n.anyOf?.some((b) => hasPiiRedact(b, defs, depth + 1))) return true;
  if (n.items && hasPiiRedact(n.items, defs, depth + 1)) return true;
  return false;
}

// ── Field filtering ─────────────────────────────────────────────────

const HIDDEN_SUFFIXES = ["_fs"];
const HIDDEN_PREFIXES = ["query_by_"];
const HIDDEN_FIELDS = new Set(["created_at", "updated_at"]);

function shouldHide(fieldName: string, fullPath: string): boolean {
  if (HIDDEN_FIELDS.has(fullPath)) return true;
  if (HIDDEN_SUFFIXES.some((s) => fieldName.endsWith(s))) return true;
  if (HIDDEN_PREFIXES.some((p) => fieldName.startsWith(p))) return true;
  return false;
}

// ── Type label ──────────────────────────────────────────────────────

/** Compact display label for a resolved (non-null-stripped) JSON Schema node. */
function typeLabel(node: JsonNode, defs: Defs): string {
  const n = deref(node, defs);

  if (n[TIMESTAMP]) return "Timestamp";
  if (n.const !== undefined) return String(n.const);
  if (Array.isArray(n.enum)) return n.enum.join(" | ");

  const t = Array.isArray(n.type) ? n.type[0] : n.type;
  switch (t) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return typeLabel(n.items ?? {}, defs) + "[]";
    case "object":
      // A z.record() has no declared `properties` — only key/value constraints.
      if (!n.properties && (n.propertyNames || typeof n.additionalProperties === "object")) {
        return "Record<string, ...>";
      }
      return "object";
  }

  if (n.anyOf) return "union";
  return t ?? "unknown";
}

// ── Schema walker ───────────────────────────────────────────────────

interface SchemaField {
  path: string;
  type: string;
}

/**
 * Label for one variant of a discriminated array union, read off its `type`
 * field. Long enums are shortened so the path prefix stays readable.
 */
function getUnionDiscriminantLabel(option: JsonNode, defs: Defs): string | null {
  const o = deref(option, defs);
  const typeField = o.properties?.type;
  if (!typeField) return null;

  const { inner } = stripNull(deref(typeField, defs));
  const n = deref(inner, defs);

  if (n.const !== undefined) return String(n.const);
  if (Array.isArray(n.enum)) {
    const values = n.enum.map(String);
    if (!values.length) return null;
    if (values.length > 3) return values.slice(0, 2).join(", ") + ", ...";
    return values.join(" | ");
  }
  return null;
}

function walkShape(
  node: JsonNode,
  defs: Defs,
  prefix: string,
  depth: number,
  results: SchemaField[],
): void {
  if (depth > 3) return;
  const { inner } = stripNull(deref(node, defs));
  const obj = deref(inner, defs);
  if (!obj.properties) return;

  for (const [key, rawVal] of Object.entries(obj.properties)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (shouldHide(key, path)) continue;
    if (hasPiiRedact(rawVal, defs)) continue;

    const val = deref(rawVal, defs);

    // `x-optional`, not the `required` array — a `.default()` field also drops
    // out of `required` but is always present on the stored document the
    // template actually reads. See the override hook.
    const opt = val[OPTIONAL] === true;
    const { inner: unwrapped, nullable } = stripNull(val);
    const resolved = deref(unwrapped, defs);

    const suffix = (opt ? "?" : "") + (nullable ? " | null" : "");
    results.push({ path, type: typeLabel(resolved, defs) + suffix });

    const resolvedType = Array.isArray(resolved.type) ? resolved.type[0] : resolved.type;

    // Recurse into nested objects
    if (resolvedType === "object" && resolved.properties) {
      walkShape(resolved, defs, path, depth + 1, results);
    }

    // Recurse into arrays
    if (resolvedType === "array" && resolved.items) {
      const { inner: elInner } = stripNull(deref(resolved.items, defs));
      const el = deref(elInner, defs);

      if (el.properties) {
        walkShape(el, defs, `${path}[]`, depth + 1, results);
      }

      // Union arrays — walk each variant separately
      if (el.anyOf) {
        for (const option of el.anyOf) {
          const label = getUnionDiscriminantLabel(option, defs);
          const variantPrefix = label ? `${path}[] (type: ${label})` : `${path}[]`;
          walkShape(option, defs, variantPrefix, depth + 1, results);
        }
      }
    }
  }
}

// ── Generate ────────────────────────────────────────────────────────

/** PARITY-GATE SCAFFOLD (Layer 3a) — sources only; Layer 3b widens to targets. */
const COLLECTIONS = [...TEMPLATE_SOURCE_COLLECTIONS] as string[];

const entries: string[] = [];

for (const collection of COLLECTIONS) {
  const schema = schemas[collection];
  const { root, defs } = toJson(schema);

  const fields: SchemaField[] = [];
  walkShape(root, defs, "", 0, fields);

  const fieldLines = fields
    .map((f) => `    { path: ${JSON.stringify(f.path)}, type: ${JSON.stringify(f.type)} },`)
    .join("\n");
  entries.push(`  ${JSON.stringify(collection)}: [\n${fieldLines}\n  ]`);
}

const output = `// AUTO-GENERATED by scripts/generate-schema-template-fields.ts — do not edit manually.
import type { TemplateSourceCollectionType } from "./template.ts";

/** A single field entry in the schema reference. */
export interface SchemaField {
  path: string;
  type: string;
}

/** Pre-compiled document field metadata for each template source collection. */
export const templateSchemaFields: Record<TemplateSourceCollectionType, SchemaField[]> = {
${entries.join(",\n")},
};
`;

const outPath = new URL("../src/schemas/template-schema-fields.generated.ts", import.meta.url);
await Deno.writeTextFile(outPath, output);
console.log(`Wrote ${outPath.pathname} (${COLLECTIONS.length} collections: ${COLLECTIONS.join(", ")})`);
