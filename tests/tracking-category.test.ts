import { assertEquals } from "@std/assert";
import { TrackingCategorySchema } from "../src/tracking-category.ts";

Deno.test("TrackingCategorySchema validates a complete document", () => {
  const doc = {
    uid: "test-tc-1",
    name: "Cameras",
    count: 3,
    crms_product_group_id: 10,
    crms_product_group_name: "Camera Group",
    products: { "test-p1": { uid: "test-p1", name: "Canon C300" } },
    xero_tracking_option_id: "test-xero-1",
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  assertEquals(TrackingCategorySchema.safeParse(doc).success, true);
});

Deno.test("TrackingCategorySchema accepts count as record", () => {
  const doc = {
    uid: "test-tc-1",
    name: "Lenses",
    count: { total: 5 },
    crms_product_group_name: "Lens Group",
    products: {},
    xero_tracking_option_id: null,
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
  };
  assertEquals(TrackingCategorySchema.safeParse(doc).success, true);
});

Deno.test("TrackingCategorySchema rejects missing required fields", () => {
  assertEquals(TrackingCategorySchema.safeParse({ uid: "test-tc-1" }).success, false);
});

Deno.test("TrackingCategorySchema rejects additional properties", () => {
  const doc = {
    uid: "test-tc-1",
    name: "Audio",
    count: 0,
    crms_product_group_name: "Audio",
    products: {},
    xero_tracking_option_id: null,
    created_by: { uid: "test-user-1", name: "Test User" },
    updated_by: { uid: "test-user-1", name: "Test User" },
    bogus: true,
  };
  assertEquals(TrackingCategorySchema.safeParse(doc).success, false);
});
