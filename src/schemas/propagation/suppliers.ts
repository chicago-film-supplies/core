/**
 * Supplier propagation — a documented NO-RULE, and the refusal is the content.
 *
 * `Movement.supplier` is a denormalized `{uid, name}`, which is exactly the
 * shape `update-tag:name-to-products` and
 * `update-department-type:name-to-departments` exist for. So the absence of a
 * rename cascade here is a decision, not an omission, and a silent absence is
 * not a refusal — hence this file, following the way
 * `propagation/department-types.ts` records that create propagates nothing.
 *
 * 🔴 **A supplier rename must NOT reach the movements naming it.** A movement is
 * an immutable historical record: the supplier name *at the time of purchase* is
 * the fact it holds, and rewriting it on a later rename would falsify history —
 * the opposite of what a cascade does for a live order, where the denorm is a
 * cache of a currently-true fact.
 *
 * The closest precedent agrees in spirit rather than by accident: the
 * organization-name cascade (`liveOrgSnapshotScans`) deliberately scopes itself
 * to NOT-YET-SETTLED documents, and every movement is settled by nature.
 *
 * ⚠️ **Purchases, purchase bills and supplier credits keep the snapshot too —
 * and for them the "settled history" argument only half applies.** Their
 * `supplier` is the same point-in-time `{uid, name}` (`schemas/purchase.ts`),
 * and the writers assert every bill and receipt equals the purchase's copy, so
 * rewriting one document alone would break that invariant. A CLOSED purchase is
 * settled history like a movement. An ACTIVE one is the not-yet-settled case
 * the org-name cascade DOES update, and since api-cloudrun#1220 indexed all
 * three collections in Typesense, a rename leaves the old name searchable on
 * open purchases. Today that is accepted: a rename changes nothing already
 * written. Whether to scope an `update-supplier:name-to-purchases` cascade to
 * `status: "active"` (and carry its bills and credits with it) is an owner
 * question filed as its own issue, not a gap in this file.
 *
 * ⚠️ **If this is ever reversed**, the rule is `update-supplier:name-to-movements`,
 * and it needs its id in `propagation/ids.ts` — `core/tests/propagation.test.ts`
 * asserts set equality in BOTH directions — plus an `enforced_by` ref in
 * `<repo>/<path>::<anchor>` form, never `path:N`.
 *
 * ⚠️ **The Xero push needs no rule either, and that is a different question with
 * the same answer.** A bill reads the supplier's `xero_id` from the supplier
 * DOCUMENT at push time rather than from a copy on the movement, so nothing
 * downstream holds a stale one to be repaired.
 *
 * Traced from: api-cloudrun/src/services/suppliers.ts
 */
import type { PropagationModule, TransactionDefinition } from "./types.ts";

const createSupplierTransaction: TransactionDefinition = {
  id: "create-supplier",
  description:
    "Creates one supplier. Propagates NOTHING — a new supplier has no movements yet, which is exactly why it is worth being able to key one in before anything buys from it. The name is unique across the WHOLE collection, deactivated rows included, so a deactivated \"B&H\" blocks a second one and forces reactivation rather than letting \"B&H\" and \"B&H Photo\" both resolve to one Xero contact. The Xero `ContactID` is NOT resolved here: it is self-healed on the first bill push, so keying a supplier costs no Xero quota.",
  steps: [],
};

const updateSupplierTransaction: TransactionDefinition = {
  id: "update-supplier",
  description:
    "Renames, deactivates or reactivates a supplier. Propagates NOTHING, deliberately — see this module's header: `Movement.supplier.name` is point-in-time and a rename must not reach it. Deactivation is this route rather than a DELETE, so a deactivated supplier stays resolvable for the movements already naming it and only leaves the picker. ⚠️ `active: false` does NOT free the name.",
  steps: [],
};

/** Everything `propagation/suppliers.ts` contributes to the catalog. */
export const suppliers: PropagationModule = {
  rules: [],
  transactions: [createSupplierTransaction, updateSupplierTransaction],
};
