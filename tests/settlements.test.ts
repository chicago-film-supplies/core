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
  assertEquals(SETTLEMENT_CONTRACTS.void.sums_into, "amount_void_cents");
  assertEquals(SETTLEMENT_CONTRACTS.void_reversal.sums_into, "amount_void_cents");
});

Deno.test("the void pair matches the shape of the other two — do/undo, no external id", () => {
  // A void carries no Xero id even though Xero is usually where it originates:
  // Xero annuls the INVOICE, not a settlement, so there is no Xero payment or
  // credit-note object for the row to name. The invoice's own `xero_id` is the
  // linkage and it is already stored.
  assertEquals(SETTLEMENT_CONTRACTS.void.xero_id_field, null);
  assertEquals(SETTLEMENT_CONTRACTS.void_reversal.xero_id_field, null);
  assertEquals(SETTLEMENT_CONTRACTS.void.reverses, "forbidden");
  assertEquals(SETTLEMENT_CONTRACTS.void_reversal.reverses, "required");
  assertEquals(getSettlementMultiplier("void"), 1);
  assertEquals(getSettlementMultiplier("void_reversal"), -1);
});

Deno.test("a void's reason is `invoice_voided`, NOT `source_retracted`", () => {
  // `source_retracted` means "the originating system no longer reports it" — the
  // reap. A void is the opposite kind of fact: the invoice IS reported, and
  // reported as annulled. Re-meaning an existing member after history carries it
  // is the one change this enum calls expensive.
  assertEquals(SETTLEMENT_CONTRACTS.void.reasons.includes("invoice_voided"), true);
  assertEquals(SETTLEMENT_CONTRACTS.void.reasons.includes("source_retracted"), false);
  assertEquals(
    SettlementSchema.safeParse(
      makeSettlement({ type: "void", reason: "source_retracted", reverses: null }),
    ).success,
    false,
  );
  assertEquals(
    SettlementSchema.safeParse(
      makeSettlement({ type: "void", reason: "invoice_voided", reverses: null }),
    ).success,
    true,
  );
});

Deno.test("a void cannot reference a credit note — the guard names the CREDIT bucket, not the cash one", () => {
  // The credit-note guard used to read `sums_into === "amount_paid_cents"`,
  // which was correct while there were two buckets and silently permissive the
  // moment a third arrived: a `void` row would have been exempted entirely. It
  // now reads `!== "amount_credited_cents"`, so a fourth bucket defaults to
  // being CHECKED rather than to being skipped.
  assertEquals(
    SettlementSchema.safeParse(makeSettlement({
      type: "void",
      reason: "invoice_voided",
      uid_credit_note: "testcrn1000000000000",
      number_credit_note: "CN-1014",
    })).success,
    false,
  );
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

// ── The void bucket (api-cloudrun#436) ───────────────────────────

Deno.test("a void folds to due = 0, and it is DERIVED rather than assigned", () => {
  // The whole of #436. A void used to force `amount_due_cents = 0` while the
  // journal still folded to `total`, which is why the identity refine had to
  // exempt void invoices — and that exemption is what made a void that never
  // released its balance indistinguishable from one that did.
  const r = recomputeSettlementTotals(247_000, [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
  ]);
  assertEquals(r.amount_void_cents, 247_000);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_credited_cents, 0);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("void_reversal restores due = total — un-voiding is an APPEND, not an edit", () => {
  // Without the paired arm `amount_void_cents` would be a latch: the only way
  // back would be to edit or delete the `void` row, and the journal is
  // append-only. The pair is what keeps it a fold.
  const rows = [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
    S({ type: "void_reversal", reason: "correction", amount_cents: 247_000 }),
  ];
  const r = recomputeSettlementTotals(247_000, rows);
  assertEquals(r.amount_void_cents, 0);
  assertEquals(r.amount_due_cents, 247_000);

  // …and the pair is order-independent, like every other do/undo here.
  const reversed = recomputeSettlementTotals(247_000, [...rows].reverse());
  assertEquals(reversed.amount_void_cents, r.amount_void_cents);
  assertEquals(reversed.amount_due_cents, r.amount_due_cents);
});

Deno.test("voiding a PART-PAID invoice: the payment is reaped, the void takes the whole total", () => {
  // The shape `applyInvoiceVoid` produces. Every live settlement is retracted
  // first, so the void row annuls the full billed amount rather than the
  // residual — which is also what Xero does, since it refuses to void an
  // invoice that still has payments applied.
  const r = recomputeSettlementTotals(100_000, [
    S({ amount_cents: 40_000 }),
    S({ type: "payment_reversal", reason: "source_retracted", amount_cents: 40_000 }),
    S({ type: "void", reason: "invoice_voided", amount_cents: 100_000 }),
  ]);
  assertEquals(r.amount_paid_cents, 0);
  assertEquals(r.amount_void_cents, 100_000);
  assertEquals(r.amount_due_cents, 0);
});

Deno.test("a void row does NOT land in the credited bucket — the two-way `else` is gone", () => {
  // The fold was `if (… === "amount_paid_cents") paid += …; else credited += …`.
  // Under that `else` a void summed into `amount_credited_cents`, the identity
  // still balanced, and every consumer would have reported a voided invoice as
  // fully CREDITED — a bad debt written off. Nothing would have failed to
  // compile and nothing would have failed the identity; this assertion is the
  // only thing that separates the two answers.
  const r = recomputeSettlementTotals(247_000, [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
  ]);
  assertEquals(r.amount_credited_cents, 0, "a void is not a write-off");
  assertEquals(r.breakdown.invoice_voided, 247_000);
});

Deno.test("derivePaymentStatus leaves `void` alone — status is an explicit move", () => {
  // The fold says nothing is due; the status word is still the writer's to set,
  // in both directions. Un-voiding therefore takes TWO acts: append the
  // `void_reversal`, then move `status` off `void`.
  const voided = recomputeSettlementTotals(247_000, [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
  ]);
  assertEquals(
    derivePaymentStatus("void", voided.amount_paid_cents, voided.amount_due_cents, voided.amount_credited_cents),
    "void",
  );
  const unvoided = recomputeSettlementTotals(247_000, [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
    S({ type: "void_reversal", reason: "correction", amount_cents: 247_000 }),
  ]);
  assertEquals(
    derivePaymentStatus("void", unvoided.amount_paid_cents, unvoided.amount_due_cents),
    "void",
    "the reversal alone does not un-void; the status move is separate and deliberate",
  );
  assertEquals(
    derivePaymentStatus("issued", unvoided.amount_paid_cents, unvoided.amount_due_cents),
    "issued",
  );
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
