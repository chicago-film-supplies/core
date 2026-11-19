/**
 * The settlements journal — the contract table, the signed fold, and the
 * three-term invoice identity.
 *
 * The property that matters most here is that **the totals are a plain signed
 * fold with no filtering**. That is what deleted the live/reversed/reversal
 * trichotomy along with the `R2 → R1 → S1` chain that silently vanished money
 * when the derivation got it wrong, and it is why an invoice can do and undo
 * perpetually with correct totals after every append.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  CREDIT_NOTE_REASONS,
  CreateSettlementInput,
  getSettlementMultiplier,
  isBillingSettlement,
  isSideSettlement,
  PURCHASE_CREDIT_REASONS,
  ReverseSettlementInput,
  type Settlement,
  SETTLEMENT_CONTRACTS,
  settlementContract,
  type SettlementReasonType,
  SettlementReasonEnum,
  settlementReasonLegal,
  SettlementSchema,
  settlementSide,
  type SettlementTypeType,
  type Side,
  SIDE_COLLECTIONS,
  SIDE_CONTRACTS,
  SIDES,
} from "../src/schemas/mod.ts";
import {
  creditRemainingFromJournal,
  deriveInvoiceStatus,
  invoiceIsFrozen,
  recomputeSettlementTotals,
} from "../src/utils/invoices.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";
import type { InvoiceStatusType } from "../src/schemas/mod.ts";

/**
 * The old `derivePaymentStatus(status, paid, due, credited)` argument order over
 * {@link deriveInvoiceStatus}, so these cases read as they did before the rename.
 * `total_cents` is reconstructed as `paid + credited + due`, which is the
 * identity every stored invoice satisfies.
 */
const derive = (status: InvoiceStatusType, paid: number, due: number, credited = 0) =>
  deriveInvoiceStatus({
    status,
    totals: { total_cents: paid + credited + due, amount_paid_cents: paid, amount_credited_cents: credited, amount_due_cents: due },
  });

const ORG = "testorg1000000000000";
const INV = "testinv1000000000000";
const SETTLEMENT = "teststl1000000000000";

const SUPPLIER = "testsup1000000000000";
const BILL = "testpbl1000000000000";
const NOTE = "testcrn1000000000000";
const PCREDIT = "testpcr1000000000000";

/** The refs a row of `type` on `side` names, read off its contract. */
function refsFor(side: Side, type: SettlementTypeType) {
  const c = SETTLEMENT_CONTRACTS[type];
  const cols = SIDE_COLLECTIONS[side];
  return {
    billing: c.settles === "billing" ? { collection: cols.billing, uid: side === "receivable" ? INV : BILL } : null,
    credit: c.draws_credit
      ? { collection: cols.credit, uid: side === "receivable" ? NOTE : PCREDIT, label: side === "receivable" ? "CN-1030" : null }
      : null,
  };
}

/** A settlement row reduced to what the totals fold reads, receivable unless `side` says otherwise. */
const S = (
  o: Partial<{ type: SettlementTypeType; reason: SettlementReasonType; amount_cents: number; side: Side }> = {},
) => {
  const type = o.type ?? "payment";
  return {
    type,
    reason: o.reason ?? ("paid" as SettlementReasonType),
    amount_cents: o.amount_cents ?? 0,
    ...refsFor(o.side ?? "receivable", type),
  };
};

/** The first reason `side` labels on `type` — a legal one by construction. */
const firstReason = (side: Side, type: SettlementTypeType) =>
  Object.keys(SIDE_CONTRACTS[side].settlement_reasons[type])[0] as SettlementReasonType;

/**
 * A row that parses for ANY type on EITHER side, built from the contract and
 * the side table alone — the refs the type's role demands, a legal reason, the
 * reversal link its contract requires. Every refusal starts here and changes ONE
 * thing.
 */
function rowFor(side: Side, type: SettlementTypeType, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const c = SETTLEMENT_CONTRACTS[type];
  return {
    uid: SETTLEMENT,
    ...refsFor(side, type),
    uid_counterparty: side === "receivable" ? ORG : SUPPLIER,
    type,
    reason: firstReason(side, type),
    amount_cents: c.counts_into !== null ? 0 : 100,
    date: "2026-08-01T14:32:07.881-05:00",
    date_fs: mockTimestamp,
    reference: null,
    uuid_session: "0195f3a1-0000-7000-8000-000000000001",
    reverses: c.reverses === "required" ? SETTLEMENT : null,
    xero_id: null,
    synced_at: null,
    legacy_payment_uid: null,
    version: 0,
    created_by: { uid: ORG, name: "Bot" },
    updated_by: { uid: ORG, name: "Bot" },
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...overrides,
  };
}

/** A complete, valid receivable payment document. */
const makeSettlement = (overrides: Record<string, unknown> = {}) =>
  rowFor("receivable", (overrides.type as SettlementTypeType | undefined) ?? "payment", { amount_cents: 50_000, ...overrides });

/** A well-formed Xero id. */
const XERO = "edf5d932-0000-4000-8000-000000000001";

// ── The contract table ───────────────────────────────────────────

Deno.test("getSettlementMultiplier is DERIVED from the contract, never declared", () => {
  // A type that must name what it reverses IS a retraction; one that must not IS
  // an application. Two facts that could disagree become one that cannot.
  for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
    const expected = SETTLEMENT_CONTRACTS[type].reverses === "required" ? -1 : 1;
    assertEquals(getSettlementMultiplier(type), expected, type);
  }
  assertEquals(getSettlementMultiplier("payment"), 1);
  assertEquals(getSettlementMultiplier("payment_reversal"), -1);
  assertEquals(getSettlementMultiplier("credit"), 1);
  assertEquals(getSettlementMultiplier("credit_reversal"), -1);
});

Deno.test("ten types, five pairs, no side in the name (ruling 44)", () => {
  const types = Object.keys(SETTLEMENT_CONTRACTS).sort();
  assertEquals(types, [
    "closure",
    "closure_reversal",
    "credit",
    "credit_reversal",
    "payment",
    "payment_reversal",
    "refund",
    "refund_reversal",
    "void",
    "void_reversal",
  ]);
  // Every application has its reversal, and only reversals end in `_reversal`.
  for (const t of types) {
    if (t.endsWith("_reversal")) assertEquals(types.includes(t.slice(0, -"_reversal".length)), true, t);
    assertEquals(SETTLEMENT_CONTRACTS[t as SettlementTypeType].reverses === "required", t.endsWith("_reversal"), t);
  }
});

Deno.test("every settlement type routes to exactly one billing total", () => {
  // `sums_into` is load-bearing: without a declared target a credit row would
  // be silently summed into `amount_paid`.
  assertEquals(SETTLEMENT_CONTRACTS.payment.sums_into, "amount_paid_cents");
  assertEquals(SETTLEMENT_CONTRACTS.payment_reversal.sums_into, "amount_paid_cents");
  assertEquals(SETTLEMENT_CONTRACTS.credit.sums_into, "amount_credited_cents");
  assertEquals(SETTLEMENT_CONTRACTS.credit_reversal.sums_into, "amount_credited_cents");
  assertEquals(SETTLEMENT_CONTRACTS.void.sums_into, "amount_void_cents");
  assertEquals(SETTLEMENT_CONTRACTS.void_reversal.sums_into, "amount_void_cents");
});

Deno.test("the void pair matches the shape of the other two — do/undo, no external id", () => {
  // Xero annuls the DOCUMENT, not a settlement, so there is no Xero object for
  // the row to name; the document's own `xero_id` is the linkage.
  assertEquals(SETTLEMENT_CONTRACTS.void.xero_object, null);
  assertEquals(SETTLEMENT_CONTRACTS.void_reversal.xero_object, null);
  assertEquals(SETTLEMENT_CONTRACTS.void.reverses, "forbidden");
  assertEquals(SETTLEMENT_CONTRACTS.void_reversal.reverses, "required");
  assertEquals(getSettlementMultiplier("void"), 1);
  assertEquals(getSettlementMultiplier("void_reversal"), -1);
});

Deno.test("a void's reason is `voided`, NOT `source_retracted`", () => {
  // `source_retracted` means "the originating system no longer reports it" — the
  // reap. A void is the opposite kind of fact: the document IS reported, annulled.
  for (const side of SIDES) {
    assertEquals(settlementReasonLegal(side, "void", "voided"), true, side);
    assertEquals(settlementReasonLegal(side, "void", "source_retracted"), false, side);
    assertEquals(SettlementSchema.safeParse(rowFor(side, "void", { reason: "source_retracted" })).success, false, side);
    assertEquals(SettlementSchema.safeParse(rowFor(side, "void", { reason: "voided" })).success, true, side);
  }
});

Deno.test("settlementContract tolerates an unknown type rather than throwing", () => {
  assertEquals(settlementContract("payment")?.sums_into, "amount_paid_cents");
  assertEquals(settlementContract("refund")?.settles, "credit");
  assertEquals(settlementContract("bill_payment"), undefined, "the prefixed types are gone");
  assertEquals(settlementContract("not_a_type"), undefined);
  assertEquals(settlementContract(""), undefined);
});

Deno.test("a reversal carries NO external id — it is a CFS event", () => {
  for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
    if (SETTLEMENT_CONTRACTS[type].reverses === "required") assertEquals(SETTLEMENT_CONTRACTS[type].xero_object, null, type);
  }
  // …and the applications that carry one say what it names.
  assertEquals(SETTLEMENT_CONTRACTS.payment.xero_object, "payment");
  assertEquals(SETTLEMENT_CONTRACTS.credit.xero_object, "credit_note");
  assertEquals(SETTLEMENT_CONTRACTS.refund.xero_object, "payment");
  assertEquals(SETTLEMENT_CONTRACTS.closure.xero_object, null);
});

// ── Schema enforcement ───────────────────────────────────────────

Deno.test("SettlementSchema accepts a well-formed payment", () => {
  assertEquals(SettlementSchema.safeParse(makeSettlement()).success, true);
});

Deno.test("an illegal (type, reason) pair is rejected", () => {
  // `bad_debt` is a credit reason; a cash payment cannot carry it.
  const bad = SettlementSchema.safeParse(makeSettlement({ reason: "bad_debt" }));
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["reason"]);
  // ...and `paid` is not a credit reason.
  assertEquals(SettlementSchema.safeParse(rowFor("receivable", "credit", { reason: "paid" })).success, false);
});

Deno.test("only a type with a Xero counterpart may carry a xero_id", () => {
  for (const side of SIDES) {
    for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
      const r = SettlementSchema.safeParse(rowFor(side, type, { xero_id: XERO }));
      assertEquals(r.success, SETTLEMENT_CONTRACTS[type].xero_object !== null, `${side} ${type}`);
      if (!r.success) assertEquals(r.error.issues.map((i) => i.path.join(".")), ["xero_id"], `${side} ${type}`);
    }
  }
});

Deno.test("xero_id is a Xero id: a UUID, never a free string (ruling 129)", () => {
  const r = SettlementSchema.safeParse(makeSettlement({ xero_id: "1234" }));
  assertEquals(r.success, false);
  assertEquals(r.error?.issues[0].path, ["xero_id"]);
});

Deno.test("reverses is required on a reversal and forbidden on an application", () => {
  const missing = SettlementSchema.safeParse(rowFor("receivable", "payment_reversal", { reverses: null }));
  assertEquals(missing.success, false);
  assertEquals(missing.error?.issues[0].path, ["reverses"]);

  const stray = SettlementSchema.safeParse(makeSettlement({ reverses: SETTLEMENT }));
  assertEquals(stray.success, false);
  assertEquals(stray.error?.issues[0].path, ["reverses"]);

  assertEquals(SettlementSchema.safeParse(rowFor("receivable", "payment_reversal")).success, true);
});

Deno.test("amount_cents is a non-negative integer — the sign lives in the type", () => {
  assertEquals(SettlementSchema.safeParse(makeSettlement({ amount_cents: -1 })).success, false);
  assertEquals(SettlementSchema.safeParse(makeSettlement({ amount_cents: 10.5 })).success, false);
  assertEquals(SettlementSchema.safeParse(makeSettlement({ amount_cents: 0 })).success, true);
});

Deno.test("date is a Chicago INSTANT, not a start-of-day", () => {
  // A settlement is an event. Truncating to midnight would collapse a busy day's
  // settlements into a tie on the one axis bitemporal reporting needs ordered.
  const parsed = SettlementSchema.safeParse(makeSettlement());
  assertEquals(parsed.success, true);
  assertEquals((parsed.data as { date: string }).date, "2026-08-01T14:32:07.881-05:00", "the time of day was truncated");
});

// ── The signed fold ──────────────────────────────────────────────

const fold = (total: number, rows: ReturnType<typeof S>[]) => recomputeSettlementTotals("receivable", total, rows);

Deno.test("a do/undo pair nets to zero ARITHMETICALLY, not by filtering", () => {
  const r = fold(100_000, [
    S({ amount_cents: 500_00 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 500_00 }),
  ]);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_due_cents, 100_000);
});

Deno.test("R2 → R1 → S1: the chain that vanished money under a liveness derivation", () => {
  // Under the fold it is +500 −500 +500, correct at EVERY prefix.
  const rows = [
    S({ amount_cents: 500_00 }),
    S({ type: "payment_reversal", reason: "correction", amount_cents: 500_00 }),
    S({ reason: "correction", amount_cents: 500_00 }),
  ];
  assertEquals(fold(100_000, rows.slice(0, 1)).amount_paid_cents, 50_000);
  assertEquals(fold(100_000, rows.slice(0, 2)).amount_paid_cents, 0);
  assertEquals(fold(100_000, rows).amount_paid_cents, 50_000);
  assertEquals(fold(100_000, rows).amount_due_cents, 50_000);
});

Deno.test("the fold is order-independent — no second pass, no sequencing", () => {
  const rows = [
    S({ amount_cents: 300_00 }),
    S({ type: "payment_reversal", reason: "correction", amount_cents: 300_00 }),
    S({ type: "credit", reason: "bad_debt", amount_cents: 250_00 }),
    S({ amount_cents: 700_00 }),
  ];
  const forward = fold(100_000, rows);
  const reversed = fold(100_000, [...rows].reverse());
  assertEquals(forward.amount_paid_cents, reversed.amount_paid_cents);
  assertEquals(forward.amount_credited_cents, reversed.amount_credited_cents);
  assertEquals(forward.amount_due_cents, reversed.amount_due_cents);
});

Deno.test("credits route to amount_credited and never reduce total", () => {
  // #1301's shape: billed 18,196 / collected 16,000 / wrote off 2,196.
  const r = fold(1_819_600, [
    S({ amount_cents: 16_000_00 }),
    S({ type: "credit", reason: "bad_debt", amount_cents: 2_196_00 }),
  ]);
  assertEquals(r.amount_paid_cents, 1_600_000);
  assertEquals(r.amount_credited_cents, 219_600);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("#1322: fully credited with ZERO cash collected", () => {
  const r = fold(449_562, [S({ type: "credit", reason: "unspecified", amount_cents: 449_562 })]);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_credited_cents, 449_562);
  assertEquals(r.amount_due_cents, 0);
  assertEquals(derive("issued", r.amount_paid_cents, r.amount_due_cents, r.amount_credited_cents), "credited");
});

Deno.test("an over-credited invoice stays NEGATIVE — clamping hides the defect", () => {
  const r = fold(10_000, [S({ type: "credit", reason: "goodwill", amount_cents: 150_00 })]);
  assertEquals(r.amount_credited_cents, 15_000);
  assertEquals(r.amount_due_cents, -5_000);
});

// ── The void bucket (api-cloudrun#436) ───────────────────────────

Deno.test("a void folds to due = 0, and it is DERIVED rather than assigned", () => {
  const r = fold(247_000, [S({ type: "void", reason: "voided", amount_cents: 247_000 })]);
  assertEquals(r.amount_void_cents, 247_000);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_credited_cents, 0);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("void_reversal restores due = total — un-voiding is an APPEND, not an edit", () => {
  const rows = [
    S({ type: "void", reason: "voided", amount_cents: 247_000 }),
    S({ type: "void_reversal", reason: "correction", amount_cents: 247_000 }),
  ];
  const r = fold(247_000, rows);
  assertEquals(r.amount_void_cents, 0);
  assertEquals(r.amount_due_cents, 247_000);
  const reversed = fold(247_000, [...rows].reverse());
  assertEquals(reversed.amount_void_cents, r.amount_void_cents);
  assertEquals(reversed.amount_due_cents, r.amount_due_cents);
});

Deno.test("voiding a PART-PAID invoice: the payment is reaped, the void takes the whole total", () => {
  const r = fold(100_000, [
    S({ amount_cents: 40_000 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 40_000 }),
    S({ type: "void", reason: "voided", amount_cents: 100_000 }),
  ]);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_void_cents, 100_000);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("a void row does NOT land in the credited bucket — the two-way `else` is gone", () => {
  const r = fold(247_000, [S({ type: "void", reason: "voided", amount_cents: 247_000 })]);
  assertEquals(r.amount_credited_cents, 0, "a void is not a write-off");
  assertEquals(r.breakdown.voided, 247_000);
});

Deno.test("deriveInvoiceStatus leaves `void` alone — status is an explicit move", () => {
  const voided = fold(247_000, [S({ type: "void", reason: "voided", amount_cents: 247_000 })]);
  assertEquals(derive("void", voided.amount_paid_cents, voided.amount_due_cents, voided.amount_credited_cents), "void");
  const unvoided = fold(247_000, [
    S({ type: "void", reason: "voided", amount_cents: 247_000 }),
    S({ type: "void_reversal", reason: "correction", amount_cents: 247_000 }),
  ]);
  assertEquals(
    derive("void", unvoided.amount_paid_cents, unvoided.amount_due_cents),
    "void",
    "the reversal alone does not un-void; the status move is separate and deliberate",
  );
  assertEquals(derive("issued", unvoided.amount_paid_cents, unvoided.amount_due_cents), "issued");
});

Deno.test("integer cents are exact where a float fold would drift", () => {
  const rows = Array.from({ length: 300 }, () => S({ amount_cents: 7 }));
  const r = fold(2_100, rows);
  assertEquals(r.amount_paid_cents, 2_100);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("the per-reason breakdown is free and answers the reporting question", () => {
  const r = fold(100_000, [
    S({ amount_cents: 400_00 }),
    S({ type: "credit", reason: "early_return", amount_cents: 100_00 }),
    S({ type: "credit", reason: "early_return", amount_cents: 50_00 }),
    S({ type: "credit", reason: "goodwill", amount_cents: 25_00 }),
  ]);
  assertEquals(r.breakdown.paid, 40_000);
  assertEquals(r.breakdown.early_return, 15_000);
  assertEquals(r.breakdown.goodwill, 2_500);
  assertEquals(r.breakdown.bad_debt, undefined);
});

Deno.test("a reversal subtracts from its reason's breakdown too", () => {
  const r = fold(100_000, [
    S({ amount_cents: 500_00 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 500_00 }),
  ]);
  assertEquals(r.breakdown.paid, 50_000);
  assertEquals(r.breakdown.source_retracted, -50_000);
});

// ── deriveInvoiceStatus ──────────────────────────────────────────

Deno.test("a fully-credited, never-paid invoice derives credited", () => {
  assertEquals(derive("issued", 0, 0, 2_196), "credited");
});

Deno.test("a partially-credited, never-paid invoice derives part_paid", () => {
  assertEquals(derive("issued", 0, 500, 500), "part_paid");
});

Deno.test("draft and void still pass through regardless of credit", () => {
  assertEquals(derive("draft", 0, 0, 1000), "draft");
  assertEquals(derive("void", 0, 0, 1000), "void");
});

Deno.test("an untouched issued invoice stays issued", () => {
  assertEquals(derive("issued", 0, 1000, 0), "issued");
});

// ── closure (api-cloudrun#1169) ──────────────────────────────────

Deno.test("every BILLING-settling type feeds exactly one of a cents bucket and a count; a CREDIT one neither", () => {
  const types = Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[];
  for (const type of types) {
    const c = SETTLEMENT_CONTRACTS[type];
    switch (c.settles) {
      case "billing":
        assertEquals((c.sums_into === null) !== (c.counts_into === null), true, type);
        break;
      case "credit":
        assertEquals([c.sums_into, c.counts_into], [null, null], type);
        break;
      default: {
        const _exhaustive: never = c.settles;
        throw new Error(`unhandled role ${_exhaustive}`);
      }
    }
  }
  assertEquals(types.filter((t) => SETTLEMENT_CONTRACTS[t].settles === "credit").sort(), ["refund", "refund_reversal"]);
  // Non-vacuity: every arm is populated.
  assertEquals(types.filter((t) => SETTLEMENT_CONTRACTS[t].counts_into !== null).sort(), ["closure", "closure_reversal"]);
  assertEquals(types.filter((t) => SETTLEMENT_CONTRACTS[t].sums_into !== null).length, 6);
});

Deno.test("close → reopen → close folds to 1, 0, 1 at every prefix", () => {
  // R2: closing and reopening are journal rows, folded like every other
  // settlement — so the count is right after EVERY append, on either side.
  for (const side of SIDES) {
    const rows = [
      S({ type: "closure", reason: "zero_total", side }),
      S({ type: "closure_reversal", reason: "correction", side }),
      S({ type: "closure", reason: "zero_total", side }),
    ];
    const expected = [1, 0, 1];
    const statuses = ["paid", "issued", "paid"];
    for (let n = 1; n <= rows.length; n++) {
      const r = recomputeSettlementTotals(side, 0, rows.slice(0, n));
      assertEquals(r.closure_count, expected[n - 1], `${side} prefix ${n}`);
      assertEquals([r.amount_paid_cents, r.amount_credited_cents, r.amount_void_cents, r.amount_due_cents], [0, 0, 0, 0]);
      assertEquals(r.breakdown, {});
      const doc = { status: "issued" as InvoiceStatusType, totals: { total_cents: 0, ...r } };
      assertEquals(deriveInvoiceStatus(doc), statuses[n - 1], `${side} prefix ${n}`);
      // R1: closed ⟺ frozen, with nothing cached — reopening unfreezes.
      assertEquals(invoiceIsFrozen({ status: statuses[n - 1] as InvoiceStatusType, totals: r }), expected[n - 1] > 0);
    }
  }
});

Deno.test("a closure row's amount is ignored by the cents fold — the count reads the multiplier", () => {
  const r = fold(0, [S({ type: "closure", reason: "zero_total", amount_cents: 500 })]);
  assertEquals(r.closure_count, 1);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("deriveInvoiceStatus: a $0 invoice is paid ONLY when closed — never from due <= 0 (#2396)", () => {
  const zero = (closure_count: number, status: InvoiceStatusType = "issued") => ({
    status,
    totals: { total_cents: 0, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 0, closure_count },
  });
  assertEquals(deriveInvoiceStatus(zero(0)), "issued", "#2396: emptied by an edit, nothing settles it");
  assertEquals(deriveInvoiceStatus(zero(0, "paid")), "issued", "#2197: Xero said PAID; CFS no longer copies it");
  assertEquals(deriveInvoiceStatus(zero(1)), "paid");
  assertEquals(deriveInvoiceStatus(zero(1, "draft")), "draft");
  assertEquals(deriveInvoiceStatus(zero(0, "void")), "void");
  assertEquals(
    deriveInvoiceStatus({ status: "issued", totals: { total_cents: 0, amount_paid_cents: 100, amount_due_cents: -100 } }),
    "paid",
  );
  assertEquals(
    deriveInvoiceStatus({ status: "issued", totals: { total_cents: 500, amount_paid_cents: 0, amount_due_cents: 500, closure_count: 1 } }),
    "issued",
  );
});

Deno.test("deriveInvoiceStatus derives due from the buckets, not from a stale amount_due_cents", () => {
  assertEquals(
    deriveInvoiceStatus({ status: "issued", totals: { total_cents: 1_000, amount_paid_cents: 1_000, amount_due_cents: 1_000 } }),
    "paid",
  );
});

Deno.test("SettlementSchema enforces the closure contract", async (t) => {
  await t.step("a zero-cent closure is accepted on both sides", () => {
    for (const side of SIDES) assertEquals(SettlementSchema.safeParse(rowFor(side, "closure")).success, true, side);
  });
  const refusals: Array<[string, SettlementTypeType, Record<string, unknown>, string]> = [
    ["a closure moving money", "closure", { amount_cents: 1 }, "amount_cents"],
    ["a closure naming a credit", "closure", { credit: { collection: "credit-notes", uid: NOTE, label: null } }, "credit"],
    ["a closure carrying a Xero id", "closure", { xero_id: XERO }, "xero_id"],
    ["a closure that reverses something", "closure", { reverses: SETTLEMENT }, "reverses"],
    ["a closure_reversal naming nothing", "closure_reversal", { reverses: null }, "reverses"],
    ["a payment claiming zero_total", "payment", { reason: "zero_total" }, "reason"],
    ["a closure with no reason it may carry", "closure", { reason: "unspecified" }, "reason"],
  ];
  for (const [label, type, overrides, path] of refusals) {
    await t.step(label, () => {
      const r = SettlementSchema.safeParse(rowFor("receivable", type, overrides));
      assertEquals(r.success, false);
      assertEquals(r.error!.issues.map((i) => i.path.join(".")), [path]);
    });
  }
});

// ── refund (api-cloudrun#1207) ───────────────────────────────────

Deno.test("SettlementSchema enforces the refund contract", async (t) => {
  await t.step("a well-formed refund parses on both sides, linked or not", () => {
    for (const side of SIDES) {
      assertEquals(SettlementSchema.safeParse(rowFor(side, "refund")).success, true, side);
      assertEquals(SettlementSchema.safeParse(rowFor(side, "refund", { xero_id: XERO })).success, true, side);
    }
  });
  await t.step("a refund naming a billing document is refused — it settles the credit", () => {
    const r = SettlementSchema.safeParse(rowFor("receivable", "refund", { billing: { collection: "invoices", uid: INV } }));
    assertEquals(r.error?.issues.map((i) => i.path.join(".")), ["billing"]);
  });
  await t.step("a refund naming no credit is refused", () => {
    const r = SettlementSchema.safeParse(rowFor("receivable", "refund", { credit: null }));
    assertEquals(r.error?.issues.map((i) => i.path.join(".")), ["credit"]);
  });
  await t.step("a billing type naming no billing document is refused", () => {
    const r = SettlementSchema.safeParse(makeSettlement({ billing: null }));
    assertEquals(r.error?.issues.map((i) => i.path.join(".")), ["billing"]);
  });
  await t.step("a refund_reversal names its target and carries no Xero id", () => {
    const reversal = rowFor("receivable", "refund_reversal");
    assertEquals(SettlementSchema.safeParse(reversal).success, true);
    assertEquals(SettlementSchema.safeParse({ ...reversal, reverses: null }).success, false);
  });
  await t.step("only credit-drawing types may name a credit — the guard is draws_credit, not a bucket", () => {
    // Built from `rowFor`, which parses for every type on both sides (asserted
    // below), so each refusal here is the credit and nothing else.
    for (const side of SIDES) {
      const credit = { collection: SIDE_COLLECTIONS[side].credit, uid: NOTE, label: null };
      for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
        if (SETTLEMENT_CONTRACTS[type].draws_credit) continue;
        const r = SettlementSchema.safeParse(rowFor(side, type, { credit }));
        assertEquals(r.success, false, `${side} ${type}`);
        assertEquals(r.error!.issues.map((i) => i.path.join(".")), ["credit"], `${side} ${type}`);
      }
    }
  });
});

Deno.test("draws_credit is exactly credit, refund and their reversals", () => {
  const types = Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[];
  assertEquals(
    types.filter((t) => SETTLEMENT_CONTRACTS[t].draws_credit).sort(),
    ["credit", "credit_reversal", "refund", "refund_reversal"],
  );
});

Deno.test("a billing fold REFUSES a refund row rather than skipping it", () => {
  assertThrows(
    () => fold(10_000, [S({ type: "refund", reason: "refunded", amount_cents: 500 })]),
    Error,
    "names no billing document",
  );
});

/** A row drawing on a credit, as `creditRemainingFromJournal` reads it. */
const R = (type: SettlementTypeType, amount_cents: number, side: Side = "receivable") => ({
  type,
  amount_cents,
  credit: refsFor(side, type).credit,
});

Deno.test("creditRemainingFromJournal: total − signed draws, over credits AND refunds", () => {
  assertEquals(creditRemainingFromJournal("receivable", 2_400, []), 2_400, "untouched");
  assertEquals(creditRemainingFromJournal("receivable", 2_400, [R("refund", 2_400)]), 0, "fully refunded (CN-1030)");
  assertEquals(creditRemainingFromJournal("receivable", 48_506, [R("refund", 48_506)]), 0, "CN-1013 once backfilled");
  assertEquals(creditRemainingFromJournal("receivable", 10_000, [R("credit", 3_000), R("refund", 2_000)]), 5_000, "mixed");
  assertEquals(
    creditRemainingFromJournal("receivable", 2_400, [R("refund", 2_400), R("refund_reversal", 2_400)]),
    2_400,
    "a reaped refund gives the credit back",
  );
  assertEquals(
    creditRemainingFromJournal("receivable", 2_400, [R("refund", 2_400), R("refund_reversal", 2_400), R("refund", 2_400)]),
    0,
    "refund → reap → refund reads 0 at the end",
  );
  assertEquals(creditRemainingFromJournal("receivable", 1_000, [R("credit", 1_500)]), -500, "negative is preserved");
  assertEquals(creditRemainingFromJournal("receivable", 1_000, [R("payment", 1_000)]), 1_000, "a non-drawing row is skipped");
});

Deno.test("a voided note folds to its total — it voids only with nothing live", () => {
  assertEquals(creditRemainingFromJournal("receivable", 700, [R("credit", 700), R("credit_reversal", 700)]), 700);
});

// ── both sides (rulings 44, 129–131) ─────────────────────────────

Deno.test("rowFor parses for every settlement type on both sides — the fixture the refusals rest on", () => {
  for (const side of SIDES) {
    for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
      const r = SettlementSchema.safeParse(rowFor(side, type));
      assertEquals(r.success, true, `${side} ${type}: ${JSON.stringify(r.error?.issues)}`);
    }
  }
});

Deno.test("every reason is legal on at least one side, and labelled wherever it is legal (ruling 130)", () => {
  const legal = new Set<string>();
  for (const side of SIDES) {
    for (const [type, reasons] of Object.entries(SIDE_CONTRACTS[side].settlement_reasons)) {
      for (const [reason, label] of Object.entries(reasons)) {
        legal.add(reason);
        assertEquals(typeof label === "string" && label.length > 0, true, `${side} ${type} ${reason}`);
      }
    }
  }
  // Against the ENUM's own members, not the table: a member no side labels is a
  // reason no row can ever carry.
  const members = (SettlementReasonEnum as unknown as { options: string[] }).options;
  assertEquals(members.length >= 12, true, "the enum is readable");
  assertEquals([...legal].sort(), [...members].sort());
});

Deno.test("the side decides the reason: the direction-only pairs are one stored reason with two labels", () => {
  for (const [type, reason] of [["payment", "paid"], ["void", "voided"], ["refund", "refunded"]] as const) {
    const labels = SIDES.map((side) => SIDE_CONTRACTS[side].settlement_reasons[type][reason]);
    assertEquals(labels.every((l) => l !== undefined), true, type);
    assertEquals(new Set(labels).size, 2, `${type}: the two sides word it differently`);
  }
  // The side-specific reasons stay on their own side.
  assertEquals(settlementReasonLegal("payable", "credit", "bad_debt"), false);
  assertEquals(settlementReasonLegal("receivable", "credit", "supplier_adjustment"), false);
  // No payable history to backfill blind.
  for (const reasons of Object.values(SIDE_CONTRACTS.payable.settlement_reasons)) {
    assertEquals("unspecified" in reasons, false);
  }
});

Deno.test("each credit document's reasons are its side's `credit` entry", () => {
  assertEquals([...CREDIT_NOTE_REASONS].sort(), Object.keys(SIDE_CONTRACTS.receivable.settlement_reasons.credit).sort());
  assertEquals([...PURCHASE_CREDIT_REASONS].sort(), Object.keys(SIDE_CONTRACTS.payable.settlement_reasons.credit).sort());
});

Deno.test("SettlementSchema keeps the two sides disjoint", async (t) => {
  // Each refusal changes ONE key on an otherwise-valid row and must name exactly
  // that key, so a refusal for some other reason cannot pass for this one.
  const refusals: Array<[string, Side, SettlementTypeType, Record<string, unknown>, string]> = [
    [
      "an allocation of a customer credit note to a bill",
      "payable",
      "credit",
      { credit: { collection: "credit-notes", uid: NOTE, label: null } },
      "credit.collection",
    ],
    [
      "an allocation of a supplier credit to an invoice",
      "receivable",
      "credit",
      { credit: { collection: "purchase-credits", uid: PCREDIT, label: null } },
      "credit.collection",
    ],
    ["a supplier credit with an AR reason", "payable", "credit", { reason: "goodwill" }, "reason"],
    ["a bill payment with the backfill-only reason", "payable", "payment", { reason: "unspecified" }, "reason"],
    ["a customer credit with the supplier's reason", "receivable", "credit", { reason: "supplier_adjustment" }, "reason"],
    ["a billing ref naming another collection", "receivable", "payment", { billing: { collection: "orders", uid: INV } }, "billing.collection"],
    ["a payable payment naming no counterparty", "payable", "payment", { uid_counterparty: null }, "uid_counterparty"],
  ];
  for (const [label, side, type, overrides, path] of refusals) {
    await t.step(label, () => {
      const r = SettlementSchema.safeParse(rowFor(side, type, overrides));
      assertEquals(r.success, false);
      assertEquals(r.error!.issues.map((i) => i.path.join(".")), [path]);
    });
  }
  await t.step("a card purchase born paid: one payment carrying the SPEND's id parses (ruling 129)", () => {
    assertEquals(SettlementSchema.safeParse(rowFor("payable", "payment", { xero_id: XERO })).success, true);
  });
});

Deno.test("the narrowing guards partition the journal by side and role", () => {
  for (const side of SIDES) {
    for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
      const s = SettlementSchema.parse(rowFor(side, type)) as Settlement;
      assertEquals(settlementSide(s), side, `${side} ${type}`);
      for (const other of SIDES) assertEquals(isSideSettlement(other, s), other === side, `${side} ${type}`);
      assertEquals(isBillingSettlement(side, s), SETTLEMENT_CONTRACTS[type].settles === "billing", `${side} ${type}`);
    }
  }
});

Deno.test("the payable fold: the same fold, over bill rows", () => {
  const P = (type: SettlementTypeType, reason: SettlementReasonType, amount_cents: number) => S({ type, reason, amount_cents, side: "payable" });
  const rows = [
    P("payment", "paid", 60_000),
    P("credit", "supplier_adjustment", 10_000),
    P("payment", "paid", 5_000),
    P("payment_reversal", "source_retracted", 5_000),
  ];
  assertEquals(recomputeSettlementTotals("payable", 140_985, rows), {
    amount_paid_cents: 60_000,
    amount_credited_cents: 10_000,
    amount_void_cents: 0,
    amount_due_cents: 70_985,
    closure_count: 0,
    breakdown: { paid: 65_000, supplier_adjustment: 10_000, source_retracted: -5_000 },
  });
  // A card purchase born paid: one row for the whole total, due 0.
  assertEquals(recomputeSettlementTotals("payable", 16_354, [P("payment", "paid", 16_354)]).amount_due_cents, 0);
  // A voided bill folds to due 0, and un-voiding restores it.
  const voided = [P("void", "voided", 140_985)];
  assertEquals(recomputeSettlementTotals("payable", 140_985, voided).amount_due_cents, 0);
  assertEquals(
    recomputeSettlementTotals("payable", 140_985, [...voided, P("void_reversal", "correction", 140_985)]).amount_due_cents,
    140_985,
  );
});

Deno.test("each fold REFUSES the other side's rows rather than skipping them", async (t) => {
  // Every type, on every side, against both folds — so a row lands in exactly one.
  for (const rowSide of SIDES) {
    for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
      const c = SETTLEMENT_CONTRACTS[type];
      const row = [S({ type, reason: firstReason(rowSide, type), amount_cents: 0, side: rowSide })];
      await t.step(`${rowSide} ${type}`, () => {
        for (const foldSide of SIDES) {
          if (c.settles === "billing" && foldSide === rowSide) recomputeSettlementTotals(foldSide, 0, row);
          else assertThrows(() => recomputeSettlementTotals(foldSide, 0, row), Error, "cannot be folded");
        }
      });
    }
  }
});

Deno.test("the payable credit fold: total − signed draws, over allocations AND supplier refunds", () => {
  assertEquals(creditRemainingFromJournal("payable", 5_000, []), 5_000, "untouched");
  assertEquals(creditRemainingFromJournal("payable", 5_000, [R("credit", 3_000, "payable"), R("refund", 2_000, "payable")]), 0, "mixed");
  assertEquals(
    creditRemainingFromJournal("payable", 5_000, [R("credit", 5_000, "payable"), R("credit_reversal", 5_000, "payable")]),
    5_000,
    "a reaped allocation gives the credit back",
  );
  assertEquals(creditRemainingFromJournal("payable", 1_000, [R("credit", 1_500, "payable")]), -500, "negative is preserved");
  // The two sides' credit folds are disjoint: neither reads the other's draws.
  assertEquals(creditRemainingFromJournal("payable", 1_000, [R("credit", 1_000), R("refund", 1_000)]), 1_000);
  assertEquals(creditRemainingFromJournal("receivable", 1_000, [R("credit", 1_000, "payable"), R("refund", 1_000, "payable")]), 1_000);
});

// ── inputs (rulings 132, 137) ────────────────────────────────────

Deno.test("CreateSettlementInput: one route for both sides", async (t) => {
  const common = { date: "2026-11-18T10:00:00.000-06:00", uuid_session: "0195f3a1-0000-7000-8000-000000000002", version: 3 };
  const ok = (v: unknown) => assertEquals(CreateSettlementInput.safeParse(v).success, true, JSON.stringify(v));
  const refused = (v: unknown, path: string) => {
    const r = CreateSettlementInput.safeParse(v);
    assertEquals(r.success, false, JSON.stringify(v));
    assertEquals(r.error!.issues.map((i) => i.path.join(".")), [path]);
  };
  await t.step("a payment against an invoice and against a bill", () => {
    ok({ type: "payment", billing: { collection: "invoices", uid: INV }, reason: "paid", amount_cents: 100, ...common });
    ok({ type: "payment", billing: { collection: "purchase-bills", uid: BILL }, reason: "paid", amount_cents: 100, ...common });
  });
  await t.step("a stored billing ref with extra keys is stripped, not refused", () => {
    const r = CreateSettlementInput.safeParse({
      type: "payment",
      billing: { collection: "invoices", uid: INV, extra: 1 },
      reason: "paid",
      amount_cents: 100,
      ...common,
    });
    assertEquals(r.success, true);
    assertEquals((r.data as { billing: unknown }).billing, { collection: "invoices", uid: INV });
  });
  await t.step("a reason illegal on the target's side is a 400", () => {
    refused({ type: "payment", billing: { collection: "purchase-bills", uid: BILL }, reason: "unspecified", amount_cents: 1, ...common }, "reason");
    refused({ type: "refund", credit: { collection: "purchase-credits", uid: PCREDIT }, reason: "bad_debt", amount_cents: 1, ...common }, "reason");
  });
  await t.step("a closure states amount 0", () => {
    ok({ type: "closure", billing: { collection: "purchase-bills", uid: BILL }, reason: "zero_total", amount_cents: 0, ...common });
    refused({ type: "closure", billing: { collection: "invoices", uid: INV }, reason: "zero_total", amount_cents: 1, ...common }, "amount_cents");
  });
  await t.step("an allocation stays on its credit's side", () => {
    ok({
      type: "credit",
      credit: { collection: "purchase-credits", uid: PCREDIT },
      allocations: [{ billing: { collection: "purchase-bills", uid: BILL }, amount_cents: 100 }],
      uuid_session: common.uuid_session,
      version: 1,
    });
    refused({
      type: "credit",
      credit: { collection: "credit-notes", uid: NOTE },
      allocations: [{ billing: { collection: "purchase-bills", uid: BILL }, amount_cents: 100 }],
      uuid_session: common.uuid_session,
      version: 1,
    }, "allocations.0.billing.collection");
  });
  await t.step("every write is session-keyed and states its target's version", () => {
    refused({ type: "payment", billing: { collection: "invoices", uid: INV }, reason: "paid", amount_cents: 1, date: common.date, version: 1 }, "uuid_session");
    refused({ type: "payment", billing: { collection: "invoices", uid: INV }, reason: "paid", amount_cents: 1, date: common.date, uuid_session: common.uuid_session }, "version");
  });
});

Deno.test("ReverseSettlementInput: session-keyed, versioned, retraction reasons only", () => {
  const base = { uuid_session: "0195f3a1-0000-7000-8000-000000000003", version: 2 };
  assertEquals(ReverseSettlementInput.safeParse({ reason: "correction", ...base }).success, true);
  assertEquals(ReverseSettlementInput.safeParse({ reason: "paid", ...base }).success, false);
  assertEquals(ReverseSettlementInput.safeParse({ reason: "correction", version: 2 }).success, false);
});
