/**
 * Utility to derive initial/blank values from a Zod schema's structure.
 * Replaces hand-authored .meta({ initial }) blobs with schema-driven generation.
 */
import type { z } from "zod";

const SKIP: unique symbol = Symbol("skip");

// deno-lint-ignore no-explicit-any
function resolveField(schema: any): unknown {
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
      // Produced by `.transform()` — resolve against the input side so
      // factories like chicagoInstant() inherit the ISO-datetime initial.
      return resolveField(def.in);
    case "string":
      if (def.format === "datetime") return "1970-01-01T00:00:00Z";
      if (def.format === "date") return "1970-01-01";
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
 */
export function getInitialValues(schema: z.ZodType): Record<string, unknown> {
  const result = resolveField(schema);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("getInitialValues requires an object schema");
  }
  return result as Record<string, unknown>;
}
