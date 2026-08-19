/**
 * Tax document schema — Firestore collection: taxes
 *
 * Tax definitions used for computing item-level and order-level tax amounts.
 * Tax data is denormalized onto order items at order time.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoInstant, chicagoStartOfDay } from "./_datetime.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  JurisdictionEnum,
  type JurisdictionType,
  type PreTaxItemType,
  PreTaxItemTypeEnum,
  RATE_UNIT_META,
  RateTypeEnum,
  type RateType,
} from "./common.ts";

/**
 * One component of a Xero tax rate — the state / transit-authority / county /
 * city split a filed return reads.
 *
 * Xero's `DisplayTaxRate` and `EffectiveRate` are **readOnly**: it computes them
 * from `TaxComponents[]`. So a CFS-authored rate that flattens four components
 * into one total is accepted, prices correctly, and destroys the breakdown an
 * ST-1 return is filed from. Carrying the components on the Tax document is what
 * lets `xeroTaxRateCreate` reproduce them.
 *
 * `rate` states its unit outright rather than inheriting one: unlike
 * `PriceModifier`, this shape has no sibling `type` to discriminate on, and a
 * tax component is always a **percent**.
 */
export interface XeroTaxComponentType {
  /** Xero's component name, e.g. `"Northern Illinois Transit Authority"`. */
  name: string;
  /** Percent, e.g. `1.25`. Never dollars — a component of a flat tax is not a thing. */
  rate: number;
}

/** Zod schema for XeroTaxComponent. */
export const XeroTaxComponent: z.ZodType<XeroTaxComponentType> = z.strictObject({
  name: z.string().min(1).max(50),
  rate: z.number(),
});

/** A tax definition used for computing item-level and order-level tax amounts. */
export interface Tax {
  uid: string;
  name: string;
  rate: number;
  type: RateType;
  active: boolean;
  crms_id: number | null;
  valid_from: string;
  valid_from_fs: FirestoreTimestampType;
  valid_to: string | null;
  valid_to_fs: FirestoreTimestampType | null;
  /**
   * Which jurisdiction this tax is collected for. `null` means **explicit-only**
   * — reachable by uid, never by `findTaxFor`. Prod has exactly two:
   * `No Tax` and `Water Bottle Tax`.
   *
   * Optional through Phase 1 of api-cloudrun#409's tax-axes work: the documents
   * predate the field and `validateBeforeWrite` writes the RAW doc, so a
   * `.default()` here would never materialize.
   */
  jurisdiction?: JurisdictionType | null;
  /**
   * Which line types this tax covers. `[]` means **explicit-only**, the same
   * class as `jurisdiction: null` and enforced to coincide with it.
   *
   * ⚠️ **Set from the RULE, not from the corpus.** Prod carries taxed `service`
   * and `surcharge` lines; those are mistakes frozen as history, and encoding
   * them here would promote 11 defects into a standing rule.
   */
  item_types?: PreTaxItemType[];
  /**
   * When **CFS** starts pricing at this version — the bound `findTaxFor` and
   * `findTaxAt` bracket on, half-open `[applied_from, applied_to)`.
   *
   * Replaces `valid_from`, which conflated this with {@link Tax.effective_from}.
   * They coincided on every change before 2026-08, so nothing forced them apart.
   */
  applied_from?: string;
  applied_from_fs?: FirestoreTimestampType;
  /** Exclusive end of the applied window; `null`/absent = open-ended. */
  applied_to?: string | null;
  applied_to_fs?: FirestoreTimestampType | null;
  /**
   * When the rate legally took effect. **Never prices anything** — it exists so
   * a late-discovered statutory change is a recorded fact rather than a lost
   * one, and so the `[effective_from, applied_from)` lag is auditable.
   *
   * The 2026-08-01 NITA increase is the worked example: CFS discovered it weeks
   * late, and opening the *applied* window on 2026-08-01 would have silently
   * re-rated 42 already-billed invoices on their next CRMS edit.
   *
   * There is deliberately no `effective_to` — a version's statutory window ends
   * at its successor's `effective_from`.
   */
  effective_from?: string | null;
  /**
   * The Xero `TaxType` code this version pushes as, e.g. `"TAX002"`.
   *
   * ⚠️ **Data, not a hardcoded table.** It was `TAX_UID_TO_XERO_TYPE` in
   * api-cloudrun, keyed on uid — and a supersede mints a NEW uid, so the
   * successor fell off the map and the invoice push sent `NONE`: Xero billing
   * $0 tax while CFS billed 10.5%, plus a hard failure on the quote push.
   */
  xero_tax_type?: string | null;
  /** @see {@link XeroTaxComponentType} — must sum to {@link Tax.rate}. */
  xero_components?: XeroTaxComponentType[];
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * The two invariants that are properties of the DOCUMENT rather than of any one
 * field, so neither can be expressed at a field's own schema.
 *
 * 1. **`jurisdiction: null` ⟺ `item_types: []`** — the explicit-only class. A
 *    tax reachable by neither axis is reachable only by uid, and the two halves
 *    have to agree or `findTaxFor` gets a wildcard where it expects a refusal.
 *    ⚠️ `findTaxFor` **skips** this class; a `null` jurisdiction is never a
 *    match-anything.
 * 2. **`xero_components` sum to `rate`** — Xero derives `EffectiveRate` from the
 *    components, so a set that does not sum to the CFS rate pushes a tax at a
 *    different rate than CFS billed. Compared in integer basis points, not
 *    floats, and only for a `percent` tax: a `flat` tax's `rate` is dollars per
 *    unit and has no components.
 *
 * Both are skipped where the field is absent — every new field is additive and
 * optional until the api-cloudrun#409 Phase 2 publish makes them required.
 */
function checkTaxAxes(
  doc: {
    rate: number;
    type: RateType;
    jurisdiction?: JurisdictionType | null;
    item_types?: PreTaxItemType[];
    xero_components?: XeroTaxComponentType[];
  },
  ctx: z.RefinementCtx,
): void {
  if (doc.jurisdiction !== undefined && doc.item_types !== undefined) {
    const explicitOnly = doc.jurisdiction === null;
    if (explicitOnly !== (doc.item_types.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["item_types"],
        message:
          `jurisdiction: ${JSON.stringify(doc.jurisdiction)} and item_types: ` +
          `[${doc.item_types}] disagree — a tax is either explicit-only ` +
          `(jurisdiction null AND item_types empty, reachable only by uid) or ` +
          `resolvable (both set). Half of each makes findTaxFor read a null ` +
          `jurisdiction as a wildcard.`,
      });
    }
  }

  const components = doc.xero_components;
  if (doc.type === "percent" && components !== undefined && components.length > 0) {
    // Basis points, not floats: 4dp rates summed as doubles is exactly the
    // "quantizing the ratio" defect the money rules ban, one domain over.
    const bp = (n: number) => Math.round(n * 10_000);
    const sum = components.reduce((acc, c) => acc + bp(c.rate), 0);
    if (sum !== bp(doc.rate)) {
      ctx.addIssue({
        code: "custom",
        path: ["xero_components"],
        message:
          `xero_components sum to ${sum / 10_000} but rate is ${doc.rate}. ` +
          `Xero computes EffectiveRate FROM the components, so a mismatch ` +
          `pushes a different rate than CFS bills.`,
      });
    }
  }
}

/** Zod schema for Tax. */
export const TaxSchema: z.ZodType<Tax> = z.strictObject({
  uid: FirestoreId,
  name: z.string().min(1).max(100).meta({ column: true, label: "Name" }),
  rate: z.number().meta({ column: true, label: "Rate", ...RATE_UNIT_META }),
  type: RateTypeEnum.meta({ column: true, label: "Type" }),
  active: z.boolean().default(true).meta({ column: true, label: "Active" }),
  crms_id: z.int().nullable().default(null),
  valid_from: chicagoInstant(),
  valid_from_fs: FirestoreTimestamp,
  valid_to: chicagoInstant().nullable().default(null),
  valid_to_fs: FirestoreTimestamp.nullable().default(null),
  jurisdiction: JurisdictionEnum.nullable().optional().meta({
    column: true,
    label: "Jurisdiction",
  }),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
  applied_from: chicagoStartOfDay().optional(),
  applied_from_fs: FirestoreTimestamp.optional(),
  applied_to: chicagoStartOfDay().nullable().optional(),
  applied_to_fs: FirestoreTimestamp.nullable().optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).superRefine(checkTaxAxes).meta({
  title: "Tax",
  collection: "taxes",
  displayDefaults: {
    columns: ["name", "rate", "type", "jurisdiction", "active"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * Input for creating a new tax definition.
 *
 * ⚠️ **`valid_from` / `valid_to` are the Phase-1 wire names for the APPLIED
 * window** (api-cloudrun#409). The writer derives `applied_from` /`applied_to`
 * from them — snapped to Chicago midnight, because a rate boundary is a
 * calendar date — and writes both, so a reader on either name agrees. They are
 * renamed on the wire in Phase 2, once no stored document still carries the old
 * pair. Two names for one bound is a transitional cost, not a design.
 */
export interface CreateTaxInputType {
  name: string;
  rate: number;
  type: RateType;
  active?: boolean;
  valid_from: string;
  valid_to?: string | null;
  jurisdiction?: JurisdictionType | null;
  item_types?: PreTaxItemType[];
  effective_from?: string | null;
  xero_tax_type?: string | null;
  xero_components?: XeroTaxComponentType[];
}

/** Zod schema for CreateTaxInput. */
export const CreateTaxInput: z.ZodType<CreateTaxInputType> = z.object({
  name: z.string().min(1).max(100),
  rate: z.number(),
  type: RateTypeEnum,
  active: z.boolean().optional(),
  valid_from: chicagoInstant(),
  valid_to: chicagoInstant().nullable().optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
});

/**
 * Input for updating an existing tax definition.
 *
 * `rate` and `type` are accepted here and **refused by the service** — an
 * in-place rate edit re-prices history, so the sanctioned move is
 * {@link SupersedeTaxInput}. They stay on the input so the refusal can name what
 * the caller asked for.
 */
export interface UpdateTaxInputType {
  uid: string;
  name?: string;
  rate?: number;
  type?: RateType;
  active?: boolean;
  valid_from?: string;
  valid_to?: string | null;
  jurisdiction?: JurisdictionType | null;
  item_types?: PreTaxItemType[];
  effective_from?: string | null;
  xero_tax_type?: string | null;
  xero_components?: XeroTaxComponentType[];
  version: number;
}

/** Zod schema for UpdateTaxInput. */
export const UpdateTaxInput: z.ZodType<UpdateTaxInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  rate: z.number().optional(),
  type: RateTypeEnum.optional(),
  active: z.boolean().optional(),
  valid_from: chicagoInstant().optional(),
  valid_to: chicagoInstant().nullable().optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
  version: z.int().min(0),
});

/**
 * Input for superseding a tax — closing the incumbent's window and opening its
 * successor's, in one write (api-cloudrun#495).
 *
 * ## Why this is not two calls
 *
 * A rate change is retroactive by nature, so the correct model is a new
 * *version* rather than an edit — but the sanctioned way to reach it was
 * `POST /taxes` followed by `PUT /taxes/{old}`, and **between those two calls
 * both versions are open-ended**. {@link findTaxAt} does not pick one when two
 * same-name docs bracket an instant, it THROWS `Tax catalog drift` — on the
 * pricing path, for every order and invoice write touching that name. So the
 * documented workflow had a window in which pricing was down, and the operator
 * getting the order wrong was the only thing standing between the catalog and
 * that throw. One transaction makes the overlap unrepresentable instead.
 *
 * ## What is deliberately absent
 *
 * - **No `name`.** A supersede is by construction the next version of the same
 *   tax, and `findTaxAt` matches by name — so a caller-supplied name would let
 *   one call close this series and open a different one, which is two edits
 *   wearing one verb.
 * - **No way to deactivate the incumbent.** A closed version must stay in the
 *   catalog: `getTaxDocs()` reads the collection unfiltered and `findTaxAt`
 *   resolves *historical* instants off it, so retiring the incumbent would
 *   re-price every past document that names it. It is also what keeps a
 *   consumer holding a pinned uid working — manager pins `RENTAL_TAX_UID` as a
 *   constant and `getDefaultTaxesForType` returns `[]` on a miss, so a
 *   deactivated incumbent creates every new rental line **untaxed, silently**.
 *   The line still prices correctly because the order writers re-resolve by
 *   name at `asOf` (`resolveTaxRefsAt`); that resolution is the reason this
 *   endpoint is safe to ship before manager stops pinning uids.
 *
 * `valid_from` is one field doing two jobs — the successor's start AND the
 * incumbent's `valid_to` — because they are the same instant by definition.
 * Two fields would be two chances to disagree.
 *
 * ## `effective_from` is the OTHER date, and it is not this one
 *
 * `valid_from` (→ `applied_from`) is when **CFS** starts pricing at the new
 * rate. {@link Tax.effective_from} is when the rate **legally** took effect.
 * They coincided on every change before 2026-08 and nothing forced them apart;
 * the NITA increase arrived in a special-district bulletin CFS read weeks late,
 * so the two are genuinely different dates and the lag is a fact worth storing.
 *
 * ⚠️ **Open the applied window at the CUTOVER, not at `effective_from`.**
 * Backdating it re-rates every unsettled invoice already billed at the old rate
 * on its next CRMS edit. The service refuses `effective_from > applied_from`,
 * which is the only ordering that is incoherent rather than merely late.
 */
export interface SupersedeTaxInputType {
  /** The incumbent being closed. The successor is minted with a fresh id. */
  uid: string;
  /** OCC on the INCUMBENT — the successor does not exist yet. */
  version: number;
  /** The successor's start, and the instant the incumbent's window closes. */
  valid_from: string;
  /** The successor's rate. */
  rate: number;
  /** Defaults to the incumbent's. */
  type?: RateType;
  /** The successor's own end. Open-ended unless a third version is planned. */
  valid_to?: string | null;
  /** When the successor's rate legally took effect. Never prices anything. */
  effective_from?: string | null;
  /**
   * The successor's Xero `TaxType`. **Required in practice** — the service
   * refuses a successor with none when the incumbent had one, because an
   * unmapped version makes the invoice push send `NONE` (Xero bills $0 tax
   * while CFS bills the new rate) and hard-fails the quote push.
   */
  xero_tax_type?: string | null;
  /** The successor's Xero component split. Must sum to `rate`. */
  xero_components?: XeroTaxComponentType[];
  /** Defaults to the incumbent's — a supersede is the same tax, re-rated. */
  jurisdiction?: JurisdictionType | null;
  /** Defaults to the incumbent's. */
  item_types?: PreTaxItemType[];
}

/** Zod schema for SupersedeTaxInput. */
export const SupersedeTaxInput: z.ZodType<SupersedeTaxInputType> = z.object({
  uid: FirestoreId,
  version: z.int().min(0),
  valid_from: chicagoInstant(),
  rate: z.number(),
  type: RateTypeEnum.optional(),
  valid_to: chicagoInstant().nullable().optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
});
