import { assertEquals, assertThrows } from "@std/assert";
import { getInitialValues, OrderDocLineItem, OrderDocTransactionFeeItem } from "../src/schemas/mod.ts";
import {
  calculateItemDiscount,
  calculateItemPrice,
  calculateItemSubtotal,
  calculateItemTax,
  calculateItemTotal,
  calculateOrderTotals,
  calculateReplacementTotals,
  buildPackingList,
  buildQueryByDates,
  deriveOrderDateEnvelope,
  computeItemPaths,
  consolidateItems,
  validateItemPaths,
  validateItemUniqueness,
  getGroupItems,
  getGroupPath,
  getGroupTotals,
  getItemSubtreeRange,
  getParentProductUid,
  getRemovalIndices,
  getStructuralUids,
  getTransactionFeeTotals,
  getTaxTotals,
  getTotalDiscount,
  groupByDestination,
  isPriceableItem,
  isPreTaxItem,
  isTransactionFeeItem,
  isSameAsDeliveryDates,
  isSameAsDeliveryDestination,
  getDestinationPairItemName,
  getDestinationsLegend,
  getDefaultChargeDays,
  syncChargeDaysToItems,
  type LineItem,
  type PriceObject,
  type Tax,
  orderHasDiscount,
  orderHasRentals,
  orderHasTax,
} from "../src/utils/orders.ts";
import type { OrderDatesType, DestinationType, OrderDocDatesType, FirestoreTimestampType } from "../src/schemas/mod.ts";

const lineItemBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
const priceBase = lineItemBase.price as Record<string, unknown>;
const feeItemBase = getInitialValues(OrderDocTransactionFeeItem) as Record<string, unknown>;
const feePriceBase = feeItemBase.price as Record<string, unknown>;

const TAXES: Tax[] = [
  { uid: "chi-rental-tax", name: "Chicago Rental Tax", rate: 15, type: "percent" },
  { uid: "chi-sales-tax", name: "Chicago Sales Tax", rate: 10.25, type: "percent" },
  { uid: "rantoul-sales-tax", name: "Rantoul Sales Tax", rate: 9, type: "percent" },
  { uid: "water-bottle-tax", name: "Water Bottle Tax", rate: 0.05, type: "flat" },
  { uid: "tax-none", name: "No Tax", rate: 0, type: "percent" },
];

function makeItem(
  overrides: Partial<LineItem> = {},
  priceOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    ...lineItemBase,
    name: "Test Item",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      base: 100,
      chargeable_days: 5,
      ...priceOverrides,
    },
  } as LineItem;
}

function makeFeeItem(
  overrides: Partial<LineItem> = {},
  feeOverrides: Record<string, unknown> = {},
): LineItem {
  return {
    ...feeItemBase,
    name: "CC Processing Fee",
    quantity: 1,
    ...overrides,
    price: {
      ...feePriceBase,
      uid: "cc-fee-product",
      name: "Credit Card Processing Fee",
      rate: 3,
      ...feeOverrides,
    },
  } as LineItem;
}

// ── isPriceableItem ──────────────────────────────────────────────

Deno.test("isPriceableItem returns true for rental with price", () => {
  assertEquals(isPriceableItem(makeItem()), true);
});

Deno.test("isPriceableItem returns false for destination", () => {
  assertEquals(isPriceableItem({ type: "destination" } as LineItem), false);
});

Deno.test("isPriceableItem returns false for group", () => {
  assertEquals(isPriceableItem({ type: "group" } as LineItem), false);
});

Deno.test("isPriceableItem returns false without price", () => {
  assertEquals(isPriceableItem({ type: "rental" } as LineItem), false);
});

Deno.test("isPriceableItem returns true for transaction fee with price", () => {
  assertEquals(isPriceableItem(makeFeeItem()), true);
});

// ── isTransactionFeeItem ─────────────────────────────────────────

Deno.test("isTransactionFeeItem returns true for fee item", () => {
  assertEquals(isTransactionFeeItem(makeFeeItem()), true);
});

Deno.test("isTransactionFeeItem returns false for rental", () => {
  assertEquals(isTransactionFeeItem(makeItem()), false);
});

// ── isPreTaxItem ─────────────────────────────────────────────────

Deno.test("isPreTaxItem returns true for rental with price", () => {
  assertEquals(isPreTaxItem(makeItem()), true);
});

Deno.test("isPreTaxItem returns false for transaction fee", () => {
  assertEquals(isPreTaxItem(makeFeeItem()), false);
});

Deno.test("isPreTaxItem returns false for destination", () => {
  assertEquals(isPreTaxItem({ type: "destination" } as LineItem), false);
});

// ── calculateItemSubtotal ────────────────────────────────────────

// Exactness. Factors are applied as `× n ÷ d`, never as `× (n/d)`: neither
// `chargeable_days / 5` nor `(100 - rate) / 100` is representable in binary, and
// currency.js quantizes every intermediate at its precision. The subtotal path
// tolerated it (currency.js re-quantized after each multiply and never flipped a
// tie in 300k random lines); the discount path did not — it mis-rounded 14 of
// those 300k lines by a cent, always upward.

Deno.test("calculateItemSubtotal: percent discount rounds by the exact rational, not a float factor", () => {
  // Was: currency(3342.41).multiply(11) → 36766.51, then .multiply((100 - 89.1914)/100)
  //   = .multiply(0.10808600000000006) → 3973.95. The exact value is 3973.9449…,
  // which rounds to 3973.94. The float factor pushed it over the .005 boundary.
  const item = makeItem({ quantity: 11 }, { base: 3342.41, chargeable_days: 4, discount: { type: "percent", rate: 89.1914, amount: 0 } });
  const r = calculateItemSubtotal(item);
  assertEquals(r.subtotal, 36766.51); // 4 days → below the one-week floor → factor 1
  assertEquals(r.subtotal_discounted, 3973.94);
});

Deno.test("calculateItemSubtotal: a second exact-rounding case, with the day factor engaged", () => {
  // base 4109.19 × qty 25 × (31/5) = 636,924.45; × (1 - 0.722409) = 176,804.49…
  const item = makeItem({ quantity: 25 }, { base: 4109.19, chargeable_days: 31, discount: { type: "percent", rate: 72.2409, amount: 0 } });
  const r = calculateItemSubtotal(item);
  assertEquals(r.subtotal, 636924.45);
  assertEquals(r.subtotal_discounted, 176804.49);
});

Deno.test("calculateItemSubtotal: the day factor is applied as × days ÷ 5, exactly", () => {
  // 23/5 = 4.6 is not exact in binary. base 60 × qty 6 × 23 ÷ 5 = 1656 exactly.
  const r = calculateItemSubtotal(makeItem({ quantity: 6 }, { base: 60, chargeable_days: 23 }));
  assertEquals(r.subtotal, 1656);
  assertEquals(r.subtotal_discounted, 1656);
});

Deno.test("calculateItemSubtotal: flat discount is per-unit, per pricing factor", () => {
  // rate 10/unit × qty 2 × (10/5) = 40 off a 100 × 2 × 2 = 400 subtotal.
  const item = makeItem({ quantity: 2 }, { base: 100, chargeable_days: 10, discount: { type: "flat", rate: 10, amount: 0 } });
  const r = calculateItemSubtotal(item);
  assertEquals(r.subtotal, 400);
  assertEquals(r.subtotal_discounted, 360);
});

Deno.test("calculateItemSubtotal: a flat discount larger than the line goes negative, not clamped", () => {
  const item = makeItem({ quantity: 1 }, { base: 10, chargeable_days: 5, discount: { type: "flat", rate: 25, amount: 0 } });
  assertEquals(calculateItemSubtotal(item).subtotal_discounted, -15);
});

Deno.test("calculateItemSubtotal: rejects an unknown formula", () => {
  const item = makeItem({}, { formula: "nonsense" });
  let threw = false;
  try { calculateItemSubtotal(item); } catch { threw = true; }
  assertEquals(threw, true);
});

Deno.test("calculateItemSubtotal five_day_week 1 week", () => {
  const result = calculateItemSubtotal(makeItem());
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
});

Deno.test("calculateItemSubtotal five_day_week 2 weeks", () => {
  const result = calculateItemSubtotal(makeItem({}, { chargeable_days: 10 }));
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 200);
});

Deno.test("calculateItemSubtotal five_day_week 3 days (min 1 week)", () => {
  const result = calculateItemSubtotal(makeItem({}, { chargeable_days: 3 }));
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
});

Deno.test("calculateItemSubtotal with percent discount", () => {
  const result = calculateItemSubtotal(makeItem({}, {
    discount: { rate: 10, type: "percent", amount: 0 },
  }));
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 90);
});

Deno.test("calculateItemSubtotal with flat discount", () => {
  const result = calculateItemSubtotal(makeItem({ quantity: 2 }, {
    chargeable_days: 5,
    discount: { rate: 10, type: "flat", amount: 0 },
  }));
  // subtotal = 100 * 2 * 1 = 200
  // flat discount = 10 * 2 * 1 = 20
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 180);
});

Deno.test("calculateItemSubtotal flat discount scales with days", () => {
  const result = calculateItemSubtotal(makeItem({ quantity: 1 }, {
    chargeable_days: 10,
    discount: { rate: 5, type: "flat", amount: 0 },
  }));
  // subtotal = 100 * 1 * 2 = 200
  // flat discount = 5 * 1 * 2 = 10
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 190);
});

Deno.test("calculateItemSubtotal with quantity", () => {
  const result = calculateItemSubtotal(makeItem({ quantity: 3 }));
  assertEquals(result.subtotal, 300);
  assertEquals(result.subtotal_discounted, 300);
});

Deno.test("calculateItemSubtotal fixed formula", () => {
  const result = calculateItemSubtotal(makeItem({}, { formula: "fixed", base: 50 }));
  assertEquals(result.subtotal, 50);
  assertEquals(result.subtotal_discounted, 50);
});

Deno.test("calculateItemSubtotal fixed with quantity and percent discount", () => {
  const result = calculateItemSubtotal(
    makeItem({ quantity: 2 }, { formula: "fixed", base: 100, discount: { rate: 25, type: "percent", amount: 0 } }),
  );
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 150);
});

Deno.test("calculateItemSubtotal throws for non-priceable", () => {
  assertThrows(
    () => calculateItemSubtotal({ type: "destination" } as LineItem),
    Error,
    "not priceable",
  );
});

Deno.test("calculateItemSubtotal throws for unknown formula", () => {
  assertThrows(
    () => calculateItemSubtotal(makeItem({}, { formula: "unknown" })),
    Error,
    "Unknown formula",
  );
});

// ── calculateItemTax ─────────────────────────────────────────────

Deno.test("calculateItemTax with no taxes returns empty array", () => {
  assertEquals(calculateItemTax(makeItem(), TAXES), []);
});

Deno.test("calculateItemTax with percent tax", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Chicago Sales Tax");
  assertEquals(result[0].amount, 10.25);
});

Deno.test("calculateItemTax with rental tax", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].amount, 15);
});

Deno.test("calculateItemTax with flat tax", () => {
  const item = makeItem({ quantity: 24 }, {
    formula: "fixed",
    base: 1,
    taxes: [{ uid: "water-bottle-tax" }],
  });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Water Bottle Tax");
  assertEquals(result[0].type, "flat");
  assertEquals(result[0].amount, 1.20);
});

Deno.test("calculateItemTax multi-tax per item", () => {
  const item = makeItem({ quantity: 24 }, {
    formula: "fixed",
    base: 1,
    taxes: [{ uid: "chi-sales-tax" }, { uid: "water-bottle-tax" }],
  });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "Chicago Sales Tax");
  assertEquals(result[0].amount, 2.46); // 24 * 0.1025
  assertEquals(result[1].name, "Water Bottle Tax");
  assertEquals(result[1].amount, 1.20); // 0.05 * 24
});

Deno.test("calculateItemTax throws for unknown tax uid", () => {
  const item = makeItem({}, { taxes: [{ uid: "nonexistent" }] });
  assertThrows(
    () => calculateItemTax(item, TAXES),
    Error,
    "Unknown tax uid",
  );
});

Deno.test("calculateItemTax applies to subtotal_discounted", () => {
  const item = makeItem({}, {
    discount: { rate: 20, type: "percent", amount: 0 },
    taxes: [{ uid: "chi-rental-tax" }],
  });
  // subtotal_discounted = 100 * 0.8 = 80
  // tax = 80 * 0.15 = 12
  const result = calculateItemTax(item, TAXES);
  assertEquals(result[0].amount, 12);
});

// ── calculateItemPrice ───────────────────────────────────────────

Deno.test("calculateItemPrice computes full pipeline", () => {
  const item = makeItem({}, {
    discount: { rate: 20, type: "percent", amount: 0 },
    taxes: [{ uid: "chi-rental-tax" }],
  });
  const result = calculateItemPrice(item, TAXES);
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 80);
  assertEquals(result.discount!.rate, 20);
  assertEquals(result.discount!.type, "percent");
  assertEquals(result.discount!.amount, 20);
  assertEquals(result.taxes[0].amount, 12); // 80 * 0.15
  assertEquals(result.total, 92); // 80 + 12
});

Deno.test("calculateItemPrice with no discount", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] });
  const result = calculateItemPrice(item, TAXES);
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
  assertEquals(result.discount, null);
  assertEquals(result.total, 110.25);
});

// ── calculateItemTotal ───────────────────────────────────────────

Deno.test("calculateItemTotal no tax", () => {
  assertEquals(calculateItemTotal(makeItem(), TAXES), 100);
});

Deno.test("calculateItemTotal with tax", () => {
  assertEquals(
    calculateItemTotal(makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] }), TAXES),
    110.25,
  );
});

Deno.test("calculateItemTotal for transaction fee item", () => {
  const fee = makeFeeItem({}, { amount: 42.50 });
  assertEquals(calculateItemTotal(fee, TAXES), 42.50);
});

// ── calculateItemDiscount ────────────────────────────────────────

Deno.test("calculateItemDiscount returns 0 for no discount", () => {
  assertEquals(calculateItemDiscount(makeItem()), 0);
});

Deno.test("calculateItemDiscount calculates 10% discount", () => {
  assertEquals(calculateItemDiscount(makeItem({}, {
    discount: { rate: 10, type: "percent", amount: 0 },
  })), 10);
});

Deno.test("calculateItemDiscount fixed formula", () => {
  assertEquals(
    calculateItemDiscount(
      makeItem({}, { formula: "fixed", base: 100, discount: { rate: 20, type: "percent", amount: 0 } }),
    ),
    20,
  );
});

Deno.test("calculateItemDiscount flat discount", () => {
  assertEquals(
    calculateItemDiscount(
      makeItem({ quantity: 3 }, { discount: { rate: 5, type: "flat", amount: 0 } }),
    ),
    15, // 5 * 3 * (5/5)
  );
});

// ── getTotalDiscount ─────────────────────────────────────────────

Deno.test("getTotalDiscount sums all item discounts", () => {
  const items = [
    makeItem({}, { discount: { rate: 10, type: "percent", amount: 0 } }),
    makeItem({}, { discount: { rate: 20, type: "percent", amount: 0 } }),
  ];
  assertEquals(getTotalDiscount(items), 30);
});

Deno.test("getTotalDiscount skips non-priceable items", () => {
  const items = [
    makeItem({}, { discount: { rate: 10, type: "percent", amount: 0 } }),
    { type: "destination" } as LineItem,
  ];
  assertEquals(getTotalDiscount(items), 10);
});

Deno.test("getTotalDiscount skips transaction fee items", () => {
  const items = [
    makeItem({}, { discount: { rate: 10, type: "percent", amount: 0 } }),
    makeFeeItem(),
  ];
  assertEquals(getTotalDiscount(items), 10);
});

// ── getTaxTotals ─────────────────────────────────────────────────

Deno.test("getTaxTotals groups by tax name", () => {
  const items = [
    makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] }),
    makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] }),
    makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] }),
    makeItem(),
  ];
  const result = getTaxTotals(items, TAXES);
  const salesTax = result.find((t) => t.name === "Chicago Sales Tax");
  const rentalTax = result.find((t) => t.name === "Chicago Rental Tax");
  assertEquals(salesTax?.amount, 20.50);
  assertEquals(rentalTax?.amount, 15);
  assertEquals(result.length, 2); // tax_none excluded (zero amount)
});

// ── getTransactionFeeTotals ──────────────────────────────────────

Deno.test("getTransactionFeeTotals aggregates fee items", () => {
  const items = [
    makeFeeItem({}, { amount: 10 }),
    makeFeeItem({}, { amount: 5 }),
  ];
  const result = getTransactionFeeTotals(items);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Credit Card Processing Fee");
  assertEquals(result[0].amount, 15);
});

// ── calculateOrderTotals ─────────────────────────────────────────

Deno.test("calculateOrderTotals computes all totals", () => {
  const items = [
    makeItem({}, { taxes: [{ uid: "chi-sales-tax" }], discount: { rate: 10, type: "percent", amount: 0 } }),
    makeItem({}, { formula: "fixed", base: 50 }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  assertEquals(result.subtotal, 150); // 100 + 50
  assertEquals(result.subtotal_discounted, 140); // 90 + 50
  assertEquals(result.discount_amount, 10);
  assertEquals(result.taxes.find((t) => t.name === "Chicago Sales Tax")?.amount, 9.23); // 90 * 0.1025
  assertEquals(result.total, 149.23); // 140 + 9.23
});

Deno.test("calculateOrderTotals two-pass with transaction fee", () => {
  const items = [
    makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] }),
    makeFeeItem({}, { rate: 3, type: "percent" }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // subtotal = 100, subtotal_discounted = 100
  // tax = 100 * 0.15 = 15
  // fee = 100 * 0.03 = 3
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 100);
  assertEquals(result.taxes[0].amount, 15);
  assertEquals(result.transaction_fees[0].amount, 3);
  assertEquals(result.total, 118); // 100 + 15 + 3
});

Deno.test("calculateOrderTotals fee based on subtotal_discounted", () => {
  const items = [
    makeItem({}, {
      discount: { rate: 20, type: "percent", amount: 0 },
      taxes: [{ uid: "chi-rental-tax" }],
    }),
    makeFeeItem({}, { rate: 3, type: "percent" }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // subtotal = 100, subtotal_discounted = 80
  // tax = 80 * 0.15 = 12
  // fee = 80 * 0.03 = 2.40
  assertEquals(result.subtotal, 100);
  assertEquals(result.subtotal_discounted, 80);
  assertEquals(result.discount_amount, 20);
  assertEquals(result.taxes[0].amount, 12);
  assertEquals(result.transaction_fees[0].amount, 2.40);
  assertEquals(result.total, 94.40); // 80 + 12 + 2.40
});

Deno.test("calculateOrderTotals flat transaction fee", () => {
  const items = [
    makeItem(),
    makeFeeItem({ quantity: 2 }, { rate: 5, type: "flat" }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // fee = 5 * 2 = 10
  assertEquals(result.transaction_fees[0].amount, 10);
  assertEquals(result.total, 110); // 100 + 0 + 10
});

Deno.test("calculateOrderTotals includes replacement_total", () => {
  const items = [
    makeItem({ quantity: 1 }, { replacement: 500, taxes: [{ uid: "chi-sales-tax" }] }),
    makeItem({ quantity: 2 }, { replacement: 300 }),
  ];
  const result = calculateOrderTotals(items, TAXES);
  // replacement subtotal = 500 + 600 = 1100
  // replacement tax = 500 * 0.1025 = 51.25
  // replacement total = 1100 + 51.25 = 1151.25
  assertEquals(result.replacement_total, 1151.25);
});

Deno.test("calculateOrderTotals replacement_total is 0 when no replacement values", () => {
  const items = [makeItem(), makeItem()];
  const result = calculateOrderTotals(items, TAXES);
  assertEquals(result.replacement_total, 0);
});

// ── Order inspection helpers ─────────────────────────────────────

Deno.test("orderHasRentals detects rental items", () => {
  assertEquals(orderHasRentals([makeItem()]), true);
  assertEquals(orderHasRentals([makeItem({ type: "sale" })]), false);
});

Deno.test("orderHasDiscount detects discounted items", () => {
  assertEquals(orderHasDiscount([makeItem({}, {
    discount: { rate: 10, type: "percent", amount: 0 },
  })]), true);
  assertEquals(orderHasDiscount([makeItem()]), false);
});

Deno.test("orderHasTax detects taxed items", () => {
  assertEquals(
    orderHasTax([makeItem({}, { taxes: [{ uid: "chi-sales-tax" }] })]),
    true,
  );
  assertEquals(orderHasTax([makeItem()]), false);
});

// ── calculateReplacementTotals ───────────────────────────────────

Deno.test("calculateReplacementTotals returns zeros when no replacement values", () => {
  const items = [makeItem(), makeItem()];
  const result = calculateReplacementTotals(items, TAXES);
  assertEquals(result.subtotal, 0);
  assertEquals(result.tax, 0);
  assertEquals(result.total, 0);
});

Deno.test("calculateReplacementTotals sums replacement values across items", () => {
  const items = [
    makeItem({ quantity: 1 }, { replacement: 500 }),
    makeItem({ quantity: 2 }, { replacement: 300 }),
  ];
  const result = calculateReplacementTotals(items, TAXES);
  // 500 * 1 + 300 * 2 = 1100
  assertEquals(result.subtotal, 1100);
  assertEquals(result.tax, 0);
  assertEquals(result.total, 1100);
});

Deno.test("calculateReplacementTotals applies percent tax to replacement subtotal", () => {
  const items = [
    makeItem({ quantity: 1 }, { replacement: 1000, taxes: [{ uid: "chi-sales-tax" }] }),
  ];
  const result = calculateReplacementTotals(items, TAXES);
  // subtotal = 1000, tax = 1000 * 0.1025 = 102.50
  assertEquals(result.subtotal, 1000);
  assertEquals(result.tax, 102.50);
  assertEquals(result.total, 1102.50);
});

Deno.test("calculateReplacementTotals applies flat tax per unit", () => {
  const items = [
    makeItem({ quantity: 10 }, { replacement: 50, formula: "fixed", taxes: [{ uid: "water-bottle-tax" }] }),
  ];
  const result = calculateReplacementTotals(items, TAXES);
  // subtotal = 50 * 10 = 500, tax = 0.05 * 10 = 0.50
  assertEquals(result.subtotal, 500);
  assertEquals(result.tax, 0.50);
  assertEquals(result.total, 500.50);
});

Deno.test("calculateReplacementTotals skips items with null replacement", () => {
  const items = [
    makeItem({ quantity: 1 }, { replacement: 500 }),
    makeItem({ quantity: 1 }, { replacement: null }),
  ];
  const result = calculateReplacementTotals(items, TAXES);
  assertEquals(result.subtotal, 500);
  assertEquals(result.total, 500);
});

Deno.test("calculateReplacementTotals skips non-priceable items", () => {
  const items: LineItem[] = [
    makeItem({ quantity: 1 }, { replacement: 500 }),
    { type: "destination", uid: "d1", name: "", path: [] },
  ];
  const result = calculateReplacementTotals(items, TAXES);
  assertEquals(result.subtotal, 500);
});

Deno.test("calculateReplacementTotals skips transaction fee items", () => {
  const items = [
    makeItem({ quantity: 1 }, { replacement: 500 }),
    makeFeeItem(),
  ];
  const result = calculateReplacementTotals(items, TAXES);
  assertEquals(result.subtotal, 500);
});

Deno.test("calculateReplacementTotals multi-tax on replacement", () => {
  const items = [
    makeItem({ quantity: 2 }, {
      replacement: 200,
      taxes: [{ uid: "chi-sales-tax" }, { uid: "chi-rental-tax" }],
    }),
  ];
  const result = calculateReplacementTotals(items, TAXES);
  // subtotal = 200 * 2 = 400
  // sales tax = 400 * 0.1025 = 41
  // rental tax = 400 * 0.15 = 60
  assertEquals(result.subtotal, 400);
  assertEquals(result.tax, 101);
  assertEquals(result.total, 501);
});

// ── getGroupPath ─────────────────────────────────────────────────

Deno.test("getGroupPath finds destination and group", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "dest-1" },
    { type: "group", uid: "g1", name: "Camera", path: ["d1", "g1"] },
    makeItem({ uid: "item-1", path: ["d1", "g1", "item-1"] }),
  ];
  const result = getGroupPath(items, 2);
  assertEquals(result.destination, "dest-1");
  assertEquals(result.group, "g1");
  assertEquals(result.product, null); // parent is group (structural), not a product
});

Deno.test("getGroupPath returns product parent for component", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "dest-1" },
    makeItem({ uid: "parent-1", path: ["d1", "parent-1"] }),
    makeItem({ uid: "child-1", path: ["d1", "parent-1", "child-1"] }),
  ];
  const result = getGroupPath(items, 2);
  assertEquals(result.destination, "dest-1");
  assertEquals(result.product, "parent-1");
});

Deno.test("getGroupPath returns nulls when no headers", () => {
  const items = [makeItem({ uid: "item-1", path: ["item-1"] })];
  const result = getGroupPath(items, 0);
  assertEquals(result.destination, null);
  assertEquals(result.group, null);
  assertEquals(result.product, null);
});

// ── consolidateItems ─────────────────────────────────────────────

Deno.test("consolidateItems deduplicates by uid", () => {
  const items = [
    makeItem({ uid: "p1", quantity: 2 }, { total: 200 }),
    makeItem({ uid: "p1", quantity: 1 }, { total: 100 }),
    makeItem({ uid: "p2", quantity: 1 }, { total: 50 }),
  ];
  const result = consolidateItems(items);
  assertEquals(result.length, 2);
  const p1 = result.find((r) => r.uid === "p1")!;
  assertEquals(p1.quantity, 3);
  assertEquals(p1.total_price, 300);
  assertEquals(p1.unit_price, 100);
});

Deno.test("consolidateItems skips structural items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1" },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
  ];
  const result = consolidateItems(items);
  assertEquals(result.length, 1);
  assertEquals(result[0].uid, "p1");
});

Deno.test("consolidateItems skips transaction fee items", () => {
  const items: LineItem[] = [
    makeItem({ uid: "p1" }),
    makeFeeItem({ uid: "fee-1" }),
  ];
  const result = consolidateItems(items);
  assertEquals(result.length, 1);
  assertEquals(result[0].uid, "p1");
});

// ── groupByDestination ───────────────────────────────────────────

Deno.test("groupByDestination splits by destination dividers", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1", uid_collection: "d1" },
    makeItem({ uid: "p1", type: "rental", path: ["d1", "p1"] }),
    makeItem({ uid: "p2", type: "sale", path: ["d1", "p2"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"], uid_delivery: "d2", uid_collection: "d2" },
    makeItem({ uid: "p3", type: "rental", path: ["d2", "p3"] }),
  ];
  const result = groupByDestination(items, "fallback");
  assertEquals(result.length, 2);
  assertEquals(result[0].uid_delivery, "d1");
  assertEquals(result[0].items.length, 2);
  assertEquals(result[0].packing_list_delivery.length, 2);
  assertEquals(result[0].packing_list_collection.length, 1);
  assertEquals(result[1].uid_delivery, "d2");
  assertEquals(result[1].items.length, 1);
});

Deno.test("groupByDestination uses fallback when no dividers", () => {
  const items = [makeItem({ uid: "p1", type: "rental" })];
  const result = groupByDestination(items, "fb-delivery", "fb-collection");
  assertEquals(result.length, 1);
  assertEquals(result[0].uid_delivery, "fb-delivery");
  assertEquals(result[0].uid_collection, "fb-collection");
});

Deno.test("groupByDestination returns empty section for empty items", () => {
  const result = groupByDestination([], "fb");
  assertEquals(result.length, 1);
  assertEquals(result[0].items.length, 0);
});

// ── getGroupItems ────────────────────────────────────────────────

Deno.test("getGroupItems collects destination children", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "g1", "p2"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
  ];
  const result = getGroupItems(items, 0);
  assertEquals(result.length, 2);
});

Deno.test("getGroupItems collects group children", () => {
  const items: LineItem[] = [
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "g1", "p2"] }),
    { type: "group", uid: "g2", name: "G2", path: ["d1", "g2"] },
  ];
  const result = getGroupItems(items, 0);
  assertEquals(result.length, 2);
});

Deno.test("getGroupItems collects all direct children for product", () => {
  const items: LineItem[] = [
    makeItem({ uid: "parent", path: ["d1", "parent"] }),
    makeItem({ uid: "child1", path: ["d1", "parent", "child1"], zero_priced: true }),
    makeItem({ uid: "child2", path: ["d1", "parent", "child2"] }),
    makeItem({ uid: "other", path: ["d1", "other"] }),
  ];
  const result = getGroupItems(items, 0);
  assertEquals(result.length, 2);
});

// ── getGroupTotals ───────────────────────────────────────────────

Deno.test("getGroupTotals returns count and pricing", () => {
  const items: LineItem[] = [
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "g1", "p2"] }),
  ];
  const result = getGroupTotals(items, 0, TAXES);
  assertEquals(result.count, 2);
  assertEquals(result.subtotal, 200);
  assertEquals(result.subtotal_discounted, 200);
  assertEquals(result.total, 200);
});

Deno.test("getGroupTotals returns zeros for empty group", () => {
  const items: LineItem[] = [
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    { type: "group", uid: "g2", name: "G2", path: ["d1", "g2"] },
  ];
  const result = getGroupTotals(items, 0, TAXES);
  assertEquals(result.count, 0);
  assertEquals(result.subtotal, 0);
  assertEquals(result.subtotal_discounted, 0);
  assertEquals(result.total, 0);
});

// ── buildPackingList ────────────────────────────────────────────

Deno.test("buildPackingList returns expanded items with group context", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1", uid_collection: "d1" },
    { type: "group", uid: "g1", name: "Tables", path: ["d1", "g1"] },
    makeItem({ uid: "p1", type: "rental", name: "Round Table", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", type: "sale", name: "Tablecloth", path: ["d1", "g1", "p2"] }),
    { type: "group", uid: "g2", name: "Chairs", path: ["d1", "g2"] },
    makeItem({ uid: "p3", type: "rental", name: "Folding Chair", path: ["d1", "g2", "p3"] }),
  ];
  const result = buildPackingList(items);
  assertEquals(result.length, 3);
  assertEquals(result[0], {
    uid: "p1", name: "Round Table", type: "rental",
    quantity: 1, stock_method: "bulk", group_name: "Tables",
  });
  assertEquals(result[1], {
    uid: "p2", name: "Tablecloth", type: "sale",
    quantity: 1, stock_method: "bulk", group_name: "Tables",
  });
  assertEquals(result[2], {
    uid: "p3", name: "Folding Chair", type: "rental",
    quantity: 1, stock_method: "bulk", group_name: "Chairs",
  });
});

Deno.test("buildPackingList excludes surcharges, fees, and structural items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1" },
    makeItem({ uid: "p1", type: "rental", path: ["d1", "p1"] }),
    { type: "surcharge", uid: "s1", name: "Damage Waiver", path: ["d1", "s1"] },
    { type: "transaction_fee", uid: "f1", name: "CC Fee", path: ["d1", "f1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
  ];
  const result = buildPackingList(items);
  assertEquals(result.length, 1);
  assertEquals(result[0].uid, "p1");
});

Deno.test("buildPackingList scoped to destination", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1", uid_collection: "d1" },
    makeItem({ uid: "p1", type: "rental", path: ["d1", "p1"] }),
    makeItem({ uid: "p2", type: "sale", path: ["d1", "p2"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"], uid_delivery: "d2", uid_collection: "d2" },
    makeItem({ uid: "p3", type: "rental", path: ["d2", "p3"] }),
  ];
  const result = buildPackingList(items, false, "d2");
  assertEquals(result.length, 1);
  assertEquals(result[0].uid, "p3");
});

Deno.test("buildPackingList consolidated deduplicates by uid", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1" },
    makeItem({ uid: "p1", type: "rental", quantity: 2, path: ["d1", "p1"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"], uid_delivery: "d2" },
    makeItem({ uid: "p1", type: "rental", quantity: 3, path: ["d2", "p1"] }),
  ];
  const result = buildPackingList(items, true);
  assertEquals(result.length, 1);
  assertEquals(result[0].uid, "p1");
  assertEquals(result[0].quantity, 5);
});

Deno.test("buildPackingList consolidated + destination scoped", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1" },
    makeItem({ uid: "p1", type: "rental", quantity: 2, path: ["d1", "p1"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"], uid_delivery: "d2" },
    makeItem({ uid: "p1", type: "rental", quantity: 3, path: ["d2", "p1"] }),
    makeItem({ uid: "p2", type: "sale", quantity: 1, path: ["d2", "p2"] }),
  ];
  const result = buildPackingList(items, true, "d2");
  assertEquals(result.length, 2);
  assertEquals(result.find((r) => r.uid === "p1")!.quantity, 3);
  assertEquals(result.find((r) => r.uid === "p2")!.quantity, 1);
});

Deno.test("buildPackingList returns empty for no eligible items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"], uid_delivery: "d1" },
    { type: "surcharge", uid: "s1", name: "Surcharge", path: ["d1", "s1"] },
  ];
  assertEquals(buildPackingList(items).length, 0);
  assertEquals(buildPackingList(items, true).length, 0);
});

// ── isSameAsDeliveryDates ───────────────────────────────────────

const baseDates: OrderDatesType = {
  delivery_start: "2025-01-06T15:00:00.000Z",
  delivery_end: "2025-01-06T15:00:00.000Z",
  collection_start: "2025-01-10T21:00:00.000Z",
  collection_end: "2025-01-10T21:00:00.000Z",
  charge_start: "2025-01-06T15:00:00.000Z",
  charge_end: "2025-01-10T21:00:00.000Z",
};

Deno.test("isSameAsDeliveryDates returns true when charge matches delivery/collection", () => {
  assertEquals(isSameAsDeliveryDates(baseDates), true);
});

Deno.test("isSameAsDeliveryDates returns false when charge_start differs", () => {
  assertEquals(isSameAsDeliveryDates({ ...baseDates, charge_start: "2025-01-07T09:00:00.000Z" }), false);
});

Deno.test("isSameAsDeliveryDates returns false when charge_end differs", () => {
  assertEquals(isSameAsDeliveryDates({ ...baseDates, charge_end: "2025-01-09T21:00:00.000Z" }), false);
});

// ── isSameAsDeliveryDestination ─────────────────────────────────

const baseEndpoint = {
  uid: "loc1",
  address: { city: "Dallas", country_name: "US", full: "123 Main St", name: "Warehouse", postcode: "75001", region: "TX", street: "123 Main St" },
  instructions: "Use back door",
  contact: { uid: "c1", first_name: "John", name: "John" },
};

// Destination-display helpers (isSameAsDeliveryDestination, getDestinationPairItemName,
// getDestinationsLegend) don't read dates; this satisfies the now-required field.
const NO_DATES: OrderDatesType = {
  delivery_start: null, delivery_end: null,
  collection_start: null, collection_end: null,
  charge_start: null, charge_end: null,
};

Deno.test("isSameAsDeliveryDestination returns true when endpoints match", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { ...baseEndpoint },
    collection: { ...baseEndpoint },
  };
  assertEquals(isSameAsDeliveryDestination(dest), true);
});

Deno.test("isSameAsDeliveryDestination returns false when addresses differ", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { ...baseEndpoint },
    collection: { ...baseEndpoint, address: { ...baseEndpoint.address, city: "Houston" } },
  };
  assertEquals(isSameAsDeliveryDestination(dest), false);
});

Deno.test("isSameAsDeliveryDestination returns false when contacts differ", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { ...baseEndpoint },
    collection: { ...baseEndpoint, contact: { uid: "c2", first_name: "Jane", name: "Jane" } },
  };
  assertEquals(isSameAsDeliveryDestination(dest), false);
});

Deno.test("isSameAsDeliveryDestination returns false when instructions differ", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { ...baseEndpoint },
    collection: { ...baseEndpoint, instructions: "Front door" },
  };
  assertEquals(isSameAsDeliveryDestination(dest), false);
});

Deno.test("isSameAsDeliveryDestination returns true when both null endpoints", () => {
  const dest = { delivery: {}, collection: {} } as unknown as DestinationType;
  assertEquals(isSameAsDeliveryDestination(dest), true);
});

// ── getDestinationPairItemName ──────────────────────────────────

Deno.test("getDestinationPairItemName uses delivery and collection names", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { address: { name: "Warehouse A", street: "1 Main", city: "", country_name: "", full: "", postcode: "", region: "" } },
    collection: { address: { name: "Venue B", street: "2 Oak", city: "", country_name: "", full: "", postcode: "", region: "" } },
  };
  assertEquals(getDestinationPairItemName(dest, 0), "Warehouse A - Venue B");
});

Deno.test("getDestinationPairItemName uses delivery only when same", () => {
  const addr = { name: "Warehouse A", street: "1 Main", city: "", country_name: "", full: "", postcode: "", region: "" };
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { address: addr },
    collection: { address: addr },
  };
  assertEquals(getDestinationPairItemName(dest, 0), "Warehouse A");
});

Deno.test("getDestinationPairItemName falls back to street", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { address: { name: "", street: "1 Main St", city: "", country_name: "", full: "", postcode: "", region: "" } },
    collection: { address: { name: "", street: "2 Oak Ave", city: "", country_name: "", full: "", postcode: "", region: "" } },
  };
  assertEquals(getDestinationPairItemName(dest, 0), "1 Main St - 2 Oak Ave");
});

Deno.test("getDestinationPairItemName falls back to index", () => {
  const dest: DestinationType = { dates: NO_DATES, delivery: {}, collection: {} };
  assertEquals(getDestinationPairItemName(dest, 0), "Destination 1");
  assertEquals(getDestinationPairItemName(dest, 2), "Destination 3");
});

Deno.test("getDestinationPairItemName uses delivery when collection has no address", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: { address: { name: "Warehouse", street: "", city: "", country_name: "", full: "", postcode: "", region: "" } },
    collection: {},
  };
  assertEquals(getDestinationPairItemName(dest, 0), "Warehouse");
});

// ── getDestinationsLegend ───────────────────────────────────────

Deno.test("getDestinationsLegend returns empty strings when no destinations", () => {
  assertEquals(getDestinationsLegend([]), { start: "", end: "" });
  assertEquals(getDestinationsLegend(undefined), { start: "", end: "" });
  assertEquals(getDestinationsLegend(null), { start: "", end: "" });
});

Deno.test("getDestinationsLegend default flags render Delivery / Pickup", () => {
  const dest: DestinationType = { dates: NO_DATES, delivery: {}, collection: {} };
  assertEquals(getDestinationsLegend([dest]), { start: "Delivery", end: "Pickup" });
});

Deno.test("getDestinationsLegend customer-collecting renders Pickup / Pickup", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: true,
    customer_returning: false,
  };
  assertEquals(getDestinationsLegend([dest]), { start: "Pickup", end: "Pickup" });
});

Deno.test("getDestinationsLegend customer-returning renders Delivery / Return", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: false,
    customer_returning: true,
  };
  assertEquals(getDestinationsLegend([dest]), { start: "Delivery", end: "Return" });
});

Deno.test("getDestinationsLegend dedupes identical pairs", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: true,
    customer_returning: true,
  };
  assertEquals(getDestinationsLegend([dest, dest]), { start: "Pickup", end: "Return" });
});

Deno.test("getDestinationsLegend joins mixed pairs with ' / '", () => {
  const a: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: false,
    customer_returning: false,
  };
  const b: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: true,
    customer_returning: true,
  };
  assertEquals(getDestinationsLegend([a, b]), {
    start: "Delivery / Pickup",
    end: "Pickup / Return",
  });
});

// ── getDefaultChargeDays ────────────────────────────────────────

Deno.test("getDefaultChargeDays returns null for missing dates", () => {
  assertEquals(getDefaultChargeDays({} as OrderDatesType, []), null);
  assertEquals(getDefaultChargeDays({ delivery_start: "2025-01-06T09:00:00Z" } as OrderDatesType, []), null);
});

Deno.test("getDefaultChargeDays returns chargeable days", () => {
  const dates: OrderDatesType = {
    delivery_start: "2025-01-06T15:00:00.000Z",
    delivery_end: "2025-01-06T15:00:00.000Z",
    collection_start: "2025-01-10T21:00:00.000Z",
    collection_end: "2025-01-10T21:00:00.000Z",
    charge_start: "2025-01-06T15:00:00.000Z",
    charge_end: "2025-01-10T21:00:00.000Z",
  };
  const result = getDefaultChargeDays(dates, []);
  assertEquals(result, 5);
});

// ── syncChargeDaysToItems ───────────────────────────────────────

Deno.test("syncChargeDaysToItems no-ops when defaults are equal", () => {
  const items = [makeItem({ type: "rental" }, { chargeable_days: 5 })];
  syncChargeDaysToItems(items, 5, 5);
  assertEquals((items[0].price as PriceObject).chargeable_days, 5);
});

Deno.test("syncChargeDaysToItems updates items matching previous default", () => {
  const items = [makeItem({ type: "rental" }, { chargeable_days: 5 })];
  syncChargeDaysToItems(items, 5, 10);
  assertEquals((items[0].price as PriceObject).chargeable_days, 10);
});

Deno.test("syncChargeDaysToItems skips manual overrides", () => {
  const items = [makeItem({ type: "rental" }, { chargeable_days: 7 })];
  syncChargeDaysToItems(items, 5, 10);
  assertEquals((items[0].price as PriceObject).chargeable_days, 7);
});

Deno.test("syncChargeDaysToItems skips structural items", () => {
  const items = [
    makeItem({ type: "destination" }, { chargeable_days: 5 }),
    makeItem({ type: "group" }, { chargeable_days: 5 }),
  ];
  syncChargeDaysToItems(items, 5, 10);
  assertEquals((items[0].price as PriceObject).chargeable_days, 5);
  assertEquals((items[1].price as PriceObject).chargeable_days, 5);
});

Deno.test("syncChargeDaysToItems skips when previousDefault is null", () => {
  const items = [makeItem({ type: "rental" }, { chargeable_days: 5 })];
  syncChargeDaysToItems(items, null, 10);
  assertEquals((items[0].price as PriceObject).chargeable_days, 5);
});

// ── computeItemPaths ────────────────────────────────────────────

Deno.test("computeItemPaths sets dest path to [self uid]", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
  ];
  const result = computeItemPaths(items);
  assertEquals(result[0].path, ["d1"]);
});

Deno.test("computeItemPaths sets group path to [dest, self]", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "g1", name: "G1", path: [] },
  ];
  const result = computeItemPaths(items);
  assertEquals(result[1].path, ["d1", "g1"]);
});

Deno.test("computeItemPaths sets line item path to [dest, self]", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "item-1", path: [] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[1].path, ["d1", "item-1"]);
});

Deno.test("computeItemPaths sets line item under group to [dest, group, self]", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "g1", name: "G1", path: [] },
    makeItem({ uid: "item-1", path: [] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[2].path, ["d1", "g1", "item-1"]);
});

Deno.test("computeItemPaths preserves component ancestry from client path", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "D", path: [] }),
    makeItem({ uid: "A", path: ["D"] }),
    makeItem({ uid: "B", path: ["D", "A"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[1].path, ["d1", "D"]);
  assertEquals(result[2].path, ["d1", "D", "A"]);
  assertEquals(result[3].path, ["d1", "D", "A", "B"]);
});

Deno.test("computeItemPaths handles shared component at different paths", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "D", path: [] }),
    makeItem({ uid: "A", path: ["D"] }),
    makeItem({ uid: "B", path: ["D", "A"] }),
    makeItem({ uid: "C", path: ["D"] }),
    makeItem({ uid: "B", path: ["D", "C"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[3].path, ["d1", "D", "A", "B"]);
  assertEquals(result[5].path, ["d1", "D", "C", "B"]);
});

Deno.test("computeItemPaths resets group context at new destination", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "g1", name: "G1", path: [] },
    makeItem({ uid: "p1", path: [] }),
    { type: "destination", uid: "d2", name: "", path: [] },
    makeItem({ uid: "p2", path: [] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[2].path, ["d1", "g1", "p1"]);
  assertEquals(result[4].path, ["d2", "p2"]);
});

Deno.test("computeItemPaths strips duplicate structural/self uids from client path", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "item-1", path: ["d1", "item-1"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[1].path, ["d1", "item-1"]);
});

Deno.test("computeItemPaths produces unique keys for sibling items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "item-A", path: [] }),
    makeItem({ uid: "item-B", path: [] }),
  ];
  const result = computeItemPaths(items);
  const keyA = result[1].path.join("/");
  const keyB = result[2].path.join("/");
  assertEquals(keyA !== keyB, true);
  assertEquals(keyA, "d1/item-A");
  assertEquals(keyB, "d1/item-B");
});

Deno.test("computeItemPaths does not mutate input items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "item-1", path: [] }),
  ];
  const original = items[1];
  const result = computeItemPaths(items);
  assertEquals(original.path, []);
  assertEquals(result[1].path, ["d1", "item-1"]);
  // Each returned item is a fresh reference
  assertEquals(result[1] === original, false);
});

Deno.test("computeItemPaths strips stale structural uids carried over from prior drag positions", () => {
  // Simulates an item that has been dragged across destinations/groups —
  // its path field carries leaked structural uids from previous positions.
  // Recompute should clean them out, leaving only the current structural
  // prefix + component ancestry + self.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "tents", name: "Tents", path: ["d1", "tents"] },
    // Black tent's path leaked an old "hi" group uid (group still exists in
    // a different destination) and an old "d2" destination uid.
    makeItem({ uid: "blackTent", path: ["d1", "tents", "hi", "d2", "blackTent"] }),
    // White tent leaked just "d2".
    makeItem({ uid: "whiteTent", path: ["d1", "tents", "d2", "whiteTent"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
    { type: "group", uid: "hi", name: "Hi", path: ["d2", "hi"] },
  ];
  const result = computeItemPaths(items);
  // Both tents should have clean paths regardless of where they used to live
  assertEquals(result[2].path, ["d1", "tents", "blackTent"]);
  assertEquals(result[3].path, ["d1", "tents", "whiteTent"]);
});

Deno.test("computeItemPaths preserves component ancestry through stale-uid filter", () => {
  // Component ancestry uids (top-level product uid + nested component uids)
  // must NOT be stripped — they're not structural.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "parentProduct", path: ["d1", "parentProduct"] }),
    makeItem({ uid: "child", path: ["d1", "parentProduct", "child"] }),
    makeItem({ uid: "grandchild", path: ["d1", "parentProduct", "child", "grandchild"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[1].path, ["d1", "parentProduct"]);
  assertEquals(result[2].path, ["d1", "parentProduct", "child"]);
  assertEquals(result[3].path, ["d1", "parentProduct", "child", "grandchild"]);
});

Deno.test("computeItemPaths is idempotent — running twice equals running once", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "stale", "p1"] }),
    makeItem({ uid: "c1", path: ["d1", "g1", "p1", "c1"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
    makeItem({ uid: "stale", path: ["d2", "stale"] }),
  ];
  const once = computeItemPaths(items);
  const twice = computeItemPaths(once);
  for (let i = 0; i < items.length; i++) {
    assertEquals(twice[i].path, once[i].path);
  }
});

// ── validateItemPaths ───────────────────────────────────────────

Deno.test("validateItemPaths returns [] for a clean items array", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "c1", path: ["d1", "g1", "p1", "c1"] }),
  ];
  assertEquals(validateItemPaths(items), []);
});

Deno.test("validateItemPaths returns [] for items just produced by computeItemPaths", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "item-1", path: [] }),
    makeItem({ uid: "child", path: ["item-1"] }),
  ];
  const recomputed = computeItemPaths(items);
  assertEquals(validateItemPaths(recomputed), []);
});

Deno.test("validateItemPaths flags every item with a stale structural uid", () => {
  // Mirror of the "strips stale structural uids" computeItemPaths test, inverted:
  // input is unfixed, validate should report each leaked path.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "tents", name: "Tents", path: ["d1", "tents"] },
    makeItem({ uid: "blackTent", path: ["d1", "tents", "hi", "d2", "blackTent"] }),
    makeItem({ uid: "whiteTent", path: ["d1", "tents", "d2", "whiteTent"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
    { type: "group", uid: "hi", name: "Hi", path: ["d2", "hi"] },
  ];
  const issues = validateItemPaths(items);
  assertEquals(issues.length, 2);
  assertEquals(issues[0], {
    index: 2,
    uid: "blackTent",
    path: ["d1", "tents", "hi", "d2", "blackTent"],
    expected: ["d1", "tents", "blackTent"],
  });
  assertEquals(issues[1], {
    index: 3,
    uid: "whiteTent",
    path: ["d1", "tents", "d2", "whiteTent"],
    expected: ["d1", "tents", "whiteTent"],
  });
});

Deno.test("validateItemPaths flags a missing structural prefix", () => {
  // Line item written without its destination ancestor in the path.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "p1", path: ["p1"] }),
  ];
  const issues = validateItemPaths(items);
  assertEquals(issues, [
    { index: 1, uid: "p1", path: ["p1"], expected: ["d1", "p1"] },
  ]);
});

Deno.test("validateItemPaths does not mutate input items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "p1", path: ["d1", "stale", "p1"] }),
  ];
  const before = items[1].path.slice();
  validateItemPaths(items);
  assertEquals(items[1].path, before);
});

// ── computeItemPaths: depth-first linearization ────────────────

Deno.test("computeItemPaths linearizes breadth-first input depth-first", () => {
  // Breadth-first input: parent, all direct children, then all grandchildren.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "g1", name: "G1", path: [] },
    makeItem({ uid: "P", path: [] }),
    makeItem({ uid: "A", path: ["P"] }),
    makeItem({ uid: "B", path: ["P"] }),
    makeItem({ uid: "A1", path: ["P", "A"] }),
    makeItem({ uid: "A2", path: ["P", "A"] }),
    makeItem({ uid: "B1", path: ["P", "B"] }),
  ];
  const result = computeItemPaths(items);
  // Expected depth-first order: P, A, A1, A2, B, B1
  assertEquals(result.map((i) => i.uid), ["d1", "g1", "P", "A", "A1", "A2", "B", "B1"]);
  assertEquals(result[2].path, ["d1", "g1", "P"]);
  assertEquals(result[3].path, ["d1", "g1", "P", "A"]);
  assertEquals(result[4].path, ["d1", "g1", "P", "A", "A1"]);
  assertEquals(result[5].path, ["d1", "g1", "P", "A", "A2"]);
  assertEquals(result[6].path, ["d1", "g1", "P", "B"]);
  assertEquals(result[7].path, ["d1", "g1", "P", "B", "B1"]);
});

Deno.test("computeItemPaths sorts zero-priced before priced within each parent", () => {
  // Two top-level products under a group, mix of zero-priced and priced.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "g1", name: "G1", path: [] },
    makeItem({ uid: "P", path: [] }),
    makeItem({ uid: "C-priced", path: ["P"], zero_priced: false }),
    makeItem({ uid: "C-zero1", path: ["P"], zero_priced: true }),
    makeItem({ uid: "C-priced2", path: ["P"], zero_priced: false }),
    makeItem({ uid: "C-zero2", path: ["P"], zero_priced: true }),
  ];
  const result = computeItemPaths(items);
  // Zero-priced first (in input order among themselves), then priced (in input order).
  assertEquals(result.map((i) => i.uid), [
    "d1", "g1", "P", "C-zero1", "C-zero2", "C-priced", "C-priced2",
  ]);
});

Deno.test("computeItemPaths preserves intra-band order on reorder", () => {
  // Two priced components A, B reordered by drag-drop should stay in that order.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "P", path: [] }),
    makeItem({ uid: "B", path: ["P"], zero_priced: false }),
    makeItem({ uid: "A", path: ["P"], zero_priced: false }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result.map((i) => i.uid), ["d1", "P", "B", "A"]);
});

Deno.test("computeItemPaths strips orphan ancestor uids", () => {
  // Item path includes an intermediate uid that doesn't resolve to any item
  // in the array (e.g. catalog-only intermediate kit uid). Strip it.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "P", path: [] }),
    // urf is not in the array — should be stripped.
    makeItem({ uid: "leaf", path: ["P", "urf", "leaf"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[2].path, ["d1", "P", "leaf"]);
});

Deno.test("computeItemPaths reorders independent parent subtrees by zero-priced flag", () => {
  // Two top-level products inside a group, one zero-priced.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "g1", name: "G1", path: [] },
    makeItem({ uid: "Priced", path: [], zero_priced: false }),
    makeItem({ uid: "PricedChild", path: ["Priced"], zero_priced: false }),
    makeItem({ uid: "Zero", path: [], zero_priced: true }),
  ];
  const result = computeItemPaths(items);
  // Zero comes before Priced; Priced's subtree stays attached.
  assertEquals(result.map((i) => i.uid), ["d1", "g1", "Zero", "Priced", "PricedChild"]);
});

Deno.test("computeItemPaths reorders only line items, not divider rows", () => {
  // Destinations and groups must stay in source position.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    { type: "group", uid: "gA", name: "A", path: [] },
    makeItem({ uid: "p1", path: [] }),
    { type: "group", uid: "gB", name: "B", path: [] },
    makeItem({ uid: "p2", path: [] }),
    { type: "destination", uid: "d2", name: "", path: [] },
    makeItem({ uid: "p3", path: [] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result.map((i) => i.uid), ["d1", "gA", "p1", "gB", "p2", "d2", "p3"]);
});

Deno.test("computeItemPaths is robust to duplicate parent uids", () => {
  // Pre-migration state: two same-uid parents in the same block. Each item
  // must appear in output exactly once; second parent emits as a leaf with
  // children attached to the first parent's subtree.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "P", path: [] }), // first
    makeItem({ uid: "C1", path: ["P"] }),
    makeItem({ uid: "P", path: [] }), // duplicate
    makeItem({ uid: "C2", path: ["P"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result.length, items.length); // every item appears once
  const uids = result.map((i) => i.uid);
  assertEquals(uids.filter((u) => u === "P").length, 2);
  assertEquals(uids.filter((u) => u === "C1").length, 1);
  assertEquals(uids.filter((u) => u === "C2").length, 1);
});

// ── validateItemUniqueness ─────────────────────────────────────

Deno.test("validateItemUniqueness returns [] for unique items", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "g1", "p2"] }),
    makeItem({ uid: "c1", path: ["d1", "g1", "p1", "c1"] }),
  ];
  assertEquals(validateItemUniqueness(items), []);
});

Deno.test("validateItemUniqueness flags duplicate products in same group", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "P", path: ["d1", "g1", "P"] }),
    makeItem({ uid: "P", path: ["d1", "g1", "P"] }),
  ];
  const issues = validateItemUniqueness(items);
  assertEquals(issues, [
    { index: 3, uid: "P", parentUid: "g1", firstIndex: 2 },
  ]);
});

Deno.test("validateItemUniqueness allows same product in different groups", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "gA", name: "A", path: ["d1", "gA"] },
    makeItem({ uid: "P", path: ["d1", "gA", "P"] }),
    { type: "group", uid: "gB", name: "B", path: ["d1", "gB"] },
    makeItem({ uid: "P", path: ["d1", "gB", "P"] }),
  ];
  assertEquals(validateItemUniqueness(items), []);
});

Deno.test("validateItemUniqueness allows same component on two different parents", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "PA", path: ["d1", "PA"] }),
    makeItem({ uid: "shared", path: ["d1", "PA", "shared"] }),
    makeItem({ uid: "PB", path: ["d1", "PB"] }),
    makeItem({ uid: "shared", path: ["d1", "PB", "shared"] }),
  ];
  assertEquals(validateItemUniqueness(items), []);
});

Deno.test("validateItemUniqueness flags duplicate component under same parent", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "P", path: ["d1", "P"] }),
    makeItem({ uid: "C", path: ["d1", "P", "C"] }),
    makeItem({ uid: "C", path: ["d1", "P", "C"] }),
  ];
  const issues = validateItemUniqueness(items);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].uid, "C");
  assertEquals(issues[0].parentUid, "P");
  assertEquals(issues[0].index, 3);
  assertEquals(issues[0].firstIndex, 2);
});

// ── getStructuralUids ───────────────────────────────────────────

Deno.test("getStructuralUids returns dest and group uids only", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
  ];
  const uids = getStructuralUids(items);
  assertEquals(uids.has("d1"), true);
  assertEquals(uids.has("g1"), true);
  assertEquals(uids.has("p1"), false);
});

// ── getParentProductUid ─────────────────────────────────────────

Deno.test("getParentProductUid returns null for top-level item under dest", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "p1", path: ["d1", "p1"] }),
  ];
  const structuralUids = getStructuralUids(items);
  assertEquals(getParentProductUid(items[1], structuralUids), null);
});

Deno.test("getParentProductUid returns parent uid for component", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "parent", path: ["d1", "parent"] }),
    makeItem({ uid: "child", path: ["d1", "parent", "child"] }),
  ];
  const structuralUids = getStructuralUids(items);
  assertEquals(getParentProductUid(items[2], structuralUids), "parent");
});

Deno.test("getParentProductUid returns null when path.at(-2) is group", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
  ];
  const structuralUids = getStructuralUids(items);
  assertEquals(getParentProductUid(items[2], structuralUids), null);
});

// ── getRemovalIndices ───────────────────────────────────────────

Deno.test("getRemovalIndices removes destination and all children", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "p1", path: ["d1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "p2"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
  ];
  assertEquals(getRemovalIndices(items, 0), [0, 1, 2]);
});

Deno.test("getRemovalIndices removes group and children until next group", () => {
  const items: LineItem[] = [
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    { type: "group", uid: "g2", name: "G2", path: ["d1", "g2"] },
    makeItem({ uid: "p2", path: ["d1", "g2", "p2"] }),
  ];
  assertEquals(getRemovalIndices(items, 0), [0, 1]);
});

Deno.test("getRemovalIndices removes product and all descendants", () => {
  const items: LineItem[] = [
    makeItem({ uid: "parent", path: ["d1", "parent"] }),
    makeItem({ uid: "child", path: ["d1", "parent", "child"] }),
    makeItem({ uid: "grandchild", path: ["d1", "parent", "child", "grandchild"] }),
    makeItem({ uid: "other", path: ["d1", "other"] }),
  ];
  assertEquals(getRemovalIndices(items, 0), [0, 1, 2]);
});

// ── getItemSubtreeRange ─────────────────────────────────────────

Deno.test("getItemSubtreeRange covers a destination through its last child", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "p2"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
    makeItem({ uid: "p3", path: ["d2", "p3"] }),
  ];
  assertEquals(getItemSubtreeRange(items, 0), { startIndex: 0, endIndex: 3 });
});

Deno.test("getItemSubtreeRange covers a group up to the next group/destination", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    { type: "group", uid: "g1", name: "G1", path: ["d1", "g1"] },
    makeItem({ uid: "p1", path: ["d1", "g1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "g1", "p2"] }),
    { type: "group", uid: "g2", name: "G2", path: ["d1", "g2"] },
    makeItem({ uid: "p3", path: ["d1", "g2", "p3"] }),
  ];
  assertEquals(getItemSubtreeRange(items, 1), { startIndex: 1, endIndex: 3 });
});

Deno.test("getItemSubtreeRange covers a top-level product and its components", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "P1", path: ["d1", "P1"] }),
    makeItem({ uid: "C1", path: ["d1", "P1", "C1"] }),
    makeItem({ uid: "C2", path: ["d1", "P1", "C2"] }),
    makeItem({ uid: "P2", path: ["d1", "P2"] }),
  ];
  assertEquals(getItemSubtreeRange(items, 1), { startIndex: 1, endIndex: 3 });
});

Deno.test("getItemSubtreeRange covers a nested component subtree", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "P", path: ["d1", "P"] }),
    makeItem({ uid: "C", path: ["d1", "P", "C"] }),
    makeItem({ uid: "GC", path: ["d1", "P", "C", "GC"] }),
    makeItem({ uid: "Other", path: ["d1", "P", "Other"] }),
  ];
  assertEquals(getItemSubtreeRange(items, 2), { startIndex: 2, endIndex: 3 });
});

Deno.test("getItemSubtreeRange returns single-index range when item has no descendants", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "p1", path: ["d1", "p1"] }),
    makeItem({ uid: "p2", path: ["d1", "p2"] }),
  ];
  assertEquals(getItemSubtreeRange(items, 1), { startIndex: 1, endIndex: 1 });
});

Deno.test("getItemSubtreeRange runs to end of array when nothing follows", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "P", path: ["d1", "P"] }),
    makeItem({ uid: "C", path: ["d1", "P", "C"] }),
  ];
  assertEquals(getItemSubtreeRange(items, 0), { startIndex: 0, endIndex: 2 });
  assertEquals(getItemSubtreeRange(items, 1), { startIndex: 1, endIndex: 2 });
});

Deno.test("getItemSubtreeRange handles invoice-style paths prefixed with order uid", () => {
  // Invoice items carry an extra leading scope segment (the order divider uid).
  // Path-prefix matching works identically — the helper is generic over any
  // { path: string[] } shape.
  type InvoiceLike = { path: string[]; uid: string };
  const items: InvoiceLike[] = [
    { uid: "o1", path: ["o1"] },
    { uid: "d1", path: ["o1", "d1"] },
    { uid: "p1", path: ["o1", "d1", "p1"] },
    { uid: "c1", path: ["o1", "d1", "p1", "c1"] },
    { uid: "p2", path: ["o1", "d1", "p2"] },
    { uid: "o2", path: ["o2"] },
    { uid: "d2", path: ["o2", "d2"] },
  ];
  // Order divider covers everything until the next order
  assertEquals(getItemSubtreeRange(items, 0), { startIndex: 0, endIndex: 4 });
  // Destination within the order
  assertEquals(getItemSubtreeRange(items, 1), { startIndex: 1, endIndex: 4 });
  // Top-level product within the destination, includes its component
  assertEquals(getItemSubtreeRange(items, 2), { startIndex: 2, endIndex: 3 });
});

// ── deriveOrderDateEnvelope / buildQueryByDates ──────────────────

function fsTs(seconds: number): FirestoreTimestampType {
  return { seconds, nanoseconds: 0 } as FirestoreTimestampType;
}

function docDates(over: Partial<OrderDocDatesType> = {}): OrderDocDatesType {
  return {
    delivery_start: null, delivery_start_fs: fsTs(0),
    delivery_end: null, delivery_end_fs: fsTs(0),
    collection_start: null, collection_start_fs: fsTs(0),
    collection_end: null, collection_end_fs: fsTs(0),
    charge_start: null, charge_start_fs: fsTs(0),
    charge_end: null, charge_end_fs: fsTs(0),
    days_active: null, days_charged: null,
    ...over,
  };
}

Deno.test("deriveOrderDateEnvelope: single destination returns its own dates", () => {
  const dates = docDates({
    delivery_start: "2026-03-01T09:00:00.000-06:00", delivery_start_fs: fsTs(101),
    delivery_end: "2026-03-01T17:00:00.000-06:00", delivery_end_fs: fsTs(102),
    collection_start: "2026-03-10T09:00:00.000-06:00", collection_start_fs: fsTs(103),
    collection_end: "2026-03-10T17:00:00.000-06:00", collection_end_fs: fsTs(104),
    charge_start: "2026-03-01T09:00:00.000-06:00", charge_start_fs: fsTs(105),
    charge_end: "2026-03-10T17:00:00.000-06:00", charge_end_fs: fsTs(106),
    days_active: 8, days_charged: 6,
  });
  const env = deriveOrderDateEnvelope([{ dates }]);
  assertEquals(env.delivery_start, "2026-03-01T09:00:00.000-06:00");
  assertEquals(env.delivery_start_fs, fsTs(101));
  assertEquals(env.collection_end, "2026-03-10T17:00:00.000-06:00");
  assertEquals(env.collection_end_fs, fsTs(104));
  assertEquals(env.days_active, 8);
  assertEquals(env.days_charged, 6);
});

Deno.test("deriveOrderDateEnvelope: starts take min, ends take max across destinations", () => {
  const a = docDates({
    delivery_start: "2026-03-05T09:00:00.000-06:00", delivery_start_fs: fsTs(1),
    collection_end: "2026-03-12T17:00:00.000-06:00", collection_end_fs: fsTs(2),
    days_active: 5, days_charged: 5,
  });
  const b = docDates({
    delivery_start: "2026-03-02T09:00:00.000-06:00", delivery_start_fs: fsTs(3),
    collection_end: "2026-03-20T17:00:00.000-06:00", collection_end_fs: fsTs(4),
    days_active: 9, days_charged: 7,
  });
  const env = deriveOrderDateEnvelope([{ dates: a }, { dates: b }]);
  // earliest delivery_start (b) carries its own _fs companion
  assertEquals(env.delivery_start, "2026-03-02T09:00:00.000-06:00");
  assertEquals(env.delivery_start_fs, fsTs(3));
  // latest collection_end (b)
  assertEquals(env.collection_end, "2026-03-20T17:00:00.000-06:00");
  assertEquals(env.collection_end_fs, fsTs(4));
  // days take the largest non-null value
  assertEquals(env.days_active, 9);
  assertEquals(env.days_charged, 7);
});

Deno.test("deriveOrderDateEnvelope: compares instants across the DST boundary", () => {
  // CST (-06:00) vs CDT (-05:00) — the earlier instant must win regardless of offset.
  const winter = docDates({ delivery_start: "2026-03-01T23:00:00.000-06:00", delivery_start_fs: fsTs(1) });
  const summer = docDates({ delivery_start: "2026-03-09T00:00:00.000-05:00", delivery_start_fs: fsTs(2) });
  const env = deriveOrderDateEnvelope([{ dates: summer }, { dates: winter }]);
  assertEquals(env.delivery_start, "2026-03-01T23:00:00.000-06:00");
  assertEquals(env.delivery_start_fs, fsTs(1));
});

Deno.test("deriveOrderDateEnvelope: all-null and empty inputs yield a null envelope", () => {
  const allNull = deriveOrderDateEnvelope([{ dates: docDates() }, { dates: docDates() }]);
  assertEquals(allNull.delivery_start, null);
  assertEquals(allNull.delivery_start_fs, null);
  assertEquals(allNull.collection_end, null);
  assertEquals(allNull.days_active, null);

  const empty = deriveOrderDateEnvelope([]);
  assertEquals(empty.delivery_start, null);
  assertEquals(empty.days_charged, null);
});

Deno.test("buildQueryByDates: dedupes and sorts Chicago boundary days", () => {
  const a = docDates({
    delivery_start: "2026-03-01T09:00:00.000-06:00",
    delivery_end: "2026-03-01T17:00:00.000-06:00",
    collection_start: "2026-03-10T09:00:00.000-06:00",
    collection_end: "2026-03-10T17:00:00.000-06:00",
  });
  const b = docDates({
    delivery_start: "2026-03-05T09:00:00.000-06:00",
    delivery_end: "2026-03-05T17:00:00.000-06:00",
    collection_start: "2026-03-10T09:00:00.000-06:00",
    collection_end: "2026-03-10T17:00:00.000-06:00",
  });
  assertEquals(buildQueryByDates([{ dates: a }, { dates: b }]), ["2026-03-01", "2026-03-05", "2026-03-10"]);
});

Deno.test("buildQueryByDates: skips null boundaries, returns [] when empty", () => {
  assertEquals(buildQueryByDates([{ dates: docDates() }]), []);
  assertEquals(buildQueryByDates([]), []);
});

Deno.test("buildQueryByDates: keys on the Chicago calendar day across the UTC midnight boundary", () => {
  // 03:00Z on Mar 2 is still Mar 1 in Chicago (-06:00).
  const d = docDates({ delivery_start: "2026-03-02T03:00:00.000Z" });
  assertEquals(buildQueryByDates([{ dates: d }]), ["2026-03-01"]);
});
