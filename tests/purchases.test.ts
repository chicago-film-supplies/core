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
  type PurchaseLine,
  PurchaseBillSchema,
  PurchaseCreditSchema,
  PurchaseSchema,
  ReceivePurchaseInput,
} from "../src/schemas/mod.ts";
import {
  cumulativeShareCents,
  expandPurchaseLines,
  type PurchaseExpansionComponent,
  type PurchaseExpansionProduct,
  remainingToBill,
  remainingToReceive,
} from "../src/utils/purchases.ts";
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
    assertEquals(derivePurchaseStatus({ lines: lines.map((l) => line(l)) }), want, name);
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
    lines: [line()],
    total_cents: 140985,
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
    issuePaths(PurchaseSchema, purchase({ lines: [line(), line()], total_cents: 281970 })),
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
