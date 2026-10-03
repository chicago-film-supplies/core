/**
 * core#125 — an invoice line moved inside its own order block still bills its
 * order line, through `path_order_item`.
 *
 * The order is `D / Grip / C-stand ×4` plus `D / Misc / Tripod`; the invoice
 * dragged the C-stand into Misc. Without the pointer the C-stand bills nothing
 * (its order line reads uninvoiced), order edits never reach it, and the diff
 * reports two unrelated rows. With it the row IS order line X, where it stands.
 *
 * Every expectation is written out by hand.
 */
import { assert, assertEquals } from "@std/assert";
import type { DocDestinationType, Invoice, InvoiceDocItemType, Order } from "../src/schemas/mod.ts";
import { CreditNoteDocLineItem, InvoiceDocLineItem, InvoiceItemInputLine } from "../src/schemas/mod.ts";
import { getInitialValues } from "../src/schemas/initial.ts";
import {
  buildOrderScopedItems,
  carryForwardOverrides,
  computeInvoiceSyncStatus,
  computeOrderInvoiceCoverage,
  type InvoiceDestinationPair,
  type InvoiceItem,
  invoiceItemDifferences,
  invoiceScopeDividersMatch,
  orderLineClaimIssues,
  orderLineClaims,
  syncOrderToInvoiceSelective,
} from "../src/utils/invoices.ts";
import type { LineItem } from "../src/utils/orders.ts";
import { type AccountedInvoice, invoicedByPath, remainingForOrder } from "../src/utils/quantityAccounting.ts";
import { computeDocumentDiffs, type DocumentDiffMap } from "../src/utils/documentDiff.ts";

const O = "Order1AAAAAAAAAAAAAA";
const D = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0b01";
const GRIP = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0b02";
const MISC = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0b03";
const NEWG = "0b6c3a51-6c1a-4f0e-9a51-6f1f2b9d0b04";
const CSTAND = "ProdCstandAAAAAAAAAA";
const TRIPOD = "ProdTripodAAAAAAAAAA";
const ARM = "ProdArmAAAAAAAAAAAAA";

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
const dest = (uid: string): LineItem => ({ uid, type: "destination", name: "Venue", description: "", path: [uid] }) as unknown as LineItem;
const group = (uid: string, name: string): LineItem =>
  ({ uid, type: "group", name, description: "", path: [D, uid] }) as unknown as LineItem;

const X = [D, GRIP, CSTAND];
const AT = [D, MISC, CSTAND];

/** The order: Grip holds the C-stand ×4, Misc holds a tripod. */
const orderItems = (cstand: Partial<LineItem> = {}): LineItem[] => [
  dest(D),
  group(GRIP, "Grip"),
  { ...line(CSTAND, X, 4), ...cstand },
  group(MISC, "Misc"),
  line(TRIPOD, [D, MISC, TRIPOD]),
];

const keys = (items: readonly { path: readonly string[] }[]) => items.map((it) => it.path.join("/"));
const byKey = (items: readonly InvoiceDocItemType[], k: string[]) =>
  items.find((it) => it.path.join("/") === [O, ...k].join("/")) as InvoiceItem | undefined;
const pointer = (row: InvoiceItem | InvoiceDocItemType | undefined) => (row as InvoiceItem | undefined)?.path_order_item;

/**
 * The invoice after an operator dragged the C-stand from Grip into Misc:
 * projected, the C-stand row lifted out and re-stated under Misc with its pointer.
 * `keepGrip: false` drops the now-empty Grip divider too.
 */
function movedInvoice(order: LineItem[] = orderItems(), opts: { quantity?: number; keepGrip?: boolean } = {}): InvoiceDocItemType[] {
  const projected = buildOrderScopedItems(order, O);
  const cstand = projected.find((it) => it.uid === CSTAND)! as InvoiceItem;
  const rest = projected.filter((it) => it.uid !== CSTAND && (opts.keepGrip !== false || it.uid !== GRIP));
  return [
    ...rest,
    { ...cstand, path: [O, ...AT], quantity: opts.quantity ?? cstand.quantity, path_order_item: [...X] } as InvoiceDocItemType,
  ];
}

// ── The reader ──────────────────────────────────────────────────────

Deno.test("claims: a root claims its order line, a component follows by suffix, a self-pointer claims nothing", () => {
  const kit = [
    ...movedInvoice(),
    buildOrderScopedItems([line(ARM, [...AT, ARM])], O)[0],
    { ...buildOrderScopedItems([line(TRIPOD, [D, MISC, TRIPOD])], O)[0], path_order_item: [D, MISC, TRIPOD] } as InvoiceDocItemType,
  ] as InvoiceItem[];
  assertEquals([...orderLineClaims(kit, O)], [
    [AT.join("/"), X],
    [[...AT, ARM].join("/"), [...X, ARM]],
  ]);
});

// ── The sync ────────────────────────────────────────────────────────

Deno.test("🔴 sync: a moved line follows X's quantity and name, stays where the operator put it, keeps its pointer", () => {
  const prev = orderItems();
  const next = orderItems({ quantity: 6, name: "C-stand 40in" });
  const out = syncOrderToInvoiceSelective(prev, next, movedInvoice(), O);
  assertEquals(keys(out), [`${O}/${D}`, `${O}/${D}/${GRIP}`, `${O}/${D}/${MISC}`, `${O}/${D}/${MISC}/${TRIPOD}`, `${O}/${[...AT].join("/")}`]);
  const row = byKey(out, AT)!;
  assertEquals([row.quantity, row.name, pointer(row)], [6, "C-stand 40in", X]);
  assertEquals(byKey(out, X), undefined, "X is not re-projected at its own path");
});

Deno.test("sync: an UNCHANGED order leaves the moved line exactly as stored", () => {
  const stored = movedInvoice();
  assertEquals(syncOrderToInvoiceSelective(orderItems(), orderItems(), stored, O), stored);
});

Deno.test("🔴 sync: X moves on the order ⇒ the pointer re-points; the row stays put", () => {
  const prev = orderItems();
  const next = [dest(D), group(NEWG, "Lighting"), line(CSTAND, [D, NEWG, CSTAND], 4), group(MISC, "Misc"), line(TRIPOD, [D, MISC, TRIPOD])];
  const out = syncOrderToInvoiceSelective(prev, next, movedInvoice(), O);
  assertEquals(pointer(byKey(out, AT)), [D, NEWG, CSTAND]);
  assertEquals(byKey(out, [D, NEWG, CSTAND]), undefined, "X's new position is still held out");
});

Deno.test("sync: the order moves X onto the row's own position ⇒ the pointer clears", () => {
  const prev = orderItems();
  const next = [dest(D), group(GRIP, "Grip"), group(MISC, "Misc"), line(TRIPOD, [D, MISC, TRIPOD]), line(CSTAND, AT, 5)];
  const out = syncOrderToInvoiceSelective(prev, next, movedInvoice(), O);
  const row = byKey(out, AT)!;
  assertEquals([row.quantity, pointer(row)], [5, undefined]);
  assertEquals(out.filter((it) => it.uid === CSTAND).length, 1);
});

Deno.test("🔴 sync: X removed — an unedited moved line goes; an overridden one stays, its pointer dropped (Q2)", () => {
  const prev = orderItems();
  const next = prev.filter((it) => it.uid !== CSTAND);
  assertEquals(byKey(syncOrderToInvoiceSelective(prev, next, movedInvoice(), O), AT), undefined, "unedited: gone with X");

  const kept = byKey(syncOrderToInvoiceSelective(prev, next, movedInvoice(prev, { quantity: 3 }), O), AT);
  assertEquals([kept?.quantity, pointer(kept)], [3, undefined], "overridden: kept, plainly invoice-authored");
});

Deno.test("sync: X removed takes the moved kit's components with it", () => {
  const prev = [...orderItems(), line(ARM, [...X, ARM], 4)];
  // Components follow their parent in the order array: put ARM right after the C-stand.
  prev.splice(3, 0, prev.pop()!);
  const stored = [...movedInvoice(prev), buildOrderScopedItems([line(ARM, [...AT, ARM], 4)], O)[0]];
  const next = prev.filter((it) => it.uid !== CSTAND && it.uid !== ARM);
  const out = syncOrderToInvoiceSelective(prev, next, stored, O);
  assertEquals(out.filter((it) => it.uid === CSTAND || it.uid === ARM), []);
});

Deno.test("🔴 sync: two rows claiming X (Q1) — a split pair does not follow a quantity edit; equal copies both do", () => {
  const prev = orderItems();
  const next = orderItems({ quantity: 6 });
  const own = buildOrderScopedItems(prev, O).find((it) => it.uid === CSTAND)!;

  // Split 2 + 2: both differ from the order's 4, so both read overridden.
  const split = [...movedInvoice(prev, { quantity: 2 })];
  split.splice(2, 0, { ...own, quantity: 2 } as InvoiceDocItemType);
  const s = syncOrderToInvoiceSelective(prev, next, split, O);
  assertEquals([byKey(s, X)?.quantity, byKey(s, AT)?.quantity], [2, 2]);

  // Two full copies: both still equal the order, so both follow — a visible over-bill.
  const copies = [...movedInvoice(prev)];
  copies.splice(2, 0, own);
  const c = syncOrderToInvoiceSelective(prev, next, copies, O);
  assertEquals([byKey(c, X)?.quantity, byKey(c, AT)?.quantity], [6, 6]);
});

// ── Coverage and accounting ─────────────────────────────────────────

const divider = { uid: O, type: "order", name: "Order", description: "", path: [O] } as unknown as InvoiceItem;
const START = "2026-09-06T00:00:00.000-05:00";
const END = "2026-09-11T00:00:00.000-05:00";
const pair = (): DocDestinationType => ({
  uid: D,
  dates: { charge_windows: [{ start: START, end: END, days: 5 }] },
  delivery: { uid: `dlv-${D}`, address: null, instructions: null, contact: null },
  collection: { uid: `col-${D}`, address: null, instructions: null, contact: null },
  customer_collecting: false, customer_returning: false, jurisdiction: null, exchange: null,
}) as unknown as DocDestinationType;
const invoicePair = () => ({ uid_order: O, ...pair() }) as InvoiceDestinationPair;
const accounted = (scope: InvoiceDocItemType[]): AccountedInvoice => ({
  uid: "a", status: "issued", items: [divider, ...(scope as unknown as InvoiceItem[])], destinations: [invoicePair()] as never,
});

Deno.test("🔴 coverage: the moved line covers X — not uninvoiced, not an extra, and the remainder does not re-offer it", () => {
  const order = orderItems();
  const inv = accounted(movedInvoice());
  const coverage = computeOrderInvoiceCoverage(O, order, [inv]);
  assertEquals([coverage.unaligned, coverage.uninvoiced, coverage.unmatched], [[], [], []]);

  const billed = invoicedByPath(O, order, [inv]);
  assertEquals(billed.byPath.get(X.join("/"))?.quantity, 4);
  assertEquals(billed.byPath.has(AT.join("/")), false);

  assertEquals(remainingForOrder(O, order, [inv], [pair()]).lines, []);
});

Deno.test("coverage: claims are SUMMED — a split bills X in full, two copies over-bill it", () => {
  const order = orderItems();
  const own = buildOrderScopedItems(order, O).find((it) => it.uid === CSTAND)!;
  const split = [...movedInvoice(order, { quantity: 1 })];
  split.splice(2, 0, { ...own, quantity: 3 } as InvoiceDocItemType);
  assertEquals(invoicedByPath(O, order, [accounted(split)]).byPath.get(X.join("/"))?.quantity, 4);

  const copies = [...movedInvoice(order)];
  copies.splice(2, 0, own);
  assertEquals(invoicedByPath(O, order, [accounted(copies)]).byPath.get(X.join("/"))?.quantity, 8);
});

Deno.test("🔴 alignment: X's emptied group gone from the invoice — aligned WITH the pointer, unaligned without", () => {
  const order = orderItems();
  const noGrip = movedInvoice(order, { keepGrip: false }) as InvoiceItem[];
  assertEquals(invoiceScopeDividersMatch(noGrip, order, O), true, "the pointer says which line it bills");
  const unpointed = noGrip.map((it) => {
    const { path_order_item: _, ...rest } = it;
    return rest as InvoiceItem;
  });
  assertEquals(invoiceScopeDividersMatch(unpointed, order, O), false, "no pointer: billed elsewhere, fail closed");
});

Deno.test("🔴 accounting: a moved line in an invoice-AUTHORED group (a split's new group) still bills X", () => {
  const order = orderItems();
  const own = buildOrderScopedItems(order, O).find((it) => it.uid === CSTAND)!;
  const scope = [
    ...buildOrderScopedItems(order, O).map((it) => it.uid === CSTAND ? { ...it, quantity: 3 } as InvoiceDocItemType : it),
    { ...group(NEWG, "New Group"), path: [O, D, NEWG] } as unknown as InvoiceDocItemType,
    { ...own, quantity: 1, path: [O, D, NEWG, CSTAND], path_order_item: [...X] } as InvoiceDocItemType,
  ];
  const billed = invoicedByPath(O, order, [accounted(scope)]);
  assertEquals([billed.unaligned, billed.byPath.get(X.join("/"))?.quantity], [[], 4]);
});

// ── The diff ────────────────────────────────────────────────────────

function summary(map: DocumentDiffMap["lines"]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, entries] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    out[k] = entries.map((e) =>
      e.kind === "quantity"
        ? `quantity(o${e.ordered} i${e.invoiced})`
        : e.kind === "moved"
        ? `${e.source.kind}:moved(${e.row} → ${e.order_line}${e.fields.length ? ` ${e.fields.map((f) => f.field).join(",")}` : ""})`
        : `${e.source.kind}:${e.kind}`
    );
  }
  return out;
}

function documents(scope: InvoiceDocItemType[]) {
  const items = orderItems();
  const ord = { uid: O, number: 1001, version: 1, status: "reserved", items, destinations: [pair()] } as unknown as Order;
  const inv = {
    uid: "inv-1", number: 2241, version: 1, status: "draft", items: [divider, ...scope], destinations: [invoicePair()],
  } as unknown as Invoice;
  return { orders: [ord], invoices: [inv] };
}
const ctx = { taxNameByUid: new Map<string, string>(), isOrderFrozen: () => false };

Deno.test("🔴 diff: ONE moved entry per side for a move — no not_on_source, no unbilled X", () => {
  const sources = documents(movedInvoice());
  const onInvoice = computeDocumentDiffs(sources, { kind: "invoice", uid: "inv-1" }, ctx);
  assertEquals(summary(onInvoice.lines), {
    [`${O}/${AT.join("/")}`]: [`order:moved(${O}/${AT.join("/")} → ${O}/${X.join("/")})`],
  });
  const onOrder = computeDocumentDiffs(sources, { kind: "order", uid: O }, ctx);
  assertEquals(summary(onOrder.lines), { [X.join("/")]: [`invoice:moved(${AT.join("/")} → ${X.join("/")})`] });
});

Deno.test("diff: a moved line's TERMS are compared against X; an over-bill across two claims is one quantity entry", () => {
  const order = orderItems();
  const own = buildOrderScopedItems(order, O).find((it) => it.uid === CSTAND)!;
  const scope = movedInvoice(order).map((it) => it.uid === CSTAND ? { ...it, name: "Operator's C-stand" } : it);
  scope.splice(2, 0, own);
  const onOrder = computeDocumentDiffs(documents(scope), { kind: "order", uid: O }, ctx);
  assertEquals(summary(onOrder.lines), {
    [X.join("/")]: [`invoice:moved(${AT.join("/")} → ${X.join("/")} name)`, "quantity(o4 i8)"],
  });
});

// ── The write-time check (D3) ───────────────────────────────────────

Deno.test("🔴 D3: a pointer must sit in an order block and name a LINE of that order; unchanged ones are grandfathered", () => {
  const order = orderItems();
  const lines = (uid: string) => uid === O ? order : undefined;
  const items = [divider, ...movedInvoice(order)] as InvoiceItem[];
  assertEquals(orderLineClaimIssues(items, lines), [], "a valid move");

  const at = items.length - 1;
  const toGroup = items.map((it, i) => i === at ? { ...it, path_order_item: [D, GRIP] } : it);
  assertEquals(orderLineClaimIssues(toGroup, lines).map((i) => i.reason), ["not_a_line"], "a divider is not a line");
  const gone = items.map((it, i) => i === at ? { ...it, path_order_item: [D, GRIP, ARM] } : it);
  assertEquals(orderLineClaimIssues(gone, lines).map((i) => i.reason), ["not_a_line"]);
  assertEquals(orderLineClaimIssues(gone, lines, gone), [], "stored unchanged: the sync answers it, not a refusal");
  assertEquals(orderLineClaimIssues(items, () => undefined).map((i) => i.reason), ["order_unknown"]);

  // A standalone invoice: no order divider at all.
  const standalone = [{ ...byKey(movedInvoice(order), AT)!, path: [D, CSTAND] }] as InvoiceItem[];
  assertEquals(orderLineClaimIssues(standalone, lines).map((i) => i.reason), ["outside_order_block"]);
});

// ── The sync badge ──────────────────────────────────────────────────

Deno.test("🔴 badge: the moved row is compared against X where it stands; X gets no phantom entry", () => {
  const order = orderItems();
  const context = { taxNameByUid: new Map<string, string>(), orderFrozen: false, invoiceChargeWindows: [] };
  const status = computeInvoiceSyncStatus(movedInvoice(order) as InvoiceItem[], order, O, context as never);
  assertEquals(status.get([O, ...AT].join("/")), "in_sync");
  assertEquals(status.has([O, ...X].join("/")), false);

  const renamed = movedInvoice(order).map((it) => it.uid === CSTAND ? { ...it, name: "Operator's" } : it);
  assertEquals(computeInvoiceSyncStatus(renamed as InvoiceItem[], order, O, context as never).get([O, ...AT].join("/")), "out_of_sync");
});

// ── The field ───────────────────────────────────────────────────────

Deno.test("field: the comparator ignores it, and a uid-keyed carry-forward does NOT spread it to another occurrence", () => {
  const stored = byKey(movedInvoice(), AT)!;
  const { path_order_item: _, ...bare } = stored;
  assertEquals(invoiceItemDifferences(bare as InvoiceItem, stored), []);
  const rebuilt = buildOrderScopedItems(orderItems(), O);
  const carried = carryForwardOverrides(rebuilt, [stored]).find((it) => it.uid === CSTAND)!;
  assertEquals(pointer(carried), undefined);
});

Deno.test("field: the stored line requires a non-empty path when present; the input line keeps it", () => {
  const stored = byKey(movedInvoice(), AT)!;
  assert(InvoiceDocLineItem.safeParse(stored).success);
  assertEquals(InvoiceDocLineItem.safeParse({ ...stored, path_order_item: [] }).success, false);
  const input = InvoiceItemInputLine.parse({ uid: CSTAND, type: "rental", path: [O, ...AT], path_order_item: X });
  assertEquals(input.path_order_item, X);
});

Deno.test("seed: `.meta({ seed: false })` omits a .min(1) pointer from the form seed — both grains", () => {
  assertEquals("path_order_item" in (getInitialValues(InvoiceDocLineItem) as object), false);
  assertEquals("path_order_item" in (getInitialValues(InvoiceItemInputLine) as object), false);
  assertEquals("path_invoice_item" in (getInitialValues(CreditNoteDocLineItem) as object), false);
});
