/**
 * Store aggregate events.
 *
 * Covers: stores, locations, location-types.
 */
import type { EventEnvelope } from "./common.ts";
import type { Store } from "../store.ts";
import type { Location } from "../location.ts";
import type { LocationType } from "../location-type.ts";

// ── Store events ───────────────────────────────────────────────────

export type StoreCreated = EventEnvelope<Store> & { event: "store.created" };
export type StoreUpdated = EventEnvelope<Store> & { event: "store.updated" };

// ── Location events ────────────────────────────────────────────────

export type LocationCreated = EventEnvelope<Location> & { event: "location.created" };
export type LocationUpdated = EventEnvelope<Location> & { event: "location.updated" };

// ── Location type events ───────────────────────────────────────────

export type LocationTypeCreated = EventEnvelope<LocationType> & { event: "location_type.created" };
export type LocationTypeUpdated = EventEnvelope<LocationType> & { event: "location_type.updated" };
