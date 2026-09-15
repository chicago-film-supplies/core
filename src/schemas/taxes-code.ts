/**
 * TaxCode document schema — Firestore collection: taxes-codes
 *
 * **The identity of one tax** — the D365 "sales tax code", the SAP "tax code".
 * Its dated values live in `taxes-rates` (`schemas/taxes-rate.ts`), and the
 * item side that lists codes lives in `taxes-classes` (`schemas/taxes-class.ts`).
 * api-cloudrun#993.
 *
 * ## Why a real document, and not the first version's uid or a slug
 *
 * - A borrowed version uid names a closed rate as the identity of a live tax.
 * - A slug from name + jurisdiction breaks on the renames Xero forces on a
 *   superseded rate.
 * - A document gives the class editor, the matrix and validation one place to
 *   read the label.
 *
 * ## What lives here rather than on a rate
 *
 * Everything true of the tax across ALL of its versions: the label, who levies
 * it, whether it is a percent or a per-unit levy, and where a flat levy posts in
 * Xero. A percent rate's Xero `TaxType` is NOT here — Xero forces a new TaxType
 * per rate, so it is a property of the version.
 *
 * ⚠️ **`jurisdiction` and `type` are immutable after create** (the API refuses
 * the edit). That is what lets no propagation rule exist for a code change:
 * nothing denormalizes them, and a rate's `type` copy cannot drift from a value
 * that never moves.
 *
 * Shape follows `department-type.ts` (actor pair, spread timestamps, required
 * writer-stamped `active`).
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  type RateType,
  RateTypeEnum,
  TaxJurisdictionEnum,
  type TaxJurisdictionType,
  TimestampFields,
} from "./common.ts";
import { TaxRateBody, type TaxRateBodyType } from "./taxes-rate.ts";

/** A tax code document in Firestore. */
export interface TaxCode {
  uid: string;
  /**
   * The label every class, matrix and line snapshot shows — `PriceModifier.name`
   * on a line is copied from this at pricing time.
   *
   * Unique across the WHOLE collection, inactive codes included (the
   * `department-types` ruling), so a deactivated code blocks a duplicate rather
   * than silently freeing its name. Enforced by the API writer.
   */
  name: string;
  /** Who levies it. Immutable after create. */
  jurisdiction: TaxJurisdictionType;
  /**
   * `percent` → `subtotal_discounted × rate ÷ 100`; `flat` → `rate × quantity`.
   * Immutable after create, and the authority for every rate's `type` copy.
   */
  type: RateType;
  /**
   * Where a **flat** levy's Xero line posts — Xero cannot express a flat tax as a
   * `TaxType`, so it is pushed as an ordinary line (the Chicago Bottled Water Tax
   * posts to the 2210 liability account). `null` on a percent code.
   */
  xero_account_code: number | null;
  /** The Xero `ItemCode` a flat levy's line carries. `null` on a percent code. */
  xero_item_code: string | null;
  /**
   * Whether the code can be added to a class. Soft delete — a deactivated code
   * stays resolvable for the rates and documents already naming it.
   *
   * ⚠️ **A primary fact, not the `active` flag `taxes` deleted.** That one
   * duplicated the applied window, which is what actually prices; this one
   * answers "may an operator still pick this code", which nothing else records.
   * Required and stated by the writer — a `.default()` never materializes under
   * `validateBeforeWrite`.
   */
  active: boolean;
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * The Xero axes of a code, which only make sense as a pair with `type`:
 * a flat code must say where its line posts, and a percent code has no line.
 */
function checkCodeAxes(
  doc: { type: RateType; xero_account_code: number | null; xero_item_code: string | null },
  ctx: z.RefinementCtx,
): void {
  if (doc.type === "flat" && doc.xero_account_code === null) {
    ctx.addIssue({
      code: "custom",
      path: ["xero_account_code"],
      message:
        "A flat tax code needs xero_account_code — Xero has no TaxType for a per-unit " +
        "levy, so it is pushed as a line, and the line must post somewhere.",
    });
  }
  if (doc.type === "percent") {
    for (const key of ["xero_account_code", "xero_item_code"] as const) {
      if (doc[key] !== null) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message:
            `${key} is for a flat code's Xero line; a percent code pushes as a TaxType ` +
            `(on its rate) and has no line to post.`,
        });
      }
    }
  }
}

/** Zod schema for TaxCode. */
export const TaxCodeSchema: z.ZodType<TaxCode> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  jurisdiction: TaxJurisdictionEnum.meta({ column: true, label: "Jurisdiction" }),
  type: RateTypeEnum.meta({ column: true, label: "Type" }),
  xero_account_code: z.int().nullable(),
  xero_item_code: z.string().min(1).max(30).nullable(),
  active: z.boolean().meta({ column: true, label: "Active" }),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkCodeAxes).meta({
  title: "Tax Code",
  collection: "taxes-codes",
  displayDefaults: {
    columns: ["name", "jurisdiction", "type", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * Input for creating a tax code.
 *
 * A code with no rate prices nothing and would read as an `untaxed` cell in
 * every class listing it, so the first rate is part of the create — the writer
 * mints both documents in one transaction.
 */
export interface CreateTaxCodeInputType {
  name: string;
  jurisdiction: TaxJurisdictionType;
  type: RateType;
  xero_account_code?: number | null;
  xero_item_code?: string | null;
  active: boolean;
  first_rate: TaxRateBodyType;
}

/** Zod schema for CreateTaxCodeInput. */
export const CreateTaxCodeInput: z.ZodType<CreateTaxCodeInputType> = z.object({
  name: z.string().min(1).max(100),
  jurisdiction: TaxJurisdictionEnum,
  type: RateTypeEnum,
  xero_account_code: z.int().nullable().optional(),
  xero_item_code: z.string().min(1).max(30).nullable().optional(),
  active: z.boolean(),
  first_rate: TaxRateBody,
});

/**
 * Input for updating a tax code.
 *
 * ⚠️ **`jurisdiction` and `type` are absent, not refused-by-the-service.** A
 * code's jurisdiction and type never change — a different levy is a different
 * code — so the input cannot name them, and an object input strips them.
 */
export interface UpdateTaxCodeInputType {
  uid: string;
  version: number;
  name?: string;
  xero_account_code?: number | null;
  xero_item_code?: string | null;
  active?: boolean;
}

/** Zod schema for UpdateTaxCodeInput. */
export const UpdateTaxCodeInput: z.ZodType<UpdateTaxCodeInputType> = z.object({
  uid: FirestoreId,
  version: z.int().min(0),
  name: z.string().min(1).max(100).optional(),
  xero_account_code: z.int().nullable().optional(),
  xero_item_code: z.string().min(1).max(30).nullable().optional(),
  active: z.boolean().optional(),
});
