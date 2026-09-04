/**
 * Pure helpers over a PICK SHEET — the document a multi-order packing list
 * renders.
 *
 * ```ts
 * import { buildPackingList } from "@cfs/core/utils/pickSheets";
 * ```
 *
 * A pick sheet is every open line at one destination, or with one organization,
 * **across orders** (`schemas/pick-sheet.ts`). This namespace is what
 * `it.pickSheets` resolves to for a `pick-sheets`-sourced template.
 *
 * ⚠️ **This entrypoint is camelCase where every sibling is kebab, and it is
 * forced rather than a style choice.** The generated helper catalogue keys on
 * the entrypoint BASENAME, while injection keys on the
 * {@link TEMPLATE_COLLECTION_UTILS} value, which must be a valid `it.<ns>`
 * identifier. Those two coincide for every existing namespace only because none
 * was ever multi-word — `movement-sessions` maps to the single word `sessions`.
 * `pick-sheets` is the first that is, and `it.pick-sheets` does not parse, so a
 * kebab entrypoint would satisfy one guard and fail the other. Renaming the
 * FILE is what keeps both true with no third mapping to drift.
 *
 * ## Why this namespace exists
 *
 * A template's `it.*` namespaces are resolved from its collections
 * (`availableUtilNamespaces`), so a pick-sheets-sourced family gets
 * `it.pickSheets` and **no `it.orders`**. Without this module it would get no
 * document helpers at all.
 *
 * ⚠️ **Re-exports, never reimplementations** — the same rule
 * `utils/fulfillments.ts` states. Mapping `pick-sheets` to the string
 * `"orders"` in `TEMPLATE_COLLECTION_UTILS` would put `it.orders` on a document
 * that is not an order, and a hand-written copy would drift;
 * `tests/template-helpers.test.ts` asserts these are the SAME function objects
 * as the orders bindings, so a copy fails rather than diverges.
 *
 * ## What is deliberately NOT here
 *
 * ⭐ **No quantity helper, because the fold already answered it.** The obvious
 * candidate was one resolving a line to its booking's units, since
 * {@link PickSheetItem.uid_booking} legitimately repeats across lines — a
 * booking is aggregate per `(order, product, destination)`, so a priced
 * principal beside its zero-priced accessories, a `splitItem`, or a product
 * appearing both standalone and as a kit component all name the same booking.
 * Summing it per line is N× wrong.
 *
 * But a template never needs to: {@link PickSheetDestination.quantity} is that
 * leg's total and {@link PickSheetDestination.breakdown} its seven buckets, both
 * computed once in the fold over the whole membership slice. **Shipping a helper
 * for a question the document already answers is the dead helper-panel surface
 * `TEMPLATE_HELPER_DENYLIST` exists to prevent** — and worse here, it would
 * offer a template the one arithmetic that has a wrong obvious form. Read the
 * section total; do not re-derive it.
 *
 * ## 🔴 The hazard a caller must handle — this document is PAGED
 *
 * {@link PickSheet.orders} is *the orders on THIS PAGE*; `order_count`,
 * `destination_count`, `quantity` and `organizations` describe the whole SCOPE.
 * That split is right for a screen and is a trap for a printed document: a
 * packing list rendered from a default page is **silently short**, showing a
 * page of orders under a scope-wide total that disagrees with them.
 *
 * ⚠️ **So a render caller must assemble every page before it renders, and must
 * not paper over it by rendering the counts alone.** Nothing in this namespace
 * can enforce that — by the time a template runs, a short document is
 * indistinguishable from a small one. It belongs to whatever builds the `doc`,
 * which is the same place `PickSheet.missing_order_uids` has to be surfaced
 * rather than dropped.
 *
 * @module
 */

/**
 * The **shared document sub-interface** — the five helpers a template partial
 * may call for any family, through a namespace object handed in as a prop.
 *
 * Shared markup cannot NAME a namespace (`it.orders` resolves for one family and
 * `it.pickSheets` for another), so `partials/shared/destinations.eta` takes `u`
 * and calls `u.getDestinationsLegend(...)`. That is sound only while every
 * family's namespace exports the same names, which is asserted rather than
 * assumed.
 *
 * ⚠️ Two of these are always FALSE on a pick sheet, for the same reason they are
 * on a fulfillment and equally correctly: `orderHasDiscount` and `orderHasTax`
 * select through `isPreTaxItem`, which returns false when an item has no
 * `price` — and a pick-sheet line carries a `FulfillmentItem`, which has none. A
 * packing list is not a money document. `orderHasRentals` reads `type` and
 * answers truthfully, so it can still drive a collection leg.
 *
 * ⚠️ These take ONE leg's items, not the sheet. Every one of them is a question
 * about a single `(order, destination)` section — pass
 * `destination.items.map((i) => i.item)`, never a concatenation across orders,
 * which would answer about a document no customer receives.
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
 *
 * ⚠️ **These operate on ONE leg's lines, and a pick sheet holds many.** Each
 * `PickSheetDestination.items[].item` is a `FulfillmentItem`, byte-identical to
 * its own document's, so the builders apply per section exactly as they do for a
 * fulfillment-sourced family. What changes is that the template drives them once
 * per `(order, destination)` rather than once per document.
 *
 * 🔴 **Per section, never pooled.** `item.path` is a row identity **within one
 * document**, so concatenating two orders' lines into one call would collide
 * rows that are not the same row — the reason `schemas/pick-sheet.ts` makes the
 * order a level of the nesting rather than a segment of a path, and the reason a
 * cross-order view groups existing paths and never recomputes them.
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
