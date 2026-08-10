/**
 * CacheGeocodes document schema — Firestore collection: cache-geocodes
 */
import { z } from "zod";
import { Coordinates, type CoordinatesType, FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Parsed address fields returned from a geocode lookup. */
export interface CacheGeocodesAddress {
  street?: string;
  city?: string;
  region?: string;
  postcode?: string;
  country_name?: string;
  full?: string;
  name?: string;
}

/** Full Firestore document for a cached geocode result. */
export interface CacheGeocodes {
  query: string;
  coordinates: CoordinatesType | null;
  mapbox_id: string;
  address: CacheGeocodesAddress;
  created_at: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
}

/**
 * Zod schema for CacheGeocodes.
 *
 * Every field here except the timestamps describes ONE customer address, so the
 * whole document is PII and is tagged as such. It is the untagged twin of
 * `Address` (`common.ts`) — hand-rolled from the Mapbox response rather than
 * reusing the primitive — and it stayed untagged because `cache-geocodes` was
 * not in `tests/pii.test.ts`'s old hand-maintained schema list.
 *
 * Tagged to match `Address` exactly: `mask` on the object so a new field is
 * masked by default, with the three coarse-geography leaves opting OUT (a city
 * / state / country identifies no one alone, and the mask transform mangles
 * them). `query`, `coordinates` and `mapbox_id` are tagged individually because
 * they sit OUTSIDE the address object — and each one resolves to the same
 * street address on its own, so masking `address` while leaving them raw would
 * be theatre. Note `query`/`coordinates`/`mapbox_id` are invisible to the
 * name-dictionary in `pii/dictionary.ts`: no lint would have caught them.
 */
export const CacheGeocodesSchema: z.ZodType<CacheGeocodes> = z.strictObject({
  // The raw geocode input — in practice a customer's delivery address as typed.
  query: z.string().meta({ pii: "mask" }),
  // 6dp geocode (≈0.11 m). Object-level tag; both numeric leaves inherit it.
  coordinates: Coordinates.meta({ pii: "mask" }),
  // Opaque Mapbox place id, but it resolves back to the street address.
  mapbox_id: z.string().meta({ pii: "mask" }),
  address: z.strictObject({
    street: z.string().optional(),
    city: z.string().optional().meta({ pii: "none", column: true, label: "City" }),
    region: z.string().optional().meta({ pii: "none", column: true, label: "State" }),
    postcode: z.string().optional(),
    country_name: z.string().optional().meta({ pii: "none" }),
    full: z.string().optional().meta({ column: true, label: "Address" }),
    name: z.string().optional(),
  }).meta({ pii: "mask" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  expiresAt: FirestoreTimestamp.meta({ column: true, label: "Expires" }),
}).meta({
  title: "Cache Geocodes",
  collection: "cache-geocodes",
  displayDefaults: {
    columns: ["address.full", "address.city", "address.region"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
