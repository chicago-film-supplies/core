/**
 * The catalog's two id namespaces, as string-literal unions.
 *
 * These exist so that a rule id or a transaction id written anywhere — in a
 * `steps[]` array here, in a `rules_fired[]` array in api-cloudrun, in a call to
 * `logPropagation` — is checked by the compiler instead of by a regex.
 *
 * ## Why this is a hand-written union and not derived from the catalog
 *
 * It cannot be derived, and that is a property of the publish boundary rather
 * than a missed trick. JSR's `no-slow-types` requires every public export to
 * carry an explicit annotation, so `propagation/mod.ts` must declare
 * `export const rules: CollectionRule[]` — which erases every literal id at the
 * module boundary. The published declaration confirms it:
 * `_dist/src/schemas/propagation/mod.d.ts` emits exactly that line, and no
 * per-module `.d.ts` is emitted at all. Anything inferred from the arrays is
 * therefore `string` by the time a consumer sees it, whatever is done upstream.
 *
 * ## Why not an `as const` array with the union derived from it
 *
 * Because the array would then have to be exported to be usable in a public
 * type, and JSR's *syntactic* declaration emitter mis-emits `as const` arrays —
 * core#43 published `declare const ITEM_TYPES: readonly ["order"]` for a
 * nine-member array, and core#44 is still open on a second live instance. See
 * `propagation/types.ts`'s `EnforcementRef` docstring for the full account. A union type is
 * emitted verbatim and has no such failure mode.
 *
 * ## What keeps it honest
 *
 * ⚠️ **A declaration needs a population assertion beside it.** This file is a
 * list, and a list drifts — so `tests/propagation.test.ts` reads this file's own
 * source, extracts the quoted literals of each union, and asserts **set
 * equality** against the folded catalog. It fails in BOTH directions: a rule
 * declared with an id missing from here, and an id here that no rule declares.
 * The compile-time half (`CollectionRule.id: RuleId`) only covers the first.
 *
 * The comment headers name the file that OWNS each id — a rule id belongs to the
 * file that declares it, and the same prefix legitimately appears under two
 * files (`update-order:*` is declared in both `propagation/orders.ts` and
 * `propagation/invoices.ts`, `cowrite-thread:*` in both
 * `propagation/threads.ts` and `propagation/cards.ts`).
 */

/**
 * Every `TransactionDefinition.id` in the catalog.
 *
 * ⚠️ Disjoint from {@link RuleId} — verified, and asserted in
 * `tests/propagation.test.ts`. The two namespaces are told apart by their type
 * now, not by the shape of the call that consumes them.
 */
export type TransactionId =
  // orders.ts
  | "create-order"
  | "update-order"
  | "update-booking"
  | "bulk-checkout-order"
  | "bulk-return-order"
  | "bulk-fulfillment-bookings"
  | "cross-order-bookings"
  | "finalize-order"
  // out-of-service.ts
  | "create-out-of-service-record"
  | "update-out-of-service-record"
  | "reclassify-out-of-service-record"
  // transactions.ts
  | "create-transaction"
  | "reverse-transaction"
  | "reclass-stock"
  // purchases.ts
  | "create-purchase"
  | "update-purchase"
  | "close-purchase"
  | "receive-purchase"
  | "reverse-purchase-receipt"
  | "create-purchase-bill"
  | "settle-purchase-bill"
  | "void-purchase-bill-from-xero"
  | "create-purchase-credit"
  | "allocate-purchase-credit"
  | "settle-purchase-credit"
  | "void-purchase-credit"
  | "void-purchase-credit-from-xero"
  // store-transfers.ts
  | "create-store-transfer"
  // units.ts
  | "create-units"
  | "update-unit"
  // products.ts
  | "create-product"
  | "update-product"
  // organizations.ts
  | "create-department-type"
  | "update-department-type"
  // suppliers.ts
  | "create-supplier"
  | "update-supplier"
  // destinations.ts — the ONE route that writes a destination's tree. Every
  // other destination write is a side effect of an order.
  | "reparent-destination"
  | "create-organization"
  | "update-organization"
  // 🔴 **A re-parent gets its OWN id, never a borrowed `update-organization`.**
  // It fires a different rule set — the subtree rewrite plus every name and
  // snapshot rule, once per descendant — so `rules_expected` genuinely differs.
  // Six writers borrowed `update-invoice`, which declares exactly one step, and
  // a borrowed transaction id turns the drift warning off SILENTLY.
  | "reparent-organization"
  // The Eventarc `activity_at` stamper (api-cloudrun#979) — its OWN id, never a
  // borrowed `update-organization`: a stamp must not read as a rename.
  | "organization-activity-stamp"
  // A re-parent that COLLIDES merges the moved node into the one already there
  // (api-cloudrun#1153) — its own id: it repoints every reference to the loser
  // and deletes it, which no other organization transaction does.
  | "merge-organization"
  // contacts.ts
  | "create-contact"
  | "update-contact"
  // users.ts
  | "create-user"
  | "update-user"
  | "delete-user"
  // invoices.ts
  | "create-invoice"
  | "update-invoice"
  // settlements.ts
  | "create-settlement"
  | "reverse-settlement"
  | "close-invoice"
  | "sync-xero-settlement"
  | "void-invoice"
  | "void-invoice-from-xero"
  | "void-invoice-from-cancel"
  // credit-notes.ts
  | "create-credit-note"
  | "allocate-credit-note"
  | "void-credit-note"
  | "record-credit-note-refund"
  | "sync-xero-credit-note-refunds"
  | "reverse-credit-note-refund"
  // fulfillments.ts
  | "update-fulfillment-items"
  | "update-fulfillment-destinations"
  | "create-fulfillment-exchange"
  | "reset-fulfillment"
  | "reconcile-fulfillment-cards"
  // taxes.ts
  | "create-tax-code"
  | "update-tax-code"
  | "create-tax-rate"
  | "update-tax-rate"
  | "create-tax-class"
  | "update-tax-class"
  // reference-data.ts
  | "create-holiday-definition"
  | "update-holiday-definition"
  | "delete-holiday-definition"
  // locations.ts
  | "create-location"
  | "update-location"
  // threads.ts
  | "create-role"
  | "create-comment"
  | "delete-comment"
  // cards.ts
  | "create-card"
  | "delete-card"
  // templates.ts
  | "create-template"
  | "manage-draft"
  | "publish-template"
  // recurrences.ts
  | "create-recurrence"
  | "materialize-horizon"
  | "update-recurrence"
  | "delete-recurrence"
  | "update-card-scope-following"
  | "update-card-scope-all"
  | "delete-card-scope-this"
  | "delete-card-scope-following"
  | "delete-card-scope-all";

/**
 * Every `CollectionRule.id` in the catalog.
 *
 * A rule id is NOT always prefixed with the transaction that fires it — many rules
 * are standalone single-rule cascades with no transaction at all
 * (`update-tax-class:*`, `holiday-*`, `generate-*-pdf:*`), and several prefixes are
 * deliberately shorter than the transaction name (`create-org:*` under
 * `create-organization`). Read the prefix as a namespace, never as a join key.
 */
export type RuleId =
  // orders.ts
  | "create-order:org-to-order"
  | "create-order:products-to-order-items"
  | "create-order:order-self-derive"
  | "create-order:order-to-bookings"
  | "create-order:ledger-to-bookings"
  | "create-order:fulfillment-to-cards"
  | "create-order:order-to-fulfillment"
  | "update-order:org-to-order"
  | "update-order:order-self-derive"
  | "update-order:order-to-bookings"
  | "update-order:ledger-to-bookings"
  | "update-order:fulfillment-to-cards"
  | "update-order:order-to-fulfillment"
  | "update-booking:booking-to-self"
  | "update-booking:booking-to-out-of-service"
  | "update-booking:booking-to-transactions"
  | "update-booking:transactions-to-ledger"
  | "update-booking:transactions-to-locations"
  | "update-booking:booking-to-order"
  | "update-booking:booking-to-cards"
  // purchases.ts
  | "receive-purchase:receipt-to-purchase"
  | "reverse-purchase-receipt:receipt-to-purchase"
  | "create-purchase-bill:bill-to-purchase"
  | "create-purchase-bill:bill-to-settlements"
  | "settle-purchase-bill:xero-to-settlements"
  | "settle-purchase-bill:settlements-to-bill"
  | "void-purchase-bill-from-xero:void-to-settlements"
  | "void-purchase-bill-from-xero:settlements-to-bill"
  | "void-purchase-bill-from-xero:bill-to-purchase"
  | "settle-purchase-bill:settlements-to-credit"
  | "void-purchase-bill-from-xero:settlements-to-credit"
  | "create-purchase-credit:credit-to-purchase"
  | "allocate-purchase-credit:credit-to-settlements"
  | "allocate-purchase-credit:settlements-to-bill"
  | "allocate-purchase-credit:settlements-to-credit"
  | "close-purchase:excess-to-credit"
  | "settle-purchase-credit:xero-to-settlements"
  | "settle-purchase-credit:settlements-to-credit"
  | "void-purchase-credit:credit-to-purchase"
  | "void-purchase-credit-from-xero:void-to-settlements"
  | "void-purchase-credit-from-xero:settlements-to-bill"
  | "void-purchase-credit-from-xero:settlements-to-credit"
  | "void-purchase-credit-from-xero:credit-to-purchase"
  // out-of-service.ts
  | "create-out-of-service-record:sources-to-record"
  | "create-out-of-service-record:record-to-transactions"
  | "create-out-of-service-record:transactions-to-ledger"
  | "update-out-of-service-record:record-to-transactions"
  | "update-out-of-service-record:record-to-record"
  | "update-out-of-service-record:transactions-to-ledger"
  | "reclassify-out-of-service-record:record-to-booking"
  | "reclassify-out-of-service-record:record-to-record"
  // transactions.ts
  | "create-transaction:transaction-to-ledger"
  | "create-transaction:transaction-to-locations"
  | "reverse-transaction:transaction-to-ledger"
  | "reverse-transaction:transaction-to-locations"
  | "reclass-stock:transaction-to-ledger"
  | "reclass-stock:transaction-to-locations"
  // store-transfers.ts
  | "create-store-transfer:transaction-to-ledger"
  | "create-store-transfer:transaction-to-locations"
  | "create-store-transfer:transaction-to-out-of-service"
  // products.ts
  | "create-product:product-to-tags"
  | "create-product:product-to-tracking-categories"
  | "create-product:product-to-components"
  | "create-product:product-to-ledger"
  | "create-product:product-to-opening-movement"
  | "create-product:product-to-webshop"
  | "update-product:catalog-to-components"
  | "update-product:components-to-components"
  | "update-product:component-entry-to-parents"
  | "update-product:name-to-locations"
  | "update-product:name-to-tags"
  | "update-product:name-to-tracking-categories"
  | "update-product:to-webshop"
  | "update-product:tags-to-tags"
  | "update-product:tracking-category-change"
  | "update-product:stock-method-change"
  | "update-product:type-change"
  | "update-product:price-to-components"
  | "update-product:price-to-webshop-components"
  | "update-product:product-to-draft-orders"
  // organizations.ts
  | "create-org:org-to-contacts"
  | "create-org:node-to-tree"
  | "create-org:mint-derived-project"
  | "merge-org:loser-to-orders"
  | "merge-org:loser-to-invoices"
  | "merge-org:loser-to-credit-notes"
  | "merge-org:loser-to-settlements"
  | "merge-org:loser-to-bookings"
  | "merge-org:loser-to-fulfillments"
  | "merge-org:loser-to-cards"
  | "merge-org:loser-to-out-of-service"
  | "merge-org:loser-to-contacts"
  | "merge-org:activity-to-survivor"
  | "merge-org:merged-from-to-survivor"
  | "merge-org:delete-loser"
  | "merge-org:tombstone-loser"
  | "merge-org:merged-to-to-tombstones"
  | "merge-org:tombstone-parent"
  | "merge-org:thread-comments-to-survivor"
  | "update-department-type:name-to-departments"
  | "update-org:name-to-orders"
  | "update-org:billing-to-orders"
  | "update-org:name-to-invoices"
  | "update-org:name-to-bookings"
  | "update-org:name-to-fulfillments"
  | "update-org:name-to-cards"
  | "update-org:billing-to-invoices"
  | "update-org:tax-axes-to-orders"
  | "update-org:contacts-change"
  | "update-org:name-to-descendants"
  | "reparent-destination:tree-to-node"
  | "reparent-destination:place-name-to-units"
  | "reparent-org:tree-to-descendants"
  | "reparent-org:activity-to-new-ancestors"
  | "stamp-org-activity:orders-to-organizations"
  | "stamp-org-activity:invoices-to-organizations"
  // contacts.ts
  | "create-contact:contact-to-orgs"
  | "create-contact:link-to-user"
  | "update-contact:name-to-orgs"
  | "update-contact:name-to-orders"
  | "update-contact:phones-to-orders"
  | "update-contact:orgs-change"
  | "update-contact:name-to-user"
  // users.ts
  | "create-user:link-to-contact"
  | "update-user:name-to-contact"
  | "update-user:name-to-actor-refs"
  | "delete-user:unlink-contact"
  // invoices.ts
  | "create-invoice:invoice-to-orders"
  | "update-invoice:status-to-orders"
  | "update-order:items-to-invoices"
  | "update-order:status-to-invoices"
  // settlements.ts
  | "create-settlement:settlement-to-invoice"
  | "reverse-settlement:reverser-to-invoice"
  | "reverse-settlement:release-to-credit-note"
  | "close-invoice:closure-to-invoice"
  | "sync-xero-settlement:xero-to-settlements"
  | "sync-xero-settlement:settlements-to-invoice"
  | "void-invoice:reap-settlements"
  | "void-invoice:append-void-settlement"
  | "void-invoice-from-xero:reap-settlements"
  | "void-invoice-from-xero:append-void-settlement"
  | "void-invoice-from-cancel:reap-settlements"
  | "void-invoice-from-cancel:append-void-settlement"
  // credit-notes.ts
  | "create-credit-note:number-from-counter"
  | "create-credit-note:posting-account"
  | "allocate-credit-note:note-to-settlements"
  | "allocate-credit-note:settlements-to-invoices"
  | "allocate-credit-note:remaining-credit"
  | "void-credit-note:status"
  | "record-credit-note-refund:refund-to-settlements"
  | "record-credit-note-refund:settlements-to-credit-note"
  | "sync-xero-credit-note-refunds:xero-to-settlements"
  | "sync-xero-credit-note-refunds:settlements-to-credit-note"
  | "reverse-credit-note-refund:reverser-to-settlements"
  | "reverse-credit-note-refund:settlements-to-credit-note"
  // fulfillments.ts
  | "update-fulfillment-items:items-self"
  | "update-fulfillment-items:fulfillment-to-cards"
  | "update-fulfillment-destinations:pairs-self"
  | "update-fulfillment-destinations:fulfillment-to-cards"
  | "create-fulfillment-exchange:leg-self"
  | "create-fulfillment-exchange:fulfillment-to-cards"
  | "reset-fulfillment:rebuild-from-order"
  | "reset-fulfillment:fulfillment-to-cards"
  | "reconcile-fulfillment-cards:fulfillment-to-cards"
  // taxes.ts
  | "create-tax-rate:recompute-live-orders"
  | "create-tax-rate:recompute-live-invoices"
  | "update-tax-class:name-to-products"
  | "update-tax-class:name-to-webshop-products"
  | "update-tax-class:codes-recompute-live-orders"
  | "update-tax-class:codes-recompute-live-invoices"
  | "update-product:tax-class-to-live-orders"
  | "update-product:tax-class-to-components"
  | "update-product:tax-class-to-webshop-components"
  // reference-data.ts
  | "update-tag:name-to-products"
  | "delete-tag:remove-from-products"
  | "update-tracking-category:name-to-products"
  | "update-location-type:capacities-to-locations"
  | "update-location:name-to-inventory-ledgers"
  | "update-location:name-to-bookings"
  | "update-location:name-to-out-of-service"
  | "update-location:name-to-transactions"
  | "update-location:default-name-to-store"
  | "holiday-definition:materialize-dates"
  | "holiday-dates:rematerialize-snapshot"
  | "holiday-change:recompute-draft-orders"
  | "holiday-change:recompute-draft-invoices"
  // stores.ts
  | "create-store:unset-sibling-defaults"
  | "update-store:unset-sibling-defaults"
  | "update-store:deactivate-locations"
  // locations.ts
  | "create-location:default-location-to-store"
  | "update-location:set-default-to-store"
  | "update-location:unset-previous-default"
  // threads.ts
  | "cowrite-thread:orders-to-thread"
  | "cowrite-thread:thread-to-orders"
  | "cowrite-thread:invoices-to-thread"
  | "cowrite-thread:thread-to-invoices"
  | "cowrite-thread:contacts-to-thread"
  | "cowrite-thread:thread-to-contacts"
  | "cowrite-thread:organizations-to-thread"
  | "cowrite-thread:thread-to-organizations"
  | "cowrite-thread:products-to-thread"
  | "cowrite-thread:thread-to-products"
  | "cowrite-thread:roles-to-thread"
  | "cowrite-thread:thread-to-roles"
  | "cowrite-thread:out-of-service-to-thread"
  | "cowrite-thread:thread-to-out-of-service"
  | "cowrite-thread:credit-notes-to-thread"
  | "cowrite-thread:thread-to-credit-notes"
  | "cowrite-thread:purchases-to-thread"
  | "cowrite-thread:thread-to-purchases"
  | "cowrite-thread:purchase-bills-to-thread"
  | "cowrite-thread:thread-to-purchase-bills"
  | "cowrite-thread:purchase-credits-to-thread"
  | "cowrite-thread:thread-to-purchase-credits"
  | "create-comment:thread-to-comment"
  | "create-comment:comment-to-thread"
  | "delete-comment:comment-to-thread"
  // cards.ts
  | "cowrite-thread:cards-to-thread"
  | "cowrite-thread:thread-to-cards"
  | "delete-card:cascade-thread"
  | "delete-card:cascade-comments"
  // templates.ts
  | "create-template:thread"
  | "create-template:thread-to-family"
  | "manage-draft:family-rollup"
  | "manage-draft:component-family-rollup"
  | "manage-draft:version-to-thread"
  | "manage-draft:thread-to-version"
  | "publish-template:seq"
  | "publish-template:version-flip"
  | "publish-template:family-rollup"
  | "publish-template:component-family-rollup"
  // recurrences.ts
  | "create-recurrence:fan-out-cards"
  | "materialize-horizon:fan-out-cards"
  | "update-recurrence:fan-out-prototype"
  | "update-recurrence:rematerialize-future"
  | "delete-recurrence:fan-out-cards"
  | "update-card-scope-following:cascade-future-siblings"
  | "update-card-scope-all:update-recurrence-prototype"
  | "update-card-scope-all:cascade-siblings"
  | "delete-card-scope-this:append-exception-date"
  | "delete-card-scope-following:cascade-future-siblings"
  | "delete-card-scope-following:truncate-recurrence"
  | "delete-card-scope-all:cascade-siblings"
  | "delete-card-scope-all:delete-recurrence"
  // uploadcare.ts
  | "generate-invoice-pdf:upload-to-worklist"
  | "generate-quote-pdf:upload-to-worklist"
  | "generate-statement-pdf:upload-to-worklist"
  // stock.ts
  | "stock:ledger-to-stock"
  | "stock:bookings-to-stock"
  | "stock:oos-to-stock"
  | "stock:seed-ledger-to-stock"
  // units.ts
  | "units:transactions-to-roster"
  | "units:transactions-to-units"
  | "units:product-to-roster"
  | "units:product-to-units"
  | "units:product-to-bookings"
  | "units:product-to-out-of-service"
  | "create-units:product-to-units";
