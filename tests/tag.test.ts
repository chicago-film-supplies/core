import { assertEquals } from "@std/assert";
import { TagSchema } from "../src/schemas/tag.ts";
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

// `count` used to be `z.union([z.record(…FieldValue…), z.number()])`, and this
// test asserted the record arm parsed. It was never reachable: a top-level
// FieldValue sentinel is STRIPPED by `validateBeforeWrite` (the key is omitted),
// so it never reaches `safeParse` — the `.optional()` is what tolerates a
// sentinel write, not the record arm. Measured 2026-08-10: 45 prod / 45 dev tag
// documents and 21 / 21 tracking categories, all holding a concrete
// non-negative integer, zero records.
//
// The arm was not merely dead, it was harmful. `count` backs a Typesense
// `int32` AND is `tags.default_sorting_field`, so an object there is
// unindexable — and under a union predicate that asks whether ANY arm is
// integer-safe, tightening the number arm alone would read as fixed while the
// record arm still admitted a map.

Deno.test("TagSchema rejects count as a record — the arm is gone", () => {
  const doc = {
    uid: "testtag1000000000000",
    name: "Audio",
    count: { total: 3 },
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TagSchema.safeParse(doc).success, false);
});

Deno.test("TagSchema: count is a whole number, and stays optional", () => {
  const base = {
    uid: "testtag1000000000000",
    name: "Audio",
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TagSchema.safeParse({ ...base, count: 3 }).success, true);
  assertEquals(TagSchema.safeParse({ ...base, count: 0 }).success, true);
  assertEquals(TagSchema.safeParse({ ...base, count: 3.5 }).success, false);
  // Absent stays legal — that is what tolerates a stripped sentinel, and what
  // `typesense-parity`'s ALLOWED_GAPS entry is really about.
  assertEquals(TagSchema.safeParse(base).success, true);
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
