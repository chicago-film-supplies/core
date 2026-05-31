import { assertEquals } from "@std/assert";
import { TagSchema } from "../src/tag.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("TagSchema validates a complete document", () => {
  const doc = {
    uid: "testtag1000000000000",
    name: "Lighting",
    count: 5,
    products: [{ uid: "testp100000000000000", name: "LED Panel" }],
    query_by_products: ["testp100000000000000"],
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TagSchema.safeParse(doc).success, true);
});

Deno.test("TagSchema accepts count as record", () => {
  const doc = {
    uid: "testtag1000000000000",
    name: "Audio",
    count: { total: 3 },
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TagSchema.safeParse(doc).success, true);
});

Deno.test("TagSchema rejects missing name", () => {
  assertEquals(TagSchema.safeParse({ uid: "testtag1000000000000" }).success, false);
});

Deno.test("TagSchema rejects additional properties", () => {
  const doc = {
    uid: "testtag1000000000000",
    name: "Audio",
    bogus: true,
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
  };
  assertEquals(TagSchema.safeParse(doc).success, false);
});
