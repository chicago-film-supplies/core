/**
 * The document refines BOTH booking grains run — the outbound `BookingSchema`
 * (`bookings`, an order's) and the inbound `InboundBookingSchema`
 * (`bookings-inbound`, a purchase's). One declaration per rule, so the two
 * collections cannot disagree about what a delivery or a collection means
 * (`api-cloudrun/.claude/plans/one-document-model.md` C5).
 *
 * INTERNAL — not an entrypoint in `deno.json`'s `exports` map, and no barrel
 * re-exports it.
 *
 * @module
 */
import type { z } from "zod";
import { isCollectionLineType } from "./order.ts";

/**
 * A booking's collection follows its OWN `type` (api-cloudrun#1154): a `rental`
 * comes back, so it names a collection; anything else never does, so both
 * `destinations.collection` and `uid_destination_collection` are `null`. The
 * flat id always equals the ref's `uid`, since every address-filtered query
 * reads the flat one. `bookingCollectionFor` (`@cfs/core/utils/bookings`) is the
 * one writer-side author; this is its stored mirror. Held on all 7,409 prod /
 * 7,414 dev bookings after the Phase 4 backfill (2026-09-29).
 *
 * On an INBOUND booking the same rule reads the other way round and is still
 * right: a Subrent (`rental`) goes BACK to its supplier, which is the pair's
 * collection leg; a Buy (`sale`) never leaves CFS.
 */
export function checkBookingCollection(
  doc: {
    type: string;
    destinations: { collection: { uid: string } | null };
    uid_destination_collection: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const collection = doc.destinations.collection;
  if (isCollectionLineType(doc.type) !== (collection !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["destinations", "collection"],
      message: collection === null
        ? "a rental booking comes back, so it names a collection"
        : `a ${doc.type} booking never comes back, so it names no collection`,
    });
  }
  if (doc.uid_destination_collection !== (collection?.uid ?? null)) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_destination_collection"],
      message: "uid_destination_collection must equal destinations.collection.uid (null when there is no collection)",
    });
  }
}

/**
 * The flat delivery id always equals its nested ref's `uid` (core#103). The flat
 * one is the indexed query surface (`bookings: [uid_destination_delivery,
 * status]`, read by api-cloudrun's pick sheets), so a disagreement would send a
 * booking to the wrong sheet silently. The collection side has held the same
 * rule since `checkBookingCollection`; a census before this refine shipped read 0
 * disagreements on all 8,390 prod / 8,409 dev bookings (2026-10-09,
 * `api-cloudrun/scripts/audit-collection-legs.ts`, `booking-delivery-mirror`).
 */
export function checkBookingDelivery(
  doc: { destinations: { delivery: { uid: string } | null }; uid_destination_delivery: string },
  ctx: z.RefinementCtx,
): void {
  if (doc.uid_destination_delivery !== doc.destinations.delivery?.uid) {
    ctx.addIssue({
      code: "custom",
      path: ["uid_destination_delivery"],
      message: "uid_destination_delivery must equal destinations.delivery.uid",
    });
  }
}

/**
 * A bucket can name at most as many units as it holds: `units[k].length ≤
 * breakdown[k]`, over the ladder's own unit buckets. Fewer is the untracked
 * count a conversion left; more is a unit the breakdown does not account for.
 * Disjointness is the unit-sets schema's own refine (`unitSetsSchema`).
 */
export function checkBookingUnitsWithin<B extends string>(
  buckets: readonly B[],
): (doc: { breakdown: Record<B, number>; units?: Record<B, number[]> | null }, ctx: z.RefinementCtx) => void {
  return (doc, ctx) => {
    if (doc.units == null) return;
    for (const key of buckets) {
      if (doc.units[key].length > doc.breakdown[key]) {
        ctx.addIssue({
          code: "custom",
          path: ["units", key],
          message: `"${key}" names ${doc.units[key].length} units but holds ${doc.breakdown[key]}`,
        });
      }
    }
  };
}
