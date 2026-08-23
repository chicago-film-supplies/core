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
    "checks 1 + 2 — exactly one ACTIVE `default: true` location per store, and `store.default_location` non-null, naming an existing location, in THIS store, flagged default, with a matching `name` denorm. Unit-tested at `api-cloudrun/tests/unit/locationIntegrity.test.ts` (dangling, cross-store, not-default and stale-name each reported separately).",
  gates: true,
};

const LOCATION_DEFAULT_WRITER: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/locations/locations.test.ts::PUT - setting default:true updates store default_location and unsets previous default",
  clause:
    "the writer path and its three refusals — setting `default: true` updates the store pointer and unsets the previous default; deactivating the default 409s; unsetting it is rejected; and `default:false` then `active:false` cannot orphan the pointer (`PUT - default:false then active:false cannot orphan the store pointer`). A rename of the default reaches `store.default_location.name` (`PUT - cascades default location name to store via afterLocationWrite`) and a non-default rename does NOT (`PUT - does NOT cascade non-default location name to store`). Runs in `deno task test` (pre-push), not the hermetic CI gate.",
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
      "When the first active location is created for a store, it becomes the default and the store's default_location is set so clients don't need a global locations listener",
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
    "Creates a location. If it is the first active location for the store, auto-sets default:true and co-writes default_location to the parent store.",
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
      "Setting default:true on a location co-writes default_location {uid, name} to the parent store and unsets default on the previous default location",
    enforced_by: [LOCATION_DEFAULT_WRITER, LOCATION_DEFAULT_POINTER],
    transaction: "update-location",
    fields: [
      { source: ["uid"], target: ["default_location", "uid"] },
      { source: ["name"], target: ["default_location", "name"] },
    ],
  },
  {
    id: "update-location:unset-previous-default",
    source: "locations",
    target: "locations",
    mode: "co-write",
    invariant:
      "Only one location per store can be default — setting a new default must unset the previous one in the same transaction",
    enforced_by: [LOCATION_DEFAULT_WRITER, LOCATION_DEFAULT_POINTER],
    transaction: "update-location",
    fields: [
      {
        source: [],
        target: ["default"],
        transform:
          "set false on previous default location (looked up by uid_store + default:true)",
      },
    ],
  },
];

const updateLocationTransaction: TransactionDefinition = {
  id: "update-location",
  description:
    "Updates a location. If default is being set, unsets the previous default location and co-writes default_location to the parent store.",
  steps: [
    "update-location:set-default-to-store",
    "update-location:unset-previous-default",
  ],
};

// ── Module ──────────────────────────────────────────────────────────
/** Everything `locations.ts` contributes to the propagation catalog. */
export const locations: PropagationModule = {
  rules: [
    ...createLocationRules,
    ...updateLocationTransactionalRules,
  ],
  transactions: [
    createLocationTransaction,
    updateLocationTransaction,
  ],
};
