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
import { addChicagoDays } from "../src/utils/dates.ts";
import type { DocDestinationType } from "../src/schemas/mod.ts";
import {
  type AccountedInvoice,
  accountLine,
  billedByPath,
  buildRemainingInvoice,
  crmsAuthoredInvoices,
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
    stock_method: "reserve", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
    price: {
      base_cents: baseCents, chargeable_days: days, formula: "five_day_week",
      subtotal_cents: 0, subtotal_discounted_cents: 0, discount: null, taxes: [], total_cents: 0, replacement_cents: 1000,
    },
    ...extra,
  } as unknown as LineItem;
}

const DEST_ITEM = { uid: D, type: "destination", name: "Venue", description: "", path: [D] } as unknown as LineItem;
const GROUP_ITEM = { uid: G, type: "group", name: "Grip", description: "", path: [D, G] } as unknown as LineItem;

/**
 * Windows in these fixtures: every pair charges from START, and a pair charging
 * N days ends N days later — so a later end always means more days, which is
 * what an extension compares. The census shapes below break that on purpose.
 */
const START = "2026-09-06T00:00:00.000-05:00";
const endFor = (days: number) => addChicagoDays(START, days);
const pairFor = (uid: string, days: number, end = endFor(days)) =>
  ({ uid, dates: { charge_windows: [{ start: START, end, days }] } }) as unknown as DocDestinationType;
/** The order's pairs: D charging `days`. */
const pairs = (days = 5, end?: string): DocDestinationType[] => [pairFor(D, days, end)];

/** An invoice of `items` under order O, its D pair charging the first rental's days (override with `window`). */
function invoice(
  uid: string,
  items: LineItem[],
  status: AccountedInvoice["status"] = "draft",
  window?: { days: number; end?: string },
): AccountedInvoice {
  const divider = { uid: O, type: "order", name: "Order", description: "", path: [O] } as unknown as InvoiceItem;
  const days = window?.days ?? (items.find((it) => it.type === "rental") as { price?: { chargeable_days?: number } } | undefined)?.price?.chargeable_days ?? 5;
  return {
    uid,
    status,
    items: [divider, ...(buildOrderScopedItems(items, O) as unknown as InvoiceItem[])],
    destinations: [{ ...pairFor(D, days, window?.end), uid_order: O }] as never,
  };
}

const lightOrder = (quantity: number, days = 5): LineItem[] => [DEST_ITEM, GROUP_ITEM, line(LIGHT, [D, G, LIGHT], quantity, 1000, days)];
const lightKey = `${D}/${G}/${LIGHT}`;

Deno.test("quantityAccounting: a split bill — 3 + 2 of 5 — sums to 5 and leaves nothing", () => {
  const order = lightOrder(5);
  const invoices = [invoice("a", lightOrder(3)), invoice("b", lightOrder(2))];
  const billed = billedByPath(O, order, invoices);
  assertEquals(billed.byPath.get(lightKey)?.quantity, 5);
  assertEquals(billed.compared, ["a", "b"]);
  assertEquals(remainingForOrder(O, order, invoices, pairs(5)).lines, []);
});

Deno.test("quantityAccounting: a remainder — 4 billed of 6 — is 2 units at the order's price", () => {
  const order = lightOrder(6);
  const { lines } = remainingForOrder(O, order, [invoice("a", lightOrder(4))], pairs());
  // 2 × 1000¢ at 5 days (factor 1) = 2000¢.
  assertEquals(lines.map((l) => [l.path.join("/"), l.ordered, l.billed, l.quantity, l.quantity_cents, l.extension_cents, l.new]), [
    [lightKey, 6, 4, 2, 2000, 0, false],
  ]);
});

Deno.test("quantityAccounting: a line no invoice carries comes in whole and is marked new", () => {
  const order = [...lightOrder(2), line("prod-tripod", [D, "prod-tripod"], 1, 3000)];
  const { lines } = remainingForOrder(O, order, [invoice("a", lightOrder(2))], pairs());
  assertEquals(lines.map((l) => [l.path.join("/"), l.quantity, l.quantity_cents, l.new]), [[`${D}/prod-tripod`, 1, 3000, true]]);
});

Deno.test("quantityAccounting: a date extension is priced as D7 extension days, never as an ordinary line of the extra days", () => {
  // Billed 2 at 3 days: five_day_week floors at a week → 2 × 1000 = 2000¢.
  // The order now charges 7 days → D7 days = max(7,5) − max(3,5) = 2 → 2 × 1000 × 2 ÷ 5 = 800¢.
  // Pricing "the extra 4 days" as an ordinary line would floor to a week: 2000¢. Wrong.
  const { lines } = remainingForOrder(O, lightOrder(2, 7), [invoice("a", lightOrder(2, 3))], pairs(7));
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[0, 0, 800]]);
});

Deno.test("quantityAccounting: an extension across a split bill prices each billed row on its own days", () => {
  // Order: 5 at 10 days. Row a: 3 at 5 days → 3000¢, at 10 days → 6000¢ (+3000).
  // Row b: 2 at 8 days → 2 × 1000 × 8 ÷ 5 = 3200¢, at 10 days → 4000¢ (+800). Total 3800¢.
  const { lines } = remainingForOrder(O, lightOrder(5, 10), [invoice("a", lightOrder(3, 5)), invoice("b", lightOrder(2, 8))], pairs(10));
  assertEquals(lines.map((l) => [l.billed, l.quantity, l.extension_cents]), [[5, 0, 3800]]);
});

Deno.test("quantityAccounting: an extension rounds ONCE, as the extension invoice line will (#997 D11)", () => {
  // 1 unit at 333¢, billed at 6 days, the order now 7. D7 days = 7 − 6 = 1.
  // One rounding: 333 × 1 ÷ 5 = 66.6 → 67¢ — what an extension section bills.
  // The retired difference of two roundings gave round(466.2) − round(399.6) = 466 − 400 = 66¢.
  const order = [DEST_ITEM, line(LIGHT, [D, LIGHT], 1, 333, 7)];
  const billed = [DEST_ITEM, line(LIGHT, [D, LIGHT], 1, 333, 6)];
  const { lines } = remainingForOrder(O, order, [invoice("a", billed)], pairs(7));
  assertEquals(lines.map((l) => [l.quantity, l.extension_cents]), [[0, 67]]);
});

Deno.test("quantityAccounting: a fixed-formula row extends by nothing, and does not throw", () => {
  // A `fixed` price never read its days, so an order whose days moved adds 0¢ to it.
  // The extension pricer refuses a non-five_day_week line, so the row must be skipped, not priced.
  const fixed = (days: number) => [DEST_ITEM, line(LIGHT, [D, LIGHT], 2, 1000, days, {})].map((it) =>
    it.type === "rental" ? { ...it, price: { ...it.price, formula: "fixed" } } as LineItem : it
  );
  assertEquals(remainingForOrder(O, fixed(10), [invoice("a", fixed(3))], pairs(10)).lines, []);
});

Deno.test("quantityAccounting: a billed row's tax refs do not reach the pre-tax pricer", () => {
  // The remainder is pre-tax, so a stored tax ref the pricer has no catalog entry for must not throw.
  // 2 units at 1000¢, billed 5 days, the order now 10: D7 days 5 → 2 × 1000 × 5 ÷ 5 = 2000¢.
  const taxed = (days: number) => [DEST_ITEM, line(LIGHT, [D, LIGHT], 2, 1000, days)].map((it) =>
    it.type === "rental"
      ? { ...it, price: { ...it.price, taxes: [{ uid: "tax-x", name: "X", rate: 10, type: "percent", amount_cents: 0 }] } } as LineItem
      : it
  );
  assertEquals(remainingForOrder(O, taxed(10), [invoice("a", taxed(5))], pairs(10)).lines.map((l) => l.extension_cents), [2000]);
});

Deno.test("quantityAccounting: over-billing is reported signed, not clamped", () => {
  // Billed 3 at 10 days (3 × 1000 × 2 = 6000¢); order now 2 at 5 days.
  // Quantity: −1 unit at the order's terms = −1000¢.
  // Extension on the billed row: 3 units at 5 days (3000¢) − at 10 days (6000¢) = −3000¢.
  const { lines } = remainingForOrder(O, lightOrder(2, 5), [invoice("a", lightOrder(3, 10))], pairs(5));
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[-1, -1000, -3000]]);
});

Deno.test("quantityAccounting: a void invoice bills nothing", () => {
  const order = lightOrder(5);
  const invoices = [invoice("live", lightOrder(2)), invoice("dead", lightOrder(3), "void")];
  const billed = billedByPath(O, order, invoices);
  assertEquals([billed.byPath.get(lightKey)?.quantity, billed.compared], [2, ["live"]]);
  assertEquals(remainingForOrder(O, order, invoices, pairs()).lines.map((l) => l.quantity), [3]);
});

/** Replace the invoice row at `relKey` with a substitute Y naming it. */
function substituted(inv: AccountedInvoice, relKey: string, uid: string, quantity: number): AccountedInvoice {
  const at = inv.items.findIndex((it) => it.path.join("/") === `${O}/${relKey}`);
  const replaced = inv.items[at];
  const y = {
    ...replaced, uid, name: uid, quantity,
    path: [...replaced.path.slice(0, -1), uid],
    substituted_for: [{ path: replaced.path.slice(1), quantity }],
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
  assertEquals(remainingForOrder(O, order, [inv], pairs()).lines, []);
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
  assertEquals(remainingForOrder(O, kitOrder(), [inv], pairs()).lines, []);
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
  assertEquals(remainingForOrder(O, order, [aligned, unaligned], pairs()), { lines: [], compared: ["a"], unaligned: ["b"], crms_authored: [] });
});

Deno.test("quantityAccounting: accountLine with nothing billed is the whole line", () => {
  // 3 × 1000¢ × 7 ÷ 5 = 4200¢.
  assertEquals(accountLine(line(LIGHT, [D, LIGHT], 3, 1000, 7), undefined, null), {
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
function extensionInvoice(uid: string, quantity: number, addedDays: number, target: string[] = [D], endDays = 7): AccountedInvoice {
  const items = [
    { uid: O, type: "order", name: "Order", description: "", path: [O] },
    { uid: E, type: "destination", name: "Venue", description: "", path: [O, E], path_extension_for: target },
    { uid: G, type: "group", name: "Grip", description: "", path: [O, E, G] },
    line(LIGHT, [O, E, G, LIGHT], quantity, 1000, addedDays),
  ] as unknown as InvoiceItem[];
  // The section's own pair: it charges the added days, ending where the extended window now ends.
  return { uid, status: "draft", items, destinations: [{ ...pairFor(E, addedDays, endFor(endDays)), uid_order: O }] as never };
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
  assertEquals(remainingForOrder(O, order, invoices, pairs(7)).lines, []);
});

Deno.test("quantityAccounting: an extension section short of the order's days leaves the rest", () => {
  // Billed 2 at 3 days, order now 10: owed 2 × 1000 × (10 − 5) ÷ 5 = 2000¢.
  // A section extending by 2 billed 800¢, so 1200¢ remains.
  const { lines } = remainingForOrder(O, lightOrder(2, 10), [invoice("a", lightOrder(2, 3)), extensionInvoice("b", 2, 2)], pairs(10));
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[0, 0, 1200]]);
});

Deno.test("quantityAccounting: an extension naming no order divider is an unaligned scope, and fails closed", () => {
  const invoices = [invoice("a", lightOrder(2, 3)), extensionInvoice("b", 2, 2, ["dest-gone"])];
  const result = remainingForOrder(O, lightOrder(2, 7), invoices, pairs(7));
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

function orderSource(items: LineItem[], days = 5) {
  return { uid: O, number: 1012, items, destinations: pairs(days) };
}

/** A billed invoice whose D pair charged its lines' days, ending `endFor(days)`. */
const billedWithPair = (uid: string, items: LineItem[]): RemainingInvoiceSource => invoice(uid, items, "issued");

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
  const billed = [billedWithPair("a", lightOrder(2, 3))];
  const built = buildRemainingInvoice(orderSource(order, 7), billed, mint);

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
  // The section's pair charges from the day after the billed window ended (Sep 9) to the order's end (Sep 13).
  const pair = built.destinations.find((p) => p.uid === E)!;
  // The order pair's legacy charge fields are not carried onto the section (charge-windows step 5).
  assertEquals(["charge_start", "charge_start_fs", "charge_end", "charge_end_fs", "days_charged"].filter((k) => k in pair.dates), []);
  // ONE window holding the ADDED days, which its lines derive (owner, 2026-09-17).
  assertEquals(pair.dates.charge_windows, [{ start: "2026-09-10T00:00:00.000-05:00", end: "2026-09-13T00:00:00.000-05:00", days: 2 }]);
  assertEquals(remainingForOrder(O, order, [...billed, asInvoice("r", built)], pairs(7)).lines, []);
  // What the API's write guards assert: paths are what the one author computes, and rows are unique.
  assertEquals(validateInvoiceItemPaths(built.items as unknown as InvoiceItem[]), []);
  assertEquals(validateInvoiceItemUniqueness(built.items as unknown as InvoiceItem[]), []);
});

Deno.test("buildRemainingInvoice: a component increase carries its kit at quantity 0, so the component bills its own path", () => {
  // Order: 2 kits of 8 stakes, now 10 stakes. Billed: the kits and 8 stakes.
  const kitOrder = (stakes: number) => [DEST_ITEM, line(KIT, [D, KIT], 2, 5000), line(STAKE, [D, KIT, STAKE], stakes, 100)];
  const order = kitOrder(10);
  const billed = [billedWithPair("a", kitOrder(8))];
  const built = buildRemainingInvoice(orderSource(order), billed, mint);
  assertEquals(
    built.items.filter((it) => it.type === "rental").map((it) => [it.path.join("/"), (it as { quantity: number }).quantity]),
    [[`${O}/${D}/${KIT}`, 0], [`${O}/${D}/${KIT}/${STAKE}`, 2]],
  );
  assertEquals(remainingForOrder(O, order, [...billed, asInvoice("r", built)], pairs()).lines, []);
});

Deno.test("buildRemainingInvoice: units billed at different days extend in one section per billed window", () => {
  // 3 at 5 days on a, 2 at 8 days on b; the order now 10 days.
  // Sections: 3 units at 10 − 5 = 5 added days, 2 units at 10 − 8 = 2.
  const order = lightOrder(5, 10);
  const billed = [
    billedWithPair("a", lightOrder(3, 5)),
    billedWithPair("b", lightOrder(2, 8)),
  ];
  const built = buildRemainingInvoice(orderSource(order, 10), billed, mint);
  const extensions = built.items.filter((it) => it.type === "rental").map((it) => [(it as { quantity: number }).quantity, (it as { price: { chargeable_days: number } }).price.chargeable_days]);
  assertEquals(extensions, [[3, 5], [2, 2]]);
  // a's window ended Sep 11, b's Sep 14.
  assertEquals(built.destinations.slice(1).map((p) => p.dates.charge_windows[0].start), ["2026-09-12T00:00:00.000-05:00", "2026-09-15T00:00:00.000-05:00"]);
  assertEquals(remainingForOrder(O, order, [...billed, asInvoice("r", built)], pairs(10)).lines, []);
});

Deno.test("buildRemainingInvoice: a second extension extends from the days the first one billed", () => {
  // 2 at 3 days, extended to 7 by a first remainder (2 added), then the order
  // goes to 12: the second remainder adds 12 − 7 = 5 days, not 12 − 5 = 7.
  const billed = [billedWithPair("a", lightOrder(2, 3))];
  const first = asInvoice("r1", buildRemainingInvoice(orderSource(lightOrder(2, 7), 7), billed, mint));
  const order = lightOrder(2, 12);
  const second = buildRemainingInvoice(orderSource(order, 12), [...billed, first], mint);
  assertEquals(second.items.filter((it) => it.type === "rental").map((it) => (it as { price: { chargeable_days: number } }).price.chargeable_days), [5]);
  assertEquals(remainingForOrder(O, order, [...billed, first, asInvoice("r2", second)], pairs(12)).lines, []);
});

Deno.test("buildRemainingInvoice: over-billing is returned for a credit note, never netted into the remainder", () => {
  // Billed 3 at 7 days; the order is now 2 at 3 days. Nothing remains to bill.
  const built = buildRemainingInvoice(orderSource(lightOrder(2, 3), 3), [billedWithPair("a", lightOrder(3, 7))], mint);
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


// ── CRMS-authored invoices (owner, 2026-09-16) ──

const crms = (inv: AccountedInvoice, crmsId: number | string = 4711): AccountedInvoice => ({ ...inv, crms_id: crmsId });

Deno.test("quantityAccounting: a live CRMS-authored invoice fails the remainder closed, and names it", () => {
  const order = [...lightOrder(6), line("prod-tripod", [D, "prod-tripod"], 1, 3000)];
  const billedBy = [crms(invoice("a", lightOrder(4), "paid")), invoice("b", lightOrder(1), "issued")];
  assertEquals(remainingForOrder(O, order, billedBy, pairs()), { lines: [], compared: ["a", "b"], unaligned: [], crms_authored: ["a"] });
  const built = buildRemainingInvoice(orderSource(order), billedBy, mint);
  assertEquals([built.items, built.destinations, built.overbilled, built.crms_authored], [[], [], [], ["a"]]);
  // The sum is not a remainder: a diff still reads what CRMS billed.
  assertEquals(billedByPath(O, order, billedBy).byPath.get(lightKey)?.quantity, 5);
});

Deno.test("quantityAccounting: the same order billed natively still has a remainder — the refusal is the crms_id, nothing else", () => {
  const order = [...lightOrder(6), line("prod-tripod", [D, "prod-tripod"], 1, 3000)];
  const native = [invoice("a", lightOrder(4), "paid"), invoice("b", lightOrder(1), "issued")];
  const { lines, crms_authored } = remainingForOrder(O, order, native, pairs());
  assertEquals([lines.map((l) => [l.path.at(-1), l.quantity, l.new]), crms_authored], [[[LIGHT, 1, false], ["prod-tripod", 1, true]], []]);
  assertEquals(buildRemainingInvoice(orderSource(order), native, mint).items.length > 0, true);
});

Deno.test("quantityAccounting: a VOID CRMS invoice, a null crms_id and an empty one do not refuse", () => {
  const order = lightOrder(6);
  const billedBy = [
    crms(invoice("v", lightOrder(6), "void")),
    { ...invoice("a", lightOrder(2), "paid"), crms_id: null },
    crms(invoice("b", lightOrder(2), "issued"), ""),
  ];
  const result = remainingForOrder(O, order, billedBy, pairs());
  assertEquals([result.crms_authored, result.lines.map((l) => l.quantity)], [[], [2]]);
  assertEquals(buildRemainingInvoice(orderSource(order), billedBy, mint).crms_authored, []);
});

Deno.test("quantityAccounting: a string crms_id refuses as a number does", () => {
  assertEquals(crmsAuthoredInvoices([crms(invoice("a", lightOrder(1), "draft"), "1911")]), ["a"]);
});

// ── Windows, not day counts: the 2026-09-16 census shapes (api-cloudrun#680 R1) ──

Deno.test("quantityAccounting: an unmoved window extends nothing, whatever the billed line's days say", () => {
  // Prod #990: the invoice pair and the order pair both end Sep 13 at 7 days, and the
  // billed row is stored at 3 days (a CRMS line with no or hand-held days). The
  // retired line-day rule billed max(7,5) − max(3,5) = 2 days, 800¢, and built a
  // section charging from Sep 14 to Sep 13.
  const invoices = [invoice("a", lightOrder(2, 3), "issued", { days: 7 })];
  assertEquals(remainingForOrder(O, lightOrder(2, 7), invoices, pairs(7)).lines, []);
  const built = buildRemainingInvoice(orderSource(lightOrder(2, 7), 7), invoices, mint);
  assertEquals([built.items, built.overbilled], [[], []]);
});

Deno.test("quantityAccounting: a long rental billed in two parts on the full window extends nothing", () => {
  // Prod #361: two invoices each carry the order's whole 45-day window, their rows
  // billing 35 and 10 days. The retired rule read each as short of 45: +10 and +35 days.
  const invoices = [
    invoice("a", lightOrder(1, 35), "issued", { days: 45 }),
    invoice("b", lightOrder(1, 10), "issued", { days: 45 }),
  ];
  assertEquals(remainingForOrder(O, lightOrder(2, 45), invoices, pairs(45)).lines, []);
});

Deno.test("quantityAccounting: a recounted day total on the same window extends nothing", () => {
  // Prod #310: the same window counted 10 days on the invoice, 11 on the order.
  const invoices = [invoice("a", lightOrder(2, 10), "issued", { days: 10, end: endFor(11) })];
  assertEquals(remainingForOrder(O, lightOrder(2, 11), invoices, pairs(11)).lines, []);
});

Deno.test("quantityAccounting: a later window extends by the PAIRS' days, not the billed line's", () => {
  // Prod #898: the invoice pair charged 5 days ending Sep 11; the order now ends Sep 16
  // at 10 days. The billed row stores 11 days by hand — the pairs decide: +5 days,
  // 2 × 1000 × 5 ÷ 5 = 2000¢ (owner, 2026-09-16: a hand-held row extends on top).
  const invoices = [invoice("a", lightOrder(2, 11), "issued", { days: 5 })];
  assertEquals(remainingForOrder(O, lightOrder(2, 10), invoices, pairs(10)).lines.map((l) => [l.quantity, l.extension_cents]), [[0, 2000]]);
  const built = buildRemainingInvoice(orderSource(lightOrder(2, 10), 10), invoices, mint);
  const section = built.destinations.find((p) => p.uid !== D)!;
  assertEquals([section.dates.charge_windows[0].start, section.dates.charge_windows[0].end, section.dates.charge_windows[0].days], [
    "2026-09-12T00:00:00.000-05:00",
    "2026-09-16T00:00:00.000-05:00",
    5,
  ]);
  assertEquals(section.dates.charge_windows, [{ start: "2026-09-12T00:00:00.000-05:00", end: "2026-09-16T00:00:00.000-05:00", days: 5 }]);
});

Deno.test("quantityAccounting: an earlier window is a shortening, returned for a credit note", () => {
  // Prod #910: billed 18 days ending Sep 24; the order now ends Sep 21 at 15.
  // 2 × 1000 × (15 − 18) ÷ 5 = −1200¢.
  const invoices = [invoice("a", lightOrder(2, 18))];
  assertEquals(remainingForOrder(O, lightOrder(2, 15), invoices, pairs(15)).lines.map((l) => l.extension_cents), [-1200]);
  assertEquals(buildRemainingInvoice(orderSource(lightOrder(2, 15), 15), invoices, mint).overbilled, [
    { path: [D, G, LIGHT], quantity: 2, extension_days: -3 },
  ]);
});

Deno.test("quantityAccounting: a window and a day count that disagree in direction extend nothing", () => {
  // The order ends later but charges no more days (e.g. a weekend added under the week floor).
  const invoices = [invoice("a", lightOrder(2, 7), "issued", { days: 7 })];
  assertEquals(remainingForOrder(O, lightOrder(2, 7), invoices, pairs(7, endFor(9))).lines, []);
});

// ── The window SET, not just its last end (api-cloudrun#1028 phase 1a) ───────
//
// The retired gate asked one question — does the day delta agree with the
// direction the LAST window's end moved? — so it could not see a middle window
// change at all. These fixtures carry three windows so the last end can be held
// fixed while the set underneath it moves.

/** Three 5-day windows with gaps: [day 0–5], [day 7–12], [day 14–19]. */
const W1 = { start: START, end: endFor(5), days: 5 };
const W2 = { start: endFor(7), end: endFor(12), days: 5 };
const W3 = { start: endFor(14), end: endFor(19), days: 5 };

const multiPair = (uid: string, windows: readonly { start: string; end: string; days: number }[]) =>
  ({ uid, dates: { charge_windows: windows } }) as unknown as DocDestinationType;

/** An invoice under order O whose D pair states `windows` verbatim. */
function multiInvoice(uid: string, items: LineItem[], windows: readonly { start: string; end: string; days: number }[]): AccountedInvoice {
  const divider = { uid: O, type: "order", name: "Order", description: "", path: [O] } as unknown as InvoiceItem;
  return {
    uid,
    status: "issued",
    items: [divider, ...(buildOrderScopedItems(items, O) as unknown as InvoiceItem[])],
    destinations: [{ ...multiPair(D, windows), uid_order: O }] as never,
  };
}

Deno.test("quantityAccounting: a DROPPED MIDDLE window is a shortening, though the last end never moved", () => {
  // 🔴 The defect api-cloudrun#1028 phase 1a fixes. The invoice billed all three
  // windows (15 billable days); the order now states W1 and W3 only (10). Both
  // sets END at W3's end, so the retired end-direction gate read direction 0 and
  // reported NOTHING — a $2,000 over-bill with no remedy offered.
  // 2 × 1000 × (10 − 15) ÷ 5 = −2000¢.
  const invoices = [multiInvoice("a", lightOrder(2, 15), [W1, W2, W3])];
  const order = { uid: O, number: 1012, items: lightOrder(2, 10), destinations: [multiPair(D, [W1, W3])] };
  assertEquals(remainingForOrder(O, order.items, invoices, order.destinations).lines.map((l) => l.extension_cents), [-2000]);
  assertEquals(buildRemainingInvoice(order, invoices, mint).overbilled, [
    { path: [D, G, LIGHT], quantity: 2, extension_days: -5 },
  ]);
});

Deno.test("quantityAccounting: a SHRUNK middle window is a shortening, though the last end never moved", () => {
  // W2 shortened from 5 days to 2 (floored to 5 billable), so the DATES move while
  // billableDays does not: 15 → 15. The set gate fires on the dates, the day delta
  // is 0, and a 0 extension is dropped — no phantom credit, no phantom extension.
  const invoices = [multiInvoice("a", lightOrder(2, 15), [W1, W2, W3])];
  const shrunk = { ...W2, end: endFor(9), days: 2 };
  const order = { uid: O, number: 1012, items: lightOrder(2, 15), destinations: [multiPair(D, [W1, shrunk, W3])] };
  assertEquals(remainingForOrder(O, order.items, invoices, order.destinations).lines, []);
});

Deno.test("quantityAccounting: an identical multi-window set extends nothing, whatever the stored days say", () => {
  // The recount guard, across a SET rather than one window: the invoice's pair
  // froze 5/5/5 at write and the order's has been recounted to 6/6/6 against the
  // holiday calendar. Identical dates ⇒ 0, and the day delta of +3 is the artefact.
  const invoices = [multiInvoice("a", lightOrder(2, 15), [W1, W2, W3])];
  const recounted = [{ ...W1, days: 6 }, { ...W2, days: 6 }, { ...W3, days: 6 }];
  const order = { uid: O, number: 1012, items: lightOrder(2, 18), destinations: [multiPair(D, recounted)] };
  assertEquals(remainingForOrder(O, order.items, invoices, order.destinations).lines, []);
  assertEquals(buildRemainingInvoice(order, invoices, mint).overbilled, []);
});

Deno.test("quantityAccounting: an invoice stating its OWN narrower windows credits nothing (owner ruling)", () => {
  // A partial bill (core#112): the invoice states W1 alone while the order states
  // W1+W2+W3. The sets differ, so the gate does not fire — but the delta is
  // POSITIVE (15 − 5 = +10), an extension still owed, never an over-bill.
  // There is deliberately no sub-cover test that would read this as a shortening.
  const invoices = [multiInvoice("a", lightOrder(2, 5), [W1])];
  const order = { uid: O, number: 1012, items: lightOrder(2, 15), destinations: [multiPair(D, [W1, W2, W3])] };
  const { lines } = remainingForOrder(O, order.items, invoices, order.destinations);
  // 2 × 1000 × (15 − 5) ÷ 5 = +4000¢.
  assertEquals(lines.map((l) => l.extension_cents), [4000]);
  assertEquals(buildRemainingInvoice(order, invoices, mint).overbilled, []);
});

Deno.test("quantityAccounting: a window set re-authored at a different TIME OF DAY extends nothing", () => {
  // The gate compares Chicago calendar DATES, not instants: a pair re-saved at
  // 09:00 covers the same days and charges the same.
  const atNine = [W1, W2, W3].map((w) => ({ ...w, start: w.start.replace("T00:", "T09:"), end: w.end.replace("T00:", "T09:") }));
  const invoices = [multiInvoice("a", lightOrder(2, 15), [W1, W2, W3])];
  const order = { uid: O, number: 1012, items: lightOrder(2, 15), destinations: [multiPair(D, atNine)] };
  assertEquals(remainingForOrder(O, order.items, invoices, order.destinations).lines, []);
});

Deno.test("quantityAccounting: a row billed on no known window extends nothing", () => {
  const bare = { ...invoice("a", lightOrder(2, 3)), destinations: undefined };
  assertEquals(remainingForOrder(O, lightOrder(2, 10), [bare], pairs(10)).lines, []);
  assertEquals(accountLine(line(LIGHT, [D, G, LIGHT], 2, 1000, 10), billedByPath(O, lightOrder(2, 10), [invoice("a", lightOrder(2, 3))]).byPath.get(lightKey), null).extension_cents, 0);
});

// ── substituted_for: merges and partial swaps (manager#414, Track S1) ─────────

const TRIPOD = "prod-tripod";
const tripodKey = `${D}/${G}/${TRIPOD}`;

/** Light 2 and Tripod 2 under one group. */
/** An invoice of `items`, then `substituted_for` stamped on the rows it names — the fixture's projection drops unknown keys. */
function stamped(uid: string, items: LineItem[], entries: Record<string, Array<{ path: string[]; quantity: number }>>): AccountedInvoice {
  const inv = invoice(uid, items);
  for (const it of inv.items) {
    const found = entries[it.path.slice(1).join("/")];
    if (found) (it as InvoiceItem).substituted_for = found;
  }
  return inv;
}

const mergeOrder = (tripods = 2): LineItem[] => [
  DEST_ITEM,
  GROUP_ITEM,
  line(LIGHT, [D, G, LIGHT], 2, 1000),
  ...(tripods > 0 ? [line(TRIPOD, [D, G, TRIPOD], tripods, 3000)] : []),
];

Deno.test("quantityAccounting: a MERGE bills both lines — the substitute's own path by the rest, the replaced line by the entry", () => {
  // Both tripods merged into the Light row: 4 = 2 (the order's own Light) + 2 standing in.
  const inv = stamped("a", [DEST_ITEM, GROUP_ITEM, line(LIGHT, [D, G, LIGHT], 4, 1000)], { [lightKey]: [{ path: [D, G, TRIPOD], quantity: 2 }] });
  const billed = billedByPath(O, mergeOrder(), [inv]);
  assertEquals(billed.byPath.get(lightKey)?.quantity, 2);
  assertEquals(billed.byPath.get(lightKey)?.rows.map((r) => [r.via, r.quantity]), [["direct", 2]]);
  assertEquals(billed.byPath.get(tripodKey)?.quantity, 2);
  assertEquals(billed.byPath.get(tripodKey)?.rows.map((r) => [r.via, r.quantity]), [["substitute", 2]]);
  assertEquals(remainingForOrder(O, mergeOrder(), [inv], pairs()).lines, []);
});

Deno.test("quantityAccounting: a merge is SPENT once the order no longer carries X — its units count at the row's own path", () => {
  // The operator removed the tripods from the order (owner ruling, 2026-09-16).
  const inv = stamped("a", [DEST_ITEM, GROUP_ITEM, line(LIGHT, [D, G, LIGHT], 4, 1000)], { [lightKey]: [{ path: [D, G, TRIPOD], quantity: 2 }] });
  const billed = billedByPath(O, mergeOrder(0), [inv]);
  assertEquals(billed.byPath.get(lightKey)?.quantity, 4);
  assertEquals(billed.byPath.has(tripodKey), false);
  // 4 billed of 2 ordered: over-billed by 2.
  assertEquals(remainingForOrder(O, mergeOrder(0), [inv], pairs()).lines.map((l) => l.quantity), [-2]);
});

Deno.test("quantityAccounting: a partial kit swap through substituted_for credits X's components by the ORDER's ratio", () => {
  // Order: 4 kits, 8 stakes (2 per kit). Invoice: 2 kits + 4 stakes billed as themselves,
  // 2 kits swapped for an alternate kit whose 6 pegs all stand in for the kit.
  const ALT = "prod-alt-kit";
  const PEG = "prod-peg";
  const inv = stamped("a", [
    DEST_ITEM,
    line(KIT, [D, KIT], 2, 5000),
    line(STAKE, [D, KIT, STAKE], 4, 0),
    line(ALT, [D, ALT], 2, 5000),
    line(PEG, [D, ALT, PEG], 6, 0),
  ], { [`${D}/${ALT}`]: [{ path: [D, KIT], quantity: 2 }], [`${D}/${ALT}/${PEG}`]: [{ path: [D, KIT], quantity: 6 }] });
  const billed = billedByPath(O, kitOrder(), [inv]);
  // Kit: 2 direct + 2 standing in = 4. Stakes: 4 direct + 2 × 8 ÷ 4 = 4 credited = 8.
  assertEquals([billed.byPath.get(`${D}/${KIT}`)?.quantity, billed.byPath.get(`${D}/${KIT}/${STAKE}`)?.quantity], [4, 8]);
  // The alternate kit and its pegs stand in entirely, so neither bills its own path.
  assertEquals([billed.byPath.has(`${D}/${ALT}`), billed.byPath.has(`${D}/${ALT}/${PEG}`)], [false, false]);
  assertEquals(remainingForOrder(O, kitOrder(), [inv], pairs()).lines, []);
});

Deno.test("quantityAccounting: merging a kit into a kit the order carries bills both kits and both component lines", () => {
  // Order: kit Y 2 (4 C), kit X 1 (2 C2). Invoice: X merged whole into Y.
  const YK = "prod-kit-y", XK = "prod-kit-x", C = "prod-c", C2 = "prod-c2";
  const order = [DEST_ITEM, line(YK, [D, YK], 2, 5000), line(C, [D, YK, C], 4, 0), line(XK, [D, XK], 1, 5000), line(C2, [D, XK, C2], 2, 0)];
  const inv = stamped("a", [DEST_ITEM, line(YK, [D, YK], 3, 5000), line(C, [D, YK, C], 6, 0)], {
    [`${D}/${YK}`]: [{ path: [D, XK], quantity: 1 }],
    [`${D}/${YK}/${C}`]: [{ path: [D, XK], quantity: 2 }],
  });
  const billed = billedByPath(O, order, [inv]);
  // YK: 3 − 1 = 2. C: 6 − 2 = 4. XK: 1 standing in. C2: 1 × 2 ÷ 1 = 2 by ratio.
  assertEquals(
    [`${D}/${YK}`, `${D}/${YK}/${C}`, `${D}/${XK}`, `${D}/${XK}/${C2}`].map((k) => billed.byPath.get(k)?.quantity),
    [2, 4, 1, 2],
  );
  assertEquals(remainingForOrder(O, order, [inv], pairs()).lines, []);
});
