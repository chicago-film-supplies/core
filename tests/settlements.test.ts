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
import { assertEquals } from "@std/assert";
import {
  getSettlementMultiplier,
  SETTLEMENT_CONTRACTS,
  settlementContract,
  SettlementSchema,
  type SettlementReasonType,
  type SettlementTypeType,
} from "../src/schemas/mod.ts";
import { derivePaymentStatus, recomputeSettlementTotals } from "../src/utils/invoices.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ORG = "testorg1000000000000";
const INV = "testinv1000000000000";
const SETTLEMENT = "teststl1000000000000";

/** A settlement row reduced to what the totals fold reads. */
const S = (
  o: Partial<{ type: SettlementTypeType; reason: SettlementReasonType; amount_cents: number }> = {},
) => ({
  type: "payment" as SettlementTypeType,
  reason: "payment_received" as SettlementReasonType,
  amount_cents: 0,
  ...o,
});

/** A complete, valid settlement document. */
function makeSettlement(overrides: Record<string, unknown> = {}) {
  return {
    uid: SETTLEMENT,
    uid_invoice: INV,
    uid_organization: ORG,
    type: "payment",
    reason: "payment_received",
    amount_cents: 50_000,
    date: "2026-08-01T14:32:07.881-05:00",
    date_fs: mockTimestamp,
    reference: null,
    uid_session: "0195f3a1-0000-7000-8000-000000000001",
    reverses: null,
    uid_credit_note: null,
    number_credit_note: null,
    xero_payment_id: null,
    xero_credit_note_id: null,
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

Deno.test("every settlement type routes to exactly one invoice total", () => {
  // `sums_into` is load-bearing, not documentation: `calculateInvoiceTotals`
  // takes its settlement argument structurally, so without a declared target a
  // credit row would be silently summed into `amount_paid`.
  assertEquals(SETTLEMENT_CONTRACTS.payment.sums_into, "amount_paid_cents");
  assertEquals(SETTLEMENT_CONTRACTS.payment_reversal.sums_into, "amount_paid_cents");
  assertEquals(SETTLEMENT_CONTRACTS.credit.sums_into, "amount_credited_cents");
  assertEquals(SETTLEMENT_CONTRACTS.credit_reversal.sums_into, "amount_credited_cents");
});

Deno.test("settlementContract tolerates an unknown type rather than throwing", () => {
  assertEquals(settlementContract("payment")?.sums_into, "amount_paid_cents");
  assertEquals(settlementContract("refund"), undefined);
  assertEquals(settlementContract(""), undefined);
});

Deno.test("a reversal carries NO external id — it is a CFS event", () => {
  // The reap appends a reverser because Xero stopped reporting a payment. The
  // reverser has no Xero counterpart; the id it retracts is on the row it names.
  assertEquals(SETTLEMENT_CONTRACTS.payment_reversal.xero_id_field, null);
  assertEquals(SETTLEMENT_CONTRACTS.credit_reversal.xero_id_field, null);
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

  // ...and `payment_received` is not a credit reason.
  assertEquals(
    SettlementSchema.safeParse(makeSettlement({
      type: "credit",
      reason: "payment_received",
      xero_credit_note_id: null,
    })).success,
    false,
  );
});

Deno.test("a credit carrying xero_payment_id is rejected", () => {
  const bad = SettlementSchema.safeParse(makeSettlement({
    type: "credit",
    reason: "bad_debt",
    xero_payment_id: "1234",
  }));
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["xero_payment_id"]);
});

Deno.test("reverses is required on a reversal and forbidden on an application", () => {
  const missing = SettlementSchema.safeParse(makeSettlement({
    type: "payment_reversal",
    reason: "source_retracted",
    reverses: null,
  }));
  assertEquals(missing.success, false);
  assertEquals(missing.error?.issues[0].path, ["reverses"]);

  const stray = SettlementSchema.safeParse(makeSettlement({ reverses: SETTLEMENT }));
  assertEquals(stray.success, false);
  assertEquals(stray.error?.issues[0].path, ["reverses"]);

  assertEquals(
    SettlementSchema.safeParse(makeSettlement({
      type: "payment_reversal",
      reason: "source_retracted",
      reverses: SETTLEMENT,
    })).success,
    true,
  );
});

Deno.test("a cash settlement cannot reference a credit note", () => {
  // Derived from `sums_into` rather than declared as a fifth contract axis.
  const bad = SettlementSchema.safeParse(makeSettlement({ uid_credit_note: INV }));
  assertEquals(bad.success, false);
  assertEquals(bad.error?.issues[0].path, ["uid_credit_note"]);
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
  assertEquals(
    (parsed.data as { date: string }).date,
    "2026-08-01T14:32:07.881-05:00",
    "the time of day was truncated",
  );
});

// ── The signed fold ──────────────────────────────────────────────

Deno.test("a do/undo pair nets to zero ARITHMETICALLY, not by filtering", () => {
  const r = recomputeSettlementTotals(100_000, [
    S({ amount_cents: 500_00 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 500_00 }),
  ]);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_due_cents, 100_000);
});

Deno.test("R2 → R1 → S1: the chain that vanished money under a liveness derivation", () => {
  // The old trichotomy went wrong on a reversal-of-a-reversal and silently
  // dropped the $500. Under the fold it is +500 −500 +500, correct at EVERY
  // prefix — which is the property, not just the endpoint.
  const rows = [
    S({ amount_cents: 500_00 }),
    S({ type: "payment_reversal", reason: "correction", amount_cents: 500_00 }),
    S({ reason: "correction", amount_cents: 500_00 }),
  ];
  assertEquals(recomputeSettlementTotals(100_000, rows.slice(0, 1)).amount_paid_cents, 50_000);
  assertEquals(recomputeSettlementTotals(100_000, rows.slice(0, 2)).amount_paid_cents, 0);
  assertEquals(recomputeSettlementTotals(100_000, rows).amount_paid_cents, 50_000);
  assertEquals(recomputeSettlementTotals(100_000, rows).amount_due_cents, 50_000);
});

Deno.test("the fold is order-independent — no second pass, no sequencing", () => {
  const rows = [
    S({ amount_cents: 300_00 }),
    S({ type: "payment_reversal", reason: "correction", amount_cents: 300_00 }),
    S({ type: "credit", reason: "bad_debt", amount_cents: 250_00 }),
    S({ amount_cents: 700_00 }),
  ];
  const forward = recomputeSettlementTotals(100_000, rows);
  const reversed = recomputeSettlementTotals(100_000, [...rows].reverse());
  assertEquals(forward.amount_paid_cents, reversed.amount_paid_cents);
  assertEquals(forward.amount_credited_cents, reversed.amount_credited_cents);
  assertEquals(forward.amount_due_cents, reversed.amount_due_cents);
});

Deno.test("credits route to amount_credited and never reduce total", () => {
  // #1301's shape: billed 18,196 / collected 16,000 / wrote off 2,196.
  const r = recomputeSettlementTotals(1_819_600, [
    S({ amount_cents: 16_000_00 }),
    S({ type: "credit", reason: "bad_debt", amount_cents: 2_196_00 }),
  ]);
  assertEquals(r.amount_paid_cents, 1_600_000);
  assertEquals(r.amount_credited_cents, 219_600);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("#1322: fully credited with ZERO cash collected", () => {
  // CFS recorded $4,495.62 as cash that was never collected. Both systems agreed
  // the invoice was settled and nothing was due — the one thing they disagreed
  // about was *how*, and that was the one thing CFS had no field for.
  const r = recomputeSettlementTotals(449_562, [
    S({ type: "credit", reason: "unspecified", amount_cents: 449_562 }),
  ]);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_credited_cents, 449_562);
  assertEquals(r.amount_due_cents, 0);
  assertEquals(derivePaymentStatus("issued", r.amount_paid_cents, r.amount_due_cents, r.amount_credited_cents), "paid");
});

Deno.test("an over-credited invoice stays NEGATIVE — clamping hides the defect", () => {
  const r = recomputeSettlementTotals(10_000, [
    S({ type: "credit", reason: "goodwill", amount_cents: 150_00 }),
  ]);
  assertEquals(r.amount_credited_cents, 15_000);
  assertEquals(r.amount_due_cents, -5_000);
});

Deno.test("integer cents are exact where a float fold would drift", () => {
  // 300 rows of $0.07. In dollars-as-float this accumulates visible error;
  // summing integers has nothing to round.
  const rows = Array.from({ length: 300 }, () => S({ amount_cents: 7 }));
  const r = recomputeSettlementTotals(2_100, rows);
  assertEquals(r.amount_paid_cents, 2_100);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("the per-reason breakdown is free and answers the reporting question", () => {
  // Mirrors availability's `out_of_service_breakdown[o.reason] += o.quantity`.
  // "How much did we credit for early returns last quarter" becomes client-side
  // arithmetic over settlements manager already subscribes to — no query, no index.
  const r = recomputeSettlementTotals(100_000, [
    S({ amount_cents: 400_00 }),
    S({ type: "credit", reason: "early_return", amount_cents: 100_00 }),
    S({ type: "credit", reason: "early_return", amount_cents: 50_00 }),
    S({ type: "credit", reason: "goodwill", amount_cents: 25_00 }),
  ]);
  assertEquals(r.breakdown.payment_received, 40_000);
  assertEquals(r.breakdown.early_return, 15_000);
  assertEquals(r.breakdown.goodwill, 2_500);
  assertEquals(r.breakdown.bad_debt, undefined);
});

Deno.test("a reversal subtracts from its reason's breakdown too", () => {
  const r = recomputeSettlementTotals(100_000, [
    S({ amount_cents: 500_00 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 500_00 }),
  ]);
  assertEquals(r.breakdown.payment_received, 50_000);
  assertEquals(r.breakdown.source_retracted, -50_000);
});

// ── derivePaymentStatus ──────────────────────────────────────────

Deno.test("a fully-credited, never-paid invoice derives paid", () => {
  assertEquals(derivePaymentStatus("issued", 0, 0, 2_196), "paid");
});

Deno.test("a partially-credited, never-paid invoice derives part_paid", () => {
  assertEquals(derivePaymentStatus("issued", 0, 500, 500), "part_paid");
});

Deno.test("draft and void still pass through regardless of credit", () => {
  assertEquals(derivePaymentStatus("draft", 0, 0, 1000), "draft");
  assertEquals(derivePaymentStatus("void", 0, 0, 1000), "void");
});

Deno.test("an untouched issued invoice stays issued", () => {
  assertEquals(derivePaymentStatus("issued", 0, 1000, 0), "issued");
});
