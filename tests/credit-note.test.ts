/**
 * The credit-note document — the value instrument the settlements journal draws
 * from.
 *
 * The status enum is the decision most worth pinning here. It has three live
 * states and deliberately no `part_applied`: across all 12 notes in the live
 * tenant (probed 2026-08-01) `RemainingCredit` is either `0.00` or the full
 * total, never in between; Xero has no partial state either; and a partial
 * member would invert the operator's primary query, turning
 * `status === "issued"` into `issued OR part_applied`.
 */
import { assertEquals } from "@std/assert";
import {
  CREDIT_NOTE_REASONS,
  CreditNoteSchema,
  SETTLEMENT_CONTRACTS,
} from "../src/schemas/mod.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ORG = "testorg1000000000000";

function makeCreditNote(overrides: Record<string, unknown> = {}) {
  return {
    uid: "testcrn1000000000000",
    number: 1009,
    status: "applied",
    reason: "bad_debt",
    date: "2026-03-01T00:00:00.000-06:00",
    date_fs: mockTimestamp,
    reference: "Run of Show Locations Supplement",
    organization: {
      uid: ORG,
      name: "Acme Corp",
      tax_profile: "tax_applied",
      xero_id: null,
      billing_address: null,
    },
    tax_profile: "tax_applied",
    items: [{
      uid: "cnitem10000000000000",
      type: "sale",
      name: "Location supplement",
      description: "",
      quantity: 1,
      price: {
        base: 2196,
        chargeable_days: null,
        formula: "fixed",
        subtotal: 2196,
        subtotal_discounted: 2196,
        discount: null,
        taxes: [],
        total: 2196,
      },
      coa_revenue: 4000,
      tracking_category: null,
      xero_id: null,
      xero_tracking_option_id: null,
      uid_invoice_item: null,
    }],
    totals: {
      subtotal: 2196,
      subtotal_discounted: 2196,
      discount_amount: 0,
      taxes: [],
      total: 2196,
    },
    remaining_credit: 0,
    sources: [],
    query_by_sources: [],
    xero_credit_note_id: null,
    version: 0,
    created_by: { uid: "testuser100000000000", name: "Test User" },
    updated_by: { uid: "testuser100000000000", name: "Test User" },
    created_at: mockTimestamp,
    updated_at: mockTimestamp,
    ...overrides,
  };
}

Deno.test("CreditNoteSchema accepts CN-1009's shape", () => {
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote()).success, true);
});

Deno.test("the reasons are DERIVED from the settlement contract, not re-listed", () => {
  // One credit note allocated across three invoices has ONE reason. Authoring
  // the list twice is what would let the document and its settlements offer
  // different answers.
  assertEquals(CREDIT_NOTE_REASONS, SETTLEMENT_CONTRACTS.credit.reasons);
  assertEquals(CREDIT_NOTE_REASONS.includes("bad_debt"), true);
  assertEquals(CREDIT_NOTE_REASONS.includes("early_return"), true);
  // A payment reason is not a credit reason.
  assertEquals(CREDIT_NOTE_REASONS.includes("payment_received"), false);
  // Nor is a reversal reason — a credit note is never itself a retraction.
  assertEquals(CREDIT_NOTE_REASONS.includes("source_retracted"), false);
});

Deno.test("a payment reason is rejected on a credit note", () => {
  const bad = CreditNoteSchema.safeParse(makeCreditNote({ reason: "payment_received" }));
  assertEquals(bad.success, false);
});

Deno.test("status is a materialized derivation of remaining_credit, and must agree", () => {
  // `applied` asserting a balance it does not have is a contradiction, not a
  // preference — so the schema reports it rather than every consumer restating it.
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "applied", remaining_credit: 500 }))
      .success,
    false,
  );
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "issued", remaining_credit: 0 })).success,
    false,
  );
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "issued", remaining_credit: 2196 }))
      .success,
    true,
  );
});

Deno.test("CN-1008's shape: VOID strands the balance rather than consuming it", () => {
  // The three VOIDED notes in the live tenant all carry remaining == total.
  // Voiding is not consumption, so the status/balance agreement is waived —
  // without the exemption none of them could be written.
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({
      number: 1008,
      status: "void",
      remaining_credit: 2195.97,
      totals: {
        subtotal: 2195.97,
        subtotal_discounted: 2195.97,
        discount_amount: 0,
        taxes: [],
        total: 2195.97,
      },
      items: [],
    })).success,
    true,
  );
});

Deno.test("a cash refund is applied with zero allocations — CN-1013's shape", () => {
  // `applied` means `remaining_credit === 0` HOWEVER it got there. CN-1013 and
  // CN-1016 are PAID in Xero with a Payment attached and no allocations at all:
  // a cash refund IS a credit note settled by cash rather than by allocation.
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({
      number: 1013,
      status: "applied",
      reason: "order_adjustment",
      reference: "L&D Refund",
      remaining_credit: 0,
    })).success,
    true,
  );
});

Deno.test("remaining_credit cannot exceed the note's total", () => {
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "issued", remaining_credit: 3000 }))
      .success,
    false,
  );
});

Deno.test("number is stored BARE — CN- is presentation only", () => {
  // A prefixed string would break `default_sorting_field: "number"` outright,
  // and no collection in this package stores a prefixed string number.
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ number: "CN-1009" })).success, false);
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ number: 1009 })).success, true);
});

Deno.test("a line must declare its revenue account", () => {
  // A credit spanning lines with different COAs (#1689 hits 4000 and 4100)
  // cannot be posted from a document-level amount, and apportioning it
  // afterwards is inferring cause from effect.
  const items = makeCreditNote().items.map(({ coa_revenue: _drop, ...rest }) => rest);
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ items })).success, false);
});

Deno.test("date is a calendar date, not an instant", () => {
  // It is the accounting issue date and Xero's `Date`/`DateString`, and it is
  // one of the two inputs to `allocation.date = max(credit_note.date,
  // invoice.date)` — so it is load-bearing, not merely reportable. A settlement's
  // `date` is the opposite case; the two semantics are why both factories exist.
  const parsed = CreditNoteSchema.safeParse(
    makeCreditNote({ date: "2026-03-01T14:32:07.881-06:00" }),
  );
  assertEquals(parsed.success, true);
  assertEquals((parsed.data as { date: string }).date, "2026-03-01T00:00:00.000-06:00");
});
