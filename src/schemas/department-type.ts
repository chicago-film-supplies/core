/**
 * DepartmentType document schema — Firestore collection: department-types
 *
 * The user-maintained vocabulary a **department** node of the organization tree
 * names itself from. Departments are a short, stable, industry-standard list
 * (Locations, Office, SFX, Set Dec, Transportation, Construction, Costumes,
 * Production) and normalizing it is what turns `Transportation`/`Transpo` from a
 * permanent data-quality problem into a one-time decision.
 *
 * ⚠️ **A collection, not a `z.enum`.** A new department would otherwise be a
 * schema change, a JSR publish and three pin bumps — which is the cost that
 * guarantees the operator works around it in the `name` string instead, exactly
 * as they already do.
 *
 * ⚠️ **It constrains ONLY the department level.** Projects are production titles
 * and organizations are legal entities; both stay free text with no vocabulary.
 *
 * ## Where each part of this shape comes from
 *
 * No single existing reference is the template, so each concern takes the one
 * that actually matches:
 *
 * - **Document shape → `tracking-category.ts`.** A scalar `uid_*` on the
 *   referencing document plus a denormalized name plus a rename cascade is its
 *   shape and nothing else's in the reference-data family.
 * - **Lifecycle → `holiday-definition.ts`**, which already ships the wanted
 *   semantics: a deactivated record keeps its document and stops appearing in
 *   the picker, `DELETE` is documented as `active: false`, and reads return
 *   active plus soft-deleted.
 * - ⚠️ **NOT `location-type.ts`.** It predates the conventions — it is the only
 *   member of the family with no {@link ActorRefType} and it inlines its
 *   timestamps instead of spreading {@link TimestampFields}. Its 0 prod rows do
 *   not disqualify it (a zero measured on a surface nobody uses is a fact about
 *   the surface, not the domain), but its shape does.
 * - ⚠️ **NOT `chart-of-accounts`.** That is a mirror of the Xero tenant with no
 *   write API and no write permissions, referenced by numeric `code` rather than
 *   by uid — the wrong kind of thing entirely for something operator-maintained.
 *
 * ## What is deliberately absent
 *
 * - **No `count`.** `tags.count` and `tracking-categories.count` are maintained
 *   only by an incremental `± 1` in the products writer, never re-derived, and
 *   audited by nothing — a measured tag carried a correct `count` beside a
 *   `query_by_products` array that had already drifted by one. Against ~9 rows
 *   the number is exactly derivable on demand.
 * - **No `crms_id`, no `xero_id`.** Department names are CFS-internal vocabulary
 *   with no counterpart in either system. Adding one speculatively is expensive
 *   to undo: removing a field from a `z.strictObject` is writer-stop →
 *   corpus-strip → schema-pin, across two repos, in that order
 *   (api-cloudrun#443's failure class). Adding one is a single commit.
 * - **No Typesense config.** ~9 rows; reads go through the generic
 *   `/db/{collection}` surface and an `onSnapshot` store.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { ActorRef, type ActorRefType, type FirestoreTimestampType, TimestampFields } from "./common.ts";

/** A department-type document in Firestore. */
export interface DepartmentType {
  uid: string;
  name: string;
  /**
   * Whether this department appears in the picker. Soft delete — a deactivated
   * type stays resolvable for the nodes already using it.
   *
   * 🔴 **This is a PRIMARY FACT with no other home, which is what distinguishes
   * it from the `active` flag `taxes` deleted.** The rule that deletion
   * establishes is not *"a boolean soft-delete is an anti-pattern"* — it is
   * *a stored flag duplicating a fact some other field already determines will
   * drift from it*. `findTaxFor` selects by `[applied_from, applied_to)` alone,
   * so a tax's `active` recorded what an operator believed and nothing about
   * what got billed, and two prod documents sat `active: true` on a closed
   * window. There is no window here, and no usage-based answer either — you
   * want to add "Costumes" *before* anything uses it — so deleting this field
   * would not remove a duplicate, it would remove the only place the answer
   * lives. Live counter-evidence, all read: `holiday-definitions`, `locations`,
   * `products`, `stores`, `webshop-products`, and `chart-of-accounts`'s
   * mirrored `status`.
   *
   * ⚠️ **`active: false` does NOT free the name.** `location-types` scopes its
   * uniqueness guard to `where("name","==",n).where("active","==",true)`, so
   * deactivating there frees the name for a duplicate — and it made that choice
   * silently. This one's guard is scoped to the WHOLE collection, so a
   * deactivated `Transportation` blocks a second one and forces reactivation.
   * That is the entire point of the vocabulary: the corpus already holds
   * `Transportation` and `Transpo` as one department spelled twice.
   *
   * ⚠️ **Required and materialized by the WRITER, never `.default(true)`.**
   * `location-type.ts` uses `.default(true)` and a `.default()` never
   * materializes under `validateBeforeWrite` — which writes the RAW document and
   * discards `result.data` — so the stored key would simply be absent.
   * `organization.ts` records the identical trap on `tax_exempt`.
   */
  active: boolean;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for DepartmentType. */
export const DepartmentTypeSchema: z.ZodType<DepartmentType> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  active: z.boolean().meta({ column: true, label: "Active" }),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).meta({
  title: "Department Type",
  collection: "department-types",
  displayDefaults: {
    columns: ["name", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input type for creating a department type. */
export interface CreateDepartmentTypeInputType {
  name: string;
}
/** Input schema for creating a department type. */
export const CreateDepartmentTypeInput: z.ZodType<CreateDepartmentTypeInputType> = z.object({
  name: z.string().min(1).max(100),
});

/**
 * Input type for updating a department type.
 *
 * ⚠️ **Deactivation is a `PUT` setting `active: false`, not a `DELETE`** — the
 * shape `holiday-definitions` already documents. There is no delete route, which
 * matches `locationTypes.delete` and `taxes.delete`: both permissions exist and
 * neither routes anywhere.
 */
export interface UpdateDepartmentTypeInputType {
  uid: string;
  name?: string;
  active?: boolean;
  version: number;
}
/** Input schema for updating a department type. */
export const UpdateDepartmentTypeInput: z.ZodType<UpdateDepartmentTypeInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
  version: z.int().min(0),
});
