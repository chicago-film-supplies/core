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
import { fixedPrice } from "./helpers/formulas.ts";
import {
  COA_BAD_DEBT,
  CREDIT_NOTE_REASONS,
  CreditNoteSchema,
  deriveCreditNoteSources,
  deriveCreditPostingAccount,
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
    // REQUIRED since the notes consolidation (2026-09-06) — bare `.nullable()`,
    // so the key must be PRESENT even when there is nothing to say. This is a
    // hand-spelled literal rather than a `getInitialValues` seed, which is why
    // the compiler could not point at it and the suite had to.
    notes: null,
    organization: {
      uid: ORG,
      // Required since core#77 — every stored snapshot carries the frozen chain.
      path: [{ uid: ORG, name: "Acme Corp", derived: false }],
      xero_id: null,
      billing_address: null,
    },
    items: [{
      uid: "cnitem10000000000000",
      type: "sale",
      name: "Location supplement",
      description: "",
      quantity: 1,
      price: {
        ...fixedPrice(219600),
        subtotal_cents: 219600,
        subtotal_discounted_cents: 219600,
        discount: null,
        taxes: [],
        total_cents: 219600,
      },
      coa_revenue: 4000,
      coa_posting: 4000,
      uid_tracking_category: null,
      xero_id: null,
      uid_invoice_item: null,
      // Required, and false on every line this feature did not write — see
      // `schemas/credit-note.ts`. Stated explicitly rather than omitted, which is
      // the whole reason it is not optional.
      reverses_billing: false,
    }],
    totals: {
      subtotal_cents: 219600,
      subtotal_discounted_cents: 219600,
      discount_amount_cents: 0,
      taxes: [],
      total_cents: 219600,
    },
    remaining_credit_cents: 0,
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
    CreditNoteSchema.safeParse(makeCreditNote({ status: "applied", remaining_credit_cents: 50000 }))
      .success,
    false,
  );
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "issued", remaining_credit_cents: 0 })).success,
    false,
  );
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "issued", remaining_credit_cents: 219600 }))
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
      remaining_credit_cents: 219597,
      totals: {
        subtotal_cents: 219597,
        subtotal_discounted_cents: 219597,
        discount_amount_cents: 0,
        taxes: [],
        total_cents: 219597,
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
      remaining_credit_cents: 0,
    })).success,
    true,
  );
});

Deno.test("remaining_credit cannot exceed the note's total", () => {
  assertEquals(
    CreditNoteSchema.safeParse(makeCreditNote({ status: "issued", remaining_credit_cents: 300000 }))
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

Deno.test("a line must declare both accounts, and they are allowed to differ", () => {
  // A credit spanning lines with different COAs (#1689 hits 4000 and 4100)
  // cannot be posted from a document-level amount, and apportioning it
  // afterwards is inferring cause from effect.
  const noRevenue = makeCreditNote().items.map(({ coa_revenue: _d, ...rest }) => rest);
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ items: noRevenue })).success, false);

  const noPosting = makeCreditNote().items.map(({ coa_posting: _d, ...rest }) => rest);
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ items: noPosting })).success, false);

  // `coa_revenue` is nullable — a free-text credit line has no catalog product
  // behind it, and CN-1012's sole line is exactly that. Stricter than the
  // invoice it credits would be unable to represent the corpus.
  const nullRevenue = makeCreditNote().items.map((i) => ({ ...i, coa_revenue: null }));
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ items: nullRevenue })).success, true);

  // The two are different facts. CN-1009 writes off 35 RENTAL lines (revenue
  // 4000) to 6900 Bad Debt; collapsing them loses the revenue attribution the
  // tracking-category rollups depend on.
  const writeOff = makeCreditNote().items.map((i) => ({ ...i, coa_revenue: 4000, coa_posting: 6900 }));
  assertEquals(CreditNoteSchema.safeParse(makeCreditNote({ items: writeOff })).success, true);
});

Deno.test("deriveCreditPostingAccount: bad debt leaves revenue alone, returns reverse it", () => {
  // Bad debt is NOT a revenue reversal — the sale stands and the money was
  // owed, so it moves to Bad Debt to be written off. Everything else is a
  // return or allowance, where the customer never owed it and revenue reverses.
  assertEquals(deriveCreditPostingAccount("bad_debt", 4000), COA_BAD_DEBT);
  assertEquals(deriveCreditPostingAccount("bad_debt", null), COA_BAD_DEBT);
  assertEquals(deriveCreditPostingAccount("early_return", 4000), 4000);
  assertEquals(deriveCreditPostingAccount("order_adjustment", 4210), 4210);
  assertEquals(deriveCreditPostingAccount("goodwill", 4100), 4100);

  // Bidirectional or unclassified — the rule has no opinion and must not invent one.
  assertEquals(deriveCreditPostingAccount("correction", 4000), null);
  assertEquals(deriveCreditPostingAccount("unspecified", 4000), null);
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

// ── line money: checked until the credit note's money has moved ─────────────
//
// A credit note is priced once, at creation; the backfill (purchases-as-documents
// Phase 5) found an APPLIED one whose stored money no `rates × counts` reproduces.
// Applied or void keeps it; issued is still held to the formula.

const unreproducible = (status: string, remaining: number) => {
  const cn = makeCreditNote({ status, remaining_credit_cents: remaining });
  const [line] = cn.items;
  return { ...cn, items: [{ ...line, price: { ...line.price, rates: [{ rate_key: "flat", amount_cents: 219000 }] } }] };
};

Deno.test("CreditNoteSchema: an ISSUED credit note whose line money its rates × counts do not reproduce is refused", () => {
  const issued = CreditNoteSchema.safeParse(unreproducible("issued", 219600));
  assertEquals(issued.success, false);
  assertEquals(
    issued.error!.issues.map((i) => i.path.join(".")).sort(),
    ["items.0.price.subtotal_cents", "items.0.price.subtotal_discounted_cents"],
  );
});

Deno.test("CreditNoteSchema: an APPLIED or VOID credit note keeps line money its counts do not reproduce", () => {
  assertEquals(CreditNoteSchema.safeParse(unreproducible("applied", 0)).success, true, "applied");
  assertEquals(CreditNoteSchema.safeParse(unreproducible("void", 0)).success, true, "void");
});

// ── deriveCreditNoteSources (one-document-model ruling 32, 6e-0a) ─────

Deno.test("deriveCreditNoteSources: orders first, then invoices; a pointed line names only the order its path leads with", () => {
  const got = deriveCreditNoteSources(
    [{ uid: "inv1", query_by_orders: ["o1", "o2"] }],
    [{ path_invoice_item: ["o2", "dest", "x"] }],
  );
  assertEquals(got.sources, [{ collection: "orders", uid: "o2" }, { collection: "invoices", uid: "inv1" }]);
  assertEquals(got.query_by_sources, ["orders:o2", "invoices:inv1"]);
});

Deno.test("deriveCreditNoteSources: a path that leads with no order the invoice bills names no order (an invoice-authored subtree)", () => {
  const got = deriveCreditNoteSources([{ uid: "inv1", query_by_orders: ["o1"] }], [{ path_invoice_item: ["authored", "x"] }]);
  assertEquals(got.query_by_sources, ["invoices:inv1"]);
});

Deno.test("deriveCreditNoteSources: an unpointed line names every order its invoice bills (ruling 52, the historic notes)", () => {
  const got = deriveCreditNoteSources(
    [{ uid: "inv1", query_by_orders: ["o1", "o2"] }, { uid: "inv2", query_by_orders: ["o2", "o3"] }],
    [{ path_invoice_item: ["o1", "x"] }, {}],
  );
  assertEquals(got.query_by_sources, ["orders:o1", "orders:o2", "orders:o3", "invoices:inv1", "invoices:inv2"]);
});

Deno.test("deriveCreditNoteSources: no billing document names nothing (a historic note with no allocation)", () => {
  assertEquals(deriveCreditNoteSources([], [{}]), { sources: [], query_by_sources: [] });
});
