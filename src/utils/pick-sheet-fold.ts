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
import { buildBookingId } from "./booking-id.ts";
import { emptyBookingsBreakdown } from "./bookings.ts";
import { getItemSubtreeRange } from "./orders.ts";

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
 * The deterministic booking id — delegates to {@link buildBookingId}
 * (`./booking-id.ts`), the ONE shared constructor, rather than assembling its
 * own template. Kept as a thin wrapper (not called bare at each site) because
 * the two callers below hand it different item shapes, and this keeps their
 * call sites reading "the booking id for this occurrence" rather than four
 * positional args apiece.
 *
 * 🔴 The third parameter is the destination PAIR's own uid — the LEG — never
 * the pair's `delivery.uid`, which is a `destinations/{uid}` ADDRESS-BOOK id.
 * Two legs of one order may deliver to the SAME address, so keyed on the
 * address both resolve to one booking and this fold states that booking's whole
 * quantity once per leg (api-cloudrun#933 — a booking of 5 folding to 10).
 * ⚠️ This reverses the parameter's earlier meaning; api-cloudrun#663 is the
 * same pair of values confused on the invoice seam, and it too resolved in
 * favour of the pair uid.
 */
function bookingUidFor(
  orderUid: string,
  item: { uid: string; path: string[] },
  pairUid: string,
): string {
  return buildBookingId(orderUid, item, item.path, pairUid);
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
 * One occurrence of an aggregate booking — the two facts the owner rule reads.
 *
 * Structural rather than a named document type on purpose: the two callers hand
 * it different rows. This fold builds it from a `PickSheetItem`'s
 * `FulfillmentItem`; the manager's since-deleted `orderBookingJoin` builds it while
 * walking a whole order's `items[]`, including legs this fold would drop.
 */
export interface BookingOccurrence {
  /** The row's own `path`, carried verbatim from its document. */
  path: string[];
  /** The row's ordered line quantity. */
  quantity: number;
}

/**
 * Which of an aggregate booking's occurrences carries its quantities.
 *
 * 🔴 **ONE author, two callers, and the second one is why this is exported.** A
 * booking is aggregate per `(order, product, destination,
 * component_signature_hash)`, so the same product legitimately repeats inside
 * one leg — a priced principal beside its own zero-priced accessories, or a
 * `splitItem` clone. Exactly one occurrence renders the quantities; the rest
 * render booking-less and point at it. {@link foldPickSheet} stamps that
 * answer onto `PickSheetItem.owner_path`, and the manager's order-grain join
 * (`orderBookingJoin` (since deleted), which serves the whole fulfillment detail including
 * legs with nothing open) asks the same question about rows this fold never
 * sees. Two implementations of one rule is precisely what moving the fold to
 * core was for.
 *
 * ⭐ **Simplified from a two-arm rule (structural parentage, THEN quantity) to
 * quantity alone** — the structural-parentage override existed to rescue
 * cases where the OLD (non-ancestry-aware) booking id had wrongly merged
 * structurally-different occurrences of one product (prod order 961: a milk
 * crate under a steamer, two tents and an extension cord, all one booking).
 * Under {@link buildBookingId}'s ancestry-aware id, that collision is
 * unrepresentable: two occurrences only ever share one `uid_booking` when
 * their `componentAncestry` already agrees, so every candidate this function
 * chooses among is, by construction, genuinely fungible — the override arm
 * had nothing left to correct. Landed together with the matching update to
 * manager's `orderBookingJoin` (since deleted) (same beta wave) — simplifying
 * it in core alone, ahead of manager's own builder update, would have shipped
 * a core version that silently regressed manager's display the moment it
 * bumped its pin.
 *
 * The rule: **the largest ordered line quantity**, document order breaking a
 * tie. Exactly one row carries the picker, the action and the
 * reserved/prepped cells for every unit of the product in this section, so it
 * should be the row where the largest share of those units physically
 * belongs; a tie never displaces the incumbent, so the earliest of the best
 * quantity keeps the booking.
 *
 * Returns `null` for an empty list, which is the honest answer: a booking with
 * no occurrence on this sheet has no owner on it either.
 */
export function chooseBookingOwner<T extends BookingOccurrence>(
  occurrences: readonly T[],
): T | null {
  let best: T | null = null;
  for (const candidate of occurrences) {
    if (best === null || candidate.quantity > best.quantity) best = candidate;
  }
  return best;
}

/**
 * Does a destination scope admit a leg delivered to `uid`?
 *
 * 🔴 **`uids`, not `uid` — and the difference only became visible when
 * destinations grew a tree.** `scope.uids` is the set the membership query
 * actually ran on (`query_by_path array-contains`, self-inclusive); `scope.uid`
 * is the one the caller NAMED. For a bare destination the two say the same
 * thing, which is why narrowing on `uid` alone was correct for as long as a
 * destination had no descendants to have.
 *
 * ⚠️ **It stopped being correct silently, and in the failing-quiet direction.**
 * A `destination-subtree` scope resolves a property to its units and reads
 * every open booking across them — and then a `uid` narrowing discarded every
 * leg delivered to a UNIT, keeping only the property's own rows. The sheet came
 * back short rather than empty or erroring, so it read as "nothing is out at
 * Stage 25" instead of as a bug. `api-cloudrun`'s `resolveDestinationScope`
 * shipped its subtree arm against this.
 *
 * ⚠️ **An empty `uids` falls back to `uid`.** The field carries a `.default([])`
 * and predates its own population, so a scope built before this mattered — or by
 * a caller that fills only `uid` — must keep answering for the named node
 * rather than admitting nothing.
 *
 * ⚠️ **A `null` delivery endpoint is admitted by NO destination scope**, which is
 * what the `!==` comparison this replaced did by accident — `null !== uid` is
 * always true, so the leg was dropped. Stated rather than inherited: a leg with
 * no endpoint is not at any place, so no place's sheet can claim it.
 */
function destinationScopeAdmits(scope: PickSheetScope, uid: string | null): boolean {
  if (uid === null) return false;
  if (scope.uids.length === 0) return uid === scope.uid;
  return scope.uids.includes(uid);
}

/**
 * Fold a membership slice plus the fulfillment documents it names into
 * `orders[] → destinations[] → items[]`.
 *
 * ⚠️ `bookings` must already be the scope's slice — the destination subtree's or
 * the organization subtree's open bookings. This narrows by LEG, not by scope
 * membership: an order in the slice for one destination may carry a second leg
 * elsewhere, and the destination scope drops that one here — see
 * {@link destinationScopeAdmits} for which uids "the destination scope" means.
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
    const legs: PickSheetDestination[] = [];

    for (let i = 0; i < fulfillment.items.length; i++) {
      const divider = fulfillment.items[i];
      if (divider.type !== "destination") continue;

      const pair = fulfillment.destinations.find((d) => d.uid === divider.uid);
      if (!pair) continue;
      if (!pickSheetGateAdmits(pair, gate)) continue;
      if (scope.kind === "destination" && !destinationScopeAdmits(scope, pair.delivery.uid)) continue;

      const { endIndex } = getItemSubtreeRange(fulfillment.items, i);

      const items: PickSheetItem[] = [];
      // First-appearance order, deduped: a booking is aggregate per
      // `(order, product, leg)`, so several lines in one leg legitimately
      // name the same one — a priced principal beside zero-priced accessories, a
      // `splitItem`, or a product appearing both standalone and as a kit
      // component.
      const legBookings: PickSheetBooking[] = [];
      const seen = new Set<string>();
      // Every occurrence of each aggregate booking, in document order, scoped to
      // THIS leg — scoped rather than per order because a booking belongs to
      // exactly one leg by construction (its uid NAMES the leg), so a
      // leg-scoped map cannot leak an owner across a section boundary even if
      // that ever stops being true. ⭐ Under the old address-keyed id that
      // belonging was a claim about the DATA — two legs to one address shared a
      // booking — and this scoping is what contained the damage to a per-leg
      // overcount rather than a cross-leg one (api-cloudrun#933).
      const occurrences = new Map<string, BookingOccurrence[]>();

      for (let j = i + 1; j <= endIndex; j++) {
        const item = fulfillment.items[j];
        const uidBooking = bookingUidForItem(orderUid, item, pair, bookingByUid);
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
  pair: { uid: string; delivery: { uid: string | null } },
  bookingByUid: ReadonlyMap<string, Booking>,
): string | null {
  if (item.type === "destination" || item.type === "group") return null;
  // ⚠️ **No `delivery.uid === null` guard, deliberately.** This function used to
  // refuse an endpoint-less leg because the id embedded the delivery uid and so
  // could not be built. It can be built now, and the refusal has moved upstream
  // to a stronger place: `Booking.uid_destination_delivery` is a required
  // `FirestoreId`, so such a booking is unwritable. Refusing here as well would
  // be a second, weaker copy of that rule — and one that drops real work off a
  // packing list the day the schema changes.
  const uid = bookingUidFor(orderUid, item, pair.uid);
  return bookingByUid.has(uid) ? uid : null;
}

/**
 * Every aggregate booking's occurrences in ONE fulfillment, keyed by booking uid.
 *
 * The whole-document counterpart to the leg-scoped map {@link foldPickSheet}
 * builds inline. Equivalent per booking, and the fold's own note says why: a
 * booking belongs to exactly one leg by construction, because its uid NAMES the
 * leg. So an order-scoped walk cannot merge two legs' occurrences of one
 * booking — there is no such thing. ⭐ That is now structural; keyed on the
 * leg's ADDRESS it was a claim about the data, and a false one whenever two
 * legs delivered to the same place (api-cloudrun#933).
 *
 * ⭐ **It needs no `bookings` read.** `bookingUidFor` is a pure composite of
 * `(order, product, leg)` — plus the item's own component ancestry, for a
 * kit-component occurrence — so the keys are DERIVED; a caller that already
 * holds a real booking uid — a movement does — looks it up directly and a key
 * naming no real booking is simply never asked for. The fold passes a
 * `bookingByUid` only because it must also decide which lines are on the sheet
 * at all.
 *
 * Exported for the receipt (`MovementSessionItem.owner_path`), so the pick sheet
 * and the receipt designate the SAME row rather than deriving ownership twice.
 */
export function bookingOccurrencesByBooking(
  orderUid: string,
  // Non-readonly to match `getItemSubtreeRange`, which the fold hands the
  // same array. Does not mutate it.
  items: FulfillmentItemType[],
  destinations: readonly { uid: string; delivery: { uid: string | null } }[],
): Map<string, BookingOccurrence[]> {
  const out = new Map<string, BookingOccurrence[]>();

  for (let i = 0; i < items.length; i++) {
    const divider = items[i];
    if (divider.type !== "destination") continue;
    const pair = destinations.find((d) => d.uid === divider.uid);
    if (!pair) continue;

    const { endIndex } = getItemSubtreeRange(items, i);
    for (let j = i + 1; j <= endIndex; j++) {
      const item = items[j];
      if (item.type === "destination" || item.type === "group") continue;
      const occurrence: BookingOccurrence = {
        path: item.path,
        quantity: item.quantity,
      };
      const uidBooking = bookingUidFor(orderUid, item, pair.uid);
      const list = out.get(uidBooking);
      if (list) list.push(occurrence);
      else out.set(uidBooking, [occurrence]);
    }
  }
  return out;
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
