/**
 * Purchase → bill: the projector, the unbilled windows, the bill pricer and the
 * purchase → bill sync (`src/utils/purchase-documents.ts`; purchases-as-documents
 * D5, D7, Phase 2 rulings 1, 3, 4, 7, 8).
 *
 * The load-bearing claim is that a time line's counts TELESCOPE: the bills of a
 * window sum to the meter of the whole window, however it was split. Each such
 * test is paired with the naive form — metering only the new pieces — asserted
 * to DISAGREE, so a green run says the delta matters on this corpus.
 */
import { assert, assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  billedUnitCoverage,
  coversForUnit,
  flatShareCents,
  meterBillLine,
  overcoveredUnitWindows,
  seedPurchaseLinesForWindows,
  uncoveredUnitWindows,
  type PurchaseBilledDocuments,
  type PurchaseDocumentContext,
  pricePurchaseDocument,
  projectPurchaseLineToBillLine,
  projectPurchaseLineToCreditLine,
  purchaseBillSharedLineFields,
  syncPurchaseToBills,
  unbilledUnitWindows,
  unitWindowsForLine,
} from "../src/utils/purchase-documents.ts";
import { computePurchaseBillDiffs } from "../src/utils/purchaseDiff.ts";
import { meterUnits, priceFromFormula, priceFormulaRefOf, type TierCount } from "../src/utils/price-formulas.ts";
import { cumulativeShareCents } from "../src/utils/purchases.ts";
import {
  type ChargeItem,
  type Purchase,
  type PurchaseBill,
  PurchaseBillSchema,
  type PurchaseCredit,
  type PurchaseDocumentItem,
  type PurchaseItem,
  type SubrentItem,
  type UnitType,
} from "../src/schemas/mod.ts";
import { FIXED, FORMULAS, VERIZON, VISION } from "./helpers/formulas.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const CTX: PurchaseDocumentContext = {
  formulas: new Map([...FORMULAS, [VISION.uid, VISION], [VERIZON.uid, VERIZON]]),
  holidays: [],
};

const PURCHASE = "testpurch10000000000";
const PRODUCT = "testprod100000000000";
const actor = { uid: "testuser100000000000", name: "Test User" };
const iuid = (n: number) => `9a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A Chicago midnight in January (CST). */
const jan = (d: number) => `2026-01-${String(d).padStart(2, "0")}T00:00:00.000-06:00`;
const feb = (d: number) => `2026-02-${String(d).padStart(2, "0")}T00:00:00.000-06:00`;

const VISION_RATES = [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 4500 }];
const FIXED_REF = priceFormulaRefOf(FIXED);

/** Vision hotspots on a time subrent of `quantity` units. */
function visionLine(over: Partial<SubrentItem> = {}): SubrentItem {
  const uid = over.uid ?? iuid(1);
  return {
    type: "subrent",
    uid,
    path: [uid],
    name: "Hotspot",
    uid_product: PRODUCT,
    quantity: 2,
    amount_cents: null,
    price: { price_formula: priceFormulaRefOf(VISION), rates: VISION_RATES, discount: null },
    coa_posting: 5100,
    uid_tracking_category: null,
    dates: { start: jan(1), end: null },
    quantity_received: 2,
    quantity_billed: null,
    quantity_canceled: 0,
    quantity_returned: 0,
    uid_orders: [],
    auto_link: true,
    uid_units: ["unit-1", "unit-2"],
    ...over,
  };
}

/** A FLAT buy of 3 radios for $1,409.85. */
function buyLine(over: Record<string, unknown> = {}): PurchaseItem {
  const uid = iuid(2);
  return {
    type: "buy",
    uid,
    path: [uid],
    name: "Walkie Talkie",
    uid_product: PRODUCT,
    quantity: 3,
    amount_cents: 140985,
    price: { price_formula: FIXED_REF, rates: [], discount: null },
    coa_posting: 1999,
    uid_tracking_category: null,
    expected_date: null,
    quantity_received: 0,
    quantity_billed: 0,
    quantity_canceled: 0,
    landed_costs: [],
    ...over,
  } as PurchaseItem;
}

/** A Verizon device line (time charge, span-metered). */
function verizonLine(over: Partial<ChargeItem> = {}): ChargeItem {
  const uid = iuid(3);
  return {
    type: "charge",
    uid,
    path: [uid],
    name: "Hotspot (Unlimited)",
    quantity: 1,
    amount_cents: null,
    price: { price_formula: priceFormulaRefOf(VERIZON), rates: [{ rate_key: "month", amount_cents: 8000 }], discount: null },
    coa_posting: 5150,
    uid_tracking_category: null,
    dates: { start: jan(2), end: null },
    quantity_billed: null,
    quantity_canceled: 0,
    auto_link: true,
    uid_units: ["unit-1"],
    ...over,
  };
}

/** A unit with charge windows on `line`. */
function unit(n: number, windows: { start: string; end: string | null }[], formula: string = VISION.uid) {
  return {
    uid: `unit-${n}`,
    charge_windows: windows.map((w, k) => ({
      uid: `00000000-0000-4000-8000-${String(n * 100 + k).padStart(12, "0")}`,
      start: w.start,
      end: w.end,
      uid_order: null,
      uid_price_formula: formula,
      notes: "",
      changed_by: actor,
    })),
  } satisfies Pick<UnitType, "uid" | "charge_windows">;
}

function billDoc(number: number, items: PurchaseDocumentItem[], over: Partial<PurchaseBill> = {}): PurchaseBill {
  const total = items.reduce((s, i) => s + i.amount_cents, 0);
  return {
    uid: `testbill${String(number).padStart(12, "0")}`,
    number,
    uid_purchase: PURCHASE,
    supplier: { uid: "testsupp100000000000", name: "Vision" },
    origin: "pushed",
    xero_document: "invoice",
    xero_id: null,
    date: "2026-02-10T00:00:00.000-06:00",
    date_fs: mockTimestamp,
    due_date: "2026-03-10T00:00:00.000-06:00",
    reference: null,
    items,
    totals: { total_cents: total, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: total },
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

const NONE: PurchaseBilledDocuments = { bills: [], credits: [] };
const project = (
  item: PurchaseItem,
  through: string,
  units: Pick<UnitType, "uid" | "charge_windows">[],
  billed: PurchaseBilledDocuments = NONE,
  n = 10,
  quantity = 1,
) => projectPurchaseLineToBillLine(item, { uid: iuid(n), uid_purchase: PURCHASE, quantity, through, units, billed }, CTX);

const money = (counts: readonly TierCount[]) => priceFromFormula(VISION_RATES, counts, 1, null).subtotal_discounted_cents;

// ── Flat lines ──────────────────────────────────────────────────────

Deno.test("projector: a FLAT line bills its cumulative share — three bills of one telescope to the line's amount", () => {
  let item = buyLine();
  const amounts: number[] = [];
  for (let k = 0; k < 3; k++) {
    const line = project(item, jan(1), [], NONE, 10 + k)!;
    amounts.push(line.amount_cents);
    assertEquals(line.price?.counts, []);
    item = { ...item, quantity_billed: (item as { quantity_billed: number }).quantity_billed + 1 } as PurchaseItem;
  }
  assertEquals(amounts.reduce((a, b) => a + b, 0), 140985);
  assertEquals(amounts, [46995, 46995, 46995]);
});

Deno.test("projector: OVER-billing a flat line still defaults, at the same per-unit rate (D5: flagged, never refused)", () => {
  const line = project(buyLine({ quantity_billed: 3 }), jan(1), [], NONE, 10, 1)!;
  assertEquals(line.amount_cents, 46995);
  // Within the ordered count it is exactly cumulativeShareCents.
  assertEquals(project(buyLine(), jan(1), [], NONE, 10, 2)!.amount_cents, cumulativeShareCents(140985, 3, 0, 2));
});

Deno.test("projector: a flat line's discount is recorded as its share; amount_cents stays the NET (ruling 7)", () => {
  const item = buyLine({ price: { price_formula: FIXED_REF, rates: [], discount: { rate: 10, type: "percent", amount_cents: 15665 } } });
  const line = project(item, jan(1), [], NONE, 10, 1)!;
  assertEquals(line.amount_cents, 46995);
  assertEquals(line.price?.discount?.amount_cents, 5222);
});

// ── Time lines: the unbilled windows and the telescoping meter ─────

Deno.test("unitWindowsForLine: only the units the LINE names, clipped to its dates and closed at `through`", () => {
  const units = [
    unit(1, [{ start: jan(1), end: jan(5) }, { start: jan(10), end: null }]),
    unit(2, [{ start: jan(1), end: null }]),
    unit(3, [{ start: jan(1), end: jan(3) }, { start: jan(20), end: null }]),
  ];
  const got = unitWindowsForLine(units, { uid_units: ["unit-1", "unit-3"], dates: { start: jan(2), end: null } }, jan(15));
  assertEquals([...got.keys()], ["unit-1", "unit-3"]);
  assertEquals(got.get("unit-1"), [{ start: jan(2), end: jan(5) }, { start: jan(10), end: jan(15) }]);
  assertEquals(got.get("unit-3"), [{ start: jan(2), end: jan(3) }], "the window opened after `through` is left out");
  // Companion: a unit the line does not name contributes nothing, whatever its windows.
  assertEquals(unitWindowsForLine(units, { uid_units: [], dates: null }, jan(15)).size, 0);
});

// ── Coverage: the line names the unit (D10 item 10) ──────────────

const purchaseOf = (uid: string, items: PurchaseItem[], status: "active" | "complete" | "canceled" = "active") => ({ uid, status, items });

Deno.test("coverage: a window is covered where a live line naming its unit overlaps it; the rest is uncovered", () => {
  const units = [
    unit(1, [{ start: jan(1), end: jan(20) }]),
    unit(2, [{ start: jan(5), end: null }]),
  ];
  const purchases = [purchaseOf(PURCHASE, [verizonLine({ uid_units: ["unit-1"], dates: { start: jan(10), end: null } })])];
  assertEquals(coversForUnit("unit-1", purchases), [{ uid_purchase: PURCHASE, path: [iuid(3)], dates: { start: jan(10), end: null } }]);
  assertEquals(coversForUnit("unit-2", purchases), []);
  const got = uncoveredUnitWindows(units, purchases, jan(25));
  assertEquals(got.get("unit-1"), [{ start: jan(1), end: jan(10) }], "before the line's span");
  assertEquals(got.get("unit-2"), [{ start: jan(5), end: jan(25) }], "no line names it; open windows close at `through`");
});

Deno.test("coverage: a canceled purchase, or a line canceled in full with nothing billed, covers nothing; a closed line still does", () => {
  const units = [unit(1, [{ start: jan(1), end: jan(5) }])];
  const named = verizonLine({ uid_units: ["unit-1"], dates: null });
  assertEquals(uncoveredUnitWindows(units, [purchaseOf(PURCHASE, [named])], jan(10)).size, 0);
  assertEquals(uncoveredUnitWindows(units, [purchaseOf(PURCHASE, [named], "canceled")], jan(10)).size, 1);
  assertEquals(uncoveredUnitWindows(units, [purchaseOf(PURCHASE, [{ ...named, quantity_canceled: 1 }])], jan(10)).size, 1);
  assertEquals(uncoveredUnitWindows(units, [purchaseOf(PURCHASE, [named], "complete")], jan(10)).size, 0);
  // Companion: a buy never covers, even naming the product.
  assertEquals(uncoveredUnitWindows(units, [purchaseOf(PURCHASE, [buyLine()])], jan(10)).size, 1);
});

Deno.test("overcoverage: time two live lines both cover is ADVISED, with the lines named", () => {
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const a = verizonLine({ uid: iuid(3), path: [iuid(3)], uid_units: ["unit-1"], dates: { start: jan(1), end: jan(12) } });
  const b = verizonLine({ uid: iuid(4), path: [iuid(4)], uid_units: ["unit-1"], dates: { start: jan(8), end: null } });
  const got = overcoveredUnitWindows(units, [purchaseOf(PURCHASE, [a, b])], jan(25));
  assertEquals(got.get("unit-1")?.windows, [{ start: jan(8), end: jan(12) }]);
  assertEquals(got.get("unit-1")?.lines.map((l) => l.path[0]), [iuid(3), iuid(4)]);
  // Companion: back-to-back lines do not overlap.
  const c = verizonLine({ uid: iuid(4), path: [iuid(4)], uid_units: ["unit-1"], dates: { start: jan(12), end: null } });
  assertEquals(overcoveredUnitWindows(units, [purchaseOf(PURCHASE, [a, c])], jan(25)).size, 0);
});

Deno.test("seedPurchaseLinesForWindows: one time charge per (product, formula), naming the uncovered units, priced off the cost entry", () => {
  const provider = { uid: "testsupp200000000000", name: "Verizon" };
  const products = new Map([[PRODUCT, {
    uid: PRODUCT,
    name: "Hotspot",
    cogs: [{
      trigger: "activation" as const,
      uid: "00000000-0000-4000-8000-0000000000c1",
      label: "Verizon line",
      coa_cost: 5150 as const,
      provider,
      ownership: "cfs" as const,
      uid_price_formula: VERIZON.uid,
      rates: [
        { uid: "00000000-0000-4000-8000-0000000000r1", rate_key: "month", amount_cents: 7000, applied_from: jan(1), applied_to: jan(15) },
        { uid: "00000000-0000-4000-8000-0000000000r2", rate_key: "month", amount_cents: 8000, applied_from: jan(15), applied_to: null },
      ],
    }],
  }]]);
  const seedUnit = (n: number, windows: { start: string; end: string | null }[]) => ({ ...unit(n, windows, VERIZON.uid), number: n, uid_product: PRODUCT });
  const units = [seedUnit(2, [{ start: jan(20), end: null }]), seedUnit(1, [{ start: jan(3), end: jan(9) }]), seedUnit(3, [{ start: jan(2), end: null }])];
  const covered = purchaseOf(PURCHASE, [verizonLine({ uid_units: ["unit-3"], dates: null })]);
  const seeds = seedPurchaseLinesForWindows(units, [covered], products as never, jan(25));
  assertEquals(seeds.length, 1);
  const [seed] = seeds;
  assertEquals(seed.uid_units, ["unit-1", "unit-2"], "ascending by number; the covered unit is left out");
  assertEquals(seed.provider, provider);
  assertEquals(seed.dates, { start: jan(3), end: null });
  assertEquals(seed.rates, [{ rate_key: "month", amount_cents: 7000 }], "the rate in force at the earliest uncovered instant");
  assertEquals(seed.coa_posting, 5150);
  assertEquals(seed.warning, null);
  // Companion: with no cost entry the seed still offers, and says why it is not plain.
  const bare = seedPurchaseLinesForWindows(units, [], new Map([[PRODUCT, { uid: PRODUCT, name: "Hotspot", cogs: [] }]]) as never, jan(25));
  assertEquals(bare[0].provider, null);
  assertEquals(bare[0].uid_units, ["unit-1", "unit-2", "unit-3"]);
  assert(bare[0].warning !== null);
  // Fully covered → no offer at all.
  assertEquals(seedPurchaseLinesForWindows(units, [purchaseOf(PURCHASE, [verizonLine({ uid_units: ["unit-1", "unit-2", "unit-3"], dates: null })])], products as never, jan(25)), []);
});

Deno.test("projector: a Vision window billed in TWO halves bills a month and two weeks in all — the counts telescope", () => {
  const item = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: null }])];
  const first = project(item, jan(21), units)!; // 20 nights → 3 weeks, under the cap
  assertEquals(first.quantity, 1);
  assertEquals(first.units, [{ uid_unit: "unit-1", charge_windows: [{ start: jan(1), end: jan(21) }] }]);
  assertEquals(first.amount_cents, 13500);

  const billed = { bills: [billDoc(1, [first])], credits: [] };
  const second = project(item, feb(10), units, billed, 11)!; // through 40 nights
  assertEquals(second.units, [{ uid_unit: "unit-1", charge_windows: [{ start: jan(21), end: feb(10) }] }]);
  // The whole window meters 1 month (Jan 1 → Feb 1, capped) + 9 nights → 2 weeks.
  const whole = meterUnits(VISION, { windows: [{ start: jan(1), end: feb(10) }], holidays: [], rates: VISION_RATES }).tiers;
  assertEquals(first.amount_cents + second.amount_cents, money(whole));
  // The delta carries a NEGATIVE tier: +1 month, −1 week (Q14).
  assertEquals(second.price?.counts, [{ rate_key: "month", num: 1, den: 1 }, { rate_key: "week", num: -1, den: 1 }]);
  assertEquals(second.amount_cents, 11250);

  // Companion: metering the second half ALONE restarts the month at Jan 21 and
  // bills 20 nights as three weeks — the defect the delta exists to prevent.
  const alone = meterUnits(VISION, { windows: [{ start: jan(21), end: feb(10) }], holidays: [], rates: VISION_RATES }).tiers;
  assertNotEquals(money(alone), second.amount_cents);
  assertEquals(money(alone), 13500);
});

Deno.test("projector: two unit windows that TOUCH stay two windows — each restarts its anchor", () => {
  const item = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(4) }, { start: jan(4), end: jan(8) }])];
  const line = project(item, feb(1), units)!;
  // 3 nights → 1 week, then 4 nights → 1 week. Merged they would be 7 nights → 1 week.
  assertEquals(line.amount_cents, 9000);
  const merged = meterUnits(VISION, { windows: [{ start: jan(1), end: jan(8) }], holidays: [], rates: VISION_RATES }).tiers;
  assertEquals(money(merged), 4500);
});

Deno.test("projector: a time line's quantity is the units it bills, and counts are UNIT-periods (quantity folded in)", () => {
  const units = [unit(1, [{ start: jan(1), end: jan(8) }]), unit(2, [{ start: jan(1), end: jan(15) }])];
  const line = project(visionLine(), feb(1), units)!;
  assertEquals(line.quantity, 2);
  assertEquals(line.price?.counts, [{ rate_key: "month", num: 0, den: 1 }, { rate_key: "week", num: 3, den: 1 }]);
  assertEquals(line.amount_cents, 13500);
});

Deno.test("projector: nothing unbilled is null — the poll's nothing_to_bill", () => {
  const item = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(8) }])];
  const first = project(item, feb(1), units)!;
  assertEquals(project(item, feb(1), units, { bills: [billDoc(1, [first])], credits: [] }), null);
  assertEquals(project(item, feb(1), []), null);
});

Deno.test("coverage: a VOID bill bills nothing, and a live credit's windows are owed again", () => {
  const item = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(8) }])];
  const first = project(item, feb(1), units)!;
  const voided = billDoc(1, [first], {
    totals: { total_cents: 4500, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 4500, amount_due_cents: 0 },
  });
  assertEquals(billedUnitCoverage({ bills: [voided], credits: [] }, item.path).size, 0);
  const credit = { status: "issued" as const, items: [first] };
  const live = { bills: [billDoc(1, [first])], credits: [credit] };
  assertEquals(billedUnitCoverage(live, item.path).size, 0);
  assertEquals(project(item, feb(1), units, live)?.amount_cents, 4500);
  assertEquals(project(item, feb(1), units, { ...live, credits: [{ ...credit, status: "void" as const }] }), null);
});

Deno.test("unbilledUnitWindows: a hole in the billed coverage is what is left; a fully billed unit is left out", () => {
  const recorded = new Map([["unit-1", [{ start: jan(1), end: jan(20) }]], ["unit-2", [{ start: jan(1), end: jan(5) }]]]);
  const billed = new Map([["unit-1", [{ start: jan(5), end: jan(10) }]], ["unit-2", [{ start: jan(1), end: jan(5) }]]]);
  assertEquals(unbilledUnitWindows(recorded, billed), [
    { uid_unit: "unit-1", charge_windows: [{ start: jan(1), end: jan(5) }, { start: jan(10), end: jan(20) }] },
  ]);
});

// ── Span lines (Verizon) ────────────────────────────────────────────

Deno.test("projector: a SPAN line bills forward from where its bills left off, and its periods telescope", () => {
  const item = verizonLine();
  const first = project(item, feb(2), [])!;
  assertEquals(first.dates, { start: jan(2), end: feb(2) });
  assertEquals(first.units, []);
  const billed = { bills: [billDoc(1, [first])], credits: [] };
  const second = project(item, "2026-03-02T00:00:00.000-06:00", [], billed, 11)!;
  assertEquals(second.dates, { start: feb(2), end: "2026-03-02T00:00:00.000-06:00" });
  const whole = meterUnits(VERIZON, {
    windows: [{ start: jan(2), end: "2026-03-02T00:00:00.000-06:00" }],
    span: { start: jan(2), end: "2026-03-02T00:00:00.000-06:00" },
    holidays: [],
  }).tiers;
  const rates = [{ rate_key: "month", amount_cents: 8000 }];
  assertEquals(first.amount_cents + second.amount_cents, priceFromFormula(rates, whole, 1, null).subtotal_discounted_cents);
  assertEquals([first.amount_cents, second.amount_cents], [8000, 8000]);
  assertEquals(project(item, "2026-03-02T00:00:00.000-06:00", [], { bills: [billDoc(1, [first]), billDoc(2, [second])], credits: [] }), null);
});

Deno.test("meterBillLine: a flat line meters nothing, a missing formula and a span-less span line throw", () => {
  const src = { span: null, recorded: new Map(), billed: new Map(), billedSpanEnd: null };
  assertThrows(() => meterBillLine({ price: { price_formula: FIXED_REF, rates: [] }, units: [], dates: null, quantity: 1 }, src, CTX));
  const ghost = { uid: "GhostFormula00000000", name: "Ghost", basis: "time" as const };
  assertThrows(() => meterBillLine({ price: { price_formula: ghost, rates: [] }, units: [], dates: null, quantity: 1 }, src, CTX), Error, "not loaded");
  assertThrows(
    () => meterBillLine({ price: { price_formula: priceFormulaRefOf(VERIZON), rates: [] }, units: [], dates: null, quantity: 1 }, src, CTX),
    Error,
    "meters a span",
  );
});

// ── The projected line is a valid stored line ───────────────────────

Deno.test("projected lines parse inside a PUSHED bill — flat, time and span", () => {
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const items = [
    project(buyLine(), feb(1), [], NONE, 10, 1)!,
    project(visionLine({ quantity: 1, quantity_received: 1 }), feb(1), units, NONE, 11)!,
    project(verizonLine(), feb(2), [], NONE, 12)!,
  ];
  const r = PurchaseBillSchema.safeParse(billDoc(1, items));
  assert(r.success, JSON.stringify(r.error?.issues));
});

// ── The pricer ──────────────────────────────────────────────────────

Deno.test("pricePurchaseDocument: a pushed time line's money is re-derived from rates × counts; a linked document is untouched", () => {
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = project(visionLine({ quantity: 1, quantity_received: 1 }), feb(1), units)!;
  const stale = { ...line, amount_cents: 1 };
  const flat = project(buyLine(), feb(1), [], NONE, 12, 1)!;
  const pushed = pricePurchaseDocument({ origin: "pushed", items: [stale, flat] });
  assertEquals(pushed.items[0].amount_cents, line.amount_cents);
  assertEquals(pushed.total_cents, line.amount_cents + flat.amount_cents);
  const linked = pricePurchaseDocument({ origin: "linked", items: [stale] });
  assertEquals(linked.items[0].amount_cents, 1);
  assertEquals(linked.total_cents, null);
});

// ── The purchase → bill sync ────────────────────────────────────────

function purchaseDoc(items: PurchaseItem[]): Purchase {
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
    items,
    total_cents: 0,
    query_by_products: [PRODUCT],
    query_by_orders: [],
    query_by_item_types: ["subrent"],
    query_by_bills: [],
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
  };
}

Deno.test("purchaseBillSharedLineFields: price follows as formula ATOM + rates VALUE + discount terms; quantity, amount and dates never", () => {
  const kinds = Object.fromEntries(purchaseBillSharedLineFields().map((f) => [f.path, f.kind]));
  assertEquals(kinds["price.price_formula"], "atom");
  assertEquals(kinds["price.rates"], "propagated");
  assertEquals(kinds["price.discount.rate"], "propagated");
  assertEquals(kinds["price.discount.amount_cents"], "derived");
  assertEquals(kinds["quantity"], "homonym");
  assertEquals(kinds["amount_cents"], "homonym");
  assertEquals(kinds["dates"], "homonym");
  assertEquals(kinds["units"], undefined);
});

Deno.test("syncPurchaseToBills: a rate change reaches an un-overridden time line and re-prices it; windows and quantity never move", () => {
  const prevItem = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = project(prevItem, feb(1), units)!; // 19 nights → 3 weeks
  const bill = billDoc(1, [line]);
  const raised = [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 5000 }];
  const nextItem = { ...prevItem, name: "Hotspot (5G)", price: { ...prevItem.price, rates: raised } };
  const [out] = syncPurchaseToBills(
    { prev: purchaseDoc([prevItem]), next: purchaseDoc([nextItem]), bills: [bill], credits: [] },
    CTX,
  );
  assert(out.changed);
  assertEquals(out.overridden, []);
  const synced = out.bill.items[0];
  assertEquals(synced.price?.rates, raised);
  assertEquals(synced.name, "Hotspot (5G)");
  assertEquals(synced.units, line.units);
  assertEquals(synced.quantity, line.quantity);
  assertEquals(synced.amount_cents, 15000);
  assertEquals(out.bill.totals.total_cents, 15000);
  const parsed = PurchaseBillSchema.safeParse(out.bill);
  assert(parsed.success, JSON.stringify(parsed.error?.issues));
});

Deno.test("syncPurchaseToBills: an operator's rate override is KEPT, and reported", () => {
  const prevItem = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = project(prevItem, feb(1), units)!;
  const operator = [{ rate_key: "month", amount_cents: 15000 }, { rate_key: "week", amount_cents: 4000 }];
  const edited = pricePurchaseDocument({ origin: "pushed", items: [{ ...line, price: { ...line.price!, rates: operator } }] }).items[0];
  const bill = billDoc(1, [edited]);
  const nextItem = { ...prevItem, price: { ...prevItem.price, rates: VISION_RATES.map((r) => ({ ...r, amount_cents: r.amount_cents + 100 })) } };
  const [out] = syncPurchaseToBills(
    { prev: purchaseDoc([prevItem]), next: purchaseDoc([nextItem]), bills: [bill], credits: [] },
    CTX,
  );
  assertEquals(out.changed, false);
  assertEquals(out.overridden, ["items[0].price.rates"]);
  assertEquals(out.bill, bill);
});

Deno.test("syncPurchaseToBills: a linked, a frozen and a voided bill are skipped whole", () => {
  const prevItem = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = project(prevItem, feb(1), units)!;
  const nextItem = { ...prevItem, name: "Renamed" };
  const t = line.amount_cents;
  const bills = [
    billDoc(1, [line], { origin: "linked", xero_id: "8a1b2c3d-0000-4000-8000-000000000001" }),
    billDoc(2, [line], { totals: { total_cents: t, amount_paid_cents: t, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0 } }),
    billDoc(3, [line], { totals: { total_cents: t, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: t, amount_due_cents: 0 } }),
  ];
  const out = syncPurchaseToBills({ prev: purchaseDoc([prevItem]), next: purchaseDoc([nextItem]), bills, credits: [] }, CTX);
  assertEquals(out.map((o) => o.changed), [false, false, false]);
  // Companion: the same bill pushed and open DOES follow.
  const [open] = syncPurchaseToBills({ prev: purchaseDoc([prevItem]), next: purchaseDoc([nextItem]), bills: [billDoc(4, [line])], credits: [] }, CTX);
  assertEquals(open.bill.items[0].name, "Renamed");
});

Deno.test("syncPurchaseToBills: a FORMULA change re-meters the line from its own windows", () => {
  const prevItem = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = project(prevItem, feb(1), units)!;
  const weeklyOnly = { ...VISION, uid: "WeeklyOnlyFormula000", name: "Weekly", segments: [VISION.segments[1]] };
  const ctx = { ...CTX, formulas: new Map([...CTX.formulas, [weeklyOnly.uid, weeklyOnly]]) };
  const nextItem = {
    ...prevItem,
    price: { price_formula: priceFormulaRefOf(weeklyOnly), rates: [{ rate_key: "week", amount_cents: 4500 }], discount: null },
  };
  const [out] = syncPurchaseToBills({ prev: purchaseDoc([prevItem]), next: purchaseDoc([nextItem]), bills: [billDoc(1, [line])], credits: [] }, ctx);
  assertEquals(out.bill.items[0].price?.counts, [{ rate_key: "week", num: 3, den: 1 }]);
  assertEquals(out.bill.items[0].amount_cents, 13500);
});

Deno.test("syncPurchaseToBills: a RATE change re-meters a capped line, so the sync and a bill edit cannot price it differently", () => {
  const prevItem = visionLine({ quantity: 1, quantity_received: 1 });
  // 27 nights: four started weeks ($180) cap at the month ($157.50).
  const line = project(prevItem, feb(1), [unit(1, [{ start: jan(1), end: jan(28) }])])!;
  assertEquals(line.amount_cents, 15750);
  // The month rises to $200, so four weeks at $45 ($180) is now the cheaper reading.
  const raised = [{ rate_key: "month", amount_cents: 20000 }, { rate_key: "week", amount_cents: 4500 }];
  const nextItem = { ...prevItem, price: { ...prevItem.price, rates: raised } };
  const [out] = syncPurchaseToBills({ prev: purchaseDoc([prevItem]), next: purchaseDoc([nextItem]), bills: [billDoc(1, [line])], credits: [] }, CTX);
  assertEquals(out.bill.items[0].price?.counts, [{ rate_key: "month", num: 0, den: 1 }, { rate_key: "week", num: 4, den: 1 }]);
  assertEquals(out.bill.items[0].amount_cents, 18000);
  assertEquals(out.bill.totals.total_cents, 18000);
  // Companion: keeping the stored month count prices the same 27 nights at $200.
  assertEquals(priceFromFormula(raised, line.price!.counts, 1, null).subtotal_discounted_cents, 20000);
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

// ── The purchase ↔ bill diff (D6) ───────────────────────────────────

const credit = (items: PurchaseDocumentItem[], status: PurchaseCredit["status"] = "issued") =>
  ({ uid: "testcred100000000000", number: 1, version: 0, status, items }) as unknown as PurchaseCredit;

Deno.test("diff: a bill line that matches its purchase line is silent, on both views", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const line = project(buyLine(), feb(1), [], NONE, 10, 3)!;
  const bill = billDoc(1, [line]);
  const sources = { purchase: purchaseDoc([item]), bills: [bill], credits: [] };
  assertEquals(computePurchaseBillDiffs({ kind: "purchase" }, sources).lines.size, 0);
  assertEquals(computePurchaseBillDiffs({ kind: "bill", uid: bill.uid }, sources).lines.size, 0);
});

Deno.test("diff: an overridden account is a `differs` on both views, here/there in each view's own sense", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const line = { ...project(buyLine(), feb(1), [], NONE, 10, 3)!, coa_posting: 6500 };
  const bill = billDoc(1, [line]);
  const sources = { purchase: purchaseDoc([item]), bills: [bill], credits: [] };
  const onBill = computePurchaseBillDiffs({ kind: "bill", uid: bill.uid }, sources).lines.get(line.path.join("/"));
  assertEquals(onBill?.map((e) => e.kind), ["differs"]);
  assertEquals((onBill![0] as { fields: unknown }).fields, [{ field: "coa_posting", here: 6500, there: 1999 }]);
  const onPurchase = computePurchaseBillDiffs({ kind: "purchase" }, sources).lines.get(item.path.join("/"));
  assertEquals((onPurchase![0] as { fields: unknown }).fields, [{ field: "coa_posting", here: 1999, there: 6500 }]);
});

Deno.test("diff: OVER-billing a flat line is a `billed` entry summed across bills net of credits — flagged, never refused", () => {
  const item = buyLine({ quantity_billed: 4, quantity_received: 3 });
  const a = project(buyLine(), feb(1), [], NONE, 10, 2)!;
  const b = project(buyLine({ quantity_billed: 2 }), feb(1), [], NONE, 11, 2)!;
  const sources = { purchase: purchaseDoc([item]), bills: [billDoc(1, [a]), billDoc(2, [b])], credits: [] };
  const [entry] = computePurchaseBillDiffs({ kind: "purchase" }, sources).lines.get(item.path.join("/"))!;
  assertEquals(entry.kind, "billed");
  const billed = entry as { billed: number; ordered: number; received: number; billed_cents: number; expected_cents: number };
  assertEquals([billed.ordered, billed.received, billed.billed], [3, 3, 4]);
  assertEquals(billed.billed_cents, billed.expected_cents);
  // A credit of the extra unit makes it agree again.
  const back = project(buyLine({ quantity_billed: 3 }), feb(1), [], NONE, 12, 1)!;
  const credited = { ...sources, credits: [credit([back])] };
  assertEquals(computePurchaseBillDiffs({ kind: "purchase" }, credited).lines.size, 0);
  // …and a VOID credit does not.
  assertEquals(computePurchaseBillDiffs({ kind: "purchase" }, { ...sources, credits: [credit([back], "void")] }).lines.size, 1);
});

Deno.test("diff: a flat line billed at the wrong money is flagged even at the right count", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const line = { ...project(buyLine(), feb(1), [], NONE, 10, 3)!, amount_cents: 140000 };
  const sources = { purchase: purchaseDoc([item]), bills: [billDoc(1, [line], { origin: "linked", xero_id: "8a1b2c3d-0000-4000-8000-000000000001" })], credits: [] };
  const [entry] = computePurchaseBillDiffs({ kind: "purchase" }, sources).lines.get(item.path.join("/"))!;
  assertEquals((entry as { billed_cents: number; expected_cents: number }).billed_cents, 140000);
  assertEquals((entry as { expected_cents: number }).expected_cents, 140985);
});

Deno.test("diff: a document-only charge line is `not_on_source` on the bill view", () => {
  const item = buyLine({ quantity_billed: 3, quantity_received: 3 });
  const freight: PurchaseDocumentItem = {
    type: "charge", uid: iuid(20), path: [iuid(20)], name: "Freight", quantity: 1, amount_cents: 1500, coa_posting: 5300,
    uid_tracking_category: null, price: { price_formula: FIXED_REF, rates: [], discount: null, counts: [] }, units: [], dates: null,
  };
  const bill = billDoc(1, [project(buyLine(), feb(1), [], NONE, 10, 3)!, freight]);
  const got = computePurchaseBillDiffs({ kind: "bill", uid: bill.uid }, { purchase: purchaseDoc([item]), bills: [bill], credits: [] });
  assertEquals(got.lines.get(iuid(20))?.map((e) => e.kind), ["not_on_source"]);
});

Deno.test("diff: a time line's COVERAGE — recorded-not-billed and billed-not-recorded, per unit", () => {
  const item = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = project(item, jan(10), units)!; // bills Jan 1 → Jan 10
  // The supplier also billed Jan 25 → Jan 28, which no window recorded.
  const extra = { ...line, units: [{ uid_unit: "unit-1", charge_windows: [{ start: jan(1), end: jan(10) }, { start: jan(25), end: jan(28) }] }] };
  const sources = { purchase: purchaseDoc([item]), bills: [billDoc(1, [extra])], credits: [], units, through: feb(1) };
  const [entry] = computePurchaseBillDiffs({ kind: "purchase" }, sources).lines.get(item.path.join("/"))!;
  assertEquals(entry, {
    kind: "coverage",
    bills: [{ kind: "bill", uid: "testbill000000000001", number: 1, version: 0 }],
    uid_unit: "unit-1",
    recorded_not_billed: [{ start: jan(10), end: jan(20) }],
    billed_not_recorded: [{ start: jan(25), end: jan(28) }],
  });
  // Without units/through, coverage is not asked.
  assertEquals(computePurchaseBillDiffs({ kind: "purchase" }, { ...sources, units: undefined }).lines.size, 0);
});

Deno.test("diff: a LINKED time line's Xero money is compared with its own rates × counts; a pushed one cannot differ", () => {
  const item = visionLine({ quantity: 1, quantity_received: 1 });
  const units = [unit(1, [{ start: jan(1), end: jan(20) }])];
  const line = { ...project(item, feb(1), units)!, amount_cents: 12000 };
  const linked = billDoc(1, [line], { origin: "linked", xero_id: "8a1b2c3d-0000-4000-8000-000000000001" });
  const got = computePurchaseBillDiffs({ kind: "bill", uid: linked.uid }, { purchase: purchaseDoc([item]), bills: [linked], credits: [] });
  const [entry] = got.lines.get(line.path.join("/"))!;
  assertEquals((entry as { fields: unknown }).fields, [{ field: "amount_cents", here: 12000, there: 13500 }]);
});

// ── Time credits: un-billing windows ──────────────────────────────

const creditOf = (items: PurchaseDocumentItem[]) => ({ status: "issued" as const, items });

Deno.test("time credit: crediting everything a bill billed reverses it exactly, and leaves nothing billed", () => {
  const item = visionLine();
  const units = [unit(1, [{ start: jan(1), end: jan(15) }]), unit(2, [{ start: jan(3), end: jan(10) }])];
  const billLine = project(item, jan(20), units)!;
  const billed: PurchaseBilledDocuments = { bills: [billDoc(1, [billLine])], credits: [] };
  const credit = projectPurchaseLineToCreditLine(
    item,
    { uid: iuid(40), units: billLine.units!, dates: null, quantity: 2, billed },
    CTX,
  );
  assertEquals(credit.amount_cents, billLine.amount_cents);
  assertEquals(credit.price?.counts, billLine.price?.counts);
  assertEquals(credit.quantity, 2);
  const after: PurchaseBilledDocuments = { bills: billed.bills, credits: [creditOf([credit])] };
  assertEquals(billedUnitCoverage(after, item.path).size, 0, "the credit un-bills all of it");
  // Companion: the same windows cannot be credited twice.
  assertThrows(() =>
    projectPurchaseLineToCreditLine(item, { uid: iuid(41), units: billLine.units!, dates: null, quantity: 2, billed: after }, CTX)
  );
});

Deno.test("time credit: a window nobody billed cannot be credited", () => {
  const item = visionLine();
  const units = [unit(1, [{ start: jan(1), end: jan(8) }])];
  const billed: PurchaseBilledDocuments = { bills: [billDoc(1, [project(item, jan(20), units)!])], credits: [] };
  const inside = [{ uid_unit: "unit-1", charge_windows: [{ start: jan(2), end: jan(4) }] }];
  const outside = [{ uid_unit: "unit-1", charge_windows: [{ start: jan(6), end: jan(12) }] }];
  projectPurchaseLineToCreditLine(item, { uid: iuid(40), units: inside, dates: null, quantity: 1, billed }, CTX);
  assertThrows(
    () => projectPurchaseLineToCreditLine(item, { uid: iuid(40), units: outside, dates: null, quantity: 1, billed }, CTX),
    Error,
    "not billed",
  );
  assertThrows(
    () => projectPurchaseLineToCreditLine(buyLine(), { uid: iuid(40), units: inside, dates: null, quantity: 1, billed }, CTX),
    Error,
    "credit it in units",
  );
});

Deno.test("time credit: a tail credited out of a CAPPED month credits the delta, not the tail's weeks (Q14)", () => {
  const item = visionLine({ quantity: 1, uid_units: ["unit-1"] });
  // 27 nights: four started weeks ($180) cap at the month ($157.50).
  const units = [unit(1, [{ start: jan(1), end: jan(28) }])];
  const billLine = project(item, jan(28), units)!;
  assertEquals(billLine.amount_cents, 15750);
  const billed: PurchaseBilledDocuments = { bills: [billDoc(1, [billLine])], credits: [] };
  // Credit the last 6 nights: 21 nights stay billed — three weeks ($135), under the cap.
  const tail = [{ uid_unit: "unit-1", charge_windows: [{ start: jan(22), end: jan(28) }] }];
  const credit = projectPurchaseLineToCreditLine(item, { uid: iuid(40), units: tail, dates: null, quantity: 1, billed }, CTX);
  assertEquals(credit.amount_cents, 15750 - 3 * 4500);
  // Companion: metering only the credited piece reads one week ($45) — the naive form disagrees.
  const naive = money(meterUnits(VISION, { windows: tail[0].charge_windows, span: null, holidays: [], rates: VISION_RATES }).tiers);
  assertEquals(naive, 4500);
  assertNotEquals(naive, credit.amount_cents);
});

Deno.test("time credit: a SPAN credit must lie inside the billed span and not overlap an earlier span credit", () => {
  const item = verizonLine({ uid_units: [] });
  const billLine = project(item, feb(2), [])!;
  assert(billLine.dates !== null);
  const billed: PurchaseBilledDocuments = { bills: [billDoc(1, [billLine])], credits: [] };
  const credit = projectPurchaseLineToCreditLine(
    item,
    { uid: iuid(40), units: [], dates: { start: jan(2), end: feb(2) }, quantity: 1, billed },
    CTX,
  );
  assertEquals(credit.amount_cents, billLine.amount_cents, "a credit of the whole billed span reverses it");
  assertThrows(
    () => projectPurchaseLineToCreditLine(item, { uid: iuid(41), units: [], dates: { start: jan(2), end: feb(10) }, quantity: 1, billed }, CTX),
    Error,
    "not inside",
  );
  const after: PurchaseBilledDocuments = { bills: billed.bills, credits: [creditOf([credit])] };
  assertThrows(
    () => projectPurchaseLineToCreditLine(item, { uid: iuid(42), units: [], dates: { start: jan(10), end: jan(20) }, quantity: 1, billed: after }, CTX),
    Error,
    "already credited",
  );
});
