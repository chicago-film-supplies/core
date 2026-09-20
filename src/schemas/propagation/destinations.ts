/**
 * Destination propagation — the property → unit tree, and the ONE denorm a
 * re-parent has to carry with it.
 *
 * 🔴 **The tree lives on `destinations` and cascades into NO document
 * snapshot**, which is what makes it cheap where the organization tree is
 * expensive. `api-cloudrun/scripts/merge-destinations.ts` states the principle the whole destinations
 * campaign was decided on: *"snapshot on the DOCUMENT, derive on the MASTER"* —
 * rewriting a frozen address would erase, from completed history, the fact that
 * a delivery went to Stage 25 rather than to the campus gate. An order, an
 * invoice, a fulfillment and a booking all store an address SNAPSHOT plus a uid,
 * and a re-parent moves neither.
 *
 * Traced from: api-cloudrun/src/services/destinations.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

const DESTINATION_REPARENT: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/destinations/reparent.test.ts",
  clause:
    "hanging a unit under a property writes `path`, `query_by_path` and `address.street2` from `computeDestinationNode` alone; returning it to the root removes line 2; a rename of the property reaches every unit's `path[0].name` AND `address.name`; and a second level under a unit is refused.",
  gates: true,
};

const reparentRule: CollectionRule = {
  id: "reparent-destination:tree-to-node",
  source: "destinations",
  target: "destinations",
  // `derive`, not `fan-out`: all three fields are COMPUTED onto the node itself
  // from its resolved parent, in the same write. Nothing is pushed anywhere.
  mode: "derive",
  invariant:
    "Hanging a destination under a property rewrites `path`, `query_by_path` and `address.street2` on THAT NODE, recomputed through `computeDestinationNode` rather than patched. ⚠️ **It fans out to nothing, and the bound is structural rather than lucky**: the tree is two levels, so a re-parented node has no descendants of its own to rewrite — `.max(2)` is what makes this rule one-to-one where the organization equivalent is a subtree walk. 🔴 **No SNAPSHOT moves.** Orders, invoices, fulfillments and bookings carry a frozen address plus a uid, and both keep saying what they said: the uid still names the same document, and the address still records where the truck actually went.",
  enforced_by: [DESTINATION_REPARENT],
  transaction: "reparent-destination",
  fields: [
    { source: ["path"], target: ["path"] },
    { source: ["path"], target: ["query_by_path"] },
    { source: ["path"], target: ["address", "street2"] },
  ],
};

const renameRule: CollectionRule = {
  id: "reparent-destination:place-name-to-units",
  source: "destinations",
  target: "destinations",
  mode: "fan-out",
  invariant:
    "A unit's `path[0].name` AND its `address.name` are both denorms of its PROPERTY's place name — the same value stored twice on purpose, which is what lets the schema check the denorm from ONE document instead of by a fan-out. So renaming a property rewrites both fields on every unit under it. ⚠️ **Bounded and small** (the largest property in the corpus has 12 members), but it is a real cascade and the audit's cross-document arm is what proves it landed: `api-cloudrun/scripts/audit-destination-tree.ts` compares each unit's `path[0].name` against its property's live `address.name`. ⚠️ A unit's own former `address.name` is frequently a TENANCY — six of the twelve Cinespace rows named a production rather than a place — and it is deliberately DROPPED here rather than preserved: it goes stale the moment the production wraps, and it survives on every document snapshot that recorded it.",
  enforced_by: [DESTINATION_REPARENT],
  transaction: "reparent-destination",
  fields: [
    { source: ["address", "name"], target: ["path"] },
    { source: ["address", "name"], target: ["address", "name"] },
  ],
};

const reparentTransaction: TransactionDefinition = {
  id: "reparent-destination",
  description:
    "Hangs a destination under a property, or returns it to the root. 🔴 **The ONLY route that writes a destination's tree** — every other destination write is a side effect of an order (the address-book dedupe in `findOrCreateDestination`, which always mints a 1-level root). A property node is created when a SECOND unit needs one and never in anticipation, which is why this verb exists rather than a create/update pair: the operator's action is 'this address is a stage of that lot', not 'make a property'.",
  steps: ["reparent-destination:tree-to-node", "reparent-destination:place-name-to-units"],
};

/** Everything `propagation/destinations.ts` contributes to the catalog. */
export const destinations: PropagationModule = {
  rules: [reparentRule, renameRule],
  transactions: [reparentTransaction],
};
