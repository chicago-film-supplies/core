/**
 * The invoice action ruleset (`utils/invoice-actions.ts`, api-cloudrun#1169).
 *
 * Inputs are built from the VOCABULARIES — every invoice status, every
 * credit-note status, every settlement type — never from the tables under test,
 * so a row that silently stops being reachable fails a coverage arm here rather
 * than reading as a clean corpus.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  CREDIT_NOTE_STATUS_CONTRACTS,
  type CreditNoteStatusType,
  INVOICE_ACTION_IDS,
  INVOICE_ACTIONS,
  INVOICE_STATUS_CONTRACTS,
  type InvoiceActionId,
  type InvoiceDocItemType,
  type InvoiceStatusType,
  SETTLEMENT_CONTRACTS,
  type SettlementTypeType,
} from "../src/schemas/mod.ts";
import {
  assertCreditNoteAction,
  assertInvoiceAction,
  assertOrderInvoiceAction,
  type CappedNote,
  creditableLines,
  creditNoteActionsFor,
  creditNoteOverCredit,
  type InvoiceActionOffer,
  InvoiceActionRefusal,
  invoiceActionsFor,
  type OfferCreditNote,
  type OfferInvoice,
  type OfferOrder,
  type OfferSettlement,
  orderInvoiceActionsFor,
} from "../src/utils/invoice-actions.ts";

const INVOICE_STATUSES = Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[];
const NOTE_STATUSES = Object.keys(CREDIT_NOTE_STATUS_CONTRACTS) as CreditNoteStatusType[];
const SETTLEMENT_TYPES = Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[];

/** A billed line: `qty` units over `days` chargeable days (null for a sale). */
function line(uid: string, qty: number, days: number | null): InvoiceDocItemType {
  return {
    uid,
    path: ["ord", "dest", uid],
    type: "rental",
    name: uid,
    quantity: qty,
    price: { chargeable_days: days },
  } as unknown as InvoiceDocItemType;
}

const DIVIDER = { uid: "dest", path: ["ord", "dest"], type: "destination" } as unknown as InvoiceDocItemType;

function invoice(
  status: InvoiceStatusType,
  o: Partial<OfferInvoice["totals"]> & { items?: InvoiceDocItemType[] } = {},
): OfferInvoice {
  const { items, ...totals } = o;
  const total = totals.total_cents ?? 10_000;
  const paid = totals.amount_paid_cents ?? 0;
  return {
    status,
    items: items ?? [DIVIDER, line("cam", 5, 10)],
    totals: {
      total_cents: total,
      amount_paid_cents: paid,
      amount_credited_cents: 0,
      amount_void_cents: 0,
      amount_due_cents: total - paid,
      ...totals,
    },
  };
}

const ids = (offers: InvoiceActionOffer[]) => offers.map((o) => o.action);
const has = (offers: InvoiceActionOffer[], id: InvoiceActionId) => offers.some((o) => o.action === id);
const row = (uid: string, type: SettlementTypeType, o: Partial<OfferSettlement> = {}): OfferSettlement => ({
  uid,
  type,
  reverses: null,
  xero_payment_id: null,
  ...o,
});

// ── vocabulary ───────────────────────────────────────────────────────

Deno.test("INVOICE_ACTION_IDS and INVOICE_ACTIONS name the same actions, both ways", () => {
  assertEquals([...INVOICE_ACTION_IDS].sort(), Object.keys(INVOICE_ACTIONS).sort());
  assertEquals(new Set(INVOICE_ACTION_IDS).size, INVOICE_ACTION_IDS.length, "no duplicate id");
});

/**
 * The coverage oracle: which actions of `subject` never appear in `seen`. A
 * row that has silently become unreachable is exactly an id this returns.
 */
function unreached(subject: "invoice" | "credit_note" | "order", seen: Set<InvoiceActionId>): InvoiceActionId[] {
  return INVOICE_ACTION_IDS.filter((id) => INVOICE_ACTIONS[id].subject === subject && !seen.has(id));
}

/** Every offer across a sweep of invoices built from the status × settlement vocabulary. */
function invoiceSweep(): InvoiceActionOffer[][] {
  const out: InvoiceActionOffer[][] = [];
  for (const status of INVOICE_STATUSES) {
    for (const total of [0, 10_000]) {
      for (const closure of [0, 1]) {
        const every = SETTLEMENT_TYPES.map((t, i) => row(`s${i}`, t, SETTLEMENT_CONTRACTS[t].reverses === "required" ? { reverses: "x" } : {}));
        for (const settlements of [[], every]) {
          out.push(invoiceActionsFor(invoice(status, { total_cents: total, closure_count: closure }), { settlements }));
        }
      }
    }
  }
  return out;
}

Deno.test("every invoice action is OFFERED somewhere and REFUSED somewhere in the vocabulary sweep", () => {
  const sweep = invoiceSweep();
  const offered = new Set(sweep.flatMap(ids));
  assertEquals(unreached("invoice", offered), []);
  // …and none is offered everywhere, except `edit_items`, which D8 keeps open on
  // every status (money freezes, labels do not).
  for (const id of INVOICE_ACTION_IDS.filter((i) => INVOICE_ACTIONS[i].subject === "invoice")) {
    const everywhere = sweep.every((offers) => has(offers, id));
    assertEquals(everywhere, id === "edit_items", id);
  }
  // Only invoice-subject ids are ever offered on an invoice.
  for (const id of offered) assertEquals(INVOICE_ACTIONS[id].subject, "invoice", id);
});

Deno.test("the coverage oracle can fail — deleting a reachable action turns it red", () => {
  // A guard that cannot go red is not one. Drop `close` from the sweep's
  // results, as a deleted row in the ruleset would, and the oracle names it.
  const mutated = new Set(invoiceSweep().flatMap(ids).filter((id) => id !== "close"));
  assertEquals(unreached("invoice", mutated), ["close"]);
});

Deno.test("a status outside the vocabulary offers nothing and asserts a refusal", () => {
  assertEquals(invoiceActionsFor(invoice("voided" as InvoiceStatusType)), []);
  assertEquals(
    creditNoteActionsFor({ status: "voided" as CreditNoteStatusType, remaining_credit_cents: 5, organization: { xero_id: "c" } }, {
      allocations: [],
    }),
    [],
  );
  assertThrows(() => assertInvoiceAction(invoice("voided" as InvoiceStatusType), {}, { action: "void" }), InvoiceActionRefusal);
});

// ── issue / void ─────────────────────────────────────────────────────

Deno.test("issue and void follow operator_moves", () => {
  for (const status of INVOICE_STATUSES) {
    const offers = invoiceActionsFor(invoice(status));
    assertEquals(has(offers, "issue"), INVOICE_STATUS_CONTRACTS[status].operator_moves.includes("issued"), status);
    assertEquals(has(offers, "void"), INVOICE_STATUS_CONTRACTS[status].operator_moves.includes("void"), status);
  }
});

// ── close ────────────────────────────────────────────────────────────

Deno.test("close: a live $0 invoice with nothing settled and no live closure", () => {
  const zero = { total_cents: 0 };
  assertEquals(has(invoiceActionsFor(invoice("issued", zero)), "close"), true);
  // #2197: today's derivation copied Xero's PAID; Mark Paid closes it.
  assertEquals(has(invoiceActionsFor(invoice("paid", zero)), "close"), true);
  assertEquals(has(invoiceActionsFor(invoice("draft", zero)), "close"), false);
  assertEquals(has(invoiceActionsFor(invoice("void", zero)), "close"), false);
  assertEquals(has(invoiceActionsFor(invoice("paid", { ...zero, closure_count: 1 })), "close"), false, "already closed");
  assertEquals(has(invoiceActionsFor(invoice("issued")), "close"), false, "owes money");
  assertEquals(
    has(invoiceActionsFor(invoice("paid", { ...zero, amount_paid_cents: 100, amount_due_cents: -100 })), "close"),
    false,
    "money already settles it",
  );
  assertThrows(() => assertInvoiceAction(invoice("issued"), {}, { action: "close" }), InvoiceActionRefusal, "$0");
});

// ── add_payment (D1) ─────────────────────────────────────────────────

Deno.test("D1 add_payment: accepts_payment and something due, capped at the amount due", () => {
  for (const status of INVOICE_STATUSES) {
    const o = invoiceActionsFor(invoice(status)).find((x) => x.action === "add_payment");
    assertEquals(o !== undefined, INVOICE_STATUS_CONTRACTS[status].accepts_payment, status);
    if (o) assertEquals(o.max_cents, 10_000);
  }
  // #2422: $93,063.00 against $930.63 due — a hard cap, no override.
  const inv = invoice("issued", { total_cents: 93_063 });
  assertThrows(() => assertInvoiceAction(inv, {}, { action: "add_payment", amount_cents: 9_306_300 }), InvoiceActionRefusal, "exceeds");
  assertThrows(() => assertInvoiceAction(inv, {}, { action: "add_payment", amount_cents: 0 }), InvoiceActionRefusal, "$0");
  assertInvoiceAction(inv, {}, { action: "add_payment", amount_cents: 93_063 });
  // Nothing due on a part_paid invoice that has been paid up (a stale status).
  const settled = invoice("part_paid", { amount_paid_cents: 10_000 });
  assertEquals(has(invoiceActionsFor(settled), "add_payment"), false);
  assertThrows(() => assertInvoiceAction(invoice("paid"), {}, { action: "add_payment", amount_cents: 1 }), InvoiceActionRefusal);
});

// ── reverse_settlement (D2) ──────────────────────────────────────────

Deno.test("D2 reverse_settlement: one offer per reversible row", () => {
  const rows = [
    row("pay", "payment"),
    row("xpay", "payment", { xero_payment_id: "x-1" }),
    row("cred", "credit"),
    row("clo", "closure"),
    row("vd", "void"),
    row("rev", "payment_reversal", { reverses: "gone" }),
    row("done", "payment"),
    row("undo", "payment_reversal", { reverses: "done" }),
  ];
  const offered = invoiceActionsFor(invoice("issued"), { settlements: rows })
    .filter((o) => o.action === "reverse_settlement")
    .map((o) => [o.key, o.uid_settlement]);
  assertEquals(offered, [
    ["reverse_settlement:pay", "pay"],
    ["reverse_settlement:cred", "cred"],
    ["reverse_settlement:clo", "clo"],
  ]);
  const refuse = (uid: string, msg: string) =>
    assertThrows(() => assertInvoiceAction(invoice("issued"), { settlements: rows }, { action: "reverse_settlement", uid_settlement: uid }), InvoiceActionRefusal, msg);
  refuse("xpay", "Xero payment");
  refuse("vd", "void");
  refuse("rev", "itself a reversal");
  refuse("done", "already reversed");
  refuse("nope", "not on this invoice");
  assertInvoiceAction(invoice("issued"), { settlements: rows }, { action: "reverse_settlement", uid_settlement: "cred" });
});

Deno.test("D2: absent settlements offer no reversal and change nothing else", () => {
  const without = invoiceActionsFor(invoice("issued"));
  const withNone = invoiceActionsFor(invoice("issued"), { settlements: [] });
  assertEquals(ids(without), ids(withNone));
  assertEquals(has(without, "reverse_settlement"), false);
});

// ── add_credit_note (D3) ─────────────────────────────────────────────

const note = (status: string, ...items: CappedNote["items"]): CappedNote => ({ status, items });
const credit = (uid: string, quantity: number, days: number | null = null) => ({
  name: uid,
  quantity,
  uid_invoice_item: uid,
  path_invoice_item: ["ord", "dest", uid],
  price: { chargeable_days: days },
});

Deno.test("D3 creditableLines nets prior notes in unit-days; void notes and dividers are skipped", () => {
  const items = [DIVIDER, line("cam", 5, 10), line("bag", 2, null)];
  const prior = [
    note("issued", credit("cam", 1, 4)), // a 4-day shortening of one unit: 4 unit-days
    note("void", credit("cam", 5)), // void: ignored
    note("applied", credit("bag", 1)), // a sale unit: 1 unit-day
  ];
  assertEquals(creditableLines(items, prior).map((l) => [l.uid, l.unit_days, l.units]), [
    ["cam", 46, 4],
    ["bag", 1, 1],
  ]);
});

Deno.test("D3: a legacy note line with null chargeable_days consumes the row's FULL days, not one", () => {
  // Every note stored before api-cloudrun#1028 has null days. Read as one day,
  // crediting all 5 units of a 5 × 5 row would leave room for 4 more.
  const items = [line("cam", 5, 5)];
  assertEquals(creditableLines(items, [note("issued", credit("cam", 5))])[0].unit_days, 0);
});

Deno.test("D3 creditNoteOverCredit: the api's two arms, with its messages", () => {
  const items = [line("cam", 5, 10)];
  // Arm A — more units than the row billed, checked first.
  assertEquals(creditNoteOverCredit(2001, items, [credit("cam", 6)], []), 'crediting 6 of "cam" exceeds what invoice 2001 billed (5)');
  // Arm B — the 140% counter-example: 20 unit-days already, then 5 whole units (50).
  assertEquals(
    creditNoteOverCredit(2001, items, [credit("cam", 5)], [note("issued", credit("cam", 5, 4))]),
    'crediting 5 × 10 day(s) of "cam" is 50 unit-days, and invoice 2001 billed 50 (5 × 10) less 20 already credited',
  );
  // A sale line keeps the plain wording.
  assertEquals(
    creditNoteOverCredit(7, [line("bag", 2, null)], [credit("bag", 2)], [note("issued", credit("bag", 1))]),
    'crediting 2 of "bag" exceeds what invoice 7 billed (2) less what is already credited (1)',
  );
  assertEquals(creditNoteOverCredit(2001, items, [credit("cam", 4)], [note("issued", credit("cam", 1))]), null);
});

Deno.test("D3 add_credit_note: offered on a status live in Xero with credit left", () => {
  for (const status of INVOICE_STATUSES) {
    assertEquals(has(invoiceActionsFor(invoice(status)), "add_credit_note"), INVOICE_STATUS_CONTRACTS[status].live_in_xero, status);
  }
  const spent = invoiceActionsFor(invoice("issued"), { creditNotes: [note("issued", credit("cam", 5))] });
  assertEquals(has(spent, "add_credit_note"), false, "every unit already credited");
  assertThrows(
    () => assertInvoiceAction(invoice("draft"), {}, { action: "add_credit_note", invoice_number: 9, lines: [credit("cam", 1)] }),
    InvoiceActionRefusal,
    "issued invoice",
  );
});

// ── edit (D8) ────────────────────────────────────────────────────────

Deno.test("D8 edit_items: always offered; money frozen with the freeze, labels never", () => {
  for (const status of INVOICE_STATUSES) {
    const o = invoiceActionsFor(invoice(status)).find((x) => x.action === "edit_items")!;
    assertEquals(o.money_frozen, status === "paid" || status === "void", status);
  }
  const paidUp = invoice("part_paid", { amount_paid_cents: 1 });
  assertEquals(invoiceActionsFor(paidUp).find((x) => x.action === "edit_items")!.money_frozen, true, "a partial payment freezes money");
  assertThrows(() => assertInvoiceAction(paidUp, {}, { action: "edit_items", money_moved: true }), InvoiceActionRefusal, "settled");
  assertInvoiceAction(paidUp, {}, { action: "edit_items", money_moved: false });
  // A closed $0 invoice is frozen (R1); reopening it unfreezes.
  const closed = invoice("paid", { total_cents: 0, closure_count: 1 });
  assertEquals(has(invoiceActionsFor(closed), "edit_organization"), false);
  assertEquals(has(invoiceActionsFor(invoice("issued", { total_cents: 0, closure_count: 0 })), "edit_date"), true);
});

// ── credit notes (D4–D6) ─────────────────────────────────────────────

const cn = (status: CreditNoteStatusType, remaining = 5_000, xero_id: string | null = "contact-1"): OfferCreditNote => ({
  status,
  remaining_credit_cents: remaining,
  organization: { xero_id },
});
const target = (status: InvoiceStatusType = "issued", due = 3_000, xero_id: string | null = "contact-1") => ({
  status,
  totals: { amount_due_cents: due },
  organization: { xero_id },
});

Deno.test("credit-note actions sweep the status vocabulary", () => {
  const seen = new Set<InvoiceActionId>();
  for (const status of NOTE_STATUSES) {
    const offers = creditNoteActionsFor(cn(status), { allocations: [] });
    offers.forEach((o) => seen.add(o.action));
    assertEquals(has(offers, "void_credit_note"), CREDIT_NOTE_STATUS_CONTRACTS[status].voidable, status);
    assertEquals(has(offers, "allocate_credit_note"), CREDIT_NOTE_STATUS_CONTRACTS[status].accepts_allocation, status);
  }
  assertEquals(unreached("credit_note", seen), []);
});

Deno.test("D4 void_credit_note: not while an allocation is live", () => {
  const live = [{ uid: "a1", type: "credit" as const, reverses: null }];
  const retracted = [...live, { uid: "a1r", type: "credit_reversal" as const, reverses: "a1" }];
  assertEquals(has(creditNoteActionsFor(cn("applied", 0), { allocations: live }), "void_credit_note"), false);
  assertEquals(has(creditNoteActionsFor(cn("issued"), { allocations: retracted }), "void_credit_note"), true);
  assertThrows(() => assertCreditNoteAction(cn("applied", 0), { allocations: live }, { action: "void_credit_note" }), InvoiceActionRefusal, "live allocation");
});

Deno.test("D5/D6 allocate_credit_note: credit left, an invoice that accepts payment, the same Xero contact", () => {
  const offer = (n: OfferCreditNote, inv?: ReturnType<typeof target>) =>
    creditNoteActionsFor(n, { allocations: [], invoice: inv }).find((o) => o.action === "allocate_credit_note");
  assertEquals(offer(cn("issued"))?.max_cents, 5_000, "note-level: the remaining credit");
  assertEquals(offer(cn("issued"), target())?.max_cents, 3_000, "capped at the amount due");
  assertEquals(offer(cn("issued", 0)), undefined, "D6: nothing left");
  assertEquals(offer(cn("issued", -10)), undefined, "D6: a negative balance is not credit");
  assertEquals(offer(cn("issued"), target("draft")), undefined, "D5: a draft invoice");
  assertEquals(offer(cn("issued"), target("paid")), undefined, "D5: a paid invoice");
  assertEquals(offer(cn("issued"), target("issued", 0)), undefined, "nothing due");
  assertEquals(offer(cn("issued"), target("issued", 3_000, "contact-2")), undefined, "D5: another Xero contact");
  assertEquals(offer(cn("issued", 5_000, null), target("issued", 3_000, null)), undefined, "no contact is not a match");
  assertThrows(
    () => assertCreditNoteAction(cn("issued"), { allocations: [], invoice: target() }, { action: "allocate_credit_note", amount_cents: 3_001 }),
    InvoiceActionRefusal,
    "exceeds",
  );
  assertCreditNoteAction(cn("issued"), { allocations: [], invoice: target() }, { action: "allocate_credit_note", amount_cents: 3_000 });
});

// ── orders (D7) ──────────────────────────────────────────────────────

const order = (status: OfferOrder["status"]): OfferOrder => ({ uid: "ord", number: 1060, status, items: [], destinations: [] });

Deno.test("D7: the three create actions refuse a canceled order, and only that", () => {
  const statuses: OfferOrder["status"][] = ["draft", "quoted", "reserved", "active", "complete", "canceled"];
  for (const status of statuses) {
    const offers = orderInvoiceActionsFor(order(status), { replacement_units: 2 });
    const open = status !== "canceled";
    assertEquals(has(offers, "create_invoice"), open, status);
    assertEquals(has(offers, "create_remaining_invoice"), open, `${status}: invoices unknown ⇒ offered`);
    assertEquals(has(offers, "create_replacement_invoice"), open, status);
  }
  assertThrows(
    () => assertOrderInvoiceAction(order("canceled"), {}, { action: "create_invoice" }),
    InvoiceActionRefusal,
    "canceled",
  );
});

Deno.test("D7: Invoice Remaining reads remainingForOrder once the invoices are known", () => {
  // No lines, invoices known ⇒ nothing remains ⇒ not offered.
  const offers = orderInvoiceActionsFor(order("active"), { invoices: [] });
  assertEquals(has(offers, "create_remaining_invoice"), false);
  assertEquals(has(offers, "credit_overbilling"), false);
  assertEquals(has(offers, "create_replacement_invoice"), false, "absent replacement_units ⇒ 0");
});

Deno.test("an InvoiceActionRefusal names its action", () => {
  try {
    assertInvoiceAction(invoice("draft"), {}, { action: "add_payment", amount_cents: 1 });
  } catch (e) {
    assertEquals(e instanceof InvoiceActionRefusal && e.action, "add_payment");
    return;
  }
  throw new Error("expected a refusal");
});
