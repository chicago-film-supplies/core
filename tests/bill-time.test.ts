/**
 * A bill's TIME line on the account (one-document-model 6e-0b2 F5; owner
 * 2026-11-15): `splitBillTime` fills a bill's units from the line's never-billed
 * units, then its owed extension groups; `billExtensionSections` builds the
 * owed time as a date-extension section. The round trip is the proof: fold the
 * built bill beside the first and nothing is owed any more.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { accountInitiator, type AccountingContext, billedByPath, type PayableFoldBill } from "../src/utils/quantityAccounting.ts";
import { billExtensionSections, creditTimeCounts, splitBillTime } from "../src/utils/purchase-documents.ts";
import { businessDayWindow, fdwCounts, fdwPrice, FORMULAS, tier } from "./helpers/formulas.ts";
import type { LineItem } from "../src/utils/orders.ts";
import type { Purchase, PurchaseItem } from "../src/schemas/mod.ts";

type Billable = Pick<Purchase, "uid" | "items" | "destinations">;
const asPurchase = (p: unknown) => p as Billable;

const P = "purchase-1";
const D = "dest-1";
const G = "group-1";
const X = "prod-x";
const ctx: AccountingContext = { formulas: FORMULAS, holidays: [] };
const row = (o: Record<string, unknown>) => o as unknown as LineItem;

/** A purchase hiring `quantity` of X, its pair windowed over `days` business days (the bill's clip). */
function purchaseOf(quantity: number, days: number) {
  const items = [
    row({ uid: D, type: "destination", path: [D], name: "Shop", description: "" }),
    row({ uid: G, type: "group", path: [D, G], name: "Lights", description: "" }),
    row({ uid: X, type: "rental", path: [D, G, X], name: "Light", description: "", quantity, price: { ...fdwPrice(10000), discount: null, taxes: [] } }),
  ];
  return {
    uid: P,
    items,
    destinations: [{ uid: D, dates: { delivery_start: businessDayWindow(days).start, charge_windows: [businessDayWindow(days)] } }],
  };
}

/** A bill of `quantity` X over the first `days` business days. */
function firstBill(quantity: number, days: number): PayableFoldBill {
  return {
    uid: "bill-1",
    status: "issued",
    number: 1,
    destinations: [{ uid: D, uid_purchase: P, dates: { charge_windows: [businessDayWindow(days)] } }],
    items: [
      { uid: P, type: "purchase", path: [P], name: "PO-1", description: "" },
      { uid: D, type: "destination", path: [P, D], name: "Shop", description: "" },
      { uid: G, type: "group", path: [P, D, G], name: "Lights", description: "" },
      { uid: X, type: "rental", path: [P, D, G, X], quantity, amount_cents: 0, price: { ...fdwPrice(10000, days), discount: null, taxes: [] } },
    ],
  } as unknown as PayableFoldBill;
}

function lineOf(purchase: ReturnType<typeof purchaseOf>, bills: PayableFoldBill[]) {
  const account = accountInitiator("payable", purchase, billedByPath("payable", purchase, bills), null, [], ctx);
  return account.lines.find((l) => l.path.join("/") === `${D}/${G}/${X}`)!;
}

let seq = 0;
const mint = () => `ext-${++seq}`;

Deno.test("splitBillTime: owed time is taken after the line's never-billed units, the rest is over-billing", () => {
  // 3 hired, 2 billed over 5 days; the bill now runs to 7.
  const line = lineOf(purchaseOf(3, 7), [firstBill(2, 5)]);
  assertEquals(line.remaining.units, 1);
  assertEquals(line.remaining.owed.map((g) => [g.quantity, g.extension_counts]), [[2, [tier("week", 2, 5)]]]);
  // 4 asked: 1 never billed, 2 owed time, 1 past both.
  const split = splitBillTime(line, 4)!;
  assertEquals([split.own, split.extensions.map((e) => e.quantity)], [2, [2]]);
  // 1 asked: the never-billed unit alone.
  assertEquals(splitBillTime(line, 1), { own: 1, extensions: [] });
});

Deno.test("splitBillTime: nothing unbilled is null, so the writer can refuse by name", () => {
  // Billed 2 over the whole 5-day window: nothing new, no time owed.
  assertEquals(splitBillTime(lineOf(purchaseOf(2, 5), [firstBill(2, 5)]), 2), null);
});

Deno.test("billExtensionSections: the owed time is a section extending its destination, and folds back to nothing owed", () => {
  const purchase = purchaseOf(2, 7);
  const line = lineOf(purchase, [firstBill(2, 5)]);
  const split = splitBillTime(line, 2)!;
  assertEquals(split.own, 0);
  const built = billExtensionSections(asPurchase(purchase), [{ item: purchase.items[2] as unknown as PurchaseItem, extensions: split.extensions }], mint);
  const E = built.items[0].uid;
  assertEquals(built.items.map((r) => [r.type, r.path.join("/")]), [
    ["destination", `${P}/${E}`],
    ["group", `${P}/${E}/${G}`],
    ["rental", `${P}/${E}/${G}/${X}`],
  ]);
  assertEquals((built.items[0] as { path_extension_for?: string[] }).path_extension_for, [D]);
  const ext = built.items[2] as unknown as { quantity: number; price: { counts: unknown } };
  assertEquals([ext.quantity, ext.price.counts], [2, [tier("week", 2, 5)]]);
  // The section's window starts the day after the first bill's ended (Fri Jan 9).
  assertEquals(built.destinations.map((d) => [d.uid, d.dates.charge_windows![0].start.slice(0, 10)]), [[E, "2026-01-10"]]);

  // Round trip: the two bills together owe nothing, and add no units.
  const second = {
    uid: "bill-2",
    status: "issued",
    number: 2,
    destinations: built.destinations,
    items: [{ uid: P, type: "purchase", path: [P], name: "PO-1", description: "" }, ...built.items],
  } as unknown as PayableFoldBill;
  const after = lineOf(purchase, [firstBill(2, 5), second]);
  assertEquals([after.billed.quantity, after.remaining.units, after.remaining.owed], [2, 0, []]);
  assertEquals(after.extension.groups, []);
});

Deno.test("billExtensionSections: nothing taken builds nothing; a destination with no window refuses", () => {
  const purchase = purchaseOf(2, 7);
  assertEquals(billExtensionSections(asPurchase(purchase), [], mint), { items: [], destinations: [] });
  const line = lineOf(purchase, [firstBill(2, 5)]);
  const open = { ...purchase, destinations: [{ uid: D, dates: { delivery_start: null, charge_windows: null } }] };
  assertThrows(
    () => billExtensionSections(asPurchase(open), [{ item: purchase.items[2] as unknown as PurchaseItem, extensions: splitBillTime(line, 2)!.extensions }], mint),
    Error,
    "no charge window",
  );
});

// The companion: today's writer re-billed the SAME units over the cumulative window,
// which the account reads as those units billed twice over overlapping time.
Deno.test("the cumulative re-bill this replaces is read as doubled time (why the writer moved with the fold)", () => {
  const purchase = purchaseOf(2, 7);
  const cumulative = {
    ...firstBill(2, 7),
    uid: "bill-2",
    number: 2,
    items: firstBill(2, 7).items.map((r) => (r.uid === X ? { ...r, price: { ...(r as { price: object }).price, counts: fdwCounts(2, { stated: true }) } } : r)),
  } as unknown as PayableFoldBill;
  const line = lineOf(purchase, [firstBill(2, 5), cumulative]);
  assertEquals(line.billed.quantity, 4, "the account counts the re-billed units twice");
});

/** A bill of `quantity` X over the first `days` business days, as its own document. */
const billOf = (uid: string, number: number, quantity: number, days: number): PayableFoldBill =>
  ({ ...firstBill(quantity, days), uid, number }) as PayableFoldBill;

Deno.test("creditTimeCounts: the newest billed time is credited first, as one exact mean row", () => {
  // One unit billed 5 days (ends Fri Jan 9), one billed 7 days (ends Tue Jan 13).
  const line = lineOf(purchaseOf(2, 7), [billOf("bill-a", 1, 1, 5), billOf("bill-b", 2, 1, 7)]);
  assertEquals(line.extension.billed.map((g) => [g.quantity, g.billed_counts]).sort(), [[1, [tier("week", 1, 1)]], [1, [tier("week", 7, 5)]]].sort());
  // 1 unit: the newest group's 7 days, not the 5.
  assertEquals(creditTimeCounts(line, 1), [tier("week", 7, 5)]);
  // 2 units: the mean, 6 days a unit, so 2 × 6 = 5 + 7 days in total.
  assertEquals(creditTimeCounts(line, 2), [tier("week", 6, 5)]);
});

Deno.test("creditTimeCounts: no billed time is null; an extended group credits its whole billed time", () => {
  assertEquals(creditTimeCounts(lineOf(purchaseOf(2, 7), []), 1), null);
  // The extended units' group carries the section's added days on top of the first bill's.
  const purchase = purchaseOf(2, 7);
  const split = splitBillTime(lineOf(purchase, [firstBill(2, 5)]), 2)!;
  const built = billExtensionSections(asPurchase(purchase), [{ item: purchase.items[2] as unknown as PurchaseItem, extensions: split.extensions }], mint);
  const second = { uid: "bill-2", status: "issued", number: 2, destinations: built.destinations, items: [{ uid: P, type: "purchase", path: [P] }, ...built.items] } as unknown as PayableFoldBill;
  assertEquals(creditTimeCounts(lineOf(purchase, [firstBill(2, 5), second]), 2), [tier("week", 7, 5)]);
});
