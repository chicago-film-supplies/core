import { assertEquals } from "@std/assert";
import { LocationTypeSchema } from "../src/location-type.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("LocationTypeSchema validates a complete document", () => {
  const doc = {
    uid: "testlt10000000000000",
    name: "Shelf",
    product_capacities: [{ uid: "testp100000000000000", max: 10 }],
    active: true,
    dimensions: { width: 100, depth: 50, height: 200, weight_capacity: 500 },
    ...ts,
  };
  assertEquals(LocationTypeSchema.safeParse(doc).success, true);
});

Deno.test("LocationTypeSchema accepts null max in capacities", () => {
  const doc = {
    uid: "testlt10000000000000",
    name: "Floor",
    product_capacities: [{ uid: "testp100000000000000", max: null }],
    active: true,
    ...ts,
  };
  assertEquals(LocationTypeSchema.safeParse(doc).success, true);
});

Deno.test("LocationTypeSchema accepts null dimensions", () => {
  const doc = {
    uid: "testlt10000000000000",
    name: "Bin",
    product_capacities: [],
    active: false,
    dimensions: null,
    ...ts,
  };
  assertEquals(LocationTypeSchema.safeParse(doc).success, true);
});

Deno.test("LocationTypeSchema rejects missing name", () => {
  assertEquals(LocationTypeSchema.safeParse({ uid: "testlt10000000000000", active: true }).success, false);
});

Deno.test("LocationTypeSchema rejects additional properties", () => {
  const doc = { uid: "testlt10000000000000", name: "Shelf", active: true, bogus: true };
  assertEquals(LocationTypeSchema.safeParse(doc).success, false);
});
