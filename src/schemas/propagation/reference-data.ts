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
import type { CollectionRule, EnforcementRef } from "./types.ts";

// ── What checks the rules below that are not already linked ──────────

const TAG_DELETE_CASCADE: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/tags/tags.test.ts:335",
  clause:
    "the cascade on delete — the tag's references are removed from the products carrying them. The orphan-ref sweep that would catch a MISSED cascade in the corpus is `audit-data-integrity.ts` sections 4 + 5, which always exits 0. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const LOCATION_TYPE_CAPACITIES: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/location-types/locationTypes.test.ts:301",
  clause:
    "both halves, as two tests — the default cascade reaches the type's locations (asserting `locationsUpdated`, `max` and `max_default`), and a location carrying a CUSTOM max keeps it (:341). The override-preservation half is the one worth having: a cascade that clobbered it would still look like a working cascade.",
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
  ref: "api-cloudrun/tests/integration/holidays/holidays.test.ts:84",
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
  ref: "api-cloudrun/tests/integration/holidays/draftRecompute.test.ts:22",
  clause:
    "the ORDER side and its frozen complement — a draft order's charge days and item prices are recomputed, and a non-draft order comes back byte-unchanged. The invoice-sync half of the same cascade is NOT exercised: the fixture deliberately strips `query_by_invoices`.",
  gates: true,
};

// ── Tag cascades ─────────────────────────────────────────────────

export const updateTagRules: CollectionRule[] = [
  {
    id: "update-tag:name-to-products",
    source: "tags",
    target: "products",
    mode: "fan-out",
    invariant: "Products embed tag names — a tag rename must cascade to all tagged products",
    trigger: "name change — post-transaction two-pass batch (arrayRemove old, arrayUnion new)",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `products←tags` — every products.tags[].name is compared against tags/{uid}.name",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["tags", "name"], transform: "two-pass idempotent: pass 1 removes {uid, oldName}, pass 2 adds {uid, newName}" },
    ],
  },
];

export const deleteTagRules: CollectionRule[] = [
  {
    id: "delete-tag:remove-from-products",
    source: "tags",
    target: "products",
    mode: "fan-out",
    invariant: "Deleting a tag must clean up all product references to prevent orphan refs",
    enforced_by: [TAG_DELETE_CASCADE],
    trigger: "delete — post-transaction batch",
    fields: [
      { source: ["uid"], target: ["tags"], transform: "arrayRemove tag ref" },
      { source: ["uid"], target: ["query_by_tags"], transform: "arrayRemove tag uid" },
    ],
  },
];

// ── Tracking category cascades ───────────────────────────────────

export const updateTrackingCategoryRules: CollectionRule[] = [
  {
    id: "update-tracking-category:name-to-products",
    source: "tracking-categories",
    target: "products",
    mode: "fan-out",
    invariant: "Products store tracking category name for display — must cascade on rename",
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

export const updateLocationTypeRules: CollectionRule[] = [
  {
    id: "update-location-type:capacities-to-locations",
    source: "location-types",
    target: "locations",
    mode: "fan-out",
    invariant: "Location-type capacity defaults cascade to all locations of that type — custom overrides are preserved",
    enforced_by: [LOCATION_TYPE_CAPACITIES],
    trigger: "product_capacities change — post-transaction batch (chunks of 400)",
    fields: [
      { source: ["product_capacities", "max"], target: ["product_capacities", "max"], transform: "only if location cap matches old default; otherwise updates max_default only" },
      { source: ["product_capacities", "max"], target: ["product_capacities", "max_default"], transform: "always updated to new type default" },
      { source: ["product_capacities"], target: ["product_capacities"], transform: "new products added with type defaults" },
    ],
  },
];

// ── Location cascades ───────────────────────────────────────────

export const updateLocationRules: CollectionRule[] = [
  {
    id: "update-location:name-to-inventory-ledgers",
    source: "locations",
    target: "inventory-ledgers",
    mode: "fan-out",
    invariant: "Inventory ledgers embed location names in store_breakdown — a location rename must cascade to all ledgers containing that location",
    trigger: "name change — Eventarc on location write, BulkWriter with lastUpdateTime precondition",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `inventory-ledgers←locations` — every store_breakdown[].locations[].name vs locations/{uid}.name",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["store_breakdown", "locations", "name"], transform: "updates name where uid_location matches within each store's location array" },
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
    invariant: "Bookings embed location names in stores — a location rename must cascade to all non-complete bookings containing that location",
    trigger: "name change — Eventarc on location write, BulkWriter with lastUpdateTime precondition, filtered to status != 'complete'",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `bookings←locations`, applying this rule's own status != complete filter; completed bookings are counted separately and never fail",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["stores", "locations", "name"], transform: "updates name where uid_location matches within each store's location array" },
    ],
  },
  {
    id: "update-location:name-to-out-of-service",
    source: "locations",
    target: "out-of-service",
    mode: "fan-out",
    invariant: "Out-of-service records embed location names in stores — a location rename must cascade to every OOS record containing that location, including terminal (complete/canceled) ones, so list views and detail pages stay consistent",
    trigger: "name change — Eventarc on location write, BulkWriter with lastUpdateTime precondition",
    enforced_by: [{
      kind: "audit",
      ref: "api-cloudrun/scripts/audit-denorm-freshness.ts",
      clause:
        "row `out-of-service←locations`, unfiltered by status as this invariant requires. NOT EXERCISED on either env today (2 prod / 8 dev OOS records, none carrying a store)",
      gates: true,
    }],
    fields: [
      { source: ["name"], target: ["stores", "locations", "name"], transform: "updates name where uid_location matches within each store's location array" },
    ],
  },
  {
    id: "update-location:default-name-to-store",
    source: "locations",
    target: "stores",
    mode: "fan-out",
    invariant: "If the default location is renamed, Eventarc cascades the new name to the store's default_location",
    trigger: "name change on default location — Eventarc on location write, only if location.default === true",
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

export const rematerializeHolidaySnapshotRules: CollectionRule[] = [
  {
    id: "holiday-dates:rematerialize-snapshot",
    source: "holiday-dates",
    target: "holiday-snapshot",
    mode: "derive",
    invariant: "holiday-snapshot/current is the per-render hot-path read (1 doc + TTL cache); it must be recomputed from the full holiday-dates set on every holiday-dates write so getHolidayDates() never scans the instance collection",
    enforced_by: [HOLIDAY_SNAPSHOT_CORPUS, HOLIDAY_SNAPSHOT_WRITER],
    trigger: "holiday definition create/update/soft-delete/regenerate + monthly horizon cron — post-transaction recompute-from-source",
    fields: [
      { source: ["date"], target: ["materialized_dates"], transform: "sorted-unique ISO array of every holiday-dates.date; also stamps materialized_count + materialized_year_range" },
    ],
  },
];

export const recomputeHolidayDraftOrderRules: CollectionRule[] = [
  {
    id: "holiday-change:recompute-draft-orders",
    source: "holiday-definitions",
    target: "orders",
    mode: "fan-out",
    invariant: "A draft order is not committed, so a holiday change must re-run its destination date/duration math (durations drive prices/totals); finalized (non-draft) orders stay frozen for historical fidelity",
    enforced_by: [HOLIDAY_DRAFT_RECOMPUTE],
    trigger: "holiday definition create/update/soft-delete/regenerate — coalesced Cloud Task, status == 'draft' only (the monthly horizon cron does NOT enqueue — its far-future additions don't affect current drafts)",
    fields: [
      { source: [], target: ["destinations", "dates"], transform: "re-run canonicalizeDestinationDates → getDuration with the new holiday set, then syncChargeDaysToItems + recompute totals" },
    ],
  },
];

export const recomputeHolidayDraftInvoiceRules: CollectionRule[] = [
  {
    id: "holiday-change:recompute-draft-invoices",
    source: "orders",
    target: "invoices",
    mode: "fan-out",
    invariant: "A recomputed draft order must re-sync its draft invoices' chargeable_days/prices; terminal invoices (any unreversed settlement, or status in {paid, void}) stay frozen",
    trigger: "draft-order recompute — transitive via updateOrder's existing draft-invoice sync (projectOrderItemToInvoiceItem inherits the recomputed durations)",
    fields: [
      { source: ["items", "chargeable_days"], target: ["items", "chargeable_days"], transform: "inherited via projectOrderItemToInvoiceItem; draft invoices only — terminal ones skipped" },
    ],
  },
];
