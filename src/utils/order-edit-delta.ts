/**
 * What an order edit leaves of the custody the warehouse already holds
 * (api-cloudrun#1147; the `cfs-order-projections` skill holds the rules).
 *
 * An order edit never refuses and never moves custody. It can remove or shrink
 * a line whose units are prepped or out, and when it does, what happened still
 * happened: the booking keeps its custody and the fulfillment keeps a row for
 * the part the order no longer covers. This module answers the ROW half of
 * that, from the stored bookings. The BOOKING half is the api's reconcile,
 * which keeps any booking with custody history (`hasCustodyHistory`, in
 * `utils/bookings.ts`) and
 * needs nothing from here.
 *
 * One function, two callers that must agree: api-cloudrun's fulfillment sync
 * (inside the order-edit transaction) and the manager's removal prompt (before
 * the edit is sent, fed by a live bookings listener). The prompt fires exactly
 * where the server would keep a row.
 *
 * ## Two predicates, deliberately different
 *
 * - **A booking is kept on custody HISTORY** (`prepped + out + returned + lost +
 *   damaged > 0`): its breakdown is the record custody audits replay from.
 * - **A fulfillment row is kept on LIVE custody** ({@link liveCustody}): a row
 *   exists to tell the warehouse about units still out there. A removed line
 *   whose units all came back loses its row and keeps its booking.
 *
 * ## The grain
 *
 * A booking is one `(product, LEG, component signature)`; several order rows can
 * share it (two groups on one leg). {@link grainKeep} decides how much of the
 * grain's live custody the next order leaves uncovered and which DECREASING rows
 * keep it, so removing one of two rows that share a prepped booking keeps
 * nothing while the other still covers the units.
 *
 * ⚠️ **A row that changes grain is a removal from the old grain plus an add to
 * the new one**: a leg move, a component dragged out of its kit, a merge into
 * another line. Custody never follows the row. Its `after` at the old grain is
 * 0, and if the old grain keeps a share the OLD row stays where it was while the
 * new position is projected fresh. {@link RowKeep.sameGrain} tells the caller
 * which of the two shapes it has.
 *
 * Pure and db-free.
 */
import { grainKeep, type GrainRow, liveCustody } from "./bookings.ts";
import { componentSignatureHash, parseBookingId } from "./booking-id.ts";
import { mapPathsAcrossRebuild } from "./item-pairing.ts";
import { groupByDestination } from "./orders.ts";
import { isFulfillableItem } from "../schemas/mod.ts";
import type { Booking, FulfillmentItemType, Order } from "../schemas/mod.ts";

/** What this module reads of a stored booking. */
export type BookingCustodyFacts = Pick<Booking, "type" | "breakdown">;

const SEP = "\x1f";
const keyOf = (path: readonly string[]): string => path.join(SEP);
const grainKey = (productUid: string, legUid: string, signature: string | null): string =>
  productUid + SEP + legUid + SEP + (signature ?? "");

/** The fate of one PREVIOUS-order row under the edit, when its grain keeps a share. */
export interface RowKeep {
  /** Units of the grain's uncovered live custody this row keeps. Always > 0. */
  share: number;
  /**
   * True when the row survives the edit at the SAME grain (a shrink, possibly
   * regrouped): the next row carries `after + share`. False when it was removed
   * or changed grain: the old row is kept where it stood, at `share`.
   */
  sameGrain: boolean;
  /**
   * The stored booking that holds the grain's custody. An action on the kept
   * units (undoing a scan for this row's `share`) targets this booking, so a
   * caller never derives the id again.
   */
  bookingId: string;
  /** The grain's whole live custody, of which {@link RowKeep.share} is this row's part. */
  live: number;
}

/** @see {@link computeOrderEditDelta} */
export interface OrderEditDelta {
  /** The keep for a row that sat at `prevPath` on the previous order, if any. */
  keepFor(prevPath: readonly string[]): RowKeep | undefined;
  /**
   * Whether the grain a stored row sits on still holds live custody. Asked of a
   * STORED fulfillment row, whose path is the previous order's (or, for a row
   * the order never had, no order's — then `false`).
   */
  hasLiveCustody(row: { uid: string; path: readonly string[] }): boolean;
  /** Legs the next order dropped that still hold a live grain: their pair stays on the fulfillment. */
  keptLegUids: ReadonlySet<string>;
}

/** Each fulfillable row's grain on one order, by path key. */
function grainsByPath(order: Order): Map<string, { grain: string; legUid: string }> {
  const out = new Map<string, { grain: string; legUid: string }>();
  for (const group of groupByDestination(order.items, order.destinations)) {
    // Same leg derivation as the booking writer. A draft's unplaced leg has
    // neither and books nothing, so it has no grain.
    const legUid = group.uid ?? group.uid_delivery;
    if (legUid === null) continue;
    for (const item of group.items) {
      out.set(keyOf(item.path), {
        grain: grainKey(item.uid, legUid, componentSignatureHash(item.path)),
        legUid,
      });
    }
  }
  return out;
}

/**
 * The row and leg keep for one order edit.
 *
 * @param args.storedBookings - The order's stored bookings by id — the COMPLETE
 *   set, read before the edit is decided. A booking whose id names another
 *   order, or does not parse, is ignored.
 * @param args.fulfillmentRows - The stored fulfillment rows; a row's `before` is
 *   its physical quantity there, falling back to the previous order's.
 *
 * ```ts
 * const delta = computeOrderEditDelta({ orderUid, prevOrder, nextOrder, fulfillmentRows, storedBookings });
 * for (const row of prevOrder.items) {
 *   const keep = delta.keepFor(row.path); // { share, sameGrain, bookingId, live } | undefined
 * }
 * ```
 */
export function computeOrderEditDelta(args: {
  orderUid: string;
  prevOrder: Order;
  nextOrder: Order;
  fulfillmentRows: readonly FulfillmentItemType[];
  storedBookings: ReadonlyMap<string, BookingCustodyFacts>;
}): OrderEditDelta {
  const { orderUid, prevOrder, nextOrder, fulfillmentRows, storedBookings } = args;

  const liveByGrain = new Map<string, number>();
  const bookingIdByGrain = new Map<string, string>();
  const liveLegs = new Set<string>();
  for (const [id, booking] of storedBookings) {
    const parsed = parseBookingId(id);
    if (parsed === null || parsed.orderUid !== orderUid) continue;
    const live = liveCustody(booking);
    if (live === 0) continue;
    // The id is the grain plus the order, so a grain has exactly one booking.
    const grain = grainKey(parsed.itemUid, parsed.destUid, parsed.signatureHash);
    liveByGrain.set(grain, (liveByGrain.get(grain) ?? 0) + live);
    if (!bookingIdByGrain.has(grain)) bookingIdByGrain.set(grain, id);
    liveLegs.add(parsed.destUid);
  }

  const nextLegs = new Set(nextOrder.destinations.map((p) => p.uid));
  const prevLegs = new Set(prevOrder.destinations.map((p) => p.uid));
  const keptLegUids = new Set([...liveLegs].filter((leg) => prevLegs.has(leg) && !nextLegs.has(leg)));

  const prevGrains = grainsByPath(prevOrder);
  const nextGrains = grainsByPath(nextOrder);

  const keeps = new Map<string, RowKeep>();
  if (liveByGrain.size > 0) {
    const prevRows = prevOrder.items.filter((i) => isFulfillableItem(i));
    const nextRows = nextOrder.items.filter((i) => isFulfillableItem(i));
    const moved = mapPathsAcrossRebuild(prevRows, nextRows);
    const nextByKey = new Map(nextRows.map((r) => [keyOf(r.path), r]));
    const storedQty = new Map<string, number>();
    for (const row of fulfillmentRows) {
      if ("quantity" in row && typeof row.quantity === "number") storedQty.set(keyOf(row.path), row.quantity);
    }

    const rowsByGrain = new Map<string, GrainRow[]>();
    const sameGrainByKey = new Map<string, boolean>();
    const pushRow = (grain: string, row: GrainRow) => {
      const list = rowsByGrain.get(grain);
      if (list) list.push(row);
      else rowsByGrain.set(grain, [row]);
    };
    const consumed = new Set<string>();
    for (const prev of prevRows) {
      const key = keyOf(prev.path);
      const grain = prevGrains.get(key)?.grain;
      if (grain === undefined || !liveByGrain.has(grain)) continue;
      const nextPath = moved.toPath(prev.path);
      const next = nextPath === undefined ? undefined : nextByKey.get(keyOf(nextPath));
      const sameGrain = next !== undefined && nextGrains.get(keyOf(next.path))?.grain === grain;
      if (sameGrain && next !== undefined) consumed.add(keyOf(next.path));
      sameGrainByKey.set(key, sameGrain);
      pushRow(grain, {
        key,
        before: storedQty.get(key) ?? prev.quantity ?? 0,
        after: sameGrain ? next?.quantity ?? 0 : 0,
      });
    }
    // Rows the next order adds to a live grain (or moves onto it) cover it too.
    for (const next of nextRows) {
      const key = keyOf(next.path);
      if (consumed.has(key)) continue;
      const grain = nextGrains.get(key)?.grain;
      if (grain === undefined || !liveByGrain.has(grain)) continue;
      pushRow(grain, { key: "next" + SEP + key, before: 0, after: next.quantity ?? 0 });
    }

    for (const [grain, rows] of rowsByGrain) {
      const live = liveByGrain.get(grain) ?? 0;
      const bookingId = bookingIdByGrain.get(grain);
      if (bookingId === undefined) continue;
      const { byRow } = grainKeep(live, rows);
      for (const [key, share] of byRow) {
        const sameGrain = sameGrainByKey.get(key);
        // Only previous rows decrease, so every share lands on one of them.
        if (sameGrain === undefined) continue;
        keeps.set(key, { share, sameGrain, bookingId, live });
      }
    }
  }

  return {
    keepFor: (prevPath) => keeps.get(keyOf(prevPath)),
    hasLiveCustody: (row) => {
      const key = keyOf(row.path);
      const grain = prevGrains.get(key)?.grain ?? nextGrains.get(key)?.grain;
      return grain !== undefined && liveByGrain.has(grain);
    },
    keptLegUids,
  };
}
