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
  | "cross-order-return"
  | "cross-order-checkout"
  | "finalize-order"
  | "process-order-docs"
  // out-of-service.ts
  | "create-out-of-service-record"
  | "update-out-of-service-record"
  // transactions.ts
  | "create-transaction"
  | "reverse-transaction"
  // store-transfers.ts
  | "create-store-transfer"
  // products.ts
  | "create-product"
  | "update-product"
  // organizations.ts
  | "create-department-type"
  | "update-department-type"
  // suppliers.ts
  | "create-supplier"
  | "update-supplier"
  | "create-organization"
  | "update-organization"
  // 🔴 **A re-parent gets its OWN id, never a borrowed `update-organization`.**
  // It fires a different rule set — the subtree rewrite plus every name and
  // snapshot rule, once per descendant — so `rules_expected` genuinely differs.
  // Six writers borrowed `update-invoice`, which declares exactly one step, and
  // a borrowed transaction id turns the drift warning off SILENTLY.
  | "reparent-organization"
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
  | "sync-xero-settlement"
  | "void-invoice"
  | "void-invoice-from-crms"
  | "void-invoice-from-xero"
  // credit-notes.ts
  | "create-credit-note"
  | "allocate-credit-note"
  | "void-credit-note"
  // fulfillments.ts
  | "update-fulfillment-items"
  | "reset-fulfillment"
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
  | "delete-card-scope-all"
  // crms-ingest.ts
  | "crms-invoice-upsert"
  | "crms-opportunity-order"
  | "crms-member-organization"
  | "crms-member-contact";

/**
 * Every `CollectionRule.id` in the catalog.
 *
 * A rule id is NOT always prefixed with the transaction that fires it — 19 rules
 * are standalone single-rule cascades with no transaction at all
 * (`update-tax:*`, `holiday-*`, `generate-*-pdf:*`), and several prefixes are
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
  | "create-order:order-to-cards"
  | "create-order:order-to-fulfillment"
  | "update-order:org-to-order"
  | "update-order:order-self-derive"
  | "update-order:order-to-bookings"
  | "update-order:ledger-to-bookings"
  | "update-order:order-to-cards"
  | "update-order:order-to-fulfillment"
  | "update-booking:booking-to-self"
  | "update-booking:booking-to-out-of-service"
  | "update-booking:booking-to-transactions"
  | "update-booking:transactions-to-ledger"
  | "update-booking:transactions-to-locations"
  | "update-booking:booking-to-order"
  | "update-booking:booking-to-cards"
  | "process-order-docs:doc-to-cards"
  // out-of-service.ts
  | "create-out-of-service-record:sources-to-record"
  | "update-out-of-service-record:record-to-transactions"
  | "update-out-of-service-record:transactions-to-ledger"
  // transactions.ts
  | "create-transaction:transaction-to-ledger"
  | "create-transaction:transaction-to-locations"
  | "reverse-transaction:transaction-to-ledger"
  | "reverse-transaction:transaction-to-locations"
  // store-transfers.ts
  | "create-store-transfer:transaction-to-ledger"
  | "create-store-transfer:transaction-to-locations"
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
  | "update-department-type:name-to-departments"
  | "update-org:name-to-orders"
  | "update-org:billing-to-orders"
  | "update-org:name-to-invoices"
  | "update-org:name-to-bookings"
  | "update-org:name-to-fulfillments"
  | "update-org:billing-to-invoices"
  | "update-org:tax-axes-to-orders"
  | "update-org:contacts-change"
  | "update-org:name-to-descendants"
  | "reparent-org:tree-to-descendants"
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
  | "sync-xero-settlement:xero-to-settlements"
  | "sync-xero-settlement:settlements-to-invoice"
  | "void-invoice:reap-settlements"
  | "void-invoice:append-void-settlement"
  | "void-invoice-from-crms:reap-settlements"
  | "void-invoice-from-crms:append-void-settlement"
  | "void-invoice-from-xero:reap-settlements"
  | "void-invoice-from-xero:append-void-settlement"
  // credit-notes.ts
  | "create-credit-note:number-from-counter"
  | "create-credit-note:posting-account"
  | "allocate-credit-note:note-to-settlements"
  | "allocate-credit-note:settlements-to-invoices"
  | "allocate-credit-note:remaining-credit"
  | "void-credit-note:status"
  // fulfillments.ts
  | "update-fulfillment-items:items-self"
  | "reset-fulfillment:rebuild-from-order"
  // taxes.ts
  | "update-tax:to-products"
  | "update-tax:to-webshop-products"
  | "update-tax:to-orders"
  | "supersede-tax:recompute-live-orders"
  | "supersede-tax:recompute-live-invoices"
  // reference-data.ts
  | "update-tag:name-to-products"
  | "delete-tag:remove-from-products"
  | "update-tracking-category:name-to-products"
  | "update-location-type:capacities-to-locations"
  | "update-location:name-to-inventory-ledgers"
  | "update-location:name-to-bookings"
  | "update-location:name-to-out-of-service"
  | "update-location:default-name-to-store"
  | "holiday-definition:materialize-dates"
  | "holiday-dates:rematerialize-snapshot"
  | "holiday-change:recompute-draft-orders"
  | "holiday-change:recompute-draft-invoices"
  // stores.ts
  | "create-store:unset-sibling-defaults"
  | "update-store:unset-sibling-defaults"
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
  // stock.ts
  | "stock:ledger-to-stock"
  | "stock:bookings-to-stock"
  | "stock:oos-to-stock"
  | "stock:seed-ledger-to-stock";
