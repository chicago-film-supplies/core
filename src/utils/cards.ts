/**
 * Pure helpers over event-card lifecycle. Shared by api-cloudrun (writers
 * inside the booking-update transaction) and the manager (optimistic
 * client-side projections in `applyBookingActions`) so both sides agree on
 * exactly what `card.status` becomes after a booking write.
 *
 * ```ts
 * import { computeCardStatusFromBookings } from "@cfs/core/utils/cards";
 * ```
 *
 * @module
 */
import type { Booking, CardAction, CardStatus } from "../schemas/mod.ts";

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
 *   Known limitation: `pre_delivery === 0 → complete` would read `complete` for
 *   a hypothetical phased order where every unit has *at least* left the
 *   warehouse but some legs are still mid-cycle. No live incidence today;
 *   tracked as a low-priority follow-up, not a code change.
 *
 * **End card (collection)** — siblings filtered to `uid_destination_collection`,
 *   then to **rentals only** (`b.type === "rental"`). Only a rental has a
 *   collection event — checked out (`breakdown.out > 0`) and later returned —
 *   so only a rental can drive the card to `complete`. Sale, service, and
 *   surcharge lines are all excluded:
 *   - a kept **sale** sits permanently at `out = quantity` (a sale is only
 *     rarely returned, and then via the fulfillment flow, never via the card);
 *   - **service** / **surcharge** lines have no return event at all, so their
 *     `breakdown.out` is always 0 and they never reach a terminal
 *     `returned`/`lost`/`damaged` count.
 *   Counting any of their `quantity` toward `total` would leave
 *   `terminal < total` forever and pin the end card `active` after the rentals
 *   are all back.
 *   - `terminal  = Σ (returned + lost + damaged)`
 *   - `total     = Σ booking.quantity`
 *   - `still_out = Σ breakdown.out`
 *   - if `terminal === total`              → `complete` (everything collected/written-off)
 *   - else if `terminal > 0 || still_out > 0` → `active`   (collection in progress)
 *   - else                                  → `planned`  (nothing has come back yet)
 *
 * If the end-side roll-up has no rental siblings (e.g. a sale/service-only
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

  // side === "end" — rentals only; sale/service/surcharge have no return event.
  const rentals = siblings.filter((b) => b.type === "rental");
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

/**
 * Recompute a card's denormalized **next fulfillment action** from its sibling
 * bookings — the value the `CardTile` button shows on surfaces (Dashboard
 * kanban, Calendar agenda) where no bookings are loaded. Pure function — no
 * Firestore reads. Computed in lockstep with `computeCardStatusFromBookings`
 * on every booking write.
 *
 * Returns `null` (no actionable next step) when:
 * - `current` is `blocked | canceled | complete | draft` — **wider than the
 *   status helper**, which only preserves `blocked`/`canceled`. A complete or
 *   draft card must never surface a stale action.
 * - the relevant side has nothing pending (see per-side rules).
 *
 * **Start side (delivery)** — siblings filtered to `uid_destination_delivery`.
 * No sale filter: sale lines are genuinely prepped + checked out on delivery.
 *   - `reserved > 0` → `prep`     (still has unprepped quantity)
 *   - else `prepped > 0` → `checkout` (prepped, awaiting check-out)
 *   - else → `null`               (nothing reserved/prepped; quote-only or fully out)
 *
 * **End side (collection)** — **rentals only** (`b.type === "rental"`),
 * mirroring the end-card status formula. Sale, service, and surcharge lines
 * have no collection event.
 *   - `out > 0` → `return`        (checked-out rental quantity awaiting return)
 *   - else → `null`               (nothing out yet — end card shows no action
 *                                  until check-out produces `out > 0`)
 *
 * Side-scoped by design: a start card never reports `return` and an end card
 * never reports `prep`/`checkout` — unlike the manager's destination-wide
 * `getStageForBookings`, which collapses both sides into one stage.
 *
 * @param side     Which card side — selects the per-side rule + sibling set.
 * @param siblings Bookings filtered to the relevant destination side.
 * @param current  The card's current status — non-actionable statuses null out.
 */
export function computeCardActionFromBookings(
  side: CardSide,
  siblings: CardSiblingBooking[],
  current: CardStatus,
): CardAction | null {
  if (
    current === "blocked" || current === "canceled" ||
    current === "complete" || current === "draft"
  ) {
    return null;
  }

  if (side === "start") {
    let reserved = 0;
    let prepped = 0;
    for (const b of siblings) {
      reserved += b.breakdown.reserved;
      prepped += b.breakdown.prepped;
    }
    if (reserved > 0) return { source: "fulfillment", value: "prep" };
    if (prepped > 0) return { source: "fulfillment", value: "checkout" };
    return null;
  }

  // side === "end" — rentals only; sale/service/surcharge have no return event.
  let out = 0;
  for (const b of siblings) {
    if (b.type !== "rental") continue;
    out += b.breakdown.out;
  }
  if (out > 0) return { source: "fulfillment", value: "return" };
  return null;
}
