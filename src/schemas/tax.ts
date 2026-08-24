/**
 * Tax document schema — Firestore collection: taxes
 *
 * Tax definitions used for computing item-level and order-level tax amounts.
 * Tax data is denormalized onto order items at order time.
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import { chicagoStartOfDay } from "./_datetime.ts";
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
  crms_id: number | null;
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
   *
   * ⚠️ **Required, and `[]` is the way to say "no types".** The absence of a
   * type has to be a STATED fact: `service`, `surcharge` and `transaction_fee`
   * are untaxed today and could be taxed tomorrow, so an omitted list would
   * make "nobody decided" and "decided: none" the same document.
   * `audit-tax-catalog.ts` prints the full (jurisdiction × item type) matrix so
   * adding one stays a deliberate edit.
   */
  item_types: PreTaxItemType[];
  /**
   * When **CFS** starts pricing at this version — the bound `findTaxFor` and
   * `findTaxAt` bracket on, half-open `[applied_from, applied_to)`.
   *
   * Replaced `valid_from`, which conflated this with {@link Tax.effective_from}.
   * They coincided on every change before 2026-08, so nothing forced them apart.
   */
  applied_from: string;
  applied_from_fs: FirestoreTimestampType;
  /** Exclusive end of the applied window; `null` = open-ended. */
  applied_to: string | null;
  applied_to_fs: FirestoreTimestampType | null;
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
   *
   * Required and NULLABLE as of Wave 5b: `null` is the real answer ("no
   * statutory date recorded"), and it is what `createTax` and `supersedeTax`
   * (`api-cloudrun/src/services/taxes.ts`) write when the caller omits one
   * (`input.effective_from ?? null`). **11 of 11 taxes in prod and dev carry
   * the key** (measured 2026-08-23, `orderBy` key-presence). The three input
   * schemas keep their `?` — the writer is what supplies the value, and that
   * split is the point.
   */
  effective_from: string | null;
  /**
   * The Xero `TaxType` code this version pushes as, e.g. `"TAX002"`.
   *
   * ⚠️ **Data, not a hardcoded table.** It was `TAX_UID_TO_XERO_TYPE` in
   * api-cloudrun, keyed on uid — and a supersede mints a NEW uid, so the
   * successor fell off the map and the invoice push sent `NONE`: Xero billing
   * $0 tax while CFS billed 10.5%, plus a hard failure on the quote push.
   */
  xero_tax_type?: string | null;
  /**
   * Where a **flat** tax posts in Xero, and which Xero Item its line references.
   *
   * ⚠️ **Xero cannot express a flat tax at all** — a `TaxType` is a percentage
   * rate, so a per-unit levy has no rate to be. It is pushed as an ordinary
   * LINE instead (`TaxType: "NONE"`), and these two fields are what that line
   * needs: the account the money it collects sits in, and the catalog Item it
   * shows as.
   *
   * The Chicago Bottled Water Tax is the live case: 5¢ per bottle, collected
   * for the City, so it posts to a **liability** account (2210) rather than to
   * revenue. Both stay `null` on a `percent` tax, which carries a
   * {@link Tax.xero_tax_type} instead.
   *
   * ⚠️ On the tax DOCUMENT rather than in api-cloudrun, for the same reason
   * `xero_tax_type` is: a hardcoded table keyed on uid falls off at the first
   * supersede, and the levy's account is exactly the sort of fact that gets
   * copied into a second place and drifts. #2188 booked it to 4800 while
   * #2380/#2381/#2390 booked it to 2210 — the drift already happened once.
   */
  xero_account_code?: number | null;
  /** @see {@link Tax.xero_account_code}. The Xero `ItemCode` the line carries. */
  xero_item_code?: string | null;
  /**
   * @see {@link XeroTaxComponentType} — must sum to {@link Tax.rate}.
   *
   * Required as of Wave 5b. `createTax` and `supersedeTax`
   * (`api-cloudrun/src/services/taxes.ts`) both write `input.xero_components ??
   * []`, so the key is stamped on every write whether or not the caller sends
   * one, and **all 11 taxes in prod and dev carry it** (measured 2026-08-23 by
   * `orderBy` key-presence — every one as `[]`, which is what confirmed empty
   * arrays ARE indexed and made this oracle trustworthy in the first place).
   *
   * ⚠️ Empty stays legal and stays meaningful: invariant 2 above (components
   * sum to `rate`) is skipped on an empty list. Requiring the field says the
   * key is always present, not that a decomposition always exists. The three
   * input schemas keep their `?` — the writer is what supplies the value.
   */
  xero_components: XeroTaxComponentType[];
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
 * 1. **`item_types: []` is the EXPLICIT-ONLY class**, and `jurisdiction` SCOPES
 *    it rather than defining it. A tax listing no item types is unreachable by
 *    the `(jurisdiction × type)` rule and is applied only because a product
 *    carries its ref — the Chicago Bottled Water Tax is the live case.
 *
 *    ⚠️ **It was `jurisdiction: null ⟺ item_types: []` until api-cloudrun#409,
 *    and that biconditional made a real tax unrepresentable.** The bottle tax is
 *    levied per bottle *sold in Chicago*: it needs a jurisdiction to be scoped
 *    by, and it must NOT be resolvable by type, because `(chicago, sale)` is
 *    already claimed by Chicago Sales Tax and `findTaxFor` THROWS on two taxes
 *    covering one pair. So the two halves answer different questions — "can the
 *    rule find me?" is `item_types`, "where do I apply?" is `jurisdiction` —
 *    and welding them made the second unaskable.
 *
 *    ⚠️ `findTaxFor` still skips the class: it requires
 *    `tax.jurisdiction === jurisdiction` **and** a matching `item_types` entry,
 *    so an empty list can never match and a scoped explicit tax is no more
 *    reachable by the rule than an unscoped one. What the scope changes is
 *    which lines KEEP the ref — see `assignLineTaxes`.
 * 2. **`xero_components` sum to `rate`** — Xero derives `EffectiveRate` from the
 *    components, so a set that does not sum to the CFS rate pushes a tax at a
 *    different rate than CFS billed. Compared in integer basis points, not
 *    floats, and only for a `percent` tax: a `flat` tax's `rate` is dollars per
 *    unit and has no components.
 *
 * Invariant 2 is skipped where `xero_components` is absent; invariant 1 never
 * is, because `item_types` is required.
 */
function checkTaxAxes(
  doc: {
    rate: number;
    type: RateType;
    jurisdiction?: JurisdictionType | null;
    item_types: PreTaxItemType[];
    xero_components?: XeroTaxComponentType[];
  },
  ctx: z.RefinementCtx,
): void {
  // A RESOLVABLE tax — one the `(jurisdiction × type)` rule can find — needs
  // both halves. The converse is deliberately NOT enforced: `item_types: []`
  // with a jurisdiction is the scoped explicit-only class (see above).
  if (doc.jurisdiction === null && doc.item_types.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["jurisdiction"],
      message:
        `item_types: [${doc.item_types}] names types the rule could resolve, but ` +
        `jurisdiction is null — so nothing can ever match them. Give the tax a ` +
        `jurisdiction, or clear item_types to make it explicit-only (applied ` +
        `because a product carries its ref).`,
    });
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
  crms_id: z.int().nullable().default(null),
  jurisdiction: JurisdictionEnum.nullable().optional().meta({
    column: true,
    label: "Jurisdiction",
  }),
  item_types: z.array(PreTaxItemTypeEnum),
  applied_from: chicagoStartOfDay().meta({ column: true, label: "Applied From" }),
  applied_from_fs: FirestoreTimestamp,
  applied_to: chicagoStartOfDay().nullable().meta({ column: true, label: "Applied To" }),
  applied_to_fs: FirestoreTimestamp.nullable(),
  effective_from: chicagoStartOfDay().nullable(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_account_code: z.int().nullable().optional(),
  xero_item_code: z.string().min(1).max(30).nullable().optional(),
  // Required as of Wave 5b — 11/11 in prod and dev, every one as `[]`, and both
  // writers stamp `?? []`. That census is what confirmed empty arrays ARE
  // indexed by `orderBy`, which is the one way an array field could have read as
  // absent when it was not. CLAUDE.md § "Is a field dead?".
  xero_components: z.array(XeroTaxComponent),
  version: z.int().min(0).default(0),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  updated_by: ActorRef.meta({ column: true, label: "Updated By" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
}).superRefine(checkTaxAxes).meta({
  title: "Tax",
  collection: "taxes",
  displayDefaults: {
    // The WINDOW, not the retired `active` flag: it is what prices, and a
    // column showing a derived liveness without the bound it derives from is
    // the drift `active` already caused (api-cloudrun#613).
    columns: ["name", "rate", "type", "jurisdiction", "applied_from", "applied_to"],
    filters: {},
    sort: { column: "name", direction: "asc" },
  },
});

/**
 * Input for creating a new tax definition.
 *
 * `applied_from` / `applied_to` are the APPLIED window — the bound
 * {@link Tax.applied_from} documents. They take {@link chicagoStartOfDay}
 * rather than an instant because **a rate boundary is a calendar date**: the
 * operator authors a day, and the snap belongs in the transform rather than in
 * each of the three writers that used to do it by hand.
 */
export interface CreateTaxInputType {
  name: string;
  rate: number;
  type: RateType;
  applied_from: string;
  applied_to?: string | null;
  jurisdiction?: JurisdictionType | null;
  item_types?: PreTaxItemType[];
  effective_from?: string | null;
  xero_tax_type?: string | null;
  xero_account_code?: number | null;
  xero_item_code?: string | null;
  xero_components?: XeroTaxComponentType[];
}

/** Zod schema for CreateTaxInput. */
export const CreateTaxInput: z.ZodType<CreateTaxInputType> = z.object({
  name: z.string().min(1).max(100),
  rate: z.number(),
  type: RateTypeEnum,
  applied_from: chicagoStartOfDay(),
  applied_to: chicagoStartOfDay().nullable().optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_account_code: z.int().nullable().optional(),
  xero_item_code: z.string().min(1).max(30).nullable().optional(),
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
  applied_from?: string;
  applied_to?: string | null;
  jurisdiction?: JurisdictionType | null;
  item_types?: PreTaxItemType[];
  effective_from?: string | null;
  xero_tax_type?: string | null;
  xero_account_code?: number | null;
  xero_item_code?: string | null;
  xero_components?: XeroTaxComponentType[];
  version: number;
}

/** Zod schema for UpdateTaxInput. */
export const UpdateTaxInput: z.ZodType<UpdateTaxInputType> = z.object({
  uid: FirestoreId,
  name: z.string().min(1).max(100).optional(),
  rate: z.number().optional(),
  type: RateTypeEnum.optional(),
  applied_from: chicagoStartOfDay().optional(),
  applied_to: chicagoStartOfDay().nullable().optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_account_code: z.int().nullable().optional(),
  xero_item_code: z.string().min(1).max(30).nullable().optional(),
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
 * `applied_from` is one field doing two jobs — the successor's start AND the
 * incumbent's `applied_to` — because they are the same instant by definition.
 * Two fields would be two chances to disagree.
 *
 * ## `effective_from` is the OTHER date, and it is not this one
 *
 * `applied_from` is when **CFS** starts pricing at the new
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
  applied_from: string;
  /** The successor's rate. */
  rate: number;
  /** Defaults to the incumbent's. */
  type?: RateType;
  /** The successor's own end. Open-ended unless a third version is planned. */
  applied_to?: string | null;
  /** When the successor's rate legally took effect. Never prices anything. */
  effective_from?: string | null;
  /**
   * The successor's Xero `TaxType`. **Required in practice** — the service
   * refuses a successor with none when the incumbent had one, because an
   * unmapped version makes the invoice push send `NONE` (Xero bills $0 tax
   * while CFS bills the new rate) and hard-fails the quote push.
   */
  xero_tax_type?: string | null;
  /**
   * Where a **flat** successor posts, and which Xero Item its line carries —
   * see {@link Tax.xero_account_code}. Both default to the incumbent's.
   *
   * ⚠️ They were accepted by the Zod schema and absent from this interface,
   * so `supersedeTax` could not read them and superseding the Water Bottle Tax
   * silently dropped its liability-account binding — the exact drift
   * {@link Tax.xero_account_code} exists to prevent.
   */
  xero_account_code?: number | null;
  /** @see {@link SupersedeTaxInputType.xero_account_code}. */
  xero_item_code?: string | null;
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
  applied_from: chicagoStartOfDay(),
  rate: z.number(),
  type: RateTypeEnum.optional(),
  applied_to: chicagoStartOfDay().nullable().optional(),
  effective_from: chicagoStartOfDay().nullable().optional(),
  xero_tax_type: z.string().min(1).max(20).nullable().optional(),
  xero_account_code: z.int().nullable().optional(),
  xero_item_code: z.string().min(1).max(30).nullable().optional(),
  xero_components: z.array(XeroTaxComponent).optional(),
  jurisdiction: JurisdictionEnum.nullable().optional(),
  item_types: z.array(PreTaxItemTypeEnum).optional(),
});
