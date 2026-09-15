import { assert, assertEquals, assertThrows } from "@std/assert";
import { getInitialValues, OrderDocLineItem } from "../src/schemas/mod.ts";
import {
  calculateItemPrice,
  calculateReplacementTotals,
  calculateTransactionFeeAmountCents,
  isPreTaxItem,
  type LineItem,
  rederiveDocumentTotalsForAudit,
} from "../src/utils/orders.ts";
import {
  extensionChargeDays,
  invoiceExtensionSections,
  type PriceDocumentContext,
  priceCreditNote,
  priceDocument,
  sumPricedLines,
} from "../src/utils/price-document.ts";
import { assignLineTaxes, type DocumentTaxContext, type TaxDestination } from "../src/utils/taxes.ts";
import { pricingTaxesOf, type TaxCatalog } from "../src/utils/tax-classes.ts";
import { type LegacyTax, type LegacyTaxRow, migrateLegacyTaxCatalog } from "./helpers/legacyTaxCatalog.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const lineItemBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
const priceBase = lineItemBase.price as Record<string, unknown>;

const CATALOG: LegacyTax[] = [
  { uid: "frankfort-tax", name: "Frankfort Sales Tax", rate: 8, type: "percent", jurisdiction: "frankfort", item_types: ["rental", "sale", "replacement"], applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: null },
  { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", jurisdiction: "chicago", item_types: ["rental"], applied_from: "2026-01-01T00:00:00.000-06:00", applied_to: null },
  { uid: "chi-sales-tax", name: "Chicago Sales Tax", rate: 10.5, type: "percent", jurisdiction: "chicago", item_types: ["sale", "replacement"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: null },
];

function catalogOf(taxes: LegacyTax[]): TaxCatalog {
  let n = 0;
  const docs = taxes.map((t) => ({
    crms_id: null,
    effective_from: null,
    applied_from_fs: mockTimestamp,
    applied_to_fs: null,
    xero_components: [],
    xero_tax_type: null,
    xero_account_code: null,
    xero_item_code: null,
    version: 0,
    ...t,
  }) as unknown as LegacyTaxRow);
  return migrateLegacyTaxCatalog(docs, { codes: [], rates: [], classes: [] }, {
    actor: { uid: "testuser100000000000", name: "Test User" },
    now: mockTimestamp,
    mintUid: () => `fixture${String(++n).padStart(13, "0")}`,
  });
}
const CAT = catalogOf(CATALOG);

const at = (city: string): TaxDestination => ({ uid: null, jurisdiction: undefined, delivery: { uid: null, address: { city, region: "IL" } } });

const taxCtx = (city = "Chicago", exempt = false): DocumentTaxContext => ({
  destinations: [at(city)],
  origin: "chicago",
  exempt,
  catalog: CAT,
  asOf: "2026-07-02T00:00:00.000-05:00",
});

const ORDER: PriceDocumentContext["document"] = { kind: "order" };
const ctx = (over: Partial<PriceDocumentContext> = {}): PriceDocumentContext => ({ document: ORDER, tax: taxCtx(), ...over });

let uidSeq = 0;
function line(over: Partial<LineItem> = {}, price: Record<string, unknown> = {}): LineItem {
  return {
    ...lineItemBase,
    uid: `line-${++uidSeq}`,
    name: "Test Item",
    type: "rental",
    quantity: 1,
    path: [`line-${uidSeq}`],
    ...over,
    price: { ...priceBase, base_cents: 10000, chargeable_days: 5, formula: "five_day_week", taxes: [], ...price },
  } as unknown as LineItem;
}
function fee(over: Partial<LineItem> = {}, price: Record<string, unknown> = {}): LineItem {
  return line({ type: "transaction_fee", name: "Card Fee", ...over }, {
    formula: "percent_of_total", base_cents: 0, base_percent: 3, chargeable_days: null, replacement_cents: null, ...price,
  });
}
const p = (it: LineItem) => it.price as unknown as {
  subtotal_cents: number; subtotal_discounted_cents: number; total_cents: number;
  discount: { amount_cents: number } | null; taxes: { name: string; amount_cents: number }[];
};

// ── Hand-written expectations ─────────────────────────────────────

Deno.test("priceDocument: a percent fee is costed on subtotal + tax and STORED on its line (D6)", () => {
  // Rental 10000, Chicago Rental Tax 15% = 1500. Basis 11500; 3% = 345.
  const r = priceDocument([line(), fee()], ctx());
  assertEquals(p(r.items[0]).total_cents, 11500);
  assertEquals(p(r.items[1]), { ...p(r.items[1]), subtotal_cents: 345, subtotal_discounted_cents: 345, total_cents: 345, discount: null, taxes: [] });
  assertEquals(r.totals.transaction_fees.map((f) => [f.name, f.type, f.rate, f.amount_cents]), [["Card Fee", "percent", 3, 345]]);
  assertEquals(r.totals.subtotal_cents, 10000);
  assertEquals(r.totals.total_cents, 11845);
});

Deno.test("priceDocument: a flat fee keeps its pre-discount subtotal and its discount", () => {
  // Fixed 500 with 10% off: subtotal 500, discounted 450, discount 50, no tax.
  const r = priceDocument(
    [line(), fee({}, { formula: "fixed", base_cents: 500, base_percent: null, discount: { type: "percent", rate: 10, amount_cents: 0 } })],
    ctx(),
  );
  const f = p(r.items[1]);
  assertEquals([f.subtotal_cents, f.subtotal_discounted_cents, f.discount?.amount_cents, f.total_cents], [500, 450, 50, 450]);
  assertEquals(r.totals.transaction_fees.map((x) => x.amount_cents), [450]);
  assertEquals(r.totals.total_cents, 11500 + 450);
});

Deno.test("priceDocument: a split bill — two invoices at 2 and 3 units total the order at 5", () => {
  const order = priceDocument([line({ quantity: 5 }, { base_cents: 1999 })], ctx());
  const inv = (q: number) => priceDocument([line({ quantity: q }, { base_cents: 1999 })], ctx({ document: { kind: "invoice", status: "draft", has_settlement: false } }));
  // 1999×2 = 3998 + 599.70→600 tax; 1999×3 = 5997 + 899.55→900 tax; order 9995 + 1499.25→1499.
  assertEquals(inv(2).totals.total_cents, 4598);
  assertEquals(inv(3).totals.total_cents, 6897);
  assertEquals(order.totals.total_cents, 11494);
  assertEquals(order.replacement_total_cents !== null, true);
  assertEquals(inv(2).replacement_total_cents, null);
});

Deno.test("priceDocument: an extension line bills its OWN added days with the week minimum skipped (D7)", () => {
  assertEquals([extensionChargeDays(4, 2), extensionChargeDays(7, 3), extensionChargeDays(4, 7)], [0, 2, -2]);
  const section = (addedDays: number | null) => {
    const divider = {
      ...lineItemBase,
      uid: "dest-ext",
      type: "destination",
      name: "Extension",
      path: ["dest-ext"],
      path_extension_for: ["dest-order"],
    } as unknown as LineItem;
    const rental = line({ path: ["dest-ext", "r1"] }, { base_cents: 10000, chargeable_days: addedDays });
    const items = [divider, rental];
    return priceDocument(items, ctx({
      document: { kind: "invoice", status: "draft", has_settlement: false },
      extensions: invoiceExtensionSections(items as unknown as Parameters<typeof invoiceExtensionSections>[0]),
    }));
  };
  // 10000 × days ÷ 5, then 15% tax. Billed 3 days, order now 7: the writer stored 2.
  assertEquals([p(section(2).items[1]).subtotal_cents, p(section(2).items[1]).total_cents], [4000, 4600]);
  assertEquals(section(2).totals.total_cents, 4600);
  // Idempotent: a re-price of the stored line reproduces the same money.
  assertEquals(p(priceDocument(section(2).items, ctx({
    document: { kind: "invoice", status: "draft", has_settlement: false },
    extensions: [{ divider_path: ["dest-ext"] }],
  })).items[1]).subtotal_cents, 4000);
  // The same line outside a section is charged its week minimum: 2 days → 10000.
  assertEquals(p(priceDocument([line({}, { chargeable_days: 2 })], ctx()).items[0]).subtotal_cents, 10000);
  // A section line with no day count has nothing to extend by.
  assertThrows(() => section(null), Error, "chargeable_days");
});

Deno.test("invoiceExtensionSections: only destination dividers carrying path_extension_for open a section", () => {
  assertEquals(
    invoiceExtensionSections([
      { type: "order", path: ["o"] },
      { type: "destination", path: ["o", "d"] },
      { type: "destination", path: ["o", "e"], path_extension_for: ["d"] },
      { type: "destination", path: ["o", "f"], path_extension_for: [] },
      { type: "rental", path: ["o", "e", "r"] },
    ]),
    [{ divider_path: ["o", "e"] }],
  );
});

Deno.test("priceDocument: an extension section refuses a fixed-formula line", () => {
  assertThrows(
    () => priceDocument([line({ type: "sale", path: ["dx", "s"] }, { formula: "fixed", chargeable_days: 2 })], ctx({ extensions: [{ divider_path: ["dx"] }] })),
    Error,
    "five_day_week",
  );
});

Deno.test("priceDocument: a settled invoice is refused (D3)", () => {
  for (const document of [
    { kind: "invoice", status: "part_paid", has_settlement: true },
    { kind: "invoice", status: "issued", has_settlement: true },
    { kind: "invoice", status: "paid", has_settlement: false },
  ] as const) {
    assertThrows(() => priceDocument([line()], ctx({ document })), Error, "settled");
  }
});

Deno.test("priceDocument: a void invoice is refused, even with no settlement (D3)", () => {
  assertThrows(() => priceDocument([line()], ctx({ document: { kind: "invoice", status: "void", has_settlement: false } })), Error, "void");
});

Deno.test("priceDocument: a percent fee line at quantity 2 is refused (D6)", () => {
  assertThrows(() => priceDocument([line(), fee({ quantity: 2 })], ctx()), Error, "quantity 1");
});

Deno.test("priceDocument: the input items are not mutated", () => {
  const items = [line(), fee()];
  const before = structuredClone(items);
  priceDocument(items, ctx());
  assertEquals(items, before);
});

// ── The freeze: an issued invoice keeps the tax version it carries (#997 decision a) ──

Deno.test("priceDocument: an ISSUED invoice keeps its stored rate version; a DRAFT re-rates", () => {
  // Chicago Sales Tax changed version on 2026-06-01: 10.25% then 10.5%.
  const versions = catalogOf([
    { uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent", jurisdiction: "chicago", item_types: ["sale", "replacement"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-06-01T00:00:00.000-05:00" },
    { uid: "chi-sales-new", name: "Chicago Sales Tax", rate: 10.5, type: "percent", jurisdiction: "chicago", item_types: ["sale", "replacement"], applied_from: "2026-06-01T00:00:00.000-05:00", applied_to: null },
  ]);
  // A sale line stored at the OLD version; the invoice prices at 2026-07-02, inside the new window.
  const stored = () => [line({ type: "sale" }, {
    formula: "fixed", base_cents: 40000, chargeable_days: null,
    taxes: [{ uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent", amount_cents: 4100 }],
    taxes_base: [{ uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent" }],
  })];
  const price = (status: "draft" | "issued") =>
    priceDocument(stored(), ctx({ document: { kind: "invoice", status, has_settlement: false }, tax: { ...taxCtx(), catalog: versions } }));

  const issued = p(price("issued").items[0]);
  assertEquals(issued.taxes.map((t) => [t.name, t.amount_cents]), [["Chicago Sales Tax", 4100]]);
  assertEquals((price("issued").items[0].price as unknown as { taxes_base: { uid: string }[] }).taxes_base.map((t) => t.uid), ["chi-sales-old"]);
  assertEquals(price("issued").totals.total_cents, 44100);

  // A draft has agreed nothing yet, so it prices at its date: 40000 × 10.5% = 4200.
  assertEquals(p(price("draft").items[0]).taxes.map((t) => t.amount_cents), [4200]);
  assertEquals(price("draft").totals.total_cents, 44200);
});

Deno.test("priceDocument: the freeze falls back to stored taxes where taxes_base is absent", () => {
  const versions = catalogOf([
    { uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent", jurisdiction: "chicago", item_types: ["sale"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-06-01T00:00:00.000-05:00" },
    { uid: "chi-sales-new", name: "Chicago Sales Tax", rate: 10.5, type: "percent", jurisdiction: "chicago", item_types: ["sale"], applied_from: "2026-06-01T00:00:00.000-05:00", applied_to: null },
  ]);
  const items = [line({ type: "sale" }, {
    formula: "fixed", base_cents: 40000, chargeable_days: null,
    taxes: [{ uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent", amount_cents: 4100 }],
  })];
  // A line stored before `taxes_base` existed carries no key at all (the fixture base has `[]`).
  delete (items[0].price as { taxes_base?: unknown }).taxes_base;
  const r = priceDocument(items, ctx({ document: { kind: "invoice", status: "issued", has_settlement: false }, tax: { ...taxCtx(), catalog: versions } }));
  assertEquals(r.totals.total_cents, 44100);
});

// ── Property sweep: the SUM equals today's re-pricing, on live documents ──

function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

/**
 * The pricing path `priceDocument` replaced, frozen here as a test oracle
 * (api-cloudrun#997 step 2 deleted `materializeDocumentTax` and the totals
 * functions): tax refs, then each pre-tax line re-priced by spread, then totals
 * RE-DERIVED from line inputs by the audit oracle. It shares the line pricer
 * with `priceDocument`, deliberately — what the sweep tests is the document
 * layer (stage order, fee costing, totals as a sum), not the line arithmetic,
 * which has its own exact-rational sweep in `orders.test.ts`.
 */
function legacyPrice(items: LineItem[], taxCtx: DocumentTaxContext) {
  const out = structuredClone(items);
  assignLineTaxes(out, taxCtx);
  const pricing = pricingTaxesOf(taxCtx.catalog);
  for (const item of out) {
    if (!isPreTaxItem(item)) continue;
    const computed = calculateItemPrice(item, pricing);
    item.price = { ...item.price, ...computed };
  }
  const totals = rederiveDocumentTotalsForAudit(out, pricing);
  return { items: out, totals, replacement_total_cents: calculateReplacementTotals(out, pricing).total_cents };
}

function generateDocument(rand: (n: number) => number): { items: LineItem[]; city: string; exempt: boolean } {
  const items: LineItem[] = [];
  const count = 1 + rand(8);
  for (let i = 0; i < count; i++) {
    const type = (["rental", "sale", "service"] as const)[rand(3)];
    const discount = rand(3) === 0
      ? (rand(2) === 0 ? { type: "percent", rate: rand(10000) / 100, amount_cents: 0 } : { type: "flat", rate: rand(5000) / 100, amount_cents: 0 })
      : null;
    items.push(line({ type, quantity: 1 + rand(40) }, {
      base_cents: rand(250000),
      chargeable_days: type === "rental" ? 1 + rand(30) : null,
      formula: type === "rental" ? "five_day_week" : "fixed",
      discount,
    }));
  }
  if (rand(2) === 0) items.push(fee({}, { base_percent: rand(50000) / 10000 }));
  if (rand(4) === 0) items.push(fee({ name: "Holiday Surcharge" }, { formula: "fixed", base_cents: rand(10000), base_percent: null }));
  return { items, city: ["Chicago", "Frankfort", "Rantoul"][rand(3)], exempt: rand(6) === 0 };
}

Deno.test("priceDocument: totals equal the legacy reprice + the audit oracle on 20k documents", () => {
  const rand = lcg(997);
  let docs = 0, withPercentFee = 0, withDiscount = 0, taxedDocs = 0;
  for (let n = 0; n < 20000; n++) {
    const { items, city, exempt } = generateDocument(rand);
    const legacy = legacyPrice(items, taxCtx(city, exempt));
    const expected = legacy.totals;

    const r = priceDocument(items, ctx({ tax: taxCtx(city, exempt) }));
    assertEquals(r.totals, expected, `document ${n}`);
    assertEquals(r.replacement_total_cents, legacy.replacement_total_cents, `document ${n} replacement`);
    // Stage 5 alone over the priced lines is the same sum.
    assertEquals(sumPricedLines(r.items), r.totals, `document ${n} sumPricedLines`);

    // Pre-tax line money is byte-identical to the legacy reprice.
    r.items.forEach((it, i) => {
      if (it.type === "transaction_fee") return;
      assertEquals(it.price, legacy.items[i].price, `document ${n} line ${i}`);
    });

    docs++;
    if (items.some((it) => it.price?.formula === "percent_of_total")) withPercentFee++;
    if (items.some((it) => it.price?.discount)) withDiscount++;
    if (expected.taxes.length > 0) taxedDocs++;
  }
  // The domain was exercised, separately from being correct.
  assert(withPercentFee > 5000, `only ${withPercentFee} documents carried a percent fee`);
  assert(withDiscount > 5000, `only ${withDiscount} documents carried a discount`);
  assert(taxedDocs > 10000, `only ${taxedDocs} documents were taxed`);
  assertEquals(docs, 20000);
});

Deno.test("…and a fee costed on the PRE-TAX basis DOES disagree with it", () => {
  // The companion: a sum that forgets the tax half of the fee basis must go red,
  // or the sweep above could not tell the two basis rules apart.
  const rand = lcg(997);
  let disagreements = 0;
  for (let n = 0; n < 2000; n++) {
    const { items, city, exempt } = generateDocument(rand);
    const r = priceDocument(items, ctx({ tax: taxCtx(city, exempt) }));
    const feeLine = r.items.find((it) => it.price?.formula === "percent_of_total");
    if (!feeLine) continue;
    const wrong = calculateTransactionFeeAmountCents(feeLine, r.totals.subtotal_discounted_cents);
    if (wrong !== p(feeLine).total_cents) disagreements++;
  }
  assert(disagreements > 100, `pre-tax basis disagreed on only ${disagreements} fee documents`);
});

// ── Credit notes: priced from the invoice line (#997 D4) ──

const creditSource = (over: Partial<LineItem> = {}, price: Record<string, unknown> = {}) =>
  line(over, price) as unknown as Parameters<typeof priceCreditNote>[0][number]["line"];

Deno.test("priceCreditNote: credits a discounted, taxed line at the credited quantity, with its stored tax", () => {
  // Rental 10000 × 5 days, 10% off, Chicago Rental Tax 15%, billed 5 units; credit 2.
  // 2 × 10000 = 20000; 10% off → 18000; 15% tax → 2700; total 20700.
  const src = creditSource({ quantity: 5 }, {
    discount: { type: "percent", rate: 10, amount_cents: 0 },
    taxes: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount_cents: 0 }],
  });
  const r = priceCreditNote([{ line: src, quantity: 2 }], pricingTaxesOf(CAT), []);
  const price = r.prices[0];
  assertEquals(
    [price.subtotal_cents, price.subtotal_discounted_cents, price.discount?.amount_cents, price.total_cents],
    [20000, 18000, 2000, 20700],
  );
  assertEquals(price.taxes.map((t) => [t.uid, t.amount_cents]), [["chi-rental-tax", 2700]]);
  assertEquals(Object.keys(price).sort(), [
    "base_cents", "chargeable_days", "discount", "formula", "subtotal_cents", "subtotal_discounted_cents", "taxes", "total_cents",
  ]);
  assertEquals(r.totals, {
    discount_amount_cents: 2000, subtotal_cents: 20000, subtotal_discounted_cents: 18000,
    taxes: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount_cents: 2700 }],
    total_cents: 20700,
  });
});

Deno.test("priceCreditNote: keeps the charged rate VERSION, never today's, and an exempt line stays untaxed", () => {
  const versions = pricingTaxesOf(catalogOf([
    { uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent", jurisdiction: "chicago", item_types: ["sale"], applied_from: "2020-01-01T00:00:00.000-06:00", applied_to: "2026-06-01T00:00:00.000-05:00" },
    { uid: "chi-sales-new", name: "Chicago Sales Tax", rate: 10.5, type: "percent", jurisdiction: "chicago", item_types: ["sale"], applied_from: "2026-06-01T00:00:00.000-05:00", applied_to: null },
  ]));
  const old = creditSource({ type: "sale" }, {
    formula: "fixed", base_cents: 40000, chargeable_days: null,
    taxes: [{ uid: "chi-sales-old", name: "Chicago Sales Tax", rate: 10.25, type: "percent", amount_cents: 4100 }],
  });
  const exempt = creditSource({ type: "sale" }, { formula: "fixed", base_cents: 1000, chargeable_days: null, taxes: [] });
  const r = priceCreditNote([{ line: old, quantity: 1 }, { line: exempt, quantity: 3 }], versions, []);
  assertEquals(r.prices.map((x) => x.total_cents), [44100, 3000]);
  assertEquals(r.totals.taxes.map((t) => [t.name, t.amount_cents]), [["Chicago Sales Tax", 4100]]);
  assertEquals(r.totals.total_cents, 47100);
});

Deno.test("priceCreditNote: an extension line is credited at its own added days, never floored to a week", () => {
  // Billed in an extension section: 10000 × 2 added days ÷ 5 = 4000, 15% tax → 4600.
  // Priced as an ordinary line, 2 days floors to a week: 10000 → 11500 credited.
  const ext = creditSource({ path: ["o", "dest-ext", "r1"] }, {
    base_cents: 10000,
    chargeable_days: 2,
    taxes: [{ uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent", amount_cents: 0 }],
  });
  const inSection = priceCreditNote([{ line: ext, quantity: 1 }], pricingTaxesOf(CAT), [{ divider_path: ["o", "dest-ext"] }]);
  assertEquals([inSection.prices[0].subtotal_cents, inSection.totals.total_cents], [4000, 4600]);
  const floored = priceCreditNote([{ line: ext, quantity: 1 }], pricingTaxesOf(CAT), []);
  assertEquals(floored.prices[0].subtotal_cents, 10000);
});

Deno.test("priceCreditNote: refuses a divider, a fee, and a non-positive or fractional quantity", () => {
  const taxes = pricingTaxesOf(CAT);
  const divider = { ...line(), type: "destination" } as unknown as Parameters<typeof priceCreditNote>[0][number]["line"];
  assertThrows(() => priceCreditNote([{ line: divider, quantity: 1 }], taxes, []), Error, "cannot be credited");
  assertThrows(() => priceCreditNote([{ line: creditSource({ type: "transaction_fee" }), quantity: 1 }], taxes, []), Error, "cannot be credited");
  for (const quantity of [0, -1, 1.5]) {
    assertThrows(() => priceCreditNote([{ line: creditSource(), quantity }], taxes, []), Error, "positive integer");
  }
});
