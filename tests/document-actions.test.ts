/**
 * The one action catalog (`utils/document-actions.ts`; one-document-model F15,
 * rulings 110–118): the rules F15 ADDED or UNIFIED, each on both sides. The
 * scenarios each side already had are in `document-actions-receivable.test.ts`
 * and `document-actions-payable.test.ts`.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { DOCUMENT_ACTION_IDS, DOCUMENT_ACTIONS, type InvoiceDocItemType, type PurchaseBill, type PurchaseCredit } from "../src/schemas/mod.ts";
import * as cat from "../src/utils/document-actions.ts";
import type { AccountedCreditNote } from "../src/utils/quantityAccounting.ts";
import { fdwPrice } from "./helpers/formulas.ts";
import { asCreditRows, payablePrice, withPayableMoney } from "./helpers/payable.ts";
import { priceFormulaRefOf } from "../src/utils/price-formulas.ts";
import { FIXED, VISION } from "./helpers/formulas.ts";

// ── the catalog ──────────────────────────────────────────────────────

Deno.test("an offer function lists only ids whose roles include its role, on both sides (F15 item 1)", () => {
  for (const side of ["receivable", "payable"] as const) {
    for (const id of DOCUMENT_ACTION_IDS) {
      for (const role of ["initiator", "billing", "credit"] as const) {
        if (cat.sideOffers(side, role, id)) assert(DOCUMENT_ACTIONS[id].roles.includes(role), `${side} ${role} ${id}`);
      }
    }
  }
  // A side-only entry is offered on its own side and refused on the other.
  for (const [side, other] of [["receivable", "payable"], ["payable", "receivable"]] as const) {
    for (const entry of cat.SIDE_ONLY_ACTIONS[side]) {
      assertEquals(cat.sideOffers(side, entry.role, entry.action), true, `${entry.action} on ${side}`);
      assertEquals(cat.sideOffers(other, entry.role, entry.action), false, `${entry.action} on ${other}`);
    }
  }
  // `per_line` ids are the initiator's.
  for (const id of DOCUMENT_ACTION_IDS.filter((i) => DOCUMENT_ACTIONS[i].per_line)) assertEquals(DOCUMENT_ACTIONS[id].roles, ["initiator"], id);
});

Deno.test("a gap is refused by its reason, naming the action, on the assert (ruling 116)", () => {
  const bill = {
    uid: "b", number: 9, status: "issued" as const, origin: "pushed" as const, xero_document: "invoice" as const, xero_id: "x", items: [],
    totals: { total_cents: 100, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 100 },
  };
  const e = assertThrows(() => cat.assertBillingAction("payable", bill, { action: "edit_counterparty" }), cat.DocumentActionRefusal, "no `supplier`");
  assertEquals(e.action, "edit_counterparty");
  // 6e-0b3 removed the payment and refund gaps: a bill payment is the operator's to record now.
  cat.assertBillingAction("payable", bill, { action: "add_payment", amount_cents: 1 });
});

Deno.test("a card bill takes no operator payment, offered or asserted, even with a balance (ruling 134)", () => {
  const totals = { total_cents: 100, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 100 };
  const accpay = { uid: "b", number: 9, status: "issued" as const, origin: "linked" as const, xero_document: "invoice" as const, xero_id: "x", items: [], totals };
  const card = { ...accpay, xero_document: "bank_transaction" as const };
  const e = assertThrows(
    () => cat.assertBillingAction("payable", card, { action: "add_payment", amount_cents: 1 }),
    cat.DocumentActionRefusal,
    "born paid",
  );
  assertEquals(e.action, "add_payment");
  // The same document as an ACCPAY bill takes it: the refusal is the card's, not the balance's.
  cat.assertBillingAction("payable", accpay, { action: "add_payment", amount_cents: 1 });
  const ctx = { settlements: [], credits: [], initiators: [], xero_sync_status: "in_sync" as const };
  const offered = (doc: typeof accpay | typeof card) => cat.billingActionsFor("payable", doc, ctx).some((o) => o.action === "add_payment");
  assertEquals([offered(accpay), offered(card)], [true, false]);
});

// ── void: the pointer arm (the live payable defect found at F15 conformance) ──

const PU = "testpurch10000000000";
const FIXED_PRICE = payablePrice(0, { formula: priceFormulaRefOf(FIXED) });
const TIME_PRICE = {
  ...payablePrice(0, { formula: priceFormulaRefOf(VISION) }),
  rates: [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 4500 }],
};
const billRow = (rel: string[], quantity: number, o: Record<string, unknown> = {}) =>
  withPayableMoney({ type: "sale", uid: rel.at(-1), path: [PU, ...rel], quantity, amount_cents: 100 * quantity, price: FIXED_PRICE, ledger_account: 1400, ...o });
const bill = (uid: string, items: unknown[], status: "issued" | "void" = "issued") =>
  ({
    uid, number: 7, status, origin: "pushed", xero_document: "invoice", xero_id: "x", destinations: [],
    items: [{ uid: PU, type: "purchase", name: "PO-1", description: "", path: [PU] }, ...items],
    totals: { total_cents: 1000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 1000 },
  }) as unknown as PurchaseBill & { xero_id: string };
/** A supplier credit raised from bill `uidBill`'s line (pointed, F14): whole units, counts `[]` (ruling 106). */
const pointedCredit = (uidBill: string, rel: string[], quantity: number, status: PurchaseCredit["status"] = "issued") =>
  ({
    uid: "pc", status, destinations: [],
    items: asCreditRows([billRow(rel, quantity, { uid_billing: uidBill, path_billing_item: [PU, ...rel], price: { ...FIXED_PRICE, counts: [] } })]),
  }) as unknown as PurchaseCredit;
const purchase = { uid: PU, items: [{ uid: "x", type: "sale", path: ["x"], quantity: 5, price: FIXED_PRICE, ledger_account: 1400 }] };

Deno.test("void (payable): refused while a live supplier credit raised from the bill names it — the stranded-credit defect (F15 item 4)", () => {
  const a = bill("A", [billRow(["x"], 5)]);
  const credit = pointedCredit("A", ["x"], 2);
  const initiators = [{ initiator: purchase as never, billing: [a], credits: [credit] }];
  // The old fold arm alone could not see it: `placeCredits` skips a credit line
  // naming a billing document the fold is not reading. Red against the old rule:
  // `tests/f15-parity.test.ts` (deleted with it) asserted `purchaseBillVoidRefusal` returned null here.
  assert(cat.voidRefusal("payable", a, [credit], initiators)?.includes("raised from it"));
  assertEquals(cat.billingActionsFor("payable", a, { settlements: [], credits: [credit], initiators, xero_sync_status: "in_sync" }).some((o) => o.action === "void"), false);
  // A void credit strands nothing; nor does one naming another bill.
  assertEquals(cat.voidRefusal("payable", a, [pointedCredit("A", ["x"], 2, "void")], initiators), null);
  assertEquals(cat.voidRefusal("payable", a, [pointedCredit("B", ["x"], 2)], initiators), null);
});

Deno.test("void (receivable): the twin — refused while a live credit note raised from the invoice names it (F15 item 4)", () => {
  const invoice = {
    uid: "inv", number: 2001, status: "issued" as const, xero_id: "x", items: [] as InvoiceDocItemType[],
    totals: { total_cents: 1000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 1000 },
  };
  const note = (status: "issued" | "void") =>
    ({ uid: "cn", status, items: [{ quantity: 1, uid_billing: "inv", path_billing_item: ["ord", "cam"], price: { counts: [] } }] }) as unknown as AccountedCreditNote;
  // An unallocated note leaves the invoice's totals untouched, so ruling 117 alone does not see it.
  assert(cat.voidRefusal("receivable", invoice, [note("issued")], [])?.includes("credit note raised from it"));
  assertEquals(cat.voidRefusal("receivable", invoice, [note("void")], []), null);
});

// ── credits: one offer, both sides (F15 item 5) ──────────────────────

Deno.test("creditableLines (payable): a TIME credit takes time and never advances c (R3; F15 item 5)", () => {
  const counts = [{ rate_key: "week", num: 2, den: 1 }];
  const a = bill("A", [billRow(["t"], 3, { price: { ...TIME_PRICE, counts } })]);
  const timeCredit = {
    uid: "pc", status: "issued", destinations: [],
    items: asCreditRows([billRow(["t"], 3, {
      uid_billing: "A", path_billing_item: [PU, "t"], price: { ...TIME_PRICE, counts: [{ rate_key: "week", num: 1, den: 1 }] },
    })]),
  } as unknown as PurchaseCredit;
  const time = { uid: PU, items: [{ uid: "t", type: "service", path: ["t"], quantity: 3, price: TIME_PRICE, ledger_account: 1400 }] };
  const [line] = cat.creditableLines("payable", a, { credits: [timeCredit], initiators: [{ initiator: time as never, billing: [a], credits: [timeCredit] }] });
  // 3 units × 2 weeks = 6 unit-weeks, less 3 × 1 taken back = 3 left: ⌊3 ÷ 2⌋ = 1 whole unit by time.
  assertEquals([line.unit_time, line.units], [{ num: 3, den: 1 }, 1]);
  // The old `billLineCredited` counted the time credit's 3 units as units taken, leaving 0
  // (red against it in `tests/f15-parity.test.ts`); the segment is still whole here.
});

Deno.test("creditableLines (receivable): ONE segment per credit on a substitute row — its stand-ins first (F15 item 5)", () => {
  const sub = {
    uid: "y", type: "rental", name: "y", path: ["ord", "dest", "y"], quantity: 5,
    price: { ...fdwPrice(1000, null) }, substituted_for: [{ path: ["dest", "x"], quantity: 2 }],
  } as unknown as InvoiceDocItemType;
  const invoice = { uid: "inv", status: "issued" as const, items: [sub] };
  const order = { uid: "ord", items: [{ uid: "x", type: "rental", path: ["dest", "x"] }] };
  const lines = cat.creditableLines("receivable", invoice, { credits: [], initiators: [{ initiator: order as never, billing: [], credits: [] }] });
  assertEquals(lines.map((l) => [l.units, l.stands_in_for]), [[2, ["dest", "x"]]]);
  // Without the order its entries are not known live, and the row is all its own.
  assertEquals(cat.creditableLines("receivable", invoice, { credits: [], initiators: [] }).map((l) => [l.units, l.stands_in_for]), [[5, undefined]]);
  // Two lines naming one row are SUMMED against it (the stricter rule, both sides).
  const request = (n: number) => ({ name: "y", quantity: n, uid_billing: "inv", path_billing_item: ["ord", "dest", "y"], price: { counts: [] } });
  const why = cat.creditRefusal("receivable", { ...invoice, number: 2001 }, { credits: [], initiators: [] }, [request(3), request(3)]);
  assert(why?.includes("crediting 6"), why ?? "no refusal");
});

Deno.test("creditParts: an ordinary kit pre-fills as a suggestion, a substitute kit's root binds — on both sides (F15 item 5)", () => {
  const row = (uid: string, path: string[], quantity: number, o: Record<string, unknown> = {}) => ({ uid, type: "sale", path, quantity, ...o });
  // Ordinary kit of 3, 2 stakes a kit: a suggestion.
  const kit = { uid: "inv", items: [row("kit", ["o", "kit"], 3), row("stake", ["o", "kit", "stake"], 6)] };
  assertEquals(cat.creditParts(kit, ["o", "kit"], 1, []).map((p) => [p.uid, p.quantity, p.bound]), [["kit", 1, false], ["stake", 2, false]]);
  // A substitute kit's root binds its component.
  const sub = {
    uid: "A",
    items: [
      row("y", [PU, "y"], 2, { substituted_for: [{ path: ["k"], quantity: 2 }] }),
      row("yc", [PU, "y", "yc"], 4, { substituted_for: [{ path: ["k"], quantity: 4 }] }),
    ],
  };
  assertEquals(cat.creditParts(sub, [PU, "y"], 1, []).map((p) => [p.uid, p.quantity, p.bound]), [["y", 1, false], ["yc", 2, true]]);
});

// ── the remainder (ruling 101) ────────────────────────────────────────

Deno.test("remainingBilling: refused accounts decide nothing; `bills` is the account's own answer", () => {
  const refused = { refused: true, lines: [] } as unknown as Parameters<typeof cat.remainingBilling>[0];
  assertEquals(cat.remainingBilling(refused).refused, true);
  assertEquals(cat.remainingBilling(refused).bills, false);
});
