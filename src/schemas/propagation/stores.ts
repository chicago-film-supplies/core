/**
 * Store propagation rules — the single-default-store cascade.
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
import type { CollectionRule } from "./types.ts";

export const createStoreRules: CollectionRule[] = [
  {
    id: "create-store:unset-sibling-defaults",
    source: "stores",
    target: "stores",
    mode: "fan-out",
    invariant:
      "Only one store can be the default — creating a store with default:true must unset default on every other active store, in the same transaction",
    trigger: "create with default:true — in-transaction fan-out over active stores where default:true",
    fields: [
      { source: [], target: ["default"], transform: "set false on every other active store where default:true" },
    ],
  },
];

export const updateStoreRules: CollectionRule[] = [
  {
    id: "update-store:unset-sibling-defaults",
    source: "stores",
    target: "stores",
    mode: "fan-out",
    invariant:
      "Only one store can be the default — promoting a store to default:true must unset default on every other active store, in the same transaction",
    trigger: "default flips false→true — in-transaction fan-out over active stores where default:true (excluding self)",
    fields: [
      { source: [], target: ["default"], transform: "set false on every other active store where default:true" },
    ],
  },
];
