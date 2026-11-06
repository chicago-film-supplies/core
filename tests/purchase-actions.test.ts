/**
 * The purchase action ruleset (`src/utils/purchase-actions.ts`). Each refusal
 * here restates what the API refuses, by hand, because the API does not assert
 * these functions yet; the module docblock says so.
 */
import { assert, assertEquals } from "@std/assert";
import {
  type PurchaseActionItem,
  purchaseActionsFor,
  purchaseBillActionsFor,
  purchaseBilledPaths,
  purchaseCreditActionsFor,
  purchaseItemClosable,
  purchaseItemTouched,
} from "../src/utils/purchase-actions.ts";
import { derivePurchaseBillStatus } from "../src/utils/purchases.ts";
import {
  PURCHASE_ACTION_IDS,
  PURCHASE_ACTIONS,
  PURCHASE_BILL_STATUSES,
  type PurchaseBill,
  type PurchaseDocumentItem,
} from "../src/schemas/mod.ts";
import { priceFormulaRefOf } from "../src/utils/price-formulas.ts";
import { FIXED, FORMULAS, VISION } from "./helpers/formulas.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const FIXED_PRICE = { price_formula: priceFormulaRefOf(FIXED), rates: [], discount: null };
const TIME_PRICE = {
  price_formula: priceFormulaRefOf(VISION),
  rates: [{ rate_key: "month", amount_cents: 15750 }, { rate_key: "week", amount_cents: 4500 }],
  discount: null,
};

const buy = (o: Record<string, unknown> = {}) => ({
  type: "buy", uid: "b", path: ["b"], quantity: 3, price: FIXED_PRICE,
  quantity_received: 0, quantity_billed: 0, quantity_canceled: 0, ...o,
}) as PurchaseActionItem;
const subrent = (o: Record<string, unknown> = {}) => ({
  type: "subrent", uid: "s", path: ["s"], quantity: 2, price: FIXED_PRICE,
  quantity_received: 0, quantity_returned: 0, quantity_billed: 0, quantity_canceled: 0, ...o,
}) as PurchaseActionItem;
const charge = (o: Record<string, unknown> = {}) => ({
  type: "charge", uid: "c", path: ["c"], quantity: 2, price: FIXED_PRICE, quantity_billed: 0, quantity_canceled: 0, ...o,
}) as PurchaseActionItem;
const timeCharge = (o: Record<string, unknown> = {}) => charge({ price: TIME_PRICE, quantity_billed: null, ...o });

const po = (items: PurchaseActionItem[], status: "active" | "complete" | "canceled" = "active", query_by_bills: string[] = []) => ({ status, items, query_by_bills });
const keys = (offers: { key: string }[]) => offers.map((o) => o.key);
const offer = (offers: ReturnType<typeof purchaseActionsFor>, key: string) => offers.find((o) => o.key === key);

Deno.test("PURCHASE_ACTION_IDS and PURCHASE_ACTIONS name the same actions, both ways", () => {
  assertEquals([...PURCHASE_ACTION_IDS].sort(), Object.keys(PURCHASE_ACTIONS).sort());
  assertEquals(new Set(PURCHASE_ACTION_IDS).size, PURCHASE_ACTION_IDS.length);
});

Deno.test("purchaseItemClosable: units to arrive, an unbilled charge; never a subrent with units out", () => {
  assert(purchaseItemClosable(buy()));
  assert(!purchaseItemClosable(buy({ quantity_received: 3 })));
  assert(!purchaseItemClosable(buy({ quantity_canceled: 3 })));
  assert(purchaseItemClosable(subrent()));
  // One of two arrived and is still out: the API refuses this close (the subrent plan, D4).
  assert(!purchaseItemClosable(subrent({ quantity_received: 1 })));
  assert(purchaseItemClosable(subrent({ quantity_received: 1, quantity_returned: 1 })));
  assert(purchaseItemClosable(charge()));
  assert(purchaseItemClosable(charge({ quantity_billed: 1 })));
  assert(!purchaseItemClosable(charge({ quantity_billed: 2 })));
  assert(!purchaseItemClosable(charge({ quantity_billed: 3 })), "an over-billed charge has nothing left to cancel");
  assert(purchaseItemClosable(timeCharge()));
  assert(!purchaseItemClosable(timeCharge({ quantity_canceled: 2 })));
});

Deno.test("purchaseItemTouched: buckets, and a time line a bill names", () => {
  assert(!purchaseItemTouched(buy(), new Set()));
  for (const o of [{ quantity_received: 1 }, { quantity_billed: 1 }, { quantity_canceled: 1 }]) assert(purchaseItemTouched(buy(o), new Set()));
  assert(purchaseItemTouched(subrent({ quantity_returned: 1 }), new Set()));
  assert(!purchaseItemTouched(timeCharge(), new Set()));
  assert(purchaseItemTouched(timeCharge(), new Set(["c"])), "a time line counts no quantity_billed");
});

Deno.test("purchaseBilledPaths: a voided bill names nothing", () => {
  const line = { path_purchase_item: ["c"] } as PurchaseDocumentItem;
  const direct = {} as PurchaseDocumentItem;
  const totals = (amount_void_cents: number) => ({ amount_void_cents }) as PurchaseBill["totals"];
  assertEquals([...purchaseBilledPaths([{ totals: totals(0), items: [line, direct] }])], ["c"]);
  assertEquals([...purchaseBilledPaths([{ totals: totals(500), items: [line] }])], []);
});

Deno.test("close: refused whole while a subrent has units out, even with another line open", () => {
  const out = subrent({ quantity: 1, quantity_received: 1 });
  const offers = purchaseActionsFor(po([buy(), out]));
  assertEquals(offer(offers, "close"), undefined);
  assert(offer(offers, "close_item:b"), "the open buy still closes on its own");
  assertEquals(offer(offers, "close_item:s"), undefined);
});

Deno.test("close: only an active purchase, and only with something to close", () => {
  assertEquals(offer(purchaseActionsFor(po([buy()], "complete")), "close"), undefined);
  assertEquals(offer(purchaseActionsFor(po([buy({ quantity_received: 3 })])), "close"), undefined);
});

Deno.test("close outcome: cancel only when every line ends canceled in full", () => {
  const outcome = (items: PurchaseActionItem[]) => offer(purchaseActionsFor(po(items)), "close")?.outcome;
  assertEquals(outcome([buy()]), "cancel");
  assertEquals(outcome([buy({ quantity_received: 1 })]), "close");
  // A part-billed flat charge keeps its billed unit, so the purchase ends complete.
  assertEquals(outcome([charge({ quantity_billed: 1 })]), "close");
  // A time charge cancels in full however much was billed.
  assertEquals(outcome([timeCharge()]), "cancel");
  // A billed, unreceived buy cancels too: the close credits the excess.
  assertEquals(outcome([buy({ quantity_billed: 1 })]), "cancel");
});

Deno.test("add_bill: any purchase that is not canceled, fully billed included (owner, 2026-11-05)", () => {
  assert(offer(purchaseActionsFor(po([buy({ quantity_billed: 3, quantity_received: 3 })], "complete")), "add_bill"));
  assertEquals(offer(purchaseActionsFor(po([buy({ quantity_canceled: 3 })], "canceled")), "add_bill"), undefined);
});

Deno.test("add_credit: a billed line, or any bill, which reaches a time-only purchase", () => {
  assertEquals(offer(purchaseActionsFor(po([timeCharge()])), "add_credit"), undefined);
  assert(offer(purchaseActionsFor(po([buy({ quantity_billed: 1 })])), "add_credit"));
  assert(offer(purchaseActionsFor(po([timeCharge()], "active", ["bill1"])), "add_credit"));
});

Deno.test("bill_item: a flat line's remaining units; an over-billed line offers none", () => {
  assertEquals(offer(purchaseActionsFor(po([buy({ quantity_billed: 1 })])), "bill_item:b")?.max_quantity, 2);
  assertEquals(offer(purchaseActionsFor(po([buy({ quantity_billed: 4 })])), "bill_item:b"), undefined);
  assertEquals(offer(purchaseActionsFor(po([buy()], "canceled")), "bill_item:b"), undefined);
});

Deno.test("bill_item: a time line unprobed offers its open units; probed, a fully billed one offers nothing", () => {
  const line = {
    ...subrent({ uid: "t", path: ["t"], price: TIME_PRICE, quantity_billed: null, quantity: 1, quantity_received: 1, quantity_returned: 1 }),
    uid_units: ["unit-1"],
    dates: null,
  } as unknown as PurchaseActionItem;
  assertEquals(offer(purchaseActionsFor(po([line])), "bill_item:t")?.max_quantity, 1);

  const window = { start: "2026-01-01T00:00:00.000-06:00", end: "2026-01-08T00:00:00.000-06:00" };
  const units = [{ uid: "unit-1", charge_windows: [{ ...window, uid: "w", uid_order: null, uid_price_formula: VISION.uid, notes: "", changed_by: { uid: "u", name: "u" } }] }];
  const pricing = { formulas: new Map([...FORMULAS, [VISION.uid, VISION]]), holidays: [] };
  const through = "2026-02-01T00:00:00.000-06:00";
  const open = { through, units, billed: { bills: [], credits: [] }, pricing };
  assertEquals(offer(purchaseActionsFor(po([line]), { billing: open }), "bill_item:t")?.max_quantity, 1);

  const billed = {
    totals: { amount_void_cents: 0 },
    number: 1,
    items: [{ path_purchase_item: ["t"], units: [{ uid_unit: "unit-1", charge_windows: [window] }], dates: null }],
  } as unknown as PurchaseBill;
  const done = { ...open, billed: { bills: [billed], credits: [] } };
  assertEquals(offer(purchaseActionsFor(po([line]), { billing: done }), "bill_item:t"), undefined);

  // Fail closed: a formula the context does not hold throws in the projector, and is not offered.
  const blind = { ...open, pricing: { formulas: new Map(), holidays: [] } };
  assertEquals(offer(purchaseActionsFor(po([line]), { billing: blind }), "bill_item:t"), undefined);
});

Deno.test("remove_item and change_basis: only an untouched line, a billed time line included", () => {
  assertEquals(keys(purchaseActionsFor(po([timeCharge()]))).filter((k) => /remove|basis/.test(k)), ["remove_item:c", "change_basis:c"]);
  const billed = purchaseActionsFor(po([timeCharge()]), { billed_paths: new Set(["c"]) });
  assertEquals(keys(billed).filter((k) => /remove|basis/.test(k)), []);
  assert(offer(billed, "close_item:c"), "a billed time line offers Close instead");
});

Deno.test("purchaseBillActionsFor: a live ACCPAY with money due, capped at what is due", () => {
  const bill = (due: number, o: Partial<PurchaseBill["totals"]> = {}, xero_document: PurchaseBill["xero_document"] = "invoice") =>
    ({ xero_document, totals: { total_cents: 1000, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0, amount_due_cents: due, ...o } }) as PurchaseBill;
  assertEquals(purchaseBillActionsFor(bill(400)), [{ key: "allocate_credit", action: "allocate_credit", max_cents: 400 }]);
  assertEquals(purchaseBillActionsFor(bill(0)), []);
  assertEquals(purchaseBillActionsFor(bill(1000, { amount_void_cents: 1000 })), [], "voided, though a stale due reads money owed");
  assertEquals(purchaseBillActionsFor(bill(400, {}, "bank_transaction")), [], "a card payment is born paid");
});

Deno.test("purchaseCreditActionsFor: void only while nothing has drawn on it", () => {
  const credit = (status: "issued" | "applied" | "void", remaining: number) => ({ status, total_cents: 1000, remaining_credit_cents: remaining });
  assertEquals(purchaseCreditActionsFor(credit("issued", 1000)), [{ key: "void_credit", action: "void_credit" }]);
  assertEquals(purchaseCreditActionsFor(credit("issued", 999)), []);
  assertEquals(purchaseCreditActionsFor(credit("void", 1000)), []);
});

Deno.test("derivePurchaseBillStatus: every member, read off the totals", () => {
  const status = (total_cents: number, paid: number, credited: number, voided = 0) =>
    derivePurchaseBillStatus({ totals: { total_cents, amount_paid_cents: paid, amount_credited_cents: credited, amount_void_cents: voided } });
  assertEquals(status(1000, 0, 0), "unpaid");
  assertEquals(status(0, 0, 0), "unpaid", "no closure row exists on a bill");
  assertEquals(status(1000, 400, 0), "part_paid");
  assertEquals(status(1000, 0, 400), "part_paid");
  assertEquals(status(1000, 1000, 0), "paid");
  assertEquals(status(1000, 600, 400), "paid", "money was paid, so credit does not name it");
  assertEquals(status(1000, 1200, 0), "paid", "an overpayment from Xero is a fact");
  assertEquals(status(1000, 0, 1000), "credited");
  assertEquals(status(1000, 0, 0, 1000), "void");
  assertEquals(status(1000, 600, 0, 1000), "void", "a void beats anything its reversers left");
  assertEquals(status(1000, -100, 0), "unpaid", "a net-negative bucket is not part paid");
  assertEquals(
    derivePurchaseBillStatus({
      totals: { total_cents: 0, amount_paid_cents: 0, amount_credited_cents: 0, amount_void_cents: 0 },
      voided_at: mockTimestamp,
    }),
    "void",
    "a $0 void folds to 0, so the stamp is the only thing saying so",
  );
  // Coverage: the cases above reach every member.
  assertEquals(PURCHASE_BILL_STATUSES.length, 5);
});
