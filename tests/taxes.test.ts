import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues, OrderDocLineItem } from "../src/schemas/mod.ts";
import {
  findTaxAt,
  getEffectiveProfileTax,
  materializeDocumentTax,
  overrideItemTaxesForProfile,
  TAX_PROFILE_OVERRIDE_NAME,
} from "../src/utils/taxes.ts";
import { TaxProfileEnum } from "../src/schemas/mod.ts";
import type { LineItem, Tax } from "../src/utils/orders.ts";

const lineItemBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
const priceBase = lineItemBase.price as Record<string, unknown>;

// Catalog carrying the validity window (findTaxAt needs it); other fields
// intentionally omitted to exercise the widened optional Tax type.
const CATALOG: Tax[] = [
  {
    uid: "frankfort-tax",
    name: "Frankfort Sales Tax",
    rate: 8,
    type: "percent",
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
  },
  {
    uid: "rantoul-tax",
    name: "Rantoul Sales Tax",
    rate: 9,
    type: "percent",
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
  },
  // The tax `makeItem` puts ON the line. `overrideItemTaxesForProfile` never
  // reads it — it only ever writes `taxes` — but `materializeDocumentTax`
  // reprices, and the reprice resolves the line's EXISTING uid through
  // `calculateItemTax`, which throws `Unknown tax uid` on a miss. See the
  // incomplete-catalog test at the bottom of this file.
  {
    uid: "chi-rental-tax",
    name: "Chicago Rental Tax",
    rate: 15,
    type: "percent",
    valid_from: "2026-01-01T00:00:00.000-06:00",
    valid_to: null,
  },
];

const AS_OF = "2026-07-02T00:00:00.000-05:00";

function makeItem(
  overrides: Partial<LineItem> = {},
  priceOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    ...lineItemBase,
    name: "Test Item",
    type: "rental",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      base_cents: 10000,
      chargeable_days: 5,
      subtotal_cents: 10000,
      subtotal_discounted_cents: 10000,
      total_cents: 11500,
      taxes: [{
        uid: "chi-rental-tax",
        name: "Chicago Rental Tax",
        rate: 15,
        type: "percent",
        amount_cents: 1500,
      }],
      ...priceOverrides,
    },
  } as LineItem;
}

// ── findTaxAt ────────────────────────────────────────────────────

Deno.test("findTaxAt resolves by name within the validity window", () => {
  const tax = findTaxAt(CATALOG, "Frankfort Sales Tax", AS_OF);
  assertEquals(tax?.uid, "frankfort-tax");
});

Deno.test("findTaxAt returns null when asOf precedes valid_from", () => {
  assertEquals(findTaxAt(CATALOG, "Frankfort Sales Tax", "2025-06-01T00:00:00.000-05:00"), null);
});

Deno.test("findTaxAt treats null valid_to as open-ended", () => {
  const tax = findTaxAt(CATALOG, "Frankfort Sales Tax", "2030-01-01T00:00:00.000-06:00");
  assertEquals(tax?.uid, "frankfort-tax");
});

Deno.test("findTaxAt throws on catalog drift (two same-name docs bracket asOf)", () => {
  const drifted: Tax[] = [
    ...CATALOG,
    { uid: "frankfort-dupe", name: "Frankfort Sales Tax", rate: 8, type: "percent", valid_from: "2026-01-01T00:00:00.000-06:00", valid_to: null },
  ];
  assertThrows(() => findTaxAt(drifted, "Frankfort Sales Tax", AS_OF), Error, "drift");
});

// ── getEffectiveProfileTax (precedence) ──────────────────────────

Deno.test("getEffectiveProfileTax: tax_exempt wins over a location profile", () => {
  assertEquals(getEffectiveProfileTax("tax_rantoul", "tax_exempt", CATALOG, AS_OF), "exempt");
});

Deno.test("getEffectiveProfileTax: doc-level tax_frankfort resolves the Frankfort tax", () => {
  const r = getEffectiveProfileTax("tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(typeof r === "object" && r?.uid, "frankfort-tax");
});

Deno.test("getEffectiveProfileTax: org-level tax_rantoul resolves the Rantoul tax", () => {
  // The doc INHERITS — expressed as `null`. Passing "tax_applied" here is now a
  // different question, answered by the test below.
  const r = getEffectiveProfileTax("tax_rantoul", null, CATALOG, AS_OF);
  assertEquals(typeof r === "object" && r?.uid, "rantoul-tax");
});

Deno.test("getEffectiveProfileTax: tax_applied → null (no override)", () => {
  assertEquals(getEffectiveProfileTax("tax_applied", "tax_applied", CATALOG, AS_OF), null);
});

// ── The two questions `null` split apart (api-cloudrun#486) ──────
//
// Before, "inherit" and "plain Chicago" were the same stored value, and the
// resolver SCANNED `[doc, org]` for the first location profile. So a doc-level
// "tax_applied" could not mean anything — it matched no name and fell through
// to the org's. Live in prod: invoice #2348, issued and in Xero, carries
// `tax_profile: "tax_applied"` and is taxed Frankfort 8%.

Deno.test("getEffectiveProfileTax: a doc-level tax_applied BEATS an org location profile", () => {
  assertEquals(getEffectiveProfileTax("tax_frankfort", "tax_applied", CATALOG, AS_OF), null);
});

Deno.test("getEffectiveProfileTax: null inherits the org's location profile", () => {
  const r = getEffectiveProfileTax("tax_frankfort", null, CATALOG, AS_OF);
  assertEquals(typeof r === "object" && r?.uid, "frankfort-tax");
});

Deno.test("getEffectiveProfileTax: null under a plain org is no override", () => {
  assertEquals(getEffectiveProfileTax("tax_applied", null, CATALOG, AS_OF), null);
});

Deno.test("getEffectiveProfileTax: exemption is sticky from EITHER side", () => {
  assertEquals(getEffectiveProfileTax("tax_exempt", null, CATALOG, AS_OF), "exempt");
  assertEquals(getEffectiveProfileTax("tax_exempt", "tax_applied", CATALOG, AS_OF), "exempt");
  assertEquals(getEffectiveProfileTax("tax_exempt", "tax_frankfort", CATALOG, AS_OF), "exempt");
  assertEquals(getEffectiveProfileTax("tax_applied", "tax_exempt", CATALOG, AS_OF), "exempt");
});

Deno.test("getEffectiveProfileTax: an ABSENT org profile falls back to the default", () => {
  // The backfill window — `DocumentOrganizationSnapshot.tax_profile` is optional
  // until both environments carry it. Absent must behave as the pre-#486 default
  // (no override), never as exempt and never as a throw.
  assertEquals(getEffectiveProfileTax(undefined, null, CATALOG, AS_OF), null);
  const r = getEffectiveProfileTax(undefined, "tax_frankfort", CATALOG, AS_OF);
  assertEquals(typeof r === "object" && r?.uid, "frankfort-tax");
  assertEquals(getEffectiveProfileTax(undefined, "tax_exempt", CATALOG, AS_OF), "exempt");
});

// ── overrideItemTaxesForProfile ──────────────────────────────────

// LineItem.price is a union (priceable vs transaction-fee); narrow for asserts.
const px = (it: LineItem) =>
  it.price as {
    taxes: Array<{ uid: string; name: string; rate: number; type: string; amount_cents: number }>;
    total_cents: number;
  };

Deno.test("override tax_frankfort replaces item tax with 8% Frankfort + updates total", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, [{
    uid: "frankfort-tax",
    name: "Frankfort Sales Tax",
    rate: 8,
    type: "percent",
    amount_cents: 800,
  }]);
  assertEquals(px(items[0]).total_cents, 10800);
});

Deno.test("override tax_exempt empties taxes and sets total to subtotal_discounted", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_exempt", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000);
});

Deno.test("override tax_applied leaves the item untouched (Chicago default kept)", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].uid, "chi-rental-tax");
  assertEquals(px(items[0]).total_cents, 11500);
});

Deno.test("override skips non-priceable (group) items", () => {
  const group = { ...lineItemBase, type: "group", name: "Section", uid: "grp-1" } as unknown as LineItem;
  const items = [group, makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals((items[0] as LineItem).type, "group");
  assertEquals(px(items[1]).taxes[0].uid, "frankfort-tax");
});

// ── COA gate on the profile-override path ────────────────────────
//
// `overrideItemTaxesForProfile` was the SECOND place the taxability rule was
// missing. Clean A/B from prod: #1647 (`tax_applied`) held a Delivery line with
// `taxes: []`, while #2051 (`tax_rantoul`) carried the same product at the same
// COA with a 9% tax — so the location override re-taxed exactly the lines the
// Xero push then stripped to `NONE`.

Deno.test("override does NOT re-tax a non-revenue COA under a location profile", () => {
  const items = [makeItem({ coa_revenue: 4100 })];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000, "total is the untaxed subtotal");
});

Deno.test("override still applies the location profile on a revenue COA", () => {
  // The discriminating half: same profile, same line, only `coa_revenue` differs.
  // Without it the test above would pass against a function that taxed nothing.
  const items = [makeItem({ coa_revenue: 4000 })];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes.length, 1);
  assertEquals(px(items[0]).total_cents, 10800);
});

Deno.test("override leaves an absent COA taxable (order lines carry none)", () => {
  const items = [makeItem()];
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes.length, 1);
});

// ── Every location profile must name a Tax, or it silently does nothing ──

Deno.test("every tax profile except tax_applied/tax_exempt maps to a Tax name", () => {
  // The failure mode this catches is silent: a profile added to the enum with
  // no entry here makes `getEffectiveProfileTax` return `null`, which reads as
  // "no override" — so the document keeps whatever tax it already had and
  // nothing anywhere reports a problem. `tax_paxton` exists because prod #1978
  // hit the neighbouring version of that: no Paxton profile at all, so a Paxton
  // delivery silently kept Rantoul's 9% against Xero's 6.25%.
  const special = new Set(["tax_applied", "tax_exempt"]);
  // Read off the enum itself, with NO literal fallback: a hard-coded list would
  // stop growing the day someone adds a profile, which is the exact thing being
  // guarded against. `TaxProfileEnum` is annotated `z.ZodType<TaxProfileType>`
  // for JSR's no-slow-types, so `.options` needs the cast to be visible — it is
  // there at runtime, and this throws rather than degrading if it ever is not.
  const profiles = (TaxProfileEnum as unknown as { options: string[] }).options;
  assertEquals(Array.isArray(profiles) && profiles.length > 0, true, "enum options unreadable");
  assertEquals(profiles.includes("tax_paxton"), true, "the enum is the source, not a copy");
  for (const p of profiles) {
    if (special.has(p)) {
      assertEquals(
        TAX_PROFILE_OVERRIDE_NAME[p as keyof typeof TAX_PROFILE_OVERRIDE_NAME],
        undefined,
        `${p} is handled specially and must NOT name a Tax`,
      );
      continue;
    }
    assertEquals(
      typeof TAX_PROFILE_OVERRIDE_NAME[p as keyof typeof TAX_PROFILE_OVERRIDE_NAME],
      "string",
      `${p} has no Tax name — the override would silently no-op`,
    );
  }
});

Deno.test("tax_paxton resolves the Paxton tax, and loses to tax_exempt", () => {
  const catalog: Tax[] = [
    ...CATALOG,
    {
      uid: "paxton-tax",
      name: "Paxton Sales Tax",
      rate: 6.25,
      type: "percent",
      valid_from: "2020-01-01T00:00:00.000-06:00",
      valid_to: null,
    } as Tax,
  ];
  const resolved = getEffectiveProfileTax("tax_applied", "tax_paxton", catalog, AS_OF);
  assertEquals(resolved !== null && resolved !== "exempt" && resolved.uid, "paxton-tax");
  assertEquals(getEffectiveProfileTax("tax_paxton", "tax_exempt", catalog, AS_OF), "exempt");
});

Deno.test("tax_paxton with no Paxton doc in the catalog resolves to null, not a wrong tax", () => {
  // The guard that matters: an unseeded profile must NOT fall through to
  // whichever location tax happens to be in the catalog.
  assertEquals(getEffectiveProfileTax("tax_applied", "tax_paxton", CATALOG, AS_OF), null);
});

// ── materializeDocumentTax ───────────────────────────────────────
//
// The override PLUS the reprice — the pair the order path had as
// `api-cloudrun`'s `repriceOrderItemsForProfile` and the native invoice path had
// not at all. Three things are worth pinning that the bare override cannot show:
// the org arm is a real parameter, the reprice actually happens, and the price
// rebuild is shape-agnostic.

/** Full price surface, for asserting what survived the rebuild. */
const pxFull = (it: LineItem) =>
  it.price as unknown as Record<string, unknown>;

Deno.test("materialize: an ORG-level tax_exempt exempts a tax_applied document", () => {
  // THE ARM THAT IS NEW. `repriceOrderItemsForProfile` passed the literal
  // `"tax_applied"` as the org profile, so a tax-exempt customer's ORDERS were
  // taxed while their INVOICES were not — the same customer, the same products,
  // two answers depending on which document you looked at.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_exempt", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000);
});

Deno.test("companion: the hardcoded org arm does NOT exempt, so the arm above bites", () => {
  // Sweeps the pre-change behavior — `"tax_applied"` in the org position — and
  // asserts it disagrees. Without this, the test above would keep passing
  // against a function that had quietly gone back to ignoring `orgProfile`.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_applied", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes.length, 1, "org arm ignored → the line stays taxed");
  assertEquals(px(items[0]).total_cents, 11500);
});

Deno.test("materialize: the DOC profile still beats a plain org profile", () => {
  // Precedence is unchanged — adding the org arm must not let the org override
  // the document. Org says Rantoul (9%), doc says Frankfort (8%): 8% wins.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_rantoul", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].uid, "frankfort-tax");
  assertEquals(px(items[0]).total_cents, 10800);
});

Deno.test("materialize: the org profile applies when the doc has none", () => {
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_rantoul", null, CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].uid, "rantoul-tax");
  assertEquals(px(items[0]).total_cents, 10900);
});

Deno.test("materialize: a doc-level tax_applied keeps Chicago under a Frankfort org", () => {
  // The Kenwood-films-in-Chicago case, and the repair #2348 needed. Under the
  // scan this priced Frankfort 8%; the line's own Chicago Rental 15% survives.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_frankfort", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].uid, "chi-rental-tax");
  assertEquals(px(items[0]).total_cents, 11500);
});

Deno.test("materialize: an exempt ORG zeroes the tax on a doc that says nothing", () => {
  // api-cloudrun#486 in one line — the order path passed a hardcoded
  // "tax_applied" in the org position, so this line stayed taxed.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_exempt", null, CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000);
});

Deno.test("materialize: REPRICES, where the bare override only rewrites the tax", () => {
  // The half that distinguishes the two functions. A line arriving with a stale
  // `subtotal_cents` is corrected from `base_cents × quantity × days_factor`;
  // `overrideItemTaxesForProfile` alone would leave the lie in place and compute
  // the tax off it.
  const stale = { subtotal_cents: 1, subtotal_discounted_cents: 1, total_cents: 1 };

  const bare = [makeItem({}, stale)];
  overrideItemTaxesForProfile(bare, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(pxFull(bare[0]).subtotal_cents, 1, "the bare override does not reprice");
  assertEquals(px(bare[0]).total_cents, 1, "…so the tax is computed off the stale subtotal");

  const materialized = [makeItem({}, stale)];
  materializeDocumentTax(materialized, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(pxFull(materialized[0]).subtotal_cents, 10000);
  assertEquals(pxFull(materialized[0]).subtotal_discounted_cents, 10000);
  assertEquals(px(materialized[0]).total_cents, 10800);
});

Deno.test("materialize: preserves every price key it does not compute", () => {
  // The reason the rebuild is a SPREAD. The order-side original listed the keys
  // it meant to keep, so `taxes_base` was dropped until a conditional spread was
  // added back for it specifically — and `base_percent` is still missing from
  // that list. Here the assertion is about keys the function has never heard of,
  // which is what makes one implementation safe for both document shapes.
  const items = [makeItem({}, {
    taxes_base: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" }],
    replacement_cents: 50000, // order-only key
    discount_percent: 12, // invoice-only key
  })];
  materializeDocumentTax(items, "tax_applied", "tax_exempt", CATALOG, AS_OF);

  const p = pxFull(items[0]);
  assertEquals(
    (p.taxes_base as Array<{ uid: string }>)[0].uid,
    "chi-rental-tax",
    "the intrinsic snapshot survives — it is what a profile revert reads",
  );
  assertEquals(p.replacement_cents, 50000, "order-only key survives");
  assertEquals(p.discount_percent, 12, "invoice-only key survives");
  assertEquals(p.taxes, [], "…while the override still did its job");
});

Deno.test("materialize: never writes an `undefined` price key", () => {
  // `validateBeforeWrite` rejects an explicit `undefined`, and a spread cannot
  // introduce one — but it also cannot remove one, so this asserts the absent
  // keys stay absent rather than materializing as undefined.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  const undef = Object.entries(pxFull(items[0]))
    .filter(([, v]) => v === undefined)
    .map(([k]) => k);
  assertEquals(undef, []);
});

Deno.test("materialize: a non-revenue COA is untaxed under every profile", () => {
  for (const profile of ["tax_applied", "tax_frankfort", "tax_rantoul", "tax_exempt"] as const) {
    const items = [makeItem({ coa_revenue: 4100 })];
    materializeDocumentTax(items, "tax_applied", profile, CATALOG, AS_OF);
    assertEquals(px(items[0]).taxes, [], `${profile} re-taxed a non-revenue COA`);
    assertEquals(px(items[0]).total_cents, 10000, `${profile} total`);
  }
});

Deno.test("materialize: skips non-priceable items instead of throwing on them", () => {
  // `calculateItemPrice` THROWS on a divider. The reprice loop has to guard, and
  // a document always carries dividers, so this is the common case rather than
  // an edge one.
  const items: LineItem[] = [
    { uid: "d1", name: "Stage", type: "destination", path: ["d1"] },
    { uid: "g1", name: "Camera", type: "group", path: ["d1", "g1"] },
    makeItem(),
  ];
  materializeDocumentTax(items, "tax_applied", "tax_exempt", CATALOG, AS_OF);
  assertEquals(items[0].price, undefined);
  assertEquals(px(items[2]).taxes, []);
});

Deno.test("materialize: reprices under tax_applied too — so the catalog must be COMPLETE", () => {
  // ⚠️ The trap for every caller. There is no `tax_applied` early return: the
  // override half returns early, the REPRICE half does not, and the reprice
  // resolves each line's stored `taxes[].uid` against the catalog it was handed.
  // So passing a filtered catalog — "just the profile taxes", say — throws on
  // any line carrying a tax that filter dropped, on a document with no override
  // at all. Callers pass the whole `taxes` collection.
  const withoutTheLinesOwnTax = CATALOG.filter((t) => t.uid !== "chi-rental-tax");
  assertThrows(
    () => materializeDocumentTax([makeItem()], "tax_applied", "tax_applied", withoutTheLinesOwnTax, AS_OF),
    Error,
    "Unknown tax uid",
  );

  // And the same document with the complete catalog is repriced, not thrown on —
  // otherwise the assertion above would pass against a function that always threw.
  const items = [makeItem()];
  materializeDocumentTax(items, "tax_applied", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].uid, "chi-rental-tax");
  assertEquals(px(items[0]).total_cents, 11500);
});
