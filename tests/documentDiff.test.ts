/**
 * `computeDocumentDiffs` (manager#467). Every expectation is written out by hand:
 * the fixtures are built from a baseline projection, but no expected entry is
 * computed by the code under test.
 */
import { assertEquals } from "@std/assert";
import type { Fulfillment, Invoice, InvoiceDocItemType, Order } from "../src/schemas/mod.ts";
import { buildOrderScopedItems } from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { computeDocumentDiffs, type DocumentDiffContext, type DocumentDiffMap } from "../src/utils/documentDiff.ts";

const O = "order-1";
const O2 = "order-2";
const D = "dest-1";
const G = "group-1";
const LIGHT = "prod-light";
const TRIPOD = "prod-tripod";

const CONTEXT: DocumentDiffContext = { taxNameByUid: new Map(), isOrderFrozen: () => false };

function line(uid: string, path: string[], quantity: number, baseCents: number, extra: Record<string, unknown> = {}): LineItem {
  return {
    uid, type: "rental", name: uid, description: "", quantity, path,
    stock_method: "reserve", zero_priced: false,
    price: {
      base_cents: baseCents, chargeable_days: 5, formula: "five_day_week",
      subtotal_cents: baseCents * quantity, subtotal_discounted_cents: baseCents * quantity,
      discount: null, taxes: [], total_cents: baseCents * quantity, replacement_cents: 1000,
    },
    ...extra,
  } as unknown as LineItem;
}

const DEST_ITEM = { uid: D, type: "destination", name: "Venue", description: "", path: [D] } as unknown as LineItem;
const GROUP_ITEM = { uid: G, type: "group", name: "Grip", description: "", path: [D, G] } as unknown as LineItem;

const PAIR = {
  uid: D,
  dates: { delivery_start: "2026-09-01T09:00:00.000-05:00", collection_end: "2026-09-05T17:00:00.000-05:00" },
  jurisdiction: "chicago",
};

function orderItems(): LineItem[] {
  return [
    DEST_ITEM,
    GROUP_ITEM,
    line(LIGHT, [D, G, LIGHT], 2, 1000),
    line(TRIPOD, [D, G, TRIPOD], 1, 3000),
    // The same product at a second path.
    line(LIGHT, [D, LIGHT], 4, 1000),
  ];
}

function order(items: LineItem[] = orderItems(), uid = O): Order {
  return { uid, number: 1001, version: 7, status: "reserved", items, destinations: [structuredClone(PAIR)] } as unknown as Order;
}

/** The fulfillment projection of an order: same paths, no price. */
function fulfillment(items: LineItem[] = orderItems(), uid = O): Fulfillment {
  const rows = items
    .filter((it) => it.type !== "transaction_fee")
    .map((it) => {
      if (it.type === "destination" || it.type === "group") return it;
      const { price: _price, ...rest } = it as unknown as Record<string, unknown>;
      return rest;
    });
  return { uid, number: 1001, version: 3, items: rows, destinations: [structuredClone(PAIR)] } as unknown as Fulfillment;
}

/** An invoice scoped to one or more orders, each scope the exact projection of its order's items. */
function invoice(uid: string, scopes: Array<{ order: string; items: LineItem[] }>, number = 2241): Invoice {
  const items: InvoiceDocItemType[] = [];
  const destinations = [];
  for (const s of scopes) {
    items.push({ uid: s.order, type: "order", name: `Order ${s.order}`, description: "", path: [s.order] } as unknown as InvoiceDocItemType);
    items.push(...buildOrderScopedItems(s.items, s.order));
    destinations.push({ ...structuredClone(PAIR), uid_order: s.order });
  }
  return { uid, number, version: 1, status: "draft", items, destinations } as unknown as Invoice;
}

/** A readable projection of the map: `key → [source kind:kind:fields]`. */
function summary(map: DocumentDiffMap["lines"] | DocumentDiffMap["pairs"]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, entries] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = entries.map((e) =>
      e.kind === "uninvoiced"
        ? `uninvoiced[${e.invoices.map((i) => `#${i.number}`).join(",")}]`
        : `${e.source.kind}#${e.source.number}:${e.kind}` +
          (e.fields.length ? `(${e.fields.map((f) => `${f.field}=${JSON.stringify(f.here)}→${JSON.stringify(f.there)}`).join(",")})` : "")
    );
  }
  return out;
}

function patchLine(items: InvoiceDocItemType[] | LineItem[], pathKey: string, patch: (it: Record<string, unknown>) => void): void {
  const target = (items as Array<{ path: string[] }>).find((it) => it.path.join("/") === pathKey);
  if (!target) throw new Error(`no line at ${pathKey}`);
  patch(target as unknown as Record<string, unknown>);
}

Deno.test("documentDiff: three documents in step produce no entries from any view", () => {
  const sources = { orders: [order()], fulfillments: [fulfillment()], invoices: [invoice("inv-1", [{ order: O, items: orderItems() }])] };
  for (const viewing of [{ kind: "order", uid: O }, { kind: "fulfillment", uid: O }, { kind: "invoice", uid: "inv-1" }] as const) {
    const diff = computeDocumentDiffs(sources, viewing, CONTEXT);
    assertEquals([diff.lines.size, diff.pairs.size, diff.unaligned.length], [0, 0, 0], viewing.kind);
  }
});

Deno.test("documentDiff: a picker quantity override shows on the order view and the fulfillment view, keyed by path", () => {
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${G}/${LIGHT}`, (it) => { it.quantity = 1; it.quantity_order = 2; });
  const sources = { orders: [order()], fulfillments: [f] };

  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["fulfillment#1001:differs(quantity=2→1)"],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["order#1001:differs(quantity=1→2)"],
  });
});

Deno.test("documentDiff: the key is the path — the same product at a second, unchanged path gets no entry", () => {
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.quantity = 9; });
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(Object.keys(summary(diff.lines)), [`${D}/${LIGHT}`]);
});

Deno.test("documentDiff: order ↔ invoice compares money and quantity, never labels or taxes_base", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  patchLine(inv.items, `${O}/${D}/${G}/${TRIPOD}`, (it) => {
    it.name = "Renamed tripod";
    it.description = "moved in the catalog";
    const price = it.price as Record<string, unknown>;
    price.subtotal_cents = 2500;
    price.subtotal_discounted_cents = 2500;
    price.total_cents = 2500;
  });
  patchLine(inv.items, `${O}/${D}/${LIGHT}`, (it) => {
    it.name = "Label-only change";
    (it.price as Record<string, unknown>).taxes_base = [];
  });
  const sources = { orders: [order()], invoices: [inv] };

  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${TRIPOD}`]: [
      "invoice#2241:differs(price.subtotal_cents=3000→2500,price.subtotal_discounted_cents=3000→2500,price.total_cents=3000→2500)",
    ],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), {
    [`${O}/${D}/${G}/${TRIPOD}`]: [
      "order#1001:differs(price.subtotal_cents=2500→3000,price.subtotal_discounted_cents=2500→3000,price.total_cents=2500→3000)",
    ],
  });
});

Deno.test("documentDiff: a line no invoice carries is ONE uninvoiced entry on all three views", () => {
  const partial = orderItems().filter((it) => it.uid !== TRIPOD);
  const sources = { orders: [order()], fulfillments: [fulfillment()], invoices: [invoice("inv-1", [{ order: O, items: partial }])] };

  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${TRIPOD}`]: ["uninvoiced[#2241]"],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${TRIPOD}`]: ["uninvoiced[#2241]"],
  });
  // The order and the fulfillment both lack it on the invoice: one entry, not one per source.
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), {
    [`${O}/${D}/${G}/${TRIPOD}`]: ["uninvoiced[#2241]"],
  });
});

Deno.test("documentDiff: an order billed across two invoices has no presence entries on any view", () => {
  // Invoice A bills the grip Light; invoice B bills the Tripod and the second Light.
  const a = invoice("inv-a", [{ order: O, items: orderItems().filter((it) => it.path.join("/") !== `${D}/${G}/${TRIPOD}` && it.path.join("/") !== `${D}/${LIGHT}`) }], 2241);
  const b = invoice("inv-b", [{ order: O, items: orderItems().filter((it) => it.path.join("/") !== `${D}/${G}/${LIGHT}`) }], 2250);
  const sources = { orders: [order()], fulfillments: [fulfillment()], invoices: [a, b] };

  for (const viewing of [{ kind: "order", uid: O }, { kind: "fulfillment", uid: O }, { kind: "invoice", uid: "inv-a" }, { kind: "invoice", uid: "inv-b" }] as const) {
    assertEquals(summary(computeDocumentDiffs(sources, viewing, CONTEXT).lines), {}, `${viewing.kind} ${viewing.uid}`);
  }

  // Without the sibling passed, invoice A cannot know B bills the Tripod — so it says so.
  assertEquals(
    summary(computeDocumentDiffs({ orders: [order()], invoices: [a] }, { kind: "invoice", uid: "inv-a" }, CONTEXT).lines),
    { [`${O}/${D}/${G}/${TRIPOD}`]: ["uninvoiced[#2241]"], [`${O}/${D}/${LIGHT}`]: ["uninvoiced[#2241]"] },
  );
});

Deno.test("documentDiff: an order with no invoices is not flagged line by line", () => {
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [fulfillment()], invoices: [] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(diff.lines.size, 0);
});

Deno.test("documentDiff: a picker add and an invoice add of the same product are two separate lines, never a match", () => {
  const f = fulfillment();
  (f.items as unknown as LineItem[]).push({ uid: TRIPOD, type: "rental", name: TRIPOD, description: "", quantity: 1, path: [D, TRIPOD] } as unknown as LineItem);
  const inv = invoice("inv-1", [{ order: O, items: [...orderItems(), line(`${TRIPOD}-extra`, [D, `${TRIPOD}-extra`], 1, 3000)] }]);
  // The invoice add sits at a different path from the picker add.
  const invAddKey = `${D}/${TRIPOD}-extra`;
  const sources = { orders: [order()], fulfillments: [f], invoices: [inv] };

  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [invAddKey]: ["invoice#2241:missing_here"],
    [`${D}/${TRIPOD}`]: ["order#1001:only_here", "uninvoiced[#2241]"],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), {
    [`${O}/${invAddKey}`]: ["order#1001:only_here", "fulfillment#1001:only_here"],
    [`${O}/${D}/${TRIPOD}`]: ["uninvoiced[#2241]"],
  });
});

Deno.test("documentDiff: every invoice on an order is its own source, and each is numbered", () => {
  const a = invoice("inv-a", [{ order: O, items: orderItems() }], 2241);
  const b = invoice("inv-b", [{ order: O, items: orderItems() }], 2250);
  for (const inv of [a, b]) patchLine(inv.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { it.quantity = 5; });
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [a, b] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines)[`${D}/${G}/${LIGHT}`], [
    "invoice#2241:differs(quantity=2→5)",
    "invoice#2250:differs(quantity=2→5)",
  ]);
});

Deno.test("documentDiff: a multi-order invoice compares only the scopes whose order was passed", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }, { order: O2, items: orderItems() }]);
  patchLine(inv.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { it.quantity = 5; });
  patchLine(inv.items, `${O2}/${D}/${G}/${LIGHT}`, (it) => { it.quantity = 6; });
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${O}/${D}/${G}/${LIGHT}`]: ["order#1001:differs(quantity=5→2)"] });
});

Deno.test("documentDiff: a misaligned invoice scope is one unaligned entry, never a row per line", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  (inv.items as unknown as LineItem[]).splice(2, 1); // drop the invoice's group divider
  const diffFromOrder = computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals([diffFromOrder.lines.size, diffFromOrder.unaligned.map((u) => `${u.scope}:${u.source.kind}`)], [0, [`${O}:invoice`]]);

  const diffFromInvoice = computeDocumentDiffs(
    { orders: [order()], fulfillments: [fulfillment()], invoices: [inv] },
    { kind: "invoice", uid: "inv-1" },
    CONTEXT,
  );
  assertEquals(
    [diffFromInvoice.lines.size, diffFromInvoice.unaligned.map((u) => `${u.scope}:${u.source.kind}`)],
    [0, [`${O}:order`, `${O}:fulfillment`]],
  );
});

Deno.test("documentDiff: an absent source yields nothing — not an in-sync answer, just no entries", () => {
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${G}/${LIGHT}`, (it) => { it.quantity = 1; });
  // Viewing the order without its fulfillment passed: no read happened, so no claim is made.
  const diff = computeDocumentDiffs({ orders: [order()] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals([diff.lines.size, diff.pairs.size, diff.unaligned.length], [0, 0, 0]);
  // And a viewed document that was not passed yields an empty map rather than throwing.
  assertEquals(computeDocumentDiffs({ fulfillments: [f] }, { kind: "order", uid: O }, CONTEXT).lines.size, 0);
});

Deno.test("documentDiff: a jurisdiction override is a pair_field entry under the destination divider", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  (inv.destinations[0] as unknown as Record<string, unknown>).jurisdiction = "illinois";
  const sources = { orders: [order()], invoices: [inv] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).pairs), {
    [D]: ['invoice#2241:pair_field(jurisdiction="chicago"→"illinois")'],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).pairs), {
    [`${O}/${D}`]: ['order#1001:pair_field(jurisdiction="illinois"→"chicago")'],
  });
});

Deno.test("documentDiff: pairs compare every payload field — an address correction is a pair_field entry", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  (inv.destinations[0] as unknown as Record<string, unknown>).delivery = { address: { full: "3100 W Fillmore St" } };
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  // `uid_order` sits on the invoice pair only and is identity, not payload: no entry for it.
  assertEquals(summary(diff.pairs), {
    [D]: ['invoice#2241:pair_field(delivery=null→{"address":{"full":"3100 W Fillmore St"}})'],
  });
});

Deno.test("documentDiff: jurisdiction is never compared against a fulfillment, only between order and invoice", () => {
  const f = fulfillment();
  (f.destinations[0] as unknown as Record<string, unknown>).jurisdiction = "illinois";
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  (inv.destinations[0] as unknown as Record<string, unknown>).jurisdiction = "illinois";
  const sources = { orders: [order()], fulfillments: [f], invoices: [inv] };
  // Order view: the invoice's jurisdiction differs and shows; the fulfillment's does not.
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).pairs), {
    [D]: ['invoice#2241:pair_field(jurisdiction="chicago"→"illinois")'],
  });
  assertEquals(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).pairs.size, 0);
  // A non-tax pair field still compares against a fulfillment.
  (f.destinations[0] as unknown as Record<string, unknown>).delivery = { address: { full: "elsewhere" } };
  assertEquals(Object.keys(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).pairs)), [D]);
});

Deno.test("documentDiff: a substituted-away line is explained by its substitute, not reported missing", () => {
  const f = fulfillment();
  const rows = f.items as unknown as LineItem[];
  const at = rows.findIndex((it) => it.path.join("/") === `${D}/${G}/${TRIPOD}`);
  rows.splice(at, 1, {
    uid: "prod-monopod", type: "rental", name: "Monopod", description: "", quantity: 1,
    path: [D, G, "prod-monopod"], path_substituted_for: [D, G, TRIPOD],
  } as unknown as LineItem);
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "fulfillment", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/prod-monopod`]: ["order#1001:only_here"] });
});

Deno.test("documentDiff: a transaction fee is compared order ↔ invoice but never against a fulfillment", () => {
  const fee = { ...line("fee-1", [D, "fee-1"], 1, 500), type: "transaction_fee" } as unknown as LineItem;
  const items = [...orderItems(), fee];
  const inv = invoice("inv-1", [{ order: O, items }]);
  patchLine(inv.items, `${O}/${D}/fee-1`, (it) => { (it.price as Record<string, unknown>).total_cents = 999; });
  const diff = computeDocumentDiffs(
    { orders: [order(items)], fulfillments: [fulfillment(items)], invoices: [inv] },
    { kind: "invoice", uid: "inv-1" },
    CONTEXT,
  );
  assertEquals(summary(diff.lines), { [`${O}/${D}/fee-1`]: ["order#1001:differs(price.total_cents=999→500)"] });
});
