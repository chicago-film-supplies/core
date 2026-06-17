import { assertEquals } from "@std/assert";
import { CacheGeocodesSchema } from "../src/schemas/cache-geocodes.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, expiresAt: mockTimestamp };

Deno.test("CacheGeocodesSchema validates a complete document", () => {
  const doc = {
    query: "123 Main St, Chicago",
    coordinates: { latitude: 41.8781, longitude: -87.6298 },
    mapbox_id: "test-mapbox-1",
    address: {
      street: "123 Main St",
      city: "Chicago",
      region: "IL",
      postcode: "60601",
      country_name: "United States",
      full: "123 Main St, Chicago, IL 60601",
      name: "123 Main St",
    },
    ...ts,
  };
  assertEquals(CacheGeocodesSchema.safeParse(doc).success, true);
});

Deno.test("CacheGeocodesSchema accepts null coordinates", () => {
  const doc = {
    query: "nowhere",
    coordinates: null,
    mapbox_id: "test-mapbox-2",
    address: {},
    ...ts,
  };
  assertEquals(CacheGeocodesSchema.safeParse(doc).success, true);
});

Deno.test("CacheGeocodesSchema rejects missing query", () => {
  const doc = {
    coordinates: { latitude: 0, longitude: 0 },
    mapbox_id: "test-mapbox-3",
    address: {},
  };
  assertEquals(CacheGeocodesSchema.safeParse(doc).success, false);
});

Deno.test("CacheGeocodesSchema rejects additional properties", () => {
  const doc = {
    query: "test",
    coordinates: null,
    mapbox_id: "test-mapbox-4",
    address: {},
    bogus: true,
  };
  assertEquals(CacheGeocodesSchema.safeParse(doc).success, false);
});
