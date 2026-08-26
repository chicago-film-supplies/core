/**
 * Shared fulfillment utility functions for CFS applications.
 *
 * A thin namespace over `./orders.ts`, and deliberately so: a fulfillment's
 * `items[]` is the same structural shape an order's is — every member of
 * `FulfillmentItemType` is assignable to {@link LineItem} — and its
 * `destinations[]` is the same `DocDestinationType`. So the helpers a packing
 * list needs are already written; what was missing was a namespace to reach
 * them under.
 *
 * ```ts
 * import { buildPackingList } from "@cfs/core/utils/fulfillments";
 *
 * const toPick = buildPackingList(fulfillment.items);
 * ```
 *
 * ## Why this module exists at all
 *
 * `fulfillments` became a template SOURCE collection so a packing list can be
 * rendered from what was actually PICKED rather than from what was ordered — a
 * fulfillment line carries `quantity` beside `quantity_order`, and
 * `path_substituted_for` when a picker swapped one item for another. None of
 * that exists on the order, so an order-sourced packing list can only ever
 * describe intent.
 *
 * A template's `it.*` namespaces are resolved from its collections
 * (`availableUtilNamespaces`), so a fulfillments-sourced family gets
 * `it.fulfillments` and **no `it.orders`**. Without this module it would get no
 * document helpers at all.
 *
 * ⚠️ **Re-exports, never reimplementations.** The alternative — mapping
 * `fulfillments` to the string `"orders"` in `TEMPLATE_COLLECTION_UTILS` — would
 * put `it.orders` on a document that is not an order, which is exactly the
 * confusion the per-collection namespaces exist to remove. And a hand-written
 * copy would drift; `tests/template-helpers.test.ts` asserts these are the SAME
 * function objects as the orders bindings, so a copy fails rather than diverges.
 *
 * @module
 */

/**
 * The **shared document sub-interface** — the five helpers a template partial
 * may call for any family, through a namespace object handed in as a prop.
 *
 * Shared markup cannot NAME a namespace (`it.orders` resolves for one family and
 * `it.invoices` for another), so `partials/shared/destinations.eta` takes `u` and
 * calls `u.getDestinationsLegend(...)`. That is sound only while every family's
 * namespace exports the same names, which is asserted rather than assumed.
 *
 * ⚠️ Two of these are always FALSE on a fulfillment, and that is correct rather
 * than a gap: `orderHasDiscount` and `orderHasTax` select through
 * `isPreTaxItem`, which returns false when an item has no `price` — and a
 * fulfillment line has none, because a packing list is not a money document.
 * `orderHasRentals` reads `type`, and `rental` is a `FULFILLMENT_LINE_ITEM_TYPES`
 * member, so it answers truthfully and can still drive a collection leg.
 *
 * ⚠️ `isSameAsDeliveryDates` has an address-shaped sibling,
 * `isSameAsDeliveryDestination`, and a packing list showing both legs needs
 * both — collapsing a return that goes back where it came from. It is exported
 * below rather than here because it is not part of the shared five.
 */
export {
  getDestinationsLegend,
  isSameAsDeliveryDates,
  orderHasDiscount,
  orderHasRentals,
  orderHasTax,
} from "./orders.ts";

/**
 * The packing-list builders.
 *
 * `groupByDestination` already returns `packing_list_delivery` (rental + sale)
 * and `packing_list_collection` (rental only) per destination — the two legs a
 * packing list selects between — so the leg split is data rather than markup.
 */
export {
  buildPackingList,
  consolidateItems,
  type ConsolidatedItem,
  type DestinationGroup,
  type GroupPath,
  groupByDestination,
  type LineItem,
  type PackingListItem,
  type StructuralItem,
} from "./orders.ts";

/**
 * Structure and MOVEMENT — the two things a fulfillment is actually about.
 *
 * The test for what belongs in this namespace is the document's own subject: a
 * fulfillment describes inventory moving, not money changing hands. So the
 * whole priced surface of `utils/orders.ts` is deliberately absent — the
 * thirteen `calculate*` / `get*Totals` / `isTaxableCoa` / `isTransactionFeeItem`
 * helpers, and `getDefaultChargeDays`, whose "chargeable days" is a billing
 * duration. None of them are merely unneeded here: a fulfillment line has no
 * `price` object at all, and `transaction_fee` is not a
 * `FULFILLMENT_LINE_ITEM_TYPES` member, so they are inapplicable rather than
 * unused.
 *
 * ⚠️ **`isPreTaxItem` and `isPriceableItem` are absent for the same reason**,
 * even though they are predicates rather than arithmetic: both answer FALSE for
 * every fulfillment line, so exporting them would advertise a helper that can
 * only ever say no. That is the difference between them and `orderHasDiscount` /
 * `orderHasTax` above, which are also always-false here and are still exported —
 * those two are part of the SHARED FIVE, a contract the `u` prop depends on and
 * a ratchet asserts across all three namespaces. A contract is kept even where
 * an arm of it is trivially satisfied; a convenience is not.
 *
 * `getGroupPath` is also left out: its own docstring says the value "is only
 * ever a UI collapse key", which is a manager concern rather than a document one.
 */
export {
  getDestinationPairItemName,
  getGroupItems,
  getItemSubtreeRange,
  getParentProductUid,
  getStructuralUids,
  isSameAsDeliveryDestination,
  type ItemPathIssue,
  type ItemUniquenessIssue,
} from "./orders.ts";
