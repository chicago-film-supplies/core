/**
 * Supplier document schema — Firestore collection: suppliers
 *
 * Who CFS buys stock FROM. It exists so a `purchase` movement can post a real
 * ACCPAY bill against a real Xero contact instead of the "Inventory
 * Adjustments" placeholder — which is the defect api-cloudrun#727 repaired
 * ($106 of phantom AP against that placeholder) and the reason the movement
 * bill channel currently refuses every `purchase` outright.
 *
 * ## Which precedent this takes, and which it does not
 *
 * - **Shape → `department-type.ts`.** An operator-kept vocabulary of a couple of
 *   dozen rows: `uid` / `name` / `active` / `version` / actors / timestamps,
 *   soft-deleted by `active: false`, created from a bare name. That is this
 *   collection exactly, one field apart.
 * - ⚠️ **NOT `core/src/schemas/chart-of-accounts.ts`**, the other Xero-linked reference table.
 *   That one is a *mirror* — no write API, no write permissions, keyed by a
 *   numeric `code` Xero owns. A supplier is authored in CFS and pushed OUT, so
 *   it needs create/update routes and an `xero_id` CFS writes back.
 * - ⚠️ **NOT `contacts` and NOT `organizations`.** `contacts` are people and
 *   have no Xero representation at all; an `organization.xero_id` is a
 *   *customer* contact on the ACCREC side. A supplier is a third thing, and
 *   pooling it with either would put a payables contact in a receivables field.
 *
 * ## Why it adds `xero_id` when `department-type.ts` explicitly refused one
 *
 * That refusal was reasoned, not reflexive: *"department names are CFS-internal
 * vocabulary with no counterpart in either system"*, and adding an external id
 * speculatively is expensive to undo (writer-stop → corpus-strip → schema-pin,
 * api-cloudrun#443's failure class). The premise is simply false here — a
 * supplier's ONLY purpose is to become a `Contact.ContactID` on an ACCPAY bill,
 * so the counterpart is the reason the collection exists rather than a
 * speculative extra.
 *
 * ## Corpus counts behind the optionality decisions
 *
 * Measured 2026-08-30, BOTH environments:
 *
 * - **`suppliers` holds 0 documents in prod and 0 in dev** — it is new. That is
 *   what makes `xero_id` *required*-nullable rather than optional-nullable:
 *   every document can carry the key from birth, so `missing` is not a bucket
 *   this collection ever has to tolerate. `transactions.xero_id` is
 *   `optional()` for the opposite reason — 1,159 prod / 1,414 dev movements
 *   predate that field, and a required key would reject them on their next
 *   write. `api-cloudrun/scripts/audit-xero-uuid-shapes.ts` encodes exactly this distinction
 *   as its per-field `required_nullable | optional_nullable` target.
 * - **76 prod / 111 dev `purchase` movements** are the population that will
 *   eventually name a supplier. None do today, which is why `Movement.supplier`
 *   is `.nullable().optional()` and this document carries no back-reference.
 *
 * ## What is deliberately absent
 *
 * - **No `name_key`.** `location.ts` stores one because `locations` is large and
 *   its guard is a keyed lookup. The uniqueness guard here is
 *   `api-cloudrun/src/services/departmentTypes.ts`'s instead: an in-transaction range read over
 *   the WHOLE collection, case-folded in the service. At a couple of dozen rows
 *   that is one scan, and it keeps the fold where the comparison happens rather
 *   than adding a derived field that can drift from the name beside it — and it
 *   needs no new `core/src/utils/*` subpath, which is a pin line in three repos.
 *   ⚠️ The guard must be scoped to the whole collection, INACTIVE ROWS
 *   INCLUDED: `api-cloudrun/src/services/locationTypes.ts` scopes its equivalent to
 *   `active == true` and so silently frees a name on deactivation. A supplier
 *   catalogue has the worse version of that — "B&H" and "B&H Photo" resolving to
 *   one Xero contact.
 * - **No `notes` of any kind.** It would escape the PII ratchet:
 *   `core/src/schemas/pii/dictionary.ts` holds `external_notes` / `internal_notes` in
 *   `SENSITIVE_EXACT` and NOT bare `notes`, so the field would ship untagged and
 *   unmasked while the test stayed green. Threads and comments are where an
 *   internal note belongs, which is why `"suppliers"` is added to
 *   `CFS_SOURCE_COLLECTIONS` in the same change — without that enum member a
 *   thread cannot attach to a supplier and the replacement does not exist.
 * - **No `count` of movements.** The same argument `department-type.ts` makes:
 *   an incremental counter maintained by a writer and re-derived by nothing
 *   drifts, and against this many rows the number is derivable on demand.
 * - **No back-reference to movements.** A movement points AT a supplier; the
 *   reverse is a query.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

/** A supplier document in Firestore. */
export interface Supplier {
  uid: string;
  name: string;
  /**
   * Whether this supplier appears in the picker. Soft delete — a deactivated
   * supplier stays resolvable for the movements already naming it.
   *
   * A PRIMARY FACT with no other home, which is the distinction
   * `department-type.ts` draws against the `active` flag `taxes` deleted: there
   * is no window and no usage-based answer to derive it from, and you want to
   * key a supplier in *before* any movement uses it.
   *
   * ⚠️ **Required, and materialized by the WRITER — never `.default(true)`.**
   * A `.default()` never materializes under `validateBeforeWrite`, which writes
   * the RAW document and discards `result.data`, so the stored key would simply
   * be absent. `location-type.ts` has exactly that defect.
   */
  active: boolean;
  /**
   * Xero's `ContactID`.
   *
   * Nullable because an operator may key a supplier before its Xero contact is
   * resolved. The bill push SELF-HEALS a null rather than deferring or failing —
   * it searches Xero by exact `Name`, adopts an existing `ContactID` if one is
   * there, creates one otherwise, and writes the id back here. `issueXeroInvoice`
   * already does exactly this for a missing `organization.xero_id`.
   *
   * ⚠️ **Read from THIS document at push time; never denormalized onto the
   * movement.** A movement is an immutable historical row, so a frozen `null`
   * copied onto it at purchase time could never be healed — while the supplier
   * doc's id is resolved once and then correct for every later push.
   */
  xero_id: string | null;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Supplier. */
export const SupplierSchema: z.ZodType<Supplier> = z.strictObject({
  uid: FirestoreId,
  // 100, not `NameField`'s 255: that one is the PERSON-name field and carries
  // `pii: "mask"`. A supplier is a business.
  //
  // ⚠️ Xero caps a contact `Name` at 50, so this is a boundary MISMATCH, not a
  // schema choice — trim at the wire with `trimXeroName`, do not cap the CFS
  // field. The residual is two suppliers differing only past character 50, and
  // the read-before-create adopt path turns that into a shared contact rather
  // than a 400, which is the right failure.
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  active: z.boolean().meta({ column: true, label: "Active" }),
  xero_id: z.uuid().nullable(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Supplier",
  collection: "suppliers",
  displayDefaults: {
    // NOT `xero_id`: it carries no `column: true`, and naming an undeclared
    // column fails `core/tests/display-columns.test.ts` T8. A raw GUID is a useless column.
    columns: ["name", "active"],
    filters: { active: [true] },
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * Input for creating a supplier.
 *
 * `uid` omitted — the server mints it. `active` omitted — the server
 * materializes `true`, exactly as `createDepartmentType` does; there is no
 * client-supplied initial state for it to get wrong. `xero_id` omitted — it is
 * resolved against Xero and written back, never asserted by a caller.
 */
export interface CreateSupplierInputType {
  name: string;
}
/** Zod schema for CreateSupplierInputType. */
export const CreateSupplierInput: z.ZodType<CreateSupplierInputType> = z.object({
  name: z.string().min(1).max(100),
});

/** Input for updating a supplier — a PATCH, so both fields are optional. */
export interface UpdateSupplierInputType {
  uid: string;
  name?: string;
  active?: boolean;
  version: number;
}
/** Zod schema for UpdateSupplierInputType. */
export const UpdateSupplierInput: z.ZodType<UpdateSupplierInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});

// No DeleteSupplierInput. `DeleteTagInput` is the only one in the package, and
// deactivation here is a PUT setting `active: false` — the same shape
// `department-types`, `location-types` and `taxes` use. `suppliers.delete` is
// still minted as a permission that routes nowhere, matching
// `locationTypes.delete`, so `firestore.rules` has something to name.
