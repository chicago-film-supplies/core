/**
 * TaxClass document schema — Firestore collection: taxes-classes
 *
 * **What a product IS for tax purposes** — the D365 "item sales tax group", the
 * SAP material tax classification, the NetSuite item tax schedule. A class lists
 * tax CODES; the line's resolved jurisdiction picks among them, because every
 * code carries its own jurisdiction. api-cloudrun#993.
 *
 * ```
 * codes = class.uid_tax_codes
 * rates = for each code where code.jurisdiction === line jurisdiction:
 *           its taxes-rates version whose window contains asOf
 * ```
 *
 * So "Sale – Bottled Water" can list Chicago Sales, Chicago Bottled Water,
 * Frankfort Sales and Rantoul Sales, and a Frankfort line still gets only
 * Frankfort Sales — there is no second per-jurisdiction list to keep in sync.
 *
 * ## One class per product, no union (owner, 2026-09-13)
 *
 * A combination is a NAMED class. The trade is explicitness: every product's
 * tax set reads off one row of the class × jurisdiction matrix. Multiple
 * classes per product is the documented escape hatch if combinations ever
 * multiply — not per-code criteria.
 *
 * ## `uid_tax_codes: []` is a STATED fact
 *
 * "Non-Taxable" is a class with no codes, the same way `Tax.item_types: []` was
 * a stated "no types": an omitted list would make "nobody decided" and "decided:
 * none" the same document. It also retires the `No Tax` row and the
 * `taxed_as: "none"` enum member, which both said this.
 *
 * ## What validates across documents lives in `utils/taxes.ts`
 *
 * `validateTaxSetup` — at most one live percent rate per class × jurisdiction ×
 * instant, every referenced code exists and is active, and each product type is
 * the default on at most one active class. A single document cannot see any of
 * those.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  ProductTypeEnum,
  type ProductTypeType,
  TimestampFields,
} from "./common.ts";

/** A tax class document in Firestore. */
export interface TaxClass {
  uid: string;
  /** Title Case, e.g. "Sale – Bottled Water". Unique across the whole collection. */
  name: string;
  description: string | null;
  /** The `taxes-codes` this class draws from. `[]` = non-taxable, stated. */
  uid_tax_codes: string[];
  /**
   * The product types a NEW product of which is preselected into this class.
   * A create-time default only — it never re-classes an existing product.
   *
   * Replaces a settings map: no settings collection exists, and a map keyed on
   * product type would be a second document to keep consistent with this one.
   */
  is_default_for: ProductTypeType[];
  /** Whether a product can be assigned this class. Writer-stated, never defaulted. */
  active: boolean;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** A repeated code or product type is a list that means a set, written wrong. */
function checkClassSets(
  doc: { uid_tax_codes: string[]; is_default_for: ProductTypeType[] },
  ctx: z.RefinementCtx,
): void {
  for (const key of ["uid_tax_codes", "is_default_for"] as const) {
    const values: readonly string[] = doc[key];
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        ctx.addIssue({ code: "custom", path: [key, index], message: `${key} repeats ${value}.` });
      }
      seen.add(value);
    });
  }
}

/** Zod schema for TaxClass. */
export const TaxClassSchema: z.ZodType<TaxClass> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  description: z.string().max(500).nullable(),
  uid_tax_codes: z.array(FirestoreId),
  is_default_for: z.array(ProductTypeEnum),
  active: z.boolean().meta({ column: true, label: "Active" }),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkClassSets).meta({
  title: "Tax Class",
  collection: "taxes-classes",
  displayDefaults: {
    columns: ["name", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/** Input for creating a tax class. */
export interface CreateTaxClassInputType {
  name: string;
  description?: string | null;
  uid_tax_codes: string[];
  is_default_for?: ProductTypeType[];
  active: boolean;
}

/** Zod schema for CreateTaxClassInput. */
export const CreateTaxClassInput: z.ZodType<CreateTaxClassInputType> = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  uid_tax_codes: z.array(FirestoreId),
  is_default_for: z.array(ProductTypeEnum).optional(),
  active: z.boolean(),
});

/**
 * Input for updating a tax class.
 *
 * ⚠️ A `uid_tax_codes` change is not a label edit: it reprices every live order
 * whose lines resolve this class (`update-tax-class:codes-recompute-live-orders`).
 */
export interface UpdateTaxClassInputType {
  uid: string;
  version: number;
  name?: string;
  description?: string | null;
  uid_tax_codes?: string[];
  is_default_for?: ProductTypeType[];
  active?: boolean;
}

/** Zod schema for UpdateTaxClassInput. */
export const UpdateTaxClassInput: z.ZodType<UpdateTaxClassInputType> = z.object({
  uid: FirestoreId,
  version: z.int().min(0),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  uid_tax_codes: z.array(FirestoreId).optional(),
  is_default_for: z.array(ProductTypeEnum).optional(),
  active: z.boolean().optional(),
});
