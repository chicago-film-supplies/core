/**
 * Purchases (api-cloudrun#1210) — the cumulative share that prices receipts and
 * bill lines, the status rule, and the three documents' refines.
 *
 * Every refine is asserted in pairs from one valid factory, mutating ONE field
 * per negative case, so a case cannot pass by failing for some other reason
 * (`core/CLAUDE.md` § *Making a field REQUIRED*).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CreatePurchaseBillInput,
  CreatePurchaseInput,
  derivePurchaseStatus,
  type PurchaseLandedCost,
  type PurchaseLine,
  PurchaseLineInput,
  PurchaseBillSchema,
  PurchaseCreditSchema,
  PurchaseSchema,
  ReceivePurchaseInput,
  ReturnPurchaseInput,
  UpdatePurchaseInput,
} from "../src/schemas/mod.ts";
import {
  allocateLandedCostCents,
  cumulativeShareCents,
  expandPurchaseLines,
  isLandedCostFrozen,
  landedCostWeightCents,
  landedUnitsPriced,
  purchaseLineReceiptTargetCents,
  strandedLandedCents,
  type PurchaseExpansionComponent,
  type PurchaseExpansionProduct,
  deriveQueryByOrders,
  deriveQueryByProducts,
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

/** A random path 0 → quantity in positive steps: a line's receipts, or its bills. */
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

// ── status ───────────────────────────────────────────────────────────

const line = (over: Partial<PurchaseLine> = {}): PurchaseLine => ({
  uid_product: "testprod100000000000",
  name: "Walkie Talkie",
  quantity: 3,
  amount_cents: 140985,
  expected_date: null,
  quantity_received: 0,
  quantity_billed: 0,
  quantity_canceled: 0,
  landed_costs: [],
  ...over,
});

Deno.test("derivePurchaseStatus — the table", () => {
  const cases: [string, Partial<PurchaseLine>[], string][] = [
    ["nothing yet", [{}], "active"],
    ["billed, not received — #3882's real state", [{ quantity_billed: 3 }], "active"],
    ["received in full, unbilled", [{ quantity_received: 3 }], "active"],
    ["received and billed", [{ quantity_received: 3, quantity_billed: 3 }], "complete"],
    ["short-closed after 2, billed 2", [{ quantity_received: 2, quantity_billed: 2, quantity_canceled: 1 }], "complete"],
    ["short-closed after 2, billed 1", [{ quantity_received: 2, quantity_billed: 1, quantity_canceled: 1 }], "active"],
    ["canceled outright", [{ quantity_canceled: 3 }], "canceled"],
    ["one line done, one canceled", [{ quantity_received: 3, quantity_billed: 3 }, { quantity_canceled: 3 }], "complete"],
    ["one line done, one open", [{ quantity_received: 3, quantity_billed: 3 }, {}], "active"],
  ];
  for (const [name, lines, want] of cases) {
    assertEquals(derivePurchaseStatus({ kind: "buy", lines: lines.map((l) => line(l)) }), want, name);
  }
});

Deno.test("remainingToReceive / remainingToBill are each bounded by what was canceled", () => {
  const l = line({ quantity_received: 1, quantity_billed: 2, quantity_canceled: 1 });
  assertEquals(remainingToReceive(l), 1);
  assertEquals(remainingToBill(l), 0);
});

// ── purchases ────────────────────────────────────────────────────────

const actor = { uid: "testuser100000000000", name: "Test User" };
const SUPPLIER = { uid: "testsupp100000000000", name: "Baycom" };

function purchase(over: Record<string, unknown> = {}) {
  const lines = (over.lines as PurchaseLine[] | undefined) ?? [line()];
  return {
    uid: "testpurch10000000000",
    number: 1,
    status: "active",
    kind: "buy",
    supplier: SUPPLIER,
    store: { uid: "teststore10000000000", name: "Main" },
    date: "2026-10-01T00:00:00.000-05:00",
    date_fs: mockTimestamp,
    reference: "Q-1182",
    notes: null,
    lines,
    total_cents: 140985,
    query_by_products: deriveQueryByProducts(lines),
    query_by_orders: deriveQueryByOrders(lines),
    version: 0,
    created_by: actor,
    updated_by: actor,
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...over,
  };
}

function issuePaths(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } }, doc: unknown): string[] {
  const r = schema.safeParse(doc);
  return r.success ? [] : r.error!.issues.map((i) => i.path.join("."));
}

Deno.test("PurchaseSchema accepts a valid purchase", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase()), []);
});

Deno.test("PurchaseSchema: received + canceled may not exceed the quantity ordered", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [line({ quantity_received: 2, quantity_canceled: 2 })] })), [
    "lines.0.quantity_received",
  ]);
});

Deno.test("PurchaseSchema: billed + canceled may not exceed the quantity ordered", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [line({ quantity_billed: 3, quantity_canceled: 1 })] })), [
    "lines.0.quantity_billed",
  ]);
});

Deno.test("PurchaseSchema: one line per product", () => {
  assertEquals(
    issuePaths(PurchaseSchema, purchase({ lines: [line(), line()], total_cents: 281970, query_by_products: [line().uid_product] })),
    ["lines.1.uid_product"],
  );
});

Deno.test("PurchaseSchema: total_cents is the Σ of the lines", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ total_cents: 140984 })), ["total_cents"]);
});

Deno.test("PurchaseSchema: a stored status the buckets contradict is refused", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ status: "complete" })), ["status"]);
  assertEquals(
    issuePaths(PurchaseSchema, purchase({ status: "complete", lines: [line({ quantity_received: 3, quantity_billed: 3 })] })),
    [],
  );
});

Deno.test("PurchaseSchema: a purchase orders at least one line", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [], total_cents: 0 })), ["lines"]);
});

Deno.test("CreatePurchaseInput / ReceivePurchaseInput refuse a product named twice", () => {
  const l = { uid_product: "testprod100000000000", quantity: 1, amount_cents: 100 };
  const create = {
    supplier: { uid: SUPPLIER.uid },
    store: { uid: "teststore10000000000" },
    date: "2026-10-01T00:00:00.000-05:00",
    lines: [l, l],
    uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc",
  };
  assertEquals(issuePaths(CreatePurchaseInput, create), ["lines.1.uid_product"]);
  assertEquals(issuePaths(CreatePurchaseInput, { ...create, lines: [l] }), []);

  const r = { uid_product: "testprod100000000000", quantity: 1 };
  const receive = {
    date: "2026-10-05T10:00:00.000-05:00",
    lines: [r, r],
    uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc",
    version: 0,
  };
  assertEquals(issuePaths(ReceivePurchaseInput, receive), ["lines.1.uid_product"]);
  assertEquals(issuePaths(ReceivePurchaseInput, { ...receive, lines: [r] }), []);
});

Deno.test("ReceivePurchaseInput: allocations sum to the quantity, and named units are exactly `quantity`, ascending", () => {
  const receive = (l: Record<string, unknown>) => ({
    date: "2026-10-05T10:00:00.000-05:00",
    lines: [{ uid_product: "testprod100000000000", quantity: 2, ...l }],
    uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc",
    version: 0,
  });
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ allocations: [{ uid_location: "testloc1000000000000", quantity: 1 }] })), [
    "lines.0.quantity",
  ]);
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ units: [{ number: 1 }] })), ["lines.0.units"]);
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ units: [{ number: 2 }, { number: 1 }] })), ["lines.0.units.1"]);
  assertEquals(issuePaths(ReceivePurchaseInput, receive({ units: [{ number: 1, serial_number: "SN1" }, { number: 2 }] })), []);
});

// ── bills ────────────────────────────────────────────────────────────

const billLine = { uid_product: "testprod100000000000", quantity: 3, amount_cents: 140985 };
const XERO_ID = "384eb64a-0000-4000-8000-000000000000";

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
    lines: [billLine],
    direct_lines: [],
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

Deno.test("PurchaseBillSchema: a PUSHED bill's total is its lines'; a LINKED bill's is Xero's and exempt", () => {
  const off = { total_cents: 141000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 141000 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ totals: off })), ["totals.total_cents"]);
  // P0: 21 of 299 historic documents disagree with the CFS basis — linking
  // them must not be refused.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ totals: off, origin: "linked", xero_id: XERO_ID })), []);
});

Deno.test("PurchaseBillSchema: direct lines count toward a pushed total", () => {
  const freight = { description: "Freight", account_code: 5100, amount_cents: 1500 };
  const t = { total_cents: 142485, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 142485 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ direct_lines: [freight], totals: t })), []);
});

Deno.test("PurchaseDirectLine attribution: a legacy three-field line still parses; each field is optional", () => {
  const t = { total_cents: 142485, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 142485 };
  const legacy = { description: "Freight", account_code: 5100, amount_cents: 1500 };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ direct_lines: [legacy], totals: t })), []);
  const charge = {
    description: "Loss charge — steamer",
    account_code: 5100,
    amount_cents: 1500,
    uid_product: "testprod100000000000",
    xero_tracking_option_id: "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607",
    uid_out_of_service: "testoos1000000000000",
  };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ direct_lines: [charge], totals: t })), []);
});

Deno.test("PurchaseDirectLine attribution: a mark_lost record's MovementId parses as uid_out_of_service", () => {
  const t = { total_cents: 142485, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 142485 };
  const movementId = "0199a1f2-3b4c-7d8e-9f01-234567890abc|mark_lost|testordr100000000000:testitem10000000000x:9c2f4a10-6b3d-4e57-8a91-0d5e7c3b2f48";
  const line = { description: "Loss charge", account_code: 5100, amount_cents: 1500, uid_out_of_service: movementId };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ direct_lines: [line], totals: t })), []);
});

Deno.test("PurchaseDirectLine attribution: a null tracking option is refused — absent means none", () => {
  const t = { total_cents: 142485, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 142485 };
  const line = { description: "Freight", account_code: 5100, amount_cents: 1500, xero_tracking_option_id: null };
  assertEquals(issuePaths(PurchaseBillSchema, bill({ direct_lines: [line], totals: t })), ["direct_lines.0.xero_tracking_option_id"]);
});

Deno.test("PurchaseDirectLine stays STRICT inside the push input — an unknown key is a 400, not dropped", () => {
  // The fail-closed half of keeping the node strict: an api predating a field
  // must refuse it rather than store a line with the attribution stripped.
  const push = (line: Record<string, unknown>) =>
    CreatePurchaseBillInput.safeParse({
      mode: "push",
      date: "2026-10-25T00:00:00.000-05:00",
      due_date: "2026-11-24T00:00:00.000-06:00",
      lines: [{ uid_product: "testprod100000000000", quantity: 1, amount_cents: 1000 }],
      direct_lines: [line],
      uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc",
      version: 0,
    });
  const charge = { description: "Loss charge", account_code: 5100, amount_cents: 1500, uid_product: "testprod100000000000" };
  assertEquals(push(charge).success, true, "the otherwise-valid payload parses, so the refusal below is the key alone");
  const r = push({ ...charge, uid_product_typo: "x" });
  assertEquals(
    r.success ? [] : r.error.issues.map((i) => `${i.code}:${i.path.join(".")}`),
    ["unrecognized_keys:direct_lines.0"],
  );
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
  // Control: the base bill (a due date, no mirror yet) parses, so the gap between
  // deploy and backfill stays readable.
  assertEquals(issuePaths(PurchaseBillSchema, bill()), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date_fs: mockTimestamp })), []);
  // A bill with no due date: absent and null are both fine, a timestamp is not.
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date: null })), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date: null, due_date_fs: null })), []);
  assertEquals(issuePaths(PurchaseBillSchema, bill({ due_date: null, due_date_fs: mockTimestamp })), ["due_date_fs"]);
});

Deno.test("PurchaseBillSchema: one line per product, and at least one", () => {
  assertEquals(issuePaths(PurchaseBillSchema, bill({ lines: [billLine, billLine], origin: "linked", xero_id: XERO_ID })), [
    "lines.1.uid_product",
  ]);
  // `.min(1)` and the value rule both name `lines`; either is the refusal.
  assertEquals([...new Set(issuePaths(PurchaseBillSchema, bill({ lines: [], origin: "linked", xero_id: XERO_ID })))], ["lines"]);
});

Deno.test("CreatePurchaseBillInput: push carries dates, link carries a Xero id; neither carries a line amount", () => {
  const lines = [{ uid_product: "testprod100000000000", quantity: 3 }];
  const common = { lines, uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc", version: 0 };
  assertEquals(
    issuePaths(CreatePurchaseBillInput, { mode: "push", date: "2026-10-01T00:00:00.000-05:00", due_date: "2026-10-31T00:00:00.000-05:00", ...common }),
    [],
  );
  assertEquals(issuePaths(CreatePurchaseBillInput, { mode: "link", xero_document: "bank_transaction", xero_id: XERO_ID, ...common }), []);
  assertEquals(issuePaths(CreatePurchaseBillInput, { mode: "push", date: "2026-10-01T00:00:00.000-05:00", ...common }), ["due_date"]);
  assertEquals(
    issuePaths(CreatePurchaseBillInput, { mode: "link", xero_document: "invoice", xero_id: XERO_ID, ...common, lines: [lines[0], lines[0]] }),
    ["lines.1.uid_product"],
  );
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
    lines: [{ uid_product: "testprod100000000000", quantity: 1, amount_cents: 46995 }],
    direct_lines: [],
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

Deno.test("PurchaseCreditSchema: a rebate may carry only direct lines, but a credit with value names one", () => {
  const rebate = { description: "Volume rebate", account_code: 5000, amount_cents: 2000 };
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ lines: [], direct_lines: [rebate], total_cents: 2000, remaining_credit_cents: 2000 })), []);
  // Linked, so the pushed-total rule stays out of it and the ONE issue is this one.
  assertEquals(
    issuePaths(PurchaseCreditSchema, credit({ lines: [], origin: "linked", xero_id: XERO_ID, total_cents: 2000, remaining_credit_cents: 2000 })),
    ["lines"],
  );
});

Deno.test("PurchaseCreditSchema: a PUSHED credit's total is its lines', at the credit's own total_cents", () => {
  assertEquals(issuePaths(PurchaseCreditSchema, credit({ total_cents: 47000, remaining_credit_cents: 47000 })), ["total_cents"]);
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
const D2 = "2026-11-09T00:00:00.000-06:00";

Deno.test("expandPurchaseLines: a stocked product passes through unchanged", () => {
  const lines = [{ uid_product: "410", quantity: 7, amount_cents: 700, expected_date: D1 }];
  assertEquals(expandPurchaseLines(lines, CATALOG), { ok: true, lines });
});

Deno.test("expandPurchaseLines: a pack becomes its stocked component at ×N, carrying the pack's amount", () => {
  assertEquals(expandPurchaseLines([{ uid_product: "118", quantity: 12, amount_cents: 36_000 }], CATALOG), {
    ok: true,
    lines: [{ uid_product: "410", quantity: 480, amount_cents: 36_000 }],
  });
});

Deno.test("expandPurchaseLines: a nested pack reaches the stocked leaf through the uncounted middle", () => {
  assertEquals(expandPurchaseLines([{ uid_product: "353", quantity: 1, amount_cents: 9_000 }], CATALOG), {
    ok: true,
    lines: [{ uid_product: "410", quantity: 240, amount_cents: 9_000 }],
  });
});

Deno.test("expandPurchaseLines: the walk stops at the first counted node, not the uncounted leaf below it", () => {
  assertEquals(expandPurchaseLines([{ uid_product: "611", quantity: 2, amount_cents: 50_000 }], CATALOG), {
    ok: true,
    lines: [{ uid_product: "case", quantity: 80, amount_cents: 50_000 }],
  });
});

Deno.test("expandPurchaseLines: a counted node under a counted node is not a second frontier node", () => {
  assertEquals(expandPurchaseLines([{ uid_product: "crate", quantity: 3, amount_cents: 600 }], CATALOG), {
    ok: true,
    lines: [{ uid_product: "case", quantity: 6, amount_cents: 600 }],
  });
});

Deno.test("expandPurchaseLines: an optional component is not part of the pack", () => {
  assertEquals(expandPurchaseLines([{ uid_product: "opt", quantity: 3, amount_cents: 300 }], CATALOG), {
    ok: true,
    lines: [{ uid_product: "410", quantity: 30, amount_cents: 300 }],
  });
});

Deno.test("expandPurchaseLines: the ratio ceils once in integers — 0.07 × 100 is 7, not 8", () => {
  const result = expandPurchaseLines([{ uid_product: "frac", quantity: 100, amount_cents: 100 }], CATALOG);
  assert(result.ok);
  assertEquals(result.lines[0].quantity, 7);
});

Deno.test("expandPurchaseLines: a pack and its stocked product on one purchase merge into one line", () => {
  const result = expandPurchaseLines([
    { uid_product: "410", quantity: 20, amount_cents: 1_000, expected_date: D2 },
    { uid_product: "118", quantity: 2, amount_cents: 6_000, expected_date: D1 },
    { uid_product: "353", quantity: 1, amount_cents: 9_000, expected_date: null },
  ], CATALOG);
  assertEquals(result, {
    ok: true,
    lines: [{ uid_product: "410", quantity: 20 + 80 + 240, amount_cents: 16_000, expected_date: D1 }],
  });
});

Deno.test("expandPurchaseLines: a merge keeps null when no line states a date", () => {
  const result = expandPurchaseLines([
    { uid_product: "410", quantity: 1, amount_cents: 10, expected_date: null },
    { uid_product: "118", quantity: 1, amount_cents: 10, expected_date: null },
  ], CATALOG);
  assert(result.ok);
  assertEquals(result.lines[0].expected_date, null);
});

Deno.test("expandPurchaseLines: refuses a pack with no stocked component — it would receive nothing", () => {
  for (const uid of ["bare", "hollow", "svc"]) {
    const result = expandPurchaseLines([{ uid_product: uid, quantity: 1, amount_cents: 100 }], CATALOG);
    assert(!result.ok, uid);
    assertEquals(result.refusal.reason, "no_stocked_component", uid);
    assertEquals(result.refusal.uid_product, uid);
  }
});

Deno.test("expandPurchaseLines: refuses a kit of several stocked products — one amount has no split rule", () => {
  const result = expandPurchaseLines([{ uid_product: "set", quantity: 1, amount_cents: 100 }], CATALOG);
  assert(!result.ok);
  assertEquals(result.refusal.reason, "several_stocked_components");
  assert(result.refusal.message.includes("hanger") && result.refusal.message.includes("stacker"));
});

Deno.test("expandPurchaseLines: a product the caller did not read is the caller's bug, thrown", () => {
  assertThrows(() => expandPurchaseLines([{ uid_product: "nope", quantity: 1, amount_cents: 1 }], CATALOG));
});

// ── subrents ─────────────────────────────────────────────────────────

const HIRE = { start: "2026-10-18T09:00:00.000-05:00", end: "2026-10-25T17:00:00.000-05:00" };
const ORDER_1074 = "testorder1074000000a";

/** A subrent line of 10 steamers, received and returned per `over`. */
// A subrent line never carries `landed_costs`, so the buy fixture's `[]` comes off.
const hireLine = (over: Partial<PurchaseLine> = {}): PurchaseLine => {
  const l = line({ quantity: 10, amount_cents: 50_000, dates: HIRE, quantity_returned: 0, uid_orders: [ORDER_1074] });
  delete l.landed_costs;
  return { ...l, ...over };
};

function subrent(over: Record<string, unknown> = {}) {
  const lines = (over.lines as PurchaseLine[] | undefined) ?? [hireLine()];
  return purchase({
    kind: "subrent",
    lines,
    total_cents: lines.reduce((sum, l) => sum + l.amount_cents, 0),
    query_by_products: deriveQueryByProducts(lines),
    query_by_orders: deriveQueryByOrders(lines),
    ...over,
  });
}

Deno.test("derivePurchaseStatus — a subrent is complete only once every received unit is RETURNED", () => {
  // Each negative case breaks exactly ONE of the three axes.
  const done = { quantity_received: 10, quantity_billed: 10, quantity_returned: 10 };
  const cases: [string, Partial<PurchaseLine>, string][] = [
    ["received, billed, returned", done, "complete"],
    ["…not returned", { ...done, quantity_returned: 9 }, "active"],
    ["…not billed", { ...done, quantity_billed: 9 }, "active"],
    ["…not received (and so not returned)", { ...done, quantity_received: 9, quantity_returned: 9 }, "active"],
    ["short-closed after 6, billed 6, returned 6", { quantity_received: 6, quantity_billed: 6, quantity_returned: 6, quantity_canceled: 4 }, "complete"],
    ["canceled outright", { quantity_canceled: 10 }, "canceled"],
  ];
  for (const [name, over, want] of cases) {
    assertEquals(derivePurchaseStatus({ kind: "subrent", lines: [hireLine(over)] }), want, name);
  }
  // The return axis is a subrent's alone: the same buckets on a buy read complete.
  assertEquals(derivePurchaseStatus({ kind: "buy", lines: [line({ quantity: 10, ...done, quantity_returned: undefined })] }), "complete");
});

Deno.test("remainingToReturn is received − returned, and 0 on a buy line", () => {
  assertEquals(remainingToReturn(hireLine({ quantity_received: 7, quantity_returned: 3 })), 4);
  assertEquals(remainingToReturn(line({ quantity_received: 3 })), 0);
});

Deno.test("PurchaseSchema accepts a valid subrent", () => {
  assertEquals(issuePaths(PurchaseSchema, subrent()), []);
});

Deno.test("PurchaseSchema: the kind arm — a subrent line states all three members, a buy line none", () => {
  for (const key of ["dates", "quantity_returned", "uid_orders"] as const) {
    const without = hireLine();
    delete without[key];
    assertEquals(issuePaths(PurchaseSchema, subrent({ lines: [without], query_by_orders: deriveQueryByOrders([without]) })), [
      `lines.0.${key}`,
    ], `subrent without ${key}`);
  }
  for (const [key, value] of [["dates", HIRE], ["quantity_returned", 0], ["uid_orders", []]] as const) {
    assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [line({ [key]: value })] })), [`lines.0.${key}`], `buy with ${key}`);
    assertEquals(
      issuePaths(PurchaseSchema, purchase({ kind: "buy", lines: [line({ [key]: value })] })),
      [`lines.0.${key}`],
      `explicit buy with ${key}`,
    );
  }
});

Deno.test("PurchaseSchema: returned may not exceed received, and a hire may not end before it starts", () => {
  assertEquals(issuePaths(PurchaseSchema, subrent({ lines: [hireLine({ quantity_received: 3, quantity_returned: 4 })] })), [
    "lines.0.quantity_returned",
  ]);
  assertEquals(issuePaths(PurchaseSchema, subrent({ lines: [hireLine({ dates: { start: HIRE.end, end: HIRE.start } })] })), [
    "lines.0.dates.end",
  ]);
});

Deno.test("PurchaseSchema: kind and both mirrors are required, and a mirror must be exact", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase()), []);
  const { kind: _k, ...noKind } = purchase();
  assertEquals(issuePaths(PurchaseSchema, noKind), ["kind"]);
  const { query_by_products: _p, ...noProducts } = purchase();
  assertEquals(issuePaths(PurchaseSchema, noProducts), ["query_by_products"]);
  const { query_by_orders: _o, ...noOrders } = purchase();
  assertEquals(issuePaths(PurchaseSchema, noOrders), ["query_by_orders"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_products: [] })), ["query_by_products"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_products: ["testprod200000000000"] })), ["query_by_products"]);
  assertEquals(issuePaths(PurchaseSchema, subrent({ query_by_orders: [] })), ["query_by_orders"]);
  assertEquals(issuePaths(PurchaseSchema, purchase({ query_by_orders: [ORDER_1074] })), ["query_by_orders"]);
});

Deno.test("deriveQueryByOrders is the distinct union, first-seen order", () => {
  assertEquals(deriveQueryByOrders([{ uid_orders: ["a", "b"] }, { uid_orders: ["b", "c"] }, {}]), ["a", "b", "c"]);
});

Deno.test("CreatePurchaseInput: a subrent names a hire on every line, a buy names none", () => {
  const l = { uid_product: "testprod100000000000", quantity: 10, amount_cents: 50_000 };
  const create = (over: Record<string, unknown>) => ({
    supplier: { uid: SUPPLIER.uid },
    store: { uid: "teststore10000000000" },
    date: "2026-10-17T00:00:00.000-05:00",
    uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc",
    lines: [l],
    ...over,
  });
  assertEquals(issuePaths(CreatePurchaseInput, create({ kind: "subrent", lines: [{ ...l, dates: HIRE }] })), []);
  assertEquals(issuePaths(CreatePurchaseInput, create({ kind: "subrent" })), ["lines.0.dates"]);
  assertEquals(issuePaths(CreatePurchaseInput, create({ lines: [{ ...l, dates: HIRE }] })), ["lines.0.dates"]);
  assertEquals(issuePaths(CreatePurchaseInput, create({ kind: "buy", lines: [{ ...l, uid_orders: [] }] })), ["lines.0.uid_orders"]);
  assertEquals(
    issuePaths(CreatePurchaseInput, create({ kind: "subrent", lines: [{ ...l, dates: { start: HIRE.end, end: HIRE.start } }] })),
    ["lines.0.dates.end"],
  );
  // An update cannot see the kind; it carries the members and its writer checks them.
  assertEquals(issuePaths(UpdatePurchaseInput, { version: 0, lines: [{ ...l, dates: HIRE }] }), []);
});

Deno.test("ReturnPurchaseInput: allocations sum to the quantity and never name units", () => {
  const ret = (lineOver: Record<string, unknown>) => ({
    date: "2026-10-25T10:00:00.000-05:00",
    lines: [{ uid_product: "testprod100000000000", quantity: 10, ...lineOver }],
    uuid_session: "0199a1f2-3b4c-7d8e-9f01-234567890abc",
    version: 3,
  });
  assertEquals(issuePaths(ReturnPurchaseInput, ret({})), []);
  assertEquals(issuePaths(ReturnPurchaseInput, ret({ allocations: [{ uid_location: "testloc1000000000000", quantity: 9 }] })), [
    "lines.0.quantity",
  ]);
  assertEquals(
    issuePaths(ReturnPurchaseInput, ret({ quantity: 1, allocations: [{ uid_location: "testloc1000000000000", quantity: 1, units: [4] }] })),
    ["lines.0.allocations"],
  );
});

Deno.test("expandPurchaseLines: a subrent pack expands carrying its hire and orders", () => {
  assertEquals(
    expandPurchaseLines([{ uid_product: "118", quantity: 1, amount_cents: 900, dates: HIRE, uid_orders: [ORDER_1074] }], CATALOG),
    { ok: true, lines: [{ uid_product: "410", quantity: 40, amount_cents: 900, dates: HIRE, uid_orders: [ORDER_1074] }] },
  );
});

Deno.test("expandPurchaseLines: two subrent lines on one product merge only within one hire window", () => {
  const same = expandPurchaseLines([
    { uid_product: "410", quantity: 10, amount_cents: 100, dates: HIRE, uid_orders: ["o1"] },
    { uid_product: "118", quantity: 1, amount_cents: 900, dates: { ...HIRE }, uid_orders: ["o2", "o1"] },
  ], CATALOG);
  assertEquals(same, { ok: true, lines: [{ uid_product: "410", quantity: 50, amount_cents: 1_000, dates: HIRE, uid_orders: ["o1", "o2"] }] });

  const other = expandPurchaseLines([
    { uid_product: "410", quantity: 10, amount_cents: 100, dates: HIRE, uid_orders: [] },
    { uid_product: "118", quantity: 1, amount_cents: 900, dates: { start: HIRE.start, end: "2026-10-26T17:00:00.000-05:00" }, uid_orders: [] },
  ], CATALOG);
  assert(!other.ok);
  assertEquals(other.refusal.reason, "different_hire_windows");
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
function journalAlong(l: PurchaseLine, path: number[]): number[] {
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

Deno.test("PurchaseSchema: landed costs are present-iff-buy — a buy line states them, `[]` at least", () => {
  assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [line({ landed_costs: [entry()] })] })), []);
  assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [line({ landed_costs: [] })] })), []);
  const absent = line();
  delete absent.landed_costs;
  assertEquals(issuePaths(PurchaseSchema, purchase({ lines: [absent] })), ["lines.0.landed_costs"]);
});

Deno.test("PurchaseSchema: a landed cost is refused on a subrent line", () => {
  assertEquals(issuePaths(PurchaseSchema, subrent({ lines: [hireLine({ landed_costs: [] })] })), ["lines.0.landed_costs"]);
});

Deno.test("PurchaseSchema: a landed cost's own refines, one field at a time", () => {
  const at = (e: PurchaseLandedCost) => issuePaths(PurchaseSchema, purchase({ lines: [line({ landed_costs: [e] })] }));
  assertEquals(at(entry({ amount_cents: 0 })), ["lines.0.landed_costs.0.amount_cents"]);
  assertEquals(at(entry({ quantity: 0 })), ["lines.0.landed_costs.0.quantity"]);
  assertEquals(at(entry({ quantity: 2, received_at_entry: 2 })), ["lines.0.landed_costs.0.quantity"]);
  assertEquals(at(entry({ uid: "not-a-uuid" })), ["lines.0.landed_costs.0.uid"]);
  assertEquals(
    issuePaths(PurchaseSchema, purchase({ lines: [line({ landed_costs: [entry(), entry({ quantity: 1 })] })] })),
    ["lines.0.landed_costs.1.uid"],
  );
});

Deno.test("landed cost inputs: a subrent create refuses them; a line input refuses a uid named twice", () => {
  const create = CreatePurchaseInput.safeParse({
    kind: "subrent",
    supplier: { uid: "testsupp100000000000" },
    store: { uid: "teststore10000000000" },
    date: "2026-10-01T00:00:00.000-05:00",
    lines: [{ uid_product: "testprod100000000000", quantity: 1, amount_cents: 100, dates: HIRE, landed_costs: [] }],
    uuid_session: "8c1e2a4f-0000-4000-8000-0000000000ff",
  });
  assert(!create.success);
  assert(create.error.issues.some((i) => i.path.join(".") === "lines.0.landed_costs"), JSON.stringify(create.error.issues));
  const twice = PurchaseLineInput.safeParse({
    uid_product: "testprod100000000000",
    quantity: 1,
    amount_cents: 100,
    landed_costs: [
      { uid: entry().uid, description: "Freight", amount_cents: 1 },
      { uid: entry().uid, description: "Duty", amount_cents: 1 },
    ],
  });
  assert(!twice.success);
  assertEquals(twice.error.issues.map((i) => i.path.join(".")), ["landed_costs.1.uid"]);
});

Deno.test("expandPurchaseLines: landed costs ride a pack onto its component, and concatenate on a merge", () => {
  const freight = { description: "Freight", amount_cents: 500 };
  const duty = { description: "Duty", amount_cents: 200 };
  assertEquals(
    expandPurchaseLines([
      { uid_product: "410", quantity: 10, amount_cents: 100, landed_costs: [freight] },
      { uid_product: "118", quantity: 1, amount_cents: 900, landed_costs: [duty] },
    ], CATALOG),
    { ok: true, lines: [{ uid_product: "410", quantity: 50, amount_cents: 1_000, landed_costs: [freight, duty] }] },
  );
  // Absent on both stays absent: "keep what is stored" must survive a merge.
  const merged = expandPurchaseLines([
    { uid_product: "410", quantity: 10, amount_cents: 100 },
    { uid_product: "118", quantity: 1, amount_cents: 900 },
  ], CATALOG);
  assert(merged.ok);
  assertEquals("landed_costs" in merged.lines[0], false);
});
