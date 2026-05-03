import { assertEquals } from "@std/assert";
import { z } from "zod";
import { getTypesenseDisplayDefaults } from "../src/display-defaults.ts";
import { firestoreDisplayDefaults, schemas } from "../src/mod.ts";
import { BookingSchema } from "../src/booking.ts";
import { TypesenseConfigSchema } from "../src/typesense-config.ts";
import { typesenseSchemas } from "../src/typesense/mod.ts";

/**
 * Segments that never make sense as display columns: identifiers, external-system
 * refs, optimistic-lock counters. Mirrors the manager's column/filter walker
 * exclusion set so this invariant locks drift at the source.
 * Any segment starting with `query_by_` is also excluded (internal facet arrays).
 */
const EXCLUDED_COLUMN_SEGMENTS = new Set([
  "uid",
  "crms",
  "xero",
  "id",
  "version",
]);

function isExcludedSegment(seg: string): boolean {
  return EXCLUDED_COLUMN_SEGMENTS.has(seg) ||
    seg.startsWith("query_by_") ||
    seg.startsWith("uid_");
}

/** Unwrap ZodOptional / ZodDefault / ZodNullable wrappers to the inner type. */
function unwrapZod(node: z.ZodType): z.ZodType {
  let n = node as unknown as { unwrap?: () => z.ZodType; removeDefault?: () => z.ZodType };
  while (n?.unwrap || n?.removeDefault) {
    if (n.removeDefault) n = n.removeDefault() as unknown as typeof n;
    else n = n.unwrap!() as unknown as typeof n;
  }
  return n as unknown as z.ZodType;
}

/**
 * Walk a dotted path through the Zod schema, unwrapping wrappers at each step
 * and descending into ZodObject shapes. Returns true iff each segment resolves
 * to an existing field in the shape.
 */
function resolvesInShape(schema: z.ZodType, path: string): boolean {
  const segments = path.split(".");
  let n: z.ZodType = schema;
  for (const seg of segments) {
    n = unwrapZod(n);
    if (!(n instanceof z.ZodObject)) return false;
    const shape = (n as z.ZodObject).shape as Record<string, z.ZodType>;
    if (!(seg in shape)) return false;
    n = shape[seg];
  }
  return true;
}

/** Collections that are not client-readable and don't need display prefs. */
const EXCLUDED_COLLECTIONS = new Set(["session", "sessions"]);

/**
 * Deduplicate the schemas record by identity — returns one [key[], schema]
 * tuple per unique schema.
 */
function uniqueSchemas(): [string[], z.ZodType][] {
  const map = new Map<z.ZodType, string[]>();
  for (const [key, schema] of Object.entries(schemas)) {
    const existing = map.get(schema);
    if (existing) {
      existing.push(key);
    } else {
      map.set(schema, [key]);
    }
  }
  return [...map.entries()].map(([schema, keys]) => [keys, schema]);
}

Deno.test("every schema (except sessions) has displayDefaults in meta", () => {
  for (const [keys, schema] of uniqueSchemas()) {
    if (keys.every((k) => EXCLUDED_COLLECTIONS.has(k))) continue;
    const meta = z.globalRegistry.get(schema) as
      | { displayDefaults?: unknown }
      | undefined;
    assertEquals(
      meta?.displayDefaults != null,
      true,
      `schema [${keys.join(", ")}] is missing displayDefaults in .meta()`,
    );
  }
});

Deno.test("firestoreDisplayDefaults is derived for every non-session schema key", () => {
  for (const key of Object.keys(schemas)) {
    if (EXCLUDED_COLLECTIONS.has(key)) continue;
    assertEquals(
      key in firestoreDisplayDefaults,
      true,
      `"${key}" missing from firestoreDisplayDefaults`,
    );
  }
});

Deno.test("sessions are excluded from firestoreDisplayDefaults", () => {
  assertEquals("session" in firestoreDisplayDefaults, false);
  assertEquals("sessions" in firestoreDisplayDefaults, false);
});

Deno.test("no Firestore collection has empty columns", () => {
  for (const [key, defaults] of Object.entries(firestoreDisplayDefaults)) {
    assertEquals(defaults.columns.length > 0, true, `"${key}" has empty columns`);
  }
});

Deno.test("Firestore display defaults have correct shape", () => {
  for (const [key, defaults] of Object.entries(firestoreDisplayDefaults)) {
    assertEquals(Array.isArray(defaults.columns), true, `${key}: columns should be array`);
    assertEquals(typeof defaults.filters, "object", `${key}: filters should be object`);
    assertEquals(typeof defaults.sort, "object", `${key}: sort should be object`);
    assertEquals(
      defaults.sort.direction === "asc" || defaults.sort.direction === "desc",
      true,
      `${key}: sort.direction should be asc or desc`,
    );
  }
});

Deno.test("every Typesense collection has displayDefaults", () => {
  for (const alias of Object.keys(typesenseSchemas)) {
    const defaults = getTypesenseDisplayDefaults(alias);
    assertEquals(
      defaults !== undefined,
      true,
      `Typesense collection "${alias}" is missing displayDefaults`,
    );
  }
});

Deno.test("getTypesenseDisplayDefaults returns defaults for known aliases", () => {
  const defaults = getTypesenseDisplayDefaults("bookings");
  assertEquals(defaults !== undefined, true);
  assertEquals(defaults!.columns.length > 0, true);
});

Deno.test("getTypesenseDisplayDefaults returns undefined for unknown alias", () => {
  const defaults = getTypesenseDisplayDefaults("nonexistent");
  assertEquals(defaults, undefined);
});

Deno.test("booking.number carries label + linkTo meta", () => {
  const numberField = (BookingSchema as unknown as { shape: Record<string, z.ZodType> }).shape.number;
  const meta = z.globalRegistry.get(numberField) as
    | { label?: string; linkTo?: string }
    | undefined;
  assertEquals(meta?.label, "#");
  assertEquals(meta?.linkTo, "fulfillmentDetail");
});

Deno.test("booking displayDefaults use real Firestore paths (not aliases)", () => {
  const meta = z.globalRegistry.get(BookingSchema) as
    | { displayDefaults?: { columns: string[]; sort: { column: string | null } } }
    | undefined;
  assertEquals(meta?.displayDefaults?.columns, [
    "number",
    "status",
    "organization.name",
    "quantity",
    "dates.start",
    "dates.end",
  ]);
  assertEquals(meta?.displayDefaults?.sort?.column, "number");
});

Deno.test("typesense-config displayDefaults do not expose uid", () => {
  const meta = z.globalRegistry.get(TypesenseConfigSchema) as
    | { displayDefaults?: { columns: string[] } }
    | undefined;
  const columns = meta?.displayDefaults?.columns ?? [];
  assertEquals(columns.includes("uid"), false);
});

Deno.test("every displayDefaults.columns key resolves and passes exclusion rules", () => {
  for (const [keys, schema] of uniqueSchemas()) {
    if (keys.every((k) => EXCLUDED_COLLECTIONS.has(k))) continue;
    const meta = z.globalRegistry.get(schema) as
      | { displayDefaults?: { columns: string[] } }
      | undefined;
    const columns = meta?.displayDefaults?.columns;
    if (!columns) continue;

    for (const colKey of columns) {
      for (const seg of colKey.split(".")) {
        assertEquals(
          isExcludedSegment(seg),
          false,
          `column "${colKey}" in [${keys.join(", ")}] has excluded segment "${seg}"`,
        );
      }
      assertEquals(
        resolvesInShape(schema, colKey),
        true,
        `column "${colKey}" in [${keys.join(", ")}] does not resolve to a field in the Zod schema`,
      );
    }
  }
});
