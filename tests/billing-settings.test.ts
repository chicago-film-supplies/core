import { assertEquals } from "@std/assert";
import { BillingSettingsSchema, UpdateBillingSettingsInputSchema } from "../src/schemas/billing-settings.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const actor = { uid: "manager-bot", name: "Manager Bot" };
const CLEANING = "bPBfovL4xymy9ungfn1S";
const MAINTENANCE = "1Fbk1xG7huV9we7qMSbo";

const doc = {
  uid: "billing",
  oos_charge_products: { cleaning: CLEANING, maintenance: MAINTENANCE },
  version: 0,
  created_by: actor,
  updated_by: actor,
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
};

Deno.test("BillingSettingsSchema validates the singleton, with either product unset", () => {
  assertEquals(BillingSettingsSchema.safeParse(doc).success, true);
  assertEquals(
    BillingSettingsSchema.safeParse({ ...doc, oos_charge_products: { cleaning: null, maintenance: null } }).success,
    true,
  );
});

Deno.test("BillingSettingsSchema rejects a uid other than 'billing', a non-id product and extra keys", () => {
  assertEquals(BillingSettingsSchema.safeParse({ ...doc, uid: "other" }).success, false);
  assertEquals(
    BillingSettingsSchema.safeParse({ ...doc, oos_charge_products: { cleaning: "not an id", maintenance: null } }).success,
    false,
  );
  assertEquals(BillingSettingsSchema.safeParse({ ...doc, extra: 1 }).success, false);
  // An omitted reason is not the same as an unset one: the key set is closed.
  assertEquals(BillingSettingsSchema.safeParse({ ...doc, oos_charge_products: { cleaning: CLEANING } }).success, false);
});

Deno.test("UpdateBillingSettingsInputSchema carries the version and refuses stored-only fields", () => {
  const input = { oos_charge_products: { cleaning: CLEANING, maintenance: null }, version: 3 };
  assertEquals(UpdateBillingSettingsInputSchema.safeParse(input).success, true);
  assertEquals(UpdateBillingSettingsInputSchema.safeParse({ oos_charge_products: input.oos_charge_products }).success, false);
  assertEquals(UpdateBillingSettingsInputSchema.safeParse({ ...input, uid: "billing" }).success, false);
});
