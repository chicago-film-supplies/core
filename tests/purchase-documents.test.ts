/**
 * Purchase → bill: the projector, the "already billed" readers, the payable arm
 * of `priceDocument` and the purchase → bill sync (`src/utils/purchase-documents.ts`;
 * purchases-as-documents D5, D7; one-document-model Phases 2–3).
 *
 * Since Phase 3 a bill line sits at `[purchase uid, ...its purchase line's
 * path]` under the purchase's `purchase` divider, and the sync IS the order →
 * invoice sync's engine. The unit charge-window readers retired with the
 * windows; a time line is still refused until it meters its pair's windows.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  flatShareCents,
  remainingTimeCounts,
  type PurchaseBilledDocuments,
  projectPurchaseLineToBillLine,
  purchaseBillIsLive,
  purchaseBillSharedLineFields,
  purchaseCreditIsLive,
  purchaseDocumentScope,
  purchaseLineBilledNet,
  purchaseLineCreditCents,
  recomputePurchaseQuantityBilled,
  syncPurchaseToBills,
} from "../src/utils/purchase-documents.ts";
import { chargeWindowContext, priceDocument, PriceRefusalError } from "../src/utils/price-document.ts";
import type { PricingFormulas } from "../src/utils/price-formulas.ts";
import type { TaxCatalog } from "../src/utils/tax-classes.ts";
import { payablePrice, purchaseDivider, purchasePair, withPayableMoney } from "./helpers/payable.ts";
import { computeDocumentDiffs, type DocumentDiffContext, type DocumentQuantityEntry } from "../src/utils/documentDiff.ts";
import { priceFormulaRefOf } from "../src/utils/price-formulas.ts";
import { cumulativeShareCents } from "../src/utils/purchases.ts";
import {
  type Purchase,
  type PurchaseBill,
  PurchaseBillSchema,
  type PurchaseCredit,
  type PurchaseDocumentItem,
  type PurchaseDocumentRow,
  type PurchaseItem,
  type PurchaseRentalItem,
  purchaseDocumentLines,
} from "../src/schemas/mod.ts";
import { FIXED, VISION } from "./helpers/formulas.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

/** The tax class every payable test line is stamped with: exempt on this side, so it prices nothing. */
const TAX_CLASS = "TaxClassResale000000";

/** An empty catalog: no class resolves a rate, so an exempt line's `taxes_base` is `[]`. */
const NO_TAXES = { codes: [], rates: [], classes: [] } as unknown as TaxCatalog;
const TAX = { origin: "chicago", catalog: NO_TAXES } as const;
const payableCtx = (kind: "purchase" | "purchase_bill" | "purchase_credit") => ({
  document: { kind },
  tax: { ...TAX, asOf: jan(1) },
});

const PURCHASE = "testpurch10000000000";
/** The purchase's one destination divider and pair. */
const DIV = "9a1b2c3d-0000-4000-8000-0000000000d1";
const PRODUCT = "testprod100000000000";
const actor = { uid: "testuser100000000000", name: "Test User" };
const iuid = (n: number) => `9a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A Chicago midnight in January (CST). */
const jan = (d: number) => `2026-01-${String(d).padStart(2, "0")}T00:00:00.000-06:00`;

const VISION_RATES = [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 4500 }];
const FIXED_REF = priceFormulaRefOf(FIXED);

/** Vision hotspots on a time subrent of `quantity` units. */
function visionLine(over: Partial<PurchaseRentalItem> = {}): PurchaseRentalItem {
  const uid = over.uid ?? iuid(1);
  return {
    type: "rental",
    uid,
    path: [DIV, uid],
    description: "",
    zero_priced: null,
    name: "Hotspot",
    uid_product: PRODUCT,
    quantity: 2,
    amount_cents: null,
    price: { ...payablePrice(0, { formula: priceFormulaRefOf(VISION) }), rates: VISION_RATES },
    ledger_account: 5100,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    quantity_received: 2,
    quantity_billed: null,
    quantity_canceled: 0,
    quantity_returned: 0,
    uid_orders: [],
    uid_units: ["unit-1", "unit-2"],
    ...over,
  };
}

/** A FLAT buy of 3 radios for $1,409.85. */
function buyLine(over: Record<string, unknown> = {}): PurchaseItem {
  const uid = iuid(2);
  return withPayableMoney({
    type: "sale",
    uid,
    path: [DIV, uid],
    description: "",
    zero_priced: null,
    name: "Walkie Talkie",
    uid_product: PRODUCT,
    quantity: 3,
    amount_cents: 140985,
    price: payablePrice(0, { formula: FIXED_REF }),
    ledger_account: 1999,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    expected_date: null,
    quantity_received: 0,
    quantity_billed: 0,
    quantity_canceled: 0,
    landed_costs: [],
    ...over,
  }) as PurchaseItem;
}

/** The purchase's `purchase` divider and its destination divider, as they sit on a bill. */
const SCOPE: PurchaseDocumentRow[] = [
  { uid: PURCHASE, type: "purchase", name: "PO-1", path: [PURCHASE], description: "" },
  { ...purchaseDivider(DIV), path: [PURCHASE, DIV] },
];

/** A bill of `items` (lines at their purchase paths) under the purchase's dividers. */
function billDoc(number: number, items: PurchaseDocumentItem[], over: Partial<PurchaseBill> = {}): PurchaseBill {
  const total = items.reduce((s, i) => s + i.amount_cents, 0);
  return {
    uid: `testbill${String(number).padStart(12, "0")}`,
    number,
    status: "issued",
    query_by_purchases: [PURCHASE],
    number_purchases: [1],
    supplier: { uid: "testsupp100000000000", name: "Vision" },
    origin: "pushed",
    xero_document: "invoice",
    xero_id: null,
    date: "2026-02-10T00:00:00.000-06:00",
    date_fs: mockTimestamp,
    due_date: "2026-03-10T00:00:00.000-06:00",
    reference: null,
    items: [...SCOPE, ...items],
    destinations: [{ uid_purchase: PURCHASE, ...purchasePair(DIV) }],
    totals: { total_cents: total, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: total },
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

const NONE: PurchaseBilledDocuments = { uid_purchase: PURCHASE, bills: [], credits: [] };
/** The bill line projected from `item` for `quantity` units — at its path, with its uid. (`_n` is legacy.) */
const project = (item: PurchaseItem, _n = 10, quantity = 1) =>
  projectPurchaseLineToBillLine(item, { uid_purchase: PURCHASE, quantity });
/** The bill lines of a bill, dividers dropped. */
const linesOf = (bill: PurchaseBill) => purchaseDocumentLines(bill.items);

// ── Flat lines ──────────────────────────────────────────────────────

Deno.test("projector: a FLAT line bills its cumulative share — three bills of one telescope to the line's amount", () => {
  let item = buyLine();
  const amounts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const line = project(item, 10 + k);
    amounts.push(line.amount_cents);
    assertEquals(line.price?.counts, []);
    item = { ...item, quantity_billed: (item as { quantity_billed: number }).quantity_billed + 1 } as PurchaseItem;
  }
  assertEquals(amounts.reduce((a, b) => a + b, 0), 140985);
  assertEquals(amounts, [46995, 46995, 46995]);
});

Deno.test("projector: OVER-billing a flat line still defaults, at the same per-unit rate (D5: flagged, never refused)", () => {
  const line = project(buyLine({ quantity_billed: 3 }), 10, 1);
  assertEquals(line.amount_cents, 46995);
  // Within the ordered count it is exactly cumulativeShareCents.
  assertEquals(project(buyLine(), 10, 2).amount_cents, cumulativeShareCents(140985, 3, 0, 2));
});

Deno.test("projector: a flat line's discount is recorded as its share; amount_cents stays the NET (ruling 7)", () => {
  const item = buyLine({ price: payablePrice(140985, { formula: FIXED_REF, discount: { rate: 10, type: "percent", amount_cents: 15665 } }) });
  const line = project(item, 10, 1);
  assertEquals(line.amount_cents, 46995);
  assertEquals(line.price?.discount?.amount_cents, 5222);
  assertEquals([line.price.subtotal_cents, line.price.subtotal_discounted_cents, line.price.total_cents], [46995 + 5222, 46995, 46995]);
});

Deno.test("projector: a TIME line projects UNPRICED, carrying its seed counts — the bill pricer prices it", () => {
  const seed = [{ rate_key: "month", num: 0, den: 1 }, { rate_key: "week", num: 1, den: 1 }];
  const line = projectPurchaseLineToBillLine(visionLine(), { uid_purchase: PURCHASE, quantity: 2, counts: seed });
  assertEquals(line.path, [PURCHASE, DIV, visionLine().uid]);
  assertEquals(line.price.counts, seed);
  assertEquals(line.price.rates, VISION_RATES);
  assertEquals([line.amount_cents, line.price.subtotal_cents, line.price.total_cents], [0, 0, 0]);
  assertEquals(projectPurchaseLineToBillLine(visionLine(), { uid_purchase: PURCHASE, quantity: 2 }).price.counts, []);
});

Deno.test("projector: a bill line sits AT its purchase line's path under the purchase divider, with its uid", () => {
  const line = project(buyLine(), 10, 1);
  assertEquals(line.uid, buyLine().uid);
  assertEquals(line.path, [PURCHASE, DIV, buyLine().uid]);
  assertEquals("path_purchase_item" in line, false, "a line at its own path carries no move pointer");
});

// ── The projected line is a valid stored line ───────────────────────

Deno.test("projected flat lines parse inside a PUSHED bill, and in a LINKED one", () => {
  const other = buyLine({ uid: iuid(5), path: [DIV, iuid(5)], quantity_billed: 1 });
  const items = [project(buyLine(), 10, 1), project(other, 11, 2)];
  for (const over of [{}, { origin: "linked" as const, xero_id: "8a1b2c3d-0000-4000-8000-000000000001" }]) {
    const r = PurchaseBillSchema.safeParse(billDoc(1, items, over));
    assert(r.success, JSON.stringify(r.error?.issues));
  }
});

// ── priceDocument, payable arm ──────────────────────────────────────

Deno.test("priceDocument (payable): the stated amount IS the money, the discount the gross on top; totals are the Σ", () => {
  const discount = { rate: 10, type: "percent" as const, amount_cents: 5222 };
  const base = project(buyLine(), 10, 1);
  const stale = { ...base, price: { ...base.price, discount, subtotal_cents: 1, subtotal_discounted_cents: 1, total_cents: 1 } };
  const freight = { ...project(buyLine({ uid: iuid(5), path: [DIV, iuid(5)] }), 11, 1), amount_cents: 1500 };
  const priced = priceDocument([stale, freight], payableCtx("purchase_bill"));
  assertEquals(priced.items[0].price.subtotal_cents, 46995 + 5222);
  assertEquals(priced.items[0].price.subtotal_discounted_cents, 46995);
  assertEquals(priced.items[0].price.total_cents, 46995);
  assertEquals(priced.items[0].price.discount, discount, "the declared discount is kept, not re-derived");
  assertEquals(priced.items[1].price.total_cents, 1500);
  assertEquals(priced.totals.total_cents, 46995 + 1500);
  assertEquals(priced.totals.discount_amount_cents, 5222);
  assertEquals(priced.replacement_total_cents, null);
  assertEquals(stale.price.total_cents, 1, "pure: the caller's line is untouched");
  const r = PurchaseBillSchema.safeParse(billDoc(1, priced.items as PurchaseDocumentItem[]));
  assert(r.success, JSON.stringify(r.error?.issues));
});

Deno.test("priceDocument (payable): a LINKED line's stamped Xero amount prices to exactly itself", () => {
  const line = { ...project(buyLine(), 10, 3), amount_cents: 140000 };
  const priced = priceDocument([line], payableCtx("purchase_bill"));
  assertEquals(priced.items[0].price.total_cents, 140000);
  assertEquals(priced.items[0].amount_cents, 140000);
});

Deno.test("priceDocument (payable): prices a PURCHASE line, which carries no counts", () => {
  const priced = priceDocument([buyLine()], payableCtx("purchase"));
  assertEquals(priced.items[0].price.total_cents, 140985);
  assertEquals("counts" in priced.items[0].price, false, "no key the purchase price does not declare");
});

// ── Time lines (one-document-model Phase 3, item 10) ────────────────
//
// Vision's "weekly while on" meters a week per 7 days and caps at a month for
// 28 (`tests/helpers/formulas.ts`). Two hotspots over 14 days are 2 weeks × $45
// × 2 = $180.00; over 7 days, 1 week × $45 × 2 = $90.00. Stated by hand.

const WEEK_2 = [{ rate_key: "month", num: 0, den: 1 }, { rate_key: "week", num: 2, den: 1 }];
const WEEK_1 = [{ rate_key: "month", num: 0, den: 1 }, { rate_key: "week", num: 1, den: 1 }];
const FORMULAS: PricingFormulas = new Map([[VISION.uid, VISION]]);
/** The purchase's pair with charge windows — a fortnight from Jan 1. */
const chargedPair = () => {
  const pair = purchasePair(DIV, { start: jan(1), end: null });
  return { ...pair, dates: { ...pair.dates, charge_windows: [{ start: jan(1), end: jan(15) }] } };
};
const billCtx = (origin: "pushed" | "linked", time = true) => ({
  document: { kind: "purchase_bill" as const, origin },
  tax: { ...TAX, asOf: jan(20) },
  ...(time
    ? { time: { formulas: FORMULAS, holidays: [], charge_windows: chargeWindowContext([{ uid_purchase: PURCHASE, ...chargedPair() }]) } }
    : {}),
});
const timeBillLine = (counts: { rate_key: string; num: number; den: number }[] = []) =>
  projectPurchaseLineToBillLine(visionLine(), { uid_purchase: PURCHASE, quantity: 2, counts });

Deno.test("priceDocument (payable): a TIME purchase line commits nothing — zero money, no amount", () => {
  const [priced] = priceDocument([visionLine()], payableCtx("purchase")).items as PurchaseItem[];
  assertEquals(priced.amount_cents, null);
  assertEquals([priced.price.subtotal_cents, priced.price.subtotal_discounted_cents, priced.price.total_cents], [0, 0, 0]);
});

Deno.test("priceDocument (payable): a PUSHED time bill line is metered from its pair and priced rates × counts", () => {
  const [metered] = priceDocument([timeBillLine()], billCtx("pushed")).items;
  assertEquals(metered.price.counts, WEEK_2);
  assertEquals([metered.amount_cents, metered.price.subtotal_discounted_cents, metered.price.total_cents], [18000, 18000, 18000]);
  // Stated counts (the remaining-to-bill seed) are the line's own and win over the meter.
  const [stated] = priceDocument([timeBillLine(WEEK_1)], billCtx("pushed")).items;
  assertEquals(stated.price.counts, WEEK_1);
  assertEquals(stated.amount_cents, 9000);
  const r = PurchaseBillSchema.safeParse({
    ...billDoc(1, [metered]),
    destinations: [{ uid_purchase: PURCHASE, ...chargedPair() }],
  });
  assert(r.success, JSON.stringify(r.error?.issues));
});

Deno.test("priceDocument (payable): a LINKED time bill line keeps Xero's amount", () => {
  const linked = { ...timeBillLine(WEEK_2), amount_cents: 17500 };
  const [priced] = priceDocument([linked], billCtx("linked")).items;
  assertEquals([priced.amount_cents, priced.price.total_cents], [17500, 17500]);
  assertEquals(priced.price.counts, WEEK_2, "its counts are whatever the link stated");
});

Deno.test("priceDocument (payable): a pushed time line with no counts and no windows is refused by name", () => {
  assertThrows(() => priceDocument([timeBillLine()], billCtx("pushed", false)), PriceRefusalError, "no windows to meter");
  const bare = { ...billCtx("pushed"), time: { formulas: FORMULAS, holidays: [], charge_windows: [] } };
  assertThrows(() => priceDocument([timeBillLine()], bare), PriceRefusalError, "no destination pair with charge windows");
});

Deno.test("remainingTimeCounts: the pair metered, less what live bills bill net of credits, floored at 0 (0b ruling 3)", () => {
  const purchase = { uid: PURCHASE, destinations: [chargedPair()] };
  const args = (documents: Omit<PurchaseBilledDocuments, "uid_purchase">) => ({
    purchase,
    item: visionLine(),
    documents: { uid_purchase: PURCHASE, ...documents },
    formulas: FORMULAS,
    holidays: [],
  });
  const billed = (counts: typeof WEEK_1, over: Partial<PurchaseBill> = {}) =>
    billDoc(1, [{ ...timeBillLine(counts), amount_cents: 9000 }], over);
  assertEquals(remainingTimeCounts(args({ bills: [], credits: [] })), WEEK_2, "nothing billed: the whole fortnight");
  assertEquals(remainingTimeCounts(args({ bills: [billed(WEEK_1)], credits: [] })), WEEK_1, "one week billed: one left");
  assertEquals(remainingTimeCounts(args({ bills: [billed(WEEK_2)], credits: [] })), [
    { rate_key: "month", num: 0, den: 1 },
    { rate_key: "week", num: 0, den: 1 },
  ], "billed in full");
  const over = remainingTimeCounts(args({ bills: [billed(WEEK_2), billed(WEEK_1, { uid: "testbill000000000002" })], credits: [] }));
  assertEquals(over?.find((t) => t.rate_key === "week")?.num, 0, "over-billed seeds nothing, never a negative");
  const voided = billed(WEEK_1, { status: "void", voided_at: mockTimestamp });
  assertEquals(remainingTimeCounts(args({ bills: [voided], credits: [] })), WEEK_2, "a void bill bills nothing");
  const creditLine = { ...timeBillLine(WEEK_1), amount_cents: 9000 };
  assertEquals(remainingTimeCounts(args({ bills: [billed(WEEK_2)], credits: [credit([creditLine])] })), WEEK_1, "a credit un-bills its counts");
  assertEquals(remainingTimeCounts({ ...args({ bills: [], credits: [] }), purchase: { uid: PURCHASE, destinations: [purchasePair(DIV)] } }), null);
});

Deno.test("syncPurchaseToBills: a TIME line's quantity follows on its own and the bill re-meters; an overridden one stays", () => {
  const prevItem = visionLine();
  const nextItem = { ...prevItem, quantity: 3 } as PurchaseItem;
  const prev = { ...purchaseDoc([prevItem]), destinations: [chargedPair()] };
  const next = { ...purchaseDoc([nextItem]), destinations: [chargedPair()] };
  const [line] = priceDocument([timeBillLine()], billCtx("pushed")).items;
  const bill = { ...billDoc(1, [line]), destinations: [{ uid_purchase: PURCHASE, ...chargedPair() }] };
  parses(bill);
  const [out] = syncPurchaseToBills({ prev, next, bills: [bill], tax: TAX, time: { formulas: FORMULAS, holidays: [] } });
  assert(out.changed);
  const [synced] = linesOf(out.bill);
  assertEquals([synced.quantity, synced.amount_cents], [3, 27000], "3 hotspots × 2 weeks × $45, re-priced");
  parses(out.bill);
  // An operator who billed only 1 unit keeps 1.
  const edited = { ...bill, items: bill.items.map((r) => (r.uid === line.uid ? { ...r, name: "Hotspots (supplier)", quantity: 1 } : r)) };
  const [kept] = syncPurchaseToBills({ prev, next, bills: [edited], tax: TAX, time: { formulas: FORMULAS, holidays: [] } });
  assertEquals(linesOf(kept.bill)[0].quantity, 1);
});

// ── The purchase → bill sync ────────────────────────────────────────

function purchaseDoc(items: PurchaseItem[]): Purchase {
  const hire = items.some((i) => i.type === "rental");
  return {
    uid: PURCHASE,
    number: 1,
    status: "active",
    supplier: { uid: "testsupp100000000000", name: "Vision" },
    store: { uid: "teststore10000000000", name: "Fillmore" },
    date: jan(1),
    date_fs: mockTimestamp,
    reference: null,
    notes: null,
    items: [purchaseDivider(DIV), ...items],
    destinations: [purchasePair(DIV, hire ? { start: jan(1), end: null } : null)],
    total_cents: 0,
    query_by_products: [PRODUCT],
    query_by_orders: [],
    query_by_item_types: ["rental"],
    query_by_bills: [],
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  };
}

Deno.test("purchaseBillSharedLineFields: price follows as formula ATOM + rates VALUE + discount terms; quantity and amount as ONE group", () => {
  const fields = purchaseBillSharedLineFields();
  const kinds = Object.fromEntries(fields.map((f) => [f.path, f.kind]));
  assertEquals(kinds["price.price_formula"], "atom");
  assertEquals(kinds["price.rates"], "propagated");
  assertEquals(kinds["price.discount.rate"], "propagated");
  assertEquals(kinds["price.discount.amount_cents"], "derived");
  assertEquals(kinds["quantity"], "propagated");
  assertEquals(kinds["amount_cents"], "propagated");
  assertEquals(fields.filter((f) => f.group === "flat_money").map((f) => f.path).sort(), ["amount_cents", "quantity"]);
  assertEquals(kinds["dates"], undefined);
  assertEquals(kinds["units"], undefined);
});

const sync = (prev: PurchaseItem[] | PurchaseItem, next: PurchaseItem[] | PurchaseItem, bills: PurchaseBill[]) =>
  syncPurchaseToBills({
    prev: purchaseDoc(Array.isArray(prev) ? prev : [prev]),
    next: purchaseDoc(Array.isArray(next) ? next : [next]),
    bills,
    tax: TAX,
  });

const parses = (bill: PurchaseBill) => {
  const r = PurchaseBillSchema.safeParse(bill);
  assert(r.success, JSON.stringify(r.error?.issues));
};

Deno.test("syncPurchaseToBills: a name and a discount reach a PARTIAL bill line; its net stays, and the discount lands as its SHARE", () => {
  const prevItem = buyLine();
  const line = project(prevItem, 10, 1);
  const discount = { rate: 10, type: "percent" as const, amount_cents: 15665 };
  const nextItem = { ...prevItem, name: "Walkie (UHF)", price: { ...prevItem.price, discount } } as PurchaseItem;
  const [out] = sync(prevItem, nextItem, [billDoc(1, [line])]);
  assert(out.changed);
  const [synced] = linesOf(out.bill);
  assertEquals(synced.name, "Walkie (UHF)");
  assertEquals(synced.price.discount?.amount_cents, 5222, "one unit's share of 15665 over 3");
  assertEquals([synced.quantity, synced.amount_cents], [1, line.amount_cents], "a partial line keeps its {quantity, amount}");
  assertEquals(synced.price.subtotal_cents, 46995 + 5222, "and the gross is re-priced on it");
  assertEquals(out.bill.totals.total_cents, 46995);
  parses(out.bill);
});

Deno.test("syncPurchaseToBills: {quantity, amount_cents} follow TOGETHER onto an untouched line, and neither follows onto a partial one", () => {
  const prevItem = buyLine();
  const nextItem = { ...prevItem, quantity: 4, amount_cents: 187980 } as PurchaseItem;
  const whole = project(prevItem, 10, 3);
  const partial = project(prevItem, 10, 1);
  const [a, b] = sync(prevItem, nextItem, [billDoc(1, [whole]), billDoc(2, [partial])]);
  assert(a.changed);
  assertEquals([linesOf(a.bill)[0].quantity, linesOf(a.bill)[0].amount_cents], [4, 187980]);
  assertEquals(a.bill.totals.total_cents, 187980);
  parses(a.bill);
  assertEquals(b.changed, false, "the partial bill billed 1 of 3 and keeps it");
  // An operator who edited ONLY the amount keeps BOTH: the quantity does not follow alone.
  const edited = { ...whole, amount_cents: 140000 };
  const [c] = sync(prevItem, nextItem, [billDoc(3, [withPayableMoney(edited)])]);
  assertEquals([linesOf(c.bill)[0].quantity, linesOf(c.bill)[0].amount_cents], [3, 140000]);
});

Deno.test("syncPurchaseToBills: an untouched line compares equal to its projection — no edit means no change", () => {
  const prevItem = buyLine({ price: payablePrice(140985, { formula: FIXED_REF, discount: { rate: 10, type: "percent", amount_cents: 15665 } }) });
  const [partial] = sync(prevItem, prevItem, [billDoc(1, [project(prevItem, 10, 2)])]);
  assertEquals(partial.changed, false);
  const [whole] = sync(prevItem, prevItem, [billDoc(1, [project(prevItem, 10, 3)])]);
  assertEquals(whole.changed, false);
});

Deno.test("syncPurchaseToBills: an operator's account override is KEPT", () => {
  const prevItem = buyLine();
  const bill = billDoc(1, [{ ...project(prevItem, 10, 1), ledger_account: 1400 }]);
  const [kept] = sync(prevItem, { ...prevItem, ledger_account: 6500 } as PurchaseItem, [bill]);
  assertEquals(kept.changed, false);
  assertEquals(kept.bill, bill);
});

Deno.test("syncPurchaseToBills: a NEW purchase line reaches every unfrozen pushed bill, whole (the New arm)", () => {
  const prevItem = buyLine();
  const added = buyLine({ uid: iuid(9), path: [DIV, iuid(9)], name: "Antenna", quantity: 2, amount_cents: 2000 });
  const [out] = sync([prevItem], [prevItem, added], [billDoc(1, [project(prevItem, 10, 3)])]);
  assert(out.changed);
  const lines = linesOf(out.bill);
  assertEquals(lines.map((l) => [l.uid, l.quantity, l.amount_cents]), [[prevItem.uid, 3, 140985], [iuid(9), 2, 2000]]);
  assertEquals(lines[1].path, [PURCHASE, DIV, iuid(9)]);
  assertEquals(out.bill.totals.total_cents, 140985 + 2000);
  parses(out.bill);
});

Deno.test("syncPurchaseToBills: a line the bill LEFT OUT stays out, and a removed line goes unless overridden", () => {
  const a = buyLine();
  const b = buyLine({ uid: iuid(9), path: [DIV, iuid(9)], name: "Antenna", quantity: 2, amount_cents: 2000 });
  // The bill billed `a` only; renaming `b` must not add it.
  const [leftOut] = sync([a, b], [a, { ...b, name: "Antenna (UHF)" } as PurchaseItem], [billDoc(1, [project(a, 10, 3)])]);
  assertEquals(leftOut.changed, false);
  // `b` removed from the purchase: an untouched bill row goes…
  const both = billDoc(2, [project(a, 10, 3), project(b, 11, 2)]);
  const [gone] = sync([a, b], [a], [both]);
  assertEquals(linesOf(gone.bill).map((l) => l.uid), [a.uid]);
  parses(gone.bill);
  // …an overridden one stays.
  const overridden = billDoc(3, [project(a, 10, 3), { ...project(b, 11, 2), name: "Antenna, supplier's name" }]);
  const [kept] = sync([a, b], [a], [overridden]);
  assertEquals(linesOf(kept.bill).map((l) => l.uid), [a.uid, iuid(9)]);
});

Deno.test("syncPurchaseToBills: a linked, a frozen and a voided bill are skipped whole", () => {
  const prevItem = buyLine();
  const line = project(prevItem, 10, 1);
  const nextItem = { ...prevItem, name: "Renamed" } as PurchaseItem;
  const t = line.amount_cents;
  const bills = [
    billDoc(1, [line], { origin: "linked", xero_id: "8a1b2c3d-0000-4000-8000-000000000001" }),
    billDoc(2, [line], { totals: { total_cents: t, amount_paid_cents: t, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0 } }),
    billDoc(3, [line], { totals: { total_cents: t, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: t, amount_due_cents: 0 } }),
  ];
  assertEquals(sync(prevItem, nextItem, bills).map((o) => o.changed), [false, false, false]);
  // Companion: the same bill pushed and open DOES follow.
  const [open] = sync(prevItem, nextItem, [billDoc(4, [line])]);
  assertEquals(linesOf(open.bill)[0].name, "Renamed");
});

Deno.test("syncPurchaseToBills: another purchase's block on the same bill is untouched", () => {
  const prevItem = buyLine();
  const other = "otherpurch0000000000";
  const otherDiv = "9a1b2c3d-0000-4000-8000-0000000000d9";
  const foreign = { ...project(prevItem, 10, 1), path: [other, otherDiv, prevItem.uid] };
  const base = billDoc(1, [project(prevItem, 10, 1)]);
  const bill: PurchaseBill = {
    ...base,
    items: [
      ...base.items,
      { uid: other, type: "purchase", name: "PO-2", path: [other], description: "" },
      { ...purchaseDivider(otherDiv), path: [other, otherDiv] },
      foreign,
    ],
    destinations: [...base.destinations, { uid_purchase: other, ...purchasePair(otherDiv) }],
    query_by_purchases: [PURCHASE, other],
    number_purchases: [1, 2],
    totals: { ...base.totals, total_cents: base.totals.total_cents * 2, amount_due_cents: base.totals.total_cents * 2 },
  };
  parses(bill);
  const [out] = sync(prevItem, { ...prevItem, name: "Renamed" } as PurchaseItem, [bill]);
  const lines = linesOf(out.bill);
  assertEquals(lines.map((l) => l.name), ["Renamed", prevItem.name]);
  // The other block keeps its row; the whole-bill re-price may only restate its
  // derived money (it adds the `taxes_base` every stored line already carries).
  const { price: _p, ...rest } = lines[1];
  const { price: _f, ...foreignRest } = foreign;
  assertEquals(rest, foreignRest);
  assertEquals(lines[1].price.total_cents, foreign.price.total_cents);
});

Deno.test("purchaseDocumentScope: the purchase divider, the dividers above each billed line, the lines, and their pairs", () => {
  const a = buyLine();
  const g = "9a1b2c3d-0000-4000-8000-0000000000a1";
  const b = buyLine({ uid: iuid(9), path: [DIV, g, iuid(9)], quantity: 1, amount_cents: 100 });
  const purchase = { ...purchaseDoc([a]), items: [purchaseDivider(DIV), a, { uid: g, type: "group" as const, name: "Spare", path: [DIV, g], description: "" }, b] };
  const scope = purchaseDocumentScope(purchase, [project(b, 0, 1)]);
  assertEquals(scope.items.map((r) => [r.type, r.path.join("/")]), [
    ["purchase", PURCHASE],
    ["destination", `${PURCHASE}/${DIV}`],
    ["group", `${PURCHASE}/${DIV}/${g}`],
    ["sale", `${PURCHASE}/${DIV}/${g}/${iuid(9)}`],
  ]);
  assertEquals(scope.destinations.map((d) => [d.uid_purchase, d.uid]), [[PURCHASE, DIV]]);
  assertThrows(() => purchaseDocumentScope(purchase, [{ ...project(a, 0, 1), path: ["elsewhere", a.uid] }]), Error, "not under purchase");
});

Deno.test("flatShareCents: past `quantity` it keeps the per-unit rate, and agrees with cumulativeShareCents inside it", () => {
  // $14.09 over 3 units: 470, 939, 1409 cumulative, then 1879 and 2348 past the order.
  assertEquals(flatShareCents(1409, 3, 3, 4), 470);
  assertEquals(flatShareCents(1409, 3, 3, 5), 939);
  assertEquals(flatShareCents(1409, 3, 2, 5), 1409);
  assertEquals(flatShareCents(1409, 3, 0, 2), cumulativeShareCents(1409, 3, 0, 2));
  // Telescoping past the order: the ranges sum to the whole.
  assertEquals(flatShareCents(1409, 3, 0, 2) + flatShareCents(1409, 3, 2, 5), flatShareCents(1409, 3, 0, 5));
  // Companion: the primitive refuses what this one is for.
  assertThrows(() => cumulativeShareCents(1409, 3, 3, 4), RangeError);
});

// ── What a supplier credit is worth (api-cloudrun#1439) ─────────────

Deno.test("purchaseLineCreditCents: hand-stated cases, from the pool, never the PO line", () => {
  const pool = { quantity: 14, amount_cents: 55958 };
  assertEquals(purchaseLineCreditCents({ pool, n: 14 }), 55958, "CFS-SCR-1's case: nothing strands");
  assertEquals(purchaseLineCreditCents({ pool: { quantity: 3, amount_cents: 1000 }, n: 1 }), 333);
  assertEquals(purchaseLineCreditCents({ pool: { quantity: 2, amount_cents: 1000 }, n: 1 }), 500);
  // A named bill line prices at ITS rate, not the blend, capped at the pool.
  const blended = { quantity: 2, amount_cents: 300 };
  assertEquals(purchaseLineCreditCents({ pool: blended, n: 1, bill_line: { quantity: 1, amount_cents: 200 } }), 200);
  assertEquals(purchaseLineCreditCents({ pool: { quantity: 2, amount_cents: 150 }, n: 2, bill_line: { quantity: 1, amount_cents: 200 } }), 150, "capped");
  // A stated amount governs, up to the pool.
  assertEquals(purchaseLineCreditCents({ pool: blended, n: 1, stated_cents: 7 }), 7);
  assertThrows(() => purchaseLineCreditCents({ pool: blended, n: 1, stated_cents: 301 }), RangeError, "exceeds");
  assertThrows(() => purchaseLineCreditCents({ pool: blended, n: 3 }), RangeError, "exceeds");
  assertThrows(() => purchaseLineCreditCents({ pool: blended, n: 0 }), RangeError, "exceeds");
  assertThrows(() => purchaseLineCreditCents({ pool: { quantity: 2, amount_cents: 0 }, n: 1 }), RangeError, "no money");
});

Deno.test("purchaseLineCreditCents: any split of a pool sums to exactly its money", () => {
  // The oracle is the pool's own total, which the pricer never produces.
  let seed = 41;
  const next = (bound: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % bound;
  for (let round = 0; round < 5_000; round++) {
    let quantity = 1 + next(40);
    let amount_cents = 1 + next(5_000_000);
    const total = amount_cents;
    let sum = 0;
    while (quantity > 0) {
      const n = 1 + next(quantity);
      const cents = purchaseLineCreditCents({ pool: { quantity, amount_cents }, n });
      sum += cents;
      quantity -= n;
      amount_cents -= cents;
      if (quantity > 0 && amount_cents === 0) break;
    }
    assertEquals(sum, total);
  }
});

// ── The purchase ↔ bill diff (D6) ───────────────────────────────────

const credit = (items: PurchaseDocumentItem[], status: PurchaseCredit["status"] = "issued") =>
  ({
    uid: "testcred100000000000",
    number: 1,
    version: 0,
    status,
    items,
    sources: [{ collection: "purchases", uid: PURCHASE }],
    query_by_sources: [`purchases:${PURCHASE}`],
  }) as unknown as PurchaseCredit;

// The payable diff reads no receivable context; the shared engine still takes one.
const DIFF_CTX = { taxNameByUid: new Map(), isOrderFrozen: () => false, formulas: {}, holidays: [] } as unknown as DocumentDiffContext;
type DiffSources = { purchase: Purchase; bills: PurchaseBill[]; credits: PurchaseCredit[] };
const docsOf = (s: DiffSources) => ({ purchases: [s.purchase], bills: s.bills, purchaseCredits: s.credits });
const poDiffs = (s: DiffSources) => computeDocumentDiffs(docsOf(s), { kind: "purchase", uid: s.purchase.uid }, DIFF_CTX);
const billDiffs = (uid: string, s: DiffSources) => computeDocumentDiffs(docsOf(s), { kind: "bill", uid }, DIFF_CTX);

Deno.test("diff: a bill line that matches its purchase line is silent, on both views", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const line = project(buyLine(), 10, 3);
  const bill = billDoc(1, [line]);
  const sources = { purchase: purchaseDoc([item]), bills: [bill], credits: [] };
  assertEquals(poDiffs(sources).lines.size, 0);
  assertEquals(billDiffs(bill.uid, sources).lines.size, 0);
});

Deno.test("diff: an overridden account is a `differs` on both views, here/there in each view's own sense", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const line = { ...project(buyLine(), 10, 3), ledger_account: 6500 };
  const bill = billDoc(1, [line]);
  const sources = { purchase: purchaseDoc([item]), bills: [bill], credits: [] };
  const onBill = billDiffs(bill.uid, sources).lines.get(line.path.join("/"));
  assertEquals(onBill?.map((e) => e.kind), ["differs"]);
  assertEquals((onBill![0] as { fields: unknown }).fields, [{ field: "ledger_account", here: 6500, there: 1999 }]);
  const onPurchase = poDiffs(sources).lines.get(item.path.join("/"));
  assertEquals((onPurchase![0] as { fields: unknown }).fields, [{ field: "ledger_account", here: 1999, there: 6500 }]);
});

Deno.test("diff: OVER-billing a flat line is a `quantity` entry summed across bills net of credits — flagged, never refused", () => {
  const item = buyLine({ quantity_billed: 4, quantity_received: 3 });
  const a = project(buyLine(), 10, 2);
  const b = project(buyLine({ quantity_billed: 2 }), 11, 2);
  const sources = { purchase: purchaseDoc([item]), bills: [billDoc(1, [a]), billDoc(2, [b])], credits: [] };
  const [entry] = poDiffs(sources).lines.get(item.path.join("/"))!;
  assertEquals(entry.kind, "quantity");
  const billed = entry as DocumentQuantityEntry;
  assertEquals([billed.ordered, billed.fulfilled, billed.invoiced], [3, 3, 4]);
  assertEquals(billed.billed_cents, billed.expected_cents);
  // A credit of the extra unit makes it agree again.
  const back = project(buyLine({ quantity_billed: 3 }), 12, 1);
  const credited = { ...sources, credits: [credit([back])] };
  assertEquals(poDiffs(credited).lines.size, 0);
  // …and a VOID credit does not.
  assertEquals(poDiffs({ ...sources, credits: [credit([back], "void")] }).lines.size, 1);
});

Deno.test("diff: a flat line billed at the wrong money is flagged even at the right count", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const line = { ...project(buyLine(), 10, 3), amount_cents: 140000 };
  const sources = { purchase: purchaseDoc([item]), bills: [billDoc(1, [line], { origin: "linked", xero_id: "8a1b2c3d-0000-4000-8000-000000000001" })], credits: [] };
  const [entry] = poDiffs(sources).lines.get(item.path.join("/"))!;
  assertEquals((entry as { billed_cents: number; expected_cents: number }).billed_cents, 140000);
  assertEquals((entry as { expected_cents: number }).expected_cents, 140985);
});

Deno.test("diff: a document-only charge line is `not_on_source` on the bill view", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const freight: PurchaseDocumentItem = {
    type: "service", uid: iuid(20), path: [PURCHASE, DIV, iuid(20)], name: "Freight", description: "", zero_priced: null, quantity: 1, amount_cents: 1500, ledger_account: 5300,
    uid_tracking_category: null, uid_tax_class: TAX_CLASS, price: { ...payablePrice(1500, { formula: FIXED_REF }), counts: [] },
  };
  const bill = billDoc(1, [project(buyLine(), 10, 3), freight]);
  const got = billDiffs(bill.uid, { purchase: purchaseDoc([item]), bills: [bill], credits: [] });
  assertEquals(got.lines.get([PURCHASE, DIV, iuid(20)].join("/"))?.map((e) => e.kind), ["not_on_source"]);
});

// ── The recount of `quantity_billed` (api-cloudrun#1441) ────────────
//
// Every expected count below is stated by hand from the row's story. None is
// computed by the code under test.

/** A bill or credit line of `quantity` units of `item`, for `amount_cents`. */
const docLine = (item: PurchaseItem, quantity: number, amount_cents = 1000) =>
  ({ type: item.type, path: [PURCHASE, ...item.path], quantity, amount_cents }) as unknown as PurchaseDocumentItem;

/** A bill voided the way every void path leaves it: stamped, and folded when it holds money. */
const voidedBill = (bill: PurchaseBill): PurchaseBill => ({
  ...bill,
  status: "void",
  voided_at: mockTimestamp,
  totals: { ...bill.totals, amount_void_cents: bill.totals.total_cents, amount_due_cents: 0 },
});

const recounted = (item: PurchaseItem, documents: PurchaseBilledDocuments, at = item) =>
  (recomputePurchaseQuantityBilled({ items: [item] }, documents).find((i) => i.uid === at.uid) as PurchaseItem).quantity_billed;

Deno.test("recomputePurchaseQuantityBilled: live bills net of live credits, floored at 0", async (t) => {
  const item = buyLine({ quantity: 10, amount_cents: 10000 });
  const bill = (n: number, quantity: number) => billDoc(n, [docLine(item, quantity)]);
  const cases: [string, PurchaseBilledDocuments, number][] = [
    ["nothing billed", NONE, 0],
    ["a bill edited 5→3 counts 3", { uid_purchase: PURCHASE, bills: [bill(1, 3)], credits: [] }, 3],
    ["…and voiding it releases 3, not the 5 it was created with", { uid_purchase: PURCHASE, bills: [voidedBill(bill(1, 3))], credits: [] }, 0],
    ["a bill edited 5→8 beside a bill of 2 counts 10", { uid_purchase: PURCHASE, bills: [bill(1, 8), bill(2, 2)], credits: [] }, 10],
    ["…bill B voided leaves the edited A", { uid_purchase: PURCHASE, bills: [bill(1, 8), voidedBill(bill(2, 2))], credits: [] }, 8],
    ["…then A voided leaves nothing", { uid_purchase: PURCHASE, bills: [voidedBill(bill(1, 8)), voidedBill(bill(2, 2))], credits: [] }, 0],
    ["bill 5, credit 2", { uid_purchase: PURCHASE, bills: [bill(1, 5)], credits: [credit([docLine(item, 2)])] }, 3],
    ["…void the bill: the credit strands, and the count floors", { uid_purchase: PURCHASE, bills: [voidedBill(bill(1, 5))], credits: [credit([docLine(item, 2)])] }, 0],
    ["…then void the credit too", { uid_purchase: PURCHASE, bills: [voidedBill(bill(1, 5))], credits: [credit([docLine(item, 2)], "void")] }, 0],
    ["a void credit counts nothing, so its units read billed again", { uid_purchase: PURCHASE, bills: [bill(1, 5)], credits: [credit([docLine(item, 2)], "void")] }, 5],
    ["an applied credit still counts", { uid_purchase: PURCHASE, bills: [bill(1, 5)], credits: [credit([docLine(item, 2)], "applied")] }, 3],
    [
      "a $0 voided bill: its void folds to 0, and the stamp is what stops it counting",
      { uid_purchase: PURCHASE, bills: [voidedBill(billDoc(1, [docLine(item, 4, 0)]))], credits: [] },
      0,
    ],
    ["a $0 bill not voided still counts", { uid_purchase: PURCHASE, bills: [billDoc(1, [docLine(item, 4, 0)])], credits: [] }, 4],
    ["an unstamped bill folded void, as every bill before the stamp is", {
      uid_purchase: PURCHASE,
      bills: [billDoc(1, [docLine(item, 4)], { status: "void", totals: { total_cents: 1000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 1000, amount_due_cents: 0 } })],
      credits: [],
    }, 0],
  ];
  for (const [name, documents, expected] of cases) {
    await t.step(name, () => assertEquals(recounted(item, documents), expected));
  }

  await t.step("a time line stays null, whatever names it", () => {
    const time = visionLine();
    assertEquals(recounted(time, { uid_purchase: PURCHASE, bills: [billDoc(1, [docLine(time, 2)])], credits: [] }), null);
  });

  await t.step("the join is the full path: one product on two lines keeps two counts", () => {
    const other = buyLine({ uid: iuid(77), path: [DIV, iuid(77)], quantity: 10, amount_cents: 10000 });
    const items = [item, other];
    const documents = { uid_purchase: PURCHASE, bills: [billDoc(1, [docLine(item, 2), docLine(other, 7)])], credits: [credit([docLine(other, 1)])] };
    assertEquals(item.uid_product, other.uid_product);
    assertEquals(recomputePurchaseQuantityBilled({ items }, documents).map((i) => (i as PurchaseItem).quantity_billed), [2, 6]);
  });

  await t.step("a document-only line names no purchase line and moves nothing", () => {
    const documentOnly = { type: "service", path: [iuid(55)], quantity: 9, amount_cents: 1000 } as unknown as PurchaseDocumentItem;
    assertEquals(recounted(item, { uid_purchase: PURCHASE, bills: [billDoc(1, [documentOnly])], credits: [] }), 0);
  });
});

Deno.test("purchaseLineBilledNet: the count the recount floors, and the money beside it, unfloored", () => {
  const item = buyLine({ quantity: 10, amount_cents: 10000 });
  const documents = {
    uid_purchase: PURCHASE,
    bills: [voidedBill(billDoc(1, [docLine(item, 5, 5000)]))],
    credits: [credit([docLine(item, 2, 2000)])],
  };
  assertEquals(purchaseLineBilledNet(item.path, documents), { quantity: -2, amount_cents: -2000 });
});

Deno.test("purchaseBillIsLive reads the status; purchaseCreditIsLive reads the status", () => {
  assert(purchaseBillIsLive({ status: "issued" }));
  assert(purchaseBillIsLive({ status: "credited" }));
  assert(!purchaseBillIsLive({ status: "void" }));
  assert(purchaseCreditIsLive({ status: "issued" }));
  assert(purchaseCreditIsLive({ status: "applied" }));
  assert(!purchaseCreditIsLive({ status: "void" }));
});

Deno.test("a stamped bill parses, and an unstamped one does too", () => {
  const item = project(buyLine(), 10, 3);
  assert(PurchaseBillSchema.safeParse(billDoc(1, [item])).success);
  assert(PurchaseBillSchema.safeParse(billDoc(1, [item], { status: "void", voided_at: mockTimestamp })).success);
});

Deno.test("diff: a live credit with no live bill left under it reads as a negative `invoiced`", () => {
  const item = buyLine({ quantity_billed: 0, quantity_received: 3 });
  const billLine = project(buyLine(), 10, 3);
  const creditLine = { ...billLine, quantity: 2, amount_cents: 93990 };
  const bill = voidedBill(billDoc(1, [billLine]));
  const stranded = credit([creditLine]);
  const sources = { purchase: purchaseDoc([item]), bills: [bill], credits: [stranded] };
  const entries = poDiffs(sources).lines.get(item.path.join("/"))!;
  assertEquals(entries.map((e) => e.kind), ["quantity"]);
  const billed = entries[0] as DocumentQuantityEntry;
  assertEquals([billed.invoiced, billed.billed_cents, billed.expected_cents], [-2, -93990, 0]);
  assertEquals([billed.invoices.length, billed.credit_sources?.length], [0, 1]);
  // A voided credit beside it leaves nothing to say.
  const quiet = { ...sources, credits: [credit([creditLine], "void")] };
  assertEquals(poDiffs(quiet).lines.size, 0);
});
