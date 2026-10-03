/**
 * core#124 — an invoice owns the rows and pairs no order carries.
 *
 * The rule is the fulfillment's: **absent from BOTH orders ⇒ the invoice
 * authored it ⇒ it stays**; absent only from the next order ⇒ an order removal
 * ⇒ the override test. And its alignment half: a divider whose uid the order
 * carries nowhere, with everything beneath it, is the invoice's own section and
 * is no disagreement with the order's skeleton.
 *
 * Every expectation is written out by hand.
 */
import { assert, assertEquals } from "@std/assert";
import type { DocDestinationType, Invoice, InvoiceDocItemType, Order } from "../src/schemas/mod.ts";
import {
  buildOrderScopedItems,
  computeInvoiceItemPaths,
  computeOrderInvoiceCoverage,
  type InvoiceDestinationPair,
  type InvoiceItem,
  invoiceAuthoredSubtrees,
  invoiceScopeDividersMatch,
  type OrderInvoiceFieldSync,
  syncOrderDestinationScope,
  syncOrderToInvoiceSelective,
} from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type AccountedInvoice, invoicedByPath, remainingForOrder } from "../src/utils/quantityAccounting.ts";
import { computeDocumentDiffs, type DocumentDiffMap } from "../src/utils/documentDiff.ts";
import { interleaveStoredOnlyRows } from "../src/utils/stored-only-rows.ts";

const O = "order-1";
// Bare UUIDs, as stored dividers are.
const D = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a01";
const G = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a02";
const D_INV = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a11";
const G_INV = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a12";
const D2 = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a03";
const LIGHT = "prod-light";
const TRIPOD = "prod-tripod";
const STAND = "prod-stand";
const PF: OrderInvoiceFieldSync = { holidays: [] };

function line(uid: string, path: string[], quantity = 1, baseCents = 1000): LineItem {
  return {
    uid, type: "rental", name: uid, description: "", quantity, path,
    stock_method: "reserve", zero_priced: false, uid_tax_class: "TaxC1assDefau1tAAAAA",
    price: {
      base_cents: baseCents, chargeable_days: 5, formula: "five_day_week",
      subtotal_cents: baseCents * quantity, subtotal_discounted_cents: baseCents * quantity,
      discount: null, taxes: [], total_cents: baseCents * quantity, replacement_cents: 1000,
    },
  } as unknown as LineItem;
}
const dest = (uid: string, name = "Venue"): LineItem =>
  ({ uid, type: "destination", name, description: "", path: [uid] }) as unknown as LineItem;
const group = (uid: string, parent: string, name = "Grip"): LineItem =>
  ({ uid, type: "group", name, description: "", path: [parent, uid] }) as unknown as LineItem;

const START = "2026-09-06T00:00:00.000-05:00";
const END = "2026-09-11T00:00:00.000-05:00";
function pair(uid: string, extra: Record<string, unknown> = {}): DocDestinationType {
  return {
    uid,
    dates: { charge_windows: [{ start: START, end: END, days: 5 }] },
    delivery: { uid: `dlv-${uid}`, address: null, instructions: null, contact: null },
    collection: { uid: `col-${uid}`, address: null, instructions: null, contact: null },
    customer_collecting: false,
    customer_returning: false,
    jurisdiction: null,
    exchange: null,
    ...extra,
  } as unknown as DocDestinationType;
}
const scoped = (p: DocDestinationType): InvoiceDestinationPair => ({ uid_order: O, ...p }) as InvoiceDestinationPair;

/** The order: one leg D, a tripod straight on D, and a group G with a light. */
const orderItems = (): LineItem[] => [dest(D), line(TRIPOD, [D, TRIPOD]), group(G, D), line(LIGHT, [D, G, LIGHT], 2)];

/** An invoice-authored group G_INV under the order's leg D, with one stand in it. */
const authoredGroup = (): InvoiceDocItemType[] => [
  { ...group(G_INV, D, "Extras"), path: [O, D, G_INV] } as unknown as InvoiceDocItemType,
  { ...buildOrderScopedItems([line(STAND, [D, G_INV, STAND])], O)[0] },
];

/** An invoice-authored leg D_INV — divider, a line under it, and its pair. */
const authoredLeg = (): { items: InvoiceDocItemType[]; pair: InvoiceDestinationPair } => ({
  items: [
    { ...dest(D_INV, "Pickup"), path: [O, D_INV] } as unknown as InvoiceDocItemType,
    buildOrderScopedItems([line(STAND, [D_INV, STAND], 3)], O)[0],
  ],
  pair: scoped(pair(D_INV, { jurisdiction: "rantoul" })),
});

const keys = (items: readonly { path: readonly string[] }[]) => items.map((it) => it.path.join("/"));
const rename = <T extends { name: string }>(row: T, name: string): T => ({ ...row, name });

// ── 1a: rows ────────────────────────────────────────────────────────

Deno.test("🔴 sync: an invoice-authored GROUP and its line survive an order edit, where they stood", () => {
  // A second order group after G, so "where they stood" is between two order sections.
  const G2 = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a04";
  const prev = [...orderItems(), group(G2, D, "Electric"), line(TRIPOD, [D, G2, TRIPOD])];
  const next = prev.map((it) => it.path.join("/") === `${D}/${G2}/${TRIPOD}` ? rename(it, "Tripod v2") : it);
  const projected = buildOrderScopedItems(prev, O);
  const stored = [...projected.slice(0, 4), ...authoredGroup(), ...projected.slice(4)];

  const out = syncOrderToInvoiceSelective(prev, next, stored, O);
  assertEquals(keys(out), [
    `${O}/${D}`, `${O}/${D}/${TRIPOD}`, `${O}/${D}/${G}`, `${O}/${D}/${G}/${LIGHT}`,
    `${O}/${D}/${G_INV}`, `${O}/${D}/${G_INV}/${STAND}`,
    `${O}/${D}/${G2}`, `${O}/${D}/${G2}/${TRIPOD}`,
  ]);
  assertEquals(out.at(-1)!.name, "Tripod v2", "the order's own rows still follow it");
  const withDivider = [{ uid: O, type: "order", name: "", description: "", path: [O] } as InvoiceItem, ...out as InvoiceItem[]];
  assertEquals(keys(computeInvoiceItemPaths(withDivider)), keys(withDivider), "positions are a fixed point — nothing re-parented");
});

Deno.test("🔴 sync: an override kept by edit 1 survives edit 2 — a line, and a divider", () => {
  // Edit 1 removes the tripod and the group; the invoice renamed both, so both
  // are kept as overrides. By edit 2 they are on NEITHER order — the override
  // test has nothing left to compare against, and used to drop them.
  const v1 = orderItems();
  const v2 = [dest(D), line(LIGHT, [D, LIGHT], 2)];
  const v3 = [rename(dest(D), "Venue v3"), line(LIGHT, [D, LIGHT], 5)];
  const stored = buildOrderScopedItems(v1, O).map((it) =>
    it.uid === TRIPOD || it.uid === G ? rename(it, "OPERATOR") : it
  );

  const first = syncOrderToInvoiceSelective(v1, v2, stored, O);
  assert(first.some((it) => it.uid === TRIPOD), "edit 1 keeps the overridden line");
  assert(first.some((it) => it.uid === G), "edit 1 keeps the overridden divider");

  const second = syncOrderToInvoiceSelective(v2, v3, first, O);
  assertEquals(second.find((it) => it.uid === TRIPOD)?.name, "OPERATOR", "the line survives edit 2");
  assertEquals(second.find((it) => it.uid === G)?.name, "OPERATOR", "the divider survives edit 2");
  assertEquals(second.find((it) => it.uid === D)?.name, "Venue v3");
});

Deno.test("sync: a removed, UNEDITED order row still goes — the absent-from-both arm does not widen to it", () => {
  const prev = orderItems();
  const next = [dest(D), group(G, D), line(LIGHT, [D, G, LIGHT], 2)];
  const out = syncOrderToInvoiceSelective(prev, next, buildOrderScopedItems(prev, O), O);
  assertEquals(out.some((it) => it.uid === TRIPOD), false);
});

Deno.test("sync: a removed order GROUP stays exactly while an invoice-authored row hangs beneath it", () => {
  const prev = orderItems();
  const next = [dest(D), line(TRIPOD, [D, TRIPOD])];
  const projected = buildOrderScopedItems(prev, O);
  const stand = buildOrderScopedItems([line(STAND, [D, G, STAND])], O)[0];

  // With an authored stand under G: G stays (its light, the order's, goes),
  // and is emitted immediately before the stand, so the stand keeps its parent.
  const withStand = syncOrderToInvoiceSelective(prev, next, [...projected, stand], O);
  assertEquals(keys(withStand), [`${O}/${D}`, `${O}/${D}/${TRIPOD}`, `${O}/${D}/${G}`, `${O}/${D}/${G}/${STAND}`]);

  // Without one: G goes with the order. Both arms, so neither is vacuous.
  const without = syncOrderToInvoiceSelective(prev, next, projected, O);
  assertEquals(keys(without), [`${O}/${D}`, `${O}/${D}/${TRIPOD}`]);
});

// ── 1a + 1b: destinations ───────────────────────────────────────────

Deno.test("🔴 scope: an invoice-authored destination — pair, divider and line — survives an order edit, positions intact", () => {
  const prev = { items: orderItems(), destinations: [pair(D)] };
  const next = { items: orderItems().map((it) => it.uid === LIGHT ? { ...it, quantity: 4 } : it), destinations: [pair(D)] };
  const leg = authoredLeg();
  const items = [...buildOrderScopedItems(prev.items, O), ...leg.items];
  const r = syncOrderDestinationScope(prev, next, items, [scoped(pair(D)), leg.pair], O, PF);

  assertEquals(keys(r.scopedItems), [
    `${O}/${D}`, `${O}/${D}/${TRIPOD}`, `${O}/${D}/${G}`, `${O}/${D}/${G}/${LIGHT}`,
    `${O}/${D_INV}`, `${O}/${D_INV}/${STAND}`,
  ]);
  assertEquals((r.scopedItems[3] as InvoiceItem).quantity, 4, "the order's light followed the edit");
  assertEquals(r.destinations.map((p) => p.uid), [D, D_INV]);
  assertEquals(r.destinations[1].jurisdiction, "rantoul");
  assertEquals(r.dropped, []);

  // And again: a second edit is where an override used to be lost.
  const r2 = syncOrderDestinationScope(next, next, r.scopedItems, r.destinations, O, PF);
  assertEquals(keys(r2.scopedItems), keys(r.scopedItems));
  assertEquals(r2.destinations.map((p) => p.uid), [D, D_INV]);
});

Deno.test("🔴 scope: the order deletes leg D2 holding an invoice-authored group ⇒ D2, its pair and the group are kept", () => {
  const prev = { items: [...orderItems(), dest(D2, "Second"), line(TRIPOD, [D2, TRIPOD])], destinations: [pair(D), pair(D2)] };
  const next = { items: orderItems(), destinations: [pair(D)] };
  const projected = buildOrderScopedItems(prev.items, O);
  const extras: InvoiceDocItemType[] = [
    { ...group(G_INV, D2, "Extras"), path: [O, D2, G_INV] } as unknown as InvoiceDocItemType,
    buildOrderScopedItems([line(STAND, [D2, G_INV, STAND])], O)[0],
  ];
  const r = syncOrderDestinationScope(prev, next, [...projected, ...extras], [scoped(pair(D)), scoped(pair(D2))], O, PF);

  assertEquals(keys(r.scopedItems).filter((k) => k.includes(D2)), [`${O}/${D2}`, `${O}/${D2}/${G_INV}`, `${O}/${D2}/${G_INV}/${STAND}`]);
  assertEquals(r.destinations.map((p) => p.uid), [D, D2]);
  assertEquals(r.dropped, []);

  // Without the authored group, the same delete drops D2 whole.
  const clean = syncOrderDestinationScope(prev, next, projected, [scoped(pair(D)), scoped(pair(D2))], O, PF);
  assertEquals(clean.scopedItems.some((it) => it.uid === D2), false);
  assertEquals(clean.destinations.map((p) => p.uid), [D]);
  assertEquals(clean.dropped.map((d) => [d.uid, d.reason]), [[D2, "removed_from_order"]]);
});

// ── 1c: alignment and the readers ───────────────────────────────────

Deno.test("alignment: an invoice-authored group and leg are a SUPERSET of the skeleton — aligned", () => {
  const items = [...buildOrderScopedItems(orderItems(), O), ...authoredGroup(), ...authoredLeg().items] as InvoiceItem[];
  assertEquals(invoiceAuthoredSubtrees(items, orderItems(), O), [[D, G_INV], [D_INV]]);
  assertEquals(invoiceScopeDividersMatch(items, orderItems(), O), true);
});

Deno.test("alignment: a missing divider whose line is still pathed under it, or a MOVED one, is unaligned — the order's own divider is never excused", () => {
  // G gone, its light still at `D/G/LIGHT`: malformed, not declined (core#126).
  const missing = buildOrderScopedItems(orderItems(), O).filter((it) => it.uid !== G) as InvoiceItem[];
  assertEquals(invoiceScopeDividersMatch(missing, orderItems(), O), false, "missing");
  // G moved onto an invoice-authored leg: its uid is the order's, so it is not authored.
  const moved = [
    ...buildOrderScopedItems(orderItems(), O).filter((it) => it.uid !== G && it.uid !== LIGHT),
    ...authoredLeg().items,
    { ...group(G, D_INV), path: [O, D_INV, G] },
  ] as InvoiceItem[];
  assertEquals(invoiceAuthoredSubtrees(moved, orderItems(), O), [[D_INV]]);
  assertEquals(invoiceScopeDividersMatch(moved, orderItems(), O), false, "moved");
});

const divider = { uid: O, type: "order", name: "Order", description: "", path: [O] } as unknown as InvoiceItem;
function accounted(uid: string, scope: InvoiceDocItemType[]): AccountedInvoice {
  return {
    uid,
    status: "draft",
    items: [divider, ...(scope as unknown as InvoiceItem[])],
    destinations: [scoped(pair(D)), authoredLeg().pair] as never,
  };
}

Deno.test("🔴 accounting: an authored subtree credits NOTHING, and the remainder no longer refuses", () => {
  const order = orderItems();
  // The invoice bills 1 of 2 lights, the tripod, and its own group + leg.
  const scope = [
    ...buildOrderScopedItems(order, O).map((it) => it.uid === LIGHT ? { ...it, quantity: 1 } as InvoiceDocItemType : it),
    ...authoredGroup(),
    ...authoredLeg().items,
  ];
  const billed = invoicedByPath(O, order, [accounted("a", scope)]);
  assertEquals([billed.compared, billed.unaligned], [["a"], []]);
  assertEquals([...billed.byPath.keys()].sort(), [`${D}/${G}/${LIGHT}`, `${D}/${TRIPOD}`]);

  const remaining = remainingForOrder(O, order, [accounted("a", scope)], [pair(D)]);
  assertEquals(remaining.unaligned, []);
  assertEquals(remaining.lines.map((l) => [l.path.join("/"), l.quantity]), [[`${D}/${G}/${LIGHT}`, 1]]);

  const coverage = computeOrderInvoiceCoverage(O, order, [accounted("a", scope)]);
  assertEquals(coverage.unaligned, []);
  assertEquals(coverage.unmatched.map((u) => u.item.path!.join("/")).sort(), [
    `${O}/${D}/${G_INV}/${STAND}`, `${O}/${D_INV}/${STAND}`,
  ], "authored lines are extras");
});

// ── 1c: the diff ────────────────────────────────────────────────────

function summary(map: DocumentDiffMap["lines"] | DocumentDiffMap["pairs"]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, entries] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = entries.map((e) => e.kind === "quantity" ? `quantity(o${e.ordered} i${e.invoiced})` : `${e.source.kind}:${e.kind}`);
  }
  return out;
}

Deno.test("🔴 diff: an authored LEG reports once as a pair, its rows suppressed; an authored GROUP reports its lines", () => {
  const items = orderItems();
  const ord = { uid: O, number: 1001, version: 1, status: "reserved", items, destinations: [pair(D)] } as unknown as Order;
  const leg = authoredLeg();
  const inv = {
    uid: "inv-1",
    number: 2241,
    version: 1,
    status: "draft",
    items: [divider, ...buildOrderScopedItems(items, O), ...authoredGroup(), ...leg.items],
    destinations: [scoped(pair(D)), leg.pair],
  } as unknown as Invoice;
  const sources = { orders: [ord], invoices: [inv] };
  const ctx = { taxNameByUid: new Map<string, string>(), isOrderFrozen: () => false };

  const onInvoice = computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, ctx);
  assertEquals(onInvoice.unaligned, []);
  assertEquals(summary(onInvoice.pairs), { [`${O}/${D_INV}`]: ["order:not_on_source"] });
  assertEquals(summary(onInvoice.lines), { [`${O}/${D}/${G_INV}/${STAND}`]: ["order:not_on_source"] });

  const onOrder = computeDocumentDiffs(sources, { kind: "order", uid: O }, ctx);
  assertEquals(onOrder.unaligned, []);
  assertEquals(summary(onOrder.pairs), { [D_INV]: ["invoice:only_on_source"] });
  assertEquals(summary(onOrder.lines), { [`${D}/${G_INV}/${STAND}`]: ["invoice:only_on_source"] });
});

// ── The shared placement helper ─────────────────────────────────────

type Row = { uid: string; type: string; path: string[] };
const row = (type: string, ...path: string[]): Row => ({ uid: path.at(-1)!, type, path });

Deno.test("🔴 placement: a kept divider separated from its survivor by a projected line must not capture that line", () => {
  // Stored: D, G (order removed it), P (projected, under D directly), S (survivor under G).
  // Emitting G at its stored index would put P under G. G must sit right before S.
  const D_ = row("destination", "D"), G_ = row("group", "D", "G"), P = row("rental", "D", "P"), S = row("rental", "D", "G", "S");
  const out = interleaveStoredOnlyRows([D_, P], {
    stored: [D_, G_, P, S],
    survivors: new Set([S]),
    isLine: (r) => r.type === "rental",
  });
  assertEquals(out.map((r) => r.uid), ["D", "P", "G", "S"]);
  assertEquals(computeInvoiceItemPathsLike(out).map((r) => r.path.join("/")), ["D", "D/P", "D/G", "D/G/S"]);
});

Deno.test("placement: a removed divider with NO survivor beneath it is not emitted; a leading survivor goes first", () => {
  const G_ = row("group", "D", "G"), S = row("rental", "S"), D_ = row("destination", "D");
  const out = interleaveStoredOnlyRows([D_], { stored: [S, D_, G_], survivors: new Set([S]), isLine: (r) => r.type === "rental" });
  assertEquals(out.map((r) => r.uid), ["S", "D"]);
});

/** `computeItemPaths` at invoice depth, minus the `order` level the helper rows lack. */
function computeInvoiceItemPathsLike(rows: Row[]): Row[] {
  const withOrder = rows.map((r) => ({ ...r, path: [O, ...r.path] }));
  return computeInvoiceItemPaths([{ uid: O, type: "order", path: [O] } as never, ...withOrder as never[]])
    .slice(1)
    .map((r) => ({ ...(r as unknown as Row), path: (r as unknown as Row).path.slice(1) }));
}

// ── Phase 1b (core#126): a divider is decided like a line ───────────
//
// | | invoice has it | invoice lacks it |
// |---|---|---|
// | on prev and next order | merge per field | DECLINED: stays out |
// | new on next order | — | project it |
// | on prev only | override test | gone |
// | on neither | the invoice's own, stays | — |
//
// A divider exists while something under it does: a NEW order line beneath a
// declined divider re-opens it, every declined ancestor and the pair with it.

const G2 = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0a04";
/** The order with a second leg D2 holding a group G2 and a tripod. */
const twoLegOrder = (): LineItem[] => [
  ...orderItems(),
  dest(D2, "Second"),
  group(G2, D2, "Electric"),
  line(TRIPOD, [D2, G2, TRIPOD]),
];
const scopeOf = (items: LineItem[]) => ({ items, destinations: [pair(D), pair(D2)] });
/** The invoice bills leg D only: D2, its group, line and pair were declined. */
const legDOnly = () => ({
  items: buildOrderScopedItems(orderItems(), O),
  destinations: [scoped(pair(D))],
});

Deno.test("🔴 1b: a DECLINED group stays out across an order edit — it is not re-projected empty", () => {
  const prev = orderItems();
  const next = prev.map((it) => it.uid === TRIPOD ? rename(it, "Tripod v2") : it);
  // The invoice bills the tripod only: group G and its light were left out.
  const stored = buildOrderScopedItems(prev, O).filter((it) => it.uid !== G && it.uid !== LIGHT);
  const out = syncOrderToInvoiceSelective(prev, next, stored, O);
  assertEquals(keys(out), [`${O}/${D}`, `${O}/${D}/${TRIPOD}`]);
  assertEquals(out[1].name, "Tripod v2", "the billed line still follows the order");
});

Deno.test("🔴 1b: a DECLINED destination stays out — divider, group and pair (core#126's resurrection case)", () => {
  const prev = scopeOf(twoLegOrder());
  const next = scopeOf(twoLegOrder().map((it) => it.uid === LIGHT ? { ...it, quantity: 4 } : it));
  const inv = legDOnly();
  const r = syncOrderDestinationScope(prev, next, inv.items, inv.destinations, O, PF);
  assertEquals(keys(r.scopedItems), [`${O}/${D}`, `${O}/${D}/${TRIPOD}`, `${O}/${D}/${G}`, `${O}/${D}/${G}/${LIGHT}`]);
  assertEquals(r.destinations.map((p) => p.uid), [D]);
  assertEquals(r.dropped, []);
  // And it stays out on the edit after.
  const r2 = syncOrderDestinationScope(next, next, r.scopedItems, r.destinations, O, PF);
  assertEquals([keys(r2.scopedItems), r2.destinations.map((p) => p.uid)], [keys(r.scopedItems), [D]]);
});

Deno.test("🔴 1b: a NEW order line under a declined destination RE-OPENS it — divider, its group and pair, before the line", () => {
  const STAND_PATH = [D2, G2, STAND];
  const prev = scopeOf(twoLegOrder());
  const next = scopeOf([...twoLegOrder(), line(STAND, STAND_PATH)]);
  const inv = legDOnly();
  const r = syncOrderDestinationScope(prev, next, inv.items, inv.destinations, O, PF);
  assertEquals(keys(r.scopedItems).filter((k) => k.includes(D2)), [`${O}/${D2}`, `${O}/${D2}/${G2}`, `${O}/${D2}/${G2}/${STAND}`]);
  assertEquals(r.scopedItems.some((it) => it.uid === TRIPOD && it.path.includes(D2)), false, "the declined tripod stays out");
  assertEquals(r.destinations.map((p) => p.uid), [D, D2], "the pair re-opens with its divider");
  assertEquals(computeInvoiceItemPaths([{ ...divider } as InvoiceItem, ...r.scopedItems as InvoiceItem[]]).slice(1).map((it) => it.path.join("/")), keys(r.scopedItems), "a fixed point of the one path author");
});

Deno.test("1b: a group or destination NEW on the order is projected, even with nothing under it", () => {
  const prev = scopeOf(twoLegOrder().filter((it) => !it.path.includes(D2)));
  prev.destinations = [pair(D)];
  const next = scopeOf([...orderItems(), dest(D2, "Second")]);
  const inv = legDOnly();
  const r = syncOrderDestinationScope(prev, next, inv.items, inv.destinations, O, PF);
  assertEquals(keys(r.scopedItems).at(-1), `${O}/${D2}`);
  assertEquals(r.destinations.map((p) => p.uid), [D, D2]);
});

Deno.test("1b: a pair whose divider the invoice lacks while the order keeps it goes with its divider — reported, never silent", () => {
  const prev = scopeOf(twoLegOrder());
  const inv = legDOnly();
  const r = syncOrderDestinationScope(prev, prev, inv.items, [...inv.destinations, scoped(pair(D2))], O, PF);
  assertEquals(r.destinations.map((p) => p.uid), [D]);
  assertEquals(r.dropped.map((d) => [d.uid, d.reason]), [[D2, "divider_absent"]]);
});

Deno.test("🔴 1b alignment: a declined group or leg is aligned; billing its line ELSEWHERE is not", () => {
  const order = twoLegOrder();
  const declined = buildOrderScopedItems(orderItems(), O) as InvoiceItem[];
  assertEquals(invoiceScopeDividersMatch(declined, order, O), true, "D2 declined");
  const noGroup = declined.filter((it) => it.uid !== G && it.uid !== LIGHT);
  assertEquals(invoiceScopeDividersMatch(noGroup, order, O), true, "G declined too");
  // D2's tripod billed under D instead: its uid is under a missing divider at a path the order lacks.
  const elsewhere = [...declined, ...buildOrderScopedItems([line(TRIPOD, [D, G, TRIPOD])], O)] as InvoiceItem[];
  assertEquals(invoiceScopeDividersMatch(elsewhere, order, O), false, "billed elsewhere");
  // …and on an invoice-authored leg: the regroup core#125 has no pointer for yet.
  const onAuthored = [...declined, ...authoredLeg().items, ...buildOrderScopedItems([line(TRIPOD, [D_INV, TRIPOD])], O)] as InvoiceItem[];
  assertEquals(invoiceScopeDividersMatch(onAuthored, order, O), false, "billed on an authored leg");
});

Deno.test("🔴 1b accounting: a declined leg's lines read UNBILLED and the remainder bills them — once", () => {
  const order = twoLegOrder();
  const billed: AccountedInvoice = {
    uid: "a",
    status: "issued",
    items: [divider, ...(buildOrderScopedItems(orderItems(), O) as unknown as InvoiceItem[])],
    destinations: [scoped(pair(D))] as never,
  };
  const { lines, unaligned } = remainingForOrder(O, order, [billed], [pair(D), pair(D2)]);
  assertEquals(unaligned, []);
  assertEquals(lines.map((l) => [l.path.join("/"), l.quantity]), [[`${D2}/${G2}/${TRIPOD}`, 1]]);
});
