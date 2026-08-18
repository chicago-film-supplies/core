/**
 * Reference data propagation rules — tag, tracking-category, and location-type cascades.
 *
 * These are post-transaction fan-out operations (batched writes outside the main transaction).
 *
 * Traced from:
 *   api-cloudrun/src/services/tags.ts
 *   api-cloudrun/src/services/trackingCategories.ts
 *   api-cloudrun/src/services/locationTypes.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks the rules below that are not already linked ──────────

const TAG_DELETE_CASCADE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/tags/tags.test.ts::DELETE - cascades removal from products",
  clause:
    "the cascade on delete — the tag's references are removed from the products carrying them. The orphan-ref sweep that would catch a MISSED cascade in the corpus is `audit-data-integrity.ts` sections 4 + 5, which exit 2 on any finding since 2026-08-12. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const LOCATION_TYPE_CAPACITIES: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/location-types/locationTypes.test.ts::PUT - cascades product_capacities to locations using default max",
  clause:
    "both halves, as two tests — the default cascade reaches the type's locations (asserting `locationsUpdated`, `max` and `max_default`), and a location carrying a CUSTOM max keeps it (`PUT - preserves custom max on locations`). The override-preservation half is the one worth having: a cascade that clobbered it would still look like a working cascade.",
  gates: true,
};

const HOLIDAY_SNAPSHOT_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-holidays.ts",
  clause:
    "assertion 1 — `holiday-snapshot/current.materialized_dates` equals the sorted-unique `holiday-dates` set, corpus-wide. It also carries the two properties a snapshot check alone cannot see: horizon proximity (the monthly cron is alive) and past-immutability. Exits non-zero on any failure.",
  gates: true,
};

const HOLIDAY_SNAPSHOT_WRITER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/holidays/holidays.test.ts::snapshot materialized from instances",
  clause:
    "the write-time half — the snapshot is materialized from the instances a holiday create produced",
  gates: true,
};

/**
 * ⚠️ The INVOICE half of the holiday recompute (`holiday-change:recompute-draft-invoices`)
 * is left UNLINKED on purpose. `draftRecompute.test.ts` says in its own header
 * that `copyDoc` strips `query_by_invoices`, so it exercises the order-side
 * recompute in isolation — the invoice sync is the one thing that test cannot
 * reach, and nothing else reaches it either.
 */
const HOLIDAY_DRAFT_RECOMPUTE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/holidays/draftRecompute.test.ts::recomputes a draft order's charge days + item prices",
  clause:
    "the ORDER side and its frozen complement — a draft order's charge days and item prices are recomputed, and a non-draft order comes back byte-unchanged. The invoice-sync half of the same cascade is NOT exercised: the fixture deliberately strips `query_by_invoices`.",
  gates: true,
};

// ── Tag cascades ─────────────────────────────────────────────────

const updateTagRules: CollectionRule[] = [
  {
    id: "update-tag:name-to-products",
    source: "tags",
    target: "products",
    mode: "fan-out",
    invariant:
      "Products embed tag names — a tag rename must cascade to all tagged products",
    trigger:
      "name change — post-transaction two-pass batch (arrayRemove old, arrayUnion new)",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `products←tags` — every products.tags[].name is compared against tags/{uid}.name",
      gates: true,
    }],
    fields: [
      {
        source: ["name"],
        target: ["tags", "name"],
        transform:
          "two-pass idempotent: pass 1 removes {uid, oldName}, pass 2 adds {uid, newName}",
      },
    ],
  },
];

const deleteTagRules: CollectionRule[] = [
  {
    id: "delete-tag:remove-from-products",
    source: "tags",
    target: "products",
    mode: "fan-out",
    invariant:
      "Deleting a tag must clean up all product references to prevent orphan refs",
    enforced_by: [TAG_DELETE_CASCADE],
    trigger: "delete — post-transaction batch",
    fields: [
      { source: ["uid"], target: ["tags"], transform: "arrayRemove tag ref" },
      {
        source: ["uid"],
        target: ["query_by_tags"],
        transform: "arrayRemove tag uid",
      },
    ],
  },
];

// ── Tracking category cascades ───────────────────────────────────

const updateTrackingCategoryRules: CollectionRule[] = [
  {
    id: "update-tracking-category:name-to-products",
    source: "tracking-categories",
    target: "products",
    mode: "fan-out",
    invariant:
      "Products store tracking category name for display — must cascade on rename",
    trigger: "name change — post-transaction batch with existence check",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `products←tracking-categories` — products.tracking_category_name vs tracking-categories/{uid}.name",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["tracking_category_name"] },
    ],
  },
];

// ── Location type cascades ───────────────────────────────────────

const updateLocationTypeRules: CollectionRule[] = [
  {
    id: "update-location-type:capacities-to-locations",
    source: "location-types",
    target: "locations",
    mode: "fan-out",
    invariant:
      "Location-type capacity defaults cascade to all locations of that type — custom overrides are preserved",
    enforced_by: [LOCATION_TYPE_CAPACITIES],
    trigger:
      "product_capacities change — post-transaction batch (chunks of 400)",
    fields: [
      {
        source: ["product_capacities", "max"],
        target: ["product_capacities", "max"],
        transform:
          "only if location cap matches old default; otherwise updates max_default only",
      },
      {
        source: ["product_capacities", "max"],
        target: ["product_capacities", "max_default"],
        transform: "always updated to new type default",
      },
      {
        source: ["product_capacities"],
        target: ["product_capacities"],
        transform: "new products added with type defaults",
      },
    ],
  },
];

// ── Location cascades ───────────────────────────────────────────

const updateLocationRules: CollectionRule[] = [
  {
    id: "update-location:name-to-inventory-ledgers",
    source: "locations",
    target: "inventory-ledgers",
    mode: "fan-out",
    invariant:
      "Inventory ledgers embed location names in store_breakdown — a location rename must cascade to all ledgers containing that location",
    trigger:
      "name change — Eventarc on location write, BulkWriter with lastUpdateTime precondition",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `inventory-ledgers←locations` — every store_breakdown[].locations[].name vs locations/{uid}.name",
      gates: true,
    }],
    fields: [
      {
        source: ["name"],
        target: ["store_breakdown", "locations", "name"],
        transform:
          "updates name where uid_location matches within each store's location array",
      },
    ],
  },
  // No `update-location:name-to-stock` rule, deliberately. Stock
  // summaries used to embed `store_breakdown` (location names and all), so a
  // rename had to fan out across every summary of every product stored at that
  // location — a BulkWriter pass whose only job was to fix a denormalized string.
  // The summary now carries no store placement at all (nothing read it: the
  // manager's per-store panel is still a stub, and it reads inventory-ledgers
  // directly when it lands), so there is no location name on it to rename. The
  // ledger, bookings and OOS records still get the cascade below.
  {
    id: "update-location:name-to-bookings",
    source: "locations",
    target: "bookings",
    mode: "fan-out",
    invariant:
      "Bookings embed location names in stores — a location rename must cascade to all non-complete bookings containing that location",
    trigger:
      "name change — Eventarc on location write, BulkWriter with lastUpdateTime precondition, filtered to status != 'complete'",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `bookings←locations`, applying this rule's own status != complete filter; completed bookings are counted separately and never fail",
      gates: true,
    }],
    fields: [
      {
        source: ["name"],
        target: ["stores", "locations", "name"],
        transform:
          "updates name where uid_location matches within each store's location array",
      },
    ],
  },
  {
    id: "update-location:name-to-out-of-service",
    source: "locations",
    target: "out-of-service",
    mode: "fan-out",
    invariant:
      "Out-of-service records embed location names in stores — a location rename must cascade to every OOS record containing that location, including terminal (complete/canceled) ones, so list views and detail pages stay consistent",
    trigger:
      "name change — Eventarc on location write, BulkWriter with lastUpdateTime precondition",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `out-of-service←locations`, unfiltered by status as this invariant requires. NOT EXERCISED on either env today (2 prod / 8 dev OOS records, none carrying a store)",
      gates: true,
    }],
    fields: [
      {
        source: ["name"],
        target: ["stores", "locations", "name"],
        transform:
          "updates name where uid_location matches within each store's location array",
      },
    ],
  },
  {
    id: "update-location:default-name-to-store",
    source: "locations",
    target: "stores",
    mode: "fan-out",
    invariant:
      "If the default location is renamed, Eventarc cascades the new name to the store's default_location",
    trigger:
      "name change on default location — Eventarc on location write, only if location.default === true",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `stores←locations` — stores.default_location.name vs locations/{uid}.name",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["default_location", "name"] },
    ],
  },
];

// ── Holiday cascades ─────────────────────────────────────────────

const rematerializeHolidaySnapshotRules: CollectionRule[] = [
  {
    id: "holiday-dates:rematerialize-snapshot",
    source: "holiday-dates",
    target: "holiday-snapshot",
    mode: "derive",
    invariant:
      "holiday-snapshot/current is the per-render hot-path read (1 doc + TTL cache); it must be recomputed from the full holiday-dates set on every holiday-dates write so getHolidayDates() never scans the instance collection",
    enforced_by: [HOLIDAY_SNAPSHOT_CORPUS, HOLIDAY_SNAPSHOT_WRITER],
    trigger:
      "holiday definition create/update/soft-delete/regenerate + monthly horizon cron — post-transaction recompute-from-source",
    fields: [
      {
        source: ["date"],
        target: ["materialized_dates"],
        transform:
          "sorted-unique ISO array of every holiday-dates.date; also stamps materialized_count + materialized_year_range",
      },
    ],
  },
];

/**
 * The materialization fan-out — a definition produces its dated instances.
 *
 * Declared for api-cloudrun#503B. It was the one holiday edge with **no rule at
 * all**, and it is the edge that decides whether an order is charged for a day:
 * `getDuration` reads the materialized set, so a definition whose instances were
 * never written silently bills a holiday as a working day. A transaction cannot
 * declare a step it fires until the step exists, so this had to be declared
 * before `materialize-holiday-dates` could be.
 *
 * ⚠️ **There is NO corpus detector for this edge, and that is why the
 * `enforced_by` list is all `test`.** `audit-holidays.ts` checks three things —
 * the snapshot equals the `holiday-dates` set, the horizon is not stale, and past
 * instances survive — and **none of them re-derives instances from the
 * definitions**. So a definition that materialized the wrong dates, or none,
 * passes that audit cleanly: assertion 1 compares the snapshot against whatever
 * `holiday-dates` happens to contain, which is a fixed point over the same
 * possibly-wrong set. Pairing this with a re-derivation is real outstanding work,
 * not a formality — the repo's own rule is that a fixed-point check needs an
 * independent property beside it.
 */
const materializeHolidayDateRules: CollectionRule[] = [
  {
    id: "holiday-definition:materialize-dates",
    source: "holiday-definitions",
    target: "holiday-dates",
    mode: "fan-out",
    invariant:
      "Every active holiday-definition materializes one holiday-dates instance per occurrence across the rolling forward window (current year + 3); a soft-deleted or edited definition refreshes only FUTURE instances and leaves past ones untouched, because a past instance is what a historical order was priced against",
    enforced_by: [
      {
        kind: "test",
        ref:
          "api-cloudrun/tests/integration/holidays/holidays.test.ts::POST /holidays — creates a fixed holiday + forward-window instances",
        clause:
          "create — a fixed definition writes its forward-window instances",
        gates: true,
      },
      {
        kind: "test",
        ref:
          "api-cloudrun/tests/integration/holidays/holidays.test.ts::PUT /holidays/{uid} — version-checked update regenerates future instances",
        clause:
          "update — a version-checked edit REGENERATES future instances onto the new date",
        gates: true,
      },
      {
        kind: "test",
        ref:
          "api-cloudrun/tests/integration/holidays/holidays.test.ts::immutable past — regenerate keeps past instances, refreshes future",
        clause:
          "immutable past — regenerate keeps past instances and refreshes only future ones. NOT covered corpus-wide: see this block's note.",
        gates: true,
      },
    ],
    trigger:
      "holiday definition create/update/soft-delete/regenerate, plus the monthly extend-holiday-horizon cron which advances the window without touching existing instances",
    fields: [
      {
        // ⚠️ This was ONE mapping carrying six sources and three targets, and
        // most of the names were not fields of either document: there is no
        // `rule`, `month`, `weekday` or `occurrence` on a HolidayDefinition (they
        // are `js_month`/`display_month`, `date`, `day`, `week`), and the
        // instance's back-reference is **`uid_holiday`, not `uid_definition`** —
        // so a reader following this declaration looked for a field that has
        // never existed. Split per target, with the real names (#568).
        source: [],
        target: ["date"],
        transform:
          "expanded, not copied: the fixed rule (`js_month` + `date`) or the variable rule (`js_month` + `day` + `week`) is projected across the rolling forward window, one instance per occurrence. `active: false` materializes none — see the invariant.",
      },
      {
        source: ["uid"],
        target: ["uid_holiday"],
        transform: "the instance's back-reference to its definition",
      },
      { source: ["name"], target: ["name"] },
      {
        source: ["type"],
        target: ["type"],
        transform: "fixed | variable, carried onto the instance",
      },
    ],
  },
];

// ── The three holiday-definition writers ────────────────────────────

/**
 * `create` / `update` / `delete` of a holiday definition, declared for
 * api-cloudrun#503B. Each writes **two** collections — the definition and its
 * `holiday-dates` instances — inside one transaction, and each emitted no
 * propagation record at all.
 *
 * All three declare the **same single step**, and that is the point rather than
 * a shortcut: {@link materializeHolidayDateRules} describes one edge, and what
 * separates the three transactions is which *direction* they push it. A create
 * materializes the forward window; an update replaces the future half of it in
 * place; a soft delete empties it. The definition write itself is the source
 * document, not a propagation, so it is not a step.
 *
 * ⚠️ **`regenerate-holiday-dates` and `extend-holiday-horizon` are NOT declared
 * here, and the discriminator is the collection count, not the verb.** Both
 * write `holiday-dates` alone — they read the definition and never write it —
 * so each is a single-rule cascade that logs itself through
 * `logPropagation("holiday-definition:materialize-dates")` and expects no
 * transaction record. Adding a `TransactionDefinition` for either would declare
 * an atomic multi-collection operation that does not exist.
 *
 * ⚠️ **What none of these can carry is the recompute.** The draft-order and
 * draft-invoice recomputes below are enqueued POST-commit as a coalesced Cloud
 * Task, so they are not steps of any of these transactions — a step is
 * something the transaction's own commit either did or did not do. That is why
 * `holiday-change:recompute-draft-orders` has no `transaction` field.
 */
const createHolidayDefinitionTransaction: TransactionDefinition = {
  id: "create-holiday-definition",
  description:
    "Creates a holiday definition (fixed date or variable nth-weekday rule) and materializes its instances across the rolling forward window in the same commit, so a definition can never exist without the dates it implies. The snapshot rematerialize and the draft recompute follow post-commit.",
  steps: ["holiday-definition:materialize-dates"],
};

const updateHolidayDefinitionTransaction: TransactionDefinition = {
  id: "update-holiday-definition",
  description:
    "Version-checked in-place edit of a holiday rule. Full-replaces the definition document (so a fixed↔variable switch drops the stale variant fields) and regenerates only FUTURE instances — past ones are what historical orders were priced against and stay untouched.",
  steps: ["holiday-definition:materialize-dates"],
};

const deleteHolidayDefinitionTransaction: TransactionDefinition = {
  id: "delete-holiday-definition",
  description:
    "Soft-deletes a holiday definition — marks it inactive rather than removing it, keeping the record for historical fidelity — and deletes only its FUTURE instances, so past holidays stay materialized.",
  steps: ["holiday-definition:materialize-dates"],
};

const recomputeHolidayDraftOrderRules: CollectionRule[] = [
  {
    id: "holiday-change:recompute-draft-orders",
    source: "holiday-definitions",
    target: "orders",
    mode: "fan-out",
    invariant:
      "A draft order is not committed, so a holiday change must re-run its destination date/duration math (durations drive prices/totals); finalized (non-draft) orders stay frozen for historical fidelity",
    enforced_by: [HOLIDAY_DRAFT_RECOMPUTE],
    trigger:
      "holiday definition create/update/soft-delete/regenerate — coalesced Cloud Task, status == 'draft' only (the monthly horizon cron does NOT enqueue — its far-future additions don't affect current drafts)",
    fields: [
      {
        source: [],
        target: ["destinations", "dates"],
        transform:
          "re-run canonicalizeDestinationDates → getDuration with the new holiday set, then syncChargeDaysToItems + recompute totals",
      },
    ],
  },
];

const recomputeHolidayDraftInvoiceRules: CollectionRule[] = [
  {
    id: "holiday-change:recompute-draft-invoices",
    source: "orders",
    target: "invoices",
    mode: "fan-out",
    invariant:
      "A recomputed draft order must re-sync its draft invoices' chargeable_days/prices; terminal invoices (any unreversed settlement, or status in {paid, void}) stay frozen",
    trigger:
      "draft-order recompute — transitive via updateOrder's existing draft-invoice sync (projectOrderItemToInvoiceItem inherits the recomputed durations)",
    fields: [
      // ⚠️ One segment short on both sides until 2026-08-17 — `chargeable_days`
      // lives under the item's `price`, on the order and on the invoice alike.
      // The same shape as the `enforced_by` drift the campaign measured: a ref
      // that names the right thing and stops just above it.
      {
        source: ["items", "price", "chargeable_days"],
        target: ["items", "price", "chargeable_days"],
        transform:
          "inherited via projectOrderItemToInvoiceItem; draft invoices only — terminal ones skipped",
      },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `reference-data.ts` contributes to the propagation catalog. */
export const referenceData: PropagationModule = {
  rules: [
    ...updateTagRules,
    ...deleteTagRules,
    ...updateTrackingCategoryRules,
    ...updateLocationTypeRules,
    ...updateLocationRules,
    ...materializeHolidayDateRules,
    ...rematerializeHolidaySnapshotRules,
    ...recomputeHolidayDraftOrderRules,
    ...recomputeHolidayDraftInvoiceRules,
  ],
  transactions: [
    createHolidayDefinitionTransaction,
    updateHolidayDefinitionTransaction,
    deleteHolidayDefinitionTransaction,
  ],
};
