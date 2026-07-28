/**
 * Pure booking-allocation math — which physical units a booking draws from which
 * store and location, netted against the units other overlapping bookings have
 * already claimed.
 *
 * ```ts
 * import { allocateBookingToStores } from "@cfs/core/utils/allocation";
 * ```
 *
 * Lives in core, next to `computeAvailability`, for the same reason that does:
 * the checkout UI has to render the allocation the server would pick so the
 * operator can adjust it, and a second implementation in the browser would be a
 * second answer. Has NO Firestore edge — pure functions over plain
 * store-breakdown arrays (#279).
 *
 * `prefetchReservingBookings` (the db-backed overlap read that feeds
 * `allocateBookingWithNetting`) stays in api-cloudrun `lib/stockSummary.ts`.
 *
 * Note this is a *different* question from availability. Availability asks "how
 * many units are free over this window?" and lives in `@cfs/core/utils/availability`;
 * allocation asks "which shelf do I pick them off?" and lives here. Allocation
 * still needs a date window — two bookings that don't overlap in time can share a
 * unit — which is why `prefetchReservingBookings` keeps its range predicates even
 * though the summary rebuild has shed all of its.
 */
import type {
  Booking,
  BookingStore,
  StoreBreakdownEntry,
  StoreBreakdownLocation,
} from "../schemas/mod.ts";

/** Booking breakdown shape — matches Booking["breakdown"] from schema. */
type BookingBreakdown = Booking["breakdown"];

// The deterministic-id builder and the public-summary projection both lived
// here. Neither survives the interval model: a summary's doc id is now simply
// its product's uid (nothing to build), and the public projection is
// `toPublicStockSummary` in `@cfs/core/utils/availability`, so the API's writer
// and the browser share one definition of the sanitized shape.

// ── Booking store allocation ─────────────────────────────────────

/**
 * Draws quantity from locations for booking allocation.
 * Returns shortage instead of throwing when insufficient inventory.
 */
function drawFromLocationsForBooking(
  locations: StoreBreakdownLocation[],
  quantityToDraw: number,
): { locations: StoreBreakdownLocation[]; shortage: number } {
  const allocatedLocations: StoreBreakdownLocation[] = [];
  let remaining = quantityToDraw;

  const locationsCopy: StoreBreakdownLocation[] = structuredClone(locations);

  locationsCopy.sort((a, b) => {
    if (a.default && !b.default) return -1;
    if (!a.default && b.default) return 1;
    return b.quantity - a.quantity;
  });

  for (const location of locationsCopy) {
    if (remaining <= 0) break;
    if (location.quantity <= 0) continue;

    const drawAmount = Math.min(location.quantity, remaining);

    allocatedLocations.push({
      uid_location: location.uid_location,
      name: location.name,
      quantity: drawAmount,
      default: location.default,
      max: location.max,
    });

    remaining -= drawAmount;
  }

  return {
    locations: allocatedLocations,
    shortage: remaining,
  };
}

/**
 * Allocates booking quantity across all available stores.
 * Follows priority: default store first, then others alphabetically.
 * Draws from default locations first within each store.
 *
 * @param ledgerStoreBreakdown - Store breakdown array from inventory ledger
 * @param bookingQuantity - Total quantity to allocate
 * @returns stores array, query_by_uid_store array, query_by_uid_location array, and shortage count
 */
export function allocateBookingToStores(
  ledgerStoreBreakdown: StoreBreakdownEntry[],
  bookingQuantity: number,
): { stores: BookingStore[]; query_by_uid_store: string[]; query_by_uid_location: string[]; shortage: number } {
  const stores: BookingStore[] = [];
  let remaining = bookingQuantity;

  const sortedStores = [...ledgerStoreBreakdown].sort((a, b) => {
    if (a.default && !b.default) return -1;
    if (!a.default && b.default) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const storeData of sortedStores) {
    if (remaining <= 0) break;

    const result = drawFromLocationsForBooking(storeData.locations, remaining);

    if (result.locations.length > 0) {
      const storeQuantity = result.locations.reduce((sum, loc) => sum + loc.quantity, 0);

      // Project from the inventory-ledger StoreBreakdownEntry to the narrower
      // BookingStore shape: drop crms_stock_level_id (CRMS sync identifier,
      // irrelevant once allocated) and locations[].max (inventory capacity,
      // not a reservation property). BookingStoreSchema is strict.
      stores.push({
        uid_store: storeData.uid_store,
        name: storeData.name,
        default: storeData.default,
        quantity: storeQuantity,
        locations: result.locations.map((loc) => ({
          uid_location: loc.uid_location,
          name: loc.name,
          quantity: loc.quantity,
          default: loc.default,
        })),
      });

      remaining -= storeQuantity;
    }
  }

  const query_by_uid_store = stores.map((s) => s.uid_store);
  const query_by_uid_location = stores.flatMap((s) => s.locations.map((l) => l.uid_location));

  return { stores, query_by_uid_store, query_by_uid_location, shortage: remaining };
}

// ── Booking-aware (netted) allocation (#171) ─────────────────────

/** Per-location reserved quantity (uid_location → units already claimed). */
export type ReservedByLocation = Map<string, number>;

/**
 * Sum the physical units held by a set of bookings, per location. Only bookings
 * that currently hold stock (`reserved + prepped + out > 0`, the same definition
 * as `quantity_booked`) contribute — a returned/quoted booking reserves nothing
 * even if a stale `stores` array lingers.
 */
export function buildReservedByLocation(
  bookings: ReadonlyArray<{ breakdown: BookingBreakdown; stores: BookingStore[] }>,
): ReservedByLocation {
  const reserved: ReservedByLocation = new Map();
  for (const b of bookings) {
    const held = (b.breakdown?.reserved ?? 0) + (b.breakdown?.prepped ?? 0) + (b.breakdown?.out ?? 0);
    if (held <= 0) continue;
    for (const s of b.stores ?? []) {
      for (const l of s.locations ?? []) {
        reserved.set(l.uid_location, (reserved.get(l.uid_location) ?? 0) + l.quantity);
      }
    }
  }
  return reserved;
}

/** Fold a freshly-computed allocation into a running reserved map (in-batch netting). */
export function addAllocationToReserved(reserved: ReservedByLocation, stores: BookingStore[]): void {
  for (const s of stores) {
    for (const l of s.locations) {
      reserved.set(l.uid_location, (reserved.get(l.uid_location) ?? 0) + l.quantity);
    }
  }
}

/** Deep-copy store_breakdown with reserved quantities subtracted per location (clamped at 0). */
function netStoreBreakdown(
  storeBreakdown: StoreBreakdownEntry[],
  reserved: ReservedByLocation,
): StoreBreakdownEntry[] {
  return storeBreakdown.map((store) => {
    const locations = store.locations.map((loc) => ({
      ...loc,
      quantity: Math.max(0, loc.quantity - (reserved.get(loc.uid_location) ?? 0)),
    }));
    return { ...store, quantity: locations.reduce((s, l) => s + l.quantity, 0), locations };
  });
}

/**
 * Booking allocation that first nets out units already reserved by other open
 * bookings, so two overlapping bookings of a 5-stock product don't both point
 * pickers at the same physical unit (#171). When free stock runs out,
 * `shortage > 0` and the summary's `quantity_available` goes negative —
 * overbooking is allowed, it's just no longer silent. Falls back to the gross
 * allocation when `reserved` is empty.
 */
export function allocateBookingNetted(
  storeBreakdown: StoreBreakdownEntry[],
  quantity: number,
  reserved: ReservedByLocation,
): ReturnType<typeof allocateBookingToStores> {
  if (reserved.size === 0) return allocateBookingToStores(storeBreakdown, quantity);
  return allocateBookingToStores(netStoreBreakdown(storeBreakdown, reserved), quantity);
}

/** A stock-holding booking with its window, for in-memory overlap netting. */
export interface ReservingBooking {
  breakdown: BookingBreakdown;
  stores: BookingStore[];
  startMs: number | null;
  endMs: number | null;
}

/**
 * Allocate one booking's stores, netting against (a) pre-fetched bookings of the
 * same product that overlap this booking's window and (b) `inBatchReserved` —
 * allocations already made earlier in THIS transaction for the same product. The
 * allocation is folded back into `inBatchReserved` so the next booking for the
 * same product nets against it too. Pure (no I/O).
 */
export function allocateBookingWithNetting(
  storeBreakdown: StoreBreakdownEntry[],
  quantity: number,
  reserving: ReservingBooking[],
  windowStartMs: number | null,
  windowEndMs: number | null,
  inBatchReserved: ReservedByLocation,
): ReturnType<typeof allocateBookingToStores> {
  const combined: ReservedByLocation = new Map(inBatchReserved);
  if (windowStartMs != null && windowEndMs != null) {
    const overlapping = reserving.filter((b) =>
      (b.startMs == null || b.startMs <= windowEndMs) &&
      (b.endMs == null || b.endMs >= windowStartMs)
    );
    for (const [loc, q] of buildReservedByLocation(overlapping)) {
      combined.set(loc, (combined.get(loc) ?? 0) + q);
    }
  }
  const allocation = allocateBookingNetted(storeBreakdown, quantity, combined);
  addAllocationToReserved(inBatchReserved, allocation.stores);
  return allocation;
}
