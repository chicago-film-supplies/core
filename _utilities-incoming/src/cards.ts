/**
 * Pure helpers over event-card lifecycle. Shared by api-cloudrun (writers
 * inside the booking-update transaction) and the manager (optimistic
 * client-side projections in `applyBookingActions`) so both sides agree on
 * exactly what `card.status` becomes after a booking write.
 *
 * ```ts
 * import { computeCardStatusFromBookings } from "@cfs/utilities/cards";
 * ```
 *
 * @module
 */
import type { Booking, CardStatus } from "@cfs/schemas";

/**
 * Which side of the order's lifecycle a card represents:
 * - `"start"` — delivery event (items leave the warehouse for a destination).
 *   Backed by sibling bookings filtered by `uid_destination_delivery`.
 * - `"end"`   — collection event (items return from a destination).
 *   Backed by sibling bookings filtered by `uid_destination_collection`.
 */
export type CardSide = "start" | "end";

/** Subset of `Booking` the formula reads. Keeps the helper dependency-light. */
export type CardSiblingBooking = Pick<Booking, "type" | "quantity" | "breakdown">;

/**
 * Recompute an event card's `status` from its sibling bookings on the
 * destination it belongs to. Pure function — no Firestore reads.
 *
 * Preserves manual overrides:
 * - `"blocked"` — manually set on the card; sticks until either the parent
 *   order transitions to canceled (handled in update-order) or a future
 *   "Clear block" affordance writes a new auto value through the same path.
 * - `"canceled"` — terminal; sourced from order.status only.
 *
 * Otherwise, applies per-side roll-up rules:
 *
 * **Start card (delivery)** — siblings filtered to `uid_destination_delivery`:
 *   - `pre_delivery = Σ (quoted + reserved + prepped)` — still in the warehouse.
 *   - `out          = Σ breakdown.out` — delivery in flight.
 *   - if `pre_delivery === 0`            → `complete` (everything has at least left)
 *   - else if `out > 0`                  → `active`   (delivery in progress)
 *   - else                                → `planned`  (nothing has moved yet)
 *
 * **End card (collection)** — siblings filtered to `uid_destination_collection`:
 *   Sale-type bookings are excluded — sales have no collection event, so the
 *   end card stays planned↔complete based on rental siblings only.
 *   - `terminal  = Σ (returned + lost + damaged)`
 *   - `total     = Σ booking.quantity`
 *   - `still_out = Σ breakdown.out`
 *   - if `terminal === total`              → `complete` (everything collected/written-off)
 *   - else if `terminal > 0 || still_out > 0` → `active`   (collection in progress)
 *   - else                                  → `planned`  (nothing has come back yet)
 *
 * If the end-side roll-up has no rental siblings (e.g. a sale-only
 * destination), the card resolves to `complete` — there is nothing to collect.
 *
 * @param side       Which card side this is — drives which key set we sum and
 *                   which sibling set the caller is expected to have prepared.
 * @param siblings   Bookings filtered to the relevant destination side.
 * @param current    The card's current status — preserved if `blocked` or
 *                   `canceled` so manual overrides aren't clobbered.
 */
export function computeCardStatusFromBookings(
  side: CardSide,
  siblings: CardSiblingBooking[],
  current: CardStatus,
): CardStatus {
  if (current === "blocked" || current === "canceled") return current;

  if (side === "start") {
    let preDelivery = 0;
    let out = 0;
    for (const b of siblings) {
      preDelivery += b.breakdown.quoted + b.breakdown.reserved + b.breakdown.prepped;
      out += b.breakdown.out;
    }
    if (preDelivery === 0) return "complete";
    if (out > 0) return "active";
    return "planned";
  }

  // side === "end"
  const rentals = siblings.filter((b) => b.type !== "sale");
  if (rentals.length === 0) return "complete";

  let terminal = 0;
  let total = 0;
  let stillOut = 0;
  for (const b of rentals) {
    terminal += b.breakdown.returned + b.breakdown.lost + b.breakdown.damaged;
    total += b.quantity;
    stillOut += b.breakdown.out;
  }
  if (terminal === total) return "complete";
  if (terminal > 0 || stillOut > 0) return "active";
  return "planned";
}
