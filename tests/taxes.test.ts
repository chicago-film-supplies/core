import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues, OrderDocLineItem } from "../src/schemas/mod.ts";
import {
  deriveOrderTaxAsOf,
  findTaxAt,
  getEffectiveProfileTax,
  isEntirelyOutOfIllinois,
  materializeDocumentTax,
  materializeOrderTax,
  overrideItemTaxesForProfile,
  resolveEffectiveProfile,
  TAX_PROFILE_OVERRIDE_NAME,
  assertCoaTaxMapCoversCore,
  defaultTaxNameForLine,
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

Deno.test("🔴 a REPLACEMENT line ignores the doc/org jurisdiction override", () => {
  // Owner, 2026-08-20: every replacement item is a sale in which CFS is the END
  // USER — the customer is buying it *for CFS* — so it sources to the ORIGIN, not
  // to wherever the rental went. A Frankfort customer's replacement is a Chicago
  // sale, which is what the live Xero ledger has always billed (invoice 2348).
  const items = [makeItem({ type: "replacement" })];
  const before = structuredClone(px(items[0]).taxes);
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(
    px(items[0]).taxes,
    before,
    "the Frankfort override must not reach a replacement line",
  );
});

Deno.test("…and the same for an ORGANIZATION-level jurisdiction claim", () => {
  // ⚠️ `null` for the document, NOT "tax_applied". An explicit doc profile WINS
  // over the org's, so passing one makes `getEffectiveProfileTax` return null
  // and the whole function early-returns — the test would then pass with the
  // replacement arm deleted, which is exactly what a planted removal showed.
  const items = [makeItem({ type: "replacement" })];
  const before = structuredClone(px(items[0]).taxes);
  overrideItemTaxesForProfile(items, "tax_rantoul", null, CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, before, "the org rung must not reach it either");
});

Deno.test("…but a NON-replacement line on the same document still takes the override", () => {
  // The arm must be narrow: it is about the item type, not about the document.
  const items = [makeItem({ type: "replacement" }), makeItem({ type: "rental" })];
  // The fixture seeds both lines with the SAME tax, so "unchanged" and
  // "overridden" are distinguishable without asserting a name the fixture
  // happens to pick.
  const seeded = px(items[0]).taxes[0].name;
  overrideItemTaxesForProfile(items, "tax_applied", "tax_frankfort", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes[0].name, seeded, "the replacement keeps what it was authored with");
  assertEquals(px(items[1]).taxes[0].name, "Frankfort Sales Tax", "the rental takes the override");
});

Deno.test("…and EXEMPTION still applies to a replacement — a different axis", () => {
  // Exemption is a property of the CUSTOMER and zeroes tax whatever the
  // jurisdiction. Xero agrees: every untaxed replacement line in the corpus
  // belongs to a tax_exempt customer. Only the jurisdiction rung is skipped.
  const items = [makeItem({ type: "replacement" })];
  overrideItemTaxesForProfile(items, "tax_exempt", "tax_applied", CATALOG, AS_OF);
  assertEquals(px(items[0]).taxes, []);
  assertEquals(px(items[0]).total_cents, 10000);
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
  //
  // `legacy_unknown_key` is deliberately synthetic: since api-cloudrun#480 drop-
  // ped `discount_percent`, `InvoiceDocItemPrice` declares no invoice-only key
  // at all, so there is no real one to stand in for it. A key no schema declares
  // is the stronger form anyway — it cannot quietly become a key this function
  // learns about. Nothing parses here (`makeItem`'s overrides are
  // `Record<string, unknown>` and `pxFull` casts), so strictness never applies.
  const items = [makeItem({}, {
    taxes_base: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" }],
    replacement_cents: 50000, // order-only key
    legacy_unknown_key: 12, // a key NO schema declares
  })];
  materializeDocumentTax(items, "tax_applied", "tax_exempt", CATALOG, AS_OF);

  const p = pxFull(items[0]);
  assertEquals(
    (p.taxes_base as Array<{ uid: string }>)[0].uid,
    "chi-rental-tax",
    "the intrinsic snapshot survives — it is what a profile revert reads",
  );
  assertEquals(p.replacement_cents, 50000, "order-only key survives");
  assertEquals(p.legacy_unknown_key, 12, "an undeclared key survives");
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

// ── resolveEffectiveProfile + the out-of-Illinois rule ───────────

Deno.test("resolveEffectiveProfile agrees with getEffectiveProfileTax on every pair", () => {
  // The point of extracting it: the Xero TaxType mapping and the pricing engine
  // must answer the SAME question. This asserts they cannot drift — for each
  // (org, doc) pair, resolving the profile and then its Tax gives what
  // getEffectiveProfileTax gives directly.
  const profiles: Array<"tax_applied" | "tax_exempt" | "tax_rantoul" | "tax_frankfort"> = [
    "tax_applied",
    "tax_exempt",
    "tax_rantoul",
    "tax_frankfort",
  ];
  for (const org of profiles) {
    for (const doc of [...profiles, null]) {
      const viaProfile = resolveEffectiveProfile(org, doc);
      const direct = getEffectiveProfileTax(org, doc, CATALOG, AS_OF);
      if (viaProfile === "tax_exempt") {
        assertEquals(direct, "exempt", `${org}/${doc}`);
      } else {
        const name = TAX_PROFILE_OVERRIDE_NAME[viaProfile];
        const expected = name ? findTaxAt(CATALOG, name, AS_OF) : null;
        assertEquals(direct, expected, `${org}/${doc}`);
      }
    }
  }
});

Deno.test("resolveEffectiveProfile: the SCAN it replaced disagrees where it costs money", () => {
  // Fail-closed companion. The old rule was `[doc, org].find(names a location
  // tax)`; the new one is `doc ?? org`. They agree everywhere except the case
  // that matters — a doc-level "tax_applied" under a location-profile org —
  // which is prod invoice #2348. If this ever stops disagreeing, the extraction
  // has been undone.
  const scan = (org: string, doc: string | null) =>
    [doc, org].find((p) => p !== null && TAX_PROFILE_OVERRIDE_NAME[p as never]) ?? "tax_applied";

  assertEquals(scan("tax_frankfort", "tax_applied"), "tax_frankfort");
  assertEquals(resolveEffectiveProfile("tax_frankfort", "tax_applied"), "tax_applied");

  // …and they still agree on inherit, which is what makes the change surgical.
  assertEquals(scan("tax_frankfort", null), "tax_frankfort");
  assertEquals(resolveEffectiveProfile("tax_frankfort", null), "tax_frankfort");
});

const dest = (region: string | undefined) => ({ delivery: { address: { region } } });

Deno.test("isEntirelyOutOfIllinois: every destination out of state", () => {
  assertEquals(isEntirelyOutOfIllinois([dest("MO")]), true);
  assertEquals(isEntirelyOutOfIllinois([dest("MO"), dest("WI")]), true);
  assertEquals(isEntirelyOutOfIllinois([dest("Missouri")]), true);
});

Deno.test("isEntirelyOutOfIllinois: a MIXED order keeps its tax", () => {
  // `every`, not `some` — under-collecting is the expensive error.
  assertEquals(isEntirelyOutOfIllinois([dest("MO"), dest("IL")]), false);
  assertEquals(isEntirelyOutOfIllinois([dest("IL")]), false);
});

Deno.test("isEntirelyOutOfIllinois: 'Illinois' spelled out is NOT out of state", () => {
  // The corpus case. 18 of the 48 non-"IL" prod destinations are this, 13 of
  // them Chicago — a bare `region !== "IL"` would have zeroed the tax on all 18.
  assertEquals(isEntirelyOutOfIllinois([dest("Illinois")]), false);
  assertEquals(isEntirelyOutOfIllinois([dest("illinois")]), false);
  assertEquals(isEntirelyOutOfIllinois([dest("Illinois"), dest("MO")]), false);
});

Deno.test("isEntirelyOutOfIllinois: an UNRESOLVABLE region keeps the tax", () => {
  // `null` from toUsStateCode means unknown, never "not Illinois".
  assertEquals(isEntirelyOutOfIllinois([dest("")]), false);
  assertEquals(isEntirelyOutOfIllinois([dest(undefined)]), false);
  assertEquals(isEntirelyOutOfIllinois([dest("Ontario")]), false);
  assertEquals(isEntirelyOutOfIllinois([{ delivery: null }]), false);
  assertEquals(isEntirelyOutOfIllinois([dest("MO"), dest("")]), false);
});

Deno.test("isEntirelyOutOfIllinois: no destinations is not out of state", () => {
  assertEquals(isEntirelyOutOfIllinois([]), false);
  assertEquals(isEntirelyOutOfIllinois(undefined), false);
});

// ── The ORDER-side composition (api-cloudrun#4.10) ───────────────
//
// `materializeOrderTax` and `deriveOrderTaxAsOf` moved here from
// `api-cloudrun/src/lib/orderTaxPricing.ts`, because the manager had written a
// second copy of both in `src/utils/documentTax.ts` — carrying a comment saying
// the two must stay byte-for-byte identical, which is a wish rather than a
// mechanism. These arms are what makes it a mechanism.

/**
 * A destination delivering to `region`, starting `delivery_start`.
 *
 * Distinct from the `dest` above, which carries only an address: these arms
 * need the DATE half too, because the order-side composition reads both.
 */
const orderDest = (region: string | undefined, delivery_start: string | null = null) => ({
  dates: { delivery_start },
  delivery: { address: region === undefined ? null : { region } },
});

const NOW = "2026-07-02T12:00:00.000Z";

Deno.test("deriveOrderTaxAsOf: the EARLIEST delivery start wins", () => {
  // Earliest, not first: an order's destinations are in operator order, and the
  // tax point is the first time anything ships.
  assertEquals(
    deriveOrderTaxAsOf([orderDest("IL", "2026-03-04T09:00:00.000-06:00"), orderDest("IL", "2026-01-05T09:00:00.000-06:00")], NOW),
    "2026-01-05T09:00:00.000-06:00",
  );
});

Deno.test("deriveOrderTaxAsOf: earliest is by INSTANT, not by string order", () => {
  // ⚠️ The form this replaced sorted the ISO TEXT. For canonical Chicago values
  // that is accidentally correct — canonicalization makes the wall clock
  // monotonic with the instant, DST switch included — so the arm above passes
  // either way and proves nothing about the ordering rule.
  //
  // A MIXED set is what separates them, and the manager can hold one: it calls
  // this against an in-memory order where a date picker may supply a raw `Z`
  // value not yet through `toChicagoInstant`. Here `08:00-05:00` is 13:00Z and
  // sorts FIRST as text while being an hour later than `12:00Z`.
  assertEquals(
    deriveOrderTaxAsOf(
      [orderDest("IL", "2026-06-01T08:00:00.000-05:00"), orderDest("IL", "2026-06-01T12:00:00.000Z")],
      NOW,
    ),
    "2026-06-01T12:00:00.000Z",
  );
});

Deno.test("deriveOrderTaxAsOf: canonical Chicago values across a DST switch are unaffected", () => {
  // The companion, and the reason the fix is a correctness tidy rather than an
  // incident: every STORED business datetime is canonical, so no persisted order
  // could have been ordered wrongly. 01:30 CST is 07:30Z; 03:00 CDT is 08:00Z.
  assertEquals(
    deriveOrderTaxAsOf(
      [orderDest("IL", "2026-03-08T03:00:00.000-05:00"), orderDest("IL", "2026-03-08T01:30:00.000-06:00")],
      NOW,
    ),
    "2026-03-08T01:30:00.000-06:00",
  );
});

Deno.test("deriveOrderTaxAsOf: falls back to the INJECTED now, never an ambient clock", () => {
  // The injection is what lets this live in core at all: api-cloudrun passes
  // `Timestamp.now().toDate().toISOString()` and the manager passes
  // `new Date().toISOString()`, both UTC-Z, so the fallback resolves the same
  // Tax doc on either side.
  assertEquals(deriveOrderTaxAsOf([], NOW), NOW);
  assertEquals(deriveOrderTaxAsOf(undefined, NOW), NOW);
  assertEquals(deriveOrderTaxAsOf([orderDest("IL", null), null, undefined], NOW), NOW);
});

Deno.test("materializeOrderTax: an entirely out-of-state order is untaxed", () => {
  const items = [makeItem()];
  materializeOrderTax(items, "tax_applied", null, [orderDest("MO")], CATALOG, NOW);
  assertEquals(px(items[0]).taxes, []);
  // The money, not just the empty array: an untaxed line's total IS its
  // discounted subtotal.
  const priced = items[0].price as { subtotal_discounted_cents: number };
  assertEquals(px(items[0]).total_cents, priced.subtotal_discounted_cents);
});

Deno.test("materializeOrderTax: out-of-state beats an org LOCATION profile", () => {
  // The rule is applied in the DOC position, so it composes with the precedence
  // rule instead of shadowing it — exemption is sticky from either side, which
  // is why a Frankfort customer's Missouri delivery is still untaxed.
  const items = [makeItem()];
  materializeOrderTax(items, "tax_frankfort", null, [orderDest("MO")], CATALOG, NOW);
  assertEquals(px(items[0]).taxes, []);
});

Deno.test("materializeOrderTax: ONE in-state destination is enough to tax the order", () => {
  // The discriminating half. Without it the arms above would also pass against
  // an implementation that exempted everything.
  const items = [makeItem()];
  materializeOrderTax(items, "tax_frankfort", null, [orderDest("MO"), orderDest("IL")], CATALOG, NOW);
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["frankfort-tax"]);
});

Deno.test("materializeOrderTax: the org's profile is honored when the doc says nothing", () => {
  // `docProfile: null` means INHERIT, and it is the safe default: an order that
  // says nothing cannot tax an exempt customer (api-cloudrun#486).
  const items = [makeItem()];
  materializeOrderTax(items, "tax_exempt", null, [orderDest("IL")], CATALOG, NOW);
  assertEquals(px(items[0]).taxes, []);

  const rantoul = [makeItem()];
  materializeOrderTax(rantoul, "tax_rantoul", null, [orderDest("IL")], CATALOG, NOW);
  assertEquals(px(rantoul[0]).taxes.map((t) => t.uid), ["rantoul-tax"]);
});

Deno.test("materializeOrderTax: an explicit doc tax_applied BEATS an org location profile", () => {
  // The #2348 class: the operator saying "this one is ordinary" must outrank the
  // customer's Frankfort default rather than falling through to it.
  const items = [makeItem()];
  materializeOrderTax(items, "tax_frankfort", "tax_applied", [orderDest("IL")], CATALOG, NOW);
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);
});

Deno.test("materializeOrderTax: the as-of instant comes from the DELIVERY date, not now", () => {
  // The order-vs-invoice difference this whole composition exists to express: an
  // invoice resolves at `invoice.date`, an order at its earliest delivery start.
  // Here the Frankfort doc does not exist yet at the delivery date, so the
  // override resolves to nothing and the line keeps its intrinsic tax — the same
  // "no version brackets this date" case the order path handles by keeping what
  // it had rather than silently untaxing the line.
  const items = [makeItem()];
  materializeOrderTax(
    items,
    "tax_applied",
    "tax_frankfort",
    [orderDest("IL", "2025-06-01T09:00:00.000-05:00")],
    CATALOG,
    NOW,
  );
  assertEquals(px(items[0]).taxes.map((t) => t.uid), ["chi-rental-tax"]);

  // The discriminating half: the same order delivered after Frankfort's
  // `valid_from` DOES resolve the override.
  const later = [makeItem()];
  materializeOrderTax(
    later,
    "tax_applied",
    "tax_frankfort",
    [orderDest("IL", "2026-06-01T09:00:00.000-05:00")],
    CATALOG,
    NOW,
  );
  assertEquals(px(later[0]).taxes.map((t) => t.uid), ["frankfort-tax"]);
});

// ── defaultTaxNameForLine — the COA-first default rule (manager#297) ─────────
//
// These pin the two directions the 2026-08-16 corpus measurement found, because
// they behave DIFFERENTLY downstream and only one of them is self-correcting.

Deno.test("defaultTaxNameForLine: coa_revenue decides, and beats the type map", () => {
  // Direction 1 — the COA says taxed where a type-keyed map says untaxed.
  // 36 prod `service` lines sit at coa 4000 carrying Chicago Rental Tax.
  // ⚠️ NOT self-correcting downstream: `isTaxableCoa(4000)` passes, so
  // `materializeDocumentTax` prices whatever refs the line carries — none — and
  // the line is silently untaxed. This is the money half.
  assertEquals(defaultTaxNameForLine(4000, "service"), "Chicago Rental Tax");
  assertEquals(defaultTaxNameForLine(4200, "service"), "Chicago Sales Tax");
  assertEquals(defaultTaxNameForLine(4210, "service"), "Chicago Sales Tax");
  assertEquals(defaultTaxNameForLine(4200, "surcharge"), "Chicago Sales Tax");

  // Direction 2 — the COA says untaxed where a type-keyed map says taxed.
  // 105 prod `sale` lines sit at coa 4700, all carrying no tax; this is the
  // LARGER population and the one the issue had not looked at. Harmless in
  // practice because `materializeDocumentTax` clears `price.taxes` outright
  // when `isTaxableCoa` is false — but a client that seeds one shows the
  // operator a tax the save then removes.
  assertEquals(defaultTaxNameForLine(4700, "sale"), null);
  assertEquals(defaultTaxNameForLine(4800, "rental"), null);
  assertEquals(defaultTaxNameForLine(2210, "sale"), null);

  // Taxable in principle, no tax in practice — a real answer, not a miss.
  assertEquals(defaultTaxNameForLine(4140, "rental"), null);
});

Deno.test("defaultTaxNameForLine: type is the fallback ONLY when there is no account", () => {
  // A custom line carries no `coa_revenue` at all — `buildCustomOrderLine`
  // constructs no such field — so `type` is the only key it has. 99 prod lines.
  // This is why the type map survives rather than being deleted.
  assertEquals(defaultTaxNameForLine(null, "rental"), "Chicago Rental Tax");
  assertEquals(defaultTaxNameForLine(undefined, "sale"), "Chicago Sales Tax");
  assertEquals(defaultTaxNameForLine(undefined, "replacement"), "Chicago Sales Tax");

  // Untaxed by design under the fallback, not a miss.
  assertEquals(defaultTaxNameForLine(undefined, "service"), null);
  assertEquals(defaultTaxNameForLine(null, "surcharge"), null);

  // ⚠️ The fallback must NOT fire when an account is present — that would
  // restore the exact divergence this function replaces.
  assertEquals(defaultTaxNameForLine(4700, "rental"), null);
});

Deno.test("assertCoaTaxMapCoversCore: the name map covers every taxable COA", () => {
  // Fails CLOSED. A taxable COA with no entry would be silently left untaxed,
  // which is a money defect that looks like a clean run.
  assertCoaTaxMapCoversCore();
});
