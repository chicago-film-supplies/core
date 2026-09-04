/**
 * Pick sheet — every open line at one destination, or with one organization,
 * **across orders**. The read half of the fulfillment surface at the grain the
 * work actually has.
 *
 * A worker is at a place with a customer's gear in their hands, not inside one
 * order, and `fulfillments/{uid}` is 1:1 with an order
 * ({@link ./fulfillment.ts}). Every fulfillment surface that existed before this
 * was keyed on one order, so *"show me everything open at this destination"* had
 * no answer that was not a client-side fold.
 *
 * ## This is a DERIVED document, like a movement session
 *
 * Nothing is stored at this shape. It is rebuilt on every call from `bookings`
 * (membership and custody) and `fulfillments` (the rows), which is safe to
 * repeat because both are read-only inputs — the same contract
 * {@link ./movement-session.ts} states for the journal.
 *
 * ⚠️ **This is NOT the manager's `PickSheetSection`**
 * (`manager/src/utils/pickSheet.ts`), which is a RENDER model: it carries whole
 * `Booking` objects and a `Map` keyed by item path, neither of which crosses a
 * wire, and it designates one **owner** occurrence per aggregate booking so a
 * table does not draw the same quantities on N rows. This one is the document a
 * non-realtime caller is handed — see {@link PickSheetDestination.bookings} for
 * why it needs no owner rule at all.
 *
 * ## The structure is NESTING, and it is not a path grain
 *
 * `orders[] → destinations[] → items[]`, with every `items[].path` carried
 * **verbatim** from its own document.
 *
 * 🔴 **A cross-order or scoped VIEW groups existing paths and must never
 * recompute them.** An earlier revision of this design called for a
 * `computePickSheetItemPaths` and two new level tuples; that is withdrawn and
 * must not be rebuilt, for two reasons that generalise to any cross-document
 * view:
 *
 * 1. There is no `organization` divider type, and minting one is not local — it
 *    forces `ITEM_CONTRACTS.order.parentable_by` from `[]` to `["organization"]`,
 *    weakening `validateItemParentage` for every invoice, whose `order` dividers
 *    sit at the root.
 * 2. A `path` is a row identity **within one document**. Pooling two documents'
 *    paths into one namespace would collide rows that are not the same row —
 *    which is why an order's own uid is a level of the nesting rather than a
 *    segment of a path.
 *
 * @module
 */
import { z } from "zod";
import { AnyUid, FirestoreId, ItemUid } from "./_uid.ts";
import {
  ComponentTypeEnum,
  type ComponentTypeType,
  NameField,
} from "./common.ts";
import {
  BOOKING_STATUSES,
  BookingBreakdownSchema,
  type BookingBreakdown,
  type BookingStatusType,
  type BookingStore,
  BookingStoreSchema,
} from "./booking.ts";
import {
  DocDestination,
  type DocDestinationType,
  ORDER_STATUSES,
  type OrderStatusType,
} from "./order.ts";
import { FulfillmentItem, type FulfillmentItemType } from "./fulfillment.ts";

// ── The gate ────────────────────────────────────────────────────────

/**
 * Which legs a sheet admits.
 *
 * 🔴 **`customer_collecting` and `customer_returning` are DIRECTIONAL and
 * independent, and treating them as one boolean is a measured defect rather
 * than a simplification.** Verified against the writer
 * (`api-cloudrun/src/services/webhooks/opportunity.ts`): `customer_collecting`
 * repoints the **delivery** endpoint at our own store, `customer_returning`
 * repoints the **collection** endpoint. Nothing makes them move together, so
 * `customer_collecting || customer_returning` over-suppresses — a leg we deliver
 * and the customer returns has a REAL delivery endpoint, and hiding it means a
 * crew standing at that address is told nothing is out there.
 *
 * - `crew` — the leg's outbound work happens at the scoped place:
 *   `!customer_collecting`. Reproduces the `destinations.pick_bucket` roll-up
 *   row exactly, because that key is
 *   `customer_collecting ? "customer-collect" : delivery.uid`.
 * - `counter` — the leg has work at our own counter in EITHER direction:
 *   `customer_collecting || customer_returning`.
 * - `all` — no gate.
 *
 * ⭐ **`crew` and `counter` deliberately OVERLAP rather than partition.** A leg
 * we deliver and the customer returns has crew work outbound and counter work
 * inbound, so it belongs on both sheets, and each shows it to whoever has the
 * job. A partition would have to pick one and be wrong for the other.
 */
export const PICK_SHEET_GATES = ["all", "crew", "counter"] as const;

/** One member of {@link PICK_SHEET_GATES}. */
export type PickSheetGateType = typeof PICK_SHEET_GATES[number];

/** Zod enum over {@link PICK_SHEET_GATES}. */
export const PickSheetGateEnum: z.ZodType<PickSheetGateType> = z.enum(PICK_SHEET_GATES);

/**
 * The structural minimum the gate reads off a destination pair.
 *
 * Deliberately not the whole {@link DocDestinationType}: asking for that would
 * force every test to build `dates`, two endpoints and a jurisdiction that the
 * predicate never looks at.
 */
export type PickSheetGatePair = Pick<
  DocDestinationType,
  "customer_collecting" | "customer_returning"
>;

/**
 * Does this leg have work on a sheet gated this way? See {@link PICK_SHEET_GATES}.
 *
 * ⚠️ **One owner, deliberately, and it lives in a schema module rather than a
 * util.** The rule is the closed vocabulary's own semantics — a second copy
 * beside the enum is exactly how the `||` defect above survived as long as it
 * did — and `src/utils/*` entrypoints are walked by the template-helper
 * generator, which would advertise a warehouse predicate to PDF authors.
 */
export function pickSheetGateAdmits(
  pair: PickSheetGatePair,
  gate: PickSheetGateType,
): boolean {
  if (gate === "all") return true;
  if (gate === "counter") return pair.customer_collecting || pair.customer_returning;
  return !pair.customer_collecting;
}

// ── The leg's direction ─────────────────────────────────────────────

/**
 * Which way one leg's work is going.
 *
 * ⭐ **Derived from CUSTODY, never stated** — the same rule that already decides
 * which date `PickSheetDestination.due_at` carries. A leg whose units are all in
 * flight is waiting on its collection; everything earlier is waiting on its
 * delivery.
 *
 * ⚠️ **Exactly two members, and deliberately no `all`** — unlike
 * {@link PICK_SHEET_GATES}, which has one. A gate is only ever *chosen*, so an
 * `all` member costs nothing there; a direction is *computed*, and giving the
 * enum a third value would widen {@link pickSheetLegDirection}'s return type to
 * include one it can never produce. "Both directions" is the ABSENCE of a
 * filter, which is why {@link PickSheet.leg} is nullable rather than `"all"`.
 */
export const PICK_SHEET_LEGS = ["delivery", "collection"] as const;

/** One member of {@link PICK_SHEET_LEGS}. */
export type PickSheetLegType = typeof PICK_SHEET_LEGS[number];

/** Zod enum over {@link PICK_SHEET_LEGS}. */
export const PickSheetLegEnum: z.ZodType<PickSheetLegType> = z.enum(PICK_SHEET_LEGS);

/**
 * The structural minimum the direction reads off a leg's bookings.
 *
 * Deliberately not the whole {@link PickSheetBooking} — the same reasoning as
 * {@link PickSheetGatePair}. Narrow enough that api-cloudrun's own `Booking`
 * satisfies it structurally, which is what lets the fold call this rather than
 * keep a second copy.
 */
export type PickSheetLegCustody = Pick<PickSheetBooking, "type" | "breakdown">;

/**
 * Which way this leg's work is going, from its bookings' custody.
 *
 * ⚠️ **The predicate is `getStageForBookings(…) === "return"`, spelled out.**
 * That ladder is reserved → prepped → rental `out`, so "in flight" means no
 * `reserved` and no `prepped` anywhere on the leg plus at least one RENTAL
 * holding `out`. `quoted` is checked after `out` there and so does not enter
 * here either. **A non-rental `out` is terminal — checkout IS delivery for a
 * sale** — so it must not pull a leg onto a collection that will never happen.
 *
 * 🔴 **ONE owner, and it lives in a schema module rather than a util** — the
 * same two reasons as {@link pickSheetGateAdmits}. The rule is this vocabulary's
 * own semantics, so a second copy beside the enum is how the copies drift; and
 * `src/utils/*` entrypoints are walked by the template-helper generator, which
 * would advertise a custody predicate to PDF authors.
 *
 * ⚠️ **This answers what a leg is doing NOW, which is not what a printed
 * document IS.** Custody moves, so a delivery packing list re-rendered after its
 * goods went out would derive `collection` and change identity. Use this to
 * RESOLVE {@link PickSheet.leg} once, at build time; then read the stamped
 * field. Derivation supplies the default; the stamped value is the fact.
 */
export function pickSheetLegDirection(
  bookings: readonly PickSheetLegCustody[],
): PickSheetLegType {
  const pendingBefore = bookings.some(
    (b) => b.breakdown.reserved > 0 || b.breakdown.prepped > 0,
  );
  const inFlight = bookings.some((b) => b.type === "rental" && b.breakdown.out > 0);
  return !pendingBefore && inFlight ? "collection" : "delivery";
}

/**
 * Does this leg belong on a sheet drawn for `leg`? Mirrors
 * {@link pickSheetGateAdmits}.
 *
 * `null` admits everything — it is the pick-sheet screen's own behaviour, where
 * a worker wants both directions at a place.
 */
export function pickSheetLegAdmits(
  bookings: readonly PickSheetLegCustody[],
  leg: PickSheetLegType | null,
): boolean {
  return leg === null || pickSheetLegDirection(bookings) === leg;
}

// ── The scope ───────────────────────────────────────────────────────

/**
 * What a sheet was drawn for — echoed back so a stored or forwarded sheet says
 * what it is an answer to.
 *
 * ⚠️ For `kind: "destination"`, `uid` is the `destinations/{uid}` **address-book**
 * id — the physical place, shared across orders, which is the only reason a
 * cross-order sheet finds anything at all. It is NOT a destination divider's
 * uid, which is per-document and joins nothing outside it. api-cloudrun#663 is
 * that pair confused the other way round.
 */
export interface PickSheetScope {
  kind: "destination" | "organization";
  /** The uid the caller asked about. */
  uid: string;
  /** Its display name, resolved at fold time; `""` when it could not be read. */
  name: string;
  /**
   * Every uid the membership query actually ran on.
   *
   * For a destination that is `[uid]`. For an organization subtree it is the
   * resolved node set (`query_by_path array-contains uid`, self-inclusive), so
   * the response states the tree it was answered against rather than leaving the
   * caller to guess whether `subtree` did anything.
   */
  uids: string[];
}

/** Zod schema for {@link PickSheetScope}. */
export const PickSheetScopeSchema: z.ZodType<PickSheetScope> = z.strictObject({
  kind: z.enum(["destination", "organization"]),
  uid: FirestoreId,
  name: z.string().default(""),
  uids: z.array(FirestoreId).default([]),
});

// ── A booking, as a pick sheet states it ────────────────────────────

/**
 * One aggregate booking on a leg — custody, and where the units live.
 *
 * 🔴 **No money.** A booking carries `unit_price_cents` and `total_price_cents`;
 * a pick sheet is a warehouse document and the fulfillment projection it is
 * built from is *"no price, no financial flags"*. Projecting the fields a picker
 * needs, rather than the whole booking, is what keeps that true by construction
 * instead of by convention.
 */
export interface PickSheetBooking {
  /** `{uid_order}:{uid_product}:{delivery.uid}` — deterministic, hence joinable. */
  uid: string;
  uid_product: string;
  name: string;
  type: ComponentTypeType;
  status: BookingStatusType;
  quantity: number;
  shortage: number;
  breakdown: BookingBreakdown;
  /**
   * Where the units are shelved.
   *
   * The one field on this document that answers *"where do I walk"*, which is
   * the question a pick sheet exists for. Carried verbatim off the booking.
   */
  stores: BookingStore[];
}

/** Zod schema for {@link PickSheetBooking}. */
export const PickSheetBookingSchema: z.ZodType<PickSheetBooking> = z.strictObject({
  uid: AnyUid,
  uid_product: FirestoreId,
  name: z.string().default(""),
  type: ComponentTypeEnum,
  status: z.enum(BOOKING_STATUSES),
  quantity: z.int(),
  shortage: z.int(),
  breakdown: BookingBreakdownSchema,
  stores: z.array(BookingStoreSchema).default([]),
});

// ── A row ───────────────────────────────────────────────────────────

/**
 * One line on a sheet — a fulfillment row, carried verbatim, plus the booking
 * it resolves to.
 *
 * 🔴 **`bookings` cannot be the row source, and this is the whole reason the
 * sheet reads `fulfillments`.** There is no booking row for a `service` /
 * `surcharge` / `transaction_fee` line, none for a `stock_method: "none"`
 * product, and no dividers at all — so a bookings-derived sheet is silently
 * short, which is the one failure this surface refuses. Membership answers
 * *which orders*; the sanitized fulfillment projection supplies every row.
 */
export interface PickSheetItem {
  /** The fulfillment line or `group` divider, byte-identical to its document's. */
  item: FulfillmentItemType;
  /**
   * The aggregate booking this line resolves to, or `null` for a divider, a
   * non-stock line, or a line whose booking has not been written.
   *
   * ⚠️ **Several lines legitimately share one value.** A booking is aggregate
   * per `(order, product, destination)`, and the same product may repeat inside
   * one leg — a priced principal beside zero-priced accessories, a `splitItem`,
   * or a product appearing both standalone and as a kit component. Look the
   * quantities up in {@link PickSheetDestination.bookings}; do NOT sum this
   * field's booking across the lines that name it.
   */
  uid_booking: string | null;
}

/** Zod schema for {@link PickSheetItem}. */
export const PickSheetItemSchema: z.ZodType<PickSheetItem> = z.strictObject({
  item: FulfillmentItem,
  uid_booking: AnyUid.nullable(),
});

// ── A leg ───────────────────────────────────────────────────────────

/**
 * One order's one destination leg — a section of the sheet.
 *
 * Each destination dispatches independently, so the totals here are the leg's
 * own and never the order's.
 */
export interface PickSheetDestination {
  /**
   * The destination DIVIDER's uid — this leg's identity **within its order's
   * document**, and the pair's `uid`.
   *
   * 🔴 Not a `destinations/{uid}` address-book id; that is
   * {@link PickSheetDestination.destination}`.delivery.uid`. Confusing the two is
   * api-cloudrun#663.
   */
  uid: string;
  /** The divider's own name — the address is on `destination.delivery`. */
  name: string;
  /** The stored pair, verbatim: both endpoints, the dates and the two flags. */
  destination: DocDestinationType;
  /**
   * When this leg is next due — the field the sheet is ordered on.
   *
   * Which date that is depends on which way the work is going, derived from
   * custody rather than from a page-level direction: a leg whose units are all
   * in flight is waiting on its collection, and everything earlier is waiting on
   * its delivery. `null` when the pair states neither date, and a null sorts
   * LAST rather than first.
   */
  due_at: string | null;
  /** Units across this leg's bookings — the section's summary number. */
  quantity: number;
  /** Those bookings' breakdowns, summed. The seven buckets, not a stage label. */
  breakdown: BookingBreakdown;
  bookings: PickSheetBooking[];
  items: PickSheetItem[];
}

/** Zod schema for {@link PickSheetDestination}. */
export const PickSheetDestinationSchema: z.ZodType<PickSheetDestination> = z.strictObject({
  uid: ItemUid,
  name: z.string().default(""),
  destination: DocDestination,
  due_at: z.string().nullable(),
  quantity: z.int(),
  breakdown: BookingBreakdownSchema,
  bookings: z.array(PickSheetBookingSchema).default([]),
  items: z.array(PickSheetItemSchema).default([]),
});

// ── An order ────────────────────────────────────────────────────────

/** One order on a sheet, with only the legs the scope and gate admitted. */
export interface PickSheetOrder {
  uid: string;
  number: number;
  /** The order's status, carried through the fulfillment projection. */
  status: OrderStatusType;
  subject: string;
  organization: { uid: string | null; name: string };
  destinations: PickSheetDestination[];
}

/** Zod schema for {@link PickSheetOrder}. */
export const PickSheetOrderSchema: z.ZodType<PickSheetOrder> = z.strictObject({
  uid: FirestoreId,
  number: z.int(),
  status: z.enum(ORDER_STATUSES),
  subject: z.string().default(""),
  organization: z.strictObject({
    uid: FirestoreId.nullable(),
    name: NameField,
  }),
  destinations: z.array(PickSheetDestinationSchema).default([]),
});

// ── The sheet ───────────────────────────────────────────────────────

/**
 * The aggregated pick sheet — one scope, one gate, N orders.
 *
 * Orders are in due order (each order's earliest leg, ties on uid) and each
 * order's legs are in due order within it, so the first thing on the page is the
 * first thing to do.
 */
export interface PickSheet {
  scope: PickSheetScope;
  gate: PickSheetGateType;
  /**
   * The direction this sheet was drawn for, or `null` for both.
   *
   * ⭐ **Stamped, not re-derived — the same contract as `scope` and `gate`.** A
   * sheet says what question it is an answer to, so a stored or forwarded one
   * still means what it meant. That is what makes a packing list a record: it
   * accompanies ONE movement, and re-rendering it weeks later must not silently
   * turn a delivery note into a collection note because custody moved
   * underneath it (templates#150).
   *
   * `pickSheetLegDirection` computes the default; a caller may override it. The
   * pick-sheet SCREEN passes `null` — a worker at a place wants both.
   */
  leg: PickSheetLegType | null;
  /**
   * The orders on THIS PAGE. `orders.length` is the page size; every count
   * below is the whole scope.
   */
  orders: PickSheetOrder[];
  /**
   * Distinct orders the scope and gate admit, **across every page**.
   *
   * ⚠️ **These four totals describe the SCOPE, not the page**, and there is
   * deliberately no page-sized twin of any of them — `orders.length` already
   * says that, and a pair of near-identical counters is how a reader ends up
   * quoting the wrong one. *"How much is out at this destination"* has to be
   * answerable from page 1 or the number is worse than absent; the fold runs
   * over the whole membership slice before it is clipped, so the totals cost
   * nothing.
   */
  order_count: number;
  /** Legs the scope and gate admit, across every page. */
  destination_count: number;
  /** Units across every admitted leg, across every page. */
  quantity: number;
  /**
   * Distinct organizations across every page, `null` counted once.
   *
   * A destination sheet spanning two customers is the case the order headers
   * exist for: a worker at a shared stage must not hand one production's gear to
   * another. {@link ./movement-session.ts} takes the same shape.
   */
  organizations: Array<{ uid: string | null; name: string }>;
  /**
   * Orders in the membership slice with no readable fulfillment document.
   *
   * 🔴 **Surfaced, never dropped.** A pick sheet that is silently short is the
   * one failure this surface refuses. It means `bookings` and the projection
   * disagree, which is a finding
   * (`api-cloudrun/scripts/audit-fulfillment-projection.ts`), not a display
   * problem — so it is reported even when the page is otherwise complete.
   */
  missing_order_uids: string[];
  /**
   * Where the next page resumes from — pass it back as `start_after`. `null` is
   * the only end-of-results signal.
   *
   * ⚠️ **Pagination is by ORDER, never by row.** An order's legs and a leg's
   * lines are what a worker carries to one place; splitting them across pages
   * would hand somebody half a section and no way to know it.
   *
   * ⚠️ **Opaque, and it is the whole SORT KEY rather than the last uid.** The
   * sheet is ordered by `(due date, order uid)`, so a bare uid can only be
   * resumed from by finding it again — and the order it names may legitimately
   * have left the sheet by the next call, having been checked in. Carrying the
   * key means the resume is a comparison against a value the caller already
   * holds, which stays total when the corpus moves underneath it: no skips, no
   * repeats, terminates.
   */
  next_cursor: string | null;
  /** Set only when the page was clipped — what happened and what to do. */
  notice: string | null;
}

/** Zod schema for {@link PickSheet}. */
export const PickSheetSchema: z.ZodType<PickSheet> = z.strictObject({
  scope: PickSheetScopeSchema,
  gate: PickSheetGateEnum,
  leg: PickSheetLegEnum.nullable(),
  orders: z.array(PickSheetOrderSchema).default([]),
  order_count: z.int(),
  destination_count: z.int(),
  quantity: z.int(),
  organizations: z.array(z.strictObject({
    uid: FirestoreId.nullable(),
    name: NameField,
  })).default([]),
  missing_order_uids: z.array(FirestoreId).default([]),
  next_cursor: z.string().nullable(),
  notice: z.string().nullable(),
}).meta({ title: "PickSheet" });
