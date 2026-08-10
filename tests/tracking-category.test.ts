import { assertEquals } from "@std/assert";
import { TrackingCategorySchema } from "../src/schemas/tracking-category.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("TrackingCategorySchema validates a complete document", () => {
  const doc = {
    uid: "testtc10000000000000",
    name: "Cameras",
    count: 3,
    crms_product_group_id: 10,
    crms_product_group_name: "Camera Group",
    products: { "testp100000000000000": { uid: "testp100000000000000", name: "Canon C300" } },
    xero_tracking_option_id: "00000000-0000-4000-8000-000000000001",
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TrackingCategorySchema.safeParse(doc).success, true);
});

// Inverted with `tag.test.ts` — see the note there for why the record arm was
// unreachable, and why leaving it would have made a union-aware integer check
// pass on a schema that still admitted a map.

Deno.test("TrackingCategorySchema rejects count as a record — the arm is gone", () => {
  const doc = {
    uid: "testtc10000000000000",
    name: "Lenses",
    count: { total: 5 },
    crms_product_group_name: "Lens Group",
    products: {},
    xero_tracking_option_id: null,
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TrackingCategorySchema.safeParse(doc).success, false);
});

Deno.test("TrackingCategorySchema: count is a whole number, and stays optional", () => {
  const base = {
    uid: "testtc10000000000000",
    name: "Lenses",
    crms_product_group_name: "Lens Group",
    products: {},
    xero_tracking_option_id: null,
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    ...ts,
  };
  assertEquals(TrackingCategorySchema.safeParse({ ...base, count: 5 }).success, true);
  assertEquals(TrackingCategorySchema.safeParse({ ...base, count: 5.5 }).success, false);
  assertEquals(TrackingCategorySchema.safeParse(base).success, true);
});

Deno.test("TrackingCategorySchema rejects missing required fields", () => {
  assertEquals(TrackingCategorySchema.safeParse({ uid: "testtc10000000000000" }).success, false);
});

Deno.test("TrackingCategorySchema rejects additional properties", () => {
  const doc = {
    uid: "testtc10000000000000",
    name: "Audio",
    count: 0,
    crms_product_group_name: "Audio",
    products: {},
    xero_tracking_option_id: null,
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    bogus: true,
  };
  assertEquals(TrackingCategorySchema.safeParse(doc).success, false);
});
