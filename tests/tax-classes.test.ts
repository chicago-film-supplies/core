/**
 * The class rule over the PROD catalog (api-cloudrun#993).
 *
 * The fixture is the prod `taxes` rows of 2026-09-13 run through the retired
 * migration (`tests/helpers/legacyTaxCatalog.ts`) — the grouping the step-3
 * backfill wrote. The parity sweep against the legacy `(taxed_as ?? type)` rule
 * that stood here until the contract step is deleted with that rule. Two things
 * the plan's own class table got wrong, and this fixture corrects:
 *
 * - **Paxton Sales Tax is in Rental, Sale and Replacement.** Both Paxton
 *   versions list `[rental, sale, replacement]`; the registration is closed,
 *   not the tax, and frozen documents still resolve it.
 * - **"No Tax" does not migrate.** It carries `jurisdiction: null`, which no
 *   code can; the Non-Taxable class (`uid_tax_codes: []`) says the same thing.
 */
import { assertEquals } from "@std/assert";
import {
  getInitialValues,
  OrderDocLineItem,
  type TaxClass,
  TaxClassSchema,
  type TaxCode,
  TaxCodeSchema,
  TaxRateSchema,
} from "../src/schemas/mod.ts";
import { COLLECTING_JURISDICTIONS } from "../src/utils/taxes.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type LegacyTaxRow, migrateLegacyTaxCatalog } from "./helpers/legacyTaxCatalog.ts";
import {
  deriveLineTaxClass,
  lineTaxClass,
  pricingTaxesOf,
  resolveClassTaxes,
  type TaxCatalog,
  taxClassMatrix,
  validateTaxSetup,
} from "../src/utils/tax-classes.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

// ── the prod catalog, 2026-09-13 (read-only MCP query of `taxes`) ─────────

/** A prod `taxes` row as queried, completed to a stored `Tax` below. */
type LegacyRow = Pick<LegacyTaxRow, "uid" | "name" | "rate" | "type" | "applied_from" | "applied_to"> & {
  jurisdiction: string | null;
  item_types: string[];
  xero_tax_type: string | null;
  xero_account_code?: number | null;
  xero_item_code?: string | null;
};

const PROD_TAXES: LegacyRow[] = [
  { uid: "0sfD0ca1LvwWR0pTJtqw", name: "Frankfort Sales Tax", rate: 8, type: "percent", jurisdiction: "frankfort", item_types: ["rental", "sale", "replacement"], applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: "2026-08-19T00:00:00.000-05:00", xero_tax_type: "TAX007" },
  { uid: "NJc430kShJ0GRj7uvaQZ", name: "Chicago Sales Tax", rate: 10.25, type: "percent", jurisdiction: "chicago", item_types: ["sale", "replacement"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-08-19T00:00:00.000-05:00", xero_tax_type: "TAX001" },
  { uid: "VDPGuO3vfCfI25V0DMW2", name: "Rantoul Sales Tax", rate: 9, type: "percent", jurisdiction: "rantoul", item_types: ["rental", "sale", "replacement"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-12-01T00:00:00.000-06:00", xero_tax_type: "TAX004" },
  { uid: "VEW4Ivy7VNqgxFA5eJw6", name: "Chicago Rental Tax", rate: 15, type: "percent", jurisdiction: "chicago", item_types: ["rental"], applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: "2026-12-01T00:00:00.000-06:00", xero_tax_type: "TAX006" },
  { uid: "Yh6WnEGqElp6UEO3Uyek", name: "Frankfort Sales Tax", rate: 8.25, type: "percent", jurisdiction: "frankfort", item_types: ["rental", "sale", "replacement"], applied_from: "2026-08-19T00:00:00.000-05:00", applied_to: "2026-12-01T00:00:00.000-06:00", xero_tax_type: "TAX009" },
  { uid: "csOfsSeE2pgelplcDROu", name: "Paxton Sales Tax", rate: 6.25, type: "percent", jurisdiction: "paxton", item_types: ["rental", "sale", "replacement"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-01-01T00:00:00.000-06:00", xero_tax_type: "TAX005" },
  { uid: "dtTboGtD0f2iwRlDGOBH", name: "Chicago Sales Tax", rate: 10.5, type: "percent", jurisdiction: "chicago", item_types: ["sale", "replacement"], applied_from: "2026-08-19T00:00:00.000-05:00", applied_to: "2026-12-01T00:00:00.000-06:00", xero_tax_type: "TAX008" },
  { uid: "h7YpvowCIhZscHU7YRyd", name: "No Tax", rate: 0, type: "percent", jurisdiction: null, item_types: [], applied_from: "2026-03-27T00:00:00.000-05:00", applied_to: null, xero_tax_type: "NONE" },
  { uid: "jvsOUs8nR4DXElcVNqJc", name: "Chicago Bottled Water Tax", rate: 0.05, type: "flat", jurisdiction: "chicago", item_types: [], applied_from: "2026-03-27T00:00:00.000-05:00", applied_to: null, xero_tax_type: null, xero_account_code: 2210, xero_item_code: "619" },
  { uid: "nH9TjML9Jfwfnm9g9G3j", name: "Chicago Rental Tax", rate: 9, type: "percent", jurisdiction: "chicago", item_types: ["rental"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2025-01-01T00:00:00.000-06:00", xero_tax_type: "TAX002" },
  { uid: "uCM5n4ZNgsVc1fyMQbHq", name: "Paxton Sales Tax", rate: 0, type: "percent", jurisdiction: "paxton", item_types: ["rental", "sale", "replacement"], applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: null, xero_tax_type: "NONE" },
  { uid: "xmxiaT32ehsEnrgrKWW8", name: "Chicago Rental Tax", rate: 11, type: "percent", jurisdiction: "chicago", item_types: ["rental"], applied_from: "2025-01-01T00:00:00.000-06:00", applied_to: "2026-01-01T00:00:00.000-06:00", xero_tax_type: "TAX003" },
];
const LEGACY: LegacyTaxRow[] = PROD_TAXES.map((t) => ({
  crms_id: null,
  applied_from_fs: mockTimestamp,
  applied_to_fs: t.applied_to === null ? null : mockTimestamp,
  effective_from: null,
  xero_components: [],
  version: 0,
  created_by: { uid: "testuser100000000000", name: "Test User" },
  updated_by: { uid: "testuser100000000000", name: "Test User" },
  created_at: mockTimestamp,
  updated_at: mockTimestamp,
  ...t,
}) as unknown as LegacyTaxRow);
const BOTTLE_RATE_UID = "jvsOUs8nR4DXElcVNqJc";

// ── the migration: the same function the backfill runs ───────────────────

const actor = { uid: "testuser100000000000", name: "Test User" };
let minted = 0;
const EMPTY: TaxCatalog = { codes: [], rates: [], classes: [] };
const MIGRATED = migrateLegacyTaxCatalog(LEGACY, EMPTY, {
  actor,
  now: mockTimestamp,
  mintUid: () => `minted${String(++minted).padStart(14, "0")}`,
});
const { codes: CODES, rates: RATES, classes: CLASSES } = MIGRATED;

const CODE_UID: Record<string, string> = Object.fromEntries(CODES.map((c) => [c.name, c.uid]));
const classUid = (name: string) => CLASSES.find((c) => c.name === name)!.uid;
const CLASS_UID = {
  rental: classUid("Rental"),
  sale: classUid("Sale"),
  bottled: classUid("Sale – Bottled Water"),
  replacement: classUid("Replacement"),
  none: classUid("Non-Taxable"),
} as const;
const CLASS_BY_UID = (uid: string) => CLASSES.find((c) => c.uid === uid)!;
const namesOf = (uids: readonly string[]) => uids.map((u) => CODES.find((c) => c.uid === u)!.name).sort();

const CATALOG: TaxCatalog = { codes: CODES, rates: RATES, classes: CLASSES };

// ── the migrated catalog is valid ────────────────────────────────────────

Deno.test("migration: every migrated document parses, and prod's 12 taxes become 6 codes and 11 rates", () => {
  for (const doc of CODES) assertEquals(TaxCodeSchema.safeParse(doc).success, true, doc.name);
  for (const doc of RATES) assertEquals(TaxRateSchema.safeParse(doc).success, true, doc.uid);
  for (const doc of CLASSES) assertEquals(TaxClassSchema.safeParse(doc).success, true, doc.name);
  assertEquals([CODES.length, RATES.length, CLASSES.length], [6, 11, 5]);
});

Deno.test("migration: Paxton is in Rental, Sale and Replacement — the plan's table omitted it", () => {
  for (const uid of [CLASS_UID.rental, CLASS_UID.sale, CLASS_UID.replacement]) {
    assertEquals(CLASSES.find((c) => c.uid === uid)!.uid_tax_codes.includes(CODE_UID["Paxton Sales Tax"]), true);
  }
});

Deno.test("migration: the class table, by code name — independent of how the migration derives it", () => {
  const sales = ["Chicago Sales Tax", "Frankfort Sales Tax", "Paxton Sales Tax", "Rantoul Sales Tax"];
  assertEquals(namesOf(CLASS_BY_UID(CLASS_UID.rental).uid_tax_codes), ["Chicago Rental Tax", "Frankfort Sales Tax", "Paxton Sales Tax", "Rantoul Sales Tax"]);
  assertEquals(namesOf(CLASS_BY_UID(CLASS_UID.sale).uid_tax_codes), sales);
  assertEquals(namesOf(CLASS_BY_UID(CLASS_UID.replacement).uid_tax_codes), sales);
  assertEquals(namesOf(CLASS_BY_UID(CLASS_UID.bottled).uid_tax_codes), ["Chicago Bottled Water Tax", ...sales].sort());
  assertEquals(CLASS_BY_UID(CLASS_UID.none).uid_tax_codes, []);
  assertEquals(MIGRATED.skipped.map((s) => s.name), ["No Tax"]);
});

Deno.test("validateTaxSetup: the migrated prod catalog is clean", () => {
  assertEquals(validateTaxSetup(CATALOG), []);
});

// ── deriveLineTaxClass: a line the API has not stamped yet ──────────────

// `getInitialValues` seeds the required `uid_tax_class` as "", which states no
// class (`lineTaxClass`), so these lines still derive from `type`.
const lineBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;

/** An unstamped line: `type`, and an optional bottle levy ref it carries. */
function unstampedLine(type: string, bottle: boolean): LineItem {
  return {
    ...lineBase,
    uid: "item",
    path: ["item"],
    name: "Line",
    type,
    quantity: 3,
    price: {
      ...(lineBase.price as Record<string, unknown>),
      base_cents: 10000,
      chargeable_days: 5,
      subtotal_cents: 10000,
      subtotal_discounted_cents: 10000,
      total_cents: 10000,
      taxes: bottle ? [{ uid: BOTTLE_RATE_UID, name: "Chicago Bottled Water Tax", rate: 0.05, type: "flat", amount_cents: 15 }] : [],
    },
  } as unknown as LineItem;
}

const sorted = (xs: string[]) => [...xs].sort();

Deno.test("deriveLineTaxClass: an unstamped line takes the default class for its type", () => {
  const cases: Array<[type: string, bottle: boolean, expected: string]> = [
    ["rental", false, CLASS_UID.rental],
    ["sale", false, CLASS_UID.sale],
    ["sale", true, CLASS_UID.bottled],
    ["replacement", false, CLASS_UID.replacement],
    ["service", false, CLASS_UID.none],
    ["surcharge", false, CLASS_UID.none],
  ];
  for (const [type, bottle, expected] of cases) {
    assertEquals(deriveLineTaxClass(unstampedLine(type, bottle) as never, CATALOG), expected, `${type}/${bottle}`);
  }
});

Deno.test("deriveLineTaxClass: a stamp and an override win over the type default", () => {
  const line = { type: "sale", uid_tax_class: CLASS_UID.rental, uid_tax_class_override: null };
  assertEquals(deriveLineTaxClass(line, CATALOG), CLASS_UID.rental);
  assertEquals(deriveLineTaxClass({ ...line, uid_tax_class_override: CLASS_UID.none }, CATALOG), CLASS_UID.none);
});

Deno.test("🔴 deriveLineTaxClass: a carried PERCENT ref never widens the class — only a flat levy does", () => {
  // A service line still holding a Chicago Rental ref (a stale price) must stay
  // Non-Taxable; widening to Rental would tax it. `taxed_as: "none"` used to
  // short-circuit this before it was retired.
  const rentalRate = RATES.find((r) => r.uid_tax_code === CODE_UID["Chicago Rental Tax"])!;
  const service = unstampedLine("service", false);
  (service.price as { taxes: unknown[] }).taxes = [{ uid: rentalRate.uid, name: "Chicago Rental Tax", rate: rentalRate.rate, type: "percent", amount_cents: 1500 }];
  assertEquals(deriveLineTaxClass(service as never, CATALOG), CLASS_UID.none);
});

Deno.test("deriveLineTaxClass: an ambiguous carried code keeps the default rather than guessing", () => {
  const twin = { ...CLASS_BY_UID(CLASS_UID.bottled), uid: "twinclass00000000000", name: "Twin" };
  const catalog = { ...CATALOG, classes: [...CLASSES, twin] };
  assertEquals(deriveLineTaxClass(unstampedLine("sale", true) as never, catalog), CLASS_UID.sale);
});

Deno.test("pricingTaxesOf: one entry per rate, named by its code, legacy uids intact", () => {
  const pricing = pricingTaxesOf(CATALOG);
  assertEquals(pricing.length, RATES.length);
  assertEquals(sorted(pricing.map((p) => p.uid)), sorted(LEGACY.filter((t) => t.name !== "No Tax").map((t) => t.uid)));
  assertEquals(pricing.find((p) => p.uid === BOTTLE_RATE_UID)?.name, "Chicago Bottled Water Tax");
});

Deno.test("resolveClassTaxes: the lapsed-review fall-forward is reported as expired, not dropped", () => {
  const r = resolveClassTaxes(CLASS_UID.rental, "chicago", false, "2027-06-15T00:00:00.000-05:00", CATALOG);
  assertEquals(r.applied.map((a) => [a.rate.uid, a.expired]), [["VEW4Ivy7VNqgxFA5eJw6", true]]);
});

// ── resolveClassTaxes: explain, frozen, exempt ───────────────────────────

Deno.test("resolveClassTaxes explains every code in the class, in class order", () => {
  const r = resolveClassTaxes(CLASS_UID.bottled, "frankfort", false, "2026-09-13T00:00:00.000-05:00", CATALOG);
  assertEquals(
    r.considered.map((c) => [c.name, c.outcome]),
    [
      ["Chicago Sales Tax", "wrong_jurisdiction"],
      ["Frankfort Sales Tax", "matched"],
      ["Paxton Sales Tax", "wrong_jurisdiction"],
      ["Rantoul Sales Tax", "wrong_jurisdiction"],
      ["Chicago Bottled Water Tax", "wrong_jurisdiction"],
    ],
  );
  assertEquals(r.applied.map((a) => a.rate.uid), ["Yh6WnEGqElp6UEO3Uyek"]);
});

Deno.test("resolveClassTaxes: a Chicago bottle line carries sales tax AND the levy — never compounded", () => {
  const r = resolveClassTaxes(CLASS_UID.bottled, "chicago", false, "2026-09-13T00:00:00.000-05:00", CATALOG);
  assertEquals(sorted(r.applied.map((a) => a.code.name)), ["Chicago Bottled Water Tax", "Chicago Sales Tax"]);
});

Deno.test("resolveClassTaxes: a frozen document keeps the rate it was billed at", () => {
  const today = resolveClassTaxes(CLASS_UID.sale, "chicago", false, "2026-09-13T00:00:00.000-05:00", CATALOG);
  assertEquals(today.applied.map((a) => a.rate.rate), [10.5]);
  const frozen = resolveClassTaxes(
    CLASS_UID.sale,
    "chicago",
    false,
    "2026-09-13T00:00:00.000-05:00",
    CATALOG,
    new Set(["NJc430kShJ0GRj7uvaQZ"]),
  );
  assertEquals(frozen.applied.map((a) => a.rate.rate), [10.25]);
});

Deno.test("resolveClassTaxes: exempt keeps base and empties applied", () => {
  const r = resolveClassTaxes(CLASS_UID.rental, "chicago", true, "2026-09-13T00:00:00.000-05:00", CATALOG);
  assertEquals([r.base.length, r.applied.length], [1, 0]);
});

Deno.test("resolveClassTaxes: no class, an unknown class and no_nexus are all untaxed, never a throw", () => {
  for (const [uid, j] of [[null, "chicago"], ["classmissing00000000", "chicago"], [CLASS_UID.rental, "no_nexus"]] as const) {
    assertEquals(resolveClassTaxes(uid, j, false, "2026-09-13T00:00:00.000-05:00", CATALOG).applied, []);
  }
});

Deno.test("lineTaxClass: the override beats the snapshot, and absence is null", () => {
  assertEquals(lineTaxClass({ uid_tax_class: "a", uid_tax_class_override: "b" }), "b");
  assertEquals(lineTaxClass({ uid_tax_class: "a", uid_tax_class_override: null }), "a");
  assertEquals(lineTaxClass({}), null);
});

Deno.test("taxClassMatrix: one row per active class, a cell per collecting jurisdiction", () => {
  const m = taxClassMatrix(CATALOG, "2026-09-13T00:00:00.000-05:00", COLLECTING_JURISDICTIONS);
  const bottled = m.find((row) => row.tax_class.uid === CLASS_UID.bottled)!;
  assertEquals(
    bottled.cells.map((c) => [c.jurisdiction, sorted(c.rates.map((r) => `${r.name} ${r.rate}`))]),
    [
      ["chicago", ["Chicago Bottled Water Tax 0.05", "Chicago Sales Tax 10.5"]],
      ["rantoul", ["Rantoul Sales Tax 9"]],
      ["frankfort", ["Frankfort Sales Tax 8.25"]],
    ],
  );
});

// ── validateTaxSetup: every planted violation is caught ──────────────────

const codesOf = (violations: ReturnType<typeof validateTaxSetup>) => violations.map((v) => v.code);
const withClass = (uid: string, patch: Partial<TaxClass>): TaxCatalog => ({
  ...CATALOG,
  classes: CATALOG.classes.map((c) => (c.uid === uid ? { ...c, ...patch } : c)),
});

Deno.test("validateTaxSetup: two percent codes live in one jurisdiction of one class", () => {
  const drifted = withClass(CLASS_UID.sale, {
    uid_tax_codes: [...CLASSES[1].uid_tax_codes, CODE_UID["Chicago Rental Tax"]],
  });
  assertEquals(codesOf(validateTaxSetup(drifted)), ["multiple_percent_rates"]);
});

Deno.test("validateTaxSetup: two percent codes in one jurisdiction whose windows never meet are fine", () => {
  const retiredPaxton: TaxCode = { ...CODES[4], uid: "codepaxtonold0000000", name: "Paxton Old" };
  const catalog: TaxCatalog = {
    codes: [...CODES, retiredPaxton],
    rates: [
      ...RATES.filter((r) => r.uid !== "csOfsSeE2pgelplcDROu"),
      { ...RATES.find((r) => r.uid === "csOfsSeE2pgelplcDROu")!, uid_tax_code: retiredPaxton.uid },
    ],
    classes: CATALOG.classes.map((c) =>
      c.uid === CLASS_UID.sale ? { ...c, uid_tax_codes: [...c.uid_tax_codes, retiredPaxton.uid] } : c
    ),
  };
  assertEquals(codesOf(validateTaxSetup(catalog)).includes("multiple_percent_rates"), false);
});

Deno.test("validateTaxSetup: overlapping and gapped versions of one code", () => {
  const overlap = RATES.map((r) => (r.uid === "nH9TjML9Jfwfnm9g9G3j" ? { ...r, applied_to: "2025-06-01T00:00:00.000-05:00" } : r));
  assertEquals(codesOf(validateTaxSetup({ ...CATALOG, rates: overlap })), ["rate_overlap"]);
  const gap = RATES.map((r) => (r.uid === "nH9TjML9Jfwfnm9g9G3j" ? { ...r, applied_to: "2024-06-01T00:00:00.000-05:00" } : r));
  assertEquals(codesOf(validateTaxSetup({ ...CATALOG, rates: gap })), ["rate_gap"]);
});

Deno.test("validateTaxSetup: a rate whose type disagrees with its code, and a rate naming no code", () => {
  const wrongType = RATES.map((r) => (r.uid === BOTTLE_RATE_UID ? { ...r, type: "percent" as const } : r));
  assertEquals(codesOf(validateTaxSetup({ ...CATALOG, rates: wrongType })), ["rate_type_mismatch"]);
  const orphan = [...RATES, { ...RATES[0], uid: "orphanrate0000000000", uid_tax_code: "codemissing000000000" }];
  assertEquals(codesOf(validateTaxSetup({ ...CATALOG, rates: orphan })), ["orphan_rate"]);
});

Deno.test("validateTaxSetup: a percent successor rate that drops its Xero TaxType, found out of stored order", () => {
  // Chicago Rental 11% (TAX003) → 15%. Reversed, because stored order is not applied order.
  const lost = [...RATES].reverse().map((r) => (r.uid === "VEW4Ivy7VNqgxFA5eJw6" ? { ...r, xero_tax_type: null } : r));
  const violations = validateTaxSetup({ ...CATALOG, rates: lost });
  assertEquals(codesOf(violations), ["xero_tax_type_lost"]);
  assertEquals(violations[0].uids, ["xmxiaT32ehsEnrgrKWW8", "VEW4Ivy7VNqgxFA5eJw6"]);
  // An uncoded PREDECESSOR followed by coded successors loses nothing.
  const firstUncoded = RATES.map((r) => (r.uid === "nH9TjML9Jfwfnm9g9G3j" ? { ...r, xero_tax_type: null } : r));
  assertEquals(validateTaxSetup({ ...CATALOG, rates: firstUncoded }), []);
});

Deno.test("validateTaxSetup: an effective_from after applied_from", () => {
  const late = RATES.map((r) => (r.uid === "VEW4Ivy7VNqgxFA5eJw6" ? { ...r, effective_from: "2026-07-01T00:00:00.000-05:00" } : r));
  const violations = validateTaxSetup({ ...CATALOG, rates: late });
  assertEquals(codesOf(violations), ["effective_after_applied"]);
  assertEquals(violations[0].uids, ["VEW4Ivy7VNqgxFA5eJw6"]);
  // Equal or earlier is the ordinary late discovery, not a violation.
  const onTime = RATES.map((r) => (r.uid === "VEW4Ivy7VNqgxFA5eJw6" ? { ...r, effective_from: r.applied_from } : r));
  assertEquals(validateTaxSetup({ ...CATALOG, rates: onTime }), []);
  const earlier = RATES.map((r) => (r.uid === "VEW4Ivy7VNqgxFA5eJw6" ? { ...r, effective_from: "2025-12-01T00:00:00.000-06:00" } : r));
  assertEquals(validateTaxSetup({ ...CATALOG, rates: earlier }), []);
});

Deno.test("validateTaxSetup: unknown and inactive codes in a class", () => {
  assertEquals(
    codesOf(validateTaxSetup(withClass(CLASS_UID.none, { uid_tax_codes: ["codemissing000000000"] }))),
    ["unknown_code_in_class"],
  );
  const retired = { ...CATALOG, codes: CODES.map((c) => (c.uid === CODE_UID["Chicago Bottled Water Tax"] ? { ...c, active: false } : c)) };
  assertEquals(codesOf(validateTaxSetup(retired)), ["inactive_code_in_class"]);
});

Deno.test("validateTaxSetup: a product type defaulted by two active classes, and duplicate names", () => {
  assertEquals(
    codesOf(validateTaxSetup(withClass(CLASS_UID.bottled, { is_default_for: ["sale"] }))),
    ["duplicate_type_default"],
  );
  assertEquals(codesOf(validateTaxSetup(withClass(CLASS_UID.bottled, { name: "Sale" }))), ["duplicate_class_name"]);
  const dupeCode = { ...CATALOG, codes: [...CODES, { ...CODES[0], uid: "codedupe000000000000" }] };
  assertEquals(codesOf(validateTaxSetup(dupeCode)), ["duplicate_code_name"]);
});

Deno.test("validateTaxSetup: an INACTIVE class is exempt from the pricing invariants", () => {
  const inactive = withClass(CLASS_UID.sale, {
    active: false,
    uid_tax_codes: [...CLASSES[1].uid_tax_codes, CODE_UID["Chicago Rental Tax"]],
  });
  // Deactivating Sale leaves "sale" with no default — that, and only that, is reported.
  assertEquals(codesOf(validateTaxSetup(inactive)), ["missing_type_default"]);
});

Deno.test("validateTaxSetup: a line type with no active default class", () => {
  const cleared = withClass(CLASS_UID.none, { is_default_for: [] });
  const violations = validateTaxSetup(cleared);
  assertEquals(codesOf(violations), ["missing_type_default", "missing_type_default", "missing_type_default"]);
  assertEquals(violations.map((v) => v.message), [
    'No active tax class is the default for "service" lines.',
    'No active tax class is the default for "surcharge" lines.',
    'No active tax class is the default for "transaction_fee" lines.',
  ]);
  assertEquals(validateTaxSetup(CATALOG), []);
});

Deno.test("lineTaxClass: an empty string (the form seed) states no class", () => {
  assertEquals(lineTaxClass({ uid_tax_class: "" }), null);
  assertEquals(lineTaxClass({ uid_tax_class: "", uid_tax_class_override: "" }), null);
  assertEquals(lineTaxClass({ uid_tax_class: "classA", uid_tax_class_override: "" }), "classA");
  assertEquals(lineTaxClass({ uid_tax_class: "classA", uid_tax_class_override: "classB" }), "classB");
});
