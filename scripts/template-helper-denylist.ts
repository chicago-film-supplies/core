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
  // ⭐ **`composeOrgName` was promoted out of this list on 2026-09-01, and the
  // condition that governed it was written down in advance**: it became
  // render-useful the moment `DocumentOrganizationSnapshot` carried `path` AND
  // `organizations` joined an injection list. The first landed in
  // `10.0.0-beta.303`; the second is this change, adding `organizations` to
  // `ALWAYS_ON_UTIL_NAMESPACES` (`src/schemas/template-context.ts`). It is the
  // only way to render a customer name from a frozen chain, which is the
  // prerequisite for api-cloudrun#782.
  //
  // Everything else stays denied, and the namespace being injected is what makes
  // that a real choice rather than a formality — each of these would now work if
  // emitted:
  //
  //   - `buildOrganizationSnapshot` — write-path. It assembles the embedded
  //     `organization` block from a live `Organization` DOCUMENT, a shape no
  //     render context ever holds: a template sees `it.doc.organization`, which
  //     is this function's OUTPUT.
  //   - `computeOrganizationNode` is the ONE AUTHOR of `path` and
  //     `validateOrganizationTree` is its guard — both write-path, and a
  //     template calling either is a category error rather than a mistake.
  //   - `orgRootUid` / `orgParentUid` return document IDs, which a rendered
  //     document never prints.
  //   - `orgLevel` / `orgOwnName` answer questions about a node's POSITION.
  //     A document names its customer; it does not report where that customer
  //     sits in CFS's internal tree.
  //   - `resolveBillingAddress` walks the tree for the address a document
  //     should FREEZE (api-cloudrun#777: org states, project overrides,
  //     department inherits). Write-path for the same reason as
  //     `buildOrganizationSnapshot`, and doubly unreachable from a template: it
  //     takes an ANCESTORS map, which a render context cannot build because it
  //     holds one frozen snapshot and no way to read Firestore. A template that
  //     wants the billing address reads `it.doc.organization.billing_address` —
  //     already this function's output, resolved at write time.
  organizations: [
    "buildOrganizationSnapshot",
    "computeOrganizationNode",
    "orgLevel",
    "orgOwnName",
    "orgParentUid",
    "orgRootUid",
    "resolveBillingAddress",
    "validateOrganizationTree",
  ],
  // Stock primitives — the interval rules and the two consumption definitions.
  // Denylisted whole, for the same reason as `movements`:
  // every one takes a booking breakdown, an OOS record or a Firestore timestamp
  // pair off a stock document, and a render context holds none of those —
  // templates render orders, invoices and quotes. Pure dead surface in the
  // helper panel, and worse than dead for the two consumption functions, which
  // are only safe to use when you know which denominator you are subtracting
  // from (see `utils/stock.ts`'s header).
  stock: [
    "heldByBooking",
    "unitsClaimedOnShelves",
    "bookingHoldsStock",
    "oosConsumes",
    "boundMs",
    "intervalsOverlap",
    "windowMs",
    // The reducers and the fold: one takes a booking, one an OOS record, one a
    // `stock/{P}` document. Same reason as the rest of the namespace.
    "unavailableFromBooking",
    "unavailableFromOOS",
    "computeStockAvailability",
    "peakStockConsumption",
  ],
  // The movement-journal fold, denylisted whole — but ⚠️ **the reason is no
  // longer uniform, and the sentence that stood here is stale.** It read "a
  // render context holds neither an InventoryLedger nor a Movement", which was
  // true while templates rendered only orders, invoices and quotes. Since
  // api-cloudrun#700 a `movement-sessions`-sourced family renders a fold of the
  // journal, and `it.doc.items[].lines` IS a `MovementLineType[]` — so two of
  // the eight below now have a reachable argument:
  //
  //   - `heldDelta` / `movementHeldDelta` — REACHABLE, and denied only because
  //     no family calls them yet. Lift the entry in the change that adds the
  //     call, alongside the re-export in `utils/sessions.ts`.
  //   - the other six — still unreachable: each takes an `InventoryLedger` or a
  //     whole `Movement` document, and a session's items are neither.
  movements: [
    "applyMovementToLedger", // the ledger fold — write-path only
    "deriveServiceQuantities", // ledger derivation — write-path only
    "applyOutOfServiceReason", // ledger derivation — write-path only
    "negateLines", // reversal transform — write-path only
    "heldDelta", // conservation arithmetic over a line
    "movementHeldDelta", // ditto, over a movement
    "costOfUnits", // basis arithmetic — money math, not presentation
    "allocationSide", // maps a type to the side an allocation lands on
    // The Xero posting table. A ledger-seam decision, not presentation: it
    // answers "which accounts does this movement post to, and does it post at
    // all" — a question no rendered document asks. Its account constants
    // (`XERO_ASSET_ACCOUNTS`, `XERO_OFFSET_ACCOUNTS`) are values rather than
    // functions, so the generator never sees them.
    "xeroPostingFor",
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
    // The divider ↔ pair join, derived at WRITE time and then stored as
    // `destinations[i].uid`. A render context reads that field directly; a
    // template re-deriving it would be recomputing an identity the document
    // already carries — the same trap as `sumDocumentTotals` below, on the
    // structural axis rather than the money one.
    "assignDestinationPairUids",
    // The mint side of the same join — a WRITER builds a destination pair and
    // its divider together; a template renders the pair the document already
    // carries.
    "buildDestinationPairWithDivider",
    "computeItemPaths", // canonical path computation — write-path only
    "validateItemPaths", // invariant assertion — write-path only
    "validateItemUniqueness", // invariant assertion — write-path only
    "validateItemParentage", // invariant assertion — write-path only
    "validateComponentUniqueness", // invariant assertion — write-path only
    "getStructuralUids", // path machinery
    "getParentProductUid", // path machinery
    "getItemSubtreeRange", // path machinery
    "getRemovalIndices", // editor delete machinery
    "syncChargeDaysToItems", // mutates items in place — write-path only
    "deriveOrderDateEnvelope", // superseded by per-destination dates; not for rendering
    "buildQueryByDates", // Typesense projection helper
    "computeItemTaxAmountCents", // single-tax building block used by calculateItemTax — not a render helper
    // The transaction-fee pass of calculateOrderTotals/calculateInvoiceTotals.
    // Both need the DOCUMENT's subtotal_discounted as a basis, and both answer a
    // question the render context already has an answer to: the fee's amount is
    // stored on the line (`price.total_cents`) and rolled up in
    // `totals.transaction_fees`. Recomputing at render time would let a document
    // disagree with the doc it renders — the same trap as `allocation` above.
    "calculateTransactionFeeAmountCents", // fee arithmetic — totals pass only
    "costTransactionFees", // fee arithmetic over an array — totals pass only
    // The six-field fold shared by calculateOrderTotals and
    // calculateInvoiceTotals. Same argument as the two above, one level up: a
    // rendered document reads its STORED `totals`, and recomputing at render
    // time is precisely how a document comes to disagree with the doc it
    // renders. `calculateOrderTotals` / `calculateInvoiceTotals` stay visible
    // because a template legitimately re-totals a subset (a per-destination
    // block); this one only ever reproduces what those two already returned.
    "sumDocumentTotals",
    // The line-price author (api-cloudrun#570). All four are WRITE-path: they
    // decide how a stored `price` object is computed and assembled, and a
    // render context already holds the object they produce. Re-running one at
    // render time is the `sumDocumentTotals` trap at the line level — a
    // document disagreeing with itself — and `assembleLinePrice` in particular
    // would advertise a helper whose first argument is a half-built price a
    // template never has.
    "assembleLinePrice",
    "computeLineMoney",
    "priceTransactionFeeLine",
    // The type-level predicate the three above branch on. A template that needs
    // to know a line is a fee reads `it.…type`, or the visible
    // `isTransactionFeeItem` / `isPreTaxItem` pair, which take the STORED shape
    // a render context actually holds.
    "isFromTotalItemType",
    "validatePathsAgainst", // path machinery, parameterised — write-path only
    // `isPreTaxItem` at the PricingItem surface — the guard the three pricing
    // entry points use so a writer can price an order-INPUT item. A template
    // renders stored items and has `isPreTaxItem` for them; this one exists for
    // the write path and would only invite a template to narrow the wrong shape.
    "isPreTaxPricingItem",
    // Same reason, same pairing, for the fee family (core#56). `isTransactionFeeItem`
    // is the one a template wants; this is its PricingItem twin, added so
    // `calculateTransactionFeeAmountCents` can accept an item a writer has not
    // built yet.
    "isTransactionFeePricingItem",
  ],
  invoices: [
    // ── Xero integration ──
    "flattenForXero", // Xero line projection — write-path only
    "getXeroUnitAmountFromCents", // bakes duration into a per-unit price for Xero
    // ── Payment / totals internals ──
    // `recomputePaymentTotals` sat here for months after the function was
    // deleted — a dead string nothing could see, because this file names its
    // targets as text. `tests/template-helpers.test.ts` now asserts every
    // entry resolves to a real export, so a rename breaks the build instead.
    "recomputeSettlementTotals", // settlement projection — a template reads STORED totals
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
    "carryForwardOverrides", // invoice-only override carryforward
    "buildOrderScopedItems", // order → invoice projection (write-path)
    "removeOrderScopedItems", // items mutation (write-path)
    "removeOrderScopedDestinations", // destinations mutation (write-path)
    "resyncInvoiceLines", // operator-triggered resync (write-path)
    "computeInvoiceSyncStatus", // manager line-badging, not rendering
    "invoiceItemsMatch", // the one order↔invoice comparator — sync machinery
    "invoiceItemDifferences", // that comparator's substrate — audits + histograms
    "unexplainedInvoiceItemDifferences", // the sync explainers — badge + audit machinery
    "explainInvoiceItemDifferences", // ditto, plus which arm fired — diagnostics
    // Order → invoice projection. Exported for probes and audits
    // (api-cloudrun#481), NOT for rendering: it takes an ORDER line and an order
    // divider uid, and a template that has an order already has its items.
    "projectOrderItemToInvoiceItem",
    "adoptOrderDividerStructure", // re-hangs an invoice on the order's dividers (write-path)
    "invoiceScopeDividersMatch", // structural alignment predicate — audit + endpoint
    // Order-first coverage. Not a render helper: it needs every LINKED
    // INVOICE's items, which a render context never holds (a template is
    // handed one document), and its answer is an operator advisory.
    "computeOrderInvoiceCoverage",
  ],
  // The line builders, denylisted whole. Every one of them CONSTRUCTS a line
  // item from a Typesense `ProductDocument` — a write-path input a render context
  // never holds (`template-context.ts` has no `product`; templates render orders,
  // invoices and quotes, which already carry their `items[]`). A template
  // producing new line items would be authoring data, not rendering it.
  "order-lines": [
    "buildOrderLineFromProduct", // stages an order line from the catalog
    "buildCustomOrderLine", // mints a `custom-` order line
    "buildCustomInvoiceLine", // mints a `custom-` invoice line
    "buildOrderComponentLines", // expands a kit's component subtree
  ],
  products: [
    // Denormalization machinery for `products.query_by_images`, re-exported here
    // from `schemas/product.ts` so writers have one import. Write-path only, and
    // a template could never call it usefully: no render context holds a product
    // (`template-context.ts` has no `product` — templates render orders,
    // invoices and quotes).
    "deriveProductImageUuids",
  ],
  taxes: [
    // Recomputes MONEY at render time. It is `overrideItemTaxesForProfile` plus
    // a `calculateItemPrice` pass, and that second half is the whole difference:
    // the sibling rewrites a tax amount from the line's **stored**
    // `subtotal_discounted_cents`, while this one rebuilds `subtotal_cents` /
    // `subtotal_discounted_cents` / `total_cents` from `base_cents × quantity ×
    // days_factor`. A template that called it could print totals that disagree
    // with the document it is rendering — the same trap named on
    // `calculateTransactionFeeAmountCents` above. It also mutates its argument.
    //
    // That is why the sibling stays emitted and this does not; the line is
    // "recomputes money from base inputs", not "is a write-path helper".
    "materializeDocumentTax",
    // A RESOLVER internal, not a rendering fact. It is the one place the
    // bracket checks read a version's bounds from, exported so `findTaxAt`,
    // `findTaxFor` and api-cloudrun's window guards cannot each grow their own
    // answer to "which field is the bound" — a template asking a tax for its
    // own window should read the fields.
    //
    // ⚠️ This entry said it was a "MIGRATION-WINDOW internal … deleted with the
    // fallback in Phase 2". Phase 2 landed on 2026-08-22 (core#63): the
    // `?? valid_from` fallback and the old field pair are gone, and the
    // function SURVIVED them — pinned by `tests/taxJurisdiction.test.ts`
    // ("reads applied_* and nothing else"). The denylist verdict was right for
    // a reason that has expired; the reason above is the durable one.
    //
    // It also returns an anonymous object type, which the generator can only
    // describe as `typeLiteral`. That is a symptom rather than the reason:
    // naming the type would make it emit cleanly and it would still be an
    // internal.
    "taxAppliedWindow",
  ],
  // 🔴 **Denylisted WHOLE, and for a different reason from everything else in
  // this file.** Every other entry hides a helper that is real domain code
  // aimed at the wrong surface. `utils/citations.ts` is not domain code at all
  // — it is the doc-citation audit's rule set, tooling that no consumer's
  // runtime imports, and it sits under `utils/` only because that is where the
  // namespaced subpaths live (`CLAUDE.md` § Overview records the exception).
  //
  // The generator walks `./utils/*` mechanically and cannot know that, so
  // without this entry it emits `it.citations.classifyCitation` into the
  // template editor's helper panel — offering a document author a function
  // whose arguments are a repo checkout's directory listing.
  //
  // ⚠️ **A namespace-shaped rule would be better than this list, and there
  // isn't one.** The next tooling-only util will leak the same way; what
  // catches it is `tests/template-helpers.test.ts` failing on an export that is
  // neither emitted nor denylisted, which is what caught this one.
  // `utils/template-lint.ts` is the same case as `citations` one namespace over
  // — the fixture lint's rule set, run by CI and the API, reachable by no
  // template. Offering a document author `it.template-lint.lintFixtureSet`
  // would hand them a function whose argument is a repo checkout.
  //
  // ⚠️ This is the THIRD tooling-only util to need a hand-written entry here
  // (`citations`, `templates`' build half, now this), which is the point at
  // which the namespace-shaped rule the note below wishes for stops being
  // hypothetical. Tracked rather than built here.
  "template-lint": [
    "lintFixture",
    "lintFixtureSet",
    "stringLeaves",
  ],
  citations: [
    "classifyCitation",
    "describesDeletion",
    "isHistoryDoc",
    "narrowingSuspects",
    "paragraphAround",
    "preferOwnRepo",
    "resolveSpecifier",
  ],
  // `utils/templates.ts` is mostly build/CI machinery that happens to be pure —
  // path helpers, semver derivation, render-param validation — and only the
  // handful a template body could plausibly call is surfaced.
  templates: [
    // The golden-diff CI rollup. It takes an array of visual-diff verdicts for a
    // template family's fixtures, which is a fact about a release PR, not about
    // the document being rendered — no render context holds one, and a template
    // that could see its own CI status would be rendering the build rather than
    // the order. Shared between api-cloudrun and the manager editor (core#68);
    // neither consumer is a template.
    "aggregateGoldenVerdict",
  ],
  // No `it.dates.*` exports are hidden today.
  dates: [],
};
