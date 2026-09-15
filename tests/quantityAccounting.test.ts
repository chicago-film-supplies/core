/**
 * `billedByPath` / `accountLine` / `remainingForOrder` (api-cloudrun#680).
 * Every expected number is worked out by hand in the comment beside it; none is
 * produced by the code under test.
 */
import { assertEquals } from "@std/assert";
import {
  buildOrderScopedItems,
  computeOrderInvoiceCoverage,
  type InvoiceItem,
  validateInvoiceItemPaths,
  validateInvoiceItemUniqueness,
} from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import {
  type AccountedInvoice,
  accountLine,
  billedByPath,
  buildRemainingInvoice,
  remainingForOrder,
  type RemainingInvoiceSource,
} from "../src/utils/quantityAccounting.ts";

const O = "order-1";
const D = "dest-1";
const G = "group-1";
const LIGHT = "prod-light";
const KIT = "prod-kit";
const STAKE = "prod-stake";

function line(uid: string, path: string[], quantity: number, baseCents: number, days = 5, extra: Record<string, unknown> = {}): LineItem {
  return {
    uid, type: "rental", name: uid, description: "", quantity, path,
    stock_method: "reserve", zero_priced: false,
    price: {
      base_cents: baseCents, chargeable_days: days, formula: "five_day_week",
      subtotal_cents: 0, subtotal_discounted_cents: 0, discount: null, taxes: [], total_cents: 0, replacement_cents: 1000,
    },
    ...extra,
  } as unknown as LineItem;
}

const DEST_ITEM = { uid: D, type: "destination", name: "Venue", description: "", path: [D] } as unknown as LineItem;
const GROUP_ITEM = { uid: G, type: "group", name: "Grip", description: "", path: [D, G] } as unknown as LineItem;

function invoice(uid: string, items: LineItem[], status: AccountedInvoice["status"] = "draft"): AccountedInvoice {
  const divider = { uid: O, type: "order", name: "Order", description: "", path: [O] } as unknown as InvoiceItem;
  return { uid, status, items: [divider, ...(buildOrderScopedItems(items, O) as unknown as InvoiceItem[])] };
}

const lightOrder = (quantity: number, days = 5): LineItem[] => [DEST_ITEM, GROUP_ITEM, line(LIGHT, [D, G, LIGHT], quantity, 1000, days)];
const lightKey = `${D}/${G}/${LIGHT}`;

Deno.test("quantityAccounting: a split bill — 3 + 2 of 5 — sums to 5 and leaves nothing", () => {
  const order = lightOrder(5);
  const invoices = [invoice("a", lightOrder(3)), invoice("b", lightOrder(2))];
  const billed = billedByPath(O, order, invoices);
  assertEquals(billed.byPath.get(lightKey)?.quantity, 5);
  assertEquals(billed.compared, ["a", "b"]);
  assertEquals(remainingForOrder(O, order, invoices).lines, []);
});

Deno.test("quantityAccounting: a remainder — 4 billed of 6 — is 2 units at the order's price", () => {
  const order = lightOrder(6);
  const { lines } = remainingForOrder(O, order, [invoice("a", lightOrder(4))]);
  // 2 × 1000¢ at 5 days (factor 1) = 2000¢.
  assertEquals(lines.map((l) => [l.path.join("/"), l.ordered, l.billed, l.quantity, l.quantity_cents, l.extension_cents, l.new]), [
    [lightKey, 6, 4, 2, 2000, 0, false],
  ]);
});

Deno.test("quantityAccounting: a line no invoice carries comes in whole and is marked new", () => {
  const order = [...lightOrder(2), line("prod-tripod", [D, "prod-tripod"], 1, 3000)];
  const { lines } = remainingForOrder(O, order, [invoice("a", lightOrder(2))]);
  assertEquals(lines.map((l) => [l.path.join("/"), l.quantity, l.quantity_cents, l.new]), [[`${D}/prod-tripod`, 1, 3000, true]]);
});

Deno.test("quantityAccounting: a date extension is priced as D7 extension days, never as an ordinary line of the extra days", () => {
  // Billed 2 at 3 days: five_day_week floors at a week → 2 × 1000 = 2000¢.
  // The order now charges 7 days → D7 days = max(7,5) − max(3,5) = 2 → 2 × 1000 × 2 ÷ 5 = 800¢.
  // Pricing "the extra 4 days" as an ordinary line would floor to a week: 2000¢. Wrong.
  const { lines } = remainingForOrder(O, lightOrder(2, 7), [invoice("a", lightOrder(2, 3))]);
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[0, 0, 800]]);
});

Deno.test("quantityAccounting: an extension across a split bill prices each billed row on its own days", () => {
  // Order: 5 at 10 days. Row a: 3 at 5 days → 3000¢, at 10 days → 6000¢ (+3000).
  // Row b: 2 at 8 days → 2 × 1000 × 8 ÷ 5 = 3200¢, at 10 days → 4000¢ (+800). Total 3800¢.
  const { lines } = remainingForOrder(O, lightOrder(5, 10), [invoice("a", lightOrder(3, 5)), invoice("b", lightOrder(2, 8))]);
  assertEquals(lines.map((l) => [l.billed, l.quantity, l.extension_cents]), [[5, 0, 3800]]);
});

Deno.test("quantityAccounting: an extension rounds ONCE, as the extension invoice line will (#997 D11)", () => {
  // 1 unit at 333¢, billed at 6 days, the order now 7. D7 days = 7 − 6 = 1.
  // One rounding: 333 × 1 ÷ 5 = 66.6 → 67¢ — what an extension section bills.
  // The retired difference of two roundings gave round(466.2) − round(399.6) = 466 − 400 = 66¢.
  const order = [DEST_ITEM, line(LIGHT, [D, LIGHT], 1, 333, 7)];
  const billed = [DEST_ITEM, line(LIGHT, [D, LIGHT], 1, 333, 6)];
  const { lines } = remainingForOrder(O, order, [invoice("a", billed)]);
  assertEquals(lines.map((l) => [l.quantity, l.extension_cents]), [[0, 67]]);
});

Deno.test("quantityAccounting: a fixed-formula row extends by nothing, and does not throw", () => {
  // A `fixed` price never read its days, so an order whose days moved adds 0¢ to it.
  // The extension pricer refuses a non-five_day_week line, so the row must be skipped, not priced.
  const fixed = (days: number) => [DEST_ITEM, line(LIGHT, [D, LIGHT], 2, 1000, days, {})].map((it) =>
    it.type === "rental" ? { ...it, price: { ...it.price, formula: "fixed" } } as LineItem : it
  );
  assertEquals(remainingForOrder(O, fixed(10), [invoice("a", fixed(3))]).lines, []);
});

Deno.test("quantityAccounting: a billed row's tax refs do not reach the pre-tax pricer", () => {
  // The remainder is pre-tax, so a stored tax ref the pricer has no catalog entry for must not throw.
  // 2 units at 1000¢, billed 5 days, the order now 10: D7 days 5 → 2 × 1000 × 5 ÷ 5 = 2000¢.
  const taxed = (days: number) => [DEST_ITEM, line(LIGHT, [D, LIGHT], 2, 1000, days)].map((it) =>
    it.type === "rental"
      ? { ...it, price: { ...it.price, taxes: [{ uid: "tax-x", name: "X", rate: 10, type: "percent", amount_cents: 0 }] } } as LineItem
      : it
  );
  assertEquals(remainingForOrder(O, taxed(10), [invoice("a", taxed(5))]).lines.map((l) => l.extension_cents), [2000]);
});

Deno.test("quantityAccounting: over-billing is reported signed, not clamped", () => {
  // Billed 3 at 10 days (3 × 1000 × 2 = 6000¢); order now 2 at 5 days.
  // Quantity: −1 unit at the order's terms = −1000¢.
  // Extension on the billed row: 3 units at 5 days (3000¢) − at 10 days (6000¢) = −3000¢.
  const { lines } = remainingForOrder(O, lightOrder(2, 5), [invoice("a", lightOrder(3, 10))]);
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[-1, -1000, -3000]]);
});

Deno.test("quantityAccounting: a void invoice bills nothing", () => {
  const order = lightOrder(5);
  const invoices = [invoice("live", lightOrder(2)), invoice("dead", lightOrder(3), "void")];
  const billed = billedByPath(O, order, invoices);
  assertEquals([billed.byPath.get(lightKey)?.quantity, billed.compared], [2, ["live"]]);
  assertEquals(remainingForOrder(O, order, invoices).lines.map((l) => l.quantity), [3]);
});

/** Replace the invoice row at `relKey` with a substitute Y naming it. */
function substituted(inv: AccountedInvoice, relKey: string, uid: string, quantity: number): AccountedInvoice {
  const at = inv.items.findIndex((it) => it.path.join("/") === `${O}/${relKey}`);
  const replaced = inv.items[at];
  const y = {
    ...replaced, uid, name: uid, quantity,
    path: [...replaced.path.slice(0, -1), uid],
    path_substituted_for: replaced.path.slice(1),
  } as InvoiceItem;
  // Drop the replaced row and its whole subtree.
  const depth = replaced.path.length;
  let end = at + 1;
  while (end < inv.items.length && inv.items[end].path.length > depth && inv.items[end].path.slice(0, depth).join("/") === replaced.path.join("/")) end++;
  const items = [...inv.items];
  items.splice(at, end - at, y);
  return { ...inv, items };
}

Deno.test("quantityAccounting: an in-place substitute counts toward the line it replaced, and at its own path not at all", () => {
  const order = lightOrder(4);
  const inv = substituted(invoice("a", lightOrder(4)), lightKey, "prod-monopod", 4);
  const billed = billedByPath(O, order, [inv]);
  assertEquals(billed.byPath.get(lightKey)?.quantity, 4);
  assertEquals(billed.byPath.get(lightKey)?.rows.map((r) => r.via), ["substitute"]);
  assertEquals(billed.byPath.has(`${D}/${G}/prod-monopod`), false);
  assertEquals(remainingForOrder(O, order, [inv]).lines, []);
});

/** An order with a kit of 4 carrying 8 stakes — a stored ratio of 2 per kit. */
const kitOrder = (): LineItem[] => [
  DEST_ITEM,
  line(KIT, [D, KIT], 4, 5000),
  line(STAKE, [D, KIT, STAKE], 8, 0),
];

Deno.test("quantityAccounting: substituting a whole kit credits its components their full order quantity", () => {
  const inv = substituted(invoice("a", kitOrder()), `${D}/${KIT}`, "prod-alt-kit", 4);
  const billed = billedByPath(O, kitOrder(), [inv]);
  // 4 of 4 kits → 4 × 8 ÷ 4 = 8 stakes.
  assertEquals([billed.byPath.get(`${D}/${KIT}`)?.quantity, billed.byPath.get(`${D}/${KIT}/${STAKE}`)?.quantity], [4, 8]);
  assertEquals(remainingForOrder(O, kitOrder(), [inv]).lines, []);
});

Deno.test("quantityAccounting: a partial kit swap credits components by the ORDER's stored ratio", () => {
  // 1 of 4 kits swapped on invoice a; invoice b bills the other 3 kits and 6 of the 8 stakes.
  const swapped = substituted(invoice("a", kitOrder()), `${D}/${KIT}`, "prod-alt-kit", 1);
  const rest = invoice("b", [DEST_ITEM, line(KIT, [D, KIT], 3, 5000), line(STAKE, [D, KIT, STAKE], 6, 0)]);
  const billed = billedByPath(O, kitOrder(), [swapped, rest]);
  // Kit: 1 (substitute) + 3 (direct) = 4. Stakes: 6 direct + 1 × 8 ÷ 4 = 2 credited = 8.
  assertEquals([billed.byPath.get(`${D}/${KIT}`)?.quantity, billed.byPath.get(`${D}/${KIT}/${STAKE}`)?.quantity], [4, 8]);
});

Deno.test("quantityAccounting: an unaligned scope fails remainingForOrder closed", () => {
  const order = [DEST_ITEM, GROUP_ITEM, line(LIGHT, [D, G, LIGHT], 5, 1000), line("prod-tripod", [D, "prod-tripod"], 1, 3000)];
  const aligned = invoice("a", lightOrder(2));
  // Invoice b hangs the Light directly under the destination: no group divider.
  const unaligned = invoice("b", [DEST_ITEM, line(LIGHT, [D, LIGHT], 3, 1000)]);
  const billed = billedByPath(O, order, [aligned, unaligned]);
  assertEquals([billed.compared, billed.unaligned], [["a"], ["b"]]);
  assertEquals(remainingForOrder(O, order, [aligned, unaligned]), { lines: [], compared: ["a"], unaligned: ["b"] });
});

Deno.test("quantityAccounting: accountLine with nothing billed is the whole line", () => {
  // 3 × 1000¢ × 7 ÷ 5 = 4200¢.
  assertEquals(accountLine(line(LIGHT, [D, LIGHT], 3, 1000, 7), undefined), {
    ordered: 3, billed: 0, quantity: 3, quantity_cents: 4200, extension_cents: 0,
  });
});

Deno.test("quantityAccounting: the coverage census and the sum agree on which lines nothing bills", () => {
  const order = [...kitOrder(), line(LIGHT, [D, LIGHT], 2, 1000), line("prod-tripod", [D, "prod-tripod"], 1, 3000)];
  const invoices = [
    substituted(invoice("a", kitOrder()), `${D}/${KIT}`, "prod-alt-kit", 4),
    invoice("b", [DEST_ITEM, line(LIGHT, [D, LIGHT], 1, 1000)]),
    invoice("c", [DEST_ITEM, line("prod-tripod", [D, "prod-tripod"], 1, 3000)], "void"),
  ];
  const unbilledBySum = order
    .filter((it) => it.type === "rental" && !billedByPath(O, order, invoices).byPath.has(it.path.join("/")))
    .map((it) => it.path.join("/"));
  const uninvoiced = computeOrderInvoiceCoverage(O, order, invoices).uninvoiced.map((it) => it.path.join("/"));
  assertEquals(unbilledBySum, [`${D}/prod-tripod`]);
  assertEquals(uninvoiced, unbilledBySum);
});

// ── Date-extension sections (api-cloudrun#680 R1) ──

const E = "dest-ext";

/** An invoice holding only an extension section of D: its lines bill ADDED days. */
function extensionInvoice(uid: string, quantity: number, addedDays: number, target: string[] = [D]): AccountedInvoice {
  const items = [
    { uid: O, type: "order", name: "Order", description: "", path: [O] },
    { uid: E, type: "destination", name: "Venue", description: "", path: [O, E], path_extension_for: target },
    { uid: G, type: "group", name: "Grip", description: "", path: [O, E, G] },
    line(LIGHT, [O, E, G, LIGHT], quantity, 1000, addedDays),
  ] as unknown as InvoiceItem[];
  return { uid, status: "draft", items };
}

Deno.test("quantityAccounting: an extension section bills days, not units, and nets the extension to nothing", () => {
  // Billed 2 at 3 days; the order now charges 7. D7 days = max(7,5) − max(3,5) = 2,
  // so the unit row is owed 2 × 1000 × 2 ÷ 5 = 800¢. The section stores 2 added
  // days on 2 units: 2 × 1000 × 2 ÷ 5 = 800¢, floor skipped. 800 − 800 = 0.
  const order = lightOrder(2, 7);
  const invoices = [invoice("a", lightOrder(2, 3)), extensionInvoice("b", 2, 2)];
  const billed = billedByPath(O, order, invoices);
  assertEquals(billed.compared, ["a", "b"]);
  assertEquals(billed.unaligned, []);
  assertEquals(billed.byPath.get(lightKey)?.quantity, 2);
  assertEquals(billed.byPath.get(lightKey)?.rows.map((r) => [r.invoiceUid, r.via]), [["a", "direct"], ["b", "extension"]]);
  assertEquals(remainingForOrder(O, order, invoices).lines, []);
});

Deno.test("quantityAccounting: an extension section short of the order's days leaves the rest", () => {
  // Billed 2 at 3 days, order now 10: owed 2 × 1000 × (10 − 5) ÷ 5 = 2000¢.
  // A section extending by 2 billed 800¢, so 1200¢ remains.
  const { lines } = remainingForOrder(O, lightOrder(2, 10), [invoice("a", lightOrder(2, 3)), extensionInvoice("b", 2, 2)]);
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[0, 0, 1200]]);
});

Deno.test("quantityAccounting: an extension naming no order divider is an unaligned scope, and fails closed", () => {
  const invoices = [invoice("a", lightOrder(2, 3)), extensionInvoice("b", 2, 2, ["dest-gone"])];
  const result = remainingForOrder(O, lightOrder(2, 7), invoices);
  assertEquals([result.lines, result.unaligned], [[], ["b"]]);
});

Deno.test("computeOrderInvoiceCoverage: extension lines neither cover a line nor stand unmatched", () => {
  const order = lightOrder(2, 7);
  const onlyExtension = computeOrderInvoiceCoverage(O, order, [extensionInvoice("b", 2, 2)]);
  assertEquals([onlyExtension.compared, onlyExtension.unaligned, onlyExtension.unmatched], [["b"], [], []]);
  assertEquals(onlyExtension.uninvoiced.map((l) => l.uid), [LIGHT]);
  const both = computeOrderInvoiceCoverage(O, order, [invoice("a", lightOrder(2, 3)), extensionInvoice("b", 2, 2)]);
  assertEquals([both.uninvoiced, both.unmatched], [[], []]);
});

// ── The remainder invoice (api-cloudrun#680 R1) ──

const PAIR = {
  uid: D,
  dates: { charge_start: "2026-09-07T00:00:00.000-05:00", charge_end: "2026-09-21T00:00:00.000-05:00", days_charged: 10 },
} as unknown as import("../src/schemas/mod.ts").DocDestinationType;

function orderSource(items: LineItem[]) {
  return { uid: O, number: 1012, items, destinations: [PAIR] };
}

/** A billed invoice whose D section charged through `chargeEnd`. */
function billedWithPair(uid: string, items: LineItem[], chargeEnd: string): RemainingInvoiceSource {
  return {
    ...invoice(uid, items, "issued"),
    destinations: [{ ...PAIR, uid_order: O, dates: { ...(PAIR as { dates: object }).dates, charge_end: chargeEnd } }] as never,
  };
}

let minted = 0;
const mint = () => `ext-${++minted}`;

/** The remainder, stored as an invoice — what the next remainder reads back. */
function asInvoice(uid: string, built: ReturnType<typeof buildRemainingInvoice>): RemainingInvoiceSource {
  return { uid, status: "draft", items: built.items as unknown as InvoiceItem[], destinations: built.destinations };
}

Deno.test("buildRemainingInvoice: a new line, a quantity increase and an extension, built once, leave nothing to bill", () => {
  // Billed: 2 lights at 3 days. Order now: 3 lights at 7 days, plus a tripod.
  // Remainder: 1 light at 7 days (full window), the tripod whole, and an
  // extension section billing 2 lights at max(7,5) − max(3,5) = 2 added days.
  // Canonical order: a destination's own lines before its groups.
  const order = [DEST_ITEM, line("prod-tripod", [D, "prod-tripod"], 1, 3000, 7), GROUP_ITEM, line(LIGHT, [D, G, LIGHT], 3, 1000, 7)];
  const billed = [billedWithPair("a", lightOrder(2, 3), "2026-09-09T00:00:00.000-05:00")];
  const built = buildRemainingInvoice(orderSource(order), billed, mint);

  const rows = built.items.map((it) => [it.path.join("/"), it.type, (it as { quantity?: number }).quantity ?? null, (it as { price?: { chargeable_days: number } }).price?.chargeable_days ?? null]);
  const E = built.items.find((it) => (it as { path_extension_for?: string[] }).path_extension_for)!.uid;
  assertEquals(rows, [
    [O, "order", null, null],
    [`${O}/${D}`, "destination", null, null],
    [`${O}/${D}/prod-tripod`, "rental", 1, 7],
    [`${O}/${D}/${G}`, "group", null, null],
    [`${O}/${D}/${G}/${LIGHT}`, "rental", 1, 7],
    [`${O}/${E}`, "destination", null, null],
    [`${O}/${E}/${G}`, "group", null, null],
    [`${O}/${E}/${G}/${LIGHT}`, "rental", 2, 2],
  ]);
  // The section's pair charges from the day after the billed window ended.
  const pair = built.destinations.find((p) => p.uid === E)!;
  assertEquals([pair.dates.charge_start, pair.dates.charge_end, pair.dates.days_charged], [
    "2026-09-10T00:00:00.000-05:00",
    "2026-09-21T00:00:00.000-05:00",
    2,
  ]);
  assertEquals(remainingForOrder(O, order, [...billed, asInvoice("r", built)]).lines, []);
  // What the API's write guards assert: paths are what the one author computes, and rows are unique.
  assertEquals(validateInvoiceItemPaths(built.items as unknown as InvoiceItem[]), []);
  assertEquals(validateInvoiceItemUniqueness(built.items as unknown as InvoiceItem[]), []);
});

Deno.test("buildRemainingInvoice: a component increase carries its kit at quantity 0, so the component bills its own path", () => {
  // Order: 2 kits of 8 stakes, now 10 stakes. Billed: the kits and 8 stakes.
  const kitOrder = (stakes: number) => [DEST_ITEM, line(KIT, [D, KIT], 2, 5000), line(STAKE, [D, KIT, STAKE], stakes, 100)];
  const order = kitOrder(10);
  const billed = [billedWithPair("a", kitOrder(8), "2026-09-21T00:00:00.000-05:00")];
  const built = buildRemainingInvoice(orderSource(order), billed, mint);
  assertEquals(
    built.items.filter((it) => it.type === "rental").map((it) => [it.path.join("/"), (it as { quantity: number }).quantity]),
    [[`${O}/${D}/${KIT}`, 0], [`${O}/${D}/${KIT}/${STAKE}`, 2]],
  );
  assertEquals(remainingForOrder(O, order, [...billed, asInvoice("r", built)]).lines, []);
});

Deno.test("buildRemainingInvoice: units billed at different days extend in one section per billed window", () => {
  // 3 at 5 days on a, 2 at 8 days on b; the order now 10 days.
  // Sections: 3 units at 10 − 5 = 5 added days, 2 units at 10 − 8 = 2.
  const order = lightOrder(5, 10);
  const billed = [
    billedWithPair("a", lightOrder(3, 5), "2026-09-11T00:00:00.000-05:00"),
    billedWithPair("b", lightOrder(2, 8), "2026-09-16T00:00:00.000-05:00"),
  ];
  const built = buildRemainingInvoice(orderSource(order), billed, mint);
  const extensions = built.items.filter((it) => it.type === "rental").map((it) => [(it as { quantity: number }).quantity, (it as { price: { chargeable_days: number } }).price.chargeable_days]);
  assertEquals(extensions, [[3, 5], [2, 2]]);
  assertEquals(built.destinations.slice(1).map((p) => p.dates.charge_start), ["2026-09-12T00:00:00.000-05:00", "2026-09-17T00:00:00.000-05:00"]);
  assertEquals(remainingForOrder(O, order, [...billed, asInvoice("r", built)]).lines, []);
});

Deno.test("buildRemainingInvoice: a second extension extends from the days the first one billed", () => {
  // 2 at 3 days, extended to 7 by a first remainder (2 added), then the order
  // goes to 12: the second remainder adds 12 − 7 = 5 days, not 12 − 5 = 7.
  const billed = [billedWithPair("a", lightOrder(2, 3), "2026-09-09T00:00:00.000-05:00")];
  const first = asInvoice("r1", buildRemainingInvoice(orderSource(lightOrder(2, 7)), billed, mint));
  const order = lightOrder(2, 12);
  const second = buildRemainingInvoice(orderSource(order), [...billed, first], mint);
  assertEquals(second.items.filter((it) => it.type === "rental").map((it) => (it as { price: { chargeable_days: number } }).price.chargeable_days), [5]);
  assertEquals(remainingForOrder(O, order, [...billed, first, asInvoice("r2", second)]).lines, []);
});

Deno.test("buildRemainingInvoice: over-billing is returned for a credit note, never netted into the remainder", () => {
  // Billed 3 at 7 days; the order is now 2 at 3 days. Nothing remains to bill.
  const built = buildRemainingInvoice(orderSource(lightOrder(2, 3)), [billedWithPair("a", lightOrder(3, 7), "2026-09-15T00:00:00.000-05:00")], mint);
  assertEquals(built.items, []);
  assertEquals(built.overbilled, [
    { path: [D, G, LIGHT], quantity: -1, extension_days: 0 },
    { path: [D, G, LIGHT], quantity: 3, extension_days: -2 },
  ]);
});

Deno.test("buildRemainingInvoice: an unaligned scope fails closed", () => {
  const stray = invoice("a", [{ ...DEST_ITEM, uid: "dest-other", path: ["dest-other"] } as LineItem, line(LIGHT, ["dest-other", LIGHT], 1, 1000)]);
  const built = buildRemainingInvoice(orderSource(lightOrder(3)), [stray], mint);
  assertEquals([built.items, built.unaligned], [[], ["a"]]);
});
