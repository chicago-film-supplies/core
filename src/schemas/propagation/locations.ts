/**
 * Location propagation rules — create-location and update-location transactional co-writes.
 *
 * These are in-transaction co-writes (not post-transaction fan-out).
 * Post-transaction fan-out rules for location name cascades live in reference-data.ts.
 *
 * Traced from:
 *   api-cloudrun/src/services/locations.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

// ── What checks these rules ─────────────────────────────────────────
//
// The store-pointer invariant is the one place in this workspace where the
// writer test and the corpus detector are genuinely complementary: the test
// proves the flip happens, and the detector proves the SET property ("exactly
// one active default, and the store points at it") that no single write can
// establish. The detector's rules live in `api-cloudrun/src/lib/locationIntegrity.ts` and are
// shared verbatim with the nightly sweep, so the script and the job cannot
// drift.

const LOCATION_DEFAULT_POINTER: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-location-defaults.ts",
  clause:
    "check 2 — `store.default_location` is non-null and names an existing, ACTIVE, `staging` location in THIS store, with a matching `name` denorm. The pointer is the one source of truth; no location carries a copy of it (api-cloudrun#1302 phase 5). Unit-tested at `api-cloudrun/tests/unit/locationIntegrity.test.ts` (dangling, cross-store, inactive and stale-name each reported separately).",
  gates: true,
};

const LOCATION_DEFAULT_WRITER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/locations/locations.test.ts::PUT - setting default:true moves the store default_location",
  clause:
    "the writer path and its refusals — `default: true` on a staging location moves the store pointer to it, and writes no flag on any location; deactivating the pointer's target 409s; `default: false` is rejected; and `default:false` then `active:false` cannot orphan the pointer (`PUT - default:false then active:false cannot orphan the store pointer`). A rename of the pointer's target reaches `store.default_location.name` (`PUT - cascades default location name to store via afterLocationWrite`) and any other rename does NOT (`PUT - does NOT cascade non-default location name to store`). Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const FIRST_LOCATION_IS_DEFAULT: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/locations/locations.test.ts::POST - second location for same store is not default",
  clause:
    "the first-location clause, from its complement — a SECOND location for the same store is not default, which is what makes the first one's default meaningful",
  gates: true,
};

// ── Create location ─────────────────────────────────────────────

const createLocationRules: CollectionRule[] = [
  {
    id: "create-location:default-location-to-store",
    source: "locations",
    target: "stores",
    mode: "co-write",
    invariant:
      "When a staging location is created for a store whose default_location is null, the store's default_location is set to it, so clients don't need a global locations listener",
    enforced_by: [FIRST_LOCATION_IS_DEFAULT, LOCATION_DEFAULT_POINTER],
    transaction: "create-location",
    fields: [
      { source: ["uid"], target: ["default_location", "uid"] },
      { source: ["name"], target: ["default_location", "name"] },
    ],
  },
];

const createLocationTransaction: TransactionDefinition = {
  id: "create-location",
  description:
    "Creates a location. If it is a staging location and the store has no default_location yet, co-writes default_location to the parent store.",
  steps: [
    "create-location:default-location-to-store",
  ],
};

// ── Update location ─────────────────────────────────────────────

const updateLocationTransactionalRules: CollectionRule[] = [
  {
    id: "update-location:set-default-to-store",
    source: "locations",
    target: "stores",
    mode: "co-write",
    invariant:
      "Setting default:true on a staging location co-writes default_location {uid, name} to the parent store; renaming the location the pointer names co-writes the new name. No location document carries a copy of the pointer.",
    enforced_by: [LOCATION_DEFAULT_WRITER, LOCATION_DEFAULT_POINTER],
    transaction: "update-location",
    fields: [
      { source: ["uid"], target: ["default_location", "uid"] },
      { source: ["name"], target: ["default_location", "name"] },
    ],
  },
];

const updateLocationTransaction: TransactionDefinition = {
  id: "update-location",
  description:
    "Updates a location. If default is being set (a command — the location stores no flag), co-writes default_location to the parent store.",
  steps: [
    "update-location:set-default-to-store",
  ],
};

// ── Product default storage locations ───────────────────────────

const PRODUCT_DEFAULT_WRITER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/locations/locationProductDefault.test.ts::setting a product's default MOVES it: the other location at the store is cleared",
  clause:
    "setting a product's default at one storage location clears it on that product's other locations at the same store, in the same transaction, and the placement cascade re-stamps the ledger copy",
  gates: true,
};

const PRODUCT_DEFAULT_COUNT: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-product-defaults.ts",
  clause:
    "`several_defaults` — a product flagged default on more than one location at one store FAILS the audit; the same rule (`product_default_count`) runs in the nightly location-integrity sweep",
  gates: true,
};

/**
 * Set or clear one product's default-storage flag (api-cloudrun#1302 §2,
 * ruling 4). **A product has exactly ONE default storage location per store**
 * (ruling 11, corrected by the owner 2026-10-13), so a set MOVES the flag: the
 * product's other locations at that store are cleared in the same transaction.
 * The ledger's per-product copy is refreshed by the Eventarc placement cascade
 * (`update-location:placement-to-inventory-ledgers`), not by a step here — so
 * this transaction never meets the ledger writer's group commit.
 */
const setLocationProductDefaultRules: CollectionRule[] = [
  {
    id: "set-location-product-default:clear-sibling-defaults",
    source: "locations",
    target: "locations",
    mode: "co-write",
    invariant:
      "A product has exactly one default storage location per store — setting it on one location clears it on the product's other locations at that store in the same transaction",
    enforced_by: [PRODUCT_DEFAULT_WRITER, PRODUCT_DEFAULT_COUNT],
    transaction: "set-location-product-default",
    fields: [
      {
        source: [],
        target: ["products", "default"],
        transform:
          "set false on the product's entry at every other location in the store (looked up by uid_store + query_by_products array-contains)",
      },
    ],
  },
];

const setLocationProductDefaultTransaction: TransactionDefinition = {
  id: "set-location-product-default",
  description:
    "Sets or clears one product's default-storage flag (`products[].default`) at one storage location. A product has exactly one per store, so a set clears it on the product's other locations at that store. Its ledgers are re-stamped post-commit by the location write's placement cascade.",
  steps: ["set-location-product-default:clear-sibling-defaults"],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/locations.ts` contributes to the propagation catalog. */
export const locations: PropagationModule = {
  rules: [
    ...createLocationRules,
    ...updateLocationTransactionalRules,
    ...setLocationProductDefaultRules,
  ],
  transactions: [
    createLocationTransaction,
    updateLocationTransaction,
    setLocationProductDefaultTransaction,
  ],
};
