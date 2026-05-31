import { assertEquals } from "@std/assert";
import { DestinationSchema } from "../src/destination.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("DestinationSchema validates a complete document", () => {
  const doc = {
    uid: "testdest100000000000",
    address: {
      city: "Chicago",
      country_name: "US",
      full: "123 Main St",
      name: "Main",
      postcode: "60601",
      region: "IL",
      street: "123 Main St",
    },
    mapbox_ids: ["test-mbx-1"],
    organizations: [{ uid: "testorg1000000000000", name: "Acme" }],
    query_by_organizations: ["testorg1000000000000"],
    ...ts,
  };
  assertEquals(DestinationSchema.safeParse(doc).success, true);
});

Deno.test("DestinationSchema accepts null address", () => {
  const doc = { uid: "testdest100000000000", address: null, mapbox_ids: [], ...ts };
  assertEquals(DestinationSchema.safeParse(doc).success, true);
});

Deno.test("DestinationSchema rejects missing uid", () => {
  assertEquals(DestinationSchema.safeParse({ address: null }).success, false);
});

Deno.test("DestinationSchema rejects additional properties", () => {
  const doc = { uid: "testdest100000000000", address: null, mapbox_ids: [], bogus: true };
  assertEquals(DestinationSchema.safeParse(doc).success, false);
});
