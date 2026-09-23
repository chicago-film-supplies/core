/**
 * Fulfillment propagation rules — picker-driven edits to fulfillments/{uid}.
 *
 * Picker writes (PUT /fulfillments/{uid}/items, POST /fulfillments/{uid}/reset)
 * mutate only the fulfillment doc itself. They do NOT cascade to bookings,
 * `stock`, or inventory-ledgers — fulfillment is operational only;
 * bookings/stock/ledger track the *promise*, not the *physical pick*. Drift
 * between allocation and physical pick is an out-of-band reconciliation
 * problem, not in scope here.
 *
 * ⚠️ **The two routes are TWO transactions, and this module named only one
 * until api-cloudrun#674.** `POST /reset` borrowed `update-fulfillment-items`
 * — both the transaction id and the rule — and every clause of
 * `update-fulfillment-items:items-self` misdescribes it: reset is a whole-
 * document REPLACE sourced from `orders`, so `source: "fulfillments"` and
 * `mode: "co-write"` are both wrong, and it rewrites seven more fields than
 * that rule's four. **A borrowed transaction id turns the drift check off
 * silently**, because `rules_expected` is read off the transaction the record
 * claims to be.
 *
 * 🔴 **Reset is NOT covered by the last paragraph below either.** That
 * paragraph sends order-sourced projection writes to the order rules, and reset
 * IS an order-sourced projection write — but it is initiated on the
 * FULFILLMENT, by a picker, against a `fulfillment.reset` permission, and no
 * order write is in flight. `update-order:order-to-fulfillment` describes a
 * cascade OUT OF an order write and could not honestly claim it.
 *
 * Order-side projection writes to fulfillments (createOrder / updateOrder /
 * opportunity webhook) live under the order rules — see `update-order:order-to-fulfillment`.
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

/**
 * The positive half — items merged, `version` bumped, a stale version 409s.
 */
const PICKER_WRITE_ATOMIC: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentEdits.test.ts::PUT /items reduces qty + bumps version",
  clause:
    "the `items + version` half — the anchored step lands a quantity reduction and bumps `version`; the sibling step `PUT /items with stale version returns 409` rejects a stale one. The `query_by_*` recompute is not asserted.",
  gates: true,
};

/**
 * 🔴 **This ref asserted the OPPOSITE until the over-checkout change, and the
 * inversion is deliberate.** It named a step called *"picker writes do NOT
 * cascade to bookings/stock"*, which was right while a booking carried ONE
 * quantity: an over-send had nowhere to go, so the correct behaviour was to
 * leave the bookings alone. A booking now carries two numbers — `quantity` is
 * physical, `quantity_ordered` is what the order asked for — so a picker
 * quantity write MUST reach the bookings, or availability keeps answering from
 * the paperwork rather than the shelf.
 *
 * ⚠️ **Still measured on BOOKINGS ONLY.** The step reads neither `stock` nor
 * `inventory-ledgers`, so the ledger third of the claim remains unmeasured —
 * unchanged from before, and stated here so the gap is not re-discovered as a
 * regression.
 */
const PICKER_WRITE_CASCADES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentEdits.test.ts::a picker quantity write cascades to bookings",
  clause:
    "the `cascade` half, for BOOKINGS ONLY — after a picker quantity write the picked product's booking carries the picker's number as `quantity` and the order's as `quantity_ordered`. The booking COUNT is deliberately not asserted equal: the same convergence also retires orphans an earlier non-cascading picker write left behind. Reads neither `stock` nor `inventory-ledgers`.",
  gates: true,
};

// ── The event-card projection, shared by every fulfillment writer ────

/**
 * The fields a fulfillment writes onto its event cards — one list, read by all
 * six `*:fulfillment-to-cards` rules so the six cannot drift.
 *
 * **Event cards are sourced from the FULFILLMENT (owner ruling 2026-09-21).**
 * A card describes what happens on the ground; the order is the quote. So every
 * writer of a fulfillment stages that fulfillment's cards in the SAME
 * transaction, from the document as it will be stored — never from the order.
 * A fulfillment shares its order's id, so the card id
 * (`{uid}:{pair uid}:{start|end}`) did not move.
 *
 * ⚠️ `items` decides which cards EXIST rather than a field on one, so it has no
 * mapping here: a section with no deliverable line emits no `:start` card and
 * one with no returnable line no `:end` card, so a leg the picker emptied loses
 * its card. And the booking gate reads the leg's bookings, not a field.
 */
export const FULFILLMENT_TO_CARDS_FIELDS: CollectionRule["fields"] = [
  {
    source: ["uid"],
    target: ["sources"],
    transform: "[{collection:'fulfillments', uid}] — the fulfillment shares its order's id",
  },
  {
    source: ["status"],
    target: ["status"],
    transform:
      "quoted→draft with `status` added to `locked` (a quote's card is expected work, not queued work); draft/canceled delete every card; reserved/active/complete build cards whose status then rolls up from each LEG's bookings, preserving a manual blocked/canceled",
  },
  {
    source: ["number"],
    target: ["subject"],
    transform: "eventCardSubject(number, subject, action) → '#NUM - <Action> [Subject]'",
  },
  { source: ["subject"], target: ["subject"] },
  { source: ["organization", "uid"], target: ["organization", "uid"] },
  { source: ["organization", "path"], target: ["organization", "path"] },
  {
    source: ["destinations", "delivery"],
    target: ["destination"],
    transform: "the pair's delivery endpoint, for a :start card",
  },
  {
    source: ["destinations", "collection"],
    target: ["destination"],
    transform: "the pair's collection endpoint, for an :end card",
  },
  { source: ["destinations", "dates", "delivery_start"], target: ["dates", "start"] },
  { source: ["destinations", "dates", "delivery_end"], target: ["dates", "end"] },
  { source: ["destinations", "dates", "collection_start"], target: ["dates", "start"] },
  { source: ["destinations", "dates", "collection_end"], target: ["dates", "end"] },
  {
    source: ["destinations", "dates", "delivery_start_fs"],
    target: ["date_fs"],
    transform: "the :start card's sortable Timestamp twin of dates.start",
  },
  {
    source: ["destinations", "dates", "collection_start_fs"],
    target: ["date_fs"],
    transform: "the :end card's sortable Timestamp twin of dates.start",
  },
  {
    source: ["destinations", "customer_collecting"],
    target: ["fulfillments"],
    transform: "{leg:'start', customer_collecting} on a :start card; also picks its list (in-store vs field-service)",
  },
  {
    source: ["destinations", "customer_returning"],
    target: ["fulfillments"],
    transform: "{leg:'end', customer_returning} on an :end card; also picks its list",
  },
];

/**
 * The fulfillment writers' card half — the positive arm: an edit on the
 * fulfillment reaches the pair's cards.
 */
const FULFILLMENT_EDIT_REACHES_CARDS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentDestinations.test.ts::the edit reaches the pair's event cards (api-cloudrun#1097)",
  clause:
    "a picked collection window lands on the `:end` card and the untouched delivery window stays on the `:start` card; sibling steps assert an endpoint override, a repointed delivery and a collect-flag edit reach the cards too.",
  gates: true,
};

// ── update-fulfillment-items ─────────────────────────────────────────

const updateFulfillmentItemsRules: CollectionRule[] = [
  {
    id: "update-fulfillment-items:items-self",
    source: "fulfillments",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "Picker writes mutate items + version + query_by_* on the same doc atomically. " +
      "A QUANTITY or SUBSTITUTION change then converges the order's bookings — " +
      "the picker's number is the booking's PHYSICAL `quantity`, with the order's " +
      "kept in `quantity_ordered` — because availability must reflect the shelf. " +
      "Still no cascade to inventory-ledgers: picker work does not change the " +
      "financial promise, only what is physically out.",
    enforced_by: [PICKER_WRITE_ATOMIC, PICKER_WRITE_CASCADES],
    transaction: "update-fulfillment-items",
    fields: [
      { source: ["items"], target: ["items"] },
      { source: ["version"], target: ["version"], transform: "incremented" },
      {
        source: [],
        target: ["query_by_items"],
        transform: "recomputed from merged items",
      },
      {
        source: [],
        target: ["query_by_contacts"],
        transform: "recomputed from merged items",
      },
    ],
  },
];

const updateFulfillmentItemsTransaction: TransactionDefinition = {
  id: "update-fulfillment-items",
  description:
    "Picker write to a fulfillment's items. Validates against the underlying order " +
    "and Product.alternates[], applies optimistic concurrency via version, and " +
    "writes only the fulfillment doc itself — no cascade.",
  steps: [
    "update-fulfillment-items:items-self",
    "update-fulfillment-items:fulfillment-to-cards",
    // A card the edit makes newly derivable mints its thread in the same
    // transaction, exactly as the order writers do.
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

const updateFulfillmentItemsCardRules: CollectionRule[] = [
  {
    id: "update-fulfillment-items:fulfillment-to-cards",
    source: "fulfillments",
    target: "cards",
    mode: "co-write",
    invariant:
      "A picker's item edit re-derives the fulfillment's event cards in the same transaction — a leg emptied of deliverable lines loses its card",
    enforced_by: [FULFILLMENT_EDIT_REACHES_CARDS],
    transaction: "update-fulfillment-items",
    fields: FULFILLMENT_TO_CARDS_FIELDS,
  },
];

// ── reset-fulfillment ────────────────────────────────────────────────

/**
 * Reset discards picker work and re-projects. The anchored step drives it
 * through the route and asserts the picker's substitution and quantity
 * override are gone and the order's own quantity is back.
 */
const RESET_REBUILDS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentEdits.test.ts::POST /reset clears picker work and re-projects",
  clause:
    "the rebuild half — after a picker substitution and a quantity override, the reset leaves no `substituted_for` line and restores the order's quantity, with `version` strictly greater than before. It does not assert the other six replaced fields.",
  gates: true,
};

const resetFulfillmentRules: CollectionRule[] = [
  {
    id: "reset-fulfillment:rebuild-from-order",
    // 🔴 The SOURCE is `orders`, not `fulfillments`. Reset reads the order and
    // rebuilds the whole document from it (`buildFulfillment(order)`); the
    // existing fulfillment is read only to carry `created_at` forward and to
    // check the caller's `version`. Declaring `fulfillments` here — which is
    // what borrowing `update-fulfillment-items:items-self` did — describes a
    // co-write of a document against itself, and the four fields that rule
    // lists are the ones a PICKER edit touches.
    source: "orders",
    target: "fulfillments",
    // ⚠️ `embed`, NOT `co-write`, and the difference is the one the borrowed
    // rule got wrong. `co-write` means source and target are written in the
    // same transaction; reset only READS the order. The fulfillment takes a
    // snapshot of it and owns that snapshot until the next projection — which
    // is `embed`. Its sibling `create-order:order-to-fulfillment` is correctly
    // `co-write` because the order write is what triggers it.
    mode: "embed",
    invariant:
      "Reset rebuilds the fulfillment wholesale from its order, discarding every " +
      "picker-authored value. `created_at` is carried forward from the stored " +
      "fulfillment and `version` is bumped off it so a concurrent picker session " +
      "409s; everything else is re-derived through the same `buildFulfillment` " +
      "projection the order path uses. No cascade to bookings, `stock`, or " +
      "inventory-ledgers.",
    enforced_by: [RESET_REBUILDS],
    transaction: "reset-fulfillment",
    // ⚠️ Thirteen mappings, against the borrowed rule's four. The list is
    // `buildFulfillment`'s projected literal plus the version bump — which is
    // why `query_by_*` are direct copies off the ORDER here rather than the
    // "recomputed from merged items" the picker-edit rule declares: only the
    // PUT path recomputes them.
    fields: [
      { source: ["uid"], target: ["uid"] },
      { source: ["number"], target: ["number"] },
      { source: ["status"], target: ["status"] },
      { source: ["organization", "uid"], target: ["organization", "uid"] },
      { source: ["organization", "path"], target: ["organization", "path"] },
      {
        source: ["destinations"],
        target: ["destinations"],
        transform: "full DocDestination with per-destination dates + contacts retained",
      },
      {
        source: ["items"],
        target: ["items"],
        transform:
          "strips price, inclusion_type, zero_priced, crms_id; drops transaction_fee items entirely; every picker quantity override and substitution is discarded",
      },
      { source: ["subject"], target: ["subject"] },
      { source: ["reference"], target: ["reference"] },
      { source: ["query_by_items"], target: ["query_by_items"] },
      { source: ["query_by_contacts"], target: ["query_by_contacts"] },
      { source: ["query_by_dates"], target: ["query_by_dates"] },
      {
        source: [],
        target: ["due_at"],
        transform:
          "deriveNextEventDate(order) — the leg-appropriate start (from bookings_breakdown's custody) nearest across destinations; null on a complete/canceled order",
      },
      {
        source: [],
        target: ["due_at_fs"],
        transform: "the Timestamp companion of due_at, from the same winning destination",
      },
      {
        source: [],
        target: ["version"],
        transform: "incremented off the STORED fulfillment, not the order",
      },
    ],
  },
];

const resetFulfillmentTransaction: TransactionDefinition = {
  id: "reset-fulfillment",
  description:
    "Discard every picker-authored value on a fulfillment and rebuild the document " +
    "from its order. Optimistic concurrency via version; writes only the fulfillment " +
    "doc itself — no cascade.",
  steps: [
    "reset-fulfillment:rebuild-from-order",
    "reset-fulfillment:fulfillment-to-cards",
    // A card the edit makes newly derivable mints its thread in the same
    // transaction, exactly as the order writers do.
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── update-fulfillment-destinations ──────────────────────────────────

/**
 * The positive half — a pair field the operator states is stored, and the two
 * `query_by_*` arrays are re-derived from what was stored rather than copied.
 */
const PAIR_EDIT_STORES_AND_DERIVES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentDestinations.test.ts::PUT /destinations stores the window and re-derives query_by_dates",
  clause:
    "the `destinations + version + query_by_dates` half — the anchored step moves a collection window, asserts the stored pair carries it with its `_fs` mirror and recomputed day counts, and asserts `query_by_dates` describes the STORED pair rather than the order's. `query_by_contacts` is asserted only when an endpoint moves, in a sibling step.",
  gates: true,
};

const updateFulfillmentDestinationsRules: CollectionRule[] = [
  {
    id: "update-fulfillment-destinations:pairs-self",
    source: "fulfillments",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "An operator's pair edit writes destinations + version + query_by_dates + " +
      "query_by_contacts on the same doc atomically. The editable fields are DERIVED " +
      "from the order → fulfillment shared-field classification — `propagated` and " +
      "`atom` are writable, `derived` (`dates.*_fs`, `days_active`, `charge_windows[].days`) is " +
      "recomputed and never read from the request — so there is no list to drift. " +
      "Row MEMBERSHIP is not editable: a pair can be corrected, never added or removed.",
    enforced_by: [PAIR_EDIT_STORES_AND_DERIVES],
    transaction: "update-fulfillment-destinations",
    fields: [
      { source: ["destinations"], target: ["destinations"] },
      { source: ["version"], target: ["version"], transform: "incremented" },
      {
        source: [],
        target: ["query_by_dates"],
        transform: "recomputed from the merged destinations",
      },
      {
        source: [],
        target: ["query_by_contacts"],
        transform: "recomputed from the merged destinations",
      },
    ],
  },
];

const resetFulfillmentCardRules: CollectionRule[] = [
  {
    id: "reset-fulfillment:fulfillment-to-cards",
    source: "fulfillments",
    target: "cards",
    mode: "co-write",
    invariant:
      "A reset re-projects the fulfillment from its order, and its event cards follow the re-projection in the same transaction",
    enforced_by: [FULFILLMENT_EDIT_REACHES_CARDS],
    transaction: "reset-fulfillment",
    fields: FULFILLMENT_TO_CARDS_FIELDS,
  },
];

const updateFulfillmentDestinationsCardRules: CollectionRule[] = [
  {
    id: "update-fulfillment-destinations:fulfillment-to-cards",
    source: "fulfillments",
    target: "cards",
    mode: "co-write",
    invariant:
      "An operator's pair edit — a window, an endpoint, a collect flag — reaches that pair's event cards in the same transaction, not through the order echo (api-cloudrun#1097)",
    enforced_by: [FULFILLMENT_EDIT_REACHES_CARDS],
    transaction: "update-fulfillment-destinations",
    fields: FULFILLMENT_TO_CARDS_FIELDS,
  },
];

const updateFulfillmentDestinationsTransaction: TransactionDefinition = {
  id: "update-fulfillment-destinations",
  description:
    "An operator's edit to a fulfillment's destination pair fields — the window it " +
    "was actually picked for, and where it actually went. Optimistic concurrency via " +
    "version; writes only the fulfillment doc itself.\n\n" +
    "🔴 The BOOKINGS that follow are not a step of this transaction. A booking's " +
    "window is built from the fulfillment's EFFECTIVE pair (api-cloudrun#989 item 4), " +
    "and `buildBookingDates` has exactly one author, in `updateOrder`. So this route " +
    "converges them by driving an organization-echo `updateOrder` afterwards, " +
    "best-effort, exactly as the items writer does after a substitution — which fires " +
    "`update-order` and is recorded under that transaction, not this one. If that call " +
    "loses a version race the bookings converge on the next order write instead.\n\n" +
    "⚠️ That convergence has NO `enforced_by` entry here, and the omission is deliberate " +
    "rather than a gap in the catalog: `enforced_by` attaches to a RULE, and the " +
    "convergence is not a step of this transaction. It is asserted by the api-side step " +
    "\"the edit converges the order's bookings onto the new window\" in " +
    "tests/integration/fulfillment/fulfillmentDestinations.test.ts, which covers the " +
    "OUTCOME only — not the accelerator's mechanism, and not the lost-race window above, " +
    "which nothing measures.\n\n" +
    "⚠️ Availability is ADVISORY here, by owner ruling: an edited window that oversells " +
    "is recorded by the rebuild's `stock_oversold` warning, not refused. Every operator " +
    "claim path in `api-cloudrun/src/lib/stockGate.ts` is advisory and only `public-booking` is hard; " +
    "a picker must be able to record where the gear physically is.",
  steps: [
    "update-fulfillment-destinations:pairs-self",
    "update-fulfillment-destinations:fulfillment-to-cards",
    // A card the edit makes newly derivable mints its thread in the same
    // transaction, exactly as the order writers do.
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── create-fulfillment-exchange ──────────────────────────────────────

/**
 * The positive half — one call stages the leg, its divider and its rows, and a
 * second call against the same version is refused.
 *
 * 🔴 **Half a swap is worse than no swap**, which is why this is one route
 * rather than a `PUT /destinations` for the pair and a `PUT /items` for the
 * row: a pair with no row under it derives a trip card with nothing on it, and
 * a row under a pair that does not exist addresses nothing.
 */
const EXCHANGE_LEG_IS_ATOMIC: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/fulfillmentExchanges.test.ts::POST /exchanges stages the leg, its divider and its replacement row",
  clause:
    "the `destinations + items + version` half — the anchored step posts one exchange leg and asserts the stored fulfillment carries the pair (with its `exchange` block and the parent's endpoints), the destination divider keyed on the pair uid, and the replacement row under it carrying `replaces`. The sibling step asserts a stale `version` is a 409.",
  gates: true,
};

const createFulfillmentExchangeRules: CollectionRule[] = [
  {
    id: "create-fulfillment-exchange:leg-self",
    source: "fulfillments",
    target: "fulfillments",
    mode: "co-write",
    invariant:
      "A warehouse-staged mid-rental swap is ONE write: the exchange pair, its " +
      "destination divider and its replacement rows land together, with `version` " +
      "bumped and both `query_by_*` arrays re-derived from what is about to be " +
      "stored. 🔴 This is the ONE writer that adds a destination pair a fulfillment's " +
      "order does not have — `update-fulfillment-destinations` explicitly refuses " +
      "membership changes — and it is admissible only because an exchange leg is a " +
      "fact about what the warehouse DID, which the order never asked for. ⚠️ A swap " +
      "may ALSO be authored on the order (sales staging it, api-cloudrun#1114); that one " +
      "reaches the fulfillment through `update-order`'s projection like any other leg, " +
      "and never through this route.",
    enforced_by: [EXCHANGE_LEG_IS_ATOMIC],
    transaction: "create-fulfillment-exchange",
    fields: [
      { source: ["destinations"], target: ["destinations"], transform: "the exchange pair appended" },
      { source: ["items"], target: ["items"], transform: "the leg's divider and replacement rows appended" },
      { source: ["version"], target: ["version"], transform: "incremented" },
      {
        source: [],
        target: ["query_by_dates"],
        transform: "recomputed from the merged destinations",
      },
      {
        source: [],
        target: ["query_by_contacts"],
        transform: "recomputed from the merged destinations",
      },
    ],
  },
];

const createFulfillmentExchangeCardRules: CollectionRule[] = [
  {
    id: "create-fulfillment-exchange:fulfillment-to-cards",
    source: "fulfillments",
    target: "cards",
    mode: "co-write",
    invariant:
      "The swap's trip card is derived in the same transaction that stages the leg. " +
      "⚠️ A `:start` card ONLY — an exchange leg's units come back on the parent's " +
      "return trip, so `eventCardSlots` mints no `:end` for it and the parent's " +
      "`:end` rolls the leg's bookings in.",
    enforced_by: [EXCHANGE_LEG_IS_ATOMIC],
    transaction: "create-fulfillment-exchange",
    fields: FULFILLMENT_TO_CARDS_FIELDS,
  },
];

const createFulfillmentExchangeTransaction: TransactionDefinition = {
  id: "create-fulfillment-exchange",
  description:
    "Stage a mid-rental SWAP on a fulfillment: a destination pair carrying " +
    "`exchange: { uid_pair, disposition }`, its divider, and the replacement row(s) " +
    "under it naming — through `replaces` — the damaged rows they go out against. " +
    "Optimistic concurrency via `version`; writes the fulfillment doc and its cards.\n\n" +
    "🔴 The BOOKINGS that follow are not a step of this transaction, for exactly the " +
    "reason `update-fulfillment-destinations` records: `buildBookingDates` has one " +
    "author and it is in `updateOrder`. The leg reaches the booking projection as an " +
    "INPUT (`api-cloudrun/src/lib/exchangeLegs.ts`, the api-cloudrun#882 pattern), so " +
    "the next order write creates the replacement's booking whether or not the " +
    "best-effort organization echo this route fires wins its version race.\n\n" +
    "⚠️ The damaged unit X is NOT touched here. For `disposition: \"exchange\"` it moves " +
    "`out → damaged` when the swap's own trip is checked out (the rider in " +
    "`api-cloudrun/src/lib/swapCustody.ts`); for `send_now` the operator marks it at " +
    "check-in, because `mark_damaged` means \"back on a shelf\" and the unit is still " +
    "on set.",
  steps: [
    "create-fulfillment-exchange:leg-self",
    "create-fulfillment-exchange:fulfillment-to-cards",
    // A newly derivable trip card mints its thread in the same transaction.
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── reconcile-fulfillment-cards ──────────────────────────────────────

/**
 * The standalone form of the card half every fulfillment writer runs — for a
 * fulfillment whose cards were stranded by a write that did not reach them.
 */
const RECONCILE_REACHES_CARDS: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/fulfillment/reconcileFulfillmentCards.test.ts::a fulfillment with no cards gets them, and a second run writes nothing",
  clause:
    "a fulfillment whose cards were deleted out of band gets its `:start`/`:end` cards back from one call, and an immediate second call stages no card write.",
  gates: true,
};

const reconcileFulfillmentCardsRules: CollectionRule[] = [
  {
    id: "reconcile-fulfillment-cards:fulfillment-to-cards",
    source: "fulfillments",
    target: "cards",
    mode: "co-write",
    invariant:
      "A fulfillment's event cards can be re-derived from the fulfillment as stored, on demand, with no write to the fulfillment itself (api-cloudrun#1105 #2, #4)",
    enforced_by: [RECONCILE_REACHES_CARDS],
    transaction: "reconcile-fulfillment-cards",
    fields: FULFILLMENT_TO_CARDS_FIELDS,
  },
];

const reconcileFulfillmentCardsTransaction: TransactionDefinition = {
  id: "reconcile-fulfillment-cards",
  description:
    "Re-derive one fulfillment's event cards from the fulfillment as stored, and " +
    "write only the cards (and any thread a newly derivable card mints). The " +
    "fulfillment is read, never written. Called by the repair scripts that write " +
    "fulfillments outside the five card-staging writers, and by api-cloudrun's " +
    "card repair script for a fulfillment whose cards were stranded.",
  steps: [
    "reconcile-fulfillment-cards:fulfillment-to-cards",
    "cowrite-thread:cards-to-thread",
    "cowrite-thread:thread-to-cards",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/fulfillments.ts` contributes to the propagation catalog. */
export const fulfillments: PropagationModule = {
  rules: [
    ...updateFulfillmentItemsRules,
    ...updateFulfillmentItemsCardRules,
    ...updateFulfillmentDestinationsRules,
    ...updateFulfillmentDestinationsCardRules,
    ...createFulfillmentExchangeRules,
    ...createFulfillmentExchangeCardRules,
    ...resetFulfillmentRules,
    ...resetFulfillmentCardRules,
    ...reconcileFulfillmentCardsRules,
  ],
  transactions: [
    updateFulfillmentItemsTransaction,
    updateFulfillmentDestinationsTransaction,
    createFulfillmentExchangeTransaction,
    resetFulfillmentTransaction,
    reconcileFulfillmentCardsTransaction,
  ],
};
