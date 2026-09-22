/**
 * Store propagation rules — the single-default-store cascade, and closing a
 * store closes its locations (`update-store:deactivate-locations`).
 *
 * Setting a store as the default unsets `default` on every OTHER active store,
 * enforcing the "only one default store" invariant. Unlike the reference-data
 * cascades (tags / tracking-categories / location-types), which fan out in a
 * post-transaction batch, this fan-out runs INSIDE the create/update
 * transaction (it is atomic with the store write) and is logged post-commit
 * via logPropagation.
 *
 * Traced from:
 *   api-cloudrun/src/services/stores.ts (createStore, updateStore)
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
} from "./types.ts";

/**
 * The default-flip has both a writer test and a corpus detector, and the
 * detector is the one that matters: "exactly one" is a property of the SET, and
 * a writer test can only ever observe the pair it created.
 */
const ONE_DEFAULT_STORE_TESTED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/stores/stores.test.ts::POST - sets default and cascades to other stores",
  clause:
    "the CREATE writer path — creating a second `default: true` store unsets the first, asserted on BOTH documents. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

/**
 * ⚠️ The PUT path has its own step, and until 2026-08-18 `update-store` cited
 * the CREATE one — a rule pointing at a test that never exercises its writer.
 */
const ONE_DEFAULT_STORE_TESTED_ON_UPDATE: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/stores/stores.test.ts::PUT - cascades default flag to other stores",
  clause:
    "the UPDATE writer path — PUTting `default: true` on a second store unsets the first, asserted on BOTH documents. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const STORE_DEFAULT_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-location-defaults.ts",
  clause:
    "check 1 (`store_default_count`) — per store, exactly one ACTIVE `default: true` location, over the whole corpus. Its rules live in `api-cloudrun/src/lib/locationIntegrity.ts`, shared verbatim with the nightly `/tasks/sweep-location-integrity` job, and are unit-tested at `api-cloudrun/tests/unit/locationIntegrity.test.ts` (zero AND two defaults both reported).",
  gates: true,
};

/**
 * The cascade and its refusal are both writer behaviour, so the tests are
 * what gate them. The detector covers what they cannot see: a store closed
 * around the writer, or a movement into a closed location afterwards.
 */
const CLOSE_STORE_TESTED: EnforcementRef = {
  kind: "test",
  ref:
    "api-cloudrun/tests/integration/stores/stores.test.ts::PUT - deactivating a store closes every location and clears default_location",
  clause:
    "every active location of the store goes `active: false, default: false` in the transaction that closes the store, and `default_location` is null. Its sibling step `PUT - refuses to deactivate a store whose locations hold stock` pins the refusal. Runs in `deno task test` (pre-push), not the hermetic CI gate.",
  gates: true,
};

const CLOSED_STORE_CORPUS: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/scripts/audit-location-defaults.ts",
  clause:
    "check 7 (`inactive_store_live`): an inactive store has no active location and no location holding stock. Checks 1 and 2 skip an inactive store, since their state is the OPEN store's. It shares `api-cloudrun/src/lib/locationIntegrity.ts` with the nightly `/tasks/sweep-location-integrity`.",
  gates: true,
};

const createStoreRules: CollectionRule[] = [
  {
    id: "create-store:unset-sibling-defaults",
    source: "stores",
    target: "stores",
    mode: "fan-out",
    invariant:
      "Only one store can be the default — creating a store with default:true must unset default on every other active store, in the same transaction",
    enforced_by: [ONE_DEFAULT_STORE_TESTED, STORE_DEFAULT_CORPUS],
    trigger:
      "create with default:true — in-transaction fan-out over active stores where default:true",
    fields: [
      {
        source: [],
        target: ["default"],
        transform: "set false on every other active store where default:true",
      },
    ],
  },
];

const updateStoreRules: CollectionRule[] = [
  {
    id: "update-store:unset-sibling-defaults",
    source: "stores",
    target: "stores",
    mode: "fan-out",
    invariant:
      "Only one store can be the default — promoting a store to default:true must unset default on every other active store, in the same transaction",
    enforced_by: [ONE_DEFAULT_STORE_TESTED_ON_UPDATE, STORE_DEFAULT_CORPUS],
    trigger:
      "default flips false→true — in-transaction fan-out over active stores where default:true (excluding self)",
    fields: [
      {
        source: [],
        target: ["default"],
        transform: "set false on every other active store where default:true",
      },
    ],
  },
  {
    id: "update-store:deactivate-locations",
    source: "stores",
    target: "locations",
    mode: "fan-out",
    invariant:
      "A closed store has nothing open and nothing held — deactivating a store deactivates every location it owns and clears `default_location` in the same transaction, and is REFUSED while any of its locations, active or not, holds a non-zero quantity (api-cloudrun#1075, owner 2026-09-22). The cascade replaced a refusal that, composed with the two default-location guards, made a store that owned any location impossible to close",
    enforced_by: [CLOSE_STORE_TESTED, CLOSED_STORE_CORPUS],
    trigger:
      "active flips true→false — in-transaction fan-out over every location where uid_store == this store",
    fields: [
      {
        source: [],
        target: ["active"],
        transform: "set false on every location of this store that is active or flagged default",
      },
      {
        source: [],
        target: ["default"],
        transform: "set false on the same locations, so no closed location still claims the store's default",
      },
    ],
  },
];

// ── Module ──────────────────────────────────────────────────────────
/** Everything `propagation/stores.ts` contributes to the propagation catalog. */
export const stores: PropagationModule = {
  rules: [
    ...createStoreRules,
    ...updateStoreRules,
  ],
  transactions: [],
};
