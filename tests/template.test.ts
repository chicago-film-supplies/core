/**
 * Tests for the operator-managed `fixtures: FixtureMeta[]` manifest on
 * TemplateSchema. The manifest is projected from the family sidecar's
 * `fixtures` array; files in `fixtures/<git_path>/` remain authoritative,
 * so this list only enriches the manager UI with labels.
 */
import { assertEquals } from "@std/assert";
import { FixtureMetaSchema, TemplateSchema } from "../src/schemas/template.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

function baseFamily(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: "t1000000000000000000",
    git_path: "quote",
    name: "Quote",
    collection_source: "orders",
    collection_target: "quotes",
    surfaces: ["order"],
    uid_active: null,
    depends_on: { components: [] },
    draft_uids: [],
    version_count: 0,
    last_published_at: null,
    uid_thread: "th100000000000000000",
    version: 0,
    created_by: { uid: "u1000000000000000000", name: "Tester" },
    updated_by: { uid: "u1000000000000000000", name: "Tester" },
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...extra,
  };
}

Deno.test("FixtureMetaSchema accepts a minimal entry", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "order-841", label: "Order 841" }).success,
    true,
  );
});

Deno.test("FixtureMetaSchema accepts an entry with description", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({
      slug: "order-841",
      label: "Order 841 — multi-destination",
      description: "Three destinations, tax-exempt subgroup, six rentals.",
    }).success,
    true,
  );
});

Deno.test("FixtureMetaSchema rejects an empty slug", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "", label: "x" }).success,
    false,
  );
});

Deno.test("FixtureMetaSchema rejects unknown keys", () => {
  assertEquals(
    FixtureMetaSchema.safeParse({ slug: "s", label: "l", extra: 1 }).success,
    false,
  );
});

Deno.test("TemplateSchema defaults fixtures to []", () => {
  const res = TemplateSchema.safeParse(baseFamily());
  assertEquals(res.success, true);
  if (res.success) assertEquals(res.data.fixtures, []);
});

Deno.test("TemplateSchema accepts a family with multiple fixtures", () => {
  const res = TemplateSchema.safeParse(
    baseFamily({
      fixtures: [
        { slug: "order-841", label: "Order 841" },
        { slug: "tax-exempt", label: "Tax-exempt customer" },
      ],
    }),
  );
  assertEquals(res.success, true);
  if (res.success) assertEquals(res.data.fixtures.length, 2);
});
