/**
 * BillingSettings document schema — Firestore singleton: settings/billing
 *
 * Which `$0` `service` product bills each on-request out-of-service reason
 * (`OOS_BILLING_POLICY` in `utils/replacements.ts`). The mapping lives here and
 * not on the product so the product stays an ordinary catalog row and the
 * operator can repoint a reason without editing it.
 *
 * ⚠️ **An unset (`null`) or unknown uid hides the action; it never fails an
 * invoice.** The reader checks that the product resolves and is a `service`.
 *
 * The doc id is fixed at `billing`, so its `uid` is `"billing"` — a documented
 * exception to the auto-id rule, like `holiday-snapshot/current`. The
 * collection is named for the family (`settings`), but the registry maps one
 * collection to one schema, so a second settings document with a different
 * shape needs a union here first.
 */
import { z } from "zod";
import {
  ActorRef,
  type ActorRefType,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";
import { FirestoreId } from "./_uid.ts";

/** The on-request out-of-service reasons that have a charge product. */
export interface OosChargeProducts {
  /** Product billed for a `cleaning` record, or `null` when unset. */
  cleaning: string | null;
  /** Product billed for a `maintenance` record, or `null` when unset. */
  maintenance: string | null;
}

/** The billing settings singleton (`settings/billing`). */
export interface BillingSettings {
  uid: "billing";
  oos_charge_products: OosChargeProducts;
  /** Optimistic-lock version, bumped on every edit. */
  version: number;
  created_by: ActorRefType;
  updated_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for BillingSettings. */
export const BillingSettingsSchema: z.ZodType<BillingSettings> = z.strictObject({
  uid: z.literal("billing"),
  oos_charge_products: z.strictObject({
    cleaning: FirestoreId.nullable(),
    maintenance: FirestoreId.nullable(),
  }),
  version: z.int().min(0),
  created_by: ActorRef,
  updated_by: ActorRef,
  ...TimestampFields,
}).meta({
  title: "Billing Settings",
  collection: "settings",
  displayDefaults: {
    columns: ["updated_at"],
    filters: {},
    sort: { column: "updated_at", direction: "desc" },
  },
});

/** Body of `PUT /settings/billing`. `version` is the optimistic-lock check. */
export interface UpdateBillingSettingsInput {
  oos_charge_products: OosChargeProducts;
  version: number;
}

/** Zod schema for {@link UpdateBillingSettingsInput}. */
export const UpdateBillingSettingsInputSchema: z.ZodType<UpdateBillingSettingsInput> = z.strictObject({
  oos_charge_products: z.strictObject({
    cleaning: FirestoreId.nullable(),
    maintenance: FirestoreId.nullable(),
  }),
  version: z.int().min(0),
});
