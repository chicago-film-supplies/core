/**
 * Department-type propagation — the rename cascade onto the department nodes
 * that name themselves from this vocabulary.
 *
 * Traced from: api-cloudrun/src/services/departmentTypes.ts
 */
import type {
  CollectionRule,
  EnforcementRef,
  PropagationModule,
  TransactionDefinition,
} from "./types.ts";

const DEPARTMENT_TYPE_RENAME: EnforcementRef = {
  kind: "test",
  ref: "api-cloudrun/tests/integration/organizations/departmentTypes.test.ts",
  clause:
    "a catalog rename reaching `path.at(-1).name` on every department node holding the type, and from there through the ORDINARY organization rename — contacts, OPEN orders and UNPAID invoices converge, terminal documents stay frozen.",
  gates: true,
};

const createDepartmentTypeTransaction: TransactionDefinition = {
  id: "create-department-type",
  description:
    "Creates one term in the department vocabulary. Propagates NOTHING — a new term has no population yet, which is exactly why it is worth being able to add one before anything uses it. The name is unique across the WHOLE collection, deactivated entries included, so a deactivated `Transportation` blocks a second one and forces reactivation.",
  steps: [],
};

const renameRule: CollectionRule = {
  id: "update-department-type:name-to-departments",
  source: "department-types",
  target: "organizations",
  mode: "fan-out",
  invariant:
    "A department node's `path.at(-1).name` is a DENORM of its catalog entry's name, which is why the node stores `uid_department_type` as a REF and not just a matching string — a rename has to be able to FIND its population. Bounded by construction: a department is a LEAF, so its name appears in no other node's `path`. ⚠️ Each affected node is then an ordinary organization rename, so the `update-org:name-to-*` rules take over unchanged rather than being reimplemented here — and note the multiplier, since one term used across five productions is five organization renames and their open orders.",
  enforced_by: [DEPARTMENT_TYPE_RENAME],
  transaction: "update-department-type",
  fields: [
    { source: ["name"], target: ["path"] },
  ],
};

const updateDepartmentTypeTransaction: TransactionDefinition = {
  id: "update-department-type",
  description:
    "Renames, deactivates or reactivates a department type. Deactivation is this route rather than a DELETE — a deactivated type stays resolvable for the nodes already using it and just leaves the picker. ⚠️ `active: false` does NOT free the name.",
  steps: ["update-department-type:name-to-departments"],
};

/** Everything `propagation/department-types.ts` contributes to the catalog. */
export const departmentTypes: PropagationModule = {
  rules: [renameRule],
  transactions: [createDepartmentTypeTransaction, updateDepartmentTypeTransaction],
};
