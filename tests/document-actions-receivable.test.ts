/**
 * The one action catalog on the RECEIVABLE side (`utils/document-actions.ts`;
 * api-cloudrun#1169, one-document-model F15).
 *
 * Inputs are built from the VOCABULARIES — every invoice status, every
 * credit-note status, every settlement type — never from the tables under test,
 * so a row that silently stops being reachable fails a coverage arm here rather
 * than reading as a clean corpus.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { fdwCounts, fdwPrice, FORMULAS } from "./helpers/formulas.ts";
import {
  CREDIT_NOTE_STATUS_CONTRACTS,
  type CreditNoteStatusType,
  DOCUMENT_ACTION_IDS,
  DOCUMENT_ACTIONS,
  INVOICE_FIELD_CLASSES,
  INVOICE_FIELD_FREEZE,
  INVOICE_STATUS_CONTRACTS,
  type DocumentActionId,
  type InvoiceDocItemType,
  type InvoiceFieldClass,
  type InvoiceStatusType,
  SETTLEMENT_CONTRACTS,
  type SettlementTypeType,
} from "../src/schemas/mod.ts";
import * as cat from "../src/utils/document-actions.ts";
import { DocumentActionRefusal, type DocumentActionOffer } from "../src/utils/document-actions.ts";

// ── The F15 port: each pre-F15 receivable scenario, against the one catalog ──
// These adapters only map the old argument SHAPES onto the role functions; every
// assertion below states the catalog's own ids and behaviour.
type InvoiceActionOffer = DocumentActionOffer;
const InvoiceActionRefusal = DocumentActionRefusal;
type OfferInvoice = Omit<cat.BillingOfferDocuments["receivable"], "number" | "items" | "xero_id"> & {
  number?: number;
  items?: readonly InvoiceDocItemType[];
  xero_id?: string | null;
};
type CappedNote = { status: string; items: readonly unknown[] };
type OfferCreditNote = Omit<cat.CreditOfferDocuments["receivable"], "uid">;
type OfferOrder = cat.InitiatorOfferDocuments["receivable"];
type OfferSettlement = cat.OfferSettlement;
interface InvoiceCtx {
  settlements?: readonly OfferSettlement[];
  creditNotes?: readonly CappedNote[];
  xero_sync_status?: BillingXeroSyncStatus;
}
const asDoc = (inv: OfferInvoice): cat.BillingOfferDocuments["receivable"] =>
  ({ ...inv, number: inv.number ?? 2001, items: (inv.items ?? []) as never, xero_id: inv.xero_id ?? null });
const billingCtx = (ctx: InvoiceCtx = {}): cat.BillingOfferContext<"receivable"> => ({
  settlements: ctx.settlements ?? [],
  credits: (ctx.creditNotes ?? []) as never,
  initiators: [],
  xero_sync_status: ctx.xero_sync_status ?? "not_applicable",
});
const invoiceActionsFor = (inv: OfferInvoice, ctx: InvoiceCtx = {}) => cat.billingActionsFor("receivable", asDoc(inv), billingCtx(ctx));
type InvoiceRequest =
  | { action: "add_payment"; amount_cents: number }
  | { action: "reverse_settlement"; uid_settlement: string }
  | { action: "add_credit"; invoice_number: number; lines: readonly cat.CappedCreditLine[] }
  | { action: "edit_items"; money_moved: boolean }
  | { action: "issue" | "void" | "close" | "edit_counterparty" | "edit_date" | "push_to_xero" };
function assertInvoiceAction(inv: OfferInvoice, ctx: InvoiceCtx, request: InvoiceRequest): void {
  const doc = asDoc(inv);
  const c = billingCtx(ctx);
  switch (request.action) {
    case "reverse_settlement":
      return cat.assertBillingAction("receivable", doc, { ...request, settlements: c.settlements });
    case "add_credit":
      return cat.assertBillingAction("receivable", { ...doc, number: request.invoice_number }, { action: "add_credit", lines: request.lines, credits: c.credits, initiators: [] });
    case "void":
      return cat.assertBillingAction("receivable", doc, { action: "void", credits: c.credits, initiators: [] });
    case "push_to_xero":
      if (ctx.xero_sync_status === undefined) throw new DocumentActionRefusal("push_to_xero", "the sync status is unknown to the caller");
      return cat.assertBillingAction("receivable", doc, { action: "push_to_xero", xero_sync_status: ctx.xero_sync_status });
    default:
      return cat.assertBillingAction("receivable", doc, request as cat.BillingActionRequest<"receivable">);
  }
}
const creditableLines = (invoice: { uid: string; items: readonly InvoiceDocItemType[] }, prior: readonly CappedNote[]) =>
  cat.creditableLines("receivable", { uid: invoice.uid, status: "issued", items: invoice.items as never }, { credits: prior as never, initiators: [] });
const creditKitParts = (invoice: { uid: string; items: readonly InvoiceDocItemType[] }, path: string[], n: number, prior: readonly CappedNote[]) =>
  cat.creditParts({ uid: invoice.uid, items: invoice.items as never }, path, n, prior as never);
const creditNoteOverCredit = (
  num: number,
  invoice: { uid: string; items: readonly InvoiceDocItemType[] },
  requested: readonly cat.CappedCreditLine[],
  prior: readonly CappedNote[],
) => cat.creditRefusal("receivable", { uid: invoice.uid, number: num, status: "issued", items: invoice.items as never }, { credits: prior as never, initiators: [] }, requested);
const creditNoteActionsFor = (n: OfferCreditNote, ctx: { allocations: cat.CreditOfferContext<"receivable">["allocations"]; invoice?: cat.AllocationTargets["receivable"] }) =>
  cat.creditActionsFor("receivable", { uid: "cn", ...n }, { allocations: ctx.allocations, target: ctx.invoice ?? null });
function assertCreditNoteAction(
  n: OfferCreditNote,
  ctx: { allocations: cat.CreditOfferContext<"receivable">["allocations"]; invoice?: cat.AllocationTargets["receivable"] },
  request: { action: "void_credit" } | { action: "allocate_credit" | "record_refund"; amount_cents: number },
): void {
  const note = { uid: "cn", ...n };
  if (request.action === "void_credit") return cat.assertCreditAction("receivable", note, { action: "void_credit", allocations: ctx.allocations });
  if (request.action === "record_refund") return cat.assertCreditAction("receivable", note, { action: "record_refund", amount_cents: request.amount_cents });
  return cat.assertCreditAction("receivable", note, { action: "allocate_credit", amount_cents: request.amount_cents, target: ctx.invoice ?? null });
}
interface OrderCtx {
  invoices?: readonly AccountedInvoice[];
  creditNotes?: readonly unknown[];
  accounting?: cat.InitiatorOfferContext<"receivable">["accounting"];
  replacement_units?: number;
  on_request_units?: number;
}
const orderCtx = (ctx: OrderCtx): cat.InitiatorOfferContext<"receivable"> => ({
  billing: ctx.invoices ?? [],
  credits: (ctx.creditNotes ?? []) as never,
  accounting: ctx.accounting ?? { formulas: FORMULAS, holidays: [] },
  custody: new Map(),
  now: "2026-11-18T12:00:00.000-06:00",
  replacement_units: ctx.replacement_units ?? 0,
  on_request_units: ctx.on_request_units ?? 0,
});
const orderInvoiceActionsFor = (order: OfferOrder, ctx: OrderCtx = {}) => cat.initiatorActionsFor("receivable", order, orderCtx(ctx));
const assertOrderInvoiceAction = (order: OfferOrder, ctx: OrderCtx, request: cat.InitiatorActionRequest) =>
  cat.assertInitiatorAction("receivable", order, orderCtx(ctx), request);
import type { BillingXeroSyncStatus } from "../src/utils/xero-sync.ts";
import { invoiceFieldIsFrozen } from "../src/utils/invoices.ts";
import type { AccountedInvoice } from "../src/utils/quantityAccounting.ts";

const INVOICE_STATUSES = Object.keys(INVOICE_STATUS_CONTRACTS) as InvoiceStatusType[];
const NOTE_STATUSES = Object.keys(CREDIT_NOTE_STATUS_CONTRACTS) as CreditNoteStatusType[];
const SETTLEMENT_TYPES = Object.keys(SETTLEMENT_CONTRACTS) as SettlementTypeType[];
/** Every `BillingXeroSyncStatus` member. A type-only union, so `satisfies` below is what keeps it whole. */
const XERO_SYNC_STATUSES = ["in_sync", "out_of_sync", "unknown", "not_applicable"] as const satisfies readonly BillingXeroSyncStatus[];

/** A billed line: `qty` units over `days` chargeable days (null for a sale). */
function line(uid: string, qty: number, days: number | null): InvoiceDocItemType {
  return {
    uid,
    path: ["ord", "dest", uid],
    type: "rental",
    name: uid,
    quantity: qty,
    price: { ...fdwPrice(0, days) },
  } as unknown as InvoiceDocItemType;
}

const INV = "inv";
const DIVIDER = { uid: "dest", path: ["ord", "dest"], type: "destination" } as unknown as InvoiceDocItemType;

function invoice(
  status: InvoiceStatusType,
  o: Partial<OfferInvoice["totals"]> & { items?: InvoiceDocItemType[] } = {},
): OfferInvoice {
  const { items, ...totals } = o;
  const total = totals.total_cents ?? 10_000;
  const paid = totals.amount_paid_cents ?? 0;
  return {
    uid: INV,
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
const has = (offers: InvoiceActionOffer[], id: DocumentActionId) => offers.some((o) => o.action === id);
const row = (uid: string, type: SettlementTypeType, o: Partial<OfferSettlement> = {}): OfferSettlement => ({
  uid,
  type,
  reverses: null,
  xero_payment_id: null,
  ...o,
});

// ── vocabulary ───────────────────────────────────────────────────────

Deno.test("DOCUMENT_ACTION_IDS and DOCUMENT_ACTIONS name the same actions, both ways", () => {
  assertEquals([...DOCUMENT_ACTION_IDS].sort(), Object.keys(DOCUMENT_ACTIONS).sort());
  assertEquals(new Set(DOCUMENT_ACTION_IDS).size, DOCUMENT_ACTION_IDS.length, "no duplicate id");
  for (const id of DOCUMENT_ACTION_IDS) assertEquals(DOCUMENT_ACTIONS[id].roles.length > 0, true, id);
});

/**
 * The coverage oracle: which receivable billing-role actions never appear in
 * `seen`. A row that has silently become unreachable is exactly an id this returns.
 */
function unreached(role: "billing" | "credit" | "initiator", seen: Set<DocumentActionId>): DocumentActionId[] {
  return DOCUMENT_ACTION_IDS.filter((id) => cat.sideOffers("receivable", role, id) && !DOCUMENT_ACTIONS[id].per_line && !seen.has(id));
}

/** Every offer across a sweep of invoices built from the status × settlement vocabulary. */
function invoiceSweep(): InvoiceActionOffer[][] {
  const out: InvoiceActionOffer[][] = [];
  for (const status of INVOICE_STATUSES) {
    for (const total of [0, 10_000]) {
      for (const closure of [0, 1]) {
        const every = SETTLEMENT_TYPES.map((t, i) => row(`s${i}`, t, SETTLEMENT_CONTRACTS[t].reverses === "required" ? { reverses: "x" } : {}));
        for (const settlements of [[], every]) {
          for (const xero_sync_status of [undefined, ...XERO_SYNC_STATUSES]) {
            const inv = { ...invoice(status, { total_cents: total, closure_count: closure }), xero_id: "x-1" };
            out.push(invoiceActionsFor(inv, { settlements, xero_sync_status }));
          }
        }
      }
    }
  }
  return out;
}

Deno.test("every receivable billing action is OFFERED somewhere and REFUSED somewhere in the vocabulary sweep", () => {
  const sweep = invoiceSweep();
  const offered = new Set(sweep.flatMap(ids));
  // `add_credit` needs a credit-left line, which every fixture invoice has.
  assertEquals(unreached("billing", offered), []);
  // …and none is offered everywhere, except `edit_items`, which D8 keeps open on
  // every status (money freezes, labels do not).
  for (const id of DOCUMENT_ACTION_IDS.filter((i) => cat.sideOffers("receivable", "billing", i))) {
    const everywhere = sweep.every((offers) => has(offers, id));
    assertEquals(everywhere, id === "edit_items", id);
  }
  // Only billing-role ids are ever offered on a billing document (F15 item 1).
  for (const id of offered) assertEquals(DOCUMENT_ACTIONS[id].roles.includes("billing"), true, id);
});

Deno.test("the coverage oracle can fail — deleting a reachable action turns it red", () => {
  // A guard that cannot go red is not one. Drop `close` from the sweep's
  // results, as a deleted row in the ruleset would, and the oracle names it.
  const mutated = new Set(invoiceSweep().flatMap(ids).filter((id) => id !== "close"));
  assertEquals(unreached("billing", mutated), ["close"]);
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
  uid_billing: INV,
  path_billing_item: ["ord", "dest", uid],
  // A days credit STATES the time it gave back, unfloored; a whole-unit credit carries none of its own.
  price: { ...fdwPrice(0), counts: days === null ? [] : fdwCounts(days, { stated: true }) },
});

Deno.test("R5 creditKitParts: a kit pre-fills its components at the INVOICE's ratio, first-come after prior credits", () => {
  // Kit 3 with 6 stakes (2 each) and 3 cables (1 each); a plain light beside it.
  const at = (uid: string, path: string[], qty: number) => ({ ...line(uid, qty, null), path }) as InvoiceDocItemType;
  const items = [
    DIVIDER,
    at("kit", ["ord", "dest", "kit"], 3),
    at("stake", ["ord", "dest", "kit", "stake"], 6),
    at("cable", ["ord", "dest", "kit", "cable"], 3),
    at("light", ["ord", "dest", "light"], 4),
  ];
  const parts = (n: number, prior: CappedNote[] = []) => creditKitParts({ uid: INV, items }, ["ord", "dest", "kit"], n, prior).map((p) => [p.uid, p.quantity]);
  assertEquals(parts(1), [["kit", 1], ["stake", 2], ["cable", 1]]);
  // After 1 kit already credited, the next 2 take the rows' next units, and the three credits sum to each row.
  const prior = [note("issued", { name: "kit", quantity: 1, uid_billing: INV, path_billing_item: ["ord", "dest", "kit"], price: { counts: [] } })];
  assertEquals(parts(2, prior), [["kit", 2], ["stake", 4], ["cable", 2]]);
  // A plain line is itself alone; a path with no line pre-fills nothing.
  assertEquals(creditKitParts({ uid: INV, items }, ["ord", "dest", "light"], 2, []).map((p) => [p.uid, p.quantity]), [["light", 2]]);
  assertEquals(creditKitParts({ uid: INV, items }, ["ord", "dest", "nothing"], 1, []), []);
});

Deno.test("D3 creditableLines nets prior notes in unit-TIME, exactly; void notes and dividers are skipped", () => {
  const items = [DIVIDER, line("cam", 5, 10), line("bag", 2, null)];
  const prior = [
    note("issued", credit("cam", 1, 4)), // a 4-day shortening of one unit: 4/5 of a week
    note("void", credit("cam", 5)), // void: ignored
    note("applied", credit("bag", 1)), // a sale unit: 1 unit
  ];
  // cam: 5 units × 2 weeks = 10, less 4/5 → 46/5 unit-weeks; ⌊(46/5) ÷ 2⌋ = 4 whole units.
  assertEquals(creditableLines({ uid: INV, items }, prior).map((l) => [l.uid, l.unit_time, l.units]), [
    ["cam", { num: 46, den: 5 }, 4],
    ["bag", { num: 1, den: 1 }, 1],
  ]);
});

Deno.test("D3: a note line stating no counts consumes the row's FULL time, not one period", () => {
  // Read as one period, crediting all 5 units of a 5 × 5-day row would leave room for more.
  const items = [line("cam", 5, 5)];
  assertEquals(creditableLines({ uid: INV, items }, [note("issued", credit("cam", 5))])[0].unit_time, { num: 0, den: 1 });
});

Deno.test("D3 creditableLines keys by (uid_billing, path_billing_item): a line naming ANOTHER invoice at the same path does not count", () => {
  // A deposit and a final invoice bill one order line at one path (ruling 107): a
  // note crediting the deposit's row must not spend the final invoice's budget.
  const items = [line("cam", 5, 10)];
  const other = { ...credit("cam", 5), uid_billing: "inv-deposit" };
  assertEquals(creditableLines({ uid: INV, items }, [note("issued", other)])[0].units, 5);
  assertEquals(creditableLines({ uid: "inv-deposit", items }, [note("issued", other)])[0].units, 0);
});

Deno.test("D3 creditNoteOverCredit: the api's two arms, with its messages", () => {
  const items = [line("cam", 5, 10)];
  // Arm A — more units than the row billed, checked first.
  assertEquals(creditNoteOverCredit(2001, { uid: INV, items }, [credit("cam", 6)], []), 'crediting 6 of "cam" exceeds what invoice 2001 billed (5)');
  // Arm B — the 140% counter-example: 5 × 4/5 = 4 unit-weeks already, then 5 whole units (10).
  assertEquals(
    creditNoteOverCredit(2001, { uid: INV, items }, [credit("cam", 5)], [note("issued", credit("cam", 5, 4))]),
    'crediting 5 × 2 period(s) of "cam" is 10 unit-periods, and invoice 2001 billed 10 (5 × 2) less 4 already credited',
  );
  // A sale line keeps the plain wording.
  assertEquals(
    creditNoteOverCredit(7, { uid: INV, items: [line("bag", 2, null)] }, [credit("bag", 2)], [note("issued", credit("bag", 1))]),
    'crediting 2 of "bag" exceeds what invoice 7 billed (2) less what is already credited (1)',
  );
  assertEquals(creditNoteOverCredit(2001, { uid: INV, items }, [credit("cam", 4)], [note("issued", credit("cam", 1))]), null);
});

Deno.test("D3 add_credit_note: offered on a status live in Xero with credit left", () => {
  for (const status of INVOICE_STATUSES) {
    assertEquals(has(invoiceActionsFor(invoice(status)), "add_credit"), INVOICE_STATUS_CONTRACTS[status].live_in_xero, status);
  }
  const spent = invoiceActionsFor(invoice("issued"), { creditNotes: [note("issued", credit("cam", 5))] });
  assertEquals(has(spent, "add_credit"), false, "every unit already credited");
  assertThrows(
    () => assertInvoiceAction(invoice("draft"), {}, { action: "add_credit", invoice_number: 9, lines: [credit("cam", 1)] }),
    InvoiceActionRefusal,
    "issued invoice",
  );
});

// ── edit (D8) ────────────────────────────────────────────────────────

Deno.test("D8 edit_items: always offered; money frozen with the freeze, labels never", () => {
  for (const status of INVOICE_STATUSES) {
    const o = invoiceActionsFor(invoice(status)).find((x) => x.action === "edit_items")!;
    assertEquals(o.money_frozen, status === "paid" || status === "credited" || status === "void", status);
  }
  const paidUp = invoice("part_paid", { amount_paid_cents: 1 });
  assertEquals(invoiceActionsFor(paidUp).find((x) => x.action === "edit_items")!.money_frozen, true, "a partial payment freezes money");
  assertThrows(() => assertInvoiceAction(paidUp, {}, { action: "edit_items", money_moved: true }), InvoiceActionRefusal, "settled");
  assertInvoiceAction(paidUp, {}, { action: "edit_items", money_moved: false });
  // A closed $0 invoice is frozen (R1); reopening it unfreezes.
  const closed = invoice("paid", { total_cents: 0, closure_count: 1 });
  assertEquals(has(invoiceActionsFor(closed), "edit_counterparty"), false);
  assertEquals(has(invoiceActionsFor(invoice("issued", { total_cents: 0, closure_count: 0 })), "edit_date"), true);
});

Deno.test("D4 frozen_classes: literal per fixture — draft, issued, part_paid with a payment, paid, void", () => {
  const cases: [string, OfferInvoice, InvoiceFieldClass[]][] = [
    ["draft", invoice("draft"), []],
    ["issued", invoice("issued"), []],
    ["part_paid + payment", invoice("part_paid", { amount_paid_cents: 1 }), ["counterparty", "date", "line_money", "ledger_account"]],
    ["paid", invoice("paid"), ["counterparty", "date", "line_money", "ledger_account"]],
    ["void", invoice("void"), ["counterparty", "date", "line_money", "ledger_account", "tracking"]],
  ];
  for (const [label, inv, want] of cases) {
    const o = invoiceActionsFor(inv).find((x) => x.action === "edit_items")!;
    assertEquals(o.frozen_classes, want, label);
    assertEquals(o.money_frozen, want.includes("line_money"), label);
    assertEquals(INVOICE_FIELD_CLASSES.filter((c) => invoiceFieldIsFrozen(inv, c)), want, label);
    assertEquals(has(invoiceActionsFor(inv), "edit_counterparty"), !want.includes("counterparty"), label);
    assertEquals(has(invoiceActionsFor(inv), "edit_date"), !want.includes("date"), label);
  }
  // The text class is never frozen — on a void invoice included.
  assertEquals(invoiceFieldIsFrozen(invoice("void"), "text"), false);
});

Deno.test("D4 INVOICE_FIELD_FREEZE: every class has a row, and no field sits in two classes", () => {
  assertEquals(Object.keys(INVOICE_FIELD_FREEZE).sort(), [...INVOICE_FIELD_CLASSES].sort());
  for (const side of ["receivable", "payable"] as const) {
    const seen = new Map<string, string>();
    for (const cls of INVOICE_FIELD_CLASSES) {
      for (const m of INVOICE_FIELD_FREEZE[cls].members[side]) {
        assertEquals(seen.get(m), undefined, `${side}: ${m} is in ${seen.get(m)} and ${cls}`);
        seen.set(m, cls);
      }
    }
  }
  // Phase 0's ruling, stated literally: Xero takes a settled tracking edit, not an account change.
  assertEquals(INVOICE_FIELD_FREEZE.tracking.xero_accepts_on_settled, true);
  assertEquals(INVOICE_FIELD_FREEZE.ledger_account.xero_accepts_on_settled, false);
});

Deno.test("ruling 117 void: refused while anything is paid or credited against the invoice, Xero's or CFS's", () => {
  // AR used to void and RELEASE its settlements, refused only when Xero held one;
  // a CFS-recorded payment Xero had not yet seen then silently disappeared.
  for (const money of [{ amount_paid_cents: 1 }, { amount_credited_cents: 1 }]) {
    const inv = invoice("part_paid", money);
    assertEquals(has(invoiceActionsFor(inv), "void"), false, JSON.stringify(money));
    assertThrows(() => assertInvoiceAction(inv, {}, { action: "void" }), InvoiceActionRefusal, "payments or credits");
  }
  assertInvoiceAction(invoice("issued"), {}, { action: "void" });
  // Still the status gate first: a void invoice is refused for its status.
  assertThrows(() => assertInvoiceAction(invoice("void"), {}, { action: "void" }), InvoiceActionRefusal, "cannot be voided");
});

// ── push to Xero (api-cloudrun#1332) ─────────────────────────────────

Deno.test("api-cloudrun#1332 push_to_xero: a linked issued/part_paid/paid invoice whose Xero twin is not known in sync", () => {
  // Exhaustiveness of the hand-written list: an `BillingXeroSyncStatus` member
  // missing from it would be a status this block never tries.
  const _all: Record<BillingXeroSyncStatus, true> = { in_sync: true, out_of_sync: true, unknown: true, not_applicable: true };
  assertEquals(Object.keys(_all).sort(), [...XERO_SYNC_STATUSES].sort());

  for (const status of INVOICE_STATUSES) {
    for (const xero_sync_status of XERO_SYNC_STATUSES) {
      const inv = { ...invoice(status), xero_id: "x-1" };
      const expected = (status === "issued" || status === "part_paid" || status === "paid" || status === "credited") &&
        (xero_sync_status === "out_of_sync" || xero_sync_status === "unknown");
      assertEquals(has(invoiceActionsFor(inv, { xero_sync_status }), "push_to_xero"), expected, `${status}/${xero_sync_status}`);
      if (expected) assertInvoiceAction(inv, { xero_sync_status }, { action: "push_to_xero" });
      else {
        assertThrows(
          () => assertInvoiceAction(inv, { xero_sync_status }, { action: "push_to_xero" }),
          InvoiceActionRefusal,
          undefined,
          `${status}/${xero_sync_status}`,
        );
      }
    }
  }
  // Unlinked: the issue POST never landed, so an EDIT push has nothing to edit.
  for (const xero_id of [null, undefined]) {
    const unlinked = { ...invoice("issued"), xero_id };
    assertEquals(has(invoiceActionsFor(unlinked, { xero_sync_status: "out_of_sync" }), "push_to_xero"), false, String(xero_id));
    assertThrows(() => assertInvoiceAction(unlinked, { xero_sync_status: "out_of_sync" }, { action: "push_to_xero" }), InvoiceActionRefusal, "not linked");
  }
  // A caller that did not read the sidecar is not offered the push.
  const linked = { ...invoice("issued"), xero_id: "x-1" };
  assertEquals(has(invoiceActionsFor(linked), "push_to_xero"), false);
  assertThrows(() => assertInvoiceAction(linked, {}, { action: "push_to_xero" }), InvoiceActionRefusal, "unknown to the caller");
  // A CFS-recorded payment does not block it: the task decides on what Xero holds.
  const paidInCfs = { ...invoice("part_paid", { amount_paid_cents: 1_000 }), xero_id: "x-1" };
  assertEquals(has(invoiceActionsFor(paidInCfs, { xero_sync_status: "out_of_sync" }), "push_to_xero"), true);
  // Nor does CFS `paid` (prod #2399, #2413) — a hashless one arrives `not_applicable`.
  const fullyPaidInCfs = { ...invoice("paid", { amount_paid_cents: 5_000 }), xero_id: "x-1" };
  assertEquals(has(invoiceActionsFor(fullyPaidInCfs, { xero_sync_status: "out_of_sync" }), "push_to_xero"), true);
  assertEquals(has(invoiceActionsFor(fullyPaidInCfs, { xero_sync_status: "not_applicable" }), "push_to_xero"), false);
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
  const seen = new Set<DocumentActionId>();
  for (const status of NOTE_STATUSES) {
    const offers = creditNoteActionsFor(cn(status), { allocations: [] });
    offers.forEach((o) => seen.add(o.action));
    assertEquals(has(offers, "void_credit"), CREDIT_NOTE_STATUS_CONTRACTS[status].voidable, status);
    assertEquals(has(offers, "allocate_credit"), CREDIT_NOTE_STATUS_CONTRACTS[status].accepts_allocation, status);
    assertEquals(has(offers, "record_refund"), CREDIT_NOTE_STATUS_CONTRACTS[status].accepts_allocation, status);
  }
  assertEquals(unreached("credit", seen), []);
});

Deno.test("D4 void_credit_note: not while an allocation is live", () => {
  const live = [{ uid: "a1", type: "credit" as const, reverses: null }];
  const retracted = [...live, { uid: "a1r", type: "credit_reversal" as const, reverses: "a1" }];
  assertEquals(has(creditNoteActionsFor(cn("applied", 0), { allocations: live }), "void_credit"), false);
  assertEquals(has(creditNoteActionsFor(cn("issued"), { allocations: retracted }), "void_credit"), true);
  assertThrows(() => assertCreditNoteAction(cn("applied", 0), { allocations: live }, { action: "void_credit" }), InvoiceActionRefusal, "live allocation");
});

Deno.test("D5/D6 allocate_credit_note: credit left, an invoice that accepts payment, the same Xero contact", () => {
  const offer = (n: OfferCreditNote, inv?: ReturnType<typeof target>) =>
    creditNoteActionsFor(n, { allocations: [], invoice: inv }).find((o) => o.action === "allocate_credit");
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
    () => assertCreditNoteAction(cn("issued"), { allocations: [], invoice: target() }, { action: "allocate_credit", amount_cents: 3_001 }),
    InvoiceActionRefusal,
    "exceeds",
  );
  assertCreditNoteAction(cn("issued"), { allocations: [], invoice: target() }, { action: "allocate_credit", amount_cents: 3_000 });
});

Deno.test("void_credit_note: not while a refund is live (api-cloudrun#1207)", () => {
  const live = [{ uid: "r1", type: "refund" as const, reverses: null }];
  const reaped = [...live, { uid: "r1r", type: "refund_reversal" as const, reverses: "r1" }];
  assertEquals(has(creditNoteActionsFor(cn("applied", 0), { allocations: live }), "void_credit"), false);
  assertEquals(has(creditNoteActionsFor(cn("issued"), { allocations: reaped }), "void_credit"), true);
  assertThrows(() => assertCreditNoteAction(cn("applied", 0), { allocations: live }, { action: "void_credit" }), InvoiceActionRefusal, "live refund");
});

Deno.test("record_refund: note-level, credit left, capped at the remaining credit", () => {
  const offer = (n: OfferCreditNote, inv?: ReturnType<typeof target>) =>
    creditNoteActionsFor(n, { allocations: [], invoice: inv }).find((o) => o.action === "record_refund");
  assertEquals(offer(cn("issued"))?.max_cents, 5_000);
  assertEquals(offer(cn("issued"), target()), undefined, "an invoice context is an allocation question");
  assertEquals(offer(cn("issued", 0)), undefined, "nothing left");
  assertEquals(offer(cn("issued", 5_000, null))?.max_cents, 5_000, "no Xero contact needed — a refund pays the customer");
  assertThrows(() => assertCreditNoteAction(cn("issued"), { allocations: [] }, { action: "record_refund", amount_cents: 5_001 }), InvoiceActionRefusal, "exceeds");
  assertThrows(() => assertCreditNoteAction(cn("issued"), { allocations: [] }, { action: "record_refund", amount_cents: 0 }), InvoiceActionRefusal, "more than $0");
  assertThrows(() => assertCreditNoteAction(cn("applied", 0), { allocations: [] }, { action: "record_refund", amount_cents: 1 }), InvoiceActionRefusal);
  assertCreditNoteAction(cn("issued"), { allocations: [] }, { action: "record_refund", amount_cents: 5_000 });
});

// ── orders (D7) ──────────────────────────────────────────────────────

const order = (status: OfferOrder["status"]): OfferOrder => ({ uid: "ord", number: 1060, status, items: [], destinations: [] });

Deno.test("D7: the three create actions refuse a canceled order, and only that", () => {
  const statuses: OfferOrder["status"][] = ["draft", "quoted", "reserved", "active", "complete", "canceled"];
  for (const status of statuses) {
    const offers = orderInvoiceActionsFor(order(status), { replacement_units: 2, on_request_units: 1 });
    const open = status !== "canceled";
    assertEquals(has(offers, "create_billing"), open, status);
    // F15: the context is REQUIRED, so "invoices unknown ⇒ offered" is gone; an
    // order with no line has nothing remaining on any status.
    assertEquals(has(offers, "create_remaining_billing"), false, `${status}: nothing remains`);
    assertEquals(has(offers, "create_replacement_billing"), open, status);
    assertEquals(has(offers, "create_service_charge_billing"), open, status);
  }
  assertThrows(
    () => assertOrderInvoiceAction(order("canceled"), {}, { action: "create_billing" }),
    InvoiceActionRefusal,
    "canceled",
  );
});

Deno.test("api-cloudrun#1163: lost/damaged and cleaning/maintenance are offered independently", () => {
  const ids = (ctx: { replacement_units?: number; on_request_units?: number }) =>
    orderInvoiceActionsFor(order("active"), ctx).map((o) => o.action).filter((a) =>
      a === "create_replacement_billing" || a === "create_service_charge_billing"
    );
  assertEquals(ids({ replacement_units: 1 }), ["create_replacement_billing"]);
  assertEquals(ids({ on_request_units: 1 }), ["create_service_charge_billing"]);
  assertEquals(ids({ replacement_units: 1, on_request_units: 1 }), ["create_replacement_billing", "create_service_charge_billing"]);
  assertEquals(ids({ replacement_units: 0, on_request_units: 0 }), []);
});

Deno.test("D7: Invoice Remaining reads remainingForOrder once the invoices are known", () => {
  // No lines, invoices known ⇒ nothing remains ⇒ not offered.
  const offers = orderInvoiceActionsFor(order("active"), { invoices: [], accounting: { formulas: FORMULAS, holidays: [] } });
  assertEquals(has(offers, "create_remaining_billing"), false);
  assertEquals(has(offers, "credit_overbilling"), false);
  assertEquals(has(offers, "create_replacement_billing"), false, "absent replacement_units ⇒ 0");
  assertEquals(has(offers, "create_service_charge_billing"), false, "absent on_request_units ⇒ 0");
});

Deno.test("core#120: an order that is ONLY over-billed is offered the credit, not Invoice Remaining", () => {
  // Ordered 2, billed 3: the one remainder line is −1 unit. The remainder build
  // has nothing to bill, so offering it sends the operator to a 409.
  const window = { start: "2026-09-06T00:00:00.000-05:00", end: "2026-09-11T00:00:00.000-05:00" };
  const pair = { uid: "dest", dates: { charge_windows: [window] } };
  const cam = (path: string[], quantity: number) => ({
    uid: "cam", type: "rental", name: "cam", description: "", quantity, path,
    stock_method: "reserve", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
    price: {
      ...fdwPrice(1000, 5),
      subtotal_cents: 0,
      subtotal_discounted_cents: 0,
      discount: null,
      taxes: [],
      total_cents: 0,
      replacement_cents: 1000,
    },
  });
  const overBilled = {
    ...order("active"),
    items: [{ uid: "dest", type: "destination", name: "Venue", description: "", path: ["dest"] }, cam(["dest", "cam"], 2)],
    destinations: [pair],
  } as unknown as OfferOrder;
  const billed = {
    uid: "inv-a",
    status: "issued",
    items: [
      { uid: "ord", type: "order", name: "Order", description: "", path: ["ord"] },
      { uid: "dest", type: "destination", name: "Venue", description: "", path: ["ord", "dest"] },
      cam(["ord", "dest", "cam"], 3),
    ],
    destinations: [{ ...pair, uid_source: "ord" }],
  } as unknown as AccountedInvoice;
  const offers = orderInvoiceActionsFor(overBilled, { invoices: [billed], creditNotes: [], accounting: { formulas: FORMULAS, holidays: [] } });
  assertEquals(has(offers, "credit_overbilling"), true, "the over-billing is real and offered");
  assertEquals(has(offers, "create_remaining_billing"), false, "and there is nothing to invoice");
  assertThrows(
    () => assertOrderInvoiceAction(overBilled, { invoices: [billed], creditNotes: [], accounting: { formulas: FORMULAS, holidays: [] } }, { action: "create_remaining_billing" }),
    InvoiceActionRefusal,
    "nothing to do",
  );
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
