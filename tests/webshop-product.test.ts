import { assertEquals } from "@std/assert";
import { WebshopProductSchema } from "../src/schemas/webshop-product.ts";
import { getInitialValues } from "../src/schemas/initial.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const base = getInitialValues(WebshopProductSchema);
const validWebshopProduct = {
  ...base,
  uid: "testwp10000000000000",
  name: "Canon C300",
  active: true,
  price: { ...(base.price as Record<string, unknown>), base_cents: 50000, taxes: [{ uid: "testchirentaltax0000", name: "Chicago Rental Tax", rate: 15, type: "percent" }], discountable: true },
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
    tags: [{ uid: "testt100000000000000", name: "Camera" }],
    query_by_tags: ["testt100000000000000"],
  };
  assertEquals(WebshopProductSchema.safeParse(doc).success, true);
});

Deno.test("WebshopProductSchema rejects missing required fields", () => {
  assertEquals(WebshopProductSchema.safeParse({ uid: "testwp10000000000000" }).success, false);
});

Deno.test("WebshopProductSchema rejects additional properties", () => {
  const doc = { ...validWebshopProduct, bogus: true };
  assertEquals(WebshopProductSchema.safeParse(doc).success, false);
});
