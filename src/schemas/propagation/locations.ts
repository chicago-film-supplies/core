/**
 * Location propagation rules — create-location and update-location transactional co-writes.
 *
 * These are in-transaction co-writes (not post-transaction fan-out).
 * Post-transaction fan-out rules for location name cascades live in reference-data.ts.
 *
 * Traced from:
 *   api-cloudrun/src/services/locations.ts
 */
import type { CollectionRule, TransactionDefinition } from "./types.ts";

// ── Create location ─────────────────────────────────────────────

export const createLocationRules: CollectionRule[] = [
  {
    id: "create-location:default-location-to-store",
    source: "locations",
    target: "stores",
    mode: "co-write",
    invariant: "When the first active location is created for a store, it becomes the default and the store's default_location is set so clients don't need a global locations listener",
    transaction: "create-location",
    fields: [
      { source: ["uid"], target: ["default_location", "uid"] },
      { source: ["name"], target: ["default_location", "name"] },
    ],
  },
];

export const createLocationTransaction: TransactionDefinition = {
  id: "create-location",
  description: "Creates a location. If it is the first active location for the store, auto-sets default:true and co-writes default_location to the parent store.",
  steps: [
    "create-location:default-location-to-store",
  ],
};

// ── Update location ─────────────────────────────────────────────

export const updateLocationTransactionalRules: CollectionRule[] = [
  {
    id: "update-location:set-default-to-store",
    source: "locations",
    target: "stores",
    mode: "co-write",
    invariant: "Setting default:true on a location co-writes default_location {uid, name} to the parent store and unsets default on the previous default location",
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
    invariant: "Only one location per store can be default — setting a new default must unset the previous one in the same transaction",
    transaction: "update-location",
    fields: [
      { source: [], target: ["default"], transform: "set false on previous default location (looked up by uid_store + default:true)" },
    ],
  },
];

export const updateLocationTransaction: TransactionDefinition = {
  id: "update-location",
  description: "Updates a location. If default is being set, unsets the previous default location and co-writes default_location to the parent store.",
  steps: [
    "update-location:set-default-to-store",
    "update-location:unset-previous-default",
  ],
};
