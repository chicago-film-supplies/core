/**
 * `computeDocumentDiffs` (manager#467). Every expectation is written out by hand:
 * the fixtures are built from a baseline projection, but no expected entry is
 * computed by the code under test.
 */
import { assertEquals } from "@std/assert";
import type { Fulfillment, Invoice, InvoiceDocItemType, Order } from "../src/schemas/mod.ts";
import { buildOrderScopedItems } from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import {
  computeDocumentDiffs,
  type DocumentDiffContext,
  type DocumentDiffCreditNote,
  type DocumentDiffKind,
  type DocumentDiffMap,
  type DocumentDiffOutOfService,
} from "../src/utils/documentDiff.ts";

const O = "order-1";
const O2 = "order-2";
// Dividers are bare UUIDs, as stored: a booking's component signature reads
// every NON-uuid path segment as a product, so a readable divider uid would
// read as a kit and change every booking id the out-of-service tests file by.
const D = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a01";
const G = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a02";
const LIGHT = "prod-light";
const TRIPOD = "prod-tripod";

const CONTEXT: DocumentDiffContext = { taxNameByUid: new Map(), isOrderFrozen: () => false };

function line(uid: string, path: string[], quantity: number, baseCents: number, extra: Record<string, unknown> = {}): LineItem {
  return {
    uid, type: "rental", name: uid, description: "", quantity, path,
    stock_method: "reserve", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
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
      e.kind === "quantity"
        ? `qty[${e.invoices.map((i) => `#${i.number}`).join(",")}](o${e.ordered ?? "-"} f${e.fulfilled ?? "-"} i${e.invoiced}` +
          (e.quantity_cents === null ? "" : `,q${e.quantity_cents},x${e.extension_cents}`) +
          (e.fulfilled_quantity_cents === null ? "" : `,fq${e.fulfilled_quantity_cents}`) +
          (e.uid_out_of_service === null ? "" : `,oos:${e.uid_out_of_service}`) + ")"
        : e.kind === "substituted"
        ? `${e.source.kind}#${e.source.number}:substituted(${e.replaced}→${e.substitute})`
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
  patchLine(f.items as unknown as LineItem[], `${D}/${G}/${LIGHT}`, (it) => { it.quantity = 1; it.quantity_ordered = 2; });
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

Deno.test("documentDiff: order ↔ invoice compares every shared field, and NO derived money", () => {
  // 🔴 **This assertion is the inverse of the one it replaced, by owner ruling
  // (2026-09-16).** The old contract was "money and quantity only, never
  // labels": comparing `name`/`description` put rows on hundreds of settled
  // invoices whose catalog names moved after invoicing, so the compared set was
  // a hand-maintained list. That list could disagree with the SYNC about what
  // counts as an override, and a field absent from it was invisible to every
  // diff view with nothing saying so.
  //
  // The diff now walks the same key intersection the sync merges, so a new
  // shared field is compared by construction. The cost is accepted: label rows
  // return.
  //
  // ⭐ **And the exchange is not one-for-one — DERIVED money stopped being
  // compared at all.** An invoice is repriced in its own tax context, so its
  // subtotal/total/taxes can differ from the order's with no operator edit; that
  // was G2, the false override this campaign exists to delete. A real change
  // reports through its CAUSE (a declared input, or a discount/tax whose terms
  // moved), never through its arithmetic.
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  patchLine(inv.items, `${O}/${D}/${G}/${TRIPOD}`, (it) => {
    it.name = "Renamed tripod";
    it.description = "moved in the catalog";
    // Derived-only: the declared inputs are untouched, so this is the invoice's
    // own pricing context and must produce no row.
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
      'invoice#2241:differs(description=""→"moved in the catalog",name="prod-tripod"→"Renamed tripod")',
    ],
    [`${D}/${LIGHT}`]: [
      'invoice#2241:differs(name="prod-light"→"Label-only change")',
    ],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), {
    [`${O}/${D}/${G}/${TRIPOD}`]: [
      'order#1001:differs(description="moved in the catalog"→"",name="Renamed tripod"→"prod-tripod")',
    ],
    [`${O}/${D}/${LIGHT}`]: [
      'order#1001:differs(name="Label-only change"→"prod-light")',
    ],
  });
});

Deno.test("documentDiff: derived money alone NEVER produces a row, split or no split — G2", () => {
  // The anti-vacuity companion to the test above: prove the suppression is
  // doing the work, by moving ONLY derived money and expecting silence, then
  // moving a DECLARED input on the same line and expecting exactly that.
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  patchLine(inv.items, `${O}/${D}/${LIGHT}`, (it) => {
    const price = it.price as Record<string, unknown>;
    price.subtotal_cents = 111;
    price.subtotal_discounted_cents = 111;
    price.total_cents = 111;
  });
  assertEquals(
    summary(computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT).lines),
    {},
    "derived money moved on its own — the invoice's own tax context, not an override",
  );

  const declared = invoice("inv-1", [{ order: O, items: orderItems() }]);
  patchLine(declared.items, `${O}/${D}/${LIGHT}`, (it) => {
    (it.price as Record<string, unknown>).base_cents = 111;
  });
  assertEquals(
    summary(computeDocumentDiffs({ orders: [order()], invoices: [declared] }, { kind: "order", uid: O }, CONTEXT).lines),
    { [`${D}/${LIGHT}`]: ["invoice#2241:differs(price.base_cents=1000→111)"] },
    "a DECLARED input still reports — the suppression is not swallowing real edits",
  );
});

Deno.test("documentDiff: a line no invoice carries is ONE quantity entry, invoiced 0, on all three views", () => {
  const partial = orderItems().filter((it) => it.uid !== TRIPOD);
  const sources = { orders: [order()], fulfillments: [fulfillment()], invoices: [invoice("inv-1", [{ order: O, items: partial }])] };

  const entry = ["qty[#2241](o1 f1 i0,q3000,x0,fq3000)"];
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), { [`${D}/${G}/${TRIPOD}`]: entry });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), { [`${D}/${G}/${TRIPOD}`]: entry });
  // The order and the fulfillment both lack it on the invoice: one entry, not one per source.
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), { [`${O}/${D}/${G}/${TRIPOD}`]: entry });
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
    { [`${O}/${D}/${G}/${TRIPOD}`]: ["qty[#2241](o1 f- i0,q3000,x0)"], [`${O}/${D}/${LIGHT}`]: ["qty[#2241](o4 f- i0,q4000,x0)"] },
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
    [invAddKey]: ["invoice#2241:only_on_source"],
    // A row only the fulfillment carries: no order line, so no money on the entry.
    [`${D}/${TRIPOD}`]: ["order#1001:not_on_source", "qty[#2241](o- f1 i0)"],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), {
    [`${O}/${invAddKey}`]: ["order#1001:not_on_source", "fulfillment#1001:not_on_source"],
    [`${O}/${D}/${TRIPOD}`]: ["qty[#2241](o- f1 i0)"],
  });
});

Deno.test("documentDiff: quantity against invoices is ONE quantity entry over the sum, never a differs per invoice", () => {
  // A bills the whole order; B bills the grip Light again. Both say 5 of it.
  const a = invoice("inv-a", [{ order: O, items: orderItems() }], 2241);
  const b = invoice("inv-b", [{ order: O, items: orderItems().filter((it) => it.path.join("/") !== `${D}/${G}/${TRIPOD}` && it.path.join("/") !== `${D}/${LIGHT}`) }], 2250);
  for (const inv of [a, b]) patchLine(inv.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { it.quantity = 5; });
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [a, b] }, { kind: "order", uid: O }, CONTEXT);
  // 5 + 5 billed against 2 ordered: 8 units over, at 1000¢ each.
  assertEquals(summary(diff.lines)[`${D}/${G}/${LIGHT}`], ["qty[#2241,#2250](o2 f- i10,q-8000,x0)"]);
  // The two invoices that each bill the right quantity report nothing.
  assertEquals(Object.keys(summary(diff.lines)), [`${D}/${G}/${LIGHT}`]);
});

Deno.test("documentDiff: a multi-order invoice compares only the scopes whose order was passed", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }, { order: O2, items: orderItems() }]);
  patchLine(inv.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { it.quantity = 5; });
  patchLine(inv.items, `${O2}/${D}/${G}/${LIGHT}`, (it) => { it.quantity = 6; });
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${O}/${D}/${G}/${LIGHT}`]: ["qty[#2241](o2 f- i5,q-3000,x0)"] });
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

const MONOPOD = "prod-monopod";

/** Replace the line at `pathKey` with a substitute `uid` at the same parent, as a picker or invoice does. */
function substitute<T extends { path: string[] }>(rows: T[], pathKey: string, uid: string, prefix: string[] = []): void {
  const at = rows.findIndex((it) => it.path.join("/") === pathKey);
  if (at < 0) throw new Error(`no line at ${pathKey}`);
  const replacedPath = rows[at].path.slice(prefix.length);
  rows.splice(at, 1, {
    uid, type: "rental", name: "Monopod", description: "", quantity: 1,
    path: [...rows[at].path.slice(0, -1), uid],
    substituted_for: [{ path: replacedPath, quantity: 1 }],
  } as unknown as T);
}

Deno.test("documentDiff: a fulfillment substitution is ONE entry at the substitute on the fulfillment view", () => {
  const f = fulfillment();
  substitute(f.items as unknown as LineItem[], `${D}/${G}/${TRIPOD}`, MONOPOD);
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "fulfillment", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${MONOPOD}`]: [`order#1001:substituted(${D}/${G}/${TRIPOD}→${D}/${G}/${MONOPOD})`] });
});

Deno.test("documentDiff: a fulfillment substitution is ONE entry at the replaced line on the order view — no presence entries", () => {
  const f = fulfillment();
  substitute(f.items as unknown as LineItem[], `${D}/${G}/${TRIPOD}`, MONOPOD);
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${TRIPOD}`]: [`fulfillment#1001:substituted(${D}/${G}/${TRIPOD}→${D}/${G}/${MONOPOD})`] });
});

Deno.test("documentDiff: substituting a KIT explains the replaced kit's components and the substitute's components too", () => {
  const KIT = "prod-kit";
  const items = [...orderItems(), line(KIT, [D, KIT], 1, 5000), line("comp-a", [D, KIT, "comp-a"], 2, 0)];
  const f = fulfillment(items);
  const rows = f.items as unknown as LineItem[];
  const at = rows.findIndex((it) => it.path.join("/") === `${D}/${KIT}`);
  // Y replaces the kit and its component; Y carries a component of its own.
  rows.splice(at, 2,
    { uid: "prod-alt", type: "rental", name: "Alt", description: "", quantity: 1, path: [D, "prod-alt"], substituted_for: [{ path: [D, KIT], quantity: 1 }] } as unknown as LineItem,
    { uid: "comp-b", type: "rental", name: "B", description: "", quantity: 1, path: [D, "prod-alt", "comp-b"], substituted_for: [{ path: [D, KIT], quantity: 1 }] } as unknown as LineItem,
  );
  const sources = { orders: [order(items)], fulfillments: [f] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${KIT}`]: [`fulfillment#1001:substituted(${D}/${KIT}→${D}/prod-alt)`],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/prod-alt`]: [`order#1001:substituted(${D}/${KIT}→${D}/prod-alt)`],
  });
});

Deno.test("documentDiff: an invoice substitution covers the replaced line — substituted, never invoiced 0 — from the order view", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  substitute(inv.items, `${O}/${D}/${G}/${TRIPOD}`, MONOPOD, [O]);
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${TRIPOD}`]: [`invoice#2241:substituted(${D}/${G}/${TRIPOD}→${D}/${G}/${MONOPOD})`] });
});

Deno.test("documentDiff: on the invoice view a substitute is keyed in the invoice's own path space", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  substitute(inv.items, `${O}/${D}/${G}/${TRIPOD}`, MONOPOD, [O]);
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [fulfillment()], invoices: [inv] }, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  const entry = `${O}/${D}/${G}/${TRIPOD}→${O}/${D}/${G}/${MONOPOD}`;
  assertEquals(summary(diff.lines), { [`${O}/${D}/${G}/${MONOPOD}`]: [`order#1001:substituted(${entry})`, `fulfillment#1001:substituted(${entry})`] });
});

Deno.test("documentDiff: a sibling invoice's substitution covers the line for every other invoice", () => {
  // inv-1 bills only the Tripod, as a Monopod; inv-2 bills everything else.
  const billed = invoice("inv-1", [{ order: O, items: orderItems().filter((it) => it.path.join("/") === D || it.path.join("/") === `${D}/${G}` || it.uid === TRIPOD) }]);
  substitute(billed.items, `${O}/${D}/${G}/${TRIPOD}`, MONOPOD, [O]);
  const sibling = invoice("inv-2", [{ order: O, items: orderItems().filter((it) => it.uid !== TRIPOD) }], 2242);
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [billed, sibling] }, { kind: "invoice", uid: "inv-2" }, CONTEXT);
  assertEquals(summary(diff.lines), {});
});

Deno.test("documentDiff: a substitute whose replaced line the other side does NOT carry is an ordinary presence difference", () => {
  const f = fulfillment();
  const rows = f.items as unknown as LineItem[];
  rows.push({ uid: MONOPOD, type: "rental", name: "Monopod", description: "", quantity: 1, path: [D, MONOPOD], substituted_for: [{ path: [D, "gone"], quantity: 1 }] } as unknown as LineItem);
  const sources = { orders: [order()], fulfillments: [f] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), { [`${D}/${MONOPOD}`]: ["order#1001:not_on_source"] });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), { [`${D}/${MONOPOD}`]: ["fulfillment#1001:only_on_source"] });
});

/** `status` as `issue:kind#number` strings. */
function statusSummary(map: DocumentDiffMap): string[] {
  return map.status.map((s) => `${s.issue}:${s.source.kind}#${s.source.number}`);
}

const voided = (inv: Invoice): Invoice => ({ ...inv, status: "void" }) as Invoice;
const canceled = (o: Order): Order => ({ ...o, status: "canceled" }) as Order;

Deno.test("documentDiff: a void invoice covers nothing — the line only it billed reads invoiced 0 against the live invoice", () => {
  const live = invoice("inv-live", [{ order: O, items: orderItems().filter((it) => it.uid !== TRIPOD) }], 2242);
  const dead = voided(invoice("inv-void", [{ order: O, items: orderItems() }], 2241));
  // The void invoice differs on money too; none of that may show.
  patchLine(dead.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { (it.price as Record<string, unknown>).total_cents = 1; });
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [live, dead] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${TRIPOD}`]: ["qty[#2242](o1 f- i0,q3000,x0)"] });
  assertEquals([diff.unaligned.length, diff.status.length], [0, 0]);
});

Deno.test("documentDiff: an order whose only invoice is void is treated as not yet invoiced — no line entries", () => {
  const diff = computeDocumentDiffs(
    { orders: [order()], invoices: [voided(invoice("inv-void", [{ order: O, items: orderItems().slice(0, 3) }]))] },
    { kind: "order", uid: O },
    CONTEXT,
  );
  assertEquals([diff.lines.size, diff.pairs.size, diff.unaligned.length, diff.status.length], [0, 0, 0, 0]);
});

Deno.test("documentDiff: viewing a void invoice compares nothing", () => {
  const dead = voided(invoice("inv-void", [{ order: O, items: orderItems().slice(0, 3) }]));
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [fulfillment()], invoices: [dead] }, { kind: "invoice", uid: "inv-void" }, CONTEXT);
  assertEquals([diff.lines.size, diff.pairs.size, diff.unaligned.length, diff.status.length], [0, 0, 0, 0]);
});

Deno.test("documentDiff: a live invoice on a canceled order is ONE status entry from every view, and no line entries", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems().slice(0, 3) }]);
  patchLine(inv.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { (it.price as Record<string, unknown>).total_cents = 1; });
  const sources = { orders: [canceled(order())], fulfillments: [fulfillment()], invoices: [inv] };

  const onOrder = computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT);
  assertEquals(statusSummary(onOrder), ["live_invoice_on_canceled_order:invoice#2241"]);
  assertEquals(summary(onOrder.lines), {});

  const onFulfillment = computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT);
  assertEquals(statusSummary(onFulfillment), ["live_invoice_on_canceled_order:invoice#2241"]);
  assertEquals(summary(onFulfillment.lines), {});

  const onInvoice = computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals(statusSummary(onInvoice), ["live_invoice_on_canceled_order:order#1001"]);
  assertEquals([onInvoice.lines.size, onInvoice.pairs.size, onInvoice.unaligned.length], [0, 0, 0]);
});

Deno.test("documentDiff: a canceled order with only a void invoice is consistent — nothing from any view", () => {
  const sources = { orders: [canceled(order())], fulfillments: [fulfillment()], invoices: [voided(invoice("inv-void", [{ order: O, items: orderItems() }]))] };
  for (const viewing of [{ kind: "order", uid: O }, { kind: "fulfillment", uid: O }] as const) {
    const diff = computeDocumentDiffs(sources, viewing, CONTEXT);
    assertEquals([diff.lines.size, diff.pairs.size, diff.unaligned.length, diff.status.length], [0, 0, 0, 0], viewing.kind);
  }
});

Deno.test("documentDiff: a transaction fee is compared order ↔ invoice but never against a fulfillment", () => {
  const fee = { ...line("fee-1", [D, "fee-1"], 1, 500), type: "transaction_fee" } as unknown as LineItem;
  const items = [...orderItems(), fee];
  const inv = invoice("inv-1", [{ order: O, items }]);
  // ⚠️ A DECLARED input, not `total_cents`. A fee's derived money legitimately
  // differs between an order and an invoice billing part of it, and derived
  // money no longer produces a row at all — so mutating it would make this test
  // pass vacuously against the very suppression it is not about.
  patchLine(inv.items, `${O}/${D}/fee-1`, (it) => { (it.price as Record<string, unknown>).base_cents = 999; });
  const diff = computeDocumentDiffs(
    { orders: [order(items)], fulfillments: [fulfillment(items)], invoices: [inv] },
    { kind: "invoice", uid: "inv-1" },
    CONTEXT,
  );
  assertEquals(summary(diff.lines), { [`${O}/${D}/fee-1`]: ["order#1001:differs(price.base_cents=999→500)"] });
});

/** One order line, and the invoices that bill it, for the sum tests. */
function billedOrder(quantity: number, days = 5): Order {
  return order([DEST_ITEM, GROUP_ITEM, withDays(line(LIGHT, [D, G, LIGHT], quantity, 1000), days)]);
}
function withDays(item: LineItem, days: number): LineItem {
  const price = { ...(item.price as unknown as Record<string, unknown>), chargeable_days: days };
  return { ...item, price } as unknown as LineItem;
}
function billing(uid: string, number: number, quantity: number, days = 5): Invoice {
  return invoice(uid, [{ order: O, items: [DEST_ITEM, GROUP_ITEM, withDays(line(LIGHT, [D, G, LIGHT], quantity, 1000), days)] }], number);
}

Deno.test("documentDiff: a split bill — 3 + 2 of 5 — reports nothing from any view", () => {
  const sources = { orders: [billedOrder(5)], fulfillments: [fulfillment(billedOrder(5).items as unknown as LineItem[])], invoices: [billing("inv-a", 2241, 3), billing("inv-b", 2250, 2)] };
  for (const viewing of [{ kind: "order", uid: O }, { kind: "fulfillment", uid: O }, { kind: "invoice", uid: "inv-a" }, { kind: "invoice", uid: "inv-b" }] as const) {
    assertEquals(summary(computeDocumentDiffs(sources, viewing, CONTEXT).lines), {}, `${viewing.kind} ${viewing.uid}`);
  }
});

Deno.test("documentDiff: a remainder — 4 invoiced of 6 — is one quantity entry on the order, the fulfillment and the invoice", () => {
  const sources = { orders: [billedOrder(6)], fulfillments: [fulfillment(billedOrder(6).items as unknown as LineItem[])], invoices: [billing("inv-a", 2241, 4)] };
  const entry = ["qty[#2241](o6 f6 i4,q2000,x0,fq2000)"];
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), { [`${D}/${G}/${LIGHT}`]: entry });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), { [`${D}/${G}/${LIGHT}`]: entry });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-a" }, CONTEXT).lines), { [`${O}/${D}/${G}/${LIGHT}`]: entry });
});

Deno.test("documentDiff: the warehouse over-fulfilled and billing matched the QUOTE — the quantity entry still fires on fulfilled", () => {
  // 🔴 The case that was invisible. Ordered 2, shipped 3, billed 2: billing
  // agrees with the quote, so `accountLine`'s `ordered − billed` is 0 and the
  // `billed` entry early-returns. Before the `fulfilled` entry the invoice read as
  // perfectly aligned while a third unit went out the door unbilled.
  const order = billedOrder(2);
  const fulfilled = fulfillment(billedOrder(3).items as unknown as LineItem[]);
  const sources = { orders: [order], fulfillments: [fulfilled], invoices: [billing("inv-a", 2241, 2)] };
  // ⭐ The order and fulfillment views ALSO carry the pre-existing order ↔
  // fulfillment `differs` — "you quoted 2, we fulfilled 3". That entry and the
  // `fulfilled` one are both wanted and say different things: one compares the
  // shipment to the quote, the other compares the billing to the shipment.
  const fulfilled_ = "qty[#2241](o2 f3 i2,q0,x0,fq1000)";
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["fulfillment#1001:differs(quantity=2→3)", fulfilled_],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["order#1001:differs(quantity=3→2)", fulfilled_],
  });
  // 🔴 On the INVOICE view the order ↔ fulfillment difference is not visible at
  // all — it is a comparison between two other documents. So the `fulfilled` entry
  // is the ONLY thing telling an invoice operator that more shipped than they
  // are billing, which is why it belongs beside `billed` rather than in a new
  // fulfillment ↔ invoice pair comparison.
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-a" }, CONTEXT).lines), {
    [`${O}/${D}/${G}/${LIGHT}`]: [fulfilled_],
  });
});

Deno.test("documentDiff: under-shipped AND under-invoiced — ONE entry carrying all three numbers", () => {
  // Ordered 6, shipped 5, billed 4. The two authorities disagree with the
  // invoice by different amounts, which is exactly when the pair earns its
  // keep: "2 short of the quote" and "1 short of what shipped".
  const sources = {
    orders: [billedOrder(6)],
    fulfillments: [fulfillment(billedOrder(5).items as unknown as LineItem[])],
    invoices: [billing("inv-a", 2241, 4)],
  };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: [
      "fulfillment#1001:differs(quantity=6→5)",
      "qty[#2241](o6 f5 i4,q2000,x0,fq1000)",
    ],
  });
});

Deno.test("documentDiff: the fulfillment agreeing with the order does not by itself raise the entry — ordered vs invoiced does", () => {
  // Ordered 6, shipped 6, billed 4. A `fulfilled` entry here would read "4 of 6
  // fulfilled" beside "4 of 6" — two entries carrying one fact.
  const sources = {
    orders: [billedOrder(6)],
    fulfillments: [fulfillment(billedOrder(6).items as unknown as LineItem[])],
    invoices: [billing("inv-a", 2241, 4)],
  };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["qty[#2241](o6 f6 i4,q2000,x0,fq2000)"],
  });
});

Deno.test("documentDiff: a quantity entry says whether the over-billing offer is BLOCKED by CRMS (gap 7)", () => {
  // The copy and the offer must refuse on the SAME condition, or a surface keeps
  // rendering "over-billed" that no button can ever clear. Deciding it needs the
  // invoices' `crms_id`, which the entry's `invoices` refs do not carry — so the
  // entry states it.
  const native = { orders: [billedOrder(6)], invoices: [billing("inv-a", 2241, 4)] };
  const nativeEntry = computeDocumentDiffs(native, { kind: "order", uid: O }, CONTEXT).lines.get(`${D}/${G}/${LIGHT}`);
  assertEquals((nativeEntry?.[0] as { crms_blocked: boolean }).crms_blocked, false);

  const crms = { ...native, invoices: [{ ...billing("inv-a", 2241, 4), crms_id: 1087 }] };
  const crmsEntry = computeDocumentDiffs(crms, { kind: "order", uid: O }, CONTEXT).lines.get(`${D}/${G}/${LIGHT}`);
  assertEquals((crmsEntry?.[0] as { crms_blocked: boolean }).crms_blocked, true);
});

Deno.test("documentDiff: ANY live CRMS invoice blocks the offer, not only an all-CRMS order", () => {
  // 🔴 The MIXED order, which is where "any" and "all" disagree — and where an
  // "all CRMS" test would say the line is actionable while
  // `buildOverbillingCredits` returns nothing. The 2026-09-16 census found one.
  const mixed = {
    orders: [billedOrder(6)],
    invoices: [billing("inv-a", 2241, 2), { ...billing("inv-b", 2242, 2), crms_id: 1087 }],
  };
  const entry = computeDocumentDiffs(mixed, { kind: "order", uid: O }, CONTEXT).lines.get(`${D}/${G}/${LIGHT}`);
  assertEquals((entry?.[0] as { crms_blocked: boolean }).crms_blocked, true);
});

Deno.test("documentDiff: a date extension is money on the quantity entry, not a chargeable_days differs", () => {
  // Billed 2 at 3 chargeable days (floored to one week: 2 × 1000 = 2000¢); the
  // order now charges 7 days (2 × 1000 × 7 ÷ 5 = 2800¢). 800¢ left to bill —
  // not price(4 days) = 2000¢, which is what pricing "the extra days" would say.
  // The extension is the pairs' windows: the invoice's charged 3 days to Sep 3, the order's now 7 to Sep 9.
  const sources = { orders: [dated(billedOrder(2, 7), 7, "2026-09-09")], invoices: [dated(billing("inv-a", 2241, 2, 3), 3, "2026-09-03")] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["qty[#2241](o2 f- i2,q0,x800)"],
  });
});

Deno.test("documentDiff: line days that disagree on an unmoved window are no billed entry (api-cloudrun#680)", () => {
  // Prod's CRMS-authored invoices: the same window on both pairs, the billed row stored
  // at other days. The retired line-day rule reported "Billed 2 of 2" with 800¢ owed.
  const sources = { orders: [dated(billedOrder(2, 7), 7, "2026-09-09")], invoices: [dated(billing("inv-a", 2241, 2, 3), 7, "2026-09-09")] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {});
});

/** Give every pair on a document a charge window ending `endDay` and charging `days`. */
function dated<T extends Order | Invoice>(doc: T, days: number, endDay: string): T {
  const destinations = (doc as unknown as { destinations: { dates: Record<string, unknown> }[] }).destinations.map((pair) => ({
    ...pair,
    dates: { ...pair.dates, charge_windows: [{ start: "2026-09-01T00:00:00.000-05:00", end: `${endDay}T00:00:00.000-05:00`, days }] },
  }));
  return { ...doc, destinations } as T;
}

Deno.test("documentDiff: a discount whose AMOUNT alone moved is no row — its terms still are (G2, core#118)", () => {
  // 🔴 The leak this pins: the comparator names a price difference at the KEY
  // (`price.discount`) while the classification is per LEAF
  // (`price.discount.amount_cents` derived, `.rate`/`.type` propagated). Compared
  // at the key, a split bill's smaller discount AMOUNT read as an override.
  const discounted = (quantity: number, rate = 10) => {
    const it = line(LIGHT, [D, G, LIGHT], quantity, 1000) as unknown as { price: Record<string, unknown> };
    it.price.discount = { type: "percent", rate, amount_cents: quantity * 1000 * rate / 100 };
    return it as unknown as LineItem;
  };
  const ord = order([DEST_ITEM, GROUP_ITEM, discounted(5)]);
  const split = (uid: string, number: number, quantity: number, rate = 10) =>
    invoice(uid, [{ order: O, items: [DEST_ITEM, GROUP_ITEM, discounted(quantity, rate)] }], number);

  assertEquals(
    summary(computeDocumentDiffs({ orders: [ord], invoices: [split("inv-a", 2241, 3), split("inv-b", 2250, 2)] }, { kind: "order", uid: O }, CONTEXT).lines),
    {},
    "3 + 2 of 5 at the same 10%: only the derived amount differs",
  );
  // Mutation control: the same line with its RATE moved reports exactly the rate.
  assertEquals(
    summary(computeDocumentDiffs({ orders: [ord], invoices: [split("inv-a", 2241, 5, 20)] }, { kind: "order", uid: O }, CONTEXT).lines),
    { [`${D}/${G}/${LIGHT}`]: ["invoice#2241:differs(price.discount.rate=10→20)"] },
  );
});

Deno.test("documentDiff: a split bill still reports a base price the invoice changed", () => {
  const a = billing("inv-a", 2241, 3);
  patchLine(a.items, `${O}/${D}/${G}/${LIGHT}`, (it) => { (it.price as Record<string, unknown>).base_cents = 900; });
  const diff = computeDocumentDiffs({ orders: [billedOrder(5)], invoices: [a, billing("inv-b", 2250, 2)] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${LIGHT}`]: ["invoice#2241:differs(price.base_cents=1000→900)"] });
});

// ── Document-level differences (G13) ────────────────────────────

/** A readable projection of the doc-level list. */
function docSummary(map: DocumentDiffMap): string[] {
  return map.doc.map((e) =>
    e.kind === "doc_field"
      ? `${e.source.kind}#${e.source.number}:doc_field(${
        e.fields.map((f) => `${f.field}=${JSON.stringify(f.here)}→${JSON.stringify(f.there)}`).join(",")
      })`
      : `unexpected:${e.kind}`
  );
}

const ORG_A = { uid: "org-a", name: "Acme Films", path: [{ uid: "org-a", name: "Acme Films" }] };
const ORG_B = { uid: "org-b", name: "Acme Films — Lighting", path: [{ uid: "org-b", name: "Acme Films — Lighting" }] };

Deno.test("documentDiff: a doc-level shared field that differs reports ONE doc_field entry (G13)", () => {
  // Before this there was nowhere for these to go. `computeDocumentDiffs`
  // returned `lines` and `pairs` only, so an invoice whose organization had been
  // overridden — or frozen by a denorm drift — showed NOTHING in any view, which
  // is exactly what made the organization silently stop following its order.
  const ord = order();
  (ord as unknown as Record<string, unknown>).organization = ORG_A;
  (ord as unknown as Record<string, unknown>).subject = "Feature shoot";
  (ord as unknown as Record<string, unknown>).reference = "PO-77";
  (ord as unknown as Record<string, unknown>).tax_exempt = false;
  (ord as unknown as Record<string, unknown>).uid_store = "store-chicago";

  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  const invRec = inv as unknown as Record<string, unknown>;
  invRec.organization = ORG_B; // moved to a department
  invRec.subject = "Feature shoot"; // agrees — must not report
  invRec.reference = "PO-78"; // overridden
  invRec.tax_exempt = true; // overridden
  invRec.uid_store = "store-chicago"; // agrees

  const sources = { orders: [ord], invoices: [inv] };
  assertEquals(docSummary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT)), [
    'order#1001:doc_field(organization={"uid":"org-b","name":"Acme Films — Lighting","path":[{"uid":"org-b","name":"Acme Films — Lighting"}]}→{"uid":"org-a","name":"Acme Films","path":[{"uid":"org-a","name":"Acme Films"}]},tax_exempt=true→false,reference="PO-78"→"PO-77")',
  ]);
  // …and the order view reports the same difference the other way round.
  assertEquals(docSummary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT)).length, 1);
});

Deno.test("documentDiff: homonym and derived doc fields NEVER report — the two exclusions", () => {
  // The anti-vacuity half. `status`, `number`, `version` and `xero_id` differ on
  // essentially every real order/invoice pair — an order's `xero_id` is its Xero
  // QUOTE and an invoice's is its Xero INVOICE — so if homonyms were compared
  // this surface would report on every document in the corpus and be worthless.
  // `totals` is derived and is the doc-level G2.
  const ord = order();
  const ordRec = ord as unknown as Record<string, unknown>;
  ordRec.xero_id = "quote-xyz";
  ordRec.crms_id = 4242;
  ordRec.totals = { total_cents: 9999 };
  ordRec.subject = "Same";

  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  const invRec = inv as unknown as Record<string, unknown>;
  invRec.xero_id = "invoice-abc"; // homonym — different meaning, not a difference
  invRec.crms_id = 1717; // homonym
  invRec.totals = { total_cents: 1111 }; // derived
  invRec.subject = "Same"; // the one propagated field, and it agrees

  assertEquals(
    docSummary(computeDocumentDiffs({ orders: [ord], invoices: [inv] }, { kind: "invoice", uid: "inv-1" }, CONTEXT)),
    [],
    "status/number/version/xero_id/crms_id are homonyms and totals is derived — none is a difference",
  );

  // Mutation control: the walk really does reach this document. Move a
  // PROPAGATED field and the same call reports it.
  invRec.subject = "Changed";
  assertEquals(
    docSummary(computeDocumentDiffs({ orders: [ord], invoices: [inv] }, { kind: "invoice", uid: "inv-1" }, CONTEXT)),
    ['order#1001:doc_field(subject="Changed"→"Same")'],
  );
});

Deno.test("documentDiff: an invoice and a fulfillment have NO doc-level relationship", () => {
  // Both are projections OF the order and have no link to each other. Comparing
  // them would report every difference twice and there is no rule saying which
  // of the two should have followed the other.
  const ord = order();
  (ord as unknown as Record<string, unknown>).subject = "From the order";
  const f = fulfillment();
  (f as unknown as Record<string, unknown>).subject = "From the order";
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  (inv as unknown as Record<string, unknown>).subject = "Invoice's own";

  const entries = computeDocumentDiffs(
    { orders: [ord], fulfillments: [f], invoices: [inv] },
    { kind: "invoice", uid: "inv-1" },
    CONTEXT,
  ).doc;
  assertEquals(entries.length, 1, "exactly one entry — against the ORDER, not against the fulfillment");
  assertEquals(entries[0].kind === "doc_field" && entries[0].source.kind, "order");
});

// ── substituted_for: merges (manager#414, Track S1) ──────────────────────────

/** Merge `quantity` units of the line at `fromKey` into the row at `intoKey`, dropping the replaced row when it is used up. */
function merge(rows: LineItem[], fromKey: string, intoKey: string, quantity: number, prefix: string[] = []): void {
  const from = rows.findIndex((it) => it.path.join("/") === fromKey);
  const into = rows.find((it) => it.path.join("/") === intoKey) as unknown as Record<string, unknown>;
  const replaced = rows[from];
  into.quantity = (into.quantity as number) + quantity;
  into.substituted_for = [{ path: replaced.path.slice(prefix.length), quantity }];
  if ((replaced.quantity ?? 0) === quantity) rows.splice(from, 1);
  else (replaced as unknown as Record<string, unknown>).quantity = (replaced.quantity ?? 0) - quantity;
}

Deno.test("documentDiff: a fulfillment MERGE is one entry at the substitute from both views — no differs, no missing line", () => {
  // The one Tripod merged into the group's Light row: 2 + 1 = 3.
  const f = fulfillment();
  merge(f.items as unknown as LineItem[], `${D}/${G}/${TRIPOD}`, `${D}/${G}/${LIGHT}`, 1);
  const sources = { orders: [order()], fulfillments: [f] };
  const entry = `${D}/${G}/${TRIPOD}→${D}/${G}/${LIGHT}`;
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), { [`${D}/${G}/${LIGHT}`]: [`order#1001:substituted(${entry})`] });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), { [`${D}/${G}/${LIGHT}`]: [`fulfillment#1001:substituted(${entry})`] });
});

Deno.test("documentDiff: a PARTIAL merge leaves the replaced line at the rest — explained, not a quantity difference", () => {
  // One of the four ungrouped Lights merged into the Tripod: Light 3, Tripod 1 + 1.
  const f = fulfillment();
  merge(f.items as unknown as LineItem[], `${D}/${LIGHT}`, `${D}/${G}/${TRIPOD}`, 1);
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "fulfillment", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${TRIPOD}`]: [`order#1001:substituted(${D}/${LIGHT}→${D}/${G}/${TRIPOD})`] });
});

Deno.test("documentDiff: a merged row whose quantity breaks D2 still reports the quantity difference", () => {
  const f = fulfillment();
  const rows = f.items as unknown as LineItem[];
  merge(rows, `${D}/${G}/${TRIPOD}`, `${D}/${G}/${LIGHT}`, 1);
  // A picker bumped the merged row by hand: 5, where 2 ordered + 1 standing in = 3.
  patchLine(rows, `${D}/${G}/${LIGHT}`, (it) => it.quantity = 5);
  const diff = computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "fulfillment", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), {
    [`${D}/${G}/${LIGHT}`]: [`order#1001:substituted(${D}/${G}/${TRIPOD}→${D}/${G}/${LIGHT})`, "order#1001:differs(quantity=5→2)"],
  });
});

Deno.test("documentDiff: an invoice merge is substituted at the substitute on the order view, and bills both lines in full", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  merge(inv.items as unknown as LineItem[], `${O}/${D}/${G}/${TRIPOD}`, `${O}/${D}/${G}/${LIGHT}`, 1, [O]);
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), { [`${D}/${G}/${LIGHT}`]: [`invoice#2241:substituted(${D}/${G}/${TRIPOD}→${D}/${G}/${LIGHT})`] });
});

// ── an exchange's `exchanged_for`, re-aimed on the fulfillment (manager#537) ─────────

const X_PATH = [D, G, TRIPOD];

Deno.test("documentDiff: a fulfillment whose exchanged_for differs from the order's reports one exchanged_for field", () => {
  const o = order();
  patchLine(o.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [{ path: X_PATH, quantity: 1, reason: "damaged" }]; });
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [{ path: X_PATH, quantity: 2, reason: "damaged" }]; });
  const sources = { orders: [o], fulfillments: [f] };
  const orderEntry = [{ path: X_PATH, quantity: 1, reason: "damaged" }];
  const fulfillmentEntry = [{ path: X_PATH, quantity: 2, reason: "damaged" }];
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${LIGHT}`]: [`fulfillment#1001:differs(exchanged_for=${JSON.stringify(orderEntry)}→${JSON.stringify(fulfillmentEntry)})`],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/${LIGHT}`]: [`order#1001:differs(exchanged_for=${JSON.stringify(fulfillmentEntry)}→${JSON.stringify(orderEntry)})`],
  });
});

Deno.test("documentDiff: the same exchanged_for on both sides is no entry — and the reason is part of the identity", () => {
  const o = order();
  patchLine(o.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [{ path: X_PATH, quantity: 1, reason: "damaged" }]; });
  const same = fulfillment();
  patchLine(same.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [{ path: X_PATH, quantity: 1, reason: "damaged" }]; });
  assertEquals(computeDocumentDiffs({ orders: [o], fulfillments: [same] }, { kind: "order", uid: O }, CONTEXT).lines.size, 0);

  const reclassified = fulfillment();
  patchLine(reclassified.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [{ path: X_PATH, quantity: 1, reason: "cleaning" }]; });
  assertEquals(Object.keys(summary(computeDocumentDiffs({ orders: [o], fulfillments: [reclassified] }, { kind: "order", uid: O }, CONTEXT).lines)), [`${D}/${LIGHT}`]);
});

Deno.test("S8c-5: an old-named `replaces` is not read — it compares as no exchange entries", () => {
  const entry = { path: X_PATH, quantity: 1, reason: "damaged" };
  const o = order();
  patchLine(o.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.replaces = [entry]; });
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [entry]; });
  assertEquals(computeDocumentDiffs({ orders: [o], fulfillments: [f] }, { kind: "order", uid: O }, CONTEXT).lines.size, 1);
});

Deno.test("documentDiff: absent exchanged_for equals an empty list", () => {
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = []; });
  assertEquals(computeDocumentDiffs({ orders: [order()], fulfillments: [f] }, { kind: "order", uid: O }, CONTEXT).lines.size, 0);
});

Deno.test("documentDiff: exchanged_for entries in a different order are equal — it is a multiset, not a list", () => {
  const a = { path: X_PATH, quantity: 1, reason: "damaged" };
  const b = { path: [D, G, LIGHT], quantity: 1, reason: "cleaning" };
  const o = order();
  patchLine(o.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [a, b]; });
  const f = fulfillment();
  patchLine(f.items as unknown as LineItem[], `${D}/${LIGHT}`, (it) => { it.exchanged_for = [b, a]; });
  assertEquals(computeDocumentDiffs({ orders: [o], fulfillments: [f] }, { kind: "order", uid: O }, CONTEXT).lines.size, 0);
});

// ── core#118: one-sided legs and kits, kept rows, exchange units, L&D ────────

Deno.test("documentDiff: the kind set is exactly eight — derived from the entries, so it cannot drift", () => {
  // Compile-time: a kind added or removed without updating this literal fails
  // `deno check`, in both directions (an extra key is excess, a missing one is required).
  // `moved` joined with core#125.
  const kinds: Record<DocumentDiffKind, true> = {
    differs: true, not_on_source: true, only_on_source: true, pair_field: true,
    doc_field: true, substituted: true, moved: true, quantity: true,
  };
  assertEquals(Object.keys(kinds).length, 8);
});

const LEG2 = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a03";

Deno.test("documentDiff: a leg only the fulfillment carries is ONE pair entry — its rows are not listed again", () => {
  const f = fulfillment();
  (f.items as unknown as LineItem[]).push(
    { uid: LEG2, type: "destination", name: "Exchange", description: "", path: [LEG2] } as unknown as LineItem,
    { uid: TRIPOD, type: "rental", name: TRIPOD, description: "", quantity: 1, path: [LEG2, TRIPOD] } as unknown as LineItem,
  );
  (f.destinations as unknown as Record<string, unknown>[]).push({ ...structuredClone(PAIR), uid: LEG2 });
  const sources = { orders: [order()], fulfillments: [f] };

  const onOrder = computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(onOrder.pairs), { [LEG2]: ["fulfillment#1001:only_on_source"] });
  assertEquals(summary(onOrder.lines), {}, "the row under the one-sided leg is the pair entry's, not its own");

  const onFulfillment = computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT);
  assertEquals(summary(onFulfillment.pairs), { [LEG2]: ["order#1001:not_on_source"] });
  assertEquals(summary(onFulfillment.lines), {});
});

Deno.test("documentDiff: an invoice that DECLINED one of the order's legs is aligned — its lines read uninvoiced, no pair entry (core#126)", () => {
  // A leg is decided like a line: a partial invoice that leaves one out is
  // aligned, and the leg's lines are an ordinary `quantity` entry at
  // `invoiced: 0`. Leg presence is still never a PAIR entry against an invoice.
  const items = [...orderItems(), { uid: LEG2, type: "destination", name: "Second", description: "", path: [LEG2] } as LineItem, line(TRIPOD, [LEG2, TRIPOD], 1, 3000)];
  const ord = order(items);
  ord.destinations.push({ ...structuredClone(PAIR), uid: LEG2 } as Order["destinations"][number]);
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  const diff = computeDocumentDiffs({ orders: [ord], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(
    [summary(diff.pairs), summary(diff.lines), diff.unaligned.map((u) => u.source.kind)],
    [{}, { [`${LEG2}/${TRIPOD}`]: ["qty[#2241](o1 f- i0,q3000,x0)"] }, []],
  );
});

Deno.test("documentDiff: an invoice lacking a leg whose line it bills ELSEWHERE is still UNALIGNED — one entry, nothing per line", () => {
  // The broken-skeleton half of the same shape: the tripod is on the invoice,
  // hung under the order's first leg instead of its own. Read as declined, it
  // would count as unbilled and a remaining invoice would bill it twice.
  const items = [...orderItems(), { uid: LEG2, type: "destination", name: "Second", description: "", path: [LEG2] } as LineItem, line(TRIPOD, [LEG2, TRIPOD], 1, 3000)];
  const ord = order(items);
  ord.destinations.push({ ...structuredClone(PAIR), uid: LEG2 } as Order["destinations"][number]);
  const inv = invoice("inv-1", [{ order: O, items: [...orderItems(), line(TRIPOD, [D, TRIPOD], 1, 3000)] }]);
  const diff = computeDocumentDiffs({ orders: [ord], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals([summary(diff.pairs), summary(diff.lines), diff.unaligned.map((u) => u.source.kind)], [{}, {}, ["invoice"]]);
});

const KIT = "prod-kit";
const COMP = "comp-a";

Deno.test("documentDiff: a kit parent on one side only reports ONCE — its components are suppressed", () => {
  const items = [...orderItems(), line(KIT, [D, KIT], 1, 5000), line(COMP, [D, KIT, COMP], 2, 0)];
  const sources = { orders: [order()], fulfillments: [fulfillment(items)] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${KIT}`]: ["fulfillment#1001:only_on_source"],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/${KIT}`]: ["order#1001:not_on_source"],
  });
  // Mutation control: with the parent on both sides, the component alone reports.
  const both = { orders: [order([...orderItems(), line(KIT, [D, KIT], 1, 5000)])], fulfillments: [fulfillment(items)] };
  assertEquals(summary(computeDocumentDiffs(both, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${KIT}/${COMP}`]: ["fulfillment#1001:only_on_source"],
  });
});

Deno.test("documentDiff: a KEPT kit (the order removed it, units still out) — presence once, quantity per row", () => {
  // api-cloudrun#1147's shape: the order dropped the kit; the fulfillment keeps
  // the component at its live custody and its product ancestor at 0, both
  // stamped `quantity_ordered: 0`.
  const f = fulfillment();
  (f.items as unknown as LineItem[]).push(
    { uid: KIT, type: "rental", name: KIT, description: "", quantity: 0, quantity_ordered: 0, path: [D, KIT] } as unknown as LineItem,
    { uid: COMP, type: "rental", name: COMP, description: "", quantity: 2, quantity_ordered: 0, path: [D, KIT, COMP] } as unknown as LineItem,
  );
  const sources = { orders: [order()], fulfillments: [f], invoices: [invoice("inv-1", [{ order: O, items: orderItems() }])] };
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), {
    // One presence fact, at the kept ancestor. Its quantity (0 of 0) says nothing.
    [`${D}/${KIT}`]: ["fulfillment#1001:only_on_source"],
  });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), {
    [`${D}/${KIT}`]: ["order#1001:not_on_source"],
    // The two units still out are on no order line and no invoice: the billing question survives.
    [`${D}/${KIT}/${COMP}`]: ["qty[#2241](o- f2 i0)"],
  });
});

Deno.test("documentDiff: an exchange unit is shown, never owed — no quantity entry against invoices (decision 8)", () => {
  const exchange = { exchanged_for: [{ path: [D, G, TRIPOD], quantity: 1, reason: "damaged" }] };
  const items = [...orderItems(), line("prod-tripod-x", [D, "prod-tripod-x"], 1, 0, exchange)];
  const sources = { orders: [order(items)], fulfillments: [fulfillment(items)], invoices: [invoice("inv-1", [{ order: O, items: orderItems() }])] };
  for (const viewing of [{ kind: "order", uid: O }, { kind: "fulfillment", uid: O }, { kind: "invoice", uid: "inv-1" }] as const) {
    assertEquals(summary(computeDocumentDiffs(sources, viewing, CONTEXT).lines), {}, viewing.kind);
  }
  // Mutation control: the same line without `exchanged_for` IS owed.
  const plain = [...orderItems(), line("prod-tripod-x", [D, "prod-tripod-x"], 1, 0)];
  assertEquals(
    Object.keys(summary(computeDocumentDiffs({ ...sources, orders: [order(plain)], fulfillments: [fulfillment(plain)] }, { kind: "order", uid: O }, CONTEXT).lines)),
    [`${D}/prod-tripod-x`],
  );
});

/** A lost/damaged record against the ungrouped Light's booking (`{order}:{item}:{leg}`). */
function oos(uid: string, quantity: number, extra: Record<string, unknown> = {}): DocumentDiffOutOfService {
  return {
    uid, reason: "lost", status: "active", quantity, breakdown: { returned_to_service: 0 },
    query_by_sources: [`orders:${O}`, `bookings:${O}:${LIGHT}:${D}`],
    ...extra,
  } as unknown as DocumentDiffOutOfService;
}

/** An invoice over the whole order plus one `replacement` line billing a record. */
function invoiceBilling(uidOos: string, quantity: number): Invoice {
  const inv = invoice("inv-1", [{ order: O, items: [...orderItems(), line(`repl-${uidOos}`, [D, `repl-${uidOos}`], quantity, 5000, { type: "replacement" })] }]);
  // Set after the build: the order→invoice projection does not carry an invoice-only field.
  patchLine(inv.items, `${O}/${D}/repl-${uidOos}`, (it) => { it.uid_out_of_service = uidOos; });
  return inv;
}

Deno.test("documentDiff: a lost record is a quantity entry at the row that owns its booking — and its invoice line is no presence row", () => {
  const inv = invoiceBilling("oos-1", 1);
  const sources = { orders: [order()], fulfillments: [fulfillment()], invoices: [inv], outOfService: [oos("oos-1", 3)] };
  // Two of the three lost units are not yet invoiced. The Light at [D, G] and
  // the one at [D] are the same product on the same leg — ONE grain — so the
  // record files at the first row in document order.
  const entry = ["qty[#2241](o- f3 i1,oos:oos-1)"];
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).lines), { [`${D}/${G}/${LIGHT}`]: entry });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "fulfillment", uid: O }, CONTEXT).lines), { [`${D}/${G}/${LIGHT}`]: entry });
  assertEquals(summary(computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT).lines), { [`${O}/${D}/${G}/${LIGHT}`]: entry });

  // Fully invoiced: nothing, from any view.
  const all = { ...sources, outOfService: [oos("oos-1", 1)] };
  assertEquals(summary(computeDocumentDiffs(all, { kind: "order", uid: O }, CONTEXT).lines), {});
});

Deno.test("documentDiff: a record's billable units drop what came back, and a canceled record owes nothing", () => {
  const inv = invoiceBilling("oos-1", 2);
  const base = { orders: [order()], invoices: [inv] };
  const returned = oos("oos-1", 3, { breakdown: { returned_to_service: 1 } });
  assertEquals(summary(computeDocumentDiffs({ ...base, outOfService: [returned] }, { kind: "order", uid: O }, CONTEXT).lines), {});
  const canceledRecord = oos("oos-1", 3, { status: "canceled" });
  assertEquals(summary(computeDocumentDiffs({ ...base, outOfService: [canceledRecord] }, { kind: "order", uid: O }, CONTEXT).lines), {
    [`${D}/${G}/${LIGHT}`]: ["qty[#2241](o- f0 i2,oos:oos-1)"],
  });
});

Deno.test("documentDiff: a record no row books is listed as unplaced, never dropped; a cleaning record is not compared", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  const stray = oos("oos-2", 1, { query_by_sources: [`orders:${O}`, `bookings:${O}:prod-gone:${D}`] });
  const cleaning = oos("oos-3", 1, { reason: "cleaning" });
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv], outOfService: [stray, cleaning] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(summary(diff.lines), {});
  assertEquals(diff.unplaced_out_of_service.map((e) => `${e.uid_out_of_service}:f${e.fulfilled} i${e.invoiced}`), ["oos-2:f1 i0"]);
});

Deno.test("documentDiff: out-of-service is silent without the source, and without an aligned invoice", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  assertEquals(computeDocumentDiffs({ orders: [order()], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT).lines.size, 0);
  assertEquals(computeDocumentDiffs({ orders: [order()], outOfService: [oos("oos-1", 3)] }, { kind: "order", uid: O }, CONTEXT).lines.size, 0);
});

Deno.test("documentDiff: on the invoice view, a MISSING order does not make the fulfillment unaligned", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  (inv.items as unknown as LineItem[]).splice(2, 1); // misaligned too — but with no order, nothing can say so
  const diff = computeDocumentDiffs({ fulfillments: [fulfillment()], invoices: [inv] }, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals([diff.lines.size, diff.pairs.size, diff.unaligned.length], [0, 0, 0]);
});

// ── Credit notes (manager#610) ─────────────────────────────────────────────

/** A credit note crediting one row of one invoice. */
function creditNote(
  uid: string,
  number: number,
  invoiceUid: string | string[],
  lines: Array<{ quantity: number; path?: string[]; uid_invoice_item?: string | null; reverses_billing?: boolean }>,
  status: DocumentDiffCreditNote["status"] = "issued",
): DocumentDiffCreditNote {
  const invoices = Array.isArray(invoiceUid) ? invoiceUid : [invoiceUid];
  return {
    uid,
    number,
    status,
    sources: invoices.map((i) => ({ collection: "invoices", uid: i })),
    items: lines.map((l) => ({
      quantity: l.quantity,
      path_invoice_item: l.path,
      uid_invoice_item: l.uid_invoice_item ?? null,
      reverses_billing: l.reverses_billing ?? false,
    })),
  };
}

/** The order with LIGHT at D/G billed THREE times on inv-1 against two ordered. */
function overbilled(): { o: Order; inv: Invoice } {
  const billed = orderItems();
  patchLine(billed, `${D}/${G}/${LIGHT}`, (it) => { it.quantity = 3; });
  return { o: order(), inv: invoice("inv-1", [{ order: O, items: billed }]) };
}

const LIGHT_REL = `${D}/${G}/${LIGHT}`;
const LIGHT_ON_INVOICE = [O, D, G, LIGHT];

function quantityAt(diff: DocumentDiffMap, k: string) {
  return (diff.lines.get(k) ?? []).filter((e) => e.kind === "quantity").map((e) => e.kind === "quantity" ? [e.ordered, e.invoiced] : []);
}

Deno.test("documentDiff: with no credit notes passed, the over-billed line reads ordered 2, invoiced 3 — the baseline the credit cases move", () => {
  const { o, inv } = overbilled();
  const diff = computeDocumentDiffs({ orders: [o], invoices: [inv] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(quantityAt(diff, LIGHT_REL), [[2, 3]]);
  assertEquals([diff.credits.size, diff.unkeyed_credit_notes.length], [0, 0]);
});

Deno.test("documentDiff: a REVERSING credit nets out of invoiced, clearing the quantity entry, and is still annotated on the row", () => {
  const { o, inv } = overbilled();
  const cn = creditNote("cn-1", 1030, "inv-1", [{ quantity: 1, path: LIGHT_ON_INVOICE, reverses_billing: true }]);
  const sources = { orders: [o], invoices: [inv], creditNotes: [cn] };
  const expected = [{ uid_credit_note: "cn-1", number: 1030, uid_invoice: "inv-1", quantity: 1, reverses_billing: true }];

  const onOrder = computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT);
  assertEquals(quantityAt(onOrder, LIGHT_REL), []);
  assertEquals(onOrder.credits.get(LIGHT_REL), expected);

  const onInvoice = computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals(quantityAt(onInvoice, `${O}/${LIGHT_REL}`), []);
  assertEquals(onInvoice.credits.get(`${O}/${LIGHT_REL}`), expected);
});

Deno.test("documentDiff: a NON-reversing credit (the CN-1027 shape) is shown and never netted — invoiced stays gross", () => {
  const { o, inv } = overbilled();
  const cn = creditNote("cn-1027", 1027, "inv-1", [{ quantity: 1, path: LIGHT_ON_INVOICE, reverses_billing: false }]);
  const sources = { orders: [o], invoices: [inv], creditNotes: [cn] };
  const expected = [{ uid_credit_note: "cn-1027", number: 1027, uid_invoice: "inv-1", quantity: 1, reverses_billing: false }];

  const onOrder = computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT);
  assertEquals(quantityAt(onOrder, LIGHT_REL), [[2, 3]]);
  assertEquals(onOrder.credits.get(LIGHT_REL), expected);

  const onInvoice = computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals(quantityAt(onInvoice, `${O}/${LIGHT_REL}`), [[2, 3]]);
  assertEquals(onInvoice.credits.get(`${O}/${LIGHT_REL}`), expected);
});

Deno.test("documentDiff: a void credit note nets nothing and is not annotated", () => {
  const { o, inv } = overbilled();
  const cn = creditNote("cn-v", 1031, "inv-1", [{ quantity: 1, path: LIGHT_ON_INVOICE, reverses_billing: true }], "void");
  const diff = computeDocumentDiffs({ orders: [o], invoices: [inv], creditNotes: [cn] }, { kind: "order", uid: O }, CONTEXT);
  assertEquals(quantityAt(diff, LIGHT_REL), [[2, 3]]);
  assertEquals([diff.credits.size, diff.unkeyed_credit_notes.length], [0, 0]);
});

Deno.test("documentDiff: credits on two invoices of one order are attributed per invoice — both on the order view, each on its own invoice", () => {
  const a = invoice("inv-a", [{ order: O, items: orderItems() }], 2241);
  const b = invoice("inv-b", [{ order: O, items: orderItems() }], 2242);
  const cnA = creditNote("cn-a", 1040, "inv-a", [{ quantity: 1, path: LIGHT_ON_INVOICE }]);
  const cnB = creditNote("cn-b", 1041, "inv-b", [{ quantity: 2, path: LIGHT_ON_INVOICE }]);
  const sources = { orders: [order()], invoices: [a, b], creditNotes: [cnA, cnB] };
  const creditA = { uid_credit_note: "cn-a", number: 1040, uid_invoice: "inv-a", quantity: 1, reverses_billing: false };
  const creditB = { uid_credit_note: "cn-b", number: 1041, uid_invoice: "inv-b", quantity: 2, reverses_billing: false };

  assertEquals(computeDocumentDiffs(sources, { kind: "order", uid: O }, CONTEXT).credits.get(LIGHT_REL), [creditA, creditB]);
  assertEquals([...computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-a" }, CONTEXT).credits], [[`${O}/${LIGHT_REL}`, [creditA]]]);
  assertEquals([...computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-b" }, CONTEXT).credits], [[`${O}/${LIGHT_REL}`, [creditB]]]);
});

Deno.test("documentDiff: a legacy line with no path keys by uid only when the uid is unique on the invoice; otherwise the note is unkeyed", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  // LIGHT sits at two paths on the invoice, TRIPOD at one.
  const ambiguous = creditNote("cn-light", 1050, "inv-1", [{ quantity: 1, uid_invoice_item: LIGHT }]);
  const unique = creditNote("cn-tripod", 1051, "inv-1", [{ quantity: 1, uid_invoice_item: TRIPOD }]);
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv], creditNotes: [ambiguous, unique] }, { kind: "order", uid: O }, CONTEXT);

  assertEquals([...diff.credits], [[`${D}/${G}/${TRIPOD}`, [{ uid_credit_note: "cn-tripod", number: 1051, uid_invoice: "inv-1", quantity: 1, reverses_billing: false }]]]);
  assertEquals(diff.unkeyed_credit_notes, [{ uid_credit_note: "cn-light", number: 1050, uid_invoice: "inv-1" }]);
});

Deno.test("documentDiff: a note naming two invoices cannot be keyed to a row, and is listed rather than dropped", () => {
  const inv = invoice("inv-1", [{ order: O, items: orderItems() }]);
  const cn = creditNote("cn-2src", 1060, ["inv-1", "inv-2"], [{ quantity: 1, path: LIGHT_ON_INVOICE }]);
  const diff = computeDocumentDiffs({ orders: [order()], invoices: [inv], creditNotes: [cn] }, { kind: "invoice", uid: "inv-1" }, CONTEXT);
  assertEquals(diff.credits.size, 0);
  assertEquals(diff.unkeyed_credit_notes, [{ uid_credit_note: "cn-2src", number: 1060, uid_invoice: null }]);
});
