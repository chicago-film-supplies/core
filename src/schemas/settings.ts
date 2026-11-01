/**
 * The `settings` collection — one fixed-id singleton per concern, discriminated
 * on `uid`: `settings/billing` ({@link BillingSettings}) and `settings/pricing`
 * ({@link PricingSettings}). The registry maps one collection to one schema, so
 * the collection's schema is this union.
 */
import { z } from "zod";
import { type BillingSettings, BillingSettingsSchema } from "./billing-settings.ts";
import { type PricingSettings, PricingSettingsSchema } from "./pricing-settings.ts";

/** Any `settings/{uid}` document. Narrow on `uid`. */
export type SettingsDocument = BillingSettings | PricingSettings;

/**
 * Zod schema for {@link SettingsDocument}. A plain `z.union`: each member is a
 * strict object pinned by its literal `uid`, so exactly one member can parse a
 * document, and a type-erased member (`z.ZodType<…>`, the export form JSR's
 * `no-slow-types` needs) is not a `ZodObject` a `discriminatedUnion` accepts.
 */
export const SettingsSchema: z.ZodType<SettingsDocument> = z.union([BillingSettingsSchema, PricingSettingsSchema]).meta({
  title: "Settings",
  collection: "settings",
  displayDefaults: {
    columns: ["updated_at"],
    filters: {},
    sort: { column: "updated_at", direction: "desc" },
  },
});
