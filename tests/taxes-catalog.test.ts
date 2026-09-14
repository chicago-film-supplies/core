import { assertEquals } from "@std/assert";
import { TAX_JURISDICTIONS } from "../src/schemas/common.ts";
import { CreateTaxCodeInput, TaxCodeSchema, UpdateTaxCodeInput } from "../src/schemas/taxes-code.ts";
import { CreateTaxRateInput, TaxRateSchema, UpdateTaxRateInput } from "../src/schemas/taxes-rate.ts";
import { TaxClassSchema } from "../src/schemas/taxes-class.ts";
import { COLLECTING_JURISDICTIONS } from "../src/utils/taxes.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const actor = { uid: "testuser100000000000", name: "Test User" };
const stamps = { created_by: actor, updated_by: actor, created_at: mockTimestamp, updated_at: mockTimestamp };

/** Minimal valid documents, so each negative case fails for exactly the reason it names. */
const percentCode = (o: Record<string, unknown> = {}) => ({
  uid: "testcode100000000000",
  name: "Chicago Sales Tax",
  jurisdiction: "chicago",
  type: "percent",
  xero_account_code: null,
  xero_item_code: null,
  active: true,
  ...stamps,
  ...o,
});
const flatCode = (o: Record<string, unknown> = {}) =>
  percentCode({ name: "Chicago Bottled Water Tax", type: "flat", xero_account_code: 2210, xero_item_code: "619", ...o });

const percentRate = (o: Record<string, unknown> = {}) => ({
  uid: "testrate100000000000",
  uid_tax_code: "testcode100000000000",
  rate: 10.25,
  type: "percent",
  applied_from: "2020-01-01T00:00:00.000-06:00",
  applied_from_fs: mockTimestamp,
  applied_to: null,
  applied_to_fs: null,
  effective_from: null,
  xero_tax_type: "TAX001",
  xero_components: [],
  ...stamps,
  ...o,
});

const taxClass = (o: Record<string, unknown> = {}) => ({
  uid: "testclass10000000000",
  name: "Sale – Bottled Water",
  description: null,
  uid_tax_codes: ["testcode100000000000", "testcode200000000000"],
  is_default_for: [],
  active: true,
  ...stamps,
  ...o,
});

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, doc: unknown) =>
  assertEquals(schema.safeParse(doc).success, true);
const refused = (schema: { safeParse(v: unknown): { success: boolean } }, doc: unknown) =>
  assertEquals(schema.safeParse(doc).success, false);

// ── vocabulary ─────────────────────────────────────────────────────────

Deno.test("TAX_JURISDICTIONS: every live registration can levy a tax", () => {
  for (const j of COLLECTING_JURISDICTIONS) assertEquals(TAX_JURISDICTIONS.includes(j as never), true);
});

Deno.test("TAX_JURISDICTIONS: a CLOSED registration still levies — paxton's codes outlive its derivation", () => {
  assertEquals(COLLECTING_JURISDICTIONS.includes("paxton"), false);
  ok(TaxCodeSchema, percentCode({ name: "Paxton Sales Tax", jurisdiction: "paxton" }));
});

Deno.test("TaxCodeSchema refuses no_nexus — it is an answer, not an authority", () => {
  refused(TaxCodeSchema, percentCode({ jurisdiction: "no_nexus" }));
  refused(TaxCodeSchema, percentCode({ jurisdiction: null }));
});

// ── taxes-codes ────────────────────────────────────────────────────────

Deno.test("TaxCodeSchema validates a percent and a flat code", () => {
  ok(TaxCodeSchema, percentCode());
  ok(TaxCodeSchema, flatCode());
});

Deno.test("TaxCodeSchema: a flat code must say where its Xero line posts", () => {
  refused(TaxCodeSchema, flatCode({ xero_account_code: null }));
});

Deno.test("TaxCodeSchema: a percent code carries no Xero line axes", () => {
  refused(TaxCodeSchema, percentCode({ xero_account_code: 2210 }));
  refused(TaxCodeSchema, percentCode({ xero_item_code: "619" }));
});

Deno.test("TaxCodeSchema requires `active` — the writer states it", () => {
  const { active: _omitted, ...rest } = percentCode();
  refused(TaxCodeSchema, rest);
});

Deno.test("TaxCodeSchema rejects additional properties — `item_types` did not move here", () => {
  refused(TaxCodeSchema, percentCode({ item_types: ["sale"] }));
  refused(TaxCodeSchema, percentCode({ rate: 10.25 }));
});

Deno.test("UpdateTaxCodeInput cannot carry jurisdiction or type — both are immutable", () => {
  const parsed = UpdateTaxCodeInput.safeParse({
    uid: "testcode100000000000",
    version: 1,
    jurisdiction: "frankfort",
    type: "flat",
  });
  assertEquals(parsed.success, true);
  assertEquals(parsed.success && ("jurisdiction" in parsed.data || "type" in parsed.data), false);
});

Deno.test("CreateTaxCodeInput requires a first rate — a code with none prices nothing", () => {
  const base = { name: "X", jurisdiction: "chicago", type: "percent", active: true };
  refused(CreateTaxCodeInput, base);
  ok(CreateTaxCodeInput, { ...base, first_rate: { rate: 10.25, applied_from: "2026-01-01T00:00:00.000-06:00" } });
});

// ── taxes-rates ────────────────────────────────────────────────────────

Deno.test("TaxRateSchema validates a percent and a flat rate", () => {
  ok(TaxRateSchema, percentRate());
  ok(TaxRateSchema, percentRate({ rate: 0.05, type: "flat", xero_tax_type: null }));
});

Deno.test("TaxRateSchema: percent components must sum to rate", () => {
  ok(TaxRateSchema, percentRate({ rate: 10.25, xero_components: [{ name: "a", rate: 6.25 }, { name: "b", rate: 4 }] }));
  refused(TaxRateSchema, percentRate({ rate: 10.25, xero_components: [{ name: "a", rate: 6.25 }] }));
});

Deno.test("TaxRateSchema: a flat rate has no TaxType and no components", () => {
  refused(TaxRateSchema, percentRate({ rate: 0.05, type: "flat", xero_tax_type: "TAX001" }));
  refused(
    TaxRateSchema,
    percentRate({ rate: 0.05, type: "flat", xero_tax_type: null, xero_components: [{ name: "a", rate: 0.05 }] }),
  );
});

Deno.test("TaxRateSchema rejects the fields that moved to the code", () => {
  for (const key of ["name", "jurisdiction", "item_types", "xero_account_code", "xero_item_code", "crms_id"]) {
    refused(TaxRateSchema, percentRate({ [key]: null }));
  }
});

Deno.test("TaxRateSchema refuses a bare date — a window bound is Chicago midnight with an offset", () => {
  refused(TaxRateSchema, percentRate({ applied_from: "2020-01-01" }));
});

Deno.test("CreateTaxRateInput never accepts `type` — the code states it", () => {
  const parsed = CreateTaxRateInput.safeParse({
    uid_tax_code: "testcode100000000000",
    version: 0,
    rate: 10.5,
    applied_from: "2026-08-19T00:00:00.000-05:00",
    type: "flat",
  });
  assertEquals(parsed.success && "type" in parsed.data, false);
});

Deno.test("UpdateTaxRateInput never accepts `rate` — a rate change is a new rate", () => {
  const parsed = UpdateTaxRateInput.safeParse({ uid: "testrate100000000000", version: 0, rate: 11 });
  assertEquals(parsed.success && "rate" in parsed.data, false);
});

// ── taxes-classes ──────────────────────────────────────────────────────

Deno.test("TaxClassSchema validates a class, and an empty code list is a STATED non-taxable class", () => {
  ok(TaxClassSchema, taxClass());
  ok(TaxClassSchema, taxClass({ name: "Non-Taxable", uid_tax_codes: [], is_default_for: ["service", "surcharge"] }));
});

Deno.test("TaxClassSchema requires uid_tax_codes — omitted is not the same as none", () => {
  const { uid_tax_codes: _omitted, ...rest } = taxClass();
  refused(TaxClassSchema, rest);
});

Deno.test("TaxClassSchema refuses a repeated code or product type", () => {
  refused(TaxClassSchema, taxClass({ uid_tax_codes: ["testcode100000000000", "testcode100000000000"] }));
  refused(TaxClassSchema, taxClass({ is_default_for: ["sale", "sale"] }));
});

Deno.test("TaxClassSchema refuses an unknown product type in is_default_for", () => {
  refused(TaxClassSchema, taxClass({ is_default_for: ["bottled_water"] }));
});
