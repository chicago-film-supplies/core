/**
 * PricingSettings document schema — Firestore singleton: settings/pricing
 *
 * Which `price-formulas/{uid}` a NEW custom order or invoice line starts on,
 * per line type, and which one a line moves to when it is RETYPED
 * (`retypedLinePrice`). A default is a client convenience: the server never
 * prices a line by it, and a custom line that names no price is still refused
 * (api-cloudrun purchases-as-documents D10 items 4 and 11).
 *
 * ⭐ **A POINTER per type, not a flag per formula** (owner, 2026-10-31). One
 * default per type is then true by construction — the `store.default_location`
 * shape — where an `is_default_for` on each formula (the tax-class shape) is a
 * collection-wide rule every formula write must re-check over the whole
 * catalog, and a `default: true` flag (the store shape) needs a range read and
 * a sibling-demote cascade. It also keeps every price formula's fields
 * immutable once referenced: nothing about a default lives on the formula.
 *
 * ⚠️ **`null`, an unknown uid or a retired formula is NO default** — the
 * manager makes the operator choose; it never fails a line
 * (`defaultPriceFormulaFor`). The writer refuses naming a formula that is not
 * active, but a formula retired later is not re-checked here.
 *
 * The doc id is fixed at `pricing`, so its `uid` is `"pricing"` — the same
 * documented exception to the auto-id rule as `settings/billing`. The two share
 * the `settings` collection through {@link SettingsSchema}, a union
 * discriminated on `uid`.
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  type DocLineItemTypeType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";
import { FirestoreId } from "./_uid.ts";

/** Per line type, the formula a new or retyped line starts on, or `null` for none. */
export type PriceFormulaDefaults = { [T in DocLineItemTypeType]: string | null };

/** The pricing settings singleton (`settings/pricing`). */
export interface PricingSettings {
  uid: "pricing";
  price_formula_defaults: PriceFormulaDefaults;
  /** Optimistic-lock version, bumped on every edit. */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/**
 * Zod schema for {@link PriceFormulaDefaults}. Every line type is spelled as a
 * key, so a seventh `DOC_LINE_ITEM_TYPES` member is a type error here rather
 * than a silently missing default (`tests/pricing-settings.test.ts` pins the
 * key set to the enum).
 */
export const PriceFormulaDefaultsSchema: z.ZodType<PriceFormulaDefaults> = z.strictObject({
  rental: FirestoreId.nullable(),
  replacement: FirestoreId.nullable(),
  sale: FirestoreId.nullable(),
  service: FirestoreId.nullable(),
  surcharge: FirestoreId.nullable(),
  transaction_fee: FirestoreId.nullable(),
});

/** Zod schema for {@link PricingSettings}. */
export const PricingSettingsSchema: z.ZodType<PricingSettings> = z.strictObject({
  uid: z.literal("pricing"),
  price_formula_defaults: PriceFormulaDefaultsSchema,
  version: z.int().min(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Pricing Settings",
  collection: "settings",
  displayDefaults: {
    columns: ["updated_at"],
    filters: {},
    sort: { column: "updated_at", direction: "desc" },
  },
});

/** Body of `PUT /settings/pricing`. `version` is the optimistic-lock check (`0` creates the singleton). */
export interface UpdatePricingSettingsInput {
  price_formula_defaults: PriceFormulaDefaults;
  version: number;
}

/** Zod schema for {@link UpdatePricingSettingsInput}. */
export const UpdatePricingSettingsInputSchema: z.ZodType<UpdatePricingSettingsInput> = z.strictObject({
  price_formula_defaults: PriceFormulaDefaultsSchema,
  version: z.int().min(0),
});
