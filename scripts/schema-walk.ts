/**
 * Zod → template-field walk, shared by `generate-schema-template-fields.ts` and
 * its tests.
 *
 * **Engine: Zod 4's public `z.toJSONSchema()`.** Earlier revisions poked
 * `schema._zod.def` directly — an internal API with no stability guarantee that
 * could break silently on a Zod upgrade. We convert once to JSON Schema and walk
 * *that*, using the public `override` hook to carry across the three things JSON
 * Schema alone cannot express:
 *
 * 1. **PII** — `z.meta({ pii: "redact" })` leaves are stamped `x-omit` and are
 *    dropped from the output entirely (they must never reach a template author).
 *    Only `redact` is omitted; `mask`/`hash` fields are deliberately shown.
 * 2. **Firestore Timestamps** — `z.custom()` is unrepresentable, so
 *    `unrepresentable: "any"` renders it as a bare `{}` indistinguishable from
 *    `any`/`unknown`/`function`. It is stamped `x-timestamp` and labelled from that.
 * 3. **Optionality** — `.default(x)` and `.default(x).optional()` are byte-identical
 *    in JSON Schema (both carry `default`, both drop out of `required`), and a
 *    `.default()` over a `.transform()` pipe loses its `default` key entirely under
 *    `io: "input"`. Neither `required` nor the `default` key can therefore recover
 *    "is this field optional?" — the outermost `.optional()` wrapper is stamped
 *    `x-optional`.
 *
 * `io: "input"` resolves `.transform()` pipes (chicagoInstant / chicagoStartOfDay)
 * to their input side, so business datetimes label as `string` rather than `pipe`.
 *
 * This is deliberately NOT driven by `deno doc` (which powers the *helper*
 * catalogue): TS types carry no Zod metadata, so a deno-doc-driven schema panel
 * would lose `z.meta()` and — critically — expose the PII paths this walk hides.
 *
 * @module
 */
import { z } from "zod";

// ── Markers (see the module doc) ────────────────────────────────────

/** This leaf is `pii: "redact"` — omit it from the reference entirely. */
const OMIT = "x-omit";
/** This leaf is a `z.custom()` Firestore Timestamp. */
const TIMESTAMP = "x-timestamp";
/** This field's outermost wrapper is `.optional()`. */
const OPTIONAL = "x-optional";

// ── JSON Schema node model ──────────────────────────────────────────

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

/** A single field entry in the schema reference. */
export interface SchemaField {
  path: string;
  type: string;
}

/** Convert a Zod schema to JSON Schema, stamping the three lost markers. */
function toJson(schema: z.ZodType): { root: JsonNode; defs: Defs } {
  const root = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    override: (ctx) => {
      // `ctx.zodSchema` is Zod's internal `$ZodTypes` union; narrow it to the two
      // surfaces we actually rely on rather than asserting a whole `z.ZodType`.
      const zodSchema = ctx.zodSchema as unknown as {
        meta?: () => { pii?: string } | undefined;
        _zod?: { def?: { type?: string } };
      };
      const node = ctx.jsonSchema as JsonNode;

      // Public metadata API — no internal poking.
      if (zodSchema.meta?.()?.pii === "redact") node[OMIT] = true;

      // The wrapper *kind* is the one thing with no public accessor.
      const type = zodSchema._zod?.def?.type;
      if (type === "custom") node[TIMESTAMP] = true;
      if (type === "optional") node[OPTIONAL] = true;
    },
  }) as JsonNode & { $defs?: Defs };

  return { root, defs: root.$defs ?? {} };
}

/**
 * Resolve a `$ref` against `$defs`. Zod inlines reused schemas by default, so
 * refs only appear for recursive shapes — defensive, not load-bearing. Sibling
 * keys on the referencing node (e.g. a stamped marker) win over the target's.
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
 * chain? Covers the wrappers the leaf can hide behind: optional/default (marker
 * on the node), nullable (marker inside `anyOf`), array (marker on `items`).
 *
 * Stops at object boundaries — a nested object's own properties are each checked
 * on their own, so one redact leaf does not omit its whole parent.
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

/** Compact display label for a resolved, null-stripped JSON Schema node. */
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
      // A z.record() declares no `properties` — only key/value constraints.
      if (!n.properties && (n.propertyNames || typeof n.additionalProperties === "object")) {
        return "Record<string, ...>";
      }
      return "object";
  }

  if (n.anyOf) return "union";
  return t ?? "unknown";
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

// ── Walk ────────────────────────────────────────────────────────────

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
    // template actually reads.
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

/**
 * Walk a Zod object schema into the flat `{ path, type }` list the template
 * editor's Schema Reference renders. `pii: "redact"` paths are omitted; `_fs` /
 * `query_by_*` / top-level `created_at` / `updated_at` are hidden.
 */
export function walkSchema(schema: z.ZodType): SchemaField[] {
  const { root, defs } = toJson(schema);
  const fields: SchemaField[] = [];
  walkShape(root, defs, "", 0, fields);
  return fields;
}
