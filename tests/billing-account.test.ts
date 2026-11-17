/**
 * The one per-line account (`accountInitiator`, one-document-model 6e-0b2 F9,
 * rulings 90–92).
 *
 * Where the account AGREES with what it replaces (`accountLine`,
 * `remainingForOrder`, `buildOverbillingCredits`, the diff's quantity entries)
 * it was proved by running it beside them over every fixture in this suite and
 * over the stored corpus in prod, dev and `test`. These cases pin the rules it
 * states once, each beside the reading it must NOT give:
 *
 * - a quantity disagreement exists only once a live billing document is
 *   compared (ruling 90), on BOTH sides — an AP line no bill names included;
 * - custody is shown and is never a reason (ruling 35);
 * - an exchange unit never disagrees (decision 8);
 * - only a STATED line can disagree on money (ruling 39);
 * - what acts floors an over-credit; what is shown does not (R2);
 * - the over-billing offer refuses a draft biller, and names its row;
 * - the shared refusal reads the documents' headers.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type AccountedCreditNote,
  type AccountedInvoice,
  accountInitiator,
  type AccountingContext,
  billedByPath,
  type CustodyRow,
  type PayableFoldBill,
} from "../src/utils/quantityAccounting.ts";
import type { LineItem } from "../src/utils/orders.ts";

const O = "order-1";
const P = "purchase-1";
const D = "dest-1";
const X = "prod-x";
const Y = "prod-y";
const KX = `${D}/${X}`;
const KY = `${D}/${Y}`;

const ctx: AccountingContext = { formulas: new Map(), holidays: [] };
const row = (o: Record<string, unknown>) => o as unknown as LineItem;

/** A $10.00-per-unit flat rate line. */
const ratePrice = { price_formula: { basis: "flat" }, rates: [{ rate_key: "base", amount_cents: 1000 }], counts: [{ rate_key: "base", num: 1, den: 1 }], discount: null, stated_cents: null };

const orderOf = (quantity: number, extra: Record<string, unknown> = {}) => ({
  uid: O,
  destinations: [],
  items: [
    row({ uid: D, type: "destination", path: [D], name: "", description: "" }),
    row({ uid: X, type: "rental", path: [D, X], quantity, price: ratePrice, ...extra }),
  ],
});

const invoice = (uid: string, quantity: number, status: AccountedInvoice["status"] = "issued", more: Partial<AccountedInvoice> = {}): AccountedInvoice => ({
  uid,
  status,
  number: 100,
  items: [
    { uid: O, type: "order", path: [O] },
    { uid: D, type: "destination", path: [O, D] },
    { uid: X, type: "rental", path: [O, D, X], quantity, price: { ...ratePrice, subtotal_discounted_cents: quantity * 1000 } },
  ] as unknown as AccountedInvoice["items"],
  ...more,
});

const accountAR = (order: ReturnType<typeof orderOf>, invoices: AccountedInvoice[], notes: AccountedCreditNote[] = [], custody: Map<string, CustodyRow> | null = null) =>
  accountInitiator("receivable", order, billedByPath("receivable", order, invoices, notes), custody, [], ctx);

Deno.test("accountInitiator: an unbilled line disagrees only once a live billing document is compared (ruling 90)", () => {
  const none = accountAR(orderOf(3), []);
  assertEquals([...none.lines[0].disagrees], []);
  // The figures are still stated: nothing has billed 3 ordered units.
  assertEquals([none.lines[0].quantity, none.lines[0].quantity_cents], [3, 3000]);

  const partly = accountAR(orderOf(3), [invoice("inv-1", 2)]);
  assertEquals([...partly.lines[0].disagrees], ["quantity"]);
  assertEquals([partly.lines[0].quantity, partly.lines[0].quantity_cents, partly.lines[0].naming], [1, 1000, ["inv-1"]]);
  assertEquals([partly.lines[0].remaining.units, partly.lines[0].remaining.bills], [1, true]);
});

Deno.test("accountInitiator: custody is SHOWN and never a reason (ruling 35)", () => {
  const custody = new Map<string, CustodyRow>([[KX, { quantity: 5, item: null }]]);
  const out = accountAR(orderOf(3), [invoice("inv-1", 3)], [], custody);
  const line = out.lines[0];
  assertEquals(line.custody, { quantity: 5, quantity_cents: 2000 });
  assertEquals([...line.disagrees], []);
  // The companion: the retired trigger fired when custody differed from BOTH others.
  assert(line.custody!.quantity !== line.ordered && line.custody!.quantity !== line.billed.quantity);
});

Deno.test("accountInitiator: a custody row the initiator lacks is custody-only, against what is billed there", () => {
  const custody = new Map<string, CustodyRow>([[`${D}/extra`, { quantity: 2, item: row({ uid: "extra", type: "rental", path: [D, "extra"], quantity: 2 }) }]]);
  const out = accountAR(orderOf(3), [invoice("inv-1", 3)], [], custody);
  assertEquals(out.custody_only.map((r) => [r.path, r.custody, r.billed]), [[[D, "extra"], 2, 0]]);
});

Deno.test("accountInitiator: an exchange unit is shown and never disagrees (decision 8)", () => {
  const out = accountAR(orderOf(2, { exchanged_for: [{ uid_out_of_service: "oos-1", quantity: 2 }] }), [invoice("inv-1", 0)]);
  assertEquals(out.lines[0].kind, "exchange");
  assertEquals(out.lines[0].quantity, 2);
  assertEquals([...out.lines[0].disagrees], []);
});

Deno.test("accountInitiator: what ACTS floors an over-credit; what is SHOWN does not (R2)", () => {
  const note: AccountedCreditNote = {
    uid: "cn-1",
    status: "issued",
    sources: [{ collection: "invoices", uid: "inv-1" }],
    items: [{ quantity: 4, path_invoice_item: [O, D, X], reverses_billing: true, price: { subtotal_discounted_cents: 4000 } }],
  };
  const line = accountAR(orderOf(3), [invoice("inv-1", 3)], [note]).lines[0];
  assertEquals([line.billed.quantity, line.quantity], [-1, 4]);
  assertEquals(line.remaining.units, 3);
  assertEquals(line.credit_sources, ["cn-1"]);
});

Deno.test("accountInitiator: over-billing offers a credit on the row that billed it, and refuses a DRAFT biller", () => {
  const issued = accountAR(orderOf(2), [invoice("inv-1", 3, "issued", { amount_due_cents: 3000 })]).lines[0];
  assertEquals(issued.overbilled.units, 1);
  assertEquals(issued.credit.lines.map((l) => [l.uid_billing, l.path_billing_item, l.quantity, l.preview_cents]), [["inv-1", [O, D, X], 1, 1000]]);

  const draft = accountAR(orderOf(2), [invoice("inv-1", 3, "draft")]).lines[0];
  assertEquals(draft.credit.lines, []);
  assertEquals(draft.credit.refused.length, 1);
});

Deno.test("accountInitiator: the shared refusal reads the headers — a live CRMS invoice blocks, a void one does not", () => {
  const live = accountAR(orderOf(3), [invoice("inv-1", 3, "issued", { crms_id: 77 })]);
  assertEquals([live.crms_blocked, live.refused], [true, true]);
  assertEquals(live.documents.get("inv-1")?.crms_id, 77);

  const voided = accountAR(orderOf(3), [invoice("inv-1", 3, "void", { crms_id: 77 })]);
  assertEquals([voided.crms_blocked, voided.refused], [false, false]);
  assertEquals(voided.documents.get("inv-1")?.live, false);
});

// ── Payable ───────────────────────────────────────────────────────

const stated = (cents: number) => ({ price_formula: { basis: "flat" }, rates: [], counts: [], discount: null, stated_cents: cents });

const purchase = {
  uid: P,
  destinations: [],
  items: [
    row({ uid: D, type: "destination", path: [D], name: "", description: "" }),
    row({ uid: X, type: "sale", path: [D, X], quantity: 3, amount_cents: 3000, price: stated(3000) }),
    row({ uid: Y, type: "sale", path: [D, Y], quantity: 1, amount_cents: 500, price: stated(500) }),
  ],
};

const bill = (cents: number): PayableFoldBill =>
  ({
    uid: "bill-1",
    status: "issued",
    number: 7,
    destinations: [],
    totals: { amount_due_cents: cents },
    items: [
      { uid: P, type: "purchase", path: [P] },
      { uid: D, type: "destination", path: [P, D] },
      { uid: X, type: "sale", path: [P, D, X], quantity: 3, amount_cents: cents, price: stated(cents) },
    ],
  }) as unknown as PayableFoldBill;

const accountAP = (b: PayableFoldBill) => accountInitiator("payable", purchase, billedByPath("payable", purchase, [b]), null, [], ctx);

Deno.test("accountInitiator (AP): a line no bill names reports once a bill exists (ruling 90)", () => {
  const out = accountAP(bill(3000));
  const y = out.lines.find((l) => l.path.join("/") === KY)!;
  assertEquals([y.named, [...y.disagrees], y.quantity, y.quantity_cents], [false, ["quantity"], 1, 500]);
  assertEquals(out.documents.get("bill-1")?.amount_due_cents, 3000);
  assertEquals(out.crms_blocked, false);
});

Deno.test("accountInitiator: only a STATED line disagrees on money (ruling 39)", () => {
  const x = accountAP(bill(3001)).lines.find((l) => l.path.join("/") === KX)!;
  assertEquals([x.kind, x.expected_cents, x.billed.amount_cents, [...x.disagrees]], ["stated", 3000, 3001, ["money"]]);

  // The companion: a RATE line billed at other money is a field difference, not a money reason.
  const order = orderOf(3);
  const inv = invoice("inv-1", 3);
  (inv.items[2] as unknown as { price: { subtotal_discounted_cents: number } }).price.subtotal_discounted_cents = 3001;
  const rate = accountAR(order, [inv]).lines[0];
  assertEquals([rate.kind, rate.expected_cents, rate.billed.amount_cents, [...rate.disagrees]], ["rate", null, 3001, []]);
});
