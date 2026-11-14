/**
 * The purchase action ruleset (`src/utils/purchase-actions.ts`). Most refusals
 * here restate by hand what the API refuses, because the API asserts only
 * `purchaseItemTouched`, `purchaseBillVoidRefusal` and `purchaseBillPushRefusal`;
 * the module docblock says so.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type PurchaseActionItem,
  type PurchaseOfferContext,
  assertPurchaseAction,
  assertPurchaseBillAction,
  assertPurchaseCreditAction,
  creditableBillLines,
  purchaseActionsFor,
  purchaseBillCreditRefusal,
  purchaseBillActionsFor,
  purchaseBillPushRefusal,
  purchaseBillVoidRefusal,
  purchaseBilledPaths,
  purchaseCreditActionsFor,
  purchaseItemClosable,
  purchaseItemTouched,
} from "../src/utils/purchase-actions.ts";
import { deriveInvoiceStatus } from "../src/utils/invoices.ts";
import { billLineCreditMoney, billLineCreditParts, purchaseLineBilledNet } from "../src/utils/purchase-documents.ts";
import { sliceSubstitutedFor } from "../src/utils/substitutions.ts";
import { InvoiceActionRefusal } from "../src/utils/invoice-actions.ts";
import type { PurchaseLineCustody } from "../src/utils/bookings-inbound.ts";
import {
  PURCHASE_ACTION_IDS,
  PURCHASE_ACTIONS,
  type PurchaseBill,
  type PurchaseCredit,
  type PurchaseDestination,
  type PurchaseDocumentItem,
  type PurchaseItem,
} from "../src/schemas/mod.ts";
import { priceFormulaRefOf } from "../src/utils/price-formulas.ts";
import { FIXED, VISION } from "./helpers/formulas.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";
import { asCreditRows, payablePrice, withPayableMoney } from "./helpers/payable.ts";

/** The purchase every fixture bill bills (one-document-model Phase 3). */
const PU = "testpurch10000000000";
const FIXED_PRICE = payablePrice(0, { formula: priceFormulaRefOf(FIXED) });
// A TIME-shaped line: refused by the schemas until one-document-model Phase 3,
// still read by the ruleset's time branches, which these cases keep covered.
const TIME_PRICE = {
  ...payablePrice(0, { formula: priceFormulaRefOf(VISION) }),
  rates: [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 4500 }],
};

const buy = (o: Record<string, unknown> = {}) => ({
  type: "sale", uid: "b", path: ["b"], quantity: 3, price: FIXED_PRICE, quantity_billed: 0, ...o,
}) as PurchaseActionItem;
const subrent = (o: Record<string, unknown> = {}) => ({
  type: "rental", uid: "s", path: ["s"], quantity: 2, price: FIXED_PRICE, quantity_billed: 0, ...o,
}) as PurchaseActionItem;
const charge = (o: Record<string, unknown> = {}) => ({
  type: "service", uid: "c", path: ["c"], quantity: 2, price: FIXED_PRICE, quantity_billed: 0, ...o,
}) as PurchaseActionItem;
const timeCharge = (o: Record<string, unknown> = {}) => charge({ price: TIME_PRICE, quantity_billed: null, ...o });

/** The instant offers are asked at, and a window that ends before and after it. */
const NOW = "2026-11-11T12:00:00.000-06:00";
const BEFORE = "2026-11-01T00:00:00.000-05:00";
const AFTER = "2026-12-01T00:00:00.000-06:00";
/** A pair answering every fixture line's `path[0]` (the fixtures carry no dividers), its window ending at `end`. */
const pairFor = (uid: string, end: string | null = null) =>
  ({ uid, dates: { collection_end: end, charge_windows: end === null ? null : [{ start: BEFORE, end }] } }) as unknown as PurchaseDestination;
/** Row custody (C8): what each fixture line has received and returned, by path. */
type Got = Record<string, { received: number; returned?: number }>;
const custodyOf = (got: Got): Map<string, PurchaseLineCustody> =>
  new Map(Object.entries(got).map(([k, v]) => [k, { received: v.received, returned: v.returned ?? 0 }]));
const ctx = (got: Got = {}, extra: Partial<PurchaseOfferContext> = {}): PurchaseOfferContext =>
  ({ custody: custodyOf(got), now: NOW, ...extra });
const NONE = { received: 0, returned: 0 };

const po = (
  items: PurchaseActionItem[],
  status: "active" | "complete" | "canceled" = "active",
  query_by_bills: string[] = [],
  windowEnd: string | null = null,
) => ({ status, items, query_by_bills, destinations: items.map((i) => pairFor(i.path[0], windowEnd)) });
/** Offers on a purchase with row custody `got`. */
const offersOf = (purchase: ReturnType<typeof po>, got: Got = {}, extra: Partial<PurchaseOfferContext> = {}) =>
  purchaseActionsFor(purchase, ctx(got, extra));
const keys = (offers: { key: string }[]) => offers.map((o) => o.key);
const offer = (offers: ReturnType<typeof purchaseActionsFor>, key: string) => offers.find((o) => o.key === key);

Deno.test("PURCHASE_ACTION_IDS and PURCHASE_ACTIONS name the same actions, both ways", () => {
  assertEquals([...PURCHASE_ACTION_IDS].sort(), Object.keys(PURCHASE_ACTIONS).sort());
  assertEquals(new Set(PURCHASE_ACTION_IDS).size, PURCHASE_ACTION_IDS.length);
});

Deno.test("purchaseItemClosable: units to arrive, an unbilled charge, a time line's open window; never a subrent with units out", () => {
  const closable = (item: PurchaseActionItem, custody = NONE, end: string | null = null) =>
    purchaseItemClosable(item, custody, pairFor(item.path[0], end), NOW);
  assert(closable(buy()));
  assert(!closable(buy(), { received: 3, returned: 0 }));
  assert(closable(subrent()));
  // One of two arrived and is still out: the API refuses this close (the subrent plan, D4).
  assert(!closable(subrent(), { received: 1, returned: 0 }));
  assert(closable(subrent(), { received: 1, returned: 1 }));
  assert(closable(charge()));
  assert(closable(charge({ quantity_billed: 1 })));
  assert(!closable(charge({ quantity_billed: 2 })));
  assert(!closable(charge({ quantity_billed: 3 })), "an over-billed charge has nothing left to cancel");
  // Ruling 63: a time line's close ends its pair's window, so only an open window closes.
  assert(closable(timeCharge()), "a standing hire runs on");
  assert(closable(timeCharge(), NONE, AFTER));
  assert(!closable(timeCharge(), NONE, BEFORE), "a window already ended has nothing to close");
  assert(!purchaseItemClosable(timeCharge(), NONE, undefined, NOW), "no pair, no window to end: fail closed");
});

Deno.test("purchaseItemTouched: custody, a bill, and a time line a bill names", () => {
  assert(!purchaseItemTouched(buy(), new Set(), NONE));
  assert(purchaseItemTouched(buy(), new Set(), { received: 1, returned: 0 }));
  assert(purchaseItemTouched(buy({ quantity_billed: 1 }), new Set(), NONE));
  assert(purchaseItemTouched(subrent(), new Set(), { received: 1, returned: 1 }));
  assert(!purchaseItemTouched(timeCharge(), new Set(), NONE));
  assert(purchaseItemTouched(timeCharge(), new Set(["c"]), NONE), "a time line counts no quantity_billed");
});

Deno.test("purchaseBilledPaths: a voided bill names nothing; another purchase's lines are not this one's", () => {
  // A bill line sits at `[purchase uid, ...its purchase line's path]` (one-document-model Phase 3).
  const line = { type: "service", path: [PU, "c"] } as PurchaseDocumentItem;
  const moved = { type: "service", path: [PU, "x"], path_purchase_item: ["d"] } as PurchaseDocumentItem;
  const elsewhere = { type: "service", path: ["OtherPurchase0000000", "c"] } as PurchaseDocumentItem;
  const divider = { type: "purchase", uid: PU, path: [PU] } as unknown as PurchaseDocumentItem;
  const totals = (amount_void_cents: number) => ({ amount_void_cents }) as PurchaseBill["totals"];
  assertEquals([...purchaseBilledPaths([{ status: "issued", totals: totals(0), items: [divider, line, moved, elsewhere] }], PU)].sort(), ["c", "d"]);
  assertEquals([...purchaseBilledPaths([{ status: "void", totals: totals(500), items: [line] }], PU)], []);
});

Deno.test("purchaseBilledPaths: a substitute names the line it stands in for as well as its own (W5)", () => {
  const substitute = { type: "rental", path: [PU, "y"], substituted_for: [{ path: ["t"], quantity: 2 }] } as PurchaseDocumentItem;
  const totals = { amount_void_cents: 0 } as PurchaseBill["totals"];
  assertEquals([...purchaseBilledPaths([{ status: "issued", totals, items: [substitute] }], PU)].sort(), ["t", "y"]);
});

Deno.test("close: refused whole while a subrent has units out, even with another line open", () => {
  const out = subrent({ quantity: 1 });
  const offers = offersOf(po([buy(), out]), { s: { received: 1 } });
  assertEquals(offer(offers, "close"), undefined);
  assert(offer(offers, "close_item:b"), "the open buy still closes on its own");
  assertEquals(offer(offers, "close_item:s"), undefined);
});

Deno.test("close: only an active purchase, and only with something to close", () => {
  assertEquals(offer(offersOf(po([buy()], "complete")), "close"), undefined);
  assertEquals(offer(offersOf(po([buy()]), { b: { received: 3 } }), "close"), undefined);
});

Deno.test("close outcome: cancel only when nothing was received or billed", () => {
  const outcome = (items: PurchaseActionItem[], got: Got = {}, extra: Partial<PurchaseOfferContext> = {}) =>
    offer(offersOf(po(items), got, extra), "close")?.outcome;
  assertEquals(outcome([buy()]), "cancel");
  assertEquals(outcome([buy()], { b: { received: 1 } }), "close");
  // A part-billed flat charge keeps its billed unit, so the purchase ends complete.
  assertEquals(outcome([charge({ quantity_billed: 1 })]), "close");
  // An unbilled time charge cancels; a billed one stays, its window ended (ruling 63).
  assertEquals(outcome([timeCharge()]), "cancel");
  assertEquals(outcome([timeCharge()], {}, { billed_paths: new Set(["c"]) }), "close");
  // A billed, unreceived buy cancels too: the excess is a diff entry to credit by hand.
  assertEquals(outcome([buy({ quantity_billed: 1 })]), "cancel");
});

Deno.test("add_bill: any purchase that is not canceled, fully billed included (owner, 2026-11-05)", () => {
  assert(offer(offersOf(po([buy({ quantity_billed: 3 })], "complete"), { b: { received: 3 } }), "add_bill"));
  assertEquals(offer(offersOf(po([buy()], "canceled")), "add_bill"), undefined);
});

Deno.test("add_credit: a billed line, or any bill, which reaches a time-only purchase", () => {
  assertEquals(offer(offersOf(po([timeCharge()])), "add_credit"), undefined);
  assert(offer(offersOf(po([buy({ quantity_billed: 1 })])), "add_credit"));
  assert(offer(offersOf(po([timeCharge()], "active", ["bill1"])), "add_credit"));
});

Deno.test("bill_item: a flat line's remaining units; an over-billed line offers none", () => {
  assertEquals(offer(offersOf(po([buy({ quantity_billed: 1 })])), "bill_item:b")?.max_quantity, 2);
  assertEquals(offer(offersOf(po([buy({ quantity_billed: 4 })])), "bill_item:b"), undefined);
  assertEquals(offer(offersOf(po([buy()], "canceled")), "bill_item:b"), undefined);
});

Deno.test("bill_item: a time line offers its open units — nothing is metered until Phase 3", () => {
  const line = subrent({ uid: "t", path: ["t"], price: TIME_PRICE, quantity_billed: null, quantity: 1 }) as unknown as PurchaseActionItem;
  assertEquals(offer(offersOf(po([line]), { t: { received: 1, returned: 1 } }), "bill_item:t")?.max_quantity, 1);
});

Deno.test("remove_item and change_basis: only an untouched line, a billed time line included", () => {
  assertEquals(keys(offersOf(po([timeCharge()]))).filter((k) => /remove|basis/.test(k)), ["remove_item:c", "change_basis:c"]);
  const billed = offersOf(po([timeCharge()]), {}, { billed_paths: new Set(["c"]) });
  assertEquals(keys(billed).filter((k) => /remove|basis/.test(k)), []);
  assert(offer(billed, "close_item:c"), "a billed time line offers Close instead");
});

/** A bill for the void rules: pushed, live and unsettled unless told otherwise. Its lines are `[path, quantity]`. */
const voidBill = (
  uid: string,
  lines: [string, number][],
  o: Partial<PurchaseBill> & { totals_over?: Partial<PurchaseBill["totals"]> } = {},
) => {
  const { totals_over, ...rest } = o;
  return {
    uid,
    number: 7,
    status: o.voided_at !== undefined || (totals_over?.amount_void_cents ?? 0) !== 0 ? "void" : "issued",
    origin: "pushed",
    xero_document: "invoice",
    items: lines.map(([path, quantity]) => ({ type: "sale", path: [PU, path], quantity, amount_cents: 100 * quantity, price: FIXED_PRICE })),
    totals: { total_cents: 1000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: 1000, ...totals_over },
    ...rest,
  } as PurchaseBill;
};
const voidCredit = (lines: [string, number][], status: PurchaseCredit["status"] = "issued") =>
  ({ status, items: asCreditRows(lines.map(([path, quantity]) => ({ type: "sale", path: [PU, path], quantity, amount_cents: 100 * quantity, price: FIXED_PRICE }))) }) as unknown as PurchaseCredit;
const noDocuments = { per_purchase: [{ uid_purchase: PU, purchase: { items: [] }, bills: [], credits: [] }] };
const asLines = (...items: PurchaseActionItem[]) => items as PurchaseItem[];

Deno.test("purchaseBillActionsFor: a live ACCPAY with money due, capped at what is due", () => {
  const bill = (due: number, o: Partial<PurchaseBill["totals"]> = {}, xero_document: PurchaseBill["xero_document"] = "invoice") =>
    voidBill("b", [], { xero_document, totals_over: { amount_due_cents: due, ...o } });
  const allocations = (b: PurchaseBill) => purchaseBillActionsFor(b, noDocuments).filter((a) => a.action === "allocate_credit");
  assertEquals(allocations(bill(400)), [{ key: "allocate_credit", action: "allocate_credit", max_cents: 400 }]);
  assertEquals(allocations(bill(0)), []);
  assertEquals(allocations(bill(1000, { amount_void_cents: 1000 })), [], "voided, though a stale due reads money owed");
  assertEquals(allocations(bill(400, {}, "bank_transaction")), [], "a card payment is born paid");
});

Deno.test("purchaseBillVoidRefusal: one row per reason, and the offer follows it", () => {
  const items = asLines(buy());
  const ctx = (bills: PurchaseBill[], credits: PurchaseCredit[] = []) => ({ per_purchase: [{ uid_purchase: PU, purchase: { items }, bills, credits }] });
  const refuse = (b: PurchaseBill, c: ReturnType<typeof ctx>, reason: string) => {
    assertEquals(purchaseBillVoidRefusal(b, c)?.includes(reason), true, purchaseBillVoidRefusal(b, c) ?? "no refusal");
    assertEquals(purchaseBillActionsFor(b, c).some((a) => a.action === "void_bill"), false);
  };
  const allow = (b: PurchaseBill, c: ReturnType<typeof ctx>) => {
    assertEquals(purchaseBillVoidRefusal(b, c), null);
    assertEquals(purchaseBillActionsFor(b, c).filter((a) => a.action === "void_bill"), [{ key: "void_bill", action: "void_bill" }]);
  };

  const live = voidBill("a", [["b", 5]]);
  allow(live, ctx([live]));
  const free = voidBill("a", [["b", 5]], { totals_over: { total_cents: 0, amount_due_cents: 0 } });
  allow(free, ctx([free]));

  const stamped = voidBill("a", [["b", 5]], { voided_at: mockTimestamp });
  refuse(stamped, ctx([stamped]), "already void");
  const annulled = voidBill("a", [["b", 5]], { totals_over: { amount_void_cents: 1000, amount_due_cents: 0 } });
  refuse(annulled, ctx([annulled]), "already void");

  const linked = voidBill("a", [["b", 5]], { origin: "linked", xero_id: "x" });
  refuse(linked, ctx([linked]), "linked");
  const paid = voidBill("a", [["b", 5]], { totals_over: { amount_paid_cents: 1, amount_due_cents: 999 } });
  refuse(paid, ctx([paid]), "payments or supplier credits");
  const credited = voidBill("a", [["b", 5]], { totals_over: { amount_credited_cents: 1, amount_due_cents: 999 } });
  refuse(credited, ctx([credited]), "payments or supplier credits");
});

Deno.test("purchaseBillVoidRefusal: refused only when the void leaves a credit with no bill under it", () => {
  const items = asLines(buy(), buy({ uid: "other", path: ["other"] }));
  const a = voidBill("a", [["b", 5]]);
  const b = voidBill("b", [["b", 5]]);
  const refused = (bills: PurchaseBill[], credits: PurchaseCredit[]) =>
    purchaseBillVoidRefusal(a, { per_purchase: [{ uid_purchase: PU, purchase: { items }, bills, credits }] })?.includes("Void the credit first") === true;

  assertEquals(refused([a], [voidCredit([["b", 2]])]), true, "bill 5, credit 2, nothing else billed: net −2");
  assertEquals(refused([a, b], [voidCredit([["b", 2]])]), false, "the other bill still covers it: net 3");
  assertEquals(refused([a, b], [voidCredit([["b", 5]])]), false, "exactly covered: net 0 is not negative");
  assertEquals(refused([a, b], [voidCredit([["b", 6]])]), true, "the other bill covers only 5 of 6");
  assertEquals(refused([a], [voidCredit([["b", 2]], "void")]), false, "a void credit is not subtracted");
  assertEquals(refused([a, { ...b, status: "void" as const, voided_at: mockTimestamp }], [voidCredit([["b", 2]])]), true, "a void bill covers nothing");
  assertEquals(refused([a], [voidCredit([["other", 2]])]), false, "a line stranded already, which this bill does not name, is not its problem");
  assertEquals(
    purchaseBillVoidRefusal(a, { per_purchase: [{ uid_purchase: PU, purchase: { items }, bills: [], credits: [voidCredit([["b", 2]])] }] })?.includes("Void the credit first"),
    true,
    "the bill itself need not be in the list",
  );
});

Deno.test("purchaseBillVoidRefusal: a time line counts nothing, so its credit refuses nothing", () => {
  const bill = voidBill("a", [["c", 5]]);
  assertEquals(
    purchaseBillVoidRefusal(bill, { per_purchase: [{ uid_purchase: PU, purchase: { items: asLines(timeCharge()) }, bills: [bill], credits: [voidCredit([["c", 2]])] }] }),
    null,
  );
});

Deno.test("purchaseCreditActionsFor: void only while nothing has drawn on it", () => {
  const credit = (status: "issued" | "applied" | "void", remaining: number) => ({ status, total_cents: 1000, remaining_credit_cents: remaining });
  assertEquals(purchaseCreditActionsFor(credit("issued", 1000)), [{ key: "void_credit", action: "void_credit" }]);
  assertEquals(purchaseCreditActionsFor(credit("issued", 999)), []);
  assertEquals(purchaseCreditActionsFor(credit("void", 1000)), []);
});

Deno.test("deriveInvoiceStatus reads a bill as it reads an invoice: every member, off the totals", () => {
  const status = (total_cents: number, paid: number, credited: number, closure_count = 0, stored: "issued" | "void" = "issued") =>
    deriveInvoiceStatus({
      status: stored,
      totals: { total_cents, amount_paid_cents: paid, amount_credited_cents: credited, amount_void_cents: 0, closure_count },
    });
  assertEquals(status(1000, 0, 0), "issued");
  assertEquals(status(0, 0, 0), "issued", "an unclosed $0 bill, whatever Xero says");
  assertEquals(status(0, 0, 0, 1), "paid", "closed by an operator");
  assertEquals(status(1000, 400, 0), "part_paid");
  assertEquals(status(1000, 0, 400), "part_paid");
  assertEquals(status(1000, 1000, 0), "paid");
  assertEquals(status(1000, 600, 400), "paid", "money was paid, so credit does not name it");
  assertEquals(status(1000, 1200, 0), "paid", "an overpayment from Xero is a fact");
  assertEquals(status(1000, 0, 1000), "credited");
  assertEquals(status(1000, 600, 0, 0, "void"), "void", "void is an explicit move");
  assertEquals(status(1000, -100, 0), "issued", "a net-negative bucket is not part paid");
});

Deno.test("purchaseBillPushRefusal: one row per reason, and the offer follows it", () => {
  const pushes = (b: PurchaseBill, status?: "in_sync" | "out_of_sync" | "unknown" | "not_applicable") =>
    purchaseBillActionsFor(b, { ...noDocuments, xero_sync_status: status }).filter((a) => a.action === "push_to_xero");
  const refuse = (b: PurchaseBill, reason: string) => {
    assertEquals(purchaseBillPushRefusal(b, "out_of_sync")?.includes(reason), true, purchaseBillPushRefusal(b, "out_of_sync") ?? "no refusal");
    assertEquals(pushes(b, "out_of_sync"), []);
  };

  const live = voidBill("a", []);
  for (const status of ["out_of_sync", "unknown"] as const) {
    assertEquals(purchaseBillPushRefusal(live, status), null);
    assertEquals(pushes(live, status), [{ key: "push_to_xero", action: "push_to_xero" }]);
  }
  assertEquals(purchaseBillPushRefusal(live, "in_sync")?.includes("already has"), true);
  assertEquals(pushes(live, "in_sync"), []);
  assertEquals(pushes(live), [], "no status given, no offer");

  refuse(voidBill("a", [], { totals_over: { amount_void_cents: 1000, amount_due_cents: 0 } }), "is void");
  // A linked bill may be pushed while unpaid, as a pushed one; a settled one may not.
  assertEquals(purchaseBillPushRefusal(voidBill("a", [], { origin: "linked" }), "out_of_sync"), null);
  refuse(voidBill("a", [], { origin: "linked", totals_over: { amount_paid_cents: 1000, amount_due_cents: 0 } }), "linked");

  // A settled bill may ask: Xero takes its tracking, and the task answers the rest.
  for (const settled of [{ amount_paid_cents: 1, amount_due_cents: 999 }, { amount_credited_cents: 1, amount_due_cents: 999 }]) {
    const bill = voidBill("a", [], { totals_over: settled });
    assertEquals(purchaseBillPushRefusal(bill, "out_of_sync"), null);
    assertEquals(pushes(bill, "out_of_sync"), [{ key: "push_to_xero", action: "push_to_xero" }]);
  }
});

Deno.test("purchaseActionsFor: a divider row is no line — it offers nothing and changes no offer (one-document-model Phase 3)", () => {
  const divider = { type: "destination" as const };
  const lines = [buy({ quantity_billed: 1 }), timeCharge()];
  const withDivider = { ...po(lines), items: [divider, ...lines] };
  assertEquals(purchaseActionsFor(withDivider, ctx()), offersOf(po(lines)));
});

Deno.test("a $0 bill offers Mark Paid until it is closed, then Reopen; the assert follows the offer", () => {
  const zero = (closure_count = 0) =>
    voidBill("a", [], { totals_over: { total_cents: 0, amount_due_cents: 0, closure_count } });
  const has = (b: PurchaseBill, action: string) => purchaseBillActionsFor(b, noDocuments).some((o) => o.action === action);
  assert(has(zero(), "close_bill"));
  assert(!has(zero(), "reopen_bill"));
  assert(!has(zero(1), "close_bill"), "already closed");
  assert(has(zero(1), "reopen_bill"));
  assert(!has(voidBill("a", []), "close_bill"), "only a bill totalling $0 closes");
  assertPurchaseBillAction(zero(), { action: "close_bill" });
  assertThrows(() => assertPurchaseBillAction(voidBill("a", []), { action: "close_bill" }), InvoiceActionRefusal, "totalling $0");
  assertThrows(() => assertPurchaseBillAction(zero(), { action: "reopen_bill" }), InvoiceActionRefusal, "not marked paid");
});

Deno.test("assertPurchaseBillAction: allocate caps at what is due; void reads the shared refusal", () => {
  const bill = voidBill("a", [], { totals_over: { amount_due_cents: 400 } });
  assertPurchaseBillAction(bill, { action: "allocate_credit", amount_cents: 400 });
  assertThrows(() => assertPurchaseBillAction(bill, { action: "allocate_credit", amount_cents: 401 }), InvoiceActionRefusal, "exceeds");
  assertThrows(() => assertPurchaseBillAction(bill, { action: "allocate_credit", amount_cents: 0 }), InvoiceActionRefusal);
  const linked = voidBill("a", [], { origin: "linked", xero_id: "x" });
  assertThrows(() => assertPurchaseBillAction(linked, { action: "void_bill", context: noDocuments }), InvoiceActionRefusal, "linked");
});

Deno.test("assertPurchaseCreditAction and assertPurchaseAction refuse what is not offered, and allow what is", () => {
  const credit = { status: "issued", total_cents: 10, remaining_credit_cents: 10 } as const;
  assertPurchaseCreditAction(credit, { action: "void_credit" });
  assertThrows(() => assertPurchaseCreditAction({ ...credit, remaining_credit_cents: 4 }, { action: "void_credit" }), InvoiceActionRefusal, "allocated");
  assertThrows(() => assertPurchaseCreditAction({ ...credit, status: "void" }, { action: "void_credit" }), InvoiceActionRefusal, "void");
  assertPurchaseAction(po([timeCharge()]), ctx(), { action: "remove_item", path_purchase_item: ["c"] });
  assertThrows(
    () => assertPurchaseAction(po([timeCharge()]), ctx({}, { billed_paths: new Set(["c"]) }), { action: "remove_item", path_purchase_item: ["c"] }),
    InvoiceActionRefusal,
    "remove_item",
  );
});

// ── add_credit from a bill's lines (one-document-model 6d, rulings 21–23) ──

/** A bill line or a credit line at `[PU, ...rel]`, $1.00 a unit unless told otherwise. */
const row = (rel: string[], quantity: number, o: Record<string, unknown> = {}) =>
  withPayableMoney({ type: "sale", uid: rel.at(-1), path: [PU, ...rel], quantity, amount_cents: 100 * quantity, price: FIXED_PRICE, ledger_account: 1400, ...o }) as unknown as PurchaseDocumentItem;
const bill6d = (uid: string, items: PurchaseDocumentItem[], o: Partial<PurchaseBill> = {}) =>
  ({ ...voidBill(uid, []), items, ...o }) as PurchaseBill;
const credit6d = (items: PurchaseDocumentItem[], status: PurchaseCredit["status"] = "issued") =>
  ({ status, items: asCreditRows(items) }) as unknown as PurchaseCredit;
/** A credit line naming bill `uidBill`'s line at `[PU, ...rel]`, copying its path. */
const named = (uidBill: string, rel: string[], quantity: number, o: Record<string, unknown> = {}) =>
  row(rel, quantity, { uid_purchase_bill: uidBill, path_bill_item: [PU, ...rel], ...o });
const ctx6d = (bills: PurchaseBill[], credits: PurchaseCredit[] = [], items = asLines(buy({ uid: "x", path: ["x"], quantity: 5 }))) =>
  ({ per_purchase: [{ uid_purchase: PU, purchase: { items }, bills, credits }] });
const unitsAt = (b: PurchaseBill, c: ReturnType<typeof ctx6d>) =>
  Object.fromEntries(creditableBillLines(b, c).map((l) => [l.path.slice(1).join("/"), l.units]));

Deno.test("creditableBillLines: units left per bill line, net of credits naming it (6d)", () => {
  const a = bill6d("A", [row(["x"], 5)]);
  assertEquals(creditableBillLines(a, ctx6d([a])), [{ path: [PU, "x"], uid: "x", billed: 5, units: 5 }], "uncredited");
  assertEquals(unitsAt(a, ctx6d([a], [credit6d([named("A", ["x"], 2)])])), { x: 3 }, "part-credited");
  assertEquals(unitsAt(a, ctx6d([a], [credit6d([named("A", ["x"], 2)], "void")])), { x: 5 }, "a void credit takes nothing");
  assertEquals(unitsAt(a, ctx6d([a], [credit6d([named("A", ["x"], 5)])])), { x: 0 }, "fully credited");
  assertEquals(purchaseBillActionsFor(a, ctx6d([a], [credit6d([named("A", ["x"], 5)])])).some((o) => o.action === "add_credit"), false, "0 left is absent");
  const offered = purchaseBillActionsFor(a, ctx6d([a])).find((o) => o.action === "add_credit");
  assertEquals(offered, { key: "add_credit", action: "add_credit", lines: [{ path: [PU, "x"], uid: "x", billed: 5, units: 5 }] });
});

Deno.test("creditableBillLines: the per-line cap binds while the pool still has room from another bill (6d item 2)", () => {
  const a = bill6d("A", [row(["x"], 5)]);
  const b = bill6d("B", [row(["x"], 5)]);
  const c = ctx6d([a, b], [credit6d([named("A", ["x"], 5)])]);
  // The pool is 10 − 5 = 5, yet bill A's line has nothing left.
  assertEquals(unitsAt(a, c), { x: 0 });
  assertEquals(unitsAt(b, c), { x: 5 });
  assertEquals(purchaseBillCreditRefusal(a, c, [{ path_bill_item: [PU, "x"], quantity: 1 }])?.includes("(0 of 5)"), true);
  assertThrows(
    () => assertPurchaseBillAction(a, { action: "add_credit", context: c, lines: [{ path_bill_item: [PU, "x"], quantity: 1 }] }),
    InvoiceActionRefusal,
    "left to credit",
  );
  assertPurchaseBillAction(b, { action: "add_credit", context: c, lines: [{ path_bill_item: [PU, "x"], quantity: 5 }] });
});

Deno.test("creditableBillLines: the pool caps a line too, when a purchase-form credit drew on it (6d)", () => {
  const a = bill6d("A", [row(["x"], 5)]);
  const b = bill6d("B", [row(["x"], 5)]);
  // A credit naming no bill line takes 8 of the pool of 10: 2 left, for either bill.
  const c = ctx6d([a, b], [credit6d([row(["x"], 8)])]);
  assertEquals(unitsAt(a, c), { x: 2 });
  assertEquals(purchaseBillCreditRefusal(a, c, [{ path_bill_item: [PU, "x"], quantity: 2 }]), null);
  assertEquals(purchaseBillCreditRefusal(a, c, [{ path_bill_item: [PU, "x"], quantity: 3 }])?.includes("(2 of 5)"), true);
});

Deno.test("creditableBillLines: absent — a time line, a kit header, a $0 line, another purchase's line, a bill not live (6d)", () => {
  const time = row(["t"], 2, { price: { ...TIME_PRICE, counts: [{ rate_key: "week", num: 1, den: 1 }] } });
  const header = row(["k"], 1, { ledger_account: null, amount_cents: 0 });
  const free = row(["z"], 1, { amount_cents: 0 });
  const elsewhere = { ...row(["x"], 1), path: ["otherpurch0000000000", "x"] } as PurchaseDocumentItem;
  const a = bill6d("A", [time, header, free, elsewhere, row(["x"], 1)]);
  assertEquals(Object.keys(unitsAt(a, ctx6d([a]))), ["x"]);
  const voided = bill6d("A", [row(["x"], 1)], { status: "void" });
  assertEquals(creditableBillLines(voided, ctx6d([voided])), []);
  assertEquals(purchaseBillCreditRefusal(a, ctx6d([a]), [{ path_bill_item: [PU, "t"], quantity: 1 }])?.includes("no line at"), true, "a time line is refused by name");
});

Deno.test("creditableBillLines: a bill-authored line is creditable, capped by its own join (6d, ruling 23)", () => {
  // `extra` is on no purchase line: its pool is what bills hold at its own path.
  const a = bill6d("A", [row(["x"], 5), row(["extra"], 2, { type: "service", amount_cents: 300 })]);
  assertEquals(unitsAt(a, ctx6d([a])), { x: 5, extra: 2 });
  assertEquals(unitsAt(a, ctx6d([a], [credit6d([named("A", ["extra"], 1, { type: "service" })])])), { x: 5, extra: 1 });
});

Deno.test("creditableBillLines: a substituted kit's component is never offered alone; its root is, a $0 header included (api-cloudrun#1475)", () => {
  // X is a kit: a header over 2 components a unit. Y, its alternate kit, stands in for all 2;
  // the server stamps Y's component with its share of the root's entry.
  const items = asLines(buy({ uid: "k", path: ["k"], quantity: 2 }), buy({ uid: "c", path: ["k", "c"], quantity: 4 }));
  const component = row(["y", "yc"], 4, { quantity_per_parent: 2, substituted_for: [{ path: ["k"], quantity: 4 }] });
  const headerRoot = row(["y"], 2, { ledger_account: null, amount_cents: 0, substituted_for: [{ path: ["k"], quantity: 2 }] });
  const a = bill6d("A", [headerRoot, component]);
  // The $0 header root is offered for its whole subtree; the component is bound to it.
  assertEquals(creditableBillLines(a, ctx6d([a], [], items)), [{ path: [PU, "y"], uid: "y", billed: 2, units: 2, stands_in_for: ["k"] }]);
  assertEquals(
    purchaseBillCreditRefusal(a, ctx6d([a], [], items), [{ path_bill_item: [PU, "y", "yc"], quantity: 1 }])?.includes("no line at"),
    true,
    "a component alone would un-bill X itself by its units",
  );
  // A priced root is offered the same way; its component still is not.
  const pricedRoot = row(["y"], 2, { substituted_for: [{ path: ["k"], quantity: 2 }] });
  const b = bill6d("A", [pricedRoot, component]);
  assertEquals(Object.keys(unitsAt(b, ctx6d([b], [], items))), ["y"]);
  // A substitute kit whose rows carry no money at all is not offered.
  const free = bill6d("A", [headerRoot, { ...component, amount_cents: 0 } as PurchaseDocumentItem]);
  assertEquals(creditableBillLines(free, ctx6d([free], [], items)), []);
});

Deno.test("billLineCreditParts: a substitute kit's root credit copies its subtree by the bill's ratio, and nets X and its components to 0 (api-cloudrun#1475)", () => {
  // X: a header k (3) over c, 7 a kit (21). Y: a $0 header y (3) over yc, 7 a kit (21), for $1.00,
  // standing in for all of X. A kit's ratio is its quantity_per_parent, so it is whole.
  const items = asLines(buy({ uid: "k", path: ["k"], quantity: 3 }), buy({ uid: "c", path: ["k", "c"], quantity: 21 }));
  const purchaseKeys = new Set(items.map((i) => i.path.join("/")));
  const y = row(["y"], 3, { ledger_account: null, amount_cents: 0, substituted_for: [{ path: ["k"], quantity: 3 }] });
  const yc = row(["y", "yc"], 21, { amount_cents: 100, quantity_per_parent: 7, substituted_for: [{ path: ["k"], quantity: 21 }] });
  const bill = bill6d("A", [y, yc]);
  const credits: PurchaseCredit[] = [];
  const net = (path: string[]) => purchaseLineBilledNet(path, { uid_purchase: PU, purchase_items: items, bills: [bill], credits });
  // The fold: Y's component money lands on X, its units on X's component.
  assertEquals([net(["k"]), net(["k", "c"]), net(["y", "yc"])], [
    { quantity: 3, amount_cents: 100 },
    { quantity: 21, amount_cents: 0 },
    { quantity: 0, amount_cents: 0 },
  ]);
  // Three credits of one root unit each: yc takes 7 units each, priced first-come over
  // $1.00: 33¢ (7/21 of 100 = 33.33), 34¢ (14/21 → 67, less 33¢), 33¢ (100 − 67).
  const expected = [[7, 33], [7, 34], [7, 33]];
  for (const [i, [units, cents]] of expected.entries()) {
    const parts = billLineCreditParts({ bill, path: [PU, "y"], n: 1, credits, purchaseKeys });
    assertEquals(
      parts.map((p) => [p.line.path.slice(1).join("/"), p.n, p.amount_cents, p.substituted_for]),
      [["y", 1, 0, [{ path: ["k"], quantity: 1 }]], ["y/yc", units, cents, [{ path: ["k"], quantity: units }]]],
      `credit ${i + 1}`,
    );
    credits.push(credit6d(parts.map((p) =>
      named("A", p.line.path.slice(1), p.n, {
        ledger_account: p.line.ledger_account,
        amount_cents: p.amount_cents,
        substituted_for: p.substituted_for,
      })
    )));
  }
  assertEquals([net(["k"]), net(["k", "c"]), net(["y", "yc"])], [
    { quantity: 0, amount_cents: 0 },
    { quantity: 0, amount_cents: 0 },
    { quantity: 0, amount_cents: 0 },
  ]);
  assertEquals(creditableBillLines(bill, { per_purchase: [{ uid_purchase: PU, purchase: { items }, bills: [bill], credits }] })[0].units, 0);
  // A kit is priced from its rows: a stated amount is refused.
  assertThrows(
    () => billLineCreditParts({ bill, path: [PU, "y"], n: 1, credits: [], purchaseKeys, memo_cents: 10 }),
    RangeError,
    "states no amount",
  );
  // An ordinary row is one part, as before.
  const plain = bill6d("B", [row(["x"], 5)]);
  assertEquals(
    billLineCreditParts({ bill: plain, path: [PU, "x"], n: 2, credits: [], purchaseKeys }).map((p) => [p.n, p.amount_cents]),
    [[2, 200]],
  );
});

Deno.test("creditableBillLines: one segment per credit — a substitute's stand-ins for each X, then its own units (6d, owner 2026-11-11)", () => {
  const items = asLines(buy({ uid: "x", path: ["x"], quantity: 5 }));
  // Whole: Y stands in for all 5 of X — one segment, capped by X's pool (5).
  const whole = bill6d("A", [row(["y"], 5, { substituted_for: [{ path: ["x"], quantity: 5 }] })]);
  assertEquals(creditableBillLines(whole, ctx6d([whole])), [{ path: [PU, "y"], uid: "y", billed: 5, units: 5, stands_in_for: ["x"] }]);
  // A credit of 2 copies the row and slices the entries: X's pool falls to 3, and 3 are left.
  const back = credit6d([named("A", ["y"], 2, { substituted_for: [{ path: ["x"], quantity: 2 }] })]);
  assertEquals(unitsAt(whole, ctx6d([whole], [back])), { y: 3 });
  // …and the credit un-bills X itself, by its stand-in units: X's net falls 5 → 3.
  const docs = (credits: PurchaseCredit[]) => ({ uid_purchase: PU, purchase_items: items, bills: [whole], credits });
  assertEquals(purchaseLineBilledNet(["x"], docs([])).quantity, 5);
  assertEquals(purchaseLineBilledNet(["x"], docs([back])).quantity, 3);
  // Partial: Y is 5, of which 2 stand in for X. The first credit may take only those 2…
  const partial = bill6d("A", [row(["y"], 5, { substituted_for: [{ path: ["x"], quantity: 2 }] })]);
  assertEquals(creditableBillLines(partial, ctx6d([partial])), [{ path: [PU, "y"], uid: "y", billed: 5, units: 2, stands_in_for: ["x"] }]);
  assertEquals(
    purchaseBillCreditRefusal(partial, ctx6d([partial]), [{ path_bill_item: [PU, "y"], quantity: 3 }])?.includes("stand in for x; credit those first"),
    true,
  );
  // …then, once they are credited, Y's own 3.
  const stands = credit6d([named("A", ["y"], 2, { substituted_for: [{ path: ["x"], quantity: 2 }] })]);
  assertEquals(creditableBillLines(partial, ctx6d([partial], [stands])), [{ path: [PU, "y"], uid: "y", billed: 5, units: 3 }]);
  // A purchase-form credit took 1 of X's pool: the stand-in segment is capped at 1.
  assertEquals(unitsAt(partial, ctx6d([partial], [credit6d([row(["x"], 1)])])), { y: 1 });
  // A spent entry (the purchase no longer carries X) stands in for nothing: the fold counts all 5 at Y's own join.
  assertEquals(unitsAt(partial, ctx6d([partial], [], asLines(buy({ uid: "w", path: ["w"] })))), { y: 5 });
});

Deno.test("creditableBillLines: crediting a substitute segment by segment nets every line's billed money to exactly 0 (6d)", () => {
  // Y: 7 units for $1.01, its first 2 standing in for x1, the next 2 for x2, 3 its own.
  // Odd cents on purpose, so a re-split of a straddling credit would move one.
  const items = asLines(buy({ uid: "x1", path: ["x1"], quantity: 2 }), buy({ uid: "x2", path: ["x2"], quantity: 2 }));
  const entries = [{ path: ["x1"], quantity: 2 }, { path: ["x2"], quantity: 2 }];
  const y = row(["y"], 7, { amount_cents: 101, substituted_for: entries });
  const bill = bill6d("A", [y]);
  const credits: PurchaseCredit[] = [];
  const net = (path: string) => purchaseLineBilledNet([path], { uid_purchase: PU, purchase_items: items, bills: [bill], credits });
  const billed = { x1: net("x1").amount_cents, x2: net("x2").amount_cents, y: net("y").amount_cents };
  assertEquals(billed.x1 + billed.x2 + billed.y, 101);
  // Each credit takes ALL it is offered — the form's default — priced and sliced as the API will.
  let taken = 0;
  let taken_cents = 0;
  const runs: number[] = [];
  while (taken < 7) {
    const [line] = creditableBillLines(bill, { per_purchase: [{ uid_purchase: PU, purchase: { items }, bills: [bill], credits }] });
    assert(line.units >= 1, `units ${taken + 1}.. are offered`);
    const n = line.units;
    const cents = billLineCreditMoney({ line: { quantity: 7, amount_cents: 101, price: { discount: null, stated_cents: 101 } }, credited: { quantity: taken, amount_cents: taken_cents }, n }).amount_cents;
    const slice = sliceSubstitutedFor(entries, taken, taken + n);
    credits.push(credit6d([named("A", ["y"], n, { amount_cents: cents, ...(slice.length > 0 ? { substituted_for: slice } : {}) })]));
    runs.push(n);
    taken += n;
    taken_cents += cents;
  }
  assertEquals(runs, [2, 2, 3], "one credit per segment");
  assertEquals(taken_cents, 101);
  assertEquals([net("x1"), net("x2"), net("y")], [{ quantity: 0, amount_cents: 0 }, { quantity: 0, amount_cents: 0 }, { quantity: 0, amount_cents: 0 }]);
  assertEquals(creditableBillLines(bill, { per_purchase: [{ uid_purchase: PU, purchase: { items }, bills: [bill], credits }] })[0].units, 0);
});

Deno.test("creditableBillLines: the straddling credit the rule refuses is the one that moves a cent (6d)", () => {
  // Y: 3 units for $1.00, its first unit standing in for X. The bill gives X 33¢, Y's own 67¢.
  const items = asLines(buy({ uid: "x", path: ["x"], quantity: 1 }));
  const bill = bill6d("A", [row(["y"], 3, { amount_cents: 100, substituted_for: [{ path: ["x"], quantity: 1 }] })]);
  const net = (credits: PurchaseCredit[], path: string) =>
    purchaseLineBilledNet([path], { uid_purchase: PU, purchase_items: items, bills: [bill], credits }).amount_cents;
  assertEquals([net([], "x"), net([], "y")], [33, 67]);
  // Built by hand, a credit of units 1–2 (67¢, one standing in for X) then unit 3 (33¢)
  // leaves X at −1¢ and Y at +1¢: its fold gives X half of 67¢, rounded up.
  const straddle = [
    credit6d([named("A", ["y"], 2, { amount_cents: 67, substituted_for: [{ path: ["x"], quantity: 1 }] })]),
    credit6d([named("A", ["y"], 1, { amount_cents: 33 })]),
  ];
  assertEquals([net(straddle, "x"), net(straddle, "y")], [-1, 1]);
  // The rule refuses that first credit, and the segment-by-segment pair nets both to 0.
  const ctx = { per_purchase: [{ uid_purchase: PU, purchase: { items }, bills: [bill], credits: [] as PurchaseCredit[] }] };
  assertEquals(purchaseBillCreditRefusal(bill, ctx, [{ path_bill_item: [PU, "y"], quantity: 2 }])?.includes("credit those first"), true);
  const segmented = [
    credit6d([named("A", ["y"], 1, { amount_cents: 33, substituted_for: [{ path: ["x"], quantity: 1 }] })]),
    credit6d([named("A", ["y"], 2, { amount_cents: 67 })]),
  ];
  assertEquals([net(segmented, "x"), net(segmented, "y")], [0, 0]);
});
