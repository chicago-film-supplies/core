import { assertEquals } from "@std/assert";
import { WebshopProductSchema } from "../src/webshop-product.ts";
import { getInitialValues } from "../src/initial.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const base = getInitialValues(WebshopProductSchema);
const validWebshopProduct = {
  ...base,
  uid: "test-wp-1",
  name: "Canon C300",
  active: true,
  price: { ...(base.price as Record<string, unknown>), base: 500, taxes: [{ uid: "test-chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" }], discountable: true },
  webshop: { available: true, description: "Great camera" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("WebshopProductSchema validates a complete document", () => {
  assertEquals(WebshopProductSchema.safeParse(validWebshopProduct).success, true);
});

Deno.test("WebshopProductSchema rejects replacement type", () => {
  const doc = { ...validWebshopProduct, type: "replacement" };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});

Deno.test("WebshopProductSchema accepts optional tags", () => {
  const doc = {
    ...validWebshopProduct,
    tags: [{ uid: "test-t1", name: "Camera" }],
    query_by_tags: ["test-t1"],
  };
  assertEquals(WebshopProductSchema.safeParse(doc).success, true);
});

Deno.test("WebshopProductSchema rejects missing required fields", () => {
  assertEquals(WebshopProductSchema.safeParse({ uid: "test-wp-1" }).success, false);
});

Deno.test("WebshopProductSchema rejects additional properties", () => {
  const doc = { ...validWebshopProduct, bogus: true };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});
