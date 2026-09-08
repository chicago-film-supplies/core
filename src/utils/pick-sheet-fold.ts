/**
 * The PURE fold behind a pick sheet — everything that decides which legs are on
 * a sheet, what is on them, and which line carries each aggregate booking's
 * quantities. No Firestore, no response budget, no render model.
 *
 * ```ts
 * import { foldPickSheet } from "@cfs/core/utils/pick-sheet-fold";
 * ```
 *
 * ## Membership from `bookings`; rows from `fulfillments`; custody from the same bookings
 *
 * 🔴 **Bookings cannot be the ROW source.** There is no booking row for a
 * `service` / `surcharge` / `transaction_fee` line, none for a
 * `stock_method: "none"` product, and no dividers at all — so a bookings-derived
 * sheet is silently short, which is the one failure this surface refuses.
 * Membership answers *which orders*; the sanitized fulfillment projection
 * supplies every row.
 *
 * ## It GROUPS paths; it never mints one
 *
 * Every `items[].path` on the output is byte-identical to its own document's.
 * The sheet's extra levels are **structural nesting** —
 * `orders[] → destinations[] → items[]` — not a fourth path grain, because a
 * `path` is a row identity within ONE document and pooling two documents' paths
 * into one namespace would collide rows that are not the same row. See
 * `schemas/pick-sheet.ts` for the two reasons in full.
 *
 * ## 🔴 Why this is in `@cfs/core` rather than beside either caller
 *
 * It had two homes and one rule. `api-cloudrun/src/lib/pickSheetFold.ts` built
 * the wire document and `manager/src/utils/pickSheet.ts` built the screen's
 * sections — same inputs, same primitives, and the same sentence in both
 * docblocks. Two copies of a membership rule is how the `||` defect in
 * `pickSheetGateAdmits` survived as long as it did, and it is why the screen and
 * the printed document could disagree about what is at a destination. There is
 * one author now; the screen PROJECTS this output rather than walking the inputs
 * again.
 *
 * ⚠️ **The PAGING half deliberately did not come with it.** `cursorFor` and
 * `pagePickSheetOrders` clip against api-cloudrun's serialized response budget,
 * which is a property of that service's transport and not of a pick sheet. They
 * stay in `api-cloudrun/src/lib/pickSheetFold.ts`, which re-exports this module
 * so its callers see one door.
 *
 * @module
 */
import type { Booking, Fulfillment, FulfillmentItemType } from "../schemas/mod.ts";
import {
  type PickSheetBooking,
  type PickSheetDestination,
  type PickSheetGateType,
  pickSheetGateAdmits,
  type PickSheetItem,
  pickSheetLegAdmits,
  pickSheetLegDirection,
  type PickSheetLegType,
  type PickSheetOrder,
  type PickSheetScope,
} from "../schemas/mod.ts";
import { emptyBookingsBreakdown } from "./bookings.ts";
import { getItemSubtreeRange, getParentProductUid, getStructuralUids } from "./orders.ts";
import { composeOrgName } from "./organizations.ts";

/** What {@link foldPickSheet} produces before any page is clipped. */
export interface PickSheetFoldResult {
  orders: PickSheetOrder[];
  /**
   * Orders in the membership slice with no fulfillment document supplied.
   *
   * 🔴 **Surfaced, never dropped** — it means `bookings` and the projection
   * disagree, which is a finding
   * (`api-cloudrun/scripts/audit-fulfillment-projection.ts`), not a display
   * problem.
   */
  missingOrderUids: string[];
}

/**
 * The deterministic booking id, restated here rather than imported from
 * api-cloudrun's `services/orders.ts` so this module stays db-free.
 *
 * ⚠️ The third segment is the pair's `delivery.uid` — a `destinations/{uid}`
 * ADDRESS-BOOK id — never the destination divider's uid. The two are different
 * values and only one of them joins across documents; api-cloudrun#663 is that
 * pair confused the other way round.
 */
function bookingUidFor(orderUid: string, productUid: string, deliveryUid: string): string {
  return `${orderUid}:${productUid}:${deliveryUid}`;
}

/**
 * When a leg is next due — the field the sheet is ordered on.
 *
 * ⭐ **The direction is `pickSheetLegDirection`'s, and this function owns only
 * the date selection.** It used to carry the predicate inline — computing the
 * direction and discarding it, keeping just the date it chose. Naming that fact
 * in `schemas/pick-sheet.ts` is what lets a packing list be drawn for one
 * direction; keeping a second copy here is how the two would disagree the first
 * time either was edited.
 *
 * The custody rule itself, and the non-rental-`out` case that makes it subtle,
 * are documented on `pickSheetLegDirection` rather than restated here.
 */
function dueAtForLeg(
  pair: { dates: { delivery_start: string | null; collection_start: string | null } },
  bookings: readonly Booking[],
): string | null {
  return pickSheetLegDirection(bookings) === "collection"
    ? pair.dates.collection_start ?? pair.dates.delivery_start
    : pair.dates.delivery_start ?? pair.dates.collection_start;
}

/** Project a booking to what a warehouse document may state — no money. */
function toSheetBooking(b: Booking): PickSheetBooking {
  return {
    uid: b.uid,
    uid_product: b.uid_product,
    name: b.name,
    type: b.type,
    status: b.status,
    quantity: b.quantity,
    shortage: b.shortage,
    breakdown: b.breakdown,
    stores: b.stores,
  };
}

/** Sum N breakdowns into one. Integer addition, so no rounding decision exists. */
function sumBreakdowns(bookings: readonly PickSheetBooking[]): Booking["breakdown"] {
  const total = emptyBookingsBreakdown();
  for (const b of bookings) {
    total.quoted += b.breakdown.quoted;
    total.reserved += b.breakdown.reserved;
    total.prepped += b.breakdown.prepped;
    total.out += b.breakdown.out;
    total.returned += b.breakdown.returned;
    total.lost += b.breakdown.lost;
    total.damaged += b.breakdown.damaged;
  }
  return total;
}

/**
 * Soonest work first, and a null date LAST rather than first.
 *
 * ⚠️ A date-less leg sorting to the TOP is the failure mode worth naming: ISO
 * strings compare lexically and `null` is not a string, so the naive comparator
 * puts every unscheduled leg above the one going out this morning. Ties break on
 * a uid so the order is total and a page boundary cannot wander between calls —
 * which is what makes `PickSheet.next_cursor` able to resume.
 */
function compareDue(aDue: string | null, bDue: string | null, aUid: string, bUid: string): number {
  if (aDue !== bDue) {
    if (aDue === null) return 1;
    if (bDue === null) return -1;
    return aDue < bDue ? -1 : 1;
  }
  return aUid < bUid ? -1 : aUid > bUid ? 1 : 0;
}

/** An order's own due date: its earliest leg's. `null` only when every leg is undated. */
export function orderDueAt(order: PickSheetOrder): string | null {
  let earliest: string | null = null;
  for (const leg of order.destinations) {
    if (leg.due_at === null) continue;
    if (earliest === null || leg.due_at < earliest) earliest = leg.due_at;
  }
  return earliest;
}

/** The sheet's total order over orders. Exported so a pager sorts identically. */
export function compareSheetOrders(a: PickSheetOrder, b: PickSheetOrder): number {
  return compareDue(orderDueAt(a), orderDueAt(b), a.uid, b.uid);
}

// ── The owner rule ──────────────────────────────────────────────────

/** Owner-selection accumulator for one aggregate booking, within one leg. */
interface BookingOwner {
  /** The winning occurrence's own `path`. */
  path: string[];
  /** Whether that occurrence is structurally parented (see the rule below). */
  isStructural: boolean;
  /** Its ordered line quantity — the second sort key. */
  quantity: number;
}

/**
 * Whether a later occurrence takes ownership from the incumbent.
 *
 * Structural parentage is the primary key and a strict override; ordered line
 * quantity is the second. Document order is the third and is implicit — the walk
 * is in document order and this returns `false` on a tie, so the earliest
 * occurrence of the best `(structural, quantity)` pair keeps the booking.
 */
function outranksOwner(
  candidate: { isStructural: boolean; quantity: number },
  incumbent: BookingOwner,
): boolean {
  if (candidate.isStructural !== incumbent.isStructural) return candidate.isStructural;
  return candidate.quantity > incumbent.quantity;
}

/**
 * Fold a membership slice plus the fulfillment documents it names into
 * `orders[] → destinations[] → items[]`.
 *
 * ⚠️ `bookings` must already be the scope's slice — the destination's or the
 * organization subtree's open bookings. This narrows by LEG, not by scope
 * membership: an order in the slice for one destination may carry a second leg
 * elsewhere, and the destination scope drops that one here.
 *
 * ⚠️ **A section's order attribution comes from the DOCUMENT, not from
 * `items[].uid_order`**, and that is a stated limit rather than an oversight.
 * `fulfillments` is 1:1 with an order, so every line in a document belongs to
 * that document's order today and the two answers cannot disagree.
 * `items[].uid_order` exists for the run-of-show case — an organization
 * accumulating several orders over a project and returning them all on one day
 * — and the moment a fulfillment document carries lines from more than one
 * order, this attribution and the booking id above become wrong together.
 * Tracked as manager#357; do not paper over it here with a branch no corpus can
 * reach.
 */
export function foldPickSheet(input: {
  scope: PickSheetScope;
  gate: PickSheetGateType;
  /** Which direction to admit; `null` admits both. See `pickSheetLegAdmits`. */
  leg: PickSheetLegType | null;
  bookings: readonly Booking[];
  fulfillments: ReadonlyMap<string, Fulfillment>;
}): PickSheetFoldResult {
  const { scope, gate, leg, bookings, fulfillments } = input;

  const byOrder = new Map<string, Booking[]>();
  for (const b of bookings) {
    const list = byOrder.get(b.uid_order);
    if (list) list.push(b);
    else byOrder.set(b.uid_order, [b]);
  }

  const orders: PickSheetOrder[] = [];
  const missingOrderUids: string[] = [];

  for (const [orderUid, orderBookings] of byOrder) {
    const fulfillment = fulfillments.get(orderUid);
    if (!fulfillment) {
      missingOrderUids.push(orderUid);
      continue;
    }

    const bookingByUid = new Map(orderBookings.map((b) => [b.uid, b]));
    // Structural uids are a property of the WHOLE document, not of one leg: a
    // line's parent is structural if the uid two segments back is any divider in
    // this document. Computed once per order rather than per leg.
    const structuralUids = getStructuralUids(fulfillment.items);
    const legs: PickSheetDestination[] = [];

    for (let i = 0; i < fulfillment.items.length; i++) {
      const divider = fulfillment.items[i];
      if (divider.type !== "destination") continue;

      const pair = fulfillment.destinations.find((d) => d.uid === divider.uid);
      if (!pair) continue;
      if (!pickSheetGateAdmits(pair, gate)) continue;
      if (scope.kind === "destination" && pair.delivery.uid !== scope.uid) continue;

      const deliveryUid = pair.delivery.uid;
      const { endIndex } = getItemSubtreeRange(fulfillment.items, i);

      const items: PickSheetItem[] = [];
      // First-appearance order, deduped: a booking is aggregate per
      // `(order, product, destination)`, so several lines in one leg legitimately
      // name the same one — a priced principal beside zero-priced accessories, a
      // `splitItem`, or a product appearing both standalone and as a kit
      // component.
      const legBookings: PickSheetBooking[] = [];
      const seen = new Set<string>();
      // The owner accumulator, per aggregate booking, scoped to THIS leg. Scoped
      // rather than per order because a booking belongs to exactly one leg by
      // construction (its uid names the leg's endpoint), and a leg-scoped map
      // cannot leak an owner across a section boundary even if that ever stops
      // being true.
      const owners = new Map<string, BookingOwner>();

      for (let j = i + 1; j <= endIndex; j++) {
        const item = fulfillment.items[j];
        const uidBooking = bookingUidForItem(orderUid, item, deliveryUid, bookingByUid);
        // `owner_path` is filled in after the walk: every occurrence has to be
        // known before any of them can be told which one owns.
        items.push({ item, uid_booking: uidBooking, owner_path: null });
        // The type test is redundant with `uidBooking !== null` — a divider
        // resolves to no booking — and is written anyway because it is what
        // narrows `item` to the arm that HAS a `quantity`. Leaning on the
        // implication would need a cast, which is the thing that stops being
        // true silently when an arm is added.
        if (uidBooking === null || item.type === "destination" || item.type === "group") continue;

        if (!seen.has(uidBooking)) {
          seen.add(uidBooking);
          legBookings.push(toSheetBooking(bookingByUid.get(uidBooking)!));
        }

        const candidate = {
          isStructural: getParentProductUid(item, structuralUids) === null,
          quantity: item.quantity,
        };
        const incumbent = owners.get(uidBooking);
        if (!incumbent) owners.set(uidBooking, { path: item.path, ...candidate });
        else if (outranksOwner(candidate, incumbent)) {
          incumbent.path = item.path;
          incumbent.isStructural = candidate.isStructural;
          incumbent.quantity = candidate.quantity;
        }
      }

      // A leg with nothing open in the membership slice is not on this sheet.
      // For a destination scope that is a leg whose work is done; for an
      // organization scope it is a leg whose bookings are all `complete`.
      if (legBookings.length === 0) continue;

      // ⚠️ **The leg filter sits BELOW the gate's, not beside it, and the order
      // is forced.** A gate reads the destination pair's two flags and can be
      // decided before any booking is collected; a direction is derived from
      // this leg's CUSTODY, so it cannot be asked until `legBookings` is
      // populated. Hoisting it next to `pickSheetGateAdmits` would read the
      // empty set and answer `delivery` for every leg.
      if (!pickSheetLegAdmits(legBookings, leg)) continue;

      stampOwners(items, owners);

      legs.push({
        uid: divider.uid,
        name: divider.name,
        destination: pair,
        due_at: dueAtForLeg(pair, [...bookingByUid.values()].filter((b) => seen.has(b.uid))),
        quantity: legBookings.reduce((sum, b) => sum + b.quantity, 0),
        breakdown: sumBreakdowns(legBookings),
        bookings: legBookings,
        items,
      });
    }

    if (legs.length === 0) continue;

    legs.sort((a, b) => compareDue(a.due_at, b.due_at, a.uid, b.uid));
    orders.push({
      uid: fulfillment.uid,
      number: fulfillment.number,
      status: fulfillment.status,
      subject: fulfillment.subject,
      // ⭐ **The fold COMPOSES a name; the document no longer stores one.**
      // A pick sheet is a read-time response body, and a derived value is fine
      // to deliver — it is recomputed on every render, so it has no opportunity
      // to disagree with its input. Storing it beside its input was the defect
      // (api-cloudrun#782); delivering it is not.
      organization: {
        uid: fulfillment.organization.uid,
        name: composeOrgName(fulfillment.organization.path),
      },
      destinations: legs,
    });
  }

  orders.sort(compareSheetOrders);
  return { orders, missingOrderUids: missingOrderUids.sort() };
}

/**
 * Write `owner_path` onto every NON-owner occurrence, in place.
 *
 * The owner keeps `null` — see `PickSheetItem.owner_path` for why ownership is
 * the absence of a pointer rather than a second boolean beside it.
 */
function stampOwners(items: PickSheetItem[], owners: ReadonlyMap<string, BookingOwner>): void {
  for (const row of items) {
    if (row.uid_booking === null) continue;
    const owner = owners.get(row.uid_booking);
    if (!owner) continue;
    if (samePath(owner.path, row.item.path)) continue;
    row.owner_path = owner.path;
  }
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * The booking a line resolves to, or `null`.
 *
 * `null` for a divider, for a leg whose pair names no delivery endpoint (nothing
 * can be addressed there), and — deliberately — for a line whose booking is not
 * in the membership slice. The slice is the OPEN band, so a `complete` booking
 * reads as no booking here rather than as a closed one, which is what keeps the
 * sheet a list of work rather than a history.
 */
function bookingUidForItem(
  orderUid: string,
  item: FulfillmentItemType,
  deliveryUid: string | null,
  bookingByUid: ReadonlyMap<string, Booking>,
): string | null {
  if (item.type === "destination" || item.type === "group") return null;
  if (deliveryUid === null) return null;
  const uid = bookingUidFor(orderUid, item.uid, deliveryUid);
  return bookingByUid.has(uid) ? uid : null;
}

/** Distinct organizations across a page, `null` counted once, in first-seen order. */
export function sheetOrganizations(
  orders: readonly PickSheetOrder[],
): Array<{ uid: string | null; name: string }> {
  const byUid = new Map<string | null, { uid: string | null; name: string }>();
  for (const o of orders) {
    if (!byUid.has(o.organization.uid)) byUid.set(o.organization.uid, { ...o.organization });
  }
  return [...byUid.values()];
}

/** Legs across a page. */
export function sheetDestinationCount(orders: readonly PickSheetOrder[]): number {
  return orders.reduce((n, o) => n + o.destinations.length, 0);
}

/** Units across every leg on a page. */
export function sheetQuantity(orders: readonly PickSheetOrder[]): number {
  return orders.reduce(
    (n, o) => n + o.destinations.reduce((m, d) => m + d.quantity, 0),
    0,
  );
}
