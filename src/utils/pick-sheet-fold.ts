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
import type { OrgPathNodeType } from "../schemas/mod.ts";
import { emptyBookingsBreakdown } from "./bookings.ts";
import { getItemSubtreeRange, getParentProductUid, getStructuralUids } from "./orders.ts";

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

/**
 * One occurrence of an aggregate booking — the three facts the owner rule reads.
 *
 * Structural rather than a named document type on purpose: the two callers hand
 * it different rows. This fold builds it from a `PickSheetItem`'s
 * `FulfillmentItem`; `manager/src/utils/orderBookingJoin.ts` builds it while
 * walking a whole order's `items[]`, including legs this fold would drop.
 */
export interface BookingOccurrence {
  /** The row's own `path`, carried verbatim from its document. */
  path: string[];
  /**
   * Whether the row's immediate parent is a DIVIDER rather than another product
   * — `getParentProductUid(item, structuralUids) === null`.
   */
  isStructural: boolean;
  /** The row's ordered line quantity. */
  quantity: number;
}

/**
 * Which of an aggregate booking's occurrences carries its quantities.
 *
 * 🔴 **ONE author, two callers, and the second one is why this is exported.** A
 * booking is aggregate per `(order, product, destination)`, so the same product
 * legitimately repeats inside one leg — a priced principal beside zero-priced
 * accessories, a `splitItem`, or a product appearing both standalone and as a
 * kit component. Exactly one occurrence renders the quantities; the rest render
 * booking-less and point at it. {@link foldPickSheet} stamps that answer onto
 * `PickSheetItem.owner_path`, and the manager's order-grain join
 * (`orderBookingJoin.ts`, which serves the whole fulfillment detail including
 * legs with nothing open) asks the same question about rows this fold never
 * sees. Two implementations of one rule is precisely what moving the fold to
 * core was for.
 *
 * The rule, in order:
 *
 * 1. **Structural parentage** — a strict OVERRIDE, not a tiebreak, and it is
 *    load-bearing. A booking-less structurally-parented row is exactly the one
 *    the manager's row classifier cannot rescue through a product ancestor: it
 *    has none. It still classifies, but only because SOME occurrence owns, so
 *    the structural class must win outright whenever it is non-empty.
 * 2. **The largest ordered line quantity.** Exactly one row carries the picker,
 *    the action and the reserved/prepped cells for every unit of the product in
 *    this section, so it should be the row where the largest share of those
 *    units physically belongs.
 *
 *    ⚠️ **This used to be document order alone, and that is arbitrary with
 *    respect to placement.** Prod order 961 had a Long Milk Crate at four
 *    component-parented occurrences (qty 1 / 1 / 2 / 1) under a steamer, two
 *    tents and an extension cord; document order handed all 5 units to the
 *    steamer's copy, so the crates were prepped from inside *Wardrobe* — and
 *    dragged the steamer, itself fully checked out, back into the *Reserved*
 *    pane as the ancestor shell needed to place its owner child.
 * 3. **Document order** — implicit. `occurrences` must be in it, and a tie never
 *    displaces the incumbent, so the earliest of the best `(structural,
 *    quantity)` pair keeps the booking.
 *
 * Returns `null` for an empty list, which is the honest answer: a booking with
 * no occurrence on this sheet has no owner on it either.
 */
export function chooseBookingOwner<T extends BookingOccurrence>(
  occurrences: readonly T[],
): T | null {
  let best: T | null = null;
  for (const candidate of occurrences) {
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.isStructural !== best.isStructural) {
      if (candidate.isStructural) best = candidate;
      continue;
    }
    if (candidate.quantity > best.quantity) best = candidate;
  }
  return best;
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
      // Every occurrence of each aggregate booking, in document order, scoped to
      // THIS leg — scoped rather than per order because a booking belongs to
      // exactly one leg by construction (its uid names the leg's endpoint), so a
      // leg-scoped map cannot leak an owner across a section boundary even if
      // that ever stops being true.
      const occurrences = new Map<string, BookingOccurrence[]>();

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

        const list = occurrences.get(uidBooking);
        const occurrence: BookingOccurrence = {
          path: item.path,
          isStructural: getParentProductUid(item, structuralUids) === null,
          quantity: item.quantity,
        };
        if (list) list.push(occurrence);
        else occurrences.set(uidBooking, [occurrence]);
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

      stampOwners(items, occurrences);

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
      // ⭐ **The fold DELIVERS the chain; it no longer composes a name.**
      //
      // This block used to compose one, under the argument that "a pick sheet
      // is a read-time response body, and a derived value is fine to deliver —
      // it is recomputed on every render, so it has no opportunity to disagree
      // with its input." That argument is not wrong about staleness, and it is
      // not the objection (core#93). Two things it does not answer:
      //
      //   1. Delivering ONLY the composed name is LOSSY. It discards the chain,
      //      so no consumer can trim the path against the document's own scope
      //      (as `statement.eta` does), group by ancestor, render the root, or
      //      link to the organization. `schemas/organization.ts` calls the
      //      chain "THE structural fact"; a leaf label is a projection of it.
      //   2. A pick sheet is a REGISTERED TEMPLATE SOURCE
      //      (`TEMPLATE_COLLECTION_SCHEMAS["pick-sheets"]`), so it is captured
      //      into git as a fixture. "Cannot disagree with its input" holds for
      //      a response body and NOT for a frozen artifact.
      //
      // `composeOrgName` is still the one author of the label — it just runs in
      // the renderer now (`it.organizations.composeOrgName`) instead of here.
      organization: {
        uid: fulfillment.organization.uid,
        organization_path: fulfillment.organization.path.length > 0
          ? fulfillment.organization.path
          : null,
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
function stampOwners(
  items: PickSheetItem[],
  occurrences: ReadonlyMap<string, BookingOccurrence[]>,
): void {
  const ownerByBooking = new Map<string, string[]>();
  for (const [uidBooking, list] of occurrences) {
    const owner = chooseBookingOwner(list);
    if (owner) ownerByBooking.set(uidBooking, owner.path);
  }
  for (const row of items) {
    if (row.uid_booking === null) continue;
    const ownerPath = ownerByBooking.get(row.uid_booking);
    if (!ownerPath) continue;
    if (samePath(ownerPath, row.item.path)) continue;
    row.owner_path = ownerPath;
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
): Array<{ uid: string | null; organization_path: OrgPathNodeType[] | null }> {
  const byUid = new Map<
    string | null,
    { uid: string | null; organization_path: OrgPathNodeType[] | null }
  >();
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
