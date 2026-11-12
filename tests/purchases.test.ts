/**
 * Purchases (api-cloudrun#1210) — the cumulative share that prices receipts and
 * bill items, the status rule, and the three documents' refines. The item shape
 * (`type`-discriminated items with row identity and stored posting) is
 * api-cloudrun#1407.
 *
 * Every refine is asserted in pairs from one valid factory, mutating ONE field
 * per negative case, so a case cannot pass by failing for some other reason
 * (`core/CLAUDE.md` § *Making a field REQUIRED*).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type PurchaseSaleItem,
  ClosePurchaseInput,
  COA_ASSET_CODES,
  CreatePurchaseBillInput,
  CreatePurchaseCreditInput,
  CreatePurchaseInput,
  type PurchaseServiceItem,
  PurchaseServiceItemSchema,
  derivePurchaseCreditSources,
  INVOICE_FIELD_CLASSES,
  INVOICE_FIELD_FREEZE,
  PURCHASE_ITEM_TYPES,
  type PurchaseItem,
  PurchaseDestinationInput,
  PurchaseItemInput,
  PurchaseRowInput,
  type PurchaseLandedCost,
  getInitialValues,
  PurchaseBillSchema,
  PurchaseCreditSchema,
  PurchaseDocumentProductItemSchema,
  PurchaseSchema,
  purchaseHireWindow,
  ReceivePurchaseInput,
  ReturnPurchaseInput,
  type PurchaseRentalItem,
  PurchaseRentalItemSchema,
  UpdatePurchaseInput,
} from "../src/schemas/mod.ts";
import { buildFirestoreColumns } from "../src/schemas/display-columns.ts";
import { classifySharedFields } from "../src/utils/shared-fields.ts";
import { deriveInvoiceStatus, invoiceFieldIsFrozen, invoiceIsFrozen, recomputePurchaseBillTotals } from "../src/utils/invoices.ts";
import { XERO_ASSET_ACCOUNTS } from "../src/utils/movements.ts";
import {
  allocateLandedCostCents,
  cumulativeShareCents,
  deriveQueryByItemTypes,
  expandPurchaseItems,
  isLandedCostFrozen,
  landedCostWeightCents,
  purchaseLineCloseOutcome,
  landedUnitsPriced,
  purchaseLineReceiptTargetCents,
  strandedLandedCents,
  type PurchaseExpansionComponent,
  type PurchaseExpansionProduct,
  deriveQueryByOrders,
  deriveQueryByProducts,
  deriveQueryByUnits,
  purchaseItemCommittedCents,
  remainingToBill,
  remainingToReceive,
  remainingToReturn,
  NO_LINE_CUSTODY,
} from "../src/utils/purchases.ts";
import { apportionCents } from "../src/utils/money.ts";
import { flatPurchaseLineMoney } from "../src/utils/purchases.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";
import { asCreditRows, payablePrice, purchaseDivider, purchasePair, withPayableMoney } from "./helpers/payable.ts";

/** The tax class every payable test line is stamped with: exempt on this side, so it prices nothing. */
const TAX_CLASS = "TaxClassResale000000";

// ── the cumulative share ─────────────────────────────────────────────

/**
 * The exact half-up rounding of `num / den`, computed by quotient and REMAINDER
 * rather than by `roundDivHalfUp`'s `(2n + d) / 2d` — an oracle that shared the
 * implementation's decomposition could only ever agree with it.
 */
function halfUpByRemainder(num: bigint, den: bigint): bigint {
  const q = num / den;
  const r = num % den;
  return 2n * r >= den ? q + 1n : q;
}

/** Deterministic PRNG, so a failure names a reproducible draw. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random path 0 → quantity in positive steps: an item's receipts, or its bills. */
function randomPath(rand: () => number, quantity: number): number[] {
  const steps: number[] = [];
  let at = 0;
  while (at < quantity) {
    const step = 1 + Math.floor(rand() * Math.min(quantity - at, 1 + Math.floor(rand() * 40)));
    steps.push(step);
    at += step;
  }
  return steps;
}

const DRAWS = 200_000;

Deno.test("cumulativeShareCents: over 200k random lines and paths, partials sum EXACTLY, each within a cent of pro rata, and the cumulative equals exact half-up", () => {
  const rand = mulberry32(1210);
  let partials = 0;
  let failure: string | null = null;
  for (let draw = 0; draw < DRAWS; draw++) {
    // Up to $1M a line and 500 units — the width a real purchase line spans,
    // and a 1-unit line is drawn often enough to exercise the trivial path.
    const amount = Math.floor(rand() * 100_000_000);
    const quantity = 1 + Math.floor(rand() * (rand() < 0.5 ? 12 : 500));
    let before = 0;
    let sum = 0n;
    for (const step of randomPath(rand, quantity)) {
      const after = before + step;
      const part = BigInt(cumulativeShareCents(amount, quantity, before, after));
      // Exact pro rata of `step` units is amount·step/quantity; the partial is
      // the difference of two values each within ½ cent, so within 1 cent.
      const diff = part * BigInt(quantity) - BigInt(amount) * BigInt(step);
      const cum = BigInt(cumulativeShareCents(amount, quantity, 0, after));
      // Plain comparisons, not assertions, in the hot loop: an assertion call
      // per step was 3/4 of this test's runtime. The first failure is kept.
      if (failure === null) {
        if (diff >= BigInt(quantity) || -diff >= BigInt(quantity)) {
          failure = `draw ${draw}: ${part} too far from ${amount}×${step}/${quantity}`;
        } else if (part < 0n) {
          failure = `draw ${draw}: negative partial`;
        } else if (cum !== halfUpByRemainder(BigInt(amount) * BigInt(after), BigInt(quantity))) {
          // The cumulative value at `after` is the exact half-up of the rational.
          failure = `draw ${draw}: cumulative ${cum} at ${after}/${quantity} of ${amount}`;
        }
      }
      sum += part;
      before = after;
      partials++;
    }
    if (failure === null && sum !== BigInt(amount)) {
      failure = `draw ${draw}: partials of ${amount}/${quantity} sum to ${sum}`;
    }
  }
  assertEquals(failure, null);
  assert(partials > DRAWS, "the sweep exercised multi-step paths");
});

Deno.test("cumulativeShareCents companion: rounding each PARTIAL instead does NOT sum to the line — the sweep above can fail", () => {
  // The form this replaces: price each receipt on its own. If it never
  // disagreed, the exact-sum assertion above would be guarding nothing.
  const rand = mulberry32(1210);
  let drifted = 0;
  for (let draw = 0; draw < 20_000; draw++) {
    const amount = Math.floor(rand() * 100_000_000);
    const quantity = 1 + Math.floor(rand() * 500);
    let sum = 0n;
    for (const step of randomPath(rand, quantity)) {
      sum += halfUpByRemainder(BigInt(amount) * BigInt(step), BigInt(quantity));
    }
    if (sum !== BigInt(amount)) drifted++;
  }
  assert(drifted > 1_000, `per-partial rounding drifted on only ${drifted} of 20,000 lines`);
  // The docblock's worked example, pinned.
  assertEquals([1, 1, 1].map(() => cumulativeShareCents(1000, 3, 0, 1)), [333, 333, 333]);
  assertEquals(
    [cumulativeShareCents(1000, 3, 0, 1), cumulativeShareCents(1000, 3, 1, 2), cumulativeShareCents(1000, 3, 2, 3)],
    [333, 334, 333],
  );
});

Deno.test("cumulativeShareCents: refuses bounds a correct writer never sends", () => {
  assertThrows(() => cumulativeShareCents(100, 0, 0, 0), RangeError);
  assertThrows(() => cumulativeShareCents(-1, 2, 0, 1), RangeError);
  assertThrows(() => cumulativeShareCents(100, 2, 1, 0), RangeError);
  assertThrows(() => cumulativeShareCents(100, 2, 0, 3), RangeError);
  assertThrows(() => cumulativeShareCents(100, 2, 0.5, 1), RangeError);
  assertEquals(cumulativeShareCents(100, 2, 1, 1), 0);
});

// ── item fixtures ────────────────────────────────────────────────────

/** A deterministic item uid per index — row identity, never a product uid. */
const iuid = (n: number) => `9a1b2c3d-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** A deterministic LINE uid per index, product-shaped: a payable catalog line's uid IS its product's (W4K). */
const lid = (n: number) => `testline${String(n).padStart(12, "0")}`;
const PRODUCT = "testprod100000000000";
/** The destination divider (and pair) every fixture line sits under (one-document-model Phase 3). */
const D = "9a1b2c3d-0000-4000-8000-0000000000d1";

const line = (over: Partial<PurchaseSaleItem> = {}): PurchaseSaleItem => {
  const uid = over.uid ?? lid(1);
  return withPayableMoney({
    type: "sale",
    uid,
    path: [D, uid],
    description: "",
    zero_priced: null,
    name: "Walkie Talkie",
    uid_product: uid,
    quantity: 3,
    amount_cents: 140985,
    price: flatPrice,
    ledger_account: 1999,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    quantity_billed: 0,
    landed_costs: [],
    ...over,
  });
};

const HIRE = { start: "2026-10-18T09:00:00.000-05:00", end: "2026-10-25T17:00:00.000-05:00" };
const ORDER_1074 = "testorder1074000000a";

/** The formula snapshots a line carries (Phase 2 ruling 1). */
const FIXED = { uid: "FixedFormula00000000", name: "Fixed", basis: "flat" as const };
const WEEKLY = { uid: "VisionWeeklyFormula0", name: "Weekly while on", basis: "time" as const };
const MONTHLY = { uid: "VerizonMonthlyFormul", name: "Monthly unless suspended", basis: "time" as const };
// Money keys at 0: every builder restates them from its own amount (`withPayableMoney`).
const flatPrice = payablePrice(0, { formula: FIXED });
// A TIME-shaped price: refused by the schemas until one-document-model Phase 3,
// still read by the utils' time branches, which these fixtures keep covered.
const weeklyPrice = {
  ...payablePrice(0, { formula: WEEKLY }),
  rates: [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 4500 }],
};

/** A FLAT subrent item of 10 steamers. Its custody is the movements', handed in beside it (C8). */
const hireLine = (over: Partial<PurchaseRentalItem> = {}): PurchaseRentalItem => {
  const uid = over.uid ?? lid(2);
  return withPayableMoney({
    type: "rental",
    uid,
    path: [D, uid],
    description: "",
    zero_priced: null,
    name: "Steamer",
    uid_product: uid,
    quantity: 10,
    amount_cents: 50_000,
    price: flatPrice,
    ledger_account: 5100,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    quantity_billed: 0,
    uid_orders: [ORDER_1074],
    uid_units: [],
    ...over,
  });
};

/** A TIME subrent — Vision's hotspots, "weekly while on". */
const timeHire = (over: Partial<PurchaseRentalItem> = {}): PurchaseRentalItem =>
  hireLine({ amount_cents: null, price: weeklyPrice, quantity_billed: null, ...over });

/** A TIME charge — a Verizon device line, "monthly unless suspended". */
const carrierLine = (over: Partial<PurchaseServiceItem> = {}): PurchaseServiceItem => {
  const uid = over.uid ?? `custom-${lid(3)}`;
  return withPayableMoney({
    type: "service",
    uid,
    path: [D, uid],
    description: "",
    zero_priced: null,
    name: "Hotspot (Unlimited)",
    quantity: 1,
    amount_cents: null,
    price: { ...payablePrice(0, { formula: MONTHLY }), rates: [{ rate_key: "month", amount_cents: 8000 }] },
    ledger_account: 5150,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    quantity_billed: null,
    uid_units: [],
    uid_product: PRODUCT,
    ...over,
  });
};

/** A FLAT charge — freight. */
const freight = (over: Partial<PurchaseServiceItem> = {}): PurchaseServiceItem => {
  const uid = over.uid ?? `custom-${lid(4)}`;
  return withPayableMoney({
    type: "service",
    uid,
    path: [D, uid],
    description: "",
    zero_priced: null,
    name: "Freight",
    quantity: 1,
    amount_cents: 1_500,
    price: flatPrice,
    ledger_account: 5300,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    quantity_billed: 0,
    uid_units: [],
    ...over,
  });
};

// ── status ───────────────────────────────────────────────────────────
//
// A purchase's status is custody-only since 7a (rulings 55, 56, 61): it reads
// the inbound bookings, not the lines. Its table is in
// tests/bookings-inbound.test.ts.

Deno.test("remainingToReceive / remainingToBill are each bounded by the quantity; remainingToReturn is received − returned", () => {
  const l = line({ quantity: 2, quantity_billed: 2 });
  assertEquals(remainingToReceive(l, { received: 1 }), 1);
  assertEquals(remainingToBill(l), 0);
  assertEquals(remainingToBill(line({ quantity_billed: 5 })), 0, "an over-billed line has nothing left, never a negative");
  assertEquals(remainingToReturn({ received: 7, returned: 3 }), 4);
});

// ── purchases ────────────────────────────────────────────────────────

const actor = { uid: "testuser100000000000", name: "Test User" };
const SUPPLIER = { uid: "testsupp100000000000", name: "Baycom" };

/**
 * A purchase whose `items` are the given LINES under one destination divider
 * `D`, answered by one store pair — with the hire window when a subrent is
 * among them. `over.items` names the lines; `over.rows` replaces the whole
 * array (a test planting a bad row); `over.destinations` replaces the pairs.
 */
function purchase(over: Record<string, unknown> = {}) {
  const { items: lines = [line()], rows, ...rest } = over as { items?: unknown[]; rows?: unknown[] };
  const items = (lines as PurchaseItem[]);
  const hasHire = items.some((i) => (i as { type?: string })?.type === "rental");
  return {
    uid: "testpurch10000000000",
    number: 1,
    status: "active",
    supplier: SUPPLIER,
    uid_store: "teststore10000000000",
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    subject: "",
    reference: "Q-1182",
    notes: null,
    items: rows ?? [purchaseDivider(D), ...items],
    destinations: [purchasePair(D, hasHire ? HIRE : null)],
    total_cents: 140985,
    query_by_products: deriveQueryByProducts(items),
    query_by_orders: deriveQueryByOrders(items),
    query_by_item_types: deriveQueryByItemTypes(items),
    query_by_bills: [],
    bills: [],
    credits: [],
    query_by_credits: [],
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...rest,
  };
}

/** A purchase whose total and mirrors are DERIVED from `items` — for the arm tests. */
function withItems(items: PurchaseItem[], over: Record<string, unknown> = {}) {
  return purchase({
    items,
    total_cents: items.reduce((s, i) => s + purchaseItemCommittedCents(i), 0),
    query_by_products: deriveQueryByProducts(items),
    query_by_orders: deriveQueryByOrders(items),
    query_by_item_types: deriveQueryByItemTypes(items),
    status: "active",
    ...over,
  });
}

function issuePaths(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }, doc: unknown): string[] {
  const r = schema.safeParse(doc);
  return r.success ? [] : r.error!.issues.map((i) => i.path.join("."));
}

Deno.test("PurchaseSchema accepts a valid purchase", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase()), []);
});

Deno.test("PurchaseSchema accepts every arm on ONE purchase — the kind is per item (D3)", () => {
  const items = [line(), hireLine(), freight()];
  assertEquals(issuePaths(PurchaseSchema, withItems(items, { total_cents: 140985 + 50_000 + 1_500 })), []);
  assertEquals(deriveQueryByItemTypes(items), ["sale", "rental", "service"]);
});

Deno.test("PurchaseSchema: the retired custody buckets and line status are refused on a stored line (C8)", () => {
  for (const [key, value] of [["quantity_received", 0], ["status", "open"], ["expected_date", null]] as const) {
    assertEquals(issuePaths(PurchaseSchema, withItems([{ ...line(), [key]: value } as PurchaseSaleItem])), ["items.1"], `buy with ${key}`);
  }
  assertEquals(issuePaths(PurchaseSchema, withItems([{ ...hireLine(), quantity_returned: 0 } as PurchaseRentalItem])), ["items.1"]);
  const legacy = { ...purchase(), store: { uid: "teststore10000000000", name: "Main" } } as Record<string, unknown>;
  delete legacy.uid_store;
  assertEquals(issuePaths(PurchaseSchema, legacy), ["uid_store", ""]);
});

Deno.test("PurchaseSchema: OVER-billing is legal — the ceiling refine is gone; the diff flags it (D5)", () => {
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ quantity: 2, quantity_billed: 3 })])), []);
  assertEquals(issuePaths(PurchaseSchema, withItems([freight({ quantity_billed: 2 })])), []);
});

Deno.test("PurchaseSchema: one product may sit on two items (D2), in two groups (W4K); row identity is the PATH", () => {
  const G = "9a1b2c3d-0000-4000-8000-0000000000a1";
  const two = [line(), line({ path: [D, G, lid(1)], quantity: 1, amount_cents: 100 })];
  assertEquals(deriveQueryByProducts(two), [lid(1)], "the mirror stays distinct");
  // A PATH named twice is refused, and so is a path that does not end in its
  // own uid. A uid may repeat under different parents (one-document-model Phase 3).
  assertEquals(issuePaths(PurchaseSchema, withItems([line(), line({ quantity: 1, amount_cents: 100 })])), ["items.2.path"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ path: [D, iuid(8)] })])), ["items.1.path"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ path: [] })])), ["items.1.path"]);
  const grouped = purchase({
    rows: [purchaseDivider(D), { uid: G, type: "group", name: "Spare", path: [D, G], description: "" }, ...two],
    total_cents: 141085,
  });
  assertEquals(issuePaths(PurchaseSchema, grouped), [], "one uid under two parents is two rows");
});

Deno.test("PurchaseSchema: total_cents is the Σ of the COMMITTED amounts", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ total_cents: 140984 })), ["total_cents"]);
  // A time line commits nothing (owner, 2026-10-30): its bills decide its cost.
  assertEquals(purchaseItemCommittedCents(timeHire()), 0);
  assertEquals(purchaseItemCommittedCents(carrierLine()), 0);
  assertEquals(purchaseItemCommittedCents(hireLine()), 50_000);
  assertEquals(purchaseItemCommittedCents(freight()), 1_500);
  const mixed = [line(), freight()];
  assertEquals(issuePaths(PurchaseSchema, withItems(mixed, { total_cents: 140985 + 1_500 })), []);
  assertEquals(issuePaths(PurchaseSchema, withItems(mixed, { total_cents: 140985 + 1_500 + 50_000 })), ["total_cents"]);
});

Deno.test("PurchaseSchema: the status is the inbound bookings', so the document refines none of it (7a, ruling 55)", () => {
  // It used to be refined against the line buckets. It reads another collection
  // now, so a stored `complete` beside unreceived lines parses, as an order's
  // does beside reserved bookings; derivePurchaseStatus is the authority.
  assertEquals(issuePaths(PurchaseSchema, purchase({ status: "complete" })), []);
  assertEquals(issuePaths(PurchaseSchema, purchase({ status: "draft" })), ["status"]);
});

Deno.test("PurchaseSchema: a purchase orders at least one item", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [], total_cents: 0 })), ["items"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ rows: [], total_cents: 0 })).includes("items"), true);
});

Deno.test("PurchaseSchema: every line sits under a destination divider its pair answers (one-document-model Phase 3)", () => {
  // Leads with the divider.
  assertEquals(issuePaths(PurchaseSchema, purchase({ rows: [line(), purchaseDivider(D)] })), ["items.0.type"]);
  // A divider no pair answers, and a pair no divider names.
  assertEquals(issuePaths(PurchaseSchema, purchase({ destinations: [] })).length > 0, true);
  const P2 = "9a1b2c3d-0000-4000-8000-0000000000d2";
  assertEquals(issuePaths(PurchaseSchema, purchase({ destinations: [purchasePair(D), purchasePair(P2)] })).length > 0, true);
});

Deno.test("PurchaseSchema: ledger_account is constrained per arm (D4)", () => {
  // buy → an inventory asset account; subrent → Direct Costs; charge → any.
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ ledger_account: 1400 })])), []);
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ ledger_account: 5100 as never })])), ["items.1.ledger_account"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ ledger_account: 1999 as never })])), ["items.1.ledger_account"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([freight({ ledger_account: 6100 })])), []);
});

Deno.test("COA_ASSET_CODES names exactly XERO_ASSET_ACCOUNTS' codes", () => {
  assertEquals([...COA_ASSET_CODES].sort(), Object.values(XERO_ASSET_ACCOUNTS).sort());
});

Deno.test("PurchaseSchema: each arm carries exactly its own members — a buy cannot hold a hire, a subrent cannot hold landed costs", () => {
  for (const [key, value] of [["dates", HIRE], ["uid_orders", []]] as const) {
    assertEquals(issuePaths(PurchaseSchema, withItems([{ ...line(), [key]: value } as PurchaseSaleItem])), ["items.1"], `buy with ${key}`);
  }
  assertEquals(issuePaths(PurchaseSchema, withItems([{ ...hireLine(), landed_costs: [] } as PurchaseRentalItem])), ["items.1"]);
  // The hire window and `auto_link` are retired from the line (one-document-model Phase 3).
  for (const [key, value] of [["dates", HIRE], ["auto_link", false]] as const) {
    assertEquals(issuePaths(PurchaseSchema, withItems([{ ...hireLine(), [key]: value } as PurchaseRentalItem])), ["items.1"], `subrent with ${key}`);
  }
  for (const key of ["uid_orders", "price"] as const) {
    const without = { ...hireLine() } as Record<string, unknown>;
    delete without[key];
    assertEquals(issuePaths(PurchaseSchema, withItems([hireLine()], { items: [without] })).includes(`items.1.${key}`), true, `subrent without ${key}`);
  }
  const noLanded = { ...line() } as Record<string, unknown>;
  delete noLanded.landed_costs;
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [noLanded] })), ["items.1.landed_costs"]);
});

Deno.test("PurchaseSchema: a hire may not end before it starts", () => {
  // The hire window is the PAIR's (one-document-model Phase 3), and its supply end is `collection_end`.
  const pair = purchasePair(D, HIRE);
  const reversed = { ...pair, dates: { ...pair.dates, delivery_start: HIRE.end, collection_end: HIRE.start } };
  assertEquals(
    issuePaths(PurchaseSchema, withItems([hireLine()], { destinations: [reversed] })),
    ["destinations.0.dates.collection_end"],
  );
});

Deno.test("PurchaseSchema: a STANDING subrent's pair has collection_end null (D8)", () => {
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine()], { destinations: [purchasePair(D, { start: HIRE.start, end: null })] })), []);
  assertEquals(purchaseHireWindow({ destinations: [purchasePair(D, { start: HIRE.start, end: null })] }, hireLine()), { start: HIRE.start, end: null });
  assertEquals(purchaseHireWindow({ destinations: [purchasePair(D)] }, line()), null, "a store pair states no window");
});

Deno.test("PurchaseSchema: a flat line states an amount and no rates (ruling 1)", () => {
  // Each negative case breaks ONE half of the rule.
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ amount_cents: null })])), ["items.1.amount_cents"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ price: { ...flatPrice, rates: weeklyPrice.rates } })])), [
    "items.1.price.rates",
  ]);
  assertEquals(issuePaths(PurchaseSchema, withItems([freight({ quantity_billed: null })])), ["items.1.quantity_billed"]);
});

Deno.test("PurchaseSchema: a TIME line commits nothing — no amount, no billed count, zero money; it carries its rates (Phase 3)", () => {
  for (const item of [timeHire(), carrierLine()]) {
    assertEquals(issuePaths(PurchaseSchema, withItems([item])), [], `${item.type} on a time formula`);
  }
  // A BUY is never time-priced: its arm requires an amount and a billed count,
  // which a time line refuses.
  const timeBuy = issuePaths(PurchaseSchema, withItems([line({ price: weeklyPrice })]));
  assertEquals(timeBuy.includes("items.1.amount_cents") && timeBuy.includes("items.1.quantity_billed"), true, timeBuy.join(", "));
  // Each half of the rule alone.
  assertEquals(issuePaths(PurchaseSchema, withItems([timeHire({ quantity_billed: 0 })])), ["items.1.quantity_billed"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([timeHire({ price: { ...weeklyPrice, rates: [] } })])), ["items.1.price.rates"]);
  assertEquals(
    // Planted AFTER the builder, which restates money from the amount.
    issuePaths(PurchaseSchema, withItems([{ ...timeHire(), price: { ...timeHire().price, subtotal_discounted_cents: 1 } }])),
    ["items.1.price.subtotal_discounted_cents"],
  );
});

Deno.test("PurchaseSchema: a line's price money is what its stated amount gives — each identity alone", () => {
  const discounted = hireLine({ amount_cents: 45_000, price: { ...flatPrice, discount: { rate: 10, type: "percent", amount_cents: 5_000 } } });
  assertEquals(discounted.price.subtotal_cents, 50_000, "the fixture is the rule: gross = net + discount");
  const total = { total_cents: 45_000 };
  assertEquals(issuePaths(PurchaseSchema, withItems([discounted], total)), []);
  const off = (price: Partial<typeof discounted.price>) => withItems([{ ...discounted, price: { ...discounted.price, ...price } }], total);
  assertEquals(issuePaths(PurchaseSchema, off({ subtotal_discounted_cents: 45_001 })), ["items.1.price.subtotal_discounted_cents"]);
  assertEquals(issuePaths(PurchaseSchema, off({ subtotal_cents: 45_000 })), ["items.1.price.subtotal_cents"]);
  assertEquals(issuePaths(PurchaseSchema, off({ total_cents: 45_001 })), ["items.1.price.total_cents"]);
  const { total_cents: _t, ...missing } = discounted.price;
  assertEquals(issuePaths(PurchaseSchema, withItems([{ ...discounted, price: missing as typeof discounted.price }], total)), [
    "items.1.price.total_cents",
  ]);
});

Deno.test("PurchaseSchema: a buy states its `price` — required since beta B, after the Phase 5 backfill", () => {
  assertEquals(issuePaths(PurchaseSchema, withItems([line()])), []);
  const { price: _p, ...bare } = line();
  assertEquals(issuePaths(PurchaseSchema, withItems([line()], { items: [bare] })), ["items.1.price"]);
});

Deno.test("PurchaseSchema: a supplier discount sits beside the NET amount (ruling 7)", () => {
  const discounted = hireLine({ amount_cents: 45_000, price: { ...flatPrice, discount: { rate: 10, type: "percent", amount_cents: 5_000 } } });
  assertEquals(issuePaths(PurchaseSchema, withItems([discounted])), []);
  assertEquals(purchaseItemCommittedCents(discounted), 45_000, "the committed amount is the net");
});

Deno.test("PurchaseSchema: the retired arms and keys are refused — a hard cutover (ruling 5)", () => {
  const { amount_cents: _a, price: _p, ...bare } = hireLine();
  assertEquals(
    issuePaths(PurchaseSchema, withItems([hireLine()], { items: [{ ...bare, billing: { basis: "fixed", amount_cents: 50_000 } }] })).includes(
      "items.1",
    ),
    true,
  );
  // Built by hand: the mirror derivations THROW on an unknown arm, by design.
  const doc = { ...withItems([freight()]), items: [purchaseDivider(D), { ...freight(), type: "direct" }] };
  assertEquals(issuePaths(PurchaseSchema, doc).includes("items.1.type"), true);
});

Deno.test("the price snapshot is reached by the column walker", () => {
  const columns = new Map(buildFirestoreColumns(PurchaseSchema).map((c) => [c.key, c.label]));
  assertEquals(columns.get("items.price.price_formula.name"), "Item Formula");
  assertEquals(columns.has("items.dates.end"), false, "the hire window is the pair's, not the line's");
  assertEquals(columns.get("items.type"), "Item Type");
});

Deno.test("PurchaseSchema: all three mirrors and `query_by_bills` are required, and each mirror must be exact", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase()), []);
  // `bills`, `credits` and `query_by_credits` since the 6e-0a backfill (ruling 32).
  for (const key of ["query_by_products", "query_by_orders", "query_by_item_types", "query_by_bills", "bills", "credits", "query_by_credits"]) {
    const doc = purchase() as Record<string, unknown>;
    delete doc[key];
    assertEquals(issuePaths(PurchaseSchema, doc), [key]);
  }
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_products: [] })), ["query_by_products"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_products: ["testprod200000000000"] })), ["query_by_products"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine()], { query_by_orders: [] })), ["query_by_orders"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_orders: [ORDER_1074] })), ["query_by_orders"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_item_types: ["rental"] })), ["query_by_item_types"]);
  // The retired document kind is refused outright.
  assertEquals(issuePaths(PurchaseSchema, purchase({ kind: "buy" })), [""]);
});

Deno.test("uid_units: each unit once per line; query_by_units mirrors the subrent and charge lines, optional until the backfill", () => {
  assertEquals(issuePaths(PurchaseServiceItemSchema, freight({ uid_units: ["unit-7"] })), []);
  assertEquals(issuePaths(PurchaseServiceItemSchema, freight({ uid_units: ["unit-7", "unit-7"] })), ["uid_units"]);
  assertEquals(issuePaths(PurchaseRentalItemSchema, hireLine({ uid_units: ["unit-3", "unit-3"] })), ["uid_units"]);
  const { uid_units: _, ...bare } = freight();
  assertEquals(issuePaths(PurchaseServiceItemSchema, bare), ["uid_units"], "required on the stored line (hard cutover, ruling 5)");

  const items: PurchaseItem[] = [line(), hireLine({ uid_units: ["unit-9", "unit-3"] }), freight({ uid_units: ["unit-3", "unit-12"] })];
  assertEquals(deriveQueryByUnits(items), ["unit-12", "unit-3", "unit-9"], "distinct, sorted; a buy names none");
  assertEquals(issuePaths(PurchaseSchema, withItems(items)), [], "absent until the backfill stamps it");
  assertEquals(issuePaths(PurchaseSchema, withItems(items, { query_by_units: deriveQueryByUnits(items) })), []);
  assertEquals(issuePaths(PurchaseSchema, withItems(items, { query_by_units: ["unit-3"] })), ["query_by_units"]);
});

Deno.test("deriveQueryByProducts leaves a charge's attribution out; deriveQueryByOrders reads subrent items only", () => {
  assertEquals(deriveQueryByProducts([freight({ uid_product: "testprod900000000000" })]), []);
  assertEquals(deriveQueryByProducts([carrierLine()]), [], "a carrier line attributes, it does not order");
  assertEquals(
    deriveQueryByOrders([hireLine({ uid_orders: ["a", "b"] }), hireLine({ uid: lid(7), uid_orders: ["b", "c"] }), line()]),
    ["a", "b", "c"],
  );
});

Deno.test("the item-type switches are exhaustive over PURCHASE_ITEM_TYPES", () => {
  // The compile-time half is the `never` default in each switch; this is the
  // runtime half — every member reaches a branch rather than the throw.
  const one: Record<string, PurchaseItem> = {
    sale: line(),
    rental: hireLine(),
    service: freight(),
    replacement: { ...freight(), type: "replacement", out_of_service: [{ uid: "testoos1000000000000", quantity: freight().quantity }] },
  };
  assertEquals(Object.keys(one).sort(), [...PURCHASE_ITEM_TYPES].sort());
  for (const type of PURCHASE_ITEM_TYPES) {
    purchaseItemCommittedCents(one[type]);
    purchaseLineCloseOutcome(one[type], NO_LINE_CUSTODY);
  }
  assertThrows(() => purchaseItemCommittedCents({ ...line(), type: "lease" } as unknown as PurchaseItem));
});

// ── item inputs ──────────────────────────────────────────────────────

const SESSION = "0199a1f2-3b4c-7d8e-9f01-234567890abc";
const PAIR_A = iuid(901);
const PAIR_B = iuid(902);
const GROUP = iuid(903);
const destRow = (uid = PAIR_A) => ({ type: "destination", uid, path: [uid] });
const lineHead = (n: number, pair = PAIR_A) => ({ uid: iuid(n), path: [pair, iuid(n)] });
/** The n-th product's uid. */
const pid = (n: number) => `testprod${String(n).padStart(12, "0")}`;
/** A catalog line's head, keyed by its product (W4K): uid, path leaf and `uid_product` agree. */
const keyedHead = (n: number, pair = PAIR_A) => ({ uid: pid(n), path: [pair, pid(n)], uid_product: pid(n) });
const buyInput = { type: "sale", ...keyedHead(1), quantity: 1, amount_cents: 100 };
const nullDates = { delivery_start: null, delivery_end: null, collection_start: null, collection_end: null, charge_windows: null };
/** A hire in the order's shape (api-cloudrun#1469): possession to `collection_start`, `collection_end` following it. */
const hireDates = {
  ...nullDates,
  delivery_start: HIRE.start,
  delivery_end: HIRE.start,
  collection_start: HIRE.end,
  collection_end: HIRE.end,
  charge_windows: [{ start: HIRE.start, end: HIRE.end }],
};
/** The retired hire shape: `delivery_start` → `collection_end`, the rest null. */
const oldHireDates = { ...nullDates, delivery_start: HIRE.start, collection_end: HIRE.end };
const endpoint = { uid: null };
const pairInput = (over: Record<string, unknown> = {}) => ({ uid: PAIR_A, dates: nullDates, delivery: endpoint, collection: null, ...over });
const createInput = (over: Record<string, unknown> = {}) => ({
  supplier: { uid: SUPPLIER.uid },
  uid_store: "teststore10000000000",
  date: "2026-10-01T00:00:00.000-05:00",
  items: [destRow(), buyInput],
  destinations: [pairInput()],
  uuid_session: SESSION,
  ...over,
});

Deno.test("CreatePurchaseInput: rows of every arm, the same product in two groups, and no kind", () => {
  const items = [
    destRow(),
    buyInput,
    { ...buyInput, ...keyedHead(3), quantity: 2 },
    { type: "rental", ...keyedHead(4), quantity: 10, amount_cents: 50_000 },
    {
      type: "rental",
      ...keyedHead(5),
      quantity: 2,
      price: { uid_price_formula: WEEKLY.uid, rates: weeklyPrice.rates },
    },
    { type: "service", ...lineHead(5), name: "Hotspot line", uid_product: PRODUCT, ledger_account: 5150, price: { uid_price_formula: MONTHLY.uid } },
    { type: "service", ...lineHead(6), name: "Freight", amount_cents: 1_500, ledger_account: 5300, price: { discount: { rate: 10, type: "percent" } } },
    // The same product again, in its own group: one product per group (W4K).
    { type: "group", uid: GROUP, path: [PAIR_A, GROUP], name: "Second" },
    { ...buyInput, path: [PAIR_A, GROUP, pid(1)], quantity: 2 },
  ];
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ items })), []);
});

Deno.test("purchase input: two pairs on one window and a group, parsed through the barrel", () => {
  const items = [
    destRow(PAIR_A),
    { type: "group", uid: GROUP, path: [PAIR_A, GROUP], name: "Camera" },
    { ...buyInput, path: [PAIR_A, GROUP, pid(1)] },
    destRow(PAIR_B),
    { type: "rental", ...keyedHead(2, PAIR_B), quantity: 1, amount_cents: 1 },
  ];
  const destinations = [pairInput({ dates: hireDates }), pairInput({ uid: PAIR_B, dates: hireDates, delivery: { uid: "testdest100000000000" } })];
  const parsed = CreatePurchaseInput.safeParse(createInput({ items, destinations }));
  assert(parsed.success, JSON.stringify(!parsed.success && parsed.error.issues));
  assertEquals(parsed.data.items.map((r) => r.type), ["destination", "group", "sale", "destination", "rental"]);
  assertEquals(parsed.data.destinations.map((d) => d.uid), [PAIR_A, PAIR_B]);
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items, destinations }), []);
});

Deno.test("purchase input: the whole-array rules, one defect at a time", () => {
  // A row is named by its PATH once per write (W4K: a uid is a product's and repeats across groups).
  const twice = [destRow(), buyInput, buyInput];
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ items: twice })), ["items.2.path"]);
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: twice }), ["items.2.path"]);
  // A divider's path counts as well as a line's.
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ items: [destRow(), destRow(), buyInput] })), ["items.1.path"]);
  // One product under two pairs is two rows, not a repeat.
  const twoPairs = [destRow(), buyInput, destRow(PAIR_B), { ...buyInput, ...keyedHead(1, PAIR_B) }];
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: twoPairs }), []);
  // A line ahead of any divider is refused, and that is what refuses an old flat body.
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ items: [buyInput] })), ["items.0.type"]);
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: [buyInput, destRow()] }), ["items.0.type"]);
  // A divider-only body would otherwise fail at write as a 500.
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ items: [destRow()] })), ["items"]);
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: [destRow()] }), ["items"]);
  // `destinations` is required on a create, may not be empty, and is optional on an amend.
  const { destinations: _omitted, ...noPairs } = createInput();
  assertEquals(issuePaths(CreatePurchaseInput, noPairs), ["destinations"]);
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ destinations: [] })), ["destinations"]);
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: [destRow(), buyInput] }), []);
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, destinations: [pairInput()] }), []);
});

Deno.test("purchase row input: a line and a divider each require their identity", () => {
  const { uid: _u, ...noUid } = buyInput;
  const { path: _p, ...noPath } = buyInput;
  assertEquals(issuePaths(PurchaseRowInput, noUid), ["uid"]);
  assertEquals(issuePaths(PurchaseRowInput, noPath), ["path"]);
  assertEquals(issuePaths(PurchaseRowInput, { ...destRow(), uid: "testfirestoreid00000" }), ["uid"]);
  assertEquals(issuePaths(PurchaseRowInput, { type: "group", uid: GROUP, path: [] }), ["path"]);
  assertEquals(issuePaths(PurchaseRowInput, { type: "group", uid: GROUP, path: [GROUP], name: "" }), ["name"]);
  assertEquals(issuePaths(PurchaseRowInput, { type: "group", uid: GROUP, path: [GROUP], name: "x".repeat(101) }), ["name"]);
  assertEquals(issuePaths(PurchaseRowInput, { ...destRow(), name: "x".repeat(201) }), ["name"]);
  // Stripping, as the bill's dividers are: a stray key is dropped, never refused.
  const parsed = PurchaseRowInput.safeParse({ ...destRow(), quantity: 3 });
  assert(parsed.success);
  assertEquals("quantity" in parsed.data, false);
});

Deno.test("purchase row input: a stale line `dates` strips, so only the rest of the body refuses an old client", () => {
  const stale = { type: "rental", ...keyedHead(2), quantity: 1, amount_cents: 1, dates: HIRE };
  const parsed = PurchaseRowInput.safeParse(stale);
  assert(parsed.success);
  assertEquals("dates" in parsed.data, false);
  const { path: _p, uid: _u, ...oldBody } = stale;
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: [oldBody] }).sort(), ["items.0.path", "items.0.uid"]);
});

Deno.test("PurchaseDestinationInput: a hire states both collection bounds or neither, its end after its start", () => {
  assertEquals(issuePaths(PurchaseDestinationInput, pairInput({ dates: hireDates })), []);
  // A standing hire states neither a collection start nor an end, and is legal.
  const standing = { ...hireDates, collection_start: null, collection_end: null, charge_windows: null };
  assertEquals(issuePaths(PurchaseDestinationInput, pairInput({ dates: standing })), []);
  assertEquals(
    issuePaths(PurchaseDestinationInput, pairInput({ dates: { ...hireDates, collection_end: null } })),
    ["dates.collection_end"],
  );
  // The retired hire shape is refused, not translated (api-cloudrun#1469).
  assertEquals(issuePaths(PurchaseDestinationInput, pairInput({ dates: oldHireDates })), ["dates.collection_start"]);
  assertEquals(
    issuePaths(PurchaseDestinationInput, pairInput({ dates: { ...nullDates, delivery_start: HIRE.end, collection_start: HIRE.start, collection_end: HIRE.start } })),
    ["dates.collection_end"],
  );
  assertEquals(
    issuePaths(PurchaseDestinationInput, pairInput({ dates: { ...nullDates, collection_start: HIRE.end, collection_end: HIRE.start } })),
    ["dates.collection_end"],
  );
  const { uid: _u, ...noUid } = pairInput();
  assertEquals(issuePaths(PurchaseDestinationInput, noUid), ["uid"]);
  const { delivery: _d, ...noDelivery } = pairInput();
  assertEquals(issuePaths(PurchaseDestinationInput, noDelivery), ["delivery"]);
  const { collection: _c, ...noCollection } = pairInput();
  assertEquals(issuePaths(PurchaseDestinationInput, noCollection), ["collection"]);
});

Deno.test("PurchaseItemInput: each arm's own requirements, one field at a time", () => {
  const sub = { type: "rental", ...keyedHead(2), quantity: 10, amount_cents: 1 };
  const charge = lineHead(3);
  assertEquals(issuePaths(PurchaseItemInput, sub), []);
  assertEquals(issuePaths(PurchaseItemInput, { ...sub, ledger_account: 1999 }), ["ledger_account"]);
  // A charge's account and name are the operator's: there is no default.
  assertEquals(issuePaths(PurchaseItemInput, { type: "service", ...charge, name: "Freight", amount_cents: 1 }), ["ledger_account"]);
  assertEquals(issuePaths(PurchaseItemInput, { type: "service", ...charge, amount_cents: 1, ledger_account: 5300 }), ["name"]);
  assertEquals(issuePaths(PurchaseItemInput, { ...sub, price: { discount: { rate: 101, type: "percent" } } }), ["price.discount.rate"]);
  assertEquals(issuePaths(PurchaseItemInput, { ...buyInput, ledger_account: 5100 }), ["ledger_account"]);
  // Non-strict: an extra key strips rather than 400s (core/CLAUDE.md § Document vs input).
  const parsed = PurchaseItemInput.safeParse({ ...buyInput, quantity_received: 3 });
  assert(parsed.success);
  assertEquals("quantity_received" in parsed.data, false);
});

Deno.test("ClosePurchaseInput / ReceivePurchaseInput / ReturnPurchaseInput name ITEMS, each once", () => {
  assertEquals(issuePaths(ClosePurchaseInput, { path_purchase_items: [[iuid(1)]], uuid_session: SESSION, version: 0 }), []);
  const r = { path_purchase_item: [iuid(1)], quantity: 1 };
  const receive = { date: "2026-10-05T10:00:00.000-05:00", lines: [r, r], uuid_session: SESSION, version: 0 };
  assertEquals(issuePaths(ReceivePurchaseInput, receive), ["lines.1.path_purchase_item"]);
  assertEquals(issuePaths(ReceivePurchaseInput, { ...receive, lines: [r, { ...r, path_purchase_item: [iuid(2)] }] }), []);
  assertEquals(issuePaths(ReturnPurchaseInput, { ...receive, lines: [r, r] }), ["lines.1.path_purchase_item"]);
  // W4K: a line's uid is its product's, so one uid under two pairs is two items, named by path.
  const twoPairs = [{ path_purchase_item: [iuid(1), PRODUCT_UID_W4K], quantity: 1 }, { path_purchase_item: [iuid(2), PRODUCT_UID_W4K], quantity: 1 }];
  assertEquals(issuePaths(ReceivePurchaseInput, { ...receive, lines: twoPairs }), []);
  assertEquals(issuePaths(ClosePurchaseInput, { path_purchase_items: [[]], version: 0 }), ["path_purchase_items.0"]);
  // A body naming only the retired key is stripped, then refused for the missing path.
  assertEquals(issuePaths(ReceivePurchaseInput, { ...receive, lines: [{ uid_item: iuid(1), quantity: 1 }] }), ["lines.0.path_purchase_item"]);
});

const PRODUCT_UID_W4K = "ePJgrlQYm5AEoKUpVcYz";

Deno.test("ReceivePurchaseInput: allocations sum to the quantity, and named units are exactly `quantity`, ascending", () => {
  const receive = (l: Record<string, unknown>) => ({
    date: "2026-10-05T10:00:00.000-05:00",
    lines: [{ path_purchase_item: [iuid(1)], quantity: 2, ...l }],
    uuid_session: SESSION,
    version: 0,
  });
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ allocations: [{ uid_location: "testloc1000000000000", quantity: 1 }] })), [
    "lines.0.quantity",
  ]);
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ units: [{ number: 1 }] })), ["lines.0.units"]);
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ units: [{ number: 2 }, { number: 1 }] })), ["lines.0.units.1"]);
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ units: [{ number: 1, serial_number: "SN1" }, { number: 2 }] })), []);
});

Deno.test("ReturnPurchaseInput: allocations sum to the quantity; units only with the line's own units", () => {
  const ret = (lineOver: Record<string, unknown>) => ({
    date: "2026-10-25T10:00:00.000-05:00",
    lines: [{ path_purchase_item: [iuid(2)], quantity: 10, ...lineOver }],
    uuid_session: SESSION,
    version: 3,
  });
  assertEquals(issuePaths(ReturnPurchaseInput, ret({})), []);
  assertEquals(issuePaths(ReturnPurchaseInput, ret({ allocations: [{ uid_location: "testloc1000000000000", quantity: 9 }] })), [
    "lines.0.quantity",
  ]);
  assertEquals(
    issuePaths(ReturnPurchaseInput, ret({ quantity: 1, allocations: [{ uid_location: "testloc1000000000000", quantity: 1, units: [4] }] })),
    ["lines.0.allocations"],
    "an allocation naming units the line does not name",
  );
});

Deno.test("ReturnPurchaseInput: a serialized subrent return names its units by number (serialized-subrent § 5)", () => {
  const ret = (lineOver: Record<string, unknown>) => ({
    date: "2026-10-25T10:00:00.000-05:00",
    lines: [{ path_purchase_item: [iuid(2)], quantity: 2, ...lineOver }],
    uuid_session: SESSION,
    version: 3,
  });
  const units = [{ number: 3004 }, { number: 3007 }];
  assertEquals(issuePaths(ReturnPurchaseInput, ret({ units })), []);
  assertEquals(
    issuePaths(ReturnPurchaseInput, ret({
      units,
      allocations: [{ uid_location: "testloc1000000000000", quantity: 2, units: [3004, 3007] }],
    })),
    [],
  );
  assertEquals(issuePaths(ReturnPurchaseInput, ret({ units: [{ number: 3004 }] })), ["lines.0.units"]);
  assertEquals(issuePaths(ReturnPurchaseInput, ret({ units: [{ number: 3007 }, { number: 3004 }] })), ["lines.0.units.1"]);
  assertEquals(
    issuePaths(ReturnPurchaseInput, ret({ units: [{ number: 3004, serial_number: "IMEI" }, { number: 3007 }] })),
    ["lines.0.units.0.serial_number"],
  );
});

// ── bills ────────────────────────────────────────────────────────────

const XERO_ID = "384eb64a-0000-4000-8000-000000000000";

/** The purchase every fixture bill and credit bills, and its `purchase` divider. */
const P = "testpurch10000000000";
const scope = { uid: P, type: "purchase", name: "PO-1", path: [P], description: "" };
/** The purchase's destination divider as it sits on a bill: `[P, D]`. */
const docDivider = { ...purchaseDivider(D), path: [P, D] };
/** A bill's or credit's pair for `D`, scoped to the purchase. */
const docPair = { uid_purchase: P, ...purchasePair(D) };

/**
 * A bill product item billing PO item `iuid(1)` — AT its path under the
 * purchase divider, with its uid (one-document-model Phase 3).
 */
const billItem = (over: Record<string, unknown> = {}) => {
  const uid = (over.uid as string | undefined) ?? lid(1);
  return withPayableMoney({
    type: "sale",
    uid,
    path: [P, D, uid],
    description: "",
    zero_priced: null,
    name: "Walkie Talkie",
    uid_product: uid,
    quantity: 3,
    amount_cents: 140985,
    price: { ...flatPrice, counts: [] },
    ledger_account: 1999,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    ...over,
  });
};

/** A bill charge item — document-only: at a path the purchase does not carry. */
const billDirect = (over: Record<string, unknown> = {}) => {
  const uid = (over.uid as string | undefined) ?? `custom-${lid(201)}`;
  return withPayableMoney({
    type: "service",
    uid,
    path: [P, D, uid],
    description: "",
    zero_priced: null,
    name: "Freight",
    quantity: 1,
    amount_cents: 1500,
    ledger_account: 5100,
    uid_tracking_category: null,
    uid_tax_class: TAX_CLASS,
    price: { ...flatPrice, counts: [] },
    ...over,
  });
};

/**
 * A bill whose `items` are the given LINES under the purchase and destination
 * dividers; `over.rows` replaces the whole array.
 */
function bill(over: Record<string, unknown> = {}) {
  const { items: lines = [billItem()], rows, ...rest } = over as { items?: unknown[]; rows?: unknown[] };
  return {
    uid: "testbill100000000000",
    number: 1,
    status: "issued",
    query_by_purchases: [P],
    number_purchases: [1],
    supplier: SUPPLIER,
    origin: "pushed",
    xero_document: "invoice",
    xero_id: null,
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    due_date: "2026-10-31T00:00:00.000-05:00",
    subject: "",
    reference: "INV-55",
    items: rows ?? [scope, docDivider, ...lines],
    destinations: [docPair],
    totals: {
      total_cents: 140985,
      amount_paid_cents: 0,
      amount_credited_cents: 0,
      amount_void_cents: 0,
      amount_due_cents: 140985,
    },
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...rest,
  };
}

const T_WITH_FREIGHT = { total_cents: 142485, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 142485 };

Deno.test("PurchaseBillSchema accepts a pushed ACCPAY, a linked ACCPAY and a card payment born paid", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill()), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ origin: "linked", xero_id: XERO_ID })), []);
  assertEquals(
    issuePaths(
      PurchaseBillSchema,
      bill({
        origin: "linked",
        xero_document: "bank_transaction",
        xero_id: XERO_ID,
        due_date: null,
        status: "paid",
        totals: { total_cents: 140985, amount_paid_cents: 140985, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0 },
      }),
    ),
    [],
  );
});

Deno.test("PurchaseBillSchema: a PUSHED bill's total is its items'; a LINKED bill's is Xero's and exempt", () => {
  const off = { total_cents: 141000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 141000 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ totals: off })), ["totals.total_cents"]);
  // P0: 21 of 299 historic documents disagree with the CFS basis — linking
  // them must not be refused.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ totals: off, origin: "linked", xero_id: XERO_ID })), []);
});

Deno.test("PurchaseBillSchema: direct items count toward a pushed total, in the same array", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem(), billDirect()], totals: T_WITH_FREIGHT })), []);
});

Deno.test("PurchaseBillSchema: a bill of only document-only charge items parses — a historic Vision bill (D5)", () => {
  const t = { total_cents: 1500, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 1500 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billDirect()], totals: t })), []);
});

Deno.test("PurchaseBillSchema: a replacement item names its record (a mark_lost MovementId parses); a service item names none", () => {
  const movementId = "0199a1f2-3b4c-7d8e-9f01-234567890abc|mark_lost|testordr100000000000:testitem10000000000x:9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48";
  // Keyed by the lost rental's twin, which it names (W4K, ruling 15).
  const loss = billDirect({
    type: "replacement",
    uid: PRODUCT,
    name: "Loss charge — steamer",
    uid_product: PRODUCT,
    uid_tracking_category: "testtrack10000000000",
    out_of_service: [{ uid: movementId, quantity: 1 }],
  });
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem(), loss], totals: T_WITH_FREIGHT })), []);
  // The record is what makes it a replacement: required there…
  const { out_of_service: _r, ...unnamed } = loss as Record<string, unknown>;
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem(), unnamed], totals: T_WITH_FREIGHT })), [
    "items.3.out_of_service",
  ]);
  // …and refused on a service line, which the strict arm does not declare it on.
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ items: [billItem(), billDirect({ out_of_service: [{ uid: movementId, quantity: 1 }] })], totals: T_WITH_FREIGHT })),
    ["items.3"],
  );
});

Deno.test("PurchaseBillSchema: a line sits AT the purchase line it bills; `path_purchase_item` is only a move pointer (one-document-model Phase 3)", () => {
  // At its own path: no pointer.
  assertEquals(issuePaths(PurchaseBillSchema, bill()), []);
  // A pointer, when stated, names a non-empty path.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem({ path_purchase_item: [] })] })), ["items.2.path_purchase_item"]);
  // A moved row — billing PO line 4 from another position — is legal.
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ items: [billItem(), billDirect({ path_purchase_item: [D, iuid(4)] })], totals: T_WITH_FREIGHT })),
    [],
  );
});

Deno.test("PurchaseBillSchema: several rows may bill one purchase line (a split); row identity is the path", () => {
  const linked = { origin: "linked", xero_id: XERO_ID };
  // Two rows at one path.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem(), billItem()] })), ["items.3.path"]);
  // Two rows of ONE product billing two purchase lines is fine (D2).
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem(), billItem({ uid: lid(9) })] })), []);
  // A moved row billing the line another row bills at its own path: a split.
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem(), billItem({ uid: lid(9), path_purchase_item: [D, iuid(1)] })] })),
    [],
  );
  // Two moved rows billing one line.
  assertEquals(
    issuePaths(
      PurchaseBillSchema,
      bill({ ...linked, items: [billItem({ uid: lid(8), path_purchase_item: [D, iuid(7)] }), billItem({ uid: lid(9), path_purchase_item: [D, iuid(7)] })] }),
    ),
    [],
  );
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem({ path: [P, D, iuid(9)] })] })), ["items.2.path"]);
  // `.min(1)` and the value rule both name `items`; either is the refusal.
  assertEquals(
    [...new Set(issuePaths(PurchaseBillSchema, bill({ ...linked, rows: [], destinations: [], query_by_purchases: [], number_purchases: [] })))],
    ["items"],
  );
  assertEquals([...new Set(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [] })))], ["items"]);
});

Deno.test("PurchaseBillSchema: a purchase-linked bill leads with its purchase divider, and its mirrors name the dividers", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill({ rows: [docDivider, scope, billItem()] })).includes("items.0.type"), true);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ query_by_purchases: [], number_purchases: [] })), ["query_by_purchases"]);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ number_purchases: [] })), ["number_purchases"]);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ uid_purchase: P })), [""], "the retired key is refused");
  // A charge-only bill with no purchase: no dividers, no mirrors.
  const t = { total_cents: 1500, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 1500 };
  const loose = billDirect({ path: [`custom-${lid(201)}`] });
  assertEquals(issuePaths(PurchaseBillSchema, bill({ rows: [loose], destinations: [], query_by_purchases: [], number_purchases: [], totals: t })), []);
});

Deno.test("PurchaseBillSchema: a bill item posts within its type's class, linked or pushed (owner, 2026-11-07)", () => {
  const linked = (items: unknown[]) => bill({ origin: "linked", xero_id: XERO_ID, items });
  // A sale (Buy): an asset account, or a TEMPORARY de minimis expense account.
  for (const code of [1400, 1999, 6204, 6300, 6500]) {
    assertEquals(issuePaths(PurchaseBillSchema, linked([billItem({ ledger_account: code })])), [], String(code));
  }
  // 6000 was a mis-coding the owner recodes; it is not in the set.
  for (const code of [6000, 6100, 5100]) {
    assertEquals(issuePaths(PurchaseBillSchema, linked([billItem({ ledger_account: code })])), ["items.2.ledger_account"], String(code));
  }
  // A rental (Subrent): a Direct Costs account.
  assertEquals(issuePaths(PurchaseBillSchema, linked([billItem({ type: "rental", ledger_account: 5100 })])), []);
  assertEquals(issuePaths(PurchaseBillSchema, linked([billItem({ type: "rental", ledger_account: 1999 })])), ["items.2.ledger_account"]);
  // A service (Charge): any account.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem(), billDirect({ ledger_account: 6100 })], totals: T_WITH_FREIGHT })), []);
});

Deno.test("PurchaseBillSchema: paid + credited + void + due must equal total", () => {
  const t = { total_cents: 140985, amount_paid_cents: 100, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 140985 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ status: "part_paid", totals: t })), ["totals"]);
});

Deno.test("PurchaseBillSchema: a linked bill names its Xero document", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill({ origin: "linked" })), ["xero_id"]);
});

Deno.test("PurchaseBillSchema: a bank transaction is linked, never pushed, and due on nothing", () => {
  const spend = { origin: "linked", xero_document: "bank_transaction", xero_id: XERO_ID, due_date: null };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...spend, origin: "pushed" })), ["origin"]);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...spend, due_date: "2026-10-31T00:00:00.000-05:00" })), ["due_date"]);
});

Deno.test("PurchaseBillSchema: due_date_fs is a mirror — absent until backfilled, never beside a null due_date", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill()), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date_fs: mockTimestamp })), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date: null })), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date: null, due_date_fs: null })), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date: null, due_date_fs: mockTimestamp })), ["due_date_fs"]);
});

Deno.test("CreatePurchaseBillInput: items by path_purchase_item, charge items separately; a purchase item once", () => {
  const items = [{ path_purchase_item: [iuid(1)], quantity: 3 }];
  const common = { items, uuid_session: SESSION, version: 0 };
  const push = { mode: "push", date: "2026-10-01T00:00:00.000-05:00", due_date: "2026-10-31T00:00:00.000-05:00" };
  assertEquals(issuePaths(CreatePurchaseBillInput, { ...push, ...common }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { mode: "link", xero_document: "bank_transaction", xero_id: XERO_ID, ...common }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { mode: "push", date: "2026-10-01T00:00:00.000-05:00", ...common }), ["due_date"]);
  assertEquals(
    issuePaths(CreatePurchaseBillInput, { mode: "link", xero_document: "invoice", xero_id: XERO_ID, ...common, items: [items[0], items[0]] }),
    ["items.1.path_purchase_item"],
  );
  // A push of charge items alone is a bill; a push of nothing is not.
  const fee = { name: "Freight", ledger_account: 5100, amount_cents: 1500 };
  assertEquals(issuePaths(CreatePurchaseBillInput, { ...push, ...common, items: [], charge_items: [fee] }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { ...push, ...common, items: [] }), ["items"]);
});

Deno.test("a charge item input stays STRICT inside the push input — an unknown key is a 400, not dropped", () => {
  // The fail-closed half of keeping the node strict: an api predating a field
  // must refuse it rather than store an item with the attribution stripped.
  const push = (d: Record<string, unknown>) =>
    CreatePurchaseBillInput.safeParse({
      mode: "push",
      date: "2026-10-25T00:00:00.000-05:00",
      due_date: "2026-11-24T00:00:00.000-06:00",
      items: [{ path_purchase_item: [iuid(1)], quantity: 1 }],
      charge_items: [d],
      uuid_session: SESSION,
      version: 0,
    });
  const charge = { name: "Loss charge", ledger_account: 5100, amount_cents: 1500, uid_product: PRODUCT };
  assertEquals(push(charge).success, true, "the otherwise-valid payload parses, so the refusal below is the key alone");
  const r = push({ ...charge, uid_product_typo: "x" });
  assertEquals(
    r.success ? [] : r.error.issues.map((i) => `${i.code}:${i.path.join(".")}`),
    ["unrecognized_keys:charge_items.0"],
  );
});

// ── bill time lines (Phase 2 rulings 4, 8) ───────────────────────────

/** A pushed bill's TIME line: two Vision hotspots, one 5-night window each, one week apiece at $45. */
const billTimeLine = (over: Record<string, unknown> = {}) =>
  billItem({
    type: "rental",
    uid: lid(2),
    name: "Hotspot",
    ledger_account: 5100,
    quantity: 2,
    amount_cents: 9000,
    price: { ...weeklyPrice, counts: [{ rate_key: "month", num: 0, den: 1 }, { rate_key: "week", num: 2, den: 1 }] },
    ...over,
  });
const t9000 = { total_cents: 9000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 9000 };

Deno.test("PurchaseBillSchema: a TIME line states its amount; a PUSHED one states the counts it bills (Phase 3)", () => {
  for (const origin of ["pushed", "linked"] as const) {
    const doc = bill({ origin, xero_id: origin === "linked" ? XERO_ID : null, items: [billTimeLine()], totals: t9000 });
    assertEquals(issuePaths(PurchaseBillSchema, doc), [], origin);
  }
  const uncounted = billTimeLine({ price: { ...weeklyPrice, counts: [] } });
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [uncounted], totals: t9000 })), ["items.2.price.counts"]);
  // A linked line's money is Xero's; its counts are what the link could read.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ origin: "linked", xero_id: XERO_ID, items: [uncounted], totals: t9000 })), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billTimeLine({ price: { ...weeklyPrice, counts: [{ rate_key: "week", num: 2, den: 1 }], rates: [] } })], totals: t9000 })), [
    "items.2.price.rates",
  ]);
});

Deno.test("PurchaseBillSchema: a bill line's price money is what its stated amount gives, linked as well as pushed", () => {
  const discounted = billItem({ amount_cents: 140985, price: { ...flatPrice, counts: [], discount: { rate: 5, type: "percent", amount_cents: 7420 } } });
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [discounted] })), []);
  const stale = { ...discounted, price: { ...(discounted.price as Record<string, unknown>), subtotal_discounted_cents: 140984 } };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [stale] })), ["items.2.price.subtotal_discounted_cents"]);
  // A linked line's amount is Xero's; its money still follows from it.
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ origin: "linked", xero_id: XERO_ID, items: [stale] })),
    ["items.2.price.subtotal_discounted_cents"],
  );
});

Deno.test("PurchaseBillSchema: a flat line meters nothing", () => {
  const flat = billItem({ price: { ...flatPrice, counts: [{ rate_key: "week", num: 1, den: 1 }] } });
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [flat] })), ["items.2.price.counts"]);
});

Deno.test("PurchaseBillSchema: every line states `price`; `units` and `dates` are retired (one-document-model Phase 3)", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill()), []);
  const { price: _bp, ...unpriced } = billItem();
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [unpriced] })), ["items.2.price"]);
  // A line meters its PAIR's windows; per-unit windows and a line span are refused.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [{ ...billItem(), units: [] }] })), ["items.2"]);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [{ ...billItem(), dates: null }] })), ["items.2"]);
});

// ── bill freeze (D10) ────────────────────────────────────────────────

Deno.test("invoiceIsFrozen on a bill: money settled ≠ 0, by VALUE — reversed to zero unfreezes; xero_id is no term", () => {
  const t = (over: Record<string, number>, status: "issued" | "void" = "issued") => ({ status, totals: { ...bill().totals, ...over } });
  assertEquals(invoiceIsFrozen(t({})), false);
  assertEquals(invoiceIsFrozen({ ...t({}), xero_id: XERO_ID } as never), false);
  assertEquals(invoiceIsFrozen(t({ amount_paid_cents: 1, amount_due_cents: 140984 })), true);
  assertEquals(invoiceIsFrozen(t({ amount_credited_cents: 1, amount_due_cents: 140984 })), true);
  assertEquals(invoiceIsFrozen(t({ amount_void_cents: 140985, amount_due_cents: 0 }, "void")), true);
  assertEquals(invoiceIsFrozen(t({}, "void")), true, "a $0 void settles no money");
});

Deno.test("INVOICE_FIELD_FREEZE on a bill: tracking freezes only on void and is the one class Xero takes once settled", () => {
  const paid = { status: "paid" as const, totals: { ...bill().totals, amount_paid_cents: 140985, amount_due_cents: 0 } };
  const voided = { status: "void" as const, totals: { ...bill().totals, amount_void_cents: 140985, amount_due_cents: 0 } };
  const open = { status: "issued" as const, totals: bill().totals };
  const frozenOn = (b: typeof open | typeof paid | typeof voided) => INVOICE_FIELD_CLASSES.filter((c) => invoiceFieldIsFrozen(b, c));
  assertEquals(frozenOn(open), []);
  assertEquals(frozenOn(paid), ["counterparty", "date", "line_money", "ledger_account"]);
  assertEquals(frozenOn(voided), ["counterparty", "date", "line_money", "ledger_account", "tracking"]);
  assertEquals(INVOICE_FIELD_CLASSES.filter((c) => INVOICE_FIELD_FREEZE[c].xero_accepts_on_settled), ["tracking"]);
});

Deno.test("classifySharedFields(PurchaseSchema, bill/credit) is fail-closed — every shared key is declared (D5)", () => {
  for (const downstream of [PurchaseBillSchema, PurchaseCreditSchema]) {
    const c = classifySharedFields(PurchaseSchema, downstream);
    assertEquals(c.unhandled, []);
    assertEquals(c.undeclared, []);
    assertEquals(c.rows, ["items[]", "destinations[]"]);
  }
  const kinds = Object.fromEntries(classifySharedFields(PurchaseSchema, PurchaseBillSchema).fields.map((f) => [f.path, f.kind]));
  // The posting, the labels and the price TERMS follow (D5, `syncPurchaseToBills`):
  // the formula snapshot whole, the rates as one value, the discount's terms.
  assertEquals(kinds["items[].ledger_account"], "propagated");
  assertEquals(kinds["items[].uid_tracking_category"], "propagated");
  assertEquals(kinds["items[].name"], "propagated");
  assertEquals(kinds["items[].price.price_formula"], "atom");
  assertEquals(kinds["items[].price.rates"], "propagated");
  assertEquals(kinds["items[].price.discount.rate"], "propagated");
  assertEquals(kinds["items[].price.discount.type"], "propagated");
  // Re-derived on the bill, never compared: a bill's share of a discount is its own.
  assertEquals(kinds["items[].price.discount.amount_cents"], "derived");
  // `quantity` and `amount_cents` follow as ONE group (owner, 2026-11-07;
  // one-document-model Phase 3): an untouched line follows both, an edited one
  // keeps both. `counts` is bill-only; the line `dates` and `units` are retired.
  const fields = classifySharedFields(PurchaseSchema, PurchaseBillSchema).fields;
  const group = (path: string) => fields.find((f) => f.path === path)?.group;
  assertEquals(kinds["items[].quantity"], "propagated");
  assertEquals(kinds["items[].amount_cents"], "propagated");
  assertEquals(group("items[].quantity"), "flat_money");
  assertEquals(group("items[].amount_cents"), "flat_money");
  assertEquals(kinds["items[].dates"], undefined);
  assertEquals(kinds["items[].units"], undefined);
  assertEquals(kinds["items[].price.counts"], undefined);
  // The pair follows as the order's does.
  assertEquals(kinds["destinations[].delivery"], "atom");
  assertEquals(kinds["destinations[].dates.delivery_start"], "propagated");
  assertEquals(kinds["supplier"], "atom");
});

// ── supplier credits ─────────────────────────────────────────────────

function credit(over: Record<string, unknown> = {}) {
  const { items: lines = [billItem({ quantity: 1, amount_cents: 46995 })], ...rest } = over as { items?: unknown[] };
  return {
    uid: "testcred100000000000",
    number: 1,
    sources: [{ collection: "purchases", uid: P }],
    query_by_sources: [`purchases:${P}`],
    supplier: SUPPLIER,
    origin: "pushed",
    reason: "supplier_adjustment",
    status: "issued",
    xero_id: null,
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    reference: null,
    items: lines.length === 0 ? [] : asCreditRows([scope, docDivider, ...lines] as { type: string }[]),
    destinations: lines.length === 0 ? [] : [docPair],
    total_cents: 46995,
    remaining_credit_cents: 46995,
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...rest,
  };
}

Deno.test("a $0 bill closes and reopens as a count", () => {
  const close = { type: "bill_closure" as const, reason: "zero_total" as const, amount_cents: 0 };
  const reopen = { type: "bill_closure_reversal" as const, reason: "source_retracted" as const, amount_cents: 0 };
  const count = (rows: (typeof close | typeof reopen)[]) => recomputePurchaseBillTotals(0, rows).closure_count;
  assertEquals([count([close]), count([close, reopen]), count([close, reopen, close])], [1, 0, 1]);
  const zero = (closure_count: number, status: "issued" | "paid") =>
    bill({
      status,
      totals: { total_cents: 0, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0, closure_count },
    });
  assertEquals(deriveInvoiceStatus(zero(1, "issued") as never), "paid");
  assertEquals(deriveInvoiceStatus(zero(0, "paid") as never), "issued");
  assertEquals(invoiceIsFrozen(zero(1, "paid") as never), true, "a closed bill freezes as a paid one does");
  assertEquals(invoiceIsFrozen(zero(0, "issued") as never), false, "reopening unfreezes, with no flag");
});

Deno.test("PurchaseBillSchema: the stored status is the derivation's, and void is what the stamp and the money say", () => {
  const paths = (over: Record<string, unknown>) => issuePaths(PurchaseBillSchema, bill(over)).filter((p) => p === "status");
  assertEquals(paths({}), []);
  assertEquals(paths({ status: "paid" }), ["status"], "nothing is settled");
  assertEquals(paths({ status: "draft" }).length > 0, true, "a bill has no draft step");
  assertEquals(paths({ status: "void" }), ["status"], "void with no stamp and no void money");
  assertEquals(paths({ voided_at: mockTimestamp }), ["status"], "a stamp with a live status");
  assertEquals(paths({ status: "void", voided_at: mockTimestamp }), []);
  const closedOwing = bill({ totals: { ...bill().totals, closure_count: 1 } });
  assertEquals(issuePaths(PurchaseBillSchema, closedOwing), ["totals.closure_count"]);
});

Deno.test("PurchaseCreditSchema: sources are derived from the lines; a line names a bill line with both keys or neither", () => {
  const BILL = "testbill100000000000";
  const named = billItem({ quantity: 1, amount_cents: 46995, uid_purchase_bill: BILL, path_bill_item: billItem().path });
  const sources = derivePurchaseCreditSources(P, [named] as never);
  assertEquals(sources.query_by_sources, [`purchases:${P}`, `purchase-bills:${BILL}`]);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [named], ...sources })), []);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [named] })).includes("query_by_sources"), true, "the bill is missing from the mirror");
  const half = billItem({ quantity: 1, amount_cents: 46995, uid_purchase_bill: BILL });
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [half], ...sources })).some((p) => p.endsWith("path_bill_item")), true);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ sources: [], query_by_sources: [] })).includes("sources"), true);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [named] })).includes("items"), true, "a bill line credits nothing");
});

Deno.test("reverses_billing: every supplier credit LINE row states it; a bill line refuses it (ruling 84, beta B)", () => {
  const creditLine = (v: boolean) => billItem({ quantity: 1, amount_cents: 46995, reverses_billing: v });
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [creditLine(true)] })), [], "control: true");
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [creditLine(false)] })), [], "control: false");
  // Absent is refused at the row's own key — on the line only, never on a divider.
  const absent = credit({ items: [creditLine(true)] });
  const bare: Record<string, unknown> = { ...(absent.items[2] as Record<string, unknown>) };
  delete bare.reverses_billing;
  absent.items[2] = bare as unknown as typeof absent.items[2];
  assertEquals(issuePaths(PurchaseCreditSchema, absent), ["items.2.reverses_billing"]);
  // A kit header is a line row too: the writer stamps it, so the refine requires it.
  const header = credit({ items: [creditLine(true)] });
  const headerRow: Record<string, unknown> = { ...(header.items[2] as Record<string, unknown>), ledger_account: null };
  delete headerRow.reverses_billing;
  header.items[2] = headerRow as unknown as typeof header.items[2];
  assertEquals(issuePaths(PurchaseCreditSchema, header).includes("items.2.reverses_billing"), true, "a bare kit header is refused");
  // Each line arm carries it, not just the product arm.
  const freight = billDirect({ name: "Freight credit", ledger_account: 5000, amount_cents: 2000, reverses_billing: false });
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [freight], total_cents: 2000, remaining_credit_cents: 2000 })), []);
  // A bill line refuses it either way, at the row's own key; `false` is refused too.
  assertEquals(issuePaths(PurchaseBillSchema, bill()), [], "control");
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem({ reverses_billing: true })] })), ["items.2.reverses_billing"]);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem({ reverses_billing: false })] })), ["items.2.reverses_billing"]);
  // A non-boolean is a type error on either document.
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [billItem({ quantity: 1, amount_cents: 46995, reverses_billing: "yes" })] })).length > 0, true);
  // The form seed omits it, so a seeded bill line is not born refused.
  assertEquals("reverses_billing" in (getInitialValues(PurchaseDocumentProductItemSchema) as object), false);
});

Deno.test("W4K contract: every stored payable line is keyed by its product, or custom- — on a purchase, a bill and a credit", () => {
  const minted = iuid(77);
  // A purchase: each arm's refine, at the line's own `uid`.
  assertEquals(issuePaths(PurchaseSchema, withItems([line()])), [], "control");
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ uid: minted, path: [D, minted], uid_product: lid(1) })])), ["items.1.uid"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ uid: lid(1), path: [D, lid(1)], uid_product: lid(2) })])), ["items.1.uid"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([freight({ uid: minted, path: [D, minted] })])), ["items.1.uid"], "a service is custom-");
  // A bill and a credit: the document-level line rules, at `items.N.uid`.
  assertEquals(issuePaths(PurchaseBillSchema, bill()), [], "control");
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem({ uid_product: lid(2) })] })), ["items.2.uid"]);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [billItem({ quantity: 1, amount_cents: 46995, uid_product: lid(2) })] })), ["items.2.uid"]);
});

Deno.test("PurchaseCreditSchema accepts an issued credit and an applied one", () => {
  assertEquals(issuePaths(PurchaseCreditSchema, credit()), []);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ status: "applied", remaining_credit_cents: 0 })), []);
});

Deno.test("PurchaseCreditSchema: applied IS remaining === 0, both directions; a void strands the balance", () => {
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ status: "applied" })), ["remaining_credit_cents"]);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ remaining_credit_cents: 0 })), ["status"]);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ status: "void" })), []);
});

Deno.test("PurchaseCreditSchema: remaining credit lies within [0, total]", () => {
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ remaining_credit_cents: 46996 })), ["remaining_credit_cents"]);
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ remaining_credit_cents: -1 })), ["remaining_credit_cents"]);
});

Deno.test("PurchaseCreditSchema: a rebate may carry only charge items, but a credit with value names one", () => {
  const rebate = billDirect({ name: "Volume rebate", ledger_account: 5000, amount_cents: 2000 });
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ items: [rebate], total_cents: 2000, remaining_credit_cents: 2000 })), []);
  // Linked, so the pushed-total rule stays out of it and the ONE issue is this one.
  assertEquals(
    issuePaths(PurchaseCreditSchema, credit({ items: [], origin: "linked", xero_id: XERO_ID, total_cents: 2000, remaining_credit_cents: 2000 })),
    ["items"],
  );
});

Deno.test("PurchaseCreditSchema: a PUSHED credit's total is its items', at the credit's own total_cents", () => {
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ total_cents: 47000, remaining_credit_cents: 47000 })), ["total_cents"]);
});

Deno.test("CreatePurchaseCreditInput: a pushed credit names an item or a direct item", () => {
  const base = { mode: "push", reason: "supplier_adjustment", date: "2026-10-01T00:00:00.000-05:00", uuid_session: SESSION, version: 0 };
  assertEquals(issuePaths(CreatePurchaseCreditInput, { ...base, items: [] }), ["items"]);
  assertEquals(issuePaths(CreatePurchaseCreditInput, { ...base, items: [{ path_purchase_item: [iuid(1)], quantity: 1 }] }), []);
});

Deno.test("CreatePurchaseCreditInput: a line names a purchase item OR a bill line, and each credited row once (6d, ruling 23)", () => {
  const base = { mode: "push", reason: "supplier_adjustment", date: "2026-10-01T00:00:00.000-05:00", uuid_session: SESSION, version: 0 };
  const P = "testpurch10000000000";
  const billA = "testbillA0000000000a";
  const billB = "testbillB0000000000b";
  const issues = (items: unknown[]) => issuePaths(CreatePurchaseCreditInput, { ...base, items });
  // A bill line alone is enough: the writer derives the purchase line from the row.
  assertEquals(issues([{ uid_purchase_bill: billA, path_bill_item: [P, iuid(1)], quantity: 1 }]), []);
  // An older client sending both still parses.
  assertEquals(issues([{ path_purchase_item: [iuid(1)], uid_purchase_bill: billA, path_bill_item: [P, iuid(1)], quantity: 1 }]), []);
  // Neither: refused at the purchase item, by name.
  assertEquals(issues([{ quantity: 1 }]), ["items.0.path_purchase_item"]);
  // Half a bill line: one issue, the pairing one, not a second "names nothing".
  assertEquals(issues([{ uid_purchase_bill: billA, quantity: 1 }]), ["items.0.path_bill_item"]);
  // Two bills' lines at ONE path would store one credit row twice.
  assertEquals(
    issues([
      { uid_purchase_bill: billA, path_bill_item: [P, iuid(1)], quantity: 1 },
      { uid_purchase_bill: billB, path_bill_item: [P, iuid(1)], quantity: 1 },
    ]),
    ["items.1.path_bill_item"],
  );
  // A purchase-line item and a bill line resolving to the same row collide too.
  assertEquals(
    issues([{ path_purchase_item: [iuid(1)], quantity: 1 }, { uid_purchase_bill: billA, path_bill_item: [P, iuid(1)], quantity: 1 }]),
    ["items.1.path_bill_item"],
  );
  // Two rows of one split purchase line sit at different paths: one write.
  assertEquals(
    issues([
      { uid_purchase_bill: billA, path_bill_item: [P, iuid(1)], quantity: 1 },
      { uid_purchase_bill: billA, path_bill_item: [P, iuid(7), iuid(1)], quantity: 1 },
    ]),
    [],
  );
  // A link names no bill line, so it still names its purchase item.
  const link = { mode: "link", reason: "supplier_adjustment", xero_id: "2c3d4e5f-0000-4000-8000-000000000001", uuid_session: SESSION, version: 0 };
  assertEquals(issuePaths(CreatePurchaseCreditInput, { ...link, items: [{ quantity: 1 }] }), ["items.0.path_purchase_item"]);
});

// ── pack expansion (api-cloudrun#1081) ───────────────────────────────

/** A catalog component row, shaped as prod stores them (`path` names the parent chain). */
function comp(
  uid: string,
  path: string[],
  quantity: number,
  stock_method: PurchaseExpansionComponent["stock_method"],
  extra: Partial<PurchaseExpansionComponent> = {},
): PurchaseExpansionComponent {
  return { uid, name: uid, path, quantity, stock_method, type: "sale", inclusion_type: "mandatory", ...extra };
}

function product(
  uid: string,
  stock_method: PurchaseExpansionProduct["stock_method"],
  components: PurchaseExpansionComponent[] = [],
): PurchaseExpansionProduct {
  return { uid, name: uid, type: "sale", stock_method, components };
}

// The prod warmer family: 118 (40 Pairs) → 410 × 40; 353 (240 Pairs) → 118 × 6 → 410 × 40.
const CATALOG = new Map<string, PurchaseExpansionProduct>([
  ["410", product("410", "bulk")],
  ["118", product("118", "none", [comp("410", ["118"], 40, "bulk")])],
  ["353", product("353", "none", [comp("118", ["353"], 6, "none"), comp("410", ["353", "118"], 40, "bulk")])],
  // A pallet of counted cases of uncounted bottles: the walk stops at the case.
  ["611", product("611", "none", [comp("case", ["611"], 40, "bulk"), comp("bottle", ["611", "case"], 24, "none")])],
  ["case", product("case", "bulk")],
  // A counted case of counted units: the frontier is the case alone, never both.
  ["crate", product("crate", "none", [comp("case", ["crate"], 2, "bulk"), comp("410", ["crate", "case"], 12, "bulk")])],
  ["bare", product("bare", "none")],
  ["hollow", product("hollow", "none", [comp("ring", ["hollow"], 4, "none", { type: "rental" })])],
  ["set", product("set", "none", [comp("hanger", ["set"], 50, "bulk"), comp("stacker", ["set"], 1, "bulk")])],
  ["opt", product("opt", "none", [comp("410", ["opt"], 10, "bulk"), comp("case", ["opt"], 1, "bulk", { inclusion_type: "optional" })])],
  ["frac", product("frac", "none", [comp("410", ["frac"], 0.07, "bulk")])],
  ["svc", product("svc", "none", [comp("labor", ["svc"], 1, "bulk", { type: "service" })])],
]);

/** A buy line keyed by its product (W4K), as a client sends it. */
const buy = (uid_product: string, quantity: number, amount_cents: number, over: Record<string, unknown> = {}) =>
  ({ type: "sale" as const, uid: uid_product, path: [PAIR_A, uid_product], uid_product, quantity, amount_cents, ...over });

Deno.test("expandPurchaseItems: a stocked product passes through unchanged", () => {
  const items = [buy("410", 7, 700, { description: "" })];
  assertEquals(expandPurchaseItems(items, CATALOG), { ok: true, items });
});

Deno.test("expandPurchaseItems: a pack becomes its stocked component at ×N, carrying the pack's amount, keyed by the component (W4K)", () => {
  const result = expandPurchaseItems([buy("118", 12, 36_000)], CATALOG);
  assertEquals(result, { ok: true, items: [buy("410", 480, 36_000)] });
  assert(result.ok);
  const [row] = result.items as { uid: string; path: string[] }[];
  assertEquals([row.uid, row.path], ["410", [PAIR_A, "410"]]);
});

Deno.test("expandPurchaseItems: a nested pack reaches the stocked leaf through the uncounted middle", () => {
  assertEquals(expandPurchaseItems([buy("353", 1, 9_000)], CATALOG), { ok: true, items: [buy("410", 240, 9_000)] });
});

Deno.test("expandPurchaseItems: the walk stops at the first counted node, not the uncounted leaf below it", () => {
  assertEquals(expandPurchaseItems([buy("611", 2, 50_000)], CATALOG), { ok: true, items: [buy("case", 80, 50_000)] });
});

Deno.test("expandPurchaseItems: a counted node under a counted node is not a second frontier node", () => {
  assertEquals(expandPurchaseItems([buy("crate", 3, 600)], CATALOG), { ok: true, items: [buy("case", 6, 600)] });
});

Deno.test("expandPurchaseItems: an optional component is not part of the pack", () => {
  assertEquals(expandPurchaseItems([buy("opt", 3, 300)], CATALOG), { ok: true, items: [buy("410", 30, 300)] });
});

Deno.test("expandPurchaseItems: the ratio ceils once in integers — 0.07 × 100 is 7, not 8", () => {
  const result = expandPurchaseItems([buy("frac", 100, 100)], CATALOG);
  assert(result.ok);
  assertEquals((result.items[0] as { quantity: number }).quantity, 7);
});

// The expansion does not merge (D2). Keyed by product (W4K), the two rows share a path, which the
// writer's `itemArrayIssues` uniqueness then refuses, as an order's would.
Deno.test("expandPurchaseItems: a pack onto a product the group already holds is a second row at one path, never merged here", () => {
  const result = expandPurchaseItems([buy("410", 20, 1_000), buy("118", 2, 6_000)], CATALOG);
  assertEquals(result, { ok: true, items: [buy("410", 20, 1_000), buy("410", 80, 6_000)] });
});

Deno.test("expandPurchaseItems: refuses a pack with no stocked component — it would receive nothing", () => {
  for (const uid of ["bare", "hollow", "svc"]) {
    const result = expandPurchaseItems([buy(uid, 1, 100)], CATALOG);
    assert(!result.ok, uid);
    assertEquals(result.refusal.reason, "no_stocked_component", uid);
    assertEquals(result.refusal.uid_product, uid);
  }
});

Deno.test("expandPurchaseItems: refuses a kit of several stocked products — one amount has no split rule", () => {
  const result = expandPurchaseItems([buy("set", 1, 100)], CATALOG);
  assert(!result.ok);
  assertEquals(result.refusal.reason, "several_stocked_components");
  assert(result.refusal.message.includes("hanger") && result.refusal.message.includes("stacker"));
});

Deno.test("expandPurchaseItems: a product the caller did not read is the caller's bug, thrown", () => {
  assertThrows(() => expandPurchaseItems([buy("nope", 1, 1)], CATALOG));
});

Deno.test("expandPurchaseItems: a subrent pack expands carrying its price and orders; a divider and a charge pass through", () => {
  const sub = {
    type: "rental" as const,
    uid: "118",
    path: [PAIR_A, "118"],
    uid_product: "118",
    quantity: 1,
    amount_cents: 900,
    price: { uid_price_formula: FIXED.uid },
    uid_orders: [ORDER_1074],
  };
  const other = [
    { type: "destination" as const, uid: PAIR_A, path: [PAIR_A] },
    { type: "service" as const, uid: iuid(3), path: [PAIR_A, iuid(3)], name: "Freight", amount_cents: 1, ledger_account: 5300 as const },
  ];
  assertEquals(expandPurchaseItems([sub, ...other], CATALOG), {
    ok: true,
    items: [{ ...sub, uid: "410", path: [PAIR_A, "410"], uid_product: "410", quantity: 40 }, ...other],
  });
});

Deno.test("expandPurchaseItems: landed costs ride a pack onto its component", () => {
  const freight = { description: "Freight", amount_cents: 500 };
  assertEquals(expandPurchaseItems([buy("118", 1, 900, { landed_costs: [freight] })], CATALOG), {
    ok: true,
    items: [buy("410", 40, 900, { landed_costs: [freight] })],
  });
});

// ── landed cost (api-cloudrun#1227) ──────────────────────────────────

/**
 * The largest-remainder oracle, by PROPERTY rather than by construction: Σ is
 * the total, each share is within one cent of its exact quota `T·w/W`, and no
 * share rounded down has a larger fractional remainder than a share rounded
 * up. All checked by cross-multiplication, so it never computes a share itself.
 */
function largestRemainderViolation(total: bigint, weights: bigint[], shares: bigint[]): string | null {
  const W = weights.reduce((a, w) => a + w, 0n);
  if (shares.reduce((a, s) => a + s, 0n) !== total) return `Σ ${shares.join("+")} ≠ ${total}`;
  let maxDownFrac = -1n;
  let minUpFrac = W + 1n;
  for (let i = 0; i < weights.length; i++) {
    const exact = total * weights[i]; // the quota, scaled by W
    const scaled = shares[i] * W;
    if (scaled - exact >= W || exact - scaled >= W) return `share ${i} = ${shares[i]} is a cent or more from ${exact}/${W}`;
    if (weights[i] === 0n && shares[i] !== 0n) return `zero weight ${i} got ${shares[i]}`;
    if (scaled < exact) maxDownFrac = exact - scaled > maxDownFrac ? exact - scaled : maxDownFrac;
    if (scaled > exact) {
      const frac = exact - (scaled - W); // its remainder before the +1
      minUpFrac = frac < minUpFrac ? frac : minUpFrac;
    }
  }
  if (maxDownFrac > minUpFrac) return `a share rounded down holds remainder ${maxDownFrac} > an up-rounded ${minUpFrac}`;
  return null;
}

function randomWeights(rand: () => number): bigint[] {
  const n = 1 + Math.floor(rand() * 12);
  const ws: bigint[] = Array.from({ length: n }, () => (rand() < 0.15 ? 0n : BigInt(Math.floor(rand() * 5_000_000))));
  if (!ws.some((w) => w > 0n)) ws[0] = 1n;
  return ws;
}

Deno.test("apportionCents: over 200k random splits, Σ is exact and the split is largest-remainder", () => {
  const rand = mulberry32(1227);
  let failure: string | null = null;
  let withRemainder = 0;
  let withZeroWeight = 0;
  for (let draw = 0; draw < DRAWS && failure === null; draw++) {
    const total = BigInt(Math.floor(rand() * 2_000_000));
    const weights = randomWeights(rand);
    const shares = apportionCents(total, weights);
    const v = largestRemainderViolation(total, weights, shares);
    if (v !== null) failure = `draw ${draw}: ${v}`;
    const W = weights.reduce((a, w) => a + w, 0n);
    if (weights.some((w, i) => shares[i] * W > total * w)) withRemainder++;
    if (weights.some((w) => w === 0n)) withZeroWeight++;
  }
  assertEquals(failure, null);
  // The domain, asserted apart from correctness: an evenly-dividing corpus
  // exercises none of the remainder handout.
  assert(withRemainder > DRAWS / 2, `only ${withRemainder} draws handed out a remainder cent`);
  assert(withZeroWeight > DRAWS / 10, `only ${withZeroWeight} draws carried a zero weight`);
});

Deno.test("apportionCents companion: rounding each share on its own does NOT conserve — the sweep above can fail", () => {
  const rand = mulberry32(1227);
  let drifted = 0;
  for (let draw = 0; draw < 20_000; draw++) {
    const total = BigInt(Math.floor(rand() * 2_000_000));
    const weights = randomWeights(rand);
    const W = weights.reduce((a, w) => a + w, 0n);
    const perShare = weights.map((w) => halfUpByRemainder(total * w, W));
    if (largestRemainderViolation(total, weights, perShare) !== null) drifted++;
  }
  assert(drifted > 1_000, `per-share rounding failed the oracle on only ${drifted} of 20,000 splits`);
  assertEquals(apportionCents(100n, [1n, 1n, 1n]), [34n, 33n, 33n]);
  assertEquals([1n, 1n, 1n].map((w) => halfUpByRemainder(100n * w, 3n)), [33n, 33n, 33n]);
});

Deno.test("apportionCents: refuses a split over nothing, or a negative", () => {
  assertThrows(() => apportionCents(100n, [0n, 0n]), RangeError);
  assertThrows(() => apportionCents(100n, []), RangeError);
  assertThrows(() => apportionCents(-1n, [1n]), RangeError);
  assertThrows(() => apportionCents(100n, [1n, -1n]), RangeError);
  assertEquals(apportionCents(0n, [3n, 1n]), [0n, 0n]);
  assertEquals(apportionCents(10_000n, [3n, 0n, 1n]), [7_500n, 0n, 2_500n]);
});

const entry = (over: Partial<PurchaseLandedCost> = {}): PurchaseLandedCost => ({
  uid: "8c1e2a4f-0000-4000-8000-000000000001",
  description: "Freight",
  amount_cents: 10_000,
  quantity: 3,
  received_at_entry: 0,
  uid_purchase_bill: null,
  ...over,
});

/**
 * Receive along `path` (signed steps: a negative is a reversal) the way the api
 * prices it — the cumulative target minus the journal — and return the journal.
 */
function journalAlong(l: PurchaseSaleItem, path: number[]): number[] {
  const journal: number[] = [];
  let received = 0;
  for (const step of path) {
    received += step;
    const sum = journal.reduce((a, c) => a + c, 0);
    journal.push(purchaseLineReceiptTargetCents(l, received) - sum);
  }
  return journal;
}

Deno.test("landed cost: $100 over two lines, two partial receipts each — Σ receipts is goods + $100 exactly", () => {
  const a = line({ uid_product: "testprod1000000000aa", quantity: 4, amount_cents: 40_000 });
  const b = line({ uid_product: "testprod1000000000bb", quantity: 3, amount_cents: 20_000 });
  const split = allocateLandedCostCents(10_000, [{ line: a, received: 0 }, { line: b, received: 0 }]);
  assertEquals(split, [6_667, 3_333]);
  const withA = { ...a, landed_costs: [entry({ amount_cents: split[0], quantity: 4 })] };
  const withB = { ...b, landed_costs: [entry({ amount_cents: split[1], quantity: 3 })] };
  const ja = journalAlong(withA, [1, 3]);
  const jb = journalAlong(withB, [2, 1]);
  assertEquals(ja.reduce((s, c) => s + c, 0) + jb.reduce((s, c) => s + c, 0), 40_000 + 20_000 + 10_000);
  // Every receipt carries its share, not just the last — the `(before, after]`
  // partial on top of the journal subtraction would have priced receipt 1 at
  // its goods alone.
  assertEquals(ja, [10_000 + 1_667, 30_000 + 5_000]);
});

Deno.test("landed cost: an entry made mid-receipt prices only the units received after it", () => {
  // 2 of 5 already in when $30 freight is entered over the other 3.
  const l = line({ quantity: 5, amount_cents: 5_000, landed_costs: [entry({ amount_cents: 3_000, quantity: 3, received_at_entry: 2 })] });
  assertEquals(purchaseLineReceiptTargetCents(l, 2), 2_000);
  assertEquals(purchaseLineReceiptTargetCents(l, 3), 3_000 + 1_000);
  assertEquals(purchaseLineReceiptTargetCents(l, 5), 5_000 + 3_000);
  // Reversing back past the entry clamps at 0 — those units never carried it.
  assertEquals(landedUnitsPriced(l.landed_costs![0], 1), 0);
  assertEquals(purchaseLineReceiptTargetCents(l, 1), 1_000);
});

Deno.test("landed cost: over 50k random lines, entries and receipt paths WITH reversals, the journal always equals the target and a full receipt lands every cent", () => {
  const rand = mulberry32(12270);
  let failure: string | null = null;
  let reversals = 0;
  let crossingReversals = 0;
  for (let draw = 0; draw < 50_000 && failure === null; draw++) {
    const quantity = 1 + Math.floor(rand() * 60);
    const received0 = Math.floor(rand() * quantity);
    const entries = Array.from({ length: Math.floor(rand() * 3) }, (_, k) =>
      entry({
        uid: `8c1e2a4f-0000-4000-8000-00000000000${k}`,
        amount_cents: 1 + Math.floor(rand() * 500_000),
        quantity: quantity - received0,
        received_at_entry: received0,
      }));
    const l = line({ quantity, amount_cents: Math.floor(rand() * 5_000_000), landed_costs: entries });
    // Walk 0 → quantity with occasional reversals, never below 0.
    const path: number[] = [];
    let at = 0;
    while (at < quantity) {
      if (at > 0 && rand() < 0.2) {
        const back = -(1 + Math.floor(rand() * at));
        if (at > received0 && at + back < received0) crossingReversals++;
        path.push(back);
        at += back;
        reversals++;
      } else {
        const step = 1 + Math.floor(rand() * (quantity - at));
        path.push(step);
        at += step;
      }
    }
    const journal = journalAlong(l, path);
    const sum = journal.reduce((a, c) => a + c, 0);
    const want = l.amount_cents + entries.reduce((a, e) => a + e.amount_cents, 0);
    if (sum !== want) failure = `draw ${draw}: Σ journal ${sum} ≠ ${want}`;
  }
  assertEquals(failure, null);
  assert(reversals > 10_000, `only ${reversals} reversals drawn`);
  assert(crossingReversals > 1_000, `only ${crossingReversals} reversals crossed an entry`);
});

Deno.test("landed cost companion: a (before, after] landed partial on top of the journal subtraction loses all but the last share", () => {
  // The spec's first form. If the sweep above could not tell it apart, it
  // would be guarding nothing.
  const l = line({ quantity: 2, amount_cents: 0, landed_costs: [entry({ amount_cents: 10_000, quantity: 2 })] });
  const wrongTarget = (before: number, after: number) =>
    cumulativeShareCents(l.amount_cents, l.quantity, 0, after) +
    cumulativeShareCents(10_000, 2, before, after);
  const journal: number[] = [];
  let before = 0;
  for (const after of [1, 2]) {
    journal.push(wrongTarget(before, after) - journal.reduce((a, c) => a + c, 0));
    before = after;
  }
  assertEquals(journal.reduce((a, c) => a + c, 0), 5_000, "the wrong form journals $50 of $100");
  assertEquals(journalAlong(l, [1, 1]).reduce((a, c) => a + c, 0), 10_000);
});

Deno.test("strandedLandedCents: 0 while units are to come; the unpriced share once a short close cuts them", () => {
  const e = entry({ amount_cents: 10_000, quantity: 4 });
  assertEquals(strandedLandedCents(line({ quantity: 4, landed_costs: [e] }), 1), 0);
  // Closed after 1 of 4: three quarters never arrives.
  assertEquals(strandedLandedCents(line({ quantity: 1, landed_costs: [e] }), 1), 7_500);
  // Received in full: nothing stranded.
  assertEquals(strandedLandedCents(line({ quantity: 4, landed_costs: [e] }), 4), 0);
  // No entries: nothing.
  assertEquals(strandedLandedCents(line({ quantity: 1 }), 1), 0);
});

Deno.test("isLandedCostFrozen: frozen once a receipt after the entry has priced it", () => {
  const e = entry({ received_at_entry: 2 });
  assertEquals(isLandedCostFrozen(e, 2), false);
  assertEquals(isLandedCostFrozen(e, 3), true);
  // A reversal back to the entry point thaws it: nothing priced it any more.
  assertEquals(isLandedCostFrozen(e, 1), false);
});

Deno.test("allocateLandedCostCents: weights are the value still to arrive, and a split over nothing is refused", () => {
  const half = { line: line({ quantity: 4, amount_cents: 40_000 }), received: 2 };
  assertEquals(landedCostWeightCents(half.line, half.received), 20_000);
  const done = { line: line({ quantity: 2, amount_cents: 10_000 }), received: 2 };
  assertEquals(allocateLandedCostCents(5_000, [half, done]), [5_000, 0]);
  assertThrows(() => allocateLandedCostCents(5_000, [done]), RangeError);
});

Deno.test("PurchaseSchema: a landed cost's own refines, one field at a time", () => {
  const at = (e: PurchaseLandedCost) => issuePaths(PurchaseSchema, purchase({ items: [line({ landed_costs: [e] })] }));
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [line({ landed_costs: [entry()] })] })), []);
  assertEquals(at(entry({ amount_cents: 0 })), ["items.1.landed_costs.0.amount_cents"]);
  assertEquals(at(entry({ quantity: 0 })), ["items.1.landed_costs.0.quantity"]);
  assertEquals(at(entry({ quantity: 2, received_at_entry: 2 })), ["items.1.landed_costs.0.quantity"]);
  assertEquals(at(entry({ uid: "not-a-uuid" })), ["items.1.landed_costs.0.uid"]);
  assertEquals(
    issuePaths(PurchaseSchema, purchase({ items: [line({ landed_costs: [entry(), entry({ quantity: 1 })] })] })),
    ["items.1.landed_costs.1.uid"],
  );
});

Deno.test("landed cost inputs: a subrent item cannot carry them; a buy item input refuses a uid named twice", () => {
  const sub = PurchaseItemInput.safeParse({
    type: "rental",
    ...keyedHead(2),
    quantity: 1,
    billing: { basis: "fixed", amount_cents: 100 },
    landed_costs: [{ description: "Freight", amount_cents: 1 }],
  });
  // Non-strict input: the key strips, and the subrent arm has no place to keep it.
  assert(sub.success);
  assertEquals("landed_costs" in sub.data, false);
  const twice = PurchaseItemInput.safeParse({
    ...buyInput,
    landed_costs: [
      { uid: entry().uid, description: "Freight", amount_cents: 1 },
      { uid: entry().uid, description: "Duty", amount_cents: 1 },
    ],
  });
  assert(!twice.success);
  assertEquals(twice.error.issues.map((i) => i.path.join(".")), ["landed_costs.1.uid"]);
});

// ── flatPurchaseLineMoney (Phase 2 ruling 7) ─────────────────────────


/** Seeded LCG — corpora are reproducible, never `Math.random()`. */
function flatMoneyLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/** Exact oracle: round(gross × (100 − rate) ÷ 100) half away from zero, by floor-and-compare, on 4dp rates. */
function exactPercentNet(gross: number, rate4dp: number): number {
  const num = BigInt(gross) * (1_000_000n - BigInt(rate4dp));
  const den = 1_000_000n;
  const q = num / den;
  const r = num - q * den;
  return Number(2n * r >= den ? q + 1n : q);
}

Deno.test("flatPurchaseLineMoney: percent net matches an exact oracle over 100k lines; the quantized ratio disagrees", () => {
  const rand = flatMoneyLcg(77);
  let wrong = 0;
  let companionWrong = 0;
  let discounted = 0;
  for (let i = 0; i < 100_000; i++) {
    const gross = 1 + Math.floor(rand() * 5_000_000);
    const rate4dp = Math.floor(rand() * 1_000_000); // 0.0000 … 99.9999 %
    const rate = rate4dp / 10_000;
    const got = flatPurchaseLineMoney(gross, 1 + Math.floor(rand() * 50), { rate, type: "percent" });
    const want = exactPercentNet(gross, rate4dp);
    if (got.amount_cents !== want) wrong++;
    if (got.discount!.amount_cents !== gross - got.amount_cents) wrong++;
    if (want !== gross) discounted++;
    // Companion: the ratio quantized to 2dp, then applied (cfs-money form B).
    const factor = Math.round((100 - rate) / 100 * 100) / 100;
    if (Math.round(gross * factor) !== want) companionWrong++;
  }
  assertEquals(wrong, 0);
  assert(discounted > 90_000, `the discount arm barely ran: ${discounted}`);
  assert(companionWrong > 50_000, `quantized-ratio companion stopped discriminating: ${companionWrong}`);
});

Deno.test("flatPurchaseLineMoney: a flat discount is cents per unit × quantity; none is the gross", () => {
  assertEquals(flatPurchaseLineMoney(61_718, 288, null), { amount_cents: 61_718, discount: null });
  // $0.10 off each of 288 units = $28.80.
  assertEquals(flatPurchaseLineMoney(61_718, 288, { rate: 0.1, type: "flat" }), {
    amount_cents: 61_718 - 2_880,
    discount: { rate: 0.1, type: "flat", amount_cents: 2_880 },
  });
  // 10% of $617.18 = $61.718 → $61.72 off, half away from zero.
  assertEquals(flatPurchaseLineMoney(61_718, 288, { rate: 10, type: "percent" }).amount_cents, 55_546);
  assertThrows(() => flatPurchaseLineMoney(100.5, 1, null));
});

Deno.test("PurchaseSchema: a stored line holds at least 1 — a line closed to 0 is removed (ruling 47)", () => {
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ quantity: 0, amount_cents: 0 })])).includes("items.1.quantity"), true);
  assertEquals(issuePaths(PurchaseSchema, withItems([freight({ quantity: 0, amount_cents: 0 })])).includes("items.1.quantity"), true);
});

Deno.test("purchaseLineCloseOutcome: a buy drops to received, a flat charge to billed, nothing left removes, a time charge ends its window", () => {
  const got = (received: number) => ({ received, returned: 0 });
  assertEquals(purchaseLineCloseOutcome(line({ quantity: 16 }), got(14)), { kind: "lower", quantity: 14 });
  assertEquals(purchaseLineCloseOutcome(line({ quantity: 3, quantity_billed: 3 }), got(0)), { kind: "remove" });
  assertEquals(purchaseLineCloseOutcome(line({ quantity: 3 }), got(5)), { kind: "lower", quantity: 3 }, "over-received stays at what was ordered");
  assertEquals(purchaseLineCloseOutcome(hireLine({ quantity: 10 }), { received: 4, returned: 4 }), { kind: "lower", quantity: 4 });
  assertEquals(purchaseLineCloseOutcome(freight({ quantity: 1, quantity_billed: 0 }), NO_LINE_CUSTODY), { kind: "remove" });
  assertEquals(purchaseLineCloseOutcome(freight({ quantity: 2, quantity_billed: 5 }), NO_LINE_CUSTODY), { kind: "lower", quantity: 2 }, "over-billed stays at what was ordered");
  assertEquals(purchaseLineCloseOutcome(carrierLine({ quantity: 2 }), NO_LINE_CUSTODY), { kind: "end_window" });
});

Deno.test("landedCostWeightCents: a line with nothing left to arrive weighs nothing, an over-receipt included", () => {
  assertEquals(landedCostWeightCents(line({ quantity: 2, amount_cents: 1_000 }), 2), 0);
  assertEquals(landedCostWeightCents(line({ quantity: 2, amount_cents: 1_000 }), 3), 0);
});
