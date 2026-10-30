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
  type BuyItem,
  ClosePurchaseInput,
  COA_ASSET_CODES,
  CreatePurchaseBillInput,
  CreatePurchaseCreditInput,
  CreatePurchaseInput,
  derivePurchaseStatus,
  type DirectItem,
  PURCHASE_BILL_FIELD_CLASSES,
  PURCHASE_BILL_FIELD_FREEZE,
  PURCHASE_ITEM_TYPES,
  type PurchaseItem,
  PurchaseItemInput,
  type PurchaseLandedCost,
  PurchaseBillSchema,
  PurchaseCreditSchema,
  PurchaseSchema,
  ReceivePurchaseInput,
  ReturnPurchaseInput,
  type SubrentItem,
  UpdatePurchaseInput,
  type UsageItem,
} from "../src/schemas/mod.ts";
import { buildFirestoreColumns } from "../src/schemas/display-columns.ts";
import { classifySharedFields } from "../src/utils/shared-fields.ts";
import { purchaseBillFieldIsFrozen, purchaseBillIsFrozen } from "../src/utils/invoices.ts";
import { XERO_ASSET_ACCOUNTS } from "../src/utils/movements.ts";
import {
  allocateLandedCostCents,
  cumulativeShareCents,
  deriveQueryByItemTypes,
  expandPurchaseItems,
  isLandedCostFrozen,
  landedCostWeightCents,
  landedUnitsPriced,
  purchaseLineReceiptTargetCents,
  strandedLandedCents,
  type PurchaseExpansionComponent,
  type PurchaseExpansionProduct,
  deriveQueryByOrders,
  deriveQueryByProducts,
  purchaseItemCanceled,
  purchaseItemCommittedCents,
  purchaseItemResolved,
  remainingToBill,
  remainingToReceive,
  remainingToReturn,
} from "../src/utils/purchases.ts";
import { apportionCents } from "../src/utils/money.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

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
const PRODUCT = "testprod100000000000";

const line = (over: Partial<BuyItem> = {}): BuyItem => {
  const uid = over.uid ?? iuid(1);
  return {
    type: "buy",
    uid,
    path: [uid],
    name: "Walkie Talkie",
    uid_product: PRODUCT,
    quantity: 3,
    amount_cents: 140985,
    coa_posting: 1999,
    uid_tracking_category: null,
    expected_date: null,
    quantity_received: 0,
    quantity_billed: 0,
    quantity_canceled: 0,
    landed_costs: [],
    ...over,
  };
};

const HIRE = { start: "2026-10-18T09:00:00.000-05:00", end: "2026-10-25T17:00:00.000-05:00" };
const ORDER_1074 = "testorder1074000000a";
const COGS_ENTRY = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";

/** A fixed-basis subrent item of 10 steamers, received and returned per `over`. */
const hireLine = (over: Partial<SubrentItem> = {}): SubrentItem => {
  const uid = over.uid ?? iuid(2);
  return {
    type: "subrent",
    uid,
    path: [uid],
    name: "Steamer",
    uid_product: PRODUCT,
    quantity: 10,
    coa_posting: 5100,
    uid_tracking_category: null,
    billing: { basis: "fixed", amount_cents: 50_000 },
    dates: HIRE,
    quantity_received: 0,
    quantity_billed: 0,
    quantity_canceled: 0,
    quantity_returned: 0,
    uid_orders: [ORDER_1074],
    ...over,
  };
};

const usage = (over: Partial<UsageItem> = {}): UsageItem => {
  const uid = over.uid ?? iuid(3);
  return {
    type: "usage",
    uid,
    path: [uid],
    name: "Hotspot (Unlimited)",
    uid_product: PRODUCT,
    coa_posting: 5150,
    uid_tracking_category: null,
    uid_cogs: COGS_ENTRY,
    quantity_billed: 0,
    ...over,
  };
};

const direct = (over: Partial<DirectItem> = {}): DirectItem => {
  const uid = over.uid ?? iuid(4);
  return {
    type: "direct",
    uid,
    path: [uid],
    name: "Freight",
    description: "Freight",
    amount_cents: 1_500,
    coa_posting: 5300,
    uid_tracking_category: null,
    quantity_billed: 0,
    quantity_canceled: 0,
    ...over,
  };
};

// ── status ───────────────────────────────────────────────────────────

Deno.test("derivePurchaseStatus — the buy table", () => {
  const cases: [string, Partial<BuyItem>[], string][] = [
    ["nothing yet", [{}], "active"],
    ["billed, not received — #3882's real state", [{ quantity_billed: 3 }], "active"],
    ["received in full, unbilled", [{ quantity_received: 3 }], "active"],
    ["received and billed", [{ quantity_received: 3, quantity_billed: 3 }], "complete"],
    ["short-closed after 2, billed 2", [{ quantity_received: 2, quantity_billed: 2, quantity_canceled: 1 }], "complete"],
    ["short-closed after 2, billed 1", [{ quantity_received: 2, quantity_billed: 1, quantity_canceled: 1 }], "active"],
    ["canceled outright", [{ quantity_canceled: 3 }], "canceled"],
    ["one item done, one canceled", [{ quantity_received: 3, quantity_billed: 3 }, { quantity_canceled: 3 }], "complete"],
    ["one item done, one open", [{ quantity_received: 3, quantity_billed: 3 }, {}], "active"],
  ];
  for (const [name, items, want] of cases) {
    assertEquals(derivePurchaseStatus({ items: items.map((l, k) => line({ uid: iuid(k + 1), ...l })) }), want, name);
  }
});

Deno.test("derivePurchaseStatus — a subrent is complete only once every received unit is RETURNED", () => {
  // Each negative case breaks exactly ONE of the three axes.
  const done = { quantity_received: 10, quantity_billed: 10, quantity_returned: 10 };
  const cases: [string, Partial<SubrentItem>, string][] = [
    ["received, billed, returned", done, "complete"],
    ["…not returned", { ...done, quantity_returned: 9 }, "active"],
    ["…not billed", { ...done, quantity_billed: 9 }, "active"],
    ["…not received (and so not returned)", { ...done, quantity_received: 9, quantity_returned: 9 }, "active"],
    ["short-closed after 6, billed 6, returned 6", { quantity_received: 6, quantity_billed: 6, quantity_returned: 6, quantity_canceled: 4 }, "complete"],
    ["canceled outright", { quantity_canceled: 10 }, "canceled"],
  ];
  for (const [name, over, want] of cases) {
    assertEquals(derivePurchaseStatus({ items: [hireLine(over)] }), want, name);
  }
});

Deno.test("derivePurchaseStatus — an activation-billed subrent resolves on custody alone; usage never resolves; direct on billing", () => {
  const activation = { billing: { basis: "activation" as const, uid_cogs: COGS_ENTRY } };
  // Billed periods are unbounded by units and close nothing.
  assertEquals(derivePurchaseStatus({ items: [hireLine({ ...activation, quantity_received: 10, quantity_returned: 10, quantity_billed: 0 })] }), "complete");
  assertEquals(derivePurchaseStatus({ items: [hireLine({ ...activation, quantity_received: 10, quantity_returned: 9, quantity_billed: 40 })] }), "active");
  // Control: the same buckets on a FIXED subrent are still owed a bill.
  assertEquals(derivePurchaseStatus({ items: [hireLine({ quantity_received: 10, quantity_returned: 10, quantity_billed: 0 })] }), "active");
  assertEquals(derivePurchaseStatus({ items: [usage({ quantity_billed: 12 })] }), "active");
  assertEquals(derivePurchaseStatus({ items: [direct()] }), "active");
  assertEquals(derivePurchaseStatus({ items: [direct({ quantity_billed: 1 })] }), "complete");
  // A usage item has no cancel bucket: a purchase holding one is never canceled.
  assertEquals(derivePurchaseStatus({ items: [line({ quantity_canceled: 3 }), usage({ uid: iuid(5) })] }), "active");
});

Deno.test("remainingToReceive / remainingToBill are each bounded by what was canceled; remainingToReturn is received − returned", () => {
  const l = line({ quantity_received: 1, quantity_billed: 2, quantity_canceled: 1 });
  assertEquals(remainingToReceive(l), 1);
  assertEquals(remainingToBill(l), 0);
  assertEquals(remainingToReturn(hireLine({ quantity_received: 7, quantity_returned: 3 })), 4);
});

// ── purchases ────────────────────────────────────────────────────────

const actor = { uid: "testuser100000000000", name: "Test User" };
const SUPPLIER = { uid: "testsupp100000000000", name: "Baycom" };

function purchase(over: Record<string, unknown> = {}) {
  const items = (over.items as PurchaseItem[] | undefined) ?? [line()];
  return {
    uid: "testpurch10000000000",
    number: 1,
    status: "active",
    supplier: SUPPLIER,
    store: { uid: "teststore10000000000", name: "Main" },
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    reference: "Q-1182",
    notes: null,
    items,
    total_cents: 140985,
    query_by_products: deriveQueryByProducts(items),
    query_by_orders: deriveQueryByOrders(items),
    query_by_item_types: deriveQueryByItemTypes(items),
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
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
    status: derivePurchaseStatus({ items }),
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
  const items = [line(), hireLine(), usage(), direct()];
  assertEquals(issuePaths(PurchaseSchema, withItems(items)), []);
  assertEquals(deriveQueryByItemTypes(items), ["buy", "subrent", "usage", "direct"]);
});

Deno.test("PurchaseSchema: received + canceled may not exceed the quantity ordered", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [line({ quantity_received: 2, quantity_canceled: 2 })] })), [
    "items.0.quantity_received",
  ]);
});

Deno.test("PurchaseSchema: billed + canceled may not exceed the quantity ordered", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [line({ quantity_billed: 3, quantity_canceled: 1 })] })), [
    "items.0.quantity_billed",
  ]);
});

Deno.test("PurchaseSchema: one product may sit on two items (D2); row identity is the uid", () => {
  const two = [line(), line({ uid: iuid(9), quantity: 1, amount_cents: 100 })];
  assertEquals(issuePaths(PurchaseSchema, withItems(two)), []);
  assertEquals(deriveQueryByProducts(two), [PRODUCT], "the mirror stays distinct");
  // A uid named twice is refused — and so is a path that is not [uid].
  assertEquals(issuePaths(PurchaseSchema, withItems([line(), line({ quantity: 1, amount_cents: 100 })])), ["items.1.uid"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ path: [iuid(8)] })])), ["items.0.path"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ path: [] })])), ["items.0.path"]);
});

Deno.test("PurchaseSchema: total_cents is the Σ of the COMMITTED amounts", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ total_cents: 140984 })), ["total_cents"]);
  // An activation-billed subrent and a usage item commit nothing (owner, 2026-10-30).
  const activation = hireLine({ billing: { basis: "activation", uid_cogs: COGS_ENTRY } });
  assertEquals(purchaseItemCommittedCents(activation), 0);
  assertEquals(purchaseItemCommittedCents(usage()), 0);
  assertEquals(purchaseItemCommittedCents(hireLine()), 50_000);
  assertEquals(purchaseItemCommittedCents(direct()), 1_500);
  assertEquals(issuePaths(PurchaseSchema, withItems([line(), activation, usage(), direct()], { total_cents: 140985 + 1_500 })), []);
  assertEquals(issuePaths(PurchaseSchema, withItems([line(), activation], { total_cents: 140985 + 50_000 })), ["total_cents"]);
});

Deno.test("PurchaseSchema: a stored status the buckets contradict is refused", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ status: "complete" })), ["status"]);
  assertEquals(
    issuePaths(PurchaseSchema, purchase({ status: "complete", items: [line({ quantity_received: 3, quantity_billed: 3 })] })),
    [],
  );
});

Deno.test("PurchaseSchema: a purchase orders at least one item", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [], total_cents: 0 })), ["items"]);
});

Deno.test("PurchaseSchema: coa_posting is constrained per arm (D4)", () => {
  // buy → an inventory asset account; subrent and usage → Direct Costs; direct → any.
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ coa_posting: 1400 })])), []);
  assertEquals(issuePaths(PurchaseSchema, withItems([line({ coa_posting: 5100 as never })])), ["items.0.coa_posting"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ coa_posting: 1999 as never })])), ["items.0.coa_posting"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([usage({ coa_posting: 1400 as never })])), ["items.0.coa_posting"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([direct({ coa_posting: 6100 })])), []);
});

Deno.test("COA_ASSET_CODES names exactly XERO_ASSET_ACCOUNTS' codes", () => {
  assertEquals([...COA_ASSET_CODES].sort(), Object.values(XERO_ASSET_ACCOUNTS).sort());
});

Deno.test("PurchaseSchema: each arm carries exactly its own members — a buy cannot hold a hire, a subrent cannot hold landed costs", () => {
  for (const [key, value] of [["dates", HIRE], ["quantity_returned", 0], ["uid_orders", []], ["billing", { basis: "fixed", amount_cents: 1 }]] as const) {
    assertEquals(issuePaths(PurchaseSchema, withItems([{ ...line(), [key]: value } as BuyItem])), ["items.0"], `buy with ${key}`);
  }
  assertEquals(issuePaths(PurchaseSchema, withItems([{ ...hireLine(), landed_costs: [] } as SubrentItem])), ["items.0"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([{ ...hireLine(), expected_date: null } as SubrentItem])), ["items.0"]);
  for (const key of ["dates", "quantity_returned", "uid_orders", "billing"] as const) {
    const without = { ...hireLine() } as Record<string, unknown>;
    delete without[key];
    assertEquals(issuePaths(PurchaseSchema, withItems([hireLine()], { items: [without] })).includes(`items.0.${key}`), true, `subrent without ${key}`);
  }
  const noLanded = { ...line() } as Record<string, unknown>;
  delete noLanded.landed_costs;
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [noLanded] })), ["items.0.landed_costs"]);
});

Deno.test("PurchaseSchema: returned may not exceed received, and a hire may not end before it starts", () => {
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ quantity_received: 3, quantity_returned: 4 })])), [
    "items.0.quantity_returned",
  ]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ dates: { start: HIRE.end, end: HIRE.start } })])), [
    "items.0.dates.end",
  ]);
});

Deno.test("PurchaseSchema: a STANDING subrent has dates.end null (D8)", () => {
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ dates: { start: HIRE.start, end: null } })])), []);
});

Deno.test("PurchaseSchema: the billing basis is a nested union — fixed carries an amount, activation a cost entry", () => {
  const at = (billing: unknown) => issuePaths(PurchaseSchema, withItems([hireLine({ billing: billing as SubrentItem["billing"] })], { total_cents: 0 }));
  assertEquals(at({ basis: "activation", uid_cogs: COGS_ENTRY }), []);
  assertEquals(at({ basis: "activation", uid_cogs: COGS_ENTRY, amount_cents: 1 }), ["items.0.billing"]);
  assertEquals(at({ basis: "activation" }), ["items.0.billing.uid_cogs"]);
  assertEquals(at({ basis: "fixed" }), ["items.0.billing.amount_cents"]);
  assertEquals(at({ basis: "weekly", amount_cents: 1 }), ["items.0.billing.basis"]);
  // A fixed subrent's billed units are bounded by what was ordered; an
  // activation one bills PERIODS, unbounded by units.
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine({ quantity_billed: 11 })])), ["items.0.quantity_billed"]);
  assertEquals(
    issuePaths(PurchaseSchema, withItems([hireLine({ billing: { basis: "activation", uid_cogs: COGS_ENTRY }, quantity_billed: 11 })])),
    [],
  );
});

Deno.test("the nested billing union is reached by the column walker (the new pattern's walker pin)", () => {
  const columns = new Map(buildFirestoreColumns(PurchaseSchema).map((c) => [c.key, c.label]));
  assertEquals(columns.get("items.billing.amount_cents"), "Item Billing Amount");
  assertEquals(columns.get("items.dates.end"), "Item Hire End");
  assertEquals(columns.get("items.type"), "Item Type");
});

Deno.test("PurchaseSchema: a direct item is billed once or canceled, never both", () => {
  // 2 breaks the bucket's own bound AND the billed-or-canceled sum: both issues are real.
  assertEquals(issuePaths(PurchaseSchema, withItems([direct({ quantity_billed: 2 })])), [
    "items.0.quantity_billed",
    "items.0.quantity_canceled",
  ]);
  assertEquals(issuePaths(PurchaseSchema, withItems([direct({ quantity_canceled: 1 })])), []);
  assertEquals(issuePaths(PurchaseSchema, withItems([direct({ quantity_billed: 1, quantity_canceled: 1 })])), [
    "items.0.quantity_canceled",
  ]);
  const noBucket = { ...direct() } as Record<string, unknown>;
  delete noBucket.quantity_canceled;
  assertEquals(issuePaths(PurchaseSchema, withItems([direct()], { items: [noBucket] })), ["items.0.quantity_canceled"]);
});

Deno.test("derivePurchaseStatus — a canceled direct item no longer holds a purchase open (owner, 2026-10-30)", () => {
  // Unbilled freight beside a canceled buy: before the bucket this could only read active.
  assertEquals(derivePurchaseStatus({ items: [line({ quantity_canceled: 3 }), direct()] }), "active");
  assertEquals(derivePurchaseStatus({ items: [line({ quantity_canceled: 3 }), direct({ quantity_canceled: 1 })] }), "canceled");
  // Goods done, freight canceled unbilled: complete.
  assertEquals(
    derivePurchaseStatus({ items: [line({ quantity_received: 3, quantity_billed: 3 }), direct({ quantity_canceled: 1 })] }),
    "complete",
  );
  // A BILLED direct item is not canceled, so a purchase holding one is not canceled either.
  assertEquals(derivePurchaseStatus({ items: [line({ quantity_canceled: 3 }), direct({ quantity_billed: 1 })] }), "complete");
});

Deno.test("PurchaseSchema: all three mirrors are required, and each must be exact", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase()), []);
  for (const key of ["query_by_products", "query_by_orders", "query_by_item_types"]) {
    const doc = purchase() as Record<string, unknown>;
    delete doc[key];
    assertEquals(issuePaths(PurchaseSchema, doc), [key]);
  }
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_products: [] })), ["query_by_products"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_products: ["testprod200000000000"] })), ["query_by_products"]);
  assertEquals(issuePaths(PurchaseSchema, withItems([hireLine()], { query_by_orders: [] })), ["query_by_orders"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_orders: [ORDER_1074] })), ["query_by_orders"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_item_types: ["subrent"] })), ["query_by_item_types"]);
  // The retired document kind is refused outright.
  assertEquals(issuePaths(PurchaseSchema, purchase({ kind: "buy" })), [""]);
});

Deno.test("deriveQueryByProducts leaves a direct item's attribution out; deriveQueryByOrders reads subrent items only", () => {
  assertEquals(deriveQueryByProducts([direct({ uid_product: "testprod900000000000" })]), []);
  assertEquals(
    deriveQueryByOrders([hireLine({ uid_orders: ["a", "b"] }), hireLine({ uid: iuid(7), uid_orders: ["b", "c"] }), line()]),
    ["a", "b", "c"],
  );
});

Deno.test("the item-type switches are exhaustive over PURCHASE_ITEM_TYPES", () => {
  // The compile-time half is the `never` default in each switch; this is the
  // runtime half — every member reaches a branch rather than the throw.
  const one: Record<string, PurchaseItem> = { buy: line(), subrent: hireLine(), usage: usage(), direct: direct() };
  assertEquals(Object.keys(one).sort(), [...PURCHASE_ITEM_TYPES].sort());
  for (const type of PURCHASE_ITEM_TYPES) {
    purchaseItemResolved(one[type]);
    purchaseItemCanceled(one[type]);
    purchaseItemCommittedCents(one[type]);
  }
  assertThrows(() => purchaseItemResolved({ ...line(), type: "lease" } as unknown as PurchaseItem));
});

// ── item inputs ──────────────────────────────────────────────────────

const SESSION = "0199a1f2-3b4c-7d8e-9f01-234567890abc";
const buyInput = { type: "buy", uid_product: PRODUCT, quantity: 1, amount_cents: 100 };
const createInput = (over: Record<string, unknown> = {}) => ({
  supplier: { uid: SUPPLIER.uid },
  store: { uid: "teststore10000000000" },
  date: "2026-10-01T00:00:00.000-05:00",
  items: [buyInput],
  uuid_session: SESSION,
  ...over,
});

Deno.test("CreatePurchaseInput: items of every arm, the same product twice, and no kind", () => {
  const items = [
    buyInput,
    { ...buyInput, quantity: 2 },
    { type: "subrent", uid_product: PRODUCT, quantity: 10, billing: { basis: "fixed", amount_cents: 50_000 }, dates: HIRE },
    { type: "subrent", uid_product: PRODUCT, quantity: 2, billing: { basis: "activation", uid_cogs: COGS_ENTRY }, dates: { start: HIRE.start, end: null } },
    { type: "usage", uid_product: PRODUCT, uid_cogs: COGS_ENTRY },
    { type: "direct", description: "Freight", amount_cents: 1_500, coa_posting: 5300 },
  ];
  assertEquals(issuePaths(CreatePurchaseInput, createInput({ items })), []);
  // A stored item named twice is ambiguous; unnamed items are new and need no uid.
  assertEquals(
    issuePaths(CreatePurchaseInput, createInput({ items: [{ ...buyInput, uid: iuid(1) }, { ...buyInput, uid: iuid(1) }] })),
    ["items.1.uid"],
  );
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, items: [{ ...buyInput, uid: iuid(1) }, { ...buyInput, uid: iuid(1) }] }), [
    "items.1.uid",
  ]);
});

Deno.test("PurchaseItemInput: each arm's own requirements, one field at a time", () => {
  const sub = { type: "subrent", uid_product: PRODUCT, quantity: 10, billing: { basis: "fixed", amount_cents: 1 }, dates: HIRE };
  assertEquals(issuePaths(PurchaseItemInput, sub), []);
  assertEquals(issuePaths(PurchaseItemInput, { ...sub, dates: undefined }), ["dates"]);
  assertEquals(issuePaths(PurchaseItemInput, { ...sub, billing: undefined }), ["billing"]);
  assertEquals(issuePaths(PurchaseItemInput, { ...sub, dates: { start: HIRE.end, end: HIRE.start } }), ["dates.end"]);
  assertEquals(issuePaths(PurchaseItemInput, { ...sub, coa_posting: 1999 }), ["coa_posting"]);
  // A direct item's account is the operator's: there is no default.
  assertEquals(issuePaths(PurchaseItemInput, { type: "direct", description: "Freight", amount_cents: 1 }), ["coa_posting"]);
  assertEquals(issuePaths(PurchaseItemInput, { ...buyInput, coa_posting: 5100 }), ["coa_posting"]);
  // Non-strict: an extra key strips rather than 400s (core/CLAUDE.md § Document vs input).
  const parsed = PurchaseItemInput.safeParse({ ...buyInput, quantity_received: 3 });
  assert(parsed.success);
  assertEquals("quantity_received" in parsed.data, false);
});

Deno.test("ClosePurchaseInput / ReceivePurchaseInput / ReturnPurchaseInput name ITEMS, each once", () => {
  assertEquals(issuePaths(ClosePurchaseInput, { uid_items: [iuid(1)], uuid_session: SESSION, version: 0 }), []);
  const r = { uid_item: iuid(1), quantity: 1 };
  const receive = { date: "2026-10-05T10:00:00.000-05:00", lines: [r, r], uuid_session: SESSION, version: 0 };
  assertEquals(issuePaths(ReceivePurchaseInput, receive), ["lines.1.uid_item"]);
  assertEquals(issuePaths(ReceivePurchaseInput, { ...receive, lines: [r, { ...r, uid_item: iuid(2) }] }), []);
  assertEquals(issuePaths(ReturnPurchaseInput, { ...receive, lines: [r, r] }), ["lines.1.uid_item"]);
});

Deno.test("ReceivePurchaseInput: allocations sum to the quantity, and named units are exactly `quantity`, ascending", () => {
  const receive = (l: Record<string, unknown>) => ({
    date: "2026-10-05T10:00:00.000-05:00",
    lines: [{ uid_item: iuid(1), quantity: 2, ...l }],
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
    lines: [{ uid_item: iuid(2), quantity: 10, ...lineOver }],
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
    lines: [{ uid_item: iuid(2), quantity: 2, ...lineOver }],
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

/** A bill product item projecting PO item `iuid(1)`. */
const billItem = (over: Record<string, unknown> = {}) => {
  const uid = (over.uid as string | undefined) ?? iuid(101);
  return {
    type: "buy",
    uid,
    path: [uid],
    name: "Walkie Talkie",
    uid_product: PRODUCT,
    quantity: 3,
    amount_cents: 140985,
    coa_posting: 1999,
    uid_tracking_category: null,
    path_purchase_item: [iuid(1)],
    ...over,
  };
};

/** A bill direct item — document-only unless `path_purchase_item` is given. */
const billDirect = (over: Record<string, unknown> = {}) => {
  const uid = (over.uid as string | undefined) ?? iuid(201);
  return {
    type: "direct",
    uid,
    path: [uid],
    name: "Freight",
    description: "Freight",
    quantity: 1,
    amount_cents: 1500,
    coa_posting: 5100,
    uid_tracking_category: null,
    ...over,
  };
};

function bill(over: Record<string, unknown> = {}) {
  return {
    uid: "testbill100000000000",
    number: 1,
    uid_purchase: "testpurch10000000000",
    supplier: SUPPLIER,
    origin: "pushed",
    xero_document: "invoice",
    xero_id: null,
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    due_date: "2026-10-31T00:00:00.000-05:00",
    reference: "INV-55",
    items: [billItem()],
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
    ...over,
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

Deno.test("PurchaseBillSchema: a bill of only document-only direct items parses — a historic Vision bill (D5)", () => {
  const t = { total_cents: 1500, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 1500 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billDirect()], totals: t })), []);
});

Deno.test("PurchaseBillSchema: a direct item's attribution — each field optional, a mark_lost MovementId parses", () => {
  const movementId = "0199a1f2-3b4c-7d8e-9f01-234567890abc|mark_lost|testordr100000000000:testitem10000000000x:9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48";
  const charge = billDirect({
    description: "Loss charge — steamer",
    name: "Loss charge — steamer",
    uid_product: PRODUCT,
    uid_tracking_category: "testtrack10000000000",
    uid_out_of_service: movementId,
  });
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem(), charge], totals: T_WITH_FREIGHT })), []);
});

Deno.test("PurchaseBillSchema: a product item names the purchase item it projects; a direct item may", () => {
  const { path_purchase_item: _p, ...unanchored } = billItem();
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [unanchored] })), ["items.0.path_purchase_item"]);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ items: [billItem({ path_purchase_item: [] })] })), ["items.0.path_purchase_item"]);
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ items: [billItem(), billDirect({ path_purchase_item: [iuid(4)] })], totals: T_WITH_FREIGHT })),
    [],
  );
});

Deno.test("PurchaseBillSchema: a purchase item is billed by at most one item of a document; uids are unique; path is [uid]", () => {
  const linked = { origin: "linked", xero_id: XERO_ID };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem(), billItem({ uid: iuid(102) })] })), [
    "items.1.path_purchase_item",
  ]);
  // Two items of ONE product billing two purchase items is fine (D2).
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem(), billItem({ uid: iuid(102), path_purchase_item: [iuid(9)] })] })),
    [],
  );
  assertEquals(
    issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem(), billItem({ path_purchase_item: [iuid(9)] })] })),
    ["items.1.uid"],
  );
  assertEquals(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [billItem({ path: [iuid(9)] })] })), ["items.0.path"]);
  // `.min(1)` and the value rule both name `items`; either is the refusal.
  assertEquals([...new Set(issuePaths(PurchaseBillSchema, bill({ ...linked, items: [] })))], ["items"]);
});

Deno.test("PurchaseBillSchema: a bill item's posting is any account — a linked bill carries Xero's (D5)", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill({ origin: "linked", xero_id: XERO_ID, items: [billItem({ coa_posting: 6100 })] })), []);
});

Deno.test("PurchaseBillSchema: paid + credited + void + due must equal total", () => {
  const t = { total_cents: 140985, amount_paid_cents: 100, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 140985 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ totals: t })), ["totals"]);
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

Deno.test("CreatePurchaseBillInput: items by uid_item, direct items separately; a purchase item once", () => {
  const items = [{ uid_item: iuid(1), quantity: 3 }];
  const common = { items, uuid_session: SESSION, version: 0 };
  const push = { mode: "push", date: "2026-10-01T00:00:00.000-05:00", due_date: "2026-10-31T00:00:00.000-05:00" };
  assertEquals(issuePaths(CreatePurchaseBillInput, { ...push, ...common }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { mode: "link", xero_document: "bank_transaction", xero_id: XERO_ID, ...common }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { mode: "push", date: "2026-10-01T00:00:00.000-05:00", ...common }), ["due_date"]);
  assertEquals(
    issuePaths(CreatePurchaseBillInput, { mode: "link", xero_document: "invoice", xero_id: XERO_ID, ...common, items: [items[0], items[0]] }),
    ["items.1.uid_item"],
  );
  // A push of direct items alone is a bill; a push of nothing is not.
  const freight = { description: "Freight", coa_posting: 5100, amount_cents: 1500 };
  assertEquals(issuePaths(CreatePurchaseBillInput, { ...push, ...common, items: [], direct_items: [freight] }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { ...push, ...common, items: [] }), ["items"]);
});

Deno.test("a direct item input stays STRICT inside the push input — an unknown key is a 400, not dropped", () => {
  // The fail-closed half of keeping the node strict: an api predating a field
  // must refuse it rather than store an item with the attribution stripped.
  const push = (d: Record<string, unknown>) =>
    CreatePurchaseBillInput.safeParse({
      mode: "push",
      date: "2026-10-25T00:00:00.000-05:00",
      due_date: "2026-11-24T00:00:00.000-06:00",
      items: [{ uid_item: iuid(1), quantity: 1 }],
      direct_items: [d],
      uuid_session: SESSION,
      version: 0,
    });
  const charge = { description: "Loss charge", coa_posting: 5100, amount_cents: 1500, uid_product: PRODUCT };
  assertEquals(push(charge).success, true, "the otherwise-valid payload parses, so the refusal below is the key alone");
  const r = push({ ...charge, uid_product_typo: "x" });
  assertEquals(
    r.success ? [] : r.error.issues.map((i) => `${i.code}:${i.path.join(".")}`),
    ["unrecognized_keys:direct_items.0"],
  );
});

// ── bill freeze (D10) ────────────────────────────────────────────────

Deno.test("purchaseBillIsFrozen: money settled ≠ 0, by VALUE — reversed to zero unfreezes; xero_id is no term", () => {
  const t = (over: Record<string, number>) => ({ totals: { ...bill().totals, ...over } });
  assertEquals(purchaseBillIsFrozen(t({})), false);
  assertEquals(purchaseBillIsFrozen({ ...t({}), xero_id: XERO_ID } as never), false);
  assertEquals(purchaseBillIsFrozen(t({ amount_paid_cents: 1, amount_due_cents: 140984 })), true);
  assertEquals(purchaseBillIsFrozen(t({ amount_credited_cents: 1, amount_due_cents: 140984 })), true);
  assertEquals(purchaseBillIsFrozen(t({ amount_void_cents: 140985, amount_due_cents: 0 })), true);
});

Deno.test("PURCHASE_BILL_FIELD_FREEZE: the invoice's table, class for class; tracking freezes only on void and is not shown editable in Xero", () => {
  assertEquals(Object.keys(PURCHASE_BILL_FIELD_FREEZE), [...PURCHASE_BILL_FIELD_CLASSES]);
  const paid = { totals: { ...bill().totals, amount_paid_cents: 140985, amount_due_cents: 0 } };
  const voided = { totals: { ...bill().totals, amount_void_cents: 140985, amount_due_cents: 0 } };
  const open = { totals: bill().totals };
  const frozenOn = (b: typeof open) => PURCHASE_BILL_FIELD_CLASSES.filter((c) => purchaseBillFieldIsFrozen(b, c));
  assertEquals(frozenOn(open), []);
  assertEquals(frozenOn(paid), ["supplier", "date", "line_money", "coa_posting"]);
  assertEquals(frozenOn(voided), ["supplier", "date", "line_money", "coa_posting", "tracking"]);
  // `false` is "not shown" — no settled ACCPAY edit has been measured (D10).
  assertEquals(PURCHASE_BILL_FIELD_CLASSES.filter((c) => PURCHASE_BILL_FIELD_FREEZE[c].xero_accepts_on_settled), []);
});

Deno.test("classifySharedFields(PurchaseSchema, bill/credit) is fail-closed — every shared key is declared (D5)", () => {
  for (const downstream of [PurchaseBillSchema, PurchaseCreditSchema]) {
    const c = classifySharedFields(PurchaseSchema, downstream);
    assertEquals(c.unhandled, []);
    assertEquals(c.undeclared, []);
    assertEquals(c.rows, ["items[]"]);
  }
  const kinds = Object.fromEntries(classifySharedFields(PurchaseSchema, PurchaseBillSchema).fields.map((f) => [f.path, f.kind]));
  // The posting and the labels follow; the billed quantity and amount are homonyms.
  assertEquals(kinds["items[].coa_posting"], "propagated");
  assertEquals(kinds["items[].uid_tracking_category"], "propagated");
  assertEquals(kinds["items[].name"], "propagated");
  assertEquals(kinds["items[].quantity"], "homonym");
  assertEquals(kinds["items[].amount_cents"], "homonym");
  assertEquals(kinds["supplier"], "atom");
});

// ── supplier credits ─────────────────────────────────────────────────

function credit(over: Record<string, unknown> = {}) {
  return {
    uid: "testcred100000000000",
    number: 1,
    uid_purchase: "testpurch10000000000",
    supplier: SUPPLIER,
    origin: "pushed",
    reason: "short_close",
    status: "issued",
    xero_id: null,
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    reference: null,
    items: [billItem({ quantity: 1, amount_cents: 46995 })],
    total_cents: 46995,
    remaining_credit_cents: 46995,
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

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

Deno.test("PurchaseCreditSchema: a rebate may carry only direct items, but a credit with value names one", () => {
  const rebate = billDirect({ description: "Volume rebate", name: "Volume rebate", coa_posting: 5000, amount_cents: 2000 });
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
  assertEquals(issuePaths(CreatePurchaseCreditInput, { ...base, items: [{ uid_item: iuid(1), quantity: 1 }] }), []);
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

const D1 = "2026-11-02T00:00:00.000-06:00";
const buy = (uid_product: string, quantity: number, amount_cents: number, over: Record<string, unknown> = {}) =>
  ({ type: "buy" as const, uid_product, quantity, amount_cents, ...over });

Deno.test("expandPurchaseItems: a stocked product passes through unchanged", () => {
  const items = [buy("410", 7, 700, { expected_date: D1 })];
  assertEquals(expandPurchaseItems(items, CATALOG), { ok: true, items });
});

Deno.test("expandPurchaseItems: a pack becomes its stocked component at ×N, carrying the pack's amount and uid", () => {
  assertEquals(expandPurchaseItems([buy("118", 12, 36_000, { uid: iuid(1) })], CATALOG), {
    ok: true,
    items: [buy("410", 480, 36_000, { uid: iuid(1) })],
  });
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

Deno.test("expandPurchaseItems: a pack and its stocked product stay TWO items — no merge since items carry identity (D2)", () => {
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

Deno.test("expandPurchaseItems: a subrent pack expands carrying its billing, hire and orders; usage and direct pass through", () => {
  const sub = {
    type: "subrent" as const,
    uid_product: "118",
    quantity: 1,
    billing: { basis: "fixed" as const, amount_cents: 900 },
    dates: HIRE,
    uid_orders: [ORDER_1074],
  };
  const other = [{ type: "usage" as const, uid_product: "bare", uid_cogs: COGS_ENTRY }, {
    type: "direct" as const,
    description: "Freight",
    amount_cents: 1,
    coa_posting: 5300,
  }];
  assertEquals(expandPurchaseItems([sub, ...other], CATALOG), {
    ok: true,
    items: [{ ...sub, uid_product: "410", quantity: 40 }, ...other],
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
function journalAlong(l: BuyItem, path: number[]): number[] {
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
  const split = allocateLandedCostCents(10_000, [a, b]);
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
  assertEquals(strandedLandedCents(line({ quantity: 4, quantity_received: 1, landed_costs: [e] })), 0);
  // Closed after 1 of 4: three quarters never arrives.
  assertEquals(strandedLandedCents(line({ quantity: 4, quantity_received: 1, quantity_canceled: 3, landed_costs: [e] })), 7_500);
  // Received in full: nothing stranded.
  assertEquals(strandedLandedCents(line({ quantity: 4, quantity_received: 4, landed_costs: [e] })), 0);
  // No entries, or absent: nothing.
  assertEquals(strandedLandedCents(line({ quantity: 4, quantity_canceled: 4 })), 0);
});

Deno.test("isLandedCostFrozen: frozen once a receipt after the entry has priced it", () => {
  const e = entry({ received_at_entry: 2 });
  assertEquals(isLandedCostFrozen(e, { quantity_received: 2 }), false);
  assertEquals(isLandedCostFrozen(e, { quantity_received: 3 }), true);
  // A reversal back to the entry point thaws it: nothing priced it any more.
  assertEquals(isLandedCostFrozen(e, { quantity_received: 1 }), false);
});

Deno.test("allocateLandedCostCents: weights are the value still to arrive, and a split over nothing is refused", () => {
  const half = line({ quantity: 4, amount_cents: 40_000, quantity_received: 2 });
  assertEquals(landedCostWeightCents(half), 20_000);
  const done = line({ quantity: 2, amount_cents: 10_000, quantity_received: 2 });
  assertEquals(allocateLandedCostCents(5_000, [half, done]), [5_000, 0]);
  assertThrows(() => allocateLandedCostCents(5_000, [done]), RangeError);
});

Deno.test("PurchaseSchema: a landed cost's own refines, one field at a time", () => {
  const at = (e: PurchaseLandedCost) => issuePaths(PurchaseSchema, purchase({ items: [line({ landed_costs: [e] })] }));
  assertEquals(issuePaths(PurchaseSchema, purchase({ items: [line({ landed_costs: [entry()] })] })), []);
  assertEquals(at(entry({ amount_cents: 0 })), ["items.0.landed_costs.0.amount_cents"]);
  assertEquals(at(entry({ quantity: 0 })), ["items.0.landed_costs.0.quantity"]);
  assertEquals(at(entry({ quantity: 2, received_at_entry: 2 })), ["items.0.landed_costs.0.quantity"]);
  assertEquals(at(entry({ uid: "not-a-uuid" })), ["items.0.landed_costs.0.uid"]);
  assertEquals(
    issuePaths(PurchaseSchema, purchase({ items: [line({ landed_costs: [entry(), entry({ quantity: 1 })] })] })),
    ["items.0.landed_costs.1.uid"],
  );
});

Deno.test("landed cost inputs: a subrent item cannot carry them; a buy item input refuses a uid named twice", () => {
  const sub = PurchaseItemInput.safeParse({
    type: "subrent",
    uid_product: PRODUCT,
    quantity: 1,
    billing: { basis: "fixed", amount_cents: 100 },
    dates: HIRE,
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
