import { assertEquals } from "@std/assert";
import { getInitialValues } from "../src/initial.ts";
import { LocationSchema } from "../src/location.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const locationBase = getInitialValues(LocationSchema) as Record<string, unknown>;

const validLocation = {
  ...locationBase,
  uid: "test-loc-1",
  uid_store: "test-store-1",
  name: "Aisle A",
  default: true,
  active: true,
  product_capacities: [{ uid: "test-p1", max: 50, max_default: 40 }],
  query_by_product_capacities: ["test-p1"],
  products: [{ uid: "test-p1", name: "LED Panel", quantity: 10, default: true }],
  query_by_products: ["test-p1"],
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("LocationSchema validates a complete document", () => {
  assertEquals(LocationSchema.safeParse(validLocation).success, true);
});

Deno.test("LocationSchema defaults arrays when omitted", () => {
  const { product_capacities: _, query_by_product_capacities: _q, products: _p, query_by_products: _qp, ...doc } = validLocation;
  assertEquals(LocationSchema.safeParse(doc).success, true);
});

Deno.test("LocationSchema rejects missing uid_store", () => {
  const { uid_store: _, ...doc } = validLocation;
  assertEquals(LocationSchema.safeParse(doc).success, false);
});

Deno.test("LocationSchema accepts null max_default", () => {
  const doc = {
    ...validLocation,
    product_capacities: [{ uid: "test-p1", max: 50, max_default: null }],
  };
  assertEquals(LocationSchema.safeParse(doc).success, true);
});

Deno.test("LocationSchema rejects additional properties", () => {
  const doc = { ...validLocation, bogus: true };
  assertEquals(LocationSchema.safeParse(doc).success, false);
});
