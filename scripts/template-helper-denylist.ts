/**
 * Utils exports intentionally **not** surfaced in the template editor's helper
 * panel — structural / index / validation / sync machinery for app + API
 * writers, not for rendering a document.
 *
 * The utils carry no `@internal` JSDoc tag, so this is config rather than a tag
 * scan. `generate-template-helpers.ts` emits every export that is **not** listed
 * here, and `tests/template-helpers.test.ts` fails when a new export is neither
 * emitted nor denylisted — so adding a util forces a deliberate choice
 * (document it, or hide it here with a reason).
 *
 * **This is a UI catalogue, not a security boundary.** The API injects the whole
 * util module at render time; denylisting only keeps a helper out of the panel.
 * What actually stops a template misusing a write-path helper is the golden +
 * preview gate before merge.
 *
 * ## Cross-namespace union
 *
 * `utils/invoices.ts` re-exports 14 functions from `utils/orders.ts`, 6 of which
 * are order write-path machinery listed under `orders` below — they would
 * otherwise leak into `it.invoices`. The generator resolves each symbol's
 * **origin** module (via `deno doc`'s `location.filename`) and applies the
 * origin's denylist on top of the consuming namespace's, so those 6 are
 * suppressed under `it.invoices` too while the 8 genuinely render-useful
 * re-exports (`calculateItemSubtotal`, `isPriceableItem`, …) stay visible.
 * Filtering re-exports out wholesale would have dropped those 8 as well.
 *
 * @module
 */

/**
 * Denylisted exports per utils namespace. A namespace with no entry denylists
 * nothing. Only the injectable namespaces (see `TEMPLATE_COLLECTION_UTILS` and
 * `ALWAYS_ON_UTIL_NAMESPACES` in `src/schemas/template-context.ts`) are actually
 * reachable from a template, but the catalogue is generated for every
 * `./utils/*` entrypoint so a new collection needs no generator change.
 */
export const TEMPLATE_HELPER_DENYLIST: Record<string, string[]> = {
  // The whole availability engine. It answers "how many units are free over this
  // window?" from a StockSummary — and a template's render context never holds
  // one (templates render orders, invoices and quotes). There is no argument a
  // template could ever pass these, so surfacing them in the helper panel would
  // be pure dead surface. `toChicagoEndOfDay` stays visible under `dates`,
  // though: that one is a genuine date helper.
  availability: [
    "computeAvailability", // needs a StockSummary — never in a render context
    "computePublicAvailability", // needs a PublicStockSummary — likewise
    "toPublicStockSummary", // write-path projection, not a render helper
  ],
  // The movement-journal fold, denylisted whole for the same reason as
  // `availability`: every one of these takes an InventoryLedger or a Movement,
  // and a render context holds neither — templates render orders, invoices and
  // quotes. Surfacing them would be pure dead surface in the helper panel.
  movements: [
    "applyMovementToLedger", // the ledger fold — write-path only
    "deriveServiceQuantities", // ledger derivation — write-path only
    "applyOutOfServiceReason", // ledger derivation — write-path only
    "negateLines", // reversal transform — write-path only
    "heldDelta", // conservation arithmetic over a line
    "movementHeldDelta", // ditto, over a movement
    "costOfUnits", // basis arithmetic — money math, not presentation
    "allocationSide", // maps a type to the side an allocation lands on
  ],
  // Allocation answers "which shelf do I pick these off?" from a ledger's
  // store_breakdown. Same story: never in a render context.
  //
  // **A packing list is the tempting exception, and it is a trap.** A packing
  // list must show what WAS picked, not what WOULD be picked — the allocation is
  // stored data (a movement's `lines[]`, or `booking.stores[]` before the
  // journal), and recomputing it at render time answers a different question
  // against a ledger that has since moved. Two operators picking the same
  // product would get a document disagreeing with the shelf they actually
  // emptied. When that template lands it needs the movement or booking added as
  // a render **source**, not these functions un-denylisted.
  allocation: [
    "allocateBookingToStores", // needs a ledger store_breakdown
    "allocateBookingNetted", // ditto, plus a reserved map
    "allocateBookingWithNetting", // ditto, plus overlapping bookings
    "buildReservedByLocation", // netting building block
    "addAllocationToReserved", // netting building block
  ],
  orders: [
    "computeItemPaths", // canonical path computation — write-path only
    "validateItemPaths", // invariant assertion — write-path only
    "validateItemUniqueness", // invariant assertion — write-path only
    "validateComponentUniqueness", // invariant assertion — write-path only
    "getStructuralUids", // path machinery
    "getParentProductUid", // path machinery
    "getItemSubtreeRange", // path machinery
    "getRemovalIndices", // editor delete machinery
    "syncChargeDaysToItems", // mutates items in place — write-path only
    "deriveOrderDateEnvelope", // superseded by per-destination dates; not for rendering
    "buildQueryByDates", // Typesense projection helper
    "computeItemTaxAmount", // single-tax building block used by calculateItemTax — not a render helper
  ],
  invoices: [
    // ── Xero integration ──
    "flattenForXero", // Xero line projection — write-path only
    "getXeroUnitAmount", // bakes duration into a per-unit price for Xero
    // ── Payment / totals internals ──
    "recomputePaymentTotals", // payment accounting building block used by calculateInvoiceTotals
    // ── Path + uniqueness machinery (invoice variants of the order ones above) ──
    "computeInvoiceItemPaths", // canonical path computation — write-path only
    "validateInvoiceItemPaths", // invariant assertion — write-path only
    "validateInvoiceItemUniqueness", // invariant assertion — write-path only
    // ── order → invoice sync machinery ──
    "getSharedFields", // field-intersection helper for override comparison
    "isItemSynced", // override detection
    "syncOrderToInvoiceSelective", // selective item sync
    "syncOrderItems", // whole-scope item sync
    "syncOrderDestinationsSelective", // selective destination sync
    "syncScalarWithOverride", // co-write override detection
    "syncObjectWithOverride", // co-write override detection
    "carryForwardOverrides", // invoice-only override carryforward
    "buildOrderScopedItems", // order → invoice projection (write-path)
    "removeOrderScopedItems", // items mutation (write-path)
    "removeOrderScopedDestinations", // destinations mutation (write-path)
    "resyncInvoiceLines", // operator-triggered resync (write-path)
    "computeInvoiceSyncStatus", // manager line-badging, not rendering
  ],
  products: [
    // Denormalization machinery for `products.query_by_images`, re-exported here
    // from `schemas/product.ts` so writers have one import. Write-path only, and
    // a template could never call it usefully: no render context holds a product
    // (`template-context.ts` has no `product` — templates render orders,
    // invoices and quotes).
    "deriveProductImageUuids",
  ],
  // No `it.dates.*` exports are hidden today.
  dates: [],
};
