/**
 * Tests for the generated template schema field metadata.
 *
 * Verifies correctness of the static output and includes a staleness check that
 * re-renders the generator's output IN PROCESS and compares it against the
 * committed file.
 *
 * The generator derives its fields from `z.toJSONSchema()`. Two of its
 * behaviours cannot be proven by the generated output alone and are guarded by
 * the synthetic test at the bottom — see the comment there.
 */
import { assert, assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { z } from "zod";
import { TEMPLATE_SOURCE_COLLECTIONS, TEMPLATE_TARGET_COLLECTIONS } from "../src/schemas/template.ts";
import { isCollectionName, schemaFor } from "../src/schemas/mod.ts";
import { templateSchemaFields } from "../src/schemas/template-schema-fields.generated.ts";
import type { SchemaField } from "../src/schemas/template-schema-fields.generated.ts";
import { walkSchema } from "../scripts/schema-walk.ts";
import { renderTemplateSchemaFields } from "../scripts/generate-schema-template-fields.ts";

/**
 * `templateSchemaFields` is `Partial`, so indexing it yields
 * `SchemaField[] | undefined` under `strict: true`. Narrow once, here, rather
 * than sprinkling non-null assertions through the assertions below.
 */
function fieldsFor(collection: string): SchemaField[] {
  const fields = templateSchemaFields[collection as keyof typeof templateSchemaFields];
  assertExists(fields, `missing fields for ${collection}`);
  return fields;
}

/** Collections we expect to be present: every source, plus targets with a schema. */
const PRESENT_COLLECTIONS = [
  ...new Set<string>([...TEMPLATE_SOURCE_COLLECTIONS, ...TEMPLATE_TARGET_COLLECTIONS]),
].filter((c) => isCollectionName(c));

// ── Structural tests ────────────────────────────────────────────────

Deno.test("every source collection has a non-empty field array", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    assertNotEquals(fieldsFor(collection).length, 0, `empty fields for ${collection}`);
  }
});

Deno.test("target collections with a schema are present and non-empty", () => {
  // `quotes` has a real z.strictObject schema and must be walked.
  const quotes = fieldsFor("quotes");
  assertNotEquals(quotes.length, 0, "empty fields for quotes");
  assertExists(quotes.find((f) => f.path === "uid_order"), "quotes.uid_order missing");

  // `invoices` is both a source and a target — one entry serves both.
  assertNotEquals(fieldsFor("invoices").length, 0, "empty fields for invoices");
});

Deno.test("packing_lists is absent — it has no walkable schema", () => {
  assertEquals(
    templateSchemaFields["packing_lists"],
    undefined,
    "packing_lists has no schema in the `schemas` map, so it must not be emitted",
  );
  // Guard the premise: if a schema is ever added, this test should force a
  // re-think. ⚠️ Phrased as `isCollectionName(...) === false` rather than
  // `schemas["packing_lists"] === undefined`, because once `schemas` is the
  // precise mapped type the latter is a COMPILE error on an unknown key — a
  // stronger guarantee, but one that would delete this runtime premise-guard
  // instead of keeping it. Both now hold.
  assertEquals(isCollectionName("packing_lists"), false);
});

Deno.test("no _fs suffix fields appear", () => {
  for (const collection of PRESENT_COLLECTIONS) {
    const fsFields = fieldsFor(collection).filter((f) => {
      const lastSegment = f.path.split(".").at(-1) || "";
      return lastSegment.endsWith("_fs");
    });
    assertEquals(fsFields, [], `_fs fields found in ${collection}: ${fsFields.map((f) => f.path).join(", ")}`);
  }
});

Deno.test("no created_at/updated_at fields appear", () => {
  for (const collection of PRESENT_COLLECTIONS) {
    const timestampFields = fieldsFor(collection).filter((f) =>
      f.path === "created_at" || f.path === "updated_at"
    );
    assertEquals(timestampFields, [], `timestamp fields found in ${collection}`);
  }
});

Deno.test("no query_by_ fields appear", () => {
  for (const collection of PRESENT_COLLECTIONS) {
    const queryFields = fieldsFor(collection).filter((f) => {
      const firstSegment = f.path.split(".")[0];
      return firstSegment.startsWith("query_by_");
    });
    assertEquals(queryFields, [], `query_by_ fields found in ${collection}`);
  }
});

Deno.test("nested paths appear (e.g. organization.name)", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    const fields = fieldsFor(collection);
    const nested = fields.filter((f) => f.path.includes("."));
    assertNotEquals(nested.length, 0, `no nested fields in ${collection}`);
    const orgName = fields.find((f) => f.path === "organization.name");
    assertNotEquals(orgName, undefined, `organization.name missing in ${collection}`);
  }
});

Deno.test("order items union variants are shown separately", () => {
  const fields = fieldsFor("orders");
  const variantPaths = fields.filter((f) => f.path.includes("items[] (type:"));
  assertNotEquals(variantPaths.length, 0, "no union variant paths found");

  const destinationVariant = variantPaths.find((f) => f.path.includes("(type: destination)"));
  assertNotEquals(destinationVariant, undefined, "destination variant missing");

  const groupVariant = variantPaths.find((f) => f.path.includes("(type: group)"));
  assertNotEquals(groupVariant, undefined, "group variant missing");
});

Deno.test("nullable fields are labelled nullable", () => {
  // Regression guard for the bug the toJSONSchema migration fixed: the old
  // walker recursed `optional` but not `default`, so a `.nullable().default(null)`
  // field (TS: `string | null`) was labelled a plain non-null `string`.
  const dates = fieldsFor("orders").find((f) => f.path === "destinations[].dates.delivery_start");
  assertExists(dates, "destinations[].dates.delivery_start missing");
  assert(
    dates.type.includes("| null"),
    `delivery_start is \`.nullable().default(null)\` but labelled "${dates.type}"`,
  );
});

// ── PII ─────────────────────────────────────────────────────────────

Deno.test("no pii:\"redact\" path leaks into any collection (incl. targets)", () => {
  for (const collection of PRESENT_COLLECTIONS) {
    // `PRESENT_COLLECTIONS` is filtered by `isCollectionName` above, so this
    // cannot miss — but the filter erases the narrowing, hence the re-check.
    if (!isCollectionName(collection)) continue;
    const schema = schemaFor(collection);
    const redactPaths = collectRedactPaths(schema);
    const emitted = new Set(fieldsFor(collection).map((f) => f.path));

    for (const path of redactPaths) {
      assert(!emitted.has(path), `pii:"redact" path ${collection}.${path} leaked into the reference`);
    }
  }
});

/** Walk a Zod schema for the top-level keys tagged `pii: "redact"`. */
function collectRedactPaths(schema: z.ZodType): string[] {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as {
    properties?: Record<string, { pii?: string }>;
  };
  return Object.entries(json.properties ?? {})
    .filter(([, node]) => node?.pii === "redact")
    .map(([key]) => key);
}

/**
 * **The synthetic PII guard.**
 *
 * The migration to `z.toJSONSchema()` had to preserve PII omission, but the
 * parity diff could not prove it: `pii: "redact"` exists only on auth/user/
 * invite/log/email schemas, and *none* of those are walked here. orders /
 * invoices / quotes carry only `pii: "mask"` / `"hash"`, which are deliberately
 * shown. So the redact branch is never exercised by the real collections — the
 * test above is vacuously green and would stay green if omission broke entirely.
 *
 * This builds a schema that *does* reach the branch, with the leaf behind every
 * wrapper the walker must see through (optional / nullable / default / array /
 * nested object), and asserts the path is gone while a sibling `mask` field —
 * which must NOT be omitted — survives.
 */
Deno.test("synthetic: pii:\"redact\" leaves are omitted under every wrapper", () => {
  const Nested = z.object({
    secret: z.string().meta({ pii: "redact" }),
    kept: z.string(),
  });

  const Synthetic = z.object({
    direct: z.string().meta({ pii: "redact" }),
    optional: z.string().meta({ pii: "redact" }).optional(),
    nullable: z.string().meta({ pii: "redact" }).nullable(),
    defaulted: z.string().meta({ pii: "redact" }).default("x"),
    array: z.array(z.string().meta({ pii: "redact" })),
    nested: Nested,
    masked: z.string().meta({ pii: "mask" }),
    plain: z.string(),
  });

  const paths = new Set(walkSchema(Synthetic).map((f) => f.path));

  for (const omitted of ["direct", "optional", "nullable", "defaulted", "array", "nested.secret"]) {
    assert(!paths.has(omitted), `pii:"redact" path "${omitted}" was NOT omitted`);
  }

  // Omission must be surgical: `mask`/`hash` are intentionally shown, and a
  // redact leaf must not take its whole parent object down with it.
  assert(paths.has("masked"), 'pii:"mask" field was omitted — only "redact" should be');
  assert(paths.has("plain"), "an untagged field was omitted");
  assert(paths.has("nested"), "the parent object of a redact leaf was omitted");
  assert(paths.has("nested.kept"), "a clean sibling of a redact leaf was omitted");
});

/**
 * **The synthetic union guard.**
 *
 * `z.union()` serializes to `anyOf`; `z.discriminatedUnion()` serializes to
 * `oneOf`. A walker reading only `anyOf` does not fail on a discriminated union
 * — it silently reports the whole array as `unknown[]` and drops every field
 * beneath it. That is exactly what happened when `OrderDocItem` became a
 * discriminated union: the entire `items[]` catalog vanished from the generated
 * file in one commit.
 *
 * The staleness check below cannot catch this. It regenerates and compares, so
 * it certifies whatever the walker currently produces — a fixed-point check
 * agreeing with its own oracle. This asserts the property independently: both
 * union spellings must be descended into, and their variants labelled.
 */
Deno.test("synthetic: both union spellings are walked (anyOf AND oneOf)", () => {
  const lineArm = z.object({ type: z.enum(["rental", "sale"]), base: z.number() });
  const dividerArm = z.object({ type: z.literal("group"), label: z.string() });

  const plain = z.object({ items: z.array(z.union([lineArm, dividerArm])) });
  const discriminated = z.object({
    items: z.array(z.discriminatedUnion("type", [lineArm, dividerArm])),
  });

  for (const [spelling, schema] of [["anyOf/union", plain], ["oneOf/discriminatedUnion", discriminated]] as const) {
    const fields = walkSchema(schema);
    const paths = new Set(fields.map((f) => f.path));

    assertEquals(
      fields.find((f) => f.path === "items")?.type,
      "union[]",
      `${spelling}: items was not labelled as a union — the walker did not see the branches`,
    );
    assert(
      paths.has("items[] (type: rental | sale).base"),
      `${spelling}: the line-item variant's fields are missing`,
    );
    assert(
      paths.has("items[] (type: group).label"),
      `${spelling}: the divider variant's fields are missing`,
    );
  }
});

// ── Staleness check ─────────────────────────────────────────────────

/**
 * ⚠️ This compares against the generator's RETURN VALUE, not against the file
 * it would have written.
 *
 * It used to spawn the generator as a subprocess and re-read the file. A
 * spawned child carries its own permission set, so that test wrote into `src/`
 * on every green run regardless of what the test process was allowed to do —
 * i.e. a passing suite silently rewrote two tracked files, which is exactly
 * what you do not want happening underneath a schema migration. `deno task
 * test` now runs without `--allow-run` or `--allow-write`, and that permission
 * removal *is* the enforcement; this shape is what lets the check survive it.
 *
 * Its sibling `template-helpers.generated.ts` cannot be checked this way — its
 * generator shells out to `deno doc` — so that one is gated by
 * `deno task check:generated` instead. See that task and this file's sibling.
 */
Deno.test("generated file is up to date", async () => {
  const generatedPath = new URL("../src/schemas/template-schema-fields.generated.ts", import.meta.url);

  const committed = await Deno.readTextFile(generatedPath);

  assertEquals(
    renderTemplateSchemaFields(),
    committed,
    "template-schema-fields.generated.ts is stale — run: deno task generate-schema-template-fields",
  );
});
