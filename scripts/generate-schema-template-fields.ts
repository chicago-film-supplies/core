/**
 * Generates static template schema field metadata from Zod schemas.
 *
 * Walks each TEMPLATE_SOURCE_COLLECTIONS schema and outputs a typed
 * Record<TemplateSourceCollectionType, SchemaField[]> to
 * src/template-schema-fields.generated.ts — committed, not gitignored.
 *
 * Run: deno task generate-schema-template-fields
 */
import { z } from "zod";
import { schemas } from "../src/mod.ts";
import { TEMPLATE_SOURCE_COLLECTIONS } from "../src/template.ts";

// ── Zod introspection helpers (same pattern as tests/pii.test.ts) ───

type ZodDef = {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  entries?: Record<string, string>;
  values?: string[];
  options?: z.ZodType[];
  in?: z.ZodType;
  out?: z.ZodType;
};

function getDef(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

function unwrap(schema: z.ZodType): z.ZodType {
  const def = getDef(schema);
  if (
    (def.type === "optional" || def.type === "default" || def.type === "nullable") &&
    def.innerType
  ) {
    return unwrap(def.innerType);
  }
  if (def.type === "pipe" && def.in) {
    // Produced by `.transform()` factories (chicagoInstant, chicagoStartOfDay).
    // Unwrap to the input side so datetime/offset fields label as "string"
    // instead of "pipe".
    return unwrap(def.in);
  }
  return schema;
}

function getShape(schema: z.ZodType): Record<string, z.ZodType> | null {
  const def = getDef(schema);
  if (def.shape) return def.shape;
  if (def.innerType) return getShape(def.innerType);
  return null;
}

function getMeta(schema: z.ZodType): Record<string, unknown> | undefined {
  return z.globalRegistry.get(schema) as Record<string, unknown> | undefined;
}

function isOptional(schema: z.ZodType): boolean {
  return getDef(schema).type === "optional";
}

function isNullable(schema: z.ZodType): boolean {
  const def = getDef(schema);
  if (def.type === "nullable") return true;
  if (def.type === "optional" && def.innerType) return isNullable(def.innerType);
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

function hasPiiRedact(schema: z.ZodType): boolean {
  const meta = getMeta(schema);
  if (meta?.pii === "redact") return true;
  const def = getDef(schema);
  if ((def.type === "optional" || def.type === "default" || def.type === "nullable") && def.innerType) {
    return hasPiiRedact(def.innerType);
  }
  if (def.type === "array" && def.element) {
    return hasPiiRedact(def.element);
  }
  return false;
}

// ── Type label ──────────────────────────────────────────────────────

function typeLabel(schema: z.ZodType): string {
  const def = getDef(schema);
  switch (def.type) {
    case "string": return "string";
    case "number": case "int": return "number";
    case "boolean": return "boolean";
    case "enum": {
      const values = def.entries ? Object.values(def.entries) : def.values;
      return values?.join(" | ") || "enum";
    }
    case "literal":
      return def.values?.join(" | ") || "literal";
    case "array": {
      const el = unwrap(def.element!);
      const inner = typeLabel(el);
      return inner + "[]";
    }
    case "object": return "object";
    case "union": return "union";
    case "record": return "Record<string, ...>";
    case "custom": return "Timestamp";
    default: return def.type;
  }
}

// ── Schema walker ───────────────────────────────────────────────────

interface SchemaField {
  path: string;
  type: string;
}

function getUnionDiscriminantLabel(option: z.ZodType): string | null {
  const shape = getShape(option);
  if (!shape?.type) return null;
  const typeField = unwrap(shape.type);
  const def = getDef(typeField);
  if (def.type === "literal" && def.values?.length) {
    return def.values.join(" | ");
  }
  if (def.type === "enum") {
    const values = def.entries ? Object.values(def.entries) as string[] : def.values;
    if (!values?.length) return null;
    // Shorten long enum lists to avoid unwieldy labels
    if (values.length > 3) return values.slice(0, 2).join(", ") + ", ...";
    return values.join(" | ");
  }
  return null;
}

function walkShape(
  schema: z.ZodType,
  prefix: string,
  depth: number,
  results: SchemaField[],
): void {
  if (depth > 3) return;
  const u = unwrap(schema);
  const shape = getShape(u);
  if (!shape) return;

  for (const [key, val] of Object.entries(shape)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (shouldHide(key, path)) continue;
    if (hasPiiRedact(val)) continue;

    const opt = isOptional(val);
    const nul = isNullable(val);
    const inner = unwrap(val);
    const suffix = (opt ? "?" : "") + (nul ? " | null" : "");
    results.push({ path, type: typeLabel(inner) + suffix });

    const innerDef = getDef(inner);

    // Recurse into nested objects
    if (innerDef.type === "object" && innerDef.shape) {
      walkShape(inner, path, depth + 1, results);
    }

    // Recurse into arrays
    if (innerDef.type === "array" && innerDef.element) {
      const el = unwrap(innerDef.element);
      const elDef = getDef(el);

      if (elDef.type === "object" && elDef.shape) {
        walkShape(el, `${path}[]`, depth + 1, results);
      }

      // Union arrays — walk each variant separately
      if (elDef.type === "union" && elDef.options) {
        for (const option of elDef.options) {
          const label = getUnionDiscriminantLabel(option);
          const variantPrefix = label ? `${path}[] (type: ${label})` : `${path}[]`;
          walkShape(option, variantPrefix, depth + 1, results);
        }
      }
    }
  }
}

// ── Generate ────────────────────────────────────────────────────────

const entries: string[] = [];

for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
  const schema = schemas[collection];
  if (!schema) {
    console.error(`No schema found for collection: ${collection}`);
    Deno.exit(1);
  }

  const fields: SchemaField[] = [];
  walkShape(schema, "", 0, fields);

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

const outPath = new URL("../src/template-schema-fields.generated.ts", import.meta.url);
await Deno.writeTextFile(outPath, output);
console.log(`Wrote ${outPath.pathname} (${TEMPLATE_SOURCE_COLLECTIONS.length} collections)`);
