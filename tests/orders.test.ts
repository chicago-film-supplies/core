import { assertEquals, assertThrows } from "@std/assert";
// Real currency.js, not a model of it — the fail-closed companions measure the
// forms the docstrings quote rather than reconstructing them.
import currency from "currency.js";
import {
  DOC_LINE_ITEM_TYPES,
  FULFILLMENT_LINE_ITEM_TYPES,
  getInitialValues,
  isDividerItemType,
  isFulfillableItemType,
  isLineItemType,
  ITEM_CONTRACTS,
  type ItemTypeType,
  type PreTaxItemType,
  type FromTotalItemType,
  OrderDocLineItem,
} from "../src/schemas/mod.ts";
import {
  calculateItemDiscount,
  calculateItemPrice,
  calculateItemSubtotal,
  calculateItemTax,
  computeItemTaxAmount,
  isTaxableCoa,
  TAXABLE_REVENUE_COAS,
  calculateItemTotal,
  calculateTransactionFeeAmount,
  calculateOrderTotals,
  calculateReplacementTotals,
  buildPackingList,
  buildQueryByDates,
  deriveOrderDateEnvelope,
  computeItemPaths,
  consolidateItems,
  validateItemPaths,
  validateItemParentage,
  validateItemUniqueness,
  validateComponentUniqueness,
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
  type PricingItem,
  type PriceObject,
  type Tax,
  orderHasDiscount,
  orderHasRentals,
  orderHasTax,
} from "../src/utils/orders.ts";
import type { OrderDatesType, DestinationType, OrderDocDatesType, FirestoreTimestampType } from "../src/schemas/mod.ts";

const lineItemBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
const priceBase = lineItemBase.price as Record<string, unknown>;
// A fee is an ORDINARY line item — same base, same price shape. It differs only
// in `type` and in `price.formula`, which is the whole point of the collapse.
const feeItemBase = { ...lineItemBase, type: "transaction_fee" } as Record<string, unknown>;

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
    uid: "cc-fee-product",
    ...feeItemBase,
    name: "Credit Card Processing Fee",
    quantity: 1,
    ...overrides,
    price: {
      ...priceBase,
      formula: "percent_of_total",
      base: 3,
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

// ── The sweep the three CLAUDE.md files claim ────────────────────
//
// All three assert `calculateItemSubtotal` is "verified against an exact BigInt
// rational reference over 300k random inputs, 0 disagreements". Until now that
// was a COMMENT plus the distilled examples above — the sweep did not exist, so
// the claim was the very defect class this codebase keeps finding: a stated
// guarantee that nothing executes. Pattern copied from `movements.test.ts`
// (`exactCostOfUnits` + inline LCG + `assertEquals(disagreements, 0)`).
//
// **A BigInt-vs-BigInt oracle would be close to tautological**, and saying so
// matters more than the green tick: the shipped code is already exact integer
// arithmetic, so an oracle that mirrors its decomposition can only ever agree
// with it. Two things give this sweep real discriminating power:
//
//   1. the oracle builds ONE reduced fraction and rounds once, rather than
//      staging numerator and denominator the way the implementation does; and
//   2. the FLOAT form it replaced is swept alongside it, and the test below
//      asserts that form disagrees. A guard never seen to fail is not known to
//      be a guard — the same discipline that made the `"voided"` filter test
//      trustworthy.

/** Exact half-up division of a reduced fraction. Non-negative numerator only. */
function exactRound(num: bigint, den: bigint): bigint {
  const g = gcd(num < 0n ? -num : num, den);
  const n = num / g;
  const d = den / g;
  return n < 0n ? -((-2n * n + d) / (2n * d)) : (2n * n + d) / (2n * d);
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

interface SweepLine {
  base: number;
  quantity: number;
  chargeableDays: number;
  formula: "five_day_week" | "fixed";
  discount: { type: "percent" | "flat"; rate: number } | null;
}

/**
 * The true mathematical value of a line, in cents, as one exact rational.
 *
 * `subtotal = base × quantity × max(days/5, 1)` (the floor bites only above 5
 * chargeable days, and `fixed` never engages it), then the discount:
 * `percent` scales the subtotal by `(100 − rate)/100`; `flat` is dollars per
 * unit **per pricing factor**, so it carries the same quantity and day factor
 * as the price it discounts.
 */
function exactLineCents(line: SweepLine): { subtotal: bigint; discounted: bigint } {
  const baseCents = BigInt(Math.round(line.base * 100));
  const qty = BigInt(Math.round(line.quantity * 10_000));
  const useDays = line.formula === "five_day_week" && line.chargeableDays > 5;
  const factorNum = useDays ? BigInt(line.chargeableDays) : 1n;
  const factorDen = useDays ? 5n : 1n;

  const subtotal = exactRound(baseCents * qty * factorNum, 10_000n * factorDen);
  if (!line.discount) return { subtotal, discounted: subtotal };

  if (line.discount.type === "percent") {
    const rate = BigInt(Math.round(line.discount.rate * 1_000_000));
    return { subtotal, discounted: exactRound(subtotal * (100_000_000n - rate), 100_000_000n) };
  }
  const rateCents = BigInt(Math.round(line.discount.rate * 100));
  const off = exactRound(rateCents * qty * factorNum, 10_000n * factorDen);
  return { subtotal, discounted: subtotal - off };
}

/**
 * A DIVIDE-FIRST implementation — the failure mode the money doctrine names:
 * *"never `currency(a).divide(b)` to get a ratio: it quantizes the ratio, so
 * scaling to a percent leaves only `precision − 2` decimals."*
 *
 * `Discount.rate` carries 4 decimals (Xero's `DiscountRate` does, so CFS
 * stores 4), which makes `(100 − rate)/100` a **6**-decimal ratio. Quantizing
 * it at currency.js's default precision truncates the two digits that decide
 * the half-cent, exactly as the doctrine says.
 *
 * This deliberately models the DOCUMENTED failure rather than reconstructing
 * the exact predecessor. The first attempt here did try to model "the float
 * form", using plain float with a single final round — and it agreed with the
 * oracle on all 300k lines, so it proved nothing. That near-miss is itself
 * consistent with the note above these tests: the *subtotal* path tolerated
 * float and never flipped a tie; it was the *discount* path that mis-rounded.
 */
function divideFirstLine(line: SweepLine, precision = 4): { subtotal: number; discounted: number } {
  const q = 10 ** precision;
  const useDays = line.formula === "five_day_week" && line.chargeableDays > 5;
  const factor = useDays ? line.chargeableDays / 5 : 1;
  const subtotal = Math.round(line.base * line.quantity * factor * 100) / 100;
  if (!line.discount) return { subtotal, discounted: subtotal };
  if (line.discount.type === "percent") {
    const ratio = Math.round(((100 - line.discount.rate) / 100) * q) / q; // ← the quantized ratio
    return { subtotal, discounted: Math.round(subtotal * ratio * 100) / 100 };
  }
  const off = Math.round(line.discount.rate * line.quantity * factor * 100) / 100;
  return { subtotal, discounted: Math.round((subtotal - off) * 100) / 100 };
}

/** Seeded LCG — same generator as `movements.test.ts`, so runs are reproducible. */
function sweepLines(count: number): SweepLine[] {
  let seed = 987_654_321;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const lines: SweepLine[] = [];
  for (let i = 0; i < count; i++) {
    // `chargeable_days` deliberately straddles the one-week floor at 5, so both
    // the factor-1 and the factor-engaged branches are exercised; quantities are
    // fractional because invoice items are not `z.int()` — QTY_SCALE exists for
    // exactly that, and an integer-only sweep would never reach it.
    const withDiscount = rand(4) !== 0;
    lines.push({
      base: rand(500_000) / 100,
      quantity: rand(200_000) / 10_000,
      chargeableDays: rand(40),
      formula: rand(2) === 0 ? "five_day_week" : "fixed",
      discount: !withDiscount ? null : rand(2) === 0
        ? { type: "percent", rate: rand(1_000_000) / 10_000 }
        : { type: "flat", rate: rand(20_000) / 100 },
    });
  }
  return lines;
}

const SWEEP = sweepLines(300_000);

const lineToItem = (line: SweepLine) =>
  makeItem({ quantity: line.quantity }, {
    base: line.base,
    chargeable_days: line.chargeableDays,
    formula: line.formula,
    ...(line.discount ? { discount: { ...line.discount, amount: 0 } } : {}),
  });

Deno.test("calculateItemSubtotal matches exact rational arithmetic over 300k random lines", () => {
  let disagreements = 0;
  let first: string | null = null;
  for (const line of SWEEP) {
    const got = calculateItemSubtotal(lineToItem(line));
    const want = exactLineCents(line);
    if (
      BigInt(Math.round(got.subtotal * 100)) !== want.subtotal ||
      BigInt(Math.round(got.subtotal_discounted * 100)) !== want.discounted
    ) {
      disagreements++;
      first ??= `${JSON.stringify(line)} → got ${JSON.stringify(got)}, want ` +
        `${want.subtotal}/${want.discounted} cents`;
    }
  }
  assertEquals(disagreements, 0, first ?? "");
});

Deno.test("…and a divide-first implementation DOES disagree — the sweep can fail", () => {
  // Fail-closed companion, and the reason to trust the test above. Without it, a
  // sweep whose oracle had drifted into a restatement of the implementation
  // would pass forever and prove nothing — the `SETTLED_INVOICE_STATUSES`
  // lesson, one level up: a guard never seen to fail is not known to be a guard.
  let disagreements = 0;
  for (const line of SWEEP) {
    const want = exactLineCents(line);
    const bad = divideFirstLine(line);
    if (
      BigInt(Math.round(bad.subtotal * 100)) !== want.subtotal ||
      BigInt(Math.round(bad.discounted * 100)) !== want.discounted
    ) disagreements++;
  }
  assertEquals(
    disagreements > 0,
    true,
    "the divide-first form agreed on all 300k lines — the oracle has stopped discriminating",
  );
  console.log(
    `  divide-first mis-rounds ${disagreements} of ${SWEEP.length} lines ` +
      `(1 in ${Math.round(SWEEP.length / disagreements)})`,
  );
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

Deno.test("calculateItemTotal for transaction fee item reports the stored total", () => {
  // A fee is priced from the DOCUMENT, so the only correct value here is the one
  // the totals pass already wrote — there is no basis to recompute from.
  const fee = makeFeeItem({}, { total: 42.50 });
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
    makeFeeItem({}, { total: 10 }),
    makeFeeItem({}, { total: 5 }),
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
    makeFeeItem({}, { base: 3, formula: "percent_of_total" }),
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
    makeFeeItem({}, { base: 3, formula: "percent_of_total" }),
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
    makeFeeItem({ quantity: 2 }, { base: 5, formula: "fixed" }),
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

Deno.test("getDestinationsLegend customer-collecting renders In Store Pickup / Pickup", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: true,
    customer_returning: false,
  };
  assertEquals(getDestinationsLegend([dest]), { start: "In Store Pickup", end: "Pickup" });
});

Deno.test("getDestinationsLegend customer-returning renders Delivery / In Store Return", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: false,
    customer_returning: true,
  };
  assertEquals(getDestinationsLegend([dest]), { start: "Delivery", end: "In Store Return" });
});

Deno.test("getDestinationsLegend dedupes identical pairs", () => {
  const dest: DestinationType = {
    dates: NO_DATES,
    delivery: {},
    collection: {},
    customer_collecting: true,
    customer_returning: true,
  };
  assertEquals(getDestinationsLegend([dest, dest]), { start: "In Store Pickup", end: "In Store Return" });
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
    start: "Delivery / In Store Pickup",
    end: "Pickup / In Store Return",
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

// ── computeItemPaths: one author for `path` (D3) ────────────────

Deno.test("computeItemPaths drops a parent that lives in a different block", () => {
  // D3: the client names a parent that exists in the array but sits in another
  // structural block. The path used to keep the segment (it resolved globally)
  // while the linearizer emitted the item at block top level (it resolves
  // per-block) — a disagreement that re-running reproduced, so the fixed-point
  // guard called it clean. 26 prod order items sat in that hole.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "parentInD1", path: [] }),
    { type: "destination", uid: "d2", name: "", path: [] },
    makeItem({ uid: "orphan", path: ["parentInD1"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[3].path, ["d2", "orphan"]);
  // Position and path now say the same thing: a block root under d2.
  assertEquals(result.map((i) => i.uid), ["d1", "parentInD1", "d2", "orphan"]);
  assertEquals(validateItemPaths(result), []);
});

Deno.test("validateItemPaths flags a cross-block parent instead of accepting it", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: ["d1"] },
    makeItem({ uid: "parentInD1", path: ["d1", "parentInD1"] }),
    { type: "destination", uid: "d2", name: "", path: ["d2"] },
    makeItem({ uid: "orphan", path: ["d2", "parentInD1", "orphan"] }),
  ];
  assertEquals(validateItemPaths(items), [
    {
      index: 3,
      uid: "orphan",
      path: ["d2", "parentInD1", "orphan"],
      expected: ["d2", "orphan"],
    },
  ]);
});

Deno.test("computeItemPaths derives ancestry from the parent, not the client chain", () => {
  // The client names only the immediate parent and skips the grandparent. The
  // old filter kept the chain verbatim, producing a path whose prefix did not
  // match the parent's — which breaks `getItemSubtreeRange`'s prefix matching
  // even though `path.at(-2)` looked right.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "grandparent", path: [] }),
    makeItem({ uid: "parent", path: ["grandparent"] }),
    makeItem({ uid: "child", path: ["parent"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result[3].path, ["d1", "grandparent", "parent", "child"]);
  // The subtree of `grandparent` is contiguous and covers both descendants.
  assertEquals(getItemSubtreeRange(result, 1), { startIndex: 1, endIndex: 3 });
});

Deno.test("computeItemPaths overrides a client chain that misnames the grandparent", () => {
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "realGrandparent", path: [] }),
    makeItem({ uid: "decoy", path: [] }),
    makeItem({ uid: "parent", path: ["realGrandparent"] }),
    // Client claims decoy → parent. The parent's own path wins.
    makeItem({ uid: "child", path: ["decoy", "parent"] }),
  ];
  const result = computeItemPaths(items);
  const child = result.find((i) => i.uid === "child")!;
  assertEquals(child.path, ["d1", "realGrandparent", "parent", "child"]);
});

Deno.test("computeItemPaths always writes a non-empty path ending in self", () => {
  // The two properties W0c asserts directly in api-cloudrun's write guard —
  // they hold regardless of what the client sends, including with no
  // structural dividers at all.
  const items: LineItem[] = [
    makeItem({ uid: "loose", path: [] }),
    makeItem({ uid: "weird", path: ["nope", "loose"] }),
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "under", path: ["d1", "d1"] }),
  ];
  for (const item of computeItemPaths(items)) {
    assertEquals(item.path.length >= 1, true);
    assertEquals(item.path.at(-1), item.uid);
  }
});

Deno.test("computeItemPaths terminates on a client-sent parent cycle", () => {
  // Only reachable via duplicate uids, but a client can send it, and an
  // unguarded parent walk would spin forever.
  const items: LineItem[] = [
    { type: "destination", uid: "d1", name: "", path: [] },
    makeItem({ uid: "A", path: ["B"] }),
    makeItem({ uid: "B", path: ["A"] }),
  ];
  const result = computeItemPaths(items);
  assertEquals(result.length, 3);
  assertEquals(new Set(result.map((i) => i.uid)).size, 3);
  for (const item of result) assertEquals(item.path.at(-1), item.uid);
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

// ── validateComponentUniqueness (products' self-EXCLUDED path convention) ──
// Product `components` paths are the ancestor chain WITHOUT self, so the
// immediate parent is path[-1] (not path[-2] as in orders items). Model a kit
// "K" with two direct children "c1"/"c2" (path [K]) and a grandchild under each.

Deno.test("validateComponentUniqueness allows the same sub-product under two different direct children (depth 2) — the api-cloudrun#348 case", () => {
  const items: LineItem[] = [
    makeItem({ uid: "c1", path: ["K"] }),
    makeItem({ uid: "X", path: ["K", "c1"] }), // parent = c1 (path[-1])
    makeItem({ uid: "c2", path: ["K"] }),
    makeItem({ uid: "X", path: ["K", "c2"] }), // parent = c2 — legal, distinct
  ];
  assertEquals(validateComponentUniqueness(items), []);
  // Contrast: the orders-shaped check keys X on its GRANDparent (path[-2] = "K")
  // for BOTH, so it FALSELY flags this legal tree — exactly the off-by-one #348.
  assertEquals(validateItemUniqueness(items).length, 1);
});

Deno.test("validateComponentUniqueness flags an exact-duplicate component row (a doubled tree)", () => {
  const items: LineItem[] = [
    makeItem({ uid: "c1", path: ["K"] }),
    makeItem({ uid: "X", path: ["K", "c1"] }),
    makeItem({ uid: "X", path: ["K", "c1"] }), // identical full path + uid → still rejected
  ];
  const issues = validateComponentUniqueness(items);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].uid, "X");
  assertEquals(issues[0].parentUid, "c1"); // names the TRUE immediate parent
  assertEquals(issues[0].index, 2);
  assertEquals(issues[0].firstIndex, 1);
});

Deno.test("validateComponentUniqueness flags a duplicate direct child (keyed on the root product)", () => {
  const items: LineItem[] = [
    makeItem({ uid: "X", path: ["K"] }),
    makeItem({ uid: "X", path: ["K"] }), // same product twice as a direct child → rejected
  ];
  const issues = validateComponentUniqueness(items);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].uid, "X");
  assertEquals(issues[0].parentUid, "K");
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

// ── calculateTransactionFeeAmount ────────────────────────────────

Deno.test("calculateTransactionFeeAmount: percent_of_total reads base as a percentage", () => {
  assertEquals(calculateTransactionFeeAmount(makeFeeItem({}, { base: 3 }), 100), 3);
  assertEquals(calculateTransactionFeeAmount(makeFeeItem({}, { base: 2.9 }), 1234.56), 35.80);
});

Deno.test("calculateTransactionFeeAmount: any other formula is per-unit", () => {
  const flat = makeFeeItem({ quantity: 3 }, { base: 5, formula: "fixed" });
  // The basis is irrelevant to a flat fee — 5 × 3, whatever the document totals.
  assertEquals(calculateTransactionFeeAmount(flat, 100), 15);
  assertEquals(calculateTransactionFeeAmount(flat, 999_999), 15);
});

Deno.test("calculateTransactionFeeAmount rejects a non-fee item", () => {
  assertThrows(() => calculateTransactionFeeAmount(makeItem(), 100));
});

Deno.test("calculateItemSubtotal refuses percent_of_total — it cannot see the basis", () => {
  // A fee is priced from the DOCUMENT. Reaching here means a caller tried to
  // cost one in isolation, which silently produced base × quantity before.
  assertThrows(
    () => calculateItemSubtotal(makeItem({ type: "sale" }, { formula: "percent_of_total", base: 3 })),
    Error,
    "percent_of_total",
  );
});

// The fee sweep and its reference, hoisted so the fail-closed companion below
// can reuse both. Independent of the implementation's `(2n·num + den) / (2n·den)`
// trick: take the exact quotient and remainder, then round half-up by hand.
const feeReferenceCents = (basisCents: bigint, rateMillipercent: bigint) => {
  const num = basisCents * rateMillipercent;
  const den = 100n * 1_000_000n;
  const q = num / den;
  const r = num % den;
  return 2n * r >= den ? q + 1n : q;
};

const FEE_RATES = [2.9, 3, 3.5, 0.05, 1.75, 12.345];
const FEE_SWEEP: { basisCents: bigint; rate: number }[] = (() => {
  const pairs: { basisCents: bigint; rate: number }[] = [];
  for (let basisCents = 1n; basisCents <= 200_000n; basisCents += 991n) {
    for (const rate of FEE_RATES) pairs.push({ basisCents, rate });
  }
  return pairs;
})();

Deno.test("calculateTransactionFeeAmount is exact — matches a BigInt rational reference", () => {
  // The form this replaced was `currency(basis).multiply(rate / 100)`, which
  // pre-divides into a float and lets currency.js quantize the RATIO. Sweep
  // basis × rate pairs against an exact integer-cents reference; 0 disagreements.
  for (const { basisCents, rate } of FEE_SWEEP) {
    const rateMilli = BigInt(Math.round(rate * 1_000_000));
    const expected = Number(feeReferenceCents(basisCents, rateMilli)) / 100;
    const actual = calculateTransactionFeeAmount(
      makeFeeItem({}, { base: rate }),
      Number(basisCents) / 100,
    );
    assertEquals(actual, expected, `basis=${basisCents}c rate=${rate}`);
  }
  assertEquals(FEE_SWEEP.length > 1000, true, "sweep did not run");
});

Deno.test("…and the divide-first fee form DOES disagree — the fee sweep can fail", () => {
  // The companion this sweep shipped without (core#48). It runs REAL currency.js
  // over both candidate wrong forms rather than modelling them, so the numbers
  // below are measured on every run instead of remembered in a comment.
  //
  // **The two forms are not equally wrong, and conflating them is why the
  // docstring on `calculateTransactionFeeAmount` was overstated.**
  //
  //   - `multiply(rate / 100)` — the ACTUAL predecessor (git a4b231c:272).
  //     `multiply` takes a plain JS number and never wraps it, so nothing
  //     quantizes the ratio; all it carries is the float representation error in
  //     `rate / 100`, which is ~1e-18 relative and only matters within a hair of
  //     a half-cent tie. REPORTED, not asserted — asserting a floor would mean
  //     tuning the corpus to a remembered number, and on this corpus it is 0.
  //   - `multiply(currency(rate).divide(100).value)` — divide-first, the form
  //     the money doctrine actually forbids. `divide` DOES re-enter the currency
  //     constructor, so at precision 2 the ratio is quantized to two decimals:
  //     `currency(2.9).divide(100) === 0.03`, `currency(12.345).divide(100) ===
  //     0.12`. This is api-cloudrun#415's literal shape, and it is what the
  //     assertion below pins.
  let divideFirst = 0;
  let multiplyFirst = 0;
  let worstCents = 0n;
  for (const { basisCents, rate } of FEE_SWEEP) {
    const basis = Number(basisCents) / 100;
    const want = feeReferenceCents(basisCents, BigInt(Math.round(rate * 1_000_000)));
    const wantDollars = Number(want) / 100;

    if (currency(basis).multiply(rate / 100).value !== wantDollars) multiplyFirst++;

    const bad = currency(basis).multiply(currency(rate).divide(100).value).value;
    if (bad !== wantDollars) {
      divideFirst++;
      const off = BigInt(Math.round(bad * 100)) - want;
      const mag = off < 0n ? -off : off;
      if (mag > worstCents) worstCents = mag;
    }
  }
  assertEquals(
    divideFirst > 0,
    true,
    "the divide-first fee form agreed on every pair — the reference has stopped discriminating",
  );
  console.log(
    `  divide-first mis-costs ${divideFirst} of ${FEE_SWEEP.length} fee pairs ` +
      `(worst ${Number(worstCents) / 100} off); multiply-first mis-costs ${multiplyFirst}`,
  );
});

Deno.test("getTransactionFeeTotals derives rate/type from the price, identity from the item", () => {
  const totals = getTransactionFeeTotals([
    makeFeeItem({ uid: "cc-fee-product", name: "Card Fee" }, { base: 3, total: 30 }),
    makeFeeItem({ uid: "flat-fee-product", name: "Handling" }, { base: 5, formula: "fixed", total: 5 }),
  ]);
  assertEquals(totals.length, 2);
  const card = totals.find((t) => t.name === "Card Fee");
  assertEquals(card?.uid, "cc-fee-product");
  assertEquals(card?.rate, 3);
  assertEquals(card?.type, "percent");
  assertEquals(card?.amount, 30);

  const handling = totals.find((t) => t.name === "Handling");
  assertEquals(handling?.type, "flat");
  assertEquals(handling?.rate, 5);
});

// ── ITEM_CONTRACTS ───────────────────────────────────────────────

Deno.test("ITEM_CONTRACTS covers every item type, and the derived lists agree", () => {
  // The compile-time assertions in `common.ts` already pin these; this is the
  // runtime companion, so a table edit that somehow type-checks still fails.
  const contractKeys = Object.keys(ITEM_CONTRACTS).sort();
  assertEquals(contractKeys.length, 9);

  const lines = contractKeys.filter((t) => ITEM_CONTRACTS[t as ItemTypeType].kind === "line").sort();
  assertEquals(lines, [...DOC_LINE_ITEM_TYPES].sort());

  const fulfillable = contractKeys.filter((t) => ITEM_CONTRACTS[t as ItemTypeType].fulfillable).sort();
  assertEquals(fulfillable, [...FULFILLMENT_LINE_ITEM_TYPES].sort());

  // transaction_fee is a line, but not a fulfillable one — the whole reason
  // FULFILLMENT_LINE_ITEM_TYPES is not a spelling of DOC_LINE_ITEM_TYPES.
  assertEquals(ITEM_CONTRACTS.transaction_fee.kind, "line");
  assertEquals(ITEM_CONTRACTS.transaction_fee.fulfillable, false);
});

Deno.test("the type predicates answer from the contract, and the three axes stay distinct", () => {
  // These replace eleven hand-written copies across three repos, which disagreed
  // in two ways that mattered: some added `!== "order"` (correct for invoices)
  // and some added `!== "transaction_fee"` (a DIFFERENT axis — fulfillable).
  for (const t of ["destination", "group", "order"] as const) {
    assertEquals(isDividerItemType(t), true, `${t} is a divider`);
    assertEquals(isLineItemType(t), false, `${t} is not a line`);
    assertEquals(isFulfillableItemType(t), false, `${t} is not fulfillable`);
  }
  for (const t of ["rental", "replacement", "sale", "service", "surcharge"] as const) {
    assertEquals(isLineItemType(t), true, `${t} is a line`);
    assertEquals(isDividerItemType(t), false, `${t} is not a divider`);
    assertEquals(isFulfillableItemType(t), true, `${t} is fulfillable`);
  }

  // The one row where "is a line" and "can be picked off a shelf" disagree.
  // Collapsing FULFILLMENT_LINE_ITEM_TYPES into DOC_LINE_ITEM_TYPES would put a
  // document-level charge on a picker's shelf list.
  assertEquals(isLineItemType("transaction_fee"), true);
  assertEquals(isFulfillableItemType("transaction_fee"), false);

  // A type with no contract is neither, so a stored document carrying a type
  // this build has never heard of cannot be silently treated as billable.
  assertEquals(isLineItemType("not_a_type"), false);
  assertEquals(isDividerItemType("not_a_type"), false);
  assertEquals(isFulfillableItemType("not_a_type"), false);

  // Every type is exactly one of line/divider — the two predicates partition
  // ITEM_TYPES rather than merely overlapping it.
  for (const t of Object.keys(ITEM_CONTRACTS)) {
    assertEquals(isLineItemType(t) !== isDividerItemType(t), true, `${t} is exactly one of line/divider`);
  }
});

Deno.test("the pricing entry points take an order-INPUT price, not only a stored one", () => {
  // The reason PricingPrice exists. An order-input item carries `taxes: {uid}[]`
  // and no subtotal/total — pricing's OUTPUT is not pricing's input. api-cloudrun
  // used to bridge the gap with `as unknown as LineItem`, on the money path, in
  // two writers; this is the shape that makes the cast unnecessary.
  const taxes: Tax[] = [{ uid: "t1", name: "Chicago Rental", rate: 9, type: "percent" }];
  const input: PricingItem = {
    type: "rental",
    quantity: 2,
    price: { base: 100, formula: "fixed", chargeable_days: null, discount: null, taxes: [{ uid: "t1" }] },
  };

  const computed = calculateItemPrice(input, taxes);
  assertEquals(computed.subtotal, 200);
  assertEquals(computed.subtotal_discounted, 200);
  assertEquals(computed.taxes.length, 1);
  assertEquals(computed.taxes[0].amount, 18);
  assertEquals(computed.total, 218);

  // A stored line item still prices identically through the same entry point —
  // the surface was widened, not swapped.
  const stored: LineItem = {
    uid: "u",
    name: "n",
    type: "rental",
    path: ["u"],
    quantity: 2,
    price: {
      base: 100,
      formula: "fixed",
      chargeable_days: null,
      discount: null,
      taxes: [{ uid: "t1", name: "Chicago Rental", rate: 9, type: "percent", amount: 18 }],
      subtotal: 200,
      subtotal_discounted: 200,
      total: 218,
    },
  };
  assertEquals(calculateItemPrice(stored, taxes), computed);
});

Deno.test("PreTaxItemType and FromTotalItemType are the contract's pricing axis, not a copy of it", () => {
  // Compile-time: the derived unions must still be assignable both ways against
  // the literals the table declares. If a type's `pricing` changes, one of these
  // stops compiling — which is the point of deriving them.
  const preTax: PreTaxItemType[] = ["rental", "replacement", "sale", "service", "surcharge"];
  const fromTotal: FromTotalItemType[] = ["transaction_fee"];

  // Runtime companion, same shape as the ITEM_CONTRACTS test above.
  const byPricing = (p: string) =>
    Object.keys(ITEM_CONTRACTS).filter((t) => ITEM_CONTRACTS[t as ItemTypeType].pricing === p).sort();
  assertEquals(byPricing("pre_tax"), [...preTax].sort());
  assertEquals(byPricing("from_total"), [...fromTotal].sort());
  assertEquals(byPricing("none"), ["destination", "group", "order"]);
});

Deno.test("the three pricing predicates read the contract, not their own type lists", () => {
  const price = { base: 10, formula: "fixed", chargeable_days: null, subtotal: 10, subtotal_discounted: 10, discount: null, taxes: [], total: 10 } as unknown as PriceObject;
  const at = (type: ItemTypeType): LineItem => ({ uid: "u", name: "n", type, path: ["u"], quantity: 1, price });

  for (const type of ["rental", "replacement", "sale", "service", "surcharge"] as const) {
    assertEquals(isPreTaxItem(at(type)), true, `${type} is pre-tax`);
    assertEquals(isTransactionFeeItem(at(type)), false, `${type} is not a fee`);
    assertEquals(isPriceableItem(at(type)), true, `${type} is priceable`);
  }

  assertEquals(isPreTaxItem(at("transaction_fee")), false);
  assertEquals(isTransactionFeeItem(at("transaction_fee")), true);
  assertEquals(isPriceableItem(at("transaction_fee")), true);

  for (const type of ["destination", "group", "order"] as const) {
    assertEquals(isPriceableItem(at(type)), false, `${type} is a divider`);
    assertEquals(isPreTaxItem(at(type)), false, `${type} is a divider`);
  }

  // A type with no contract answers false everywhere; `isPriceableItem` used to
  // answer true. `LineItem.type` is now `ItemTypeType`, so a CALLER can no
  // longer reach this — hence the cast, which is the test saying out loud that
  // the value comes from outside the type system. It still arrives that way in
  // practice: these items are read off Firestore documents, and a stored doc can
  // hold a type this build has never heard of.
  const unknownType = (t: string) => at(t as ItemTypeType);
  assertEquals(isPriceableItem(unknownType("not_a_type")), false);
  assertEquals(isPreTaxItem(unknownType("not_a_type")), false);
  assertEquals(isTransactionFeeItem(unknownType("not_a_type")), false);
});

// ── validateItemParentage ────────────────────────────────────────

const parentageItem = (uid: string, type: ItemTypeType, path: string[]): LineItem => ({ uid, name: uid, type, path });

Deno.test("validateItemParentage accepts the shapes prod actually holds", () => {
  // Order: destination -> group -> rental -> component. 4,453 line-parents-line
  // rows exist in prod, so a component under a product must stay legal.
  assertEquals(
    validateItemParentage([
      parentageItem("d1", "destination", ["d1"]),
      parentageItem("g1", "group", ["d1", "g1"]),
      parentageItem("p1", "rental", ["d1", "g1", "p1"]),
      parentageItem("c1", "sale", ["d1", "g1", "p1", "c1"]),
    ]),
    [],
  );

  // Invoice: order -> destination -> line.
  assertEquals(
    validateItemParentage([
      parentageItem("o1", "order", ["o1"]),
      parentageItem("d1", "destination", ["o1", "d1"]),
      parentageItem("p1", "rental", ["o1", "d1", "p1"]),
    ]),
    [],
  );

  // 78 legacy flat invoice items sit at the root in prod. Root is always legal,
  // so rejecting them here would make those invoices unwritable.
  assertEquals(validateItemParentage([parentageItem("p1", "rental", ["p1"])]), []);
});

Deno.test("validateItemParentage rejects a divider parented by a line item", () => {
  // The one asymmetry the corpus supports, and the state `computeItemPaths`
  // cannot currently produce — which is exactly why a fixed-point check against
  // it can never see this, and why the property is asserted independently.
  const issues = validateItemParentage([
    parentageItem("d1", "destination", ["d1"]),
    parentageItem("p1", "rental", ["d1", "p1"]),
    parentageItem("g1", "group", ["d1", "p1", "g1"]),
  ]);
  assertEquals(issues.length, 1);
  assertEquals(issues[0].uid, "g1");
  assertEquals(issues[0].type, "group");
  assertEquals(issues[0].parentType, "rental");
});

Deno.test("validateItemParentage rejects a fee nested under a product, and an unresolvable parent", () => {
  const nested = validateItemParentage([
    parentageItem("d1", "destination", ["d1"]),
    parentageItem("p1", "rental", ["d1", "p1"]),
    parentageItem("f1", "transaction_fee", ["d1", "p1", "f1"]),
  ]);
  assertEquals(nested.length, 1);
  assertEquals(nested[0].type, "transaction_fee");

  const dangling = validateItemParentage([parentageItem("c1", "sale", ["gone", "c1"])]);
  assertEquals(dangling.length, 1);
  assertEquals(dangling[0].parentType, "<unresolved>");
});

// ── isTaxableCoa / the COA taxability gate ───────────────────────
//
// Regression cover for the phantom-receivable defect: the taxability rule lived
// only on the Xero push side, so CFS computed tax on lines it then told Xero were
// untaxable (`TaxType: "NONE"`). Measured on prod 2026-07-30 before the fix:
// 19 invoices / $2,741.78.

Deno.test("isTaxableCoa: exactly the taxable revenue accounts, and no others", () => {
  for (const coa of [4000, 4140, 4200, 4210]) {
    assertEquals(isTaxableCoa(coa), true, `${coa} is a taxable revenue account`);
  }
  // Service Income, Delivery Surcharges, Contract Labor, PSA, Shipping,
  // Transaction Fee, Other Income, and the Bottled Water Tax liability — every
  // one of these appears in the prod defect set.
  for (const coa of [2210, 2800, 4100, 4110, 4120, 4130, 4150, 4700, 4800]) {
    assertEquals(isTaxableCoa(coa), false, `${coa} is not a taxable revenue account`);
  }
  // The two lists must be exhaustive over the enum, or a COA added later is
  // silently untested — which is how 4140 sat on the wrong side unexamined
  // while a $510.40 prod line was taxed at it in both CFS and Xero.
  assertEquals(
    [...TAXABLE_REVENUE_COAS].sort((a, b) => a - b),
    [4000, 4140, 4200, 4210],
  );
});

Deno.test("isTaxableCoa: 4140 Pass Through is taxable, and the reason is not symmetric", () => {
  // Every other member of the set is there because the Xero push already said
  // so and the engine disagreed. 4140 is the opposite: CFS and Xero AGREED —
  // prod #1897 holds its SSD Card line at 4140 in both, taxed TAX003 at 11% for
  // $510.40, paid — and the constant was the thing out of step. Excluding it
  // meant the next reprice would delete tax that had been collected and
  // remitted, so this case is a guard against a repair, not against a charge.
  assertEquals(isTaxableCoa(4140), true);
});

Deno.test("isTaxableCoa: an UNKNOWN coa is taxable — the asymmetry with the Xero push", () => {
  // The push uses `![4000,4200,4210].includes(coa ?? 0)`, i.e. unknown ⇒ NONE.
  // Mirroring that here would zero the tax on every ORDER line in the corpus,
  // because an order line carries no `coa_revenue` at all. The gate must only
  // ever remove tax from a line it can positively identify as non-revenue.
  assertEquals(isTaxableCoa(undefined), true);
  assertEquals(isTaxableCoa(null), true);
});

// ── computeItemTaxAmount: the sweep core#47 shipped without ──────
//
// This was the one percent-of-money path that never migrated to integer cents.
// Inside a single `calculateItemPrice` call the discount on a line was already
// exact BigInt while the tax on that same line was
// `currency(subtotalDiscounted).multiply(tax.rate / 100)` — a pre-divided float
// ratio, applied to EVERY percent tax on every order and invoice line, with
// nothing that would catch a change in rate or magnitude.
//
// Same rig as the subtotal and fee sweeps above: an oracle that rounds by the
// definition, and a companion asserting a wrong form disagrees.

/** The true tax in cents, as one exact rational, rounded half away from zero. */
function exactTaxCents(rate: number, type: "percent" | "flat", subtotal: number, qty: number) {
  const round = (num: bigint, den: bigint) => {
    const neg = num < 0n;
    const n = neg ? -num : num;
    const q = n / den;
    const r = n % den;
    const up = 2n * r >= den ? q + 1n : q;
    return neg ? -up : up;
  };
  if (type === "percent") {
    const rateMilli = BigInt(Math.round(rate * 1_000_000));
    return round(BigInt(Math.round(subtotal * 100)) * rateMilli, 100n * 1_000_000n);
  }
  return round(BigInt(Math.round(rate * 100)) * BigInt(Math.round(qty * 10_000)), 10_000n);
}

const TAX_SWEEP: { rate: number; type: "percent" | "flat"; subtotal: number; qty: number }[] =
  (() => {
    let seed = 55_555;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const rows = [];
    // CFS's six live rates, plus randomly drawn ones — the live set is what runs
    // today, the random ones are what stop "benign at today's rates" from being
    // mistaken for "correct".
    const live = [15, 10.25, 9, 11, 8, 0];
    for (let i = 0; i < 200_000; i++) {
      const percent = rand(5) !== 0;
      // Negative subtotals are IN the domain: a flat discount larger than its
      // line produces one, and `calculateItemSubtotal` deliberately does not
      // clamp it. A sweep over non-negative subtotals only would never reach
      // the sign path.
      const subtotal = (rand(20_000_000) - 2_000_000) / 100;
      rows.push({
        rate: percent
          ? (rand(6) === 0 ? live[rand(live.length)] : rand(3_000_000) / 10_000)
          : rand(2_000) / 100,
        type: (percent ? "percent" : "flat") as "percent" | "flat",
        subtotal,
        qty: rand(200_000) / 10_000,
      });
    }
    return rows;
  })();

Deno.test("computeItemTaxAmount matches exact rational arithmetic over 200k random taxes", () => {
  let disagreements = 0;
  let first: string | null = null;
  for (const r of TAX_SWEEP) {
    const got = computeItemTaxAmount({ rate: r.rate, type: r.type }, r.subtotal, r.qty);
    const want = exactTaxCents(r.rate, r.type, r.subtotal, r.qty);
    if (BigInt(Math.round(got * 100)) !== want) {
      disagreements++;
      first ??= `${JSON.stringify(r)} → got ${got}, want ${Number(want) / 100}`;
    }
  }
  assertEquals(disagreements, 0, first ?? "");
});

Deno.test("…and the divide-first tax form DOES disagree — the tax sweep can fail", () => {
  // Two wrong forms, measured with REAL currency.js rather than modelled:
  //
  //   - the predecessor, `currency(subtotal).multiply(rate / 100)`. `multiply`
  //     takes a plain JS number and never wraps it, so nothing quantizes the
  //     ratio — this is the benign float form, and core#47's own probe over
  //     CFS's six live rates found 0 disagreements. REPORTED, not asserted:
  //     asserting a floor would tune the corpus to a remembered number, and the
  //     whole finding is that it is wrong by the RULE, not by measurement.
  //   - divide-first, `currency(rate).divide(100)`, which does re-enter the
  //     constructor and quantizes the ratio to two decimals. This is what the
  //     doctrine forbids, and the assertion pins it.
  let divideFirst = 0;
  let multiplyFirst = 0;
  let worstCents = 0n;
  for (const r of TAX_SWEEP) {
    if (r.type !== "percent") continue;
    const want = exactTaxCents(r.rate, r.type, r.subtotal, r.qty);

    if (BigInt(Math.round(currency(r.subtotal).multiply(r.rate / 100).value * 100)) !== want) {
      multiplyFirst++;
    }

    const bad = currency(r.subtotal).multiply(currency(r.rate).divide(100).value).value;
    if (BigInt(Math.round(bad * 100)) !== want) {
      divideFirst++;
      const off = BigInt(Math.round(bad * 100)) - want;
      const mag = off < 0n ? -off : off;
      if (mag > worstCents) worstCents = mag;
    }
  }
  assertEquals(
    divideFirst > 0,
    true,
    "the divide-first tax form agreed on every row — the oracle has stopped discriminating",
  );
  console.log(
    `  divide-first mis-taxes ${divideFirst} rows (worst $${Number(worstCents) / 100} off); ` +
      `multiply-first mis-taxes ${multiplyFirst}`,
  );
});

Deno.test("computeItemTaxAmount carries the subtotal's sign — a negative line is not clamped", () => {
  // `calculateItemSubtotal` lets a flat discount exceed its line ("the caller's
  // problem to surface, not ours to clamp"), so a negative subtotal reaches here
  // and must produce negative tax. Clamping would silently drop it, and the
  // rounding must be symmetric: f(-x) === -f(x).
  const tax = { rate: 15, type: "percent" as const };
  assertEquals(computeItemTaxAmount(tax, -100, 1), -15);
  assertEquals(computeItemTaxAmount(tax, 100, 1), 15);
  for (const subtotal of [0.03, 1.115, 33.335, 999.995, 12_345.67]) {
    assertEquals(
      computeItemTaxAmount(tax, -subtotal, 1),
      -computeItemTaxAmount(tax, subtotal, 1),
      `asymmetric at ${subtotal}`,
    );
  }
});

Deno.test("calculateReplacementTotals shares ONE tax formula with the order path", () => {
  // It used to hold a second, independent copy of the percent/flat branch, so
  // core#47's fix would not have reached it. Pinning the equality is what stops
  // the copy growing back.
  const item = makeItem({ quantity: 3 }, {
    base: 100,
    replacement: 250.55,
    taxes: [{ uid: "chi-sales-tax", name: "Chicago Sales Tax", rate: 10.25, type: "percent" }],
  });
  const totals = calculateReplacementTotals([item], TAXES);
  assertEquals(totals.subtotal, 751.65);
  assertEquals(
    totals.tax,
    computeItemTaxAmount({ rate: 10.25, type: "percent" }, 751.65, 3),
    "the replacement path diverged from computeItemTaxAmount",
  );
  // Written as `751.65 + totals.tax` first, which fails at 828.6899999999999 —
  // float addition on two 2dp values. The implementation is right and the
  // assertion was wrong, which is the whole campaign in miniature.
  assertEquals(totals.tax, 77.04);
  assertEquals(totals.total, 828.69);
});

Deno.test("calculateItemTax: a non-revenue COA yields no tax", () => {
  const item = makeItem({ coa_revenue: 4100 }, { taxes: [{ uid: "chi-rental-tax" }] });
  assertEquals(calculateItemTax(item, TAXES), []);
});

Deno.test("calculateItemTax: the SAME line taxes normally on a revenue COA", () => {
  // Paired with the case above so the gate is shown to discriminate rather than
  // to suppress everything — the two differ only in `coa_revenue`.
  const item = makeItem({ coa_revenue: 4000 }, { taxes: [{ uid: "chi-rental-tax" }] });
  const result = calculateItemTax(item, TAXES);
  assertEquals(result.length, 1);
  assertEquals(result[0].amount, 15);
});

Deno.test("calculateItemTax: an absent COA still taxes (order lines carry none)", () => {
  const item = makeItem({}, { taxes: [{ uid: "chi-rental-tax" }] });
  assertEquals(calculateItemTax(item, TAXES).length, 1);
});

Deno.test("calculateItemPrice: a non-revenue COA drops tax out of the total", () => {
  // The end-to-end shape of the prod defect: #1330 was a single `service` line at
  // coa 4100 whose CFS total read 7063.20 against Xero's 6480.00 — the entire
  // 583.20 delta being tax CFS invented.
  const taxed = calculateItemPrice(
    makeItem({ coa_revenue: 4000 }, { taxes: [{ uid: "chi-rental-tax" }] }),
    TAXES,
  );
  const gated = calculateItemPrice(
    makeItem({ coa_revenue: 4100 }, { taxes: [{ uid: "chi-rental-tax" }] }),
    TAXES,
  );
  assertEquals(taxed.total, 115);
  assertEquals(gated.total, 100);
  assertEquals(gated.total, gated.subtotal_discounted, "total is the untaxed subtotal");
});
