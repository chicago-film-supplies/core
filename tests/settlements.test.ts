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
  getSettlementMultiplier,
  isInvoiceSettlement,
  isPayableSettlement,
  isPurchaseBillSettlement,
  isReceivableSettlement,
  PURCHASE_CREDIT_REASONS,
  type Settlement,
  SETTLEMENT_CONTRACTS,
  SETTLEMENT_TARGET_SIDE,
  SETTLEMENT_TARGETS,
  settlementContract,
  SettlementSchema,
  type SettlementReasonType,
  type SettlementTypeType,
} from "../src/schemas/mod.ts";
import {
  creditNoteRemainingFromJournal,
  deriveInvoiceStatus,
  invoiceIsFrozen,
  purchaseCreditRemainingFromJournal,
  recomputePurchaseBillTotals,
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
    uid_purchase_bill: null,
    uid_purchase_credit: null,
    uid_supplier: null,
    type: "payment",
    reason: "payment_received",
    amount_cents: 50_000,
    date: "2026-08-01T14:32:07.881-05:00",
    date_fs: mockTimestamp,
    reference: null,
    uuid_session: "0195f3a1-0000-7000-8000-000000000001",
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
  // `sums_into` is load-bearing, not documentation: `recomputeSettlementTotals`
  // (which every invoice total goes through) takes its settlement argument structurally, so without a declared target a
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
  assertEquals(settlementContract("refund")?.settles, "credit_note");
  assertEquals(settlementContract("not_a_type"), undefined);
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
  assertEquals(derive("issued", r.amount_paid_cents, r.amount_due_cents, r.amount_credited_cents), "paid");
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

Deno.test("deriveInvoiceStatus leaves `void` alone — status is an explicit move", () => {
  // The fold says nothing is due; the status word is still the writer's to set,
  // in both directions. Un-voiding therefore takes TWO acts: append the
  // `void_reversal`, then move `status` off `void`.
  const voided = recomputeSettlementTotals(247_000, [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
  ]);
  assertEquals(
    derive("void", voided.amount_paid_cents, voided.amount_due_cents, voided.amount_credited_cents),
    "void",
  );
  const unvoided = recomputeSettlementTotals(247_000, [
    S({ type: "void", reason: "invoice_voided", amount_cents: 247_000 }),
    S({ type: "void_reversal", reason: "correction", amount_cents: 247_000 }),
  ]);
  assertEquals(
    derive("void", unvoided.amount_paid_cents, unvoided.amount_due_cents),
    "void",
    "the reversal alone does not un-void; the status move is separate and deliberate",
  );
  assertEquals(
    derive("issued", unvoided.amount_paid_cents, unvoided.amount_due_cents),
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

// ── deriveInvoiceStatus ──────────────────────────────────────────

Deno.test("a fully-credited, never-paid invoice derives paid", () => {
  assertEquals(derive("issued", 0, 0, 2_196), "paid");
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

Deno.test("every INVOICE-settling type feeds exactly one of a cents bucket and a count; a BILL one a cents bucket; a CREDIT one neither", () => {
  // Built from the vocabulary, not the table: a type with both, or neither,
  // would be folded twice or not at all.
  const types = Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[];
  for (const type of types) {
    const c = SETTLEMENT_CONTRACTS[type];
    switch (c.settles) {
      case "invoice":
        assertEquals((c.sums_into === null) !== (c.counts_into === null), true, type);
        break;
      case "purchase_bill":
        assertEquals([c.sums_into !== null, c.counts_into], [true, null], type);
        break;
      case "credit_note":
      case "purchase_credit":
        assertEquals([c.sums_into, c.counts_into], [null, null], type);
        break;
      default: {
        const _exhaustive: never = c.settles;
        throw new Error(`unhandled target ${_exhaustive}`);
      }
    }
  }
  const settling = (target: string) => types.filter((t) => SETTLEMENT_CONTRACTS[t].settles === target).sort();
  assertEquals(settling("credit_note"), ["refund", "refund_reversal"]);
  assertEquals(settling("purchase_credit"), ["supplier_refund", "supplier_refund_reversal"]);
  assertEquals(settling("purchase_bill"), [
    "bill_credit",
    "bill_credit_reversal",
    "bill_payment",
    "bill_payment_reversal",
    "bill_void",
    "bill_void_reversal",
  ]);
  // Non-vacuity: every arm is populated.
  assertEquals(types.filter((t) => SETTLEMENT_CONTRACTS[t].counts_into !== null).sort(), ["closure", "closure_reversal"]);
  assertEquals(types.filter((t) => SETTLEMENT_CONTRACTS[t].sums_into !== null).length, 12);
});

Deno.test("close → reopen → close folds to 1, 0, 1 at every prefix", () => {
  // R2: closing and reopening are journal rows, folded like every other
  // settlement — so the count is right after EVERY append, not just at the end.
  const rows = [
    S({ type: "closure", reason: "zero_total" }),
    S({ type: "closure_reversal", reason: "correction" }),
    S({ type: "closure", reason: "zero_total" }),
  ];
  const expected = [1, 0, 1];
  const statuses = ["paid", "issued", "paid"];
  for (let n = 1; n <= rows.length; n++) {
    const r = recomputeSettlementTotals(0, rows.slice(0, n));
    assertEquals(r.closure_count, expected[n - 1], `prefix ${n}`);
    // A closure moves no money: every cents bucket stays 0 and no reason is broken down.
    assertEquals([r.amount_paid_cents, r.amount_credited_cents, r.amount_void_cents, r.amount_due_cents], [0, 0, 0, 0]);
    assertEquals(r.breakdown, {});
    const invoice = {
      status: "issued" as InvoiceStatusType,
      totals: { total_cents: 0, ...r },
    };
    assertEquals(deriveInvoiceStatus(invoice), statuses[n - 1], `prefix ${n}`);
    // R1: closed ⟺ frozen, with nothing cached — reopening unfreezes.
    assertEquals(invoiceIsFrozen({ status: statuses[n - 1] as InvoiceStatusType, totals: r }), expected[n - 1] > 0);
  }
});

Deno.test("a closure row's amount is ignored by the cents fold — the count reads the multiplier", () => {
  // The schema refuses a non-zero closure, but the fold must not depend on that:
  // even a malformed row cannot leak money through the count arm.
  const r = recomputeSettlementTotals(0, [S({ type: "closure", reason: "zero_total", amount_cents: 500 })]);
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
  // Money on a $0 invoice is still money: an overpayment reads paid, no closure needed.
  assertEquals(
    deriveInvoiceStatus({ status: "issued", totals: { total_cents: 0, amount_paid_cents: 100, amount_due_cents: -100 } }),
    "paid",
  );
  // A non-zero invoice ignores the count entirely (the invoice refine forbids it anyway).
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
  const closure = { type: "closure", reason: "zero_total", amount_cents: 0 };
  await t.step("a zero-cent closure is accepted", () => {
    assertEquals(SettlementSchema.safeParse(makeSettlement(closure)).success, true);
  });
  const refusals: Array<[string, Record<string, unknown>, string]> = [
    ["a closure moving money", { ...closure, amount_cents: 1 }, "amount_cents"],
    ["a closure naming a credit note", { ...closure, uid_credit_note: "testcn10000000000000" }, "uid_credit_note"],
    ["a closure carrying a Xero payment id", { ...closure, xero_payment_id: "x" }, "xero_payment_id"],
    ["a closure that reverses something", { ...closure, reverses: SETTLEMENT }, "reverses"],
    ["a closure_reversal naming nothing", { type: "closure_reversal", reason: "correction", amount_cents: 0 }, "reverses"],
    ["a payment claiming zero_total", { type: "payment", reason: "zero_total" }, "reason"],
    ["a closure with no reason it may carry", { ...closure, reason: "unspecified" }, "reason"],
  ];
  for (const [label, overrides, path] of refusals) {
    await t.step(label, () => {
      const r = SettlementSchema.safeParse(makeSettlement(overrides));
      assertEquals(r.success, false);
      assertEquals(r.error!.issues.map((i) => i.path.join(".")), [path]);
    });
  }
});

// ── refund (api-cloudrun#1207) ───────────────────────────────────

const NOTE = "testcrn1000000000000";

/** A valid refund row: names the note, no invoice. */
const refundRow = (overrides: Record<string, unknown> = {}) =>
  makeSettlement({
    type: "refund",
    reason: "credit_refunded",
    uid_invoice: null,
    uid_credit_note: NOTE,
    number_credit_note: "CN-1030",
    xero_payment_id: "edf5d932-0000-4000-8000-000000000001",
    ...overrides,
  });

Deno.test("SettlementSchema enforces the refund contract", async (t) => {
  await t.step("a well-formed refund parses, linked or not", () => {
    assertEquals(SettlementSchema.safeParse(refundRow()).success, true);
    assertEquals(SettlementSchema.safeParse(refundRow({ xero_payment_id: null })).success, true);
  });
  await t.step("a refund naming an invoice is refused — it settles the note", () => {
    assertEquals(SettlementSchema.safeParse(refundRow({ uid_invoice: INV })).success, false);
  });
  await t.step("a refund naming no note is refused", () => {
    assertEquals(SettlementSchema.safeParse(refundRow({ uid_credit_note: null })).success, false);
  });
  await t.step("a refund carries the PaymentID, never xero_credit_note_id", () => {
    assertEquals(SettlementSchema.safeParse(refundRow({ xero_credit_note_id: "cn-xero" })).success, false);
  });
  await t.step("an invoice type with no invoice is refused", () => {
    assertEquals(SettlementSchema.safeParse(makeSettlement({ uid_invoice: null })).success, false);
  });
  await t.step("a refund_reversal names its target and carries no Xero id", () => {
    const reversal = refundRow({ type: "refund_reversal", reason: "source_retracted", reverses: SETTLEMENT, xero_payment_id: null });
    assertEquals(SettlementSchema.safeParse(reversal).success, true);
    assertEquals(SettlementSchema.safeParse({ ...reversal, reverses: null }).success, false);
  });
  await t.step("only credit-drawing types may name a note — the guard is draws_credit, not a bucket", () => {
    // Built from `validRowFor`, which parses for every type (asserted below), so
    // each refusal here is the note and nothing else — a receivable-shaped row
    // would have refused every PAYABLE type for its party keys and passed
    // vacuously.
    const named = { uid_credit_note: NOTE, number_credit_note: "CN-1030" };
    for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
      if (SETTLEMENT_CONTRACTS[type].draws_credit) continue;
      const r = SettlementSchema.safeParse({ ...validRowFor(type), ...named });
      assertEquals(r.success, false, type);
      assertEquals(
        [...new Set(r.error!.issues.map((i) => i.path.join(".")))].sort(),
        ["number_credit_note", "uid_credit_note"],
        type,
      );
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

Deno.test("an invoice fold REFUSES a refund row rather than skipping it", () => {
  assertThrows(
    () => recomputeSettlementTotals(10_000, [S({ type: "refund", reason: "credit_refunded", amount_cents: 500 })]),
    Error,
    "settles a credit note and cannot be folded into an invoice",
  );
});

Deno.test("creditNoteRemainingFromJournal: total − signed draws, over credits AND refunds", () => {
  const R = (type: SettlementTypeType, amount_cents: number) => ({ type, amount_cents });
  assertEquals(creditNoteRemainingFromJournal(2_400, []), 2_400, "untouched");
  assertEquals(creditNoteRemainingFromJournal(2_400, [R("refund", 2_400)]), 0, "fully refunded (CN-1030)");
  assertEquals(creditNoteRemainingFromJournal(48_506, [R("refund", 48_506)]), 0, "CN-1013 once backfilled");
  assertEquals(creditNoteRemainingFromJournal(10_000, [R("credit", 3_000), R("refund", 2_000)]), 5_000, "mixed");
  assertEquals(
    creditNoteRemainingFromJournal(2_400, [R("refund", 2_400), R("refund_reversal", 2_400)]),
    2_400,
    "a reaped refund gives the credit back",
  );
  assertEquals(
    creditNoteRemainingFromJournal(2_400, [R("refund", 2_400), R("refund_reversal", 2_400), R("refund", 2_400)]),
    0,
    "refund → reap → refund reads 0 at the end",
  );
  assertEquals(creditNoteRemainingFromJournal(1_000, [R("credit", 1_500)]), -500, "negative is preserved");
  assertEquals(creditNoteRemainingFromJournal(1_000, [R("payment", 1_000)]), 1_000, "a non-drawing row is skipped");
});

Deno.test("a voided note folds to its total — it voids only with nothing live", () => {
  const rows = [
    { type: "credit" as SettlementTypeType, amount_cents: 700 },
    { type: "credit_reversal" as SettlementTypeType, amount_cents: 700 },
  ];
  assertEquals(creditNoteRemainingFromJournal(700, rows), 700);
});

// ── payable (api-cloudrun#1210) ──────────────────────────────────

const SUPPLIER = "testsup1000000000000";
const BILL = "testpbl1000000000000";
const PCREDIT = "testpcr1000000000000";

/**
 * A row that parses for ANY settlement type, built from the contract alone —
 * the party and target keys each type's `settles` demands, the instrument its
 * `draws_*` demands, a legal reason, and the reversal link its contract
 * requires. Every refusal test below starts from this and changes ONE thing.
 */
function validRowFor(type: SettlementTypeType): Record<string, unknown> {
  const c = SETTLEMENT_CONTRACTS[type];
  const payable = SETTLEMENT_TARGET_SIDE[c.settles] === "payable";
  return makeSettlement({
    type,
    reason: c.reasons[0],
    amount_cents: c.counts_into !== null ? 0 : 100,
    reverses: c.reverses === "required" ? SETTLEMENT : null,
    uid_invoice: c.settles === "invoice" ? INV : null,
    uid_organization: payable ? null : ORG,
    uid_supplier: payable ? SUPPLIER : null,
    uid_purchase_bill: c.settles === "purchase_bill" ? BILL : null,
    uid_credit_note: c.draws_credit ? NOTE : null,
    uid_purchase_credit: c.draws_purchase_credit ? PCREDIT : null,
  });
}

Deno.test("validRowFor parses for every settlement type — the fixture the refusals rest on", () => {
  for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
    const r = SettlementSchema.safeParse(validRowFor(type));
    assertEquals(r.success, true, `${type}: ${JSON.stringify(r.error?.issues)}`);
  }
});

Deno.test("every target has a side, and both sides are populated by types", () => {
  assertEquals([...SETTLEMENT_TARGETS].sort(), Object.keys(SETTLEMENT_TARGET_SIDE).sort());
  const sides = new Set(Object.values(SETTLEMENT_CONTRACTS).map((c) => SETTLEMENT_TARGET_SIDE[c.settles]));
  assertEquals([...sides].sort(), ["payable", "receivable"]);
  // Every target is settled by at least one type — a member nothing settles is
  // a key the refine demands that no row can ever carry.
  const targets = new Set(Object.values(SETTLEMENT_CONTRACTS).map((c) => c.settles));
  assertEquals([...targets].sort(), [...SETTLEMENT_TARGETS].sort());
});

Deno.test("draws_purchase_credit is exactly bill_credit, supplier_refund and their reversals — and never with draws_credit", () => {
  const types = Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[];
  assertEquals(
    types.filter((t) => SETTLEMENT_CONTRACTS[t].draws_purchase_credit).sort(),
    ["bill_credit", "bill_credit_reversal", "supplier_refund", "supplier_refund_reversal"],
  );
  for (const t of types) {
    const c = SETTLEMENT_CONTRACTS[t];
    assertEquals(c.draws_credit && c.draws_purchase_credit, false, t);
    // A receivable never draws a supplier credit, a payable never a customer one.
    if (SETTLEMENT_TARGET_SIDE[c.settles] === "payable") assertEquals(c.draws_credit, false, t);
    else assertEquals(c.draws_purchase_credit, false, t);
  }
});

Deno.test("no payable type shares a reason list with `unspecified` — there is no payable history to backfill blind", () => {
  for (const [t, c] of Object.entries(SETTLEMENT_CONTRACTS)) {
    if (SETTLEMENT_TARGET_SIDE[c.settles] === "payable") assertEquals(c.reasons.includes("unspecified"), false, t);
  }
});

Deno.test("PURCHASE_CREDIT_REASONS equals bill_credit's reasons — the allocation carries its credit's reason", () => {
  assertEquals([...PURCHASE_CREDIT_REASONS].sort(), [...SETTLEMENT_CONTRACTS.bill_credit.reasons].sort());
});

Deno.test("SettlementSchema keeps the two sides disjoint", async (t) => {
  // Each refusal changes ONE key on an otherwise-valid row and must name exactly
  // that key, so a refusal for some other reason cannot pass for this one.
  const refusals: Array<[string, SettlementTypeType, Record<string, unknown>, string]> = [
    ["a bill payment naming a customer", "bill_payment", { uid_organization: ORG }, "uid_organization"],
    ["a bill payment naming no supplier", "bill_payment", { uid_supplier: null }, "uid_supplier"],
    ["a bill payment naming no bill", "bill_payment", { uid_purchase_bill: null }, "uid_purchase_bill"],
    ["a bill payment naming an invoice", "bill_payment", { uid_invoice: INV }, "uid_invoice"],
    ["a bill payment naming a supplier credit", "bill_payment", { uid_purchase_credit: PCREDIT }, "uid_purchase_credit"],
    ["a bill payment naming a customer credit note", "bill_payment", { uid_credit_note: NOTE }, "uid_credit_note"],
    ["a bill credit naming no supplier credit", "bill_credit", { uid_purchase_credit: null }, "uid_purchase_credit"],
    ["a bill credit carrying a PaymentID", "bill_credit", { xero_payment_id: "x" }, "xero_payment_id"],
    ["a bill credit with an AR reason", "bill_credit", { reason: "goodwill" }, "reason"],
    ["a bill void with the INVOICE's reason", "bill_void", { reason: "invoice_voided" }, "reason"],
    ["a bill_payment_reversal naming nothing", "bill_payment_reversal", { reverses: null }, "reverses"],
    ["a supplier refund naming a bill", "supplier_refund", { uid_purchase_bill: BILL }, "uid_purchase_bill"],
    ["a supplier refund naming no credit", "supplier_refund", { uid_purchase_credit: null }, "uid_purchase_credit"],
    ["a supplier refund with the CUSTOMER refund reason", "supplier_refund", { reason: "credit_refunded" }, "reason"],
    ["a customer payment naming a supplier", "payment", { uid_supplier: SUPPLIER }, "uid_supplier"],
    ["a customer payment naming a bill", "payment", { uid_purchase_bill: BILL }, "uid_purchase_bill"],
    ["a customer payment naming no customer", "payment", { uid_organization: null }, "uid_organization"],
    ["a customer refund naming a supplier credit", "refund", { uid_purchase_credit: PCREDIT }, "uid_purchase_credit"],
  ];
  for (const [label, type, overrides, path] of refusals) {
    await t.step(label, () => {
      const r = SettlementSchema.safeParse({ ...validRowFor(type), ...overrides });
      assertEquals(r.success, false);
      assertEquals(r.error!.issues.map((i) => i.path.join(".")), [path]);
    });
  }
  await t.step("a card purchase born paid: one bill_payment with no PaymentID parses", () => {
    assertEquals(SettlementSchema.safeParse({ ...validRowFor("bill_payment"), xero_payment_id: null }).success, true);
  });
});

Deno.test("the narrowing guards partition the journal by side and target", () => {
  const parsed = (Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]).map((type) =>
    SettlementSchema.parse(validRowFor(type)) as Settlement
  );
  for (const s of parsed) {
    const c = SETTLEMENT_CONTRACTS[s.type];
    const payable = SETTLEMENT_TARGET_SIDE[c.settles] === "payable";
    assertEquals(isPayableSettlement(s), payable, s.type);
    assertEquals(isReceivableSettlement(s), !payable, s.type);
    assertEquals(isInvoiceSettlement(s), c.settles === "invoice", s.type);
    assertEquals(isPurchaseBillSettlement(s), c.settles === "purchase_bill", s.type);
  }
});

Deno.test("recomputePurchaseBillTotals: the invoice fold, over bill rows", () => {
  const rows = [
    S({ type: "bill_payment", reason: "payment_sent", amount_cents: 60_000 }),
    S({ type: "bill_credit", reason: "short_close", amount_cents: 10_000 }),
    S({ type: "bill_payment", reason: "payment_sent", amount_cents: 5_000 }),
    S({ type: "bill_payment_reversal", reason: "source_retracted", amount_cents: 5_000 }),
  ];
  assertEquals(recomputePurchaseBillTotals(140_985, rows), {
    amount_paid_cents: 60_000,
    amount_credited_cents: 10_000,
    amount_void_cents: 0,
    amount_due_cents: 70_985,
    breakdown: { payment_sent: 65_000, short_close: 10_000, source_retracted: -5_000 },
  });
  // A card purchase born paid: one row for the whole total, due 0.
  assertEquals(
    recomputePurchaseBillTotals(16_354, [S({ type: "bill_payment", reason: "payment_sent", amount_cents: 16_354 })])
      .amount_due_cents,
    0,
  );
  // A voided bill folds to due 0, and un-voiding restores it.
  const voided = [S({ type: "bill_void", reason: "bill_voided", amount_cents: 140_985 })];
  assertEquals(recomputePurchaseBillTotals(140_985, voided).amount_due_cents, 0);
  assertEquals(
    recomputePurchaseBillTotals(140_985, [
      ...voided,
      S({ type: "bill_void_reversal", reason: "correction", amount_cents: 140_985 }),
    ]).amount_due_cents,
    140_985,
  );
});

Deno.test("each fold REFUSES the other side's rows rather than skipping them", async (t) => {
  // Every type, against both folds — so a new type lands in exactly one.
  for (const type of Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[]) {
    const c = SETTLEMENT_CONTRACTS[type];
    const row = [S({ type, reason: c.reasons[0], amount_cents: 0 })];
    await t.step(type, () => {
      if (c.settles === "invoice") recomputeSettlementTotals(0, row);
      else assertThrows(() => recomputeSettlementTotals(0, row), Error, "cannot be folded into an invoice");
      if (c.settles === "purchase_bill") recomputePurchaseBillTotals(0, row);
      else assertThrows(() => recomputePurchaseBillTotals(0, row), Error, "cannot be folded into a purchase bill");
    });
  }
});

Deno.test("purchaseCreditRemainingFromJournal: total − signed draws, over allocations AND supplier refunds", () => {
  const R = (type: SettlementTypeType, amount_cents: number) => ({ type, amount_cents });
  assertEquals(purchaseCreditRemainingFromJournal(5_000, []), 5_000, "untouched");
  assertEquals(purchaseCreditRemainingFromJournal(5_000, [R("bill_credit", 3_000), R("supplier_refund", 2_000)]), 0, "mixed");
  assertEquals(
    purchaseCreditRemainingFromJournal(5_000, [R("bill_credit", 5_000), R("bill_credit_reversal", 5_000)]),
    5_000,
    "a reaped allocation gives the credit back",
  );
  assertEquals(purchaseCreditRemainingFromJournal(1_000, [R("bill_credit", 1_500)]), -500, "negative is preserved");
  // The two sides' credit folds are disjoint: neither reads the other's draws.
  assertEquals(purchaseCreditRemainingFromJournal(1_000, [R("credit", 1_000), R("refund", 1_000)]), 1_000);
  assertEquals(creditNoteRemainingFromJournal(1_000, [R("bill_credit", 1_000), R("supplier_refund", 1_000)]), 1_000);
});
