/**
 * Tests for the generated template schema field metadata.
 *
 * Verifies correctness of the static output and includes a staleness
 * check that re-runs the generator and compares against the committed file.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { TEMPLATE_SOURCE_COLLECTIONS } from "../src/schemas/template.ts";
import { templateSchemaFields } from "../src/schemas/template-schema-fields.generated.ts";
import type { SchemaField } from "../src/schemas/template-schema-fields.generated.ts";

// ── Structural tests ────────────────────────────────────────────────

Deno.test("every source collection has a non-empty field array", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    const fields = templateSchemaFields[collection];
    assertNotEquals(fields, undefined, `missing fields for ${collection}`);
    assertNotEquals(fields.length, 0, `empty fields for ${collection}`);
  }
});

Deno.test("no _fs suffix fields appear", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    const fields = templateSchemaFields[collection];
    const fsFields = fields.filter((f: SchemaField) => {
      const lastSegment = f.path.split(".").at(-1) || "";
      return lastSegment.endsWith("_fs");
    });
    assertEquals(fsFields, [], `_fs fields found in ${collection}: ${fsFields.map((f: SchemaField) => f.path).join(", ")}`);
  }
});

Deno.test("no created_at/updated_at fields appear", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    const fields = templateSchemaFields[collection];
    const timestampFields = fields.filter((f: SchemaField) =>
      f.path === "created_at" || f.path === "updated_at"
    );
    assertEquals(timestampFields, [], `timestamp fields found in ${collection}`);
  }
});

Deno.test("no query_by_ fields appear", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    const fields = templateSchemaFields[collection];
    const queryFields = fields.filter((f: SchemaField) => {
      const firstSegment = f.path.split(".")[0];
      return firstSegment.startsWith("query_by_");
    });
    assertEquals(queryFields, [], `query_by_ fields found in ${collection}`);
  }
});

Deno.test("nested paths appear (e.g. organization.name)", () => {
  for (const collection of TEMPLATE_SOURCE_COLLECTIONS) {
    const fields = templateSchemaFields[collection];
    const nested = fields.filter((f: SchemaField) => f.path.includes("."));
    assertNotEquals(nested.length, 0, `no nested fields in ${collection}`);
    const orgName = fields.find((f: SchemaField) => f.path === "organization.name");
    assertNotEquals(orgName, undefined, `organization.name missing in ${collection}`);
  }
});

Deno.test("order items union variants are shown separately", () => {
  const fields = templateSchemaFields["orders"];
  const variantPaths = fields.filter((f: SchemaField) => f.path.includes("items[] (type:"));
  assertNotEquals(variantPaths.length, 0, "no union variant paths found");

  // Check destination variant exists
  const destinationVariant = variantPaths.find((f: SchemaField) => f.path.includes("(type: destination)"));
  assertNotEquals(destinationVariant, undefined, "destination variant missing");

  // Check group variant exists
  const groupVariant = variantPaths.find((f: SchemaField) => f.path.includes("(type: group)"));
  assertNotEquals(groupVariant, undefined, "group variant missing");
});

// ── Staleness check ─────────────────────────────────────────────────

Deno.test("generated file is up to date", async () => {
  const scriptPath = new URL("../scripts/generate-schema-template-fields.ts", import.meta.url);
  const generatedPath = new URL("../src/schemas/template-schema-fields.generated.ts", import.meta.url);

  const committed = await Deno.readTextFile(generatedPath);

  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-write", scriptPath.pathname],
    stdout: "piped",
    stderr: "piped",
  });
  const { code } = await command.output();
  assertEquals(code, 0, "generator script failed");

  const regenerated = await Deno.readTextFile(generatedPath);
  assertEquals(
    regenerated,
    committed,
    "template-schema-fields.generated.ts is stale — run: deno task generate-schema-template-fields",
  );
});
