/**
 * TaxRate document schema — Firestore collection: taxes-rates
 *
 * **One dated value of a tax code** — the D365 "sales tax code values", the SAP
 * condition record. The code (`schemas/taxes-code.ts`) carries the identity;
 * this carries a rate and the window it prices over. api-cloudrun#993.
 *
 * ⚠️ **Today's `taxes` collection, renamed, with the SAME uids.** Every stored
 * `price.taxes[].uid` on an order or invoice line names a `taxes` document, and
 * the migration copies each one here under its own id, so those refs stay valid
 * without touching a single line. That is also why a line keeps storing the
 * RATE uid it priced on rather than the code's: a frozen document stays frozen.
 *
 * ## What moved off, and why
 *
 * `name`, `jurisdiction`, `xero_account_code` and `xero_item_code` are true of
 * the tax across every version, so they live on the code. `item_types` is gone
 * entirely — class membership (`schemas/taxes-class.ts`) replaced it. There is
 * deliberately **no `name` denorm**: every writer that prices a line already
 * loads the code to select by jurisdiction, so `PriceModifier.name` snapshots
 * `code.name` directly.
 *
 * `crms_id` is not carried. Removing it from `taxes` still waits on the
 * key-presence census; a new collection has no stored documents to preserve.
 *
 * ## The window
 *
 * `[applied_from, applied_to)`, snapped to Chicago midnight — the same rules
 * `Tax.applied_from` documents in `schemas/tax.ts`, and the same two dates:
 * `applied_*` is when CFS prices, `effective_from` is when the rate legally took
 * effect and prices nothing.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  RATE_UNIT_META,
  type RateType,
  RateTypeEnum,
  TimestampFields,
} from "./common.ts";
import { XeroTaxComponent, type XeroTaxComponentType } from "./tax.ts";

/** A tax rate document in Firestore. */
export interface TaxRate {
  uid: string;
  /** The `taxes-codes` document this is a version of. */
  uid_tax_code: string;
  /** Percent for a `percent` code, dollars per unit for a `flat` one. */
  rate: number;
  /**
   * **A COPY of `code.type`**, stamped by the writer and never accepted on input.
   *
   * Carried because `RATE_UNIT_META` resolves a rate's unit from a SIBLING key,
   * and a rate column with no sibling would render `10.25` without saying
   * whether it is percent or dollars. It cannot drift: the code's `type` is
   * immutable, and `validateTaxSetup` asserts the two agree.
   */
  type: RateType;
  applied_from: string;
  applied_from_fs: FirestoreTimestampType;
  /** Exclusive end of the applied window; `null` = open-ended. */
  applied_to: string | null;
  applied_to_fs: FirestoreTimestampType | null;
  /** When the rate legally took effect. Never prices anything. */
  effective_from: string | null;
  /**
   * The Xero `TaxType` this version pushes as. Per VERSION because Xero forces a
   * new TaxType per rate. `null` on a flat rate, which pushes as a line.
   */
  xero_tax_type: string | null;
  /** Must sum to `rate` on a percent rate; `[]` on a flat one. */
  xero_components: XeroTaxComponentType[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * The per-document invariants — the `taxes` ones that survive the split.
 *
 * 1. A **percent** rate's components sum to `rate`, in integer basis points
 *    (Xero derives EffectiveRate from them).
 * 2. A **flat** rate carries no `xero_tax_type` and no components — Xero has no
 *    TaxType for a per-unit levy, so either would be pushed somewhere wrong.
 */
function checkRateAxes(
  doc: { rate: number; type: RateType; xero_tax_type: string | null; xero_components: XeroTaxComponentType[] },
  ctx: z.RefinementCtx,
): void {
  if (doc.type === "percent" && doc.xero_components.length > 0) {
    const bp = (n: number) => Math.round(n * 10_000);
    const sum = doc.xero_components.reduce((acc, c) => acc + bp(c.rate), 0);
    if (sum !== bp(doc.rate)) {
      ctx.addIssue({
        code: "custom",
        path: ["xero_components"],
        message:
          `xero_components sum to ${sum / 10_000} but rate is ${doc.rate}. Xero computes ` +
          `EffectiveRate FROM the components, so a mismatch pushes a different rate than CFS bills.`,
      });
    }
  }
  if (doc.type === "flat") {
    if (doc.xero_tax_type !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["xero_tax_type"],
        message: "A flat rate pushes as a Xero line, not a TaxType — xero_tax_type must be null.",
      });
    }
    if (doc.xero_components.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["xero_components"],
        message: "A flat rate is dollars per unit and has no percent components.",
      });
    }
  }
}

/** Zod schema for TaxRate. */
export const TaxRateSchema: z.ZodType<TaxRate> = z.strictObject({
  uid: FirestoreId,
  uid_tax_code: FirestoreId,
  rate: z.number().meta({ column: true, label: "Rate", ...RATE_UNIT_META }),
  type: RateTypeEnum.meta({ column: true, label: "Type" }),
  applied_from: chicagoStartOfDay().meta({ column: true, label: "Applied From" }),
  applied_from_fs: FirestoreTimestamp,
  applied_to: chicagoStartOfDay().nullable().meta({ column: true, label: "Applied To" }),
  applied_to_fs: FirestoreTimestamp.nullable(),
  effective_from: chicagoStartOfDay().nullable(),
  xero_tax_type: z.string().min(1).max(20).nullable(),
  xero_components: z.array(XeroTaxComponent),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  ...TimestampFields,
}).superRefine(checkRateAxes).meta({
  title: "Tax Rate",
  collection: "taxes-rates",
  displayDefaults: {
    columns: ["rate", "type", "applied_from", "applied_to"],
    filters: {},
    sort: { column: "applied_from", direction: "desc" },
  },
});

/**
 * The dated-value half of a rate write, shared by a code's first rate
 * (`CreateTaxCodeInput.first_rate`) and {@link CreateTaxRateInput}.
 *
 * No `type` — the code states it and the writer copies it.
 */
export interface TaxRateBodyType {
  rate: number;
  applied_from: string;
  applied_to?: string | null;
  effective_from?: string | null;
  xero_tax_type?: string | null;
  xero_components?: XeroTaxComponentType[];
}

/** Zod schema for TaxRateBody. */
export const TaxRateBody: z.ZodType<TaxRateBodyType> = z.object({
  rate: z.number(),
  applied_from: chicagoStartOfDay(),
  applied_to: chicagoStartOfDay().nullable().optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
});

/**
 * Input for adding a rate to a code — `POST /taxes-codes/{uid}/rates`, which
 * replaces `SupersedeTaxInput`.
 *
 * The writer closes the incumbent's window at this `applied_from` in the same
 * transaction, for the reason `SupersedeTaxInput` records: between two separate
 * calls both versions are open and pricing throws on the overlap.
 *
 * `version` is OCC on the CODE — the rate being added does not exist yet, and a
 * concurrent add to the same code is exactly the race to refuse.
 */
export interface CreateTaxRateInputType extends TaxRateBodyType {
  uid_tax_code: string;
  version: number;
}

/** Zod schema for CreateTaxRateInput. */
export const CreateTaxRateInput: z.ZodType<CreateTaxRateInputType> = z.object({
  uid_tax_code: FirestoreId,
  version: z.int().min(0),
  rate: z.number(),
  applied_from: chicagoStartOfDay(),
  applied_to: chicagoStartOfDay().nullable().optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
});

/**
 * Input for renewing a rate's window.
 *
 * ⚠️ **`rate` is absent.** An in-place rate edit re-prices history; the
 * sanctioned move is a new rate. What an operator legitimately edits on an
 * existing version is its review bound and its statutory date.
 */
export interface UpdateTaxRateInputType {
  uid: string;
  version: number;
  applied_to?: string | null;
  effective_from?: string | null;
}

/** Zod schema for UpdateTaxRateInput. */
export const UpdateTaxRateInput: z.ZodType<UpdateTaxRateInputType> = z.object({
  uid: FirestoreId,
  version: z.int().min(0),
  applied_to: chicagoStartOfDay().nullable().optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
});
