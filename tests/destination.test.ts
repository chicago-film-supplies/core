import { assertEquals } from "@std/assert";
import { DestinationSchema } from "../src/schemas/destination.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

// The tree is REQUIRED since 2026-09-20 — a flat destination is a property of
// one, self-inclusive, so every fixture here carries its own single node. The
// tree's own invariants are planted in both directions in `destinations.test.ts`.
const UID = "testdest100000000000";
const tree = { path: [{ uid: UID, name: "Main" }], query_by_path: [UID] };

Deno.test("DestinationSchema validates a complete document", () => {
  const doc = {
    uid: UID,
    ...tree,
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
    ...ts,
  };
  assertEquals(DestinationSchema.safeParse(doc).success, true);
});

Deno.test("DestinationSchema accepts null address", () => {
  const doc = { uid: UID, ...tree, address: null, mapbox_ids: [], ...ts };
  assertEquals(DestinationSchema.safeParse(doc).success, true);
});

Deno.test("DestinationSchema rejects missing uid", () => {
  assertEquals(DestinationSchema.safeParse({ address: null }).success, false);
});

Deno.test("DestinationSchema rejects additional properties", () => {
  const doc = { uid: UID, ...tree, address: null, mapbox_ids: [], bogus: true };
  assertEquals(DestinationSchema.safeParse(doc).success, false);
});
