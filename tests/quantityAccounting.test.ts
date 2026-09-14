/**
 * `billedByPath` / `accountLine` / `remainingForOrder` (api-cloudrun#680).
 * Every expected number is worked out by hand in the comment beside it; none is
 * produced by the code under test.
 */
import { assertEquals } from "@std/assert";
import { buildOrderScopedItems, computeOrderInvoiceCoverage, type InvoiceItem } from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type AccountedInvoice, accountLine, billedByPath, remainingForOrder } from "../src/utils/quantityAccounting.ts";

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

Deno.test("quantityAccounting: a date extension is priced at both day counts, never as the extra days alone", () => {
  // Billed 2 at 3 days: five_day_week floors at a week → 2 × 1000 = 2000¢.
  // The order now charges 7 days → 2 × 1000 × 7 ÷ 5 = 2800¢. Remainder 800¢.
  // Pricing "the extra 4 days" as a line would floor to a week: 2000¢. Wrong.
  const { lines } = remainingForOrder(O, lightOrder(2, 7), [invoice("a", lightOrder(2, 3))]);
  assertEquals(lines.map((l) => [l.quantity, l.quantity_cents, l.extension_cents]), [[0, 0, 800]]);
});

Deno.test("quantityAccounting: an extension across a split bill prices each billed row on its own days", () => {
  // Order: 5 at 10 days. Row a: 3 at 5 days → 3000¢, at 10 days → 6000¢ (+3000).
  // Row b: 2 at 8 days → 2 × 1000 × 8 ÷ 5 = 3200¢, at 10 days → 4000¢ (+800). Total 3800¢.
  const { lines } = remainingForOrder(O, lightOrder(5, 10), [invoice("a", lightOrder(3, 5)), invoice("b", lightOrder(2, 8))]);
  assertEquals(lines.map((l) => [l.billed, l.quantity, l.extension_cents]), [[5, 0, 3800]]);
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
