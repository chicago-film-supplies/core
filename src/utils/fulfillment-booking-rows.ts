/**
 * Fulfillment rows the ORDER does not carry, as an input to the order's booking
 * projection (api-cloudrun#1188).
 *
 * ## What is missing today
 *
 * Bookings are re-projected from the order, with two downstream divergences
 * handed in as inputs: a picker substitution (`itemsWithSubstitutions` in
 * `api-cloudrun/src/lib/substitutedSubtree.ts`) and a warehouse-authored
 * exchange leg (`withExchangeLegs` in `api-cloudrun/src/lib/exchangeLegs.ts`).
 * A third kind of row reaches neither and therefore books nothing: a line the
 * fulfillment carries at a path the order lacks — a picker addition, or an
 * invoice-only line projected onto the fulfillment (`invoiceOnlyLines` in
 * `utils/quantityAccounting.ts`). CFS deducts what was FULFILLED, so those rows
 * have to be able to book.
 *
 * ## Which rows
 *
 * A row is selected when ALL of these hold, and each one keeps another input from
 * being counted twice or a history row from being resurrected:
 *
 * - it is a LINE, at a path the projection does not already carry — the
 *   substitution netting and the exchange legs have already put their rows in;
 * - `quantity_ordered !== 0`. 🔴 **`0` is a KEPT row**: the order removed the
 *   line while its units were out, and the booking's history is owned by
 *   `buildKeptBooking` in `api-cloudrun/src/lib/bookingReconcile.ts` and
 *   {@link hasCustodyHistory}. Re-projecting it would book it a second time.
 * - it names no `substituted_for` entry, and sits in no substitution's subtree
 *   (`isSubstitutionRow`, over EVERY anchor — a spent one included, which is
 *   what keeps today's answer for a substitute whose X left the order);
 * - it asks for something: `quantity_ordered ?? quantity` is above 0.
 *
 * ## At what quantity
 *
 * At the row's ORDERED number, `quantity_ordered ?? quantity` — not the picker's.
 * The picker's number is an override applied afterwards by the reconcile's own
 * `pickerQuantityByPath` rule, which is how an invoice-only row the picker
 * lowered to 0 keeps its paperwork quantity beside a physical one of 0.
 *
 * ## Where they go
 *
 * 🔴 **Not appended.** `groupByDestination` assigns a row to a leg by its
 * POSITION, so a row appended at the tail would land under the last leg. They are
 * placed by {@link interleaveStoredOnlyRows}, after the projected row they
 * followed on the fulfillment, with any fulfillment-only divider they hang under.
 *
 * @module
 */
import { isLineItemType } from "../schemas/mod.ts";
import { interleaveStoredOnlyRows } from "./stored-only-rows.ts";
import { isSubstitutionRow, type SubstitutionAnchor } from "./substitutions.ts";

/** What this module reads off an item — the row's place and kind. */
export interface BookingRowShape {
  type: string;
  path: readonly string[];
  quantity?: number | null;
}

/** The fulfillment-only fields it reads beside {@link BookingRowShape}. */
export interface FulfillmentRowFields {
  quantity_ordered?: number | null;
  substituted_for?: readonly unknown[];
}

const key = (path: readonly string[]): string => path.join("/");

/** The quantity a selected row books at: what was ORDERED, else what the row holds. */
function orderedQuantity(row: BookingRowShape & FulfillmentRowFields): number {
  return row.quantity_ordered ?? row.quantity ?? 0;
}

/**
 * The fulfillment rows no other booking input carries and that may book.
 * See the module doc for the rule and why each clause is there.
 *
 * @param projectionPaths - The paths the projection ALREADY holds: the order's rows plus its substitution and exchange-leg inputs
 * @param fulfillmentRows - The fulfillment's items, in stored order
 * @param anchors - The fulfillment's substitution anchors
 */
export function fulfillmentOnlyBookingRows<R extends BookingRowShape & FulfillmentRowFields>(
  projectionPaths: Iterable<readonly string[]>,
  fulfillmentRows: readonly R[],
  anchors: readonly SubstitutionAnchor[],
): R[] {
  const carried = new Set<string>();
  for (const path of projectionPaths) carried.add(key(path));
  return fulfillmentRows.filter((row) =>
    isLineItemType(row.type) &&
    !carried.has(key(row.path)) &&
    row.quantity_ordered !== 0 &&
    (row.substituted_for?.length ?? 0) === 0 &&
    !isSubstitutionRow(row.path, anchors) &&
    orderedQuantity(row) > 0
  );
}

/**
 * {@link fulfillmentOnlyBookingRows}, placed into the projection at their ordered
 * quantity.
 *
 * Returns `items` ITSELF when no row qualifies, so a caller can assert by
 * reference that an order with no fulfillment-only row is untouched — the same
 * contract `withExchangeLegs` and `itemsWithSubstitutions` keep.
 *
 * @param items - The booking projection so far, in document order
 * @param fulfillmentRows - The fulfillment's items, in stored order
 * @param anchors - The fulfillment's substitution anchors
 */
export function withFulfillmentOnlyRows<T extends BookingRowShape>(
  items: T[],
  fulfillmentRows: readonly (T & FulfillmentRowFields)[],
  anchors: readonly SubstitutionAnchor[],
): T[] {
  const rows = fulfillmentOnlyBookingRows(items.map((i) => i.path), fulfillmentRows, anchors);
  if (rows.length === 0) return items;
  const survivors = new Set(rows);
  const survivorAs = new Map(rows.map((row) => [row, { ...row, quantity: orderedQuantity(row) }] as const));
  return interleaveStoredOnlyRows<T & FulfillmentRowFields>(items, {
    stored: fulfillmentRows,
    survivors,
    survivorAs,
    isLine: (row) => isLineItemType(row.type),
  });
}
