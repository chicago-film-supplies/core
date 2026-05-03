import { assertEquals } from "@std/assert";
import { TagSchema } from "../src/tag.ts";

Deno.test("TagSchema validates a complete document", () => {
  const doc = {
    uid: "test-tag-1",
    name: "Lighting",
    count: 5,
    products: [{ uid: "test-p1", name: "LED Panel" }],
    query_by_products: ["test-p1"],
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  assertEquals(TagSchema.safeParse(doc).success, true);
});

Deno.test("TagSchema accepts count as record", () => {
  const doc = {
    uid: "test-tag-1",
    name: "Audio",
    count: { total: 3 },
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  assertEquals(TagSchema.safeParse(doc).success, true);
});

Deno.test("TagSchema rejects missing name", () => {
  assertEquals(TagSchema.safeParse({ uid: "test-tag-1" }).success, false);
});

Deno.test("TagSchema rejects additional properties", () => {
  const doc = {
    uid: "test-tag-1",
    name: "Audio",
    bogus: true,
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  assertEquals(TagSchema.safeParse(doc).success, false);
});
