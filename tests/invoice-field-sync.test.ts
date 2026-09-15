/**
 * The per-field order → invoice sync (api-cloudrun#890, Step 2 of
 * `api-cloudrun/.claude/plans/order-propagation-overrides.md`).
 *
 * Each case that fixes a row-mode defect runs the ROW mode too and asserts it
 * gets the case wrong — otherwise a fixture that never reaches the defect would
 * pass both ways and prove nothing.
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  buildOrderScopedItems,
  type InvoiceDestinationPair,
  type OrderInvoiceFieldSync,
  orderInvoiceSharedFields,
  syncOrderDestinationScope,
} from "../src/utils/invoices.ts";
import { getDuration } from "../src/utils/dates.ts";
import type { LineItem } from "../src/utils/orders.ts";
import type { DocDestinationType, InvoiceDocItemType } from "../src/schemas/mod.ts";

const ORDER = "00000000-0000-4000-8000-00000000d101";
const DEST_A = "00000000-0000-4000-8000-0000000de501";
const DEST_B = "00000000-0000-4000-8000-0000000de502";
const CHAIR = "Chair000000000000001";
const LAMP = "Lamp0000000000000001";
const TAX_CLASS = "TaxC1assDefau1tAAAAA";

const FIELD: OrderInvoiceFieldSync = { perField: true, holidays: [] };
const BOTH = { items: true, destinations: true };

const iso = (day: number, time = "00:00:00") => `2026-10-${String(day).padStart(2, "0")}T${time}.000-05:00`;
const daysFor = (from: string, to: string) => getDuration({ delivery_start: from, collection_start: to }, []).chargeDays;
const activeFor = (from: string, to: string) => getDuration({ delivery_start: from, collection_start: to }, []).activeDays;

/** A pair's `dates`. `tag` marks every `_fs` so a test can tell which side one came from. */
function dates(from: string, to: string, tag: number) {
  const fs = (s: string) => ({ seconds: Date.parse(s) / 1000, nanoseconds: tag });
  return {
    delivery_start: from, delivery_start_fs: fs(from),
    delivery_end: from, delivery_end_fs: fs(from),
    collection_start: to, collection_start_fs: fs(to),
    collection_end: to, collection_end_fs: fs(to),
    charge_start: null, charge_start_fs: null,
    charge_end: null, charge_end_fs: null,
    days_active: activeFor(from, to),
    days_charged: daysFor(from, to),
  };
}

type Dates = ReturnType<typeof dates>;

function pair(uid: string, d: Dates, over: Partial<{ instructions: string; jurisdiction: string | null }> = {}): DocDestinationType {
  return {
    uid,
    dates: d,
    delivery: { uid: "Delivery000000000001", address: null, instructions: over.instructions ?? null, contact: null },
    collection: { uid: "Collect0000000000001", address: null, instructions: null, contact: null },
    customer_collecting: false,
    customer_returning: false,
    jurisdiction: over.jurisdiction ?? null,
  } as unknown as DocDestinationType;
}

function divider(dest: string): LineItem {
  return { uid: dest, type: "destination", name: "Stage", description: "", path: [dest] } as unknown as LineItem;
}

function line(uid: string, dest: string, over: { quantity?: number; name?: string; days?: number | null; base?: number } = {}): LineItem {
  return {
    uid,
    type: "rental",
    uid_tax_class: TAX_CLASS,
    name: over.name ?? "Folding chair",
    description: "",
    quantity: over.quantity ?? 2,
    path: [dest, uid],
    stock_method: "reserve",
    order_number: 1001,
    uid_order: "Order000000000000001",
    zero_priced: false,
    price: {
      base_cents: over.base ?? 1000, replacement_cents: 5000, base_percent: null,
      chargeable_days: over.days === undefined ? 5 : over.days,
      formula: "five_day_week", subtotal_cents: 0, subtotal_discounted_cents: 0,
      discount: null, taxes: [], total_cents: 0,
    },
  } as unknown as LineItem;
}

interface OrderShape {
  items: LineItem[];
  destinations: DocDestinationType[];
}

/** The invoice a clean create would write from `order`: its scope (no order divider) and its pairs. */
function invoiceOf(order: OrderShape) {
  return {
    items: buildOrderScopedItems(order.items, ORDER).filter((it) => it.type !== "order"),
    destinations: order.destinations.map((p) => ({ uid_order: ORDER, ...p }) as unknown as InvoiceDestinationPair),
  };
}

type Row = Record<string, unknown> & { uid: string; path: string[]; price?: Record<string, unknown> };
const rows = (items: readonly InvoiceDocItemType[]) => items as unknown as Row[];
const lineAt = (items: readonly InvoiceDocItemType[], uid: string) => rows(items).filter((r) => r.uid === uid);

function sync(prev: OrderShape, next: OrderShape, inv: ReturnType<typeof invoiceOf>, mode?: OrderInvoiceFieldSync) {
  return syncOrderDestinationScope(prev, next, inv.items, inv.destinations, ORDER, BOTH, mode);
}

const WINDOW: [string, string] = [iso(5), iso(9)];

Deno.test("orderInvoiceSharedFields: classified once, nothing unhandled", () => {
  const a = orderInvoiceSharedFields();
  assert(a === orderInvoiceSharedFields(), "memoized");
  assert(a.line.some((f) => f.path === "quantity" && f.kind === "propagated"));
  assert(a.pair.some((f) => f.path === "dates.delivery_start" && f.kind === "propagated"));
  assert(a.doc.some((f) => f.path === "organization" && f.kind === "atom"));
});

// ── Items ────────────────────────────────────────────────────────────────────

Deno.test("per field: the folding chair — an invoice at 2 follows 2 → 3; an invoice at 4 keeps 4 and still takes the new price", () => {
  const d = dates(...WINDOW, 0);
  const prev = { items: [divider(DEST_A), line(CHAIR, DEST_A, { quantity: 2 })], destinations: [pair(DEST_A, d)] };
  const next = { items: [divider(DEST_A), line(CHAIR, DEST_A, { quantity: 3, base: 1500 })], destinations: [pair(DEST_A, d)] };

  const unedited = invoiceOf(prev);
  const followed = lineAt(sync(prev, next, unedited, FIELD).scopedItems, CHAIR);
  assertEquals(followed.length, 1);
  assertEquals([followed[0].quantity, followed[0].price?.base_cents], [3, 1500]);

  const edited = invoiceOf(prev);
  (rows(edited.items).find((r) => r.uid === CHAIR)!).quantity = 4;
  const kept = lineAt(sync(prev, next, edited, FIELD).scopedItems, CHAIR);
  assertEquals([kept[0].quantity, kept[0].price?.base_cents], [4, 1500], "quantity kept, price followed (G1)");

  // Companion: the row mode freezes the whole line on the one override.
  assertEquals(lineAt(sync(prev, next, edited).scopedItems, CHAIR)[0].price?.base_cents, 1000);
});

Deno.test("per field: a line that differs only in DERIVED money still follows the order (G2)", () => {
  const d = dates(...WINDOW, 0);
  const prev = { items: [divider(DEST_A), line(CHAIR, DEST_A)], destinations: [pair(DEST_A, d)] };
  const next = { items: [divider(DEST_A), line(CHAIR, DEST_A, { name: "Padded chair" })], destinations: [pair(DEST_A, d)] };
  const inv = invoiceOf(prev);
  const stored = rows(inv.items).find((r) => r.uid === CHAIR)!;
  stored.price = { ...stored.price, total_cents: 1150, taxes_base: [{ uid: "t", name: "Tax", rate: 15, type: "percent" }] };

  assertEquals(lineAt(sync(prev, next, inv, FIELD).scopedItems, CHAIR)[0].name, "Padded chair");
  assertEquals(lineAt(sync(prev, next, inv).scopedItems, CHAIR)[0].name, "Folding chair", "companion: the row mode reads money as an edit");
});

Deno.test("per field: a line the order removed is dropped unless a shared field was overridden", () => {
  const d = dates(...WINDOW, 0);
  const prev = { items: [divider(DEST_A), line(CHAIR, DEST_A), line(LAMP, DEST_A)], destinations: [pair(DEST_A, d)] };
  const next = { items: [divider(DEST_A)], destinations: [pair(DEST_A, d)] };
  const inv = invoiceOf(prev);
  const chair = rows(inv.items).find((r) => r.uid === CHAIR)!;
  chair.price = { ...chair.price, total_cents: 999 }; // derived only
  rows(inv.items).find((r) => r.uid === LAMP)!.quantity = 9; // a real override

  const out = sync(prev, next, inv, FIELD).scopedItems;
  assertEquals(lineAt(out, CHAIR).length, 0, "derived-only difference is not an override");
  assertEquals(lineAt(out, LAMP).length, 1);
  assertEquals(lineAt(sync(prev, next, inv).scopedItems, CHAIR).length, 1, "companion: the row mode keeps it");
});

Deno.test("per field: a line the order MOVED appears once, at its new path, keeping its invoice-only fields (G3)", () => {
  const d = dates(...WINDOW, 0);
  const prev = {
    items: [divider(DEST_A), line(CHAIR, DEST_A), divider(DEST_B)],
    destinations: [pair(DEST_A, d), pair(DEST_B, d)],
  };
  const next = {
    items: [divider(DEST_A), divider(DEST_B), line(CHAIR, DEST_B, { name: "Moved chair" })],
    destinations: [pair(DEST_A, d), pair(DEST_B, d)],
  };
  const inv = invoiceOf(prev);
  const stored = rows(inv.items).find((r) => r.uid === CHAIR)!;
  Object.assign(stored, { quantity: 4, xero_id: "LineXero", coa_revenue: 4010 });

  const moved = lineAt(sync(prev, next, inv, FIELD).scopedItems, CHAIR);
  assertEquals(moved.length, 1, "one line, not two");
  assertEquals(moved[0].path, [ORDER, DEST_B, CHAIR]);
  assertEquals([moved[0].quantity, moved[0].xero_id, moved[0].coa_revenue, moved[0].name], [4, "LineXero", 4010, "Moved chair"]);

  assertEquals(lineAt(sync(prev, next, inv).scopedItems, CHAIR).length, 2, "companion: the row mode bills it twice");
});

Deno.test("per field: when the order did not change, the scope comes back unchanged", () => {
  const d = dates(...WINDOW, 0);
  const order = { items: [divider(DEST_A), line(CHAIR, DEST_A), line(LAMP, DEST_A)], destinations: [pair(DEST_A, d)] };
  const inv = invoiceOf(order);
  Object.assign(rows(inv.items).find((r) => r.uid === CHAIR)!, { quantity: 7, xero_id: "x" });
  (inv.destinations[0] as unknown as Record<string, unknown>).jurisdiction = "rantoul";

  const out = sync(order, structuredClone(order), inv, FIELD);
  assertEquals(out.scopedItems, inv.items);
  assertEquals(out.destinations, inv.destinations);
});

// ── Pairs ────────────────────────────────────────────────────────────────────

Deno.test("per field: a pair keeps its jurisdiction override while its delivery follows the order (G7)", () => {
  const d = dates(...WINDOW, 0);
  const prev = { items: [divider(DEST_A)], destinations: [pair(DEST_A, d, { instructions: "old" })] };
  const next = { items: [divider(DEST_A)], destinations: [pair(DEST_A, d, { instructions: "new", jurisdiction: "chicago" })] };
  const inv = invoiceOf(prev);
  (inv.destinations[0] as unknown as Record<string, unknown>).jurisdiction = "frankfort";

  const out = sync(prev, next, inv, FIELD).destinations[0] as unknown as { jurisdiction: string; delivery: { instructions: string } };
  assertEquals([out.jurisdiction, out.delivery.instructions], ["frankfort", "new"]);
});

Deno.test("per field: pair dates merge per leaf — a mixed window takes each _fs from its side and recomputes the days (G6)", () => {
  const prev = { items: [divider(DEST_A)], destinations: [pair(DEST_A, dates(iso(5), iso(9), 1))] };
  const next = { items: [divider(DEST_A)], destinations: [pair(DEST_A, dates(iso(5), iso(16), 2))] };
  const inv = invoiceOf(prev);
  const storedDates = { ...dates(iso(6), iso(9), 3) }; // the invoice moved delivery to the 6th
  (inv.destinations[0] as unknown as Record<string, unknown>).dates = storedDates;

  const out = (sync(prev, next, inv, FIELD).destinations[0] as unknown as { dates: Record<string, { nanoseconds: number } | string | number> }).dates;
  assertEquals([out.delivery_start, out.collection_start], [iso(6), iso(16)]);
  assertEquals((out.delivery_start_fs as { nanoseconds: number }).nanoseconds, 3, "delivery kept → the invoice's own _fs");
  assertEquals((out.collection_start_fs as { nanoseconds: number }).nanoseconds, 2, "collection followed → the order's _fs");
  assertEquals(out.days_charged, daysFor(iso(6), iso(16)));
  assertNotEquals(daysFor(iso(6), iso(16)), daysFor(iso(5), iso(16)), "anti-vacuity: the two windows bill differently");

  // The row mode copies the order's dates whole over the invoice's edit.
  const row = (sync(prev, next, inv).destinations[0] as unknown as { dates: Record<string, unknown> }).dates;
  assertEquals(row.delivery_start, iso(5), "companion");
});

Deno.test("per field: a mixed window that would be invalid keeps the invoice's WHOLE dates", () => {
  // The order moves the whole window earlier; the invoice had moved delivery later.
  const prev = { items: [divider(DEST_A)], destinations: [pair(DEST_A, dates(iso(5), iso(9), 1))] };
  const next = { items: [divider(DEST_A)], destinations: [pair(DEST_A, dates(iso(1), iso(3), 2))] };
  const inv = invoiceOf(prev);
  const storedDates = dates(iso(8), iso(9), 3);
  (inv.destinations[0] as unknown as Record<string, unknown>).dates = storedDates;

  // Leaf by leaf that is delivery the 8th (invoice) and collection the 3rd (order).
  const out = sync(prev, next, inv, FIELD).destinations[0] as unknown as { dates: Record<string, unknown> };
  assertEquals(out.dates, storedDates);
});

Deno.test("per field: a pair the order deleted is kept when its dates were overridden, and dropped when untouched", () => {
  const d = dates(...WINDOW, 0);
  const prev = { items: [divider(DEST_A), divider(DEST_B)], destinations: [pair(DEST_A, d), pair(DEST_B, d)] };
  const next = { items: [divider(DEST_A)], destinations: [pair(DEST_A, d)] };

  const untouched = sync(prev, next, invoiceOf(prev), FIELD);
  assertEquals(untouched.destinations.map((p) => p.uid), [DEST_A]);

  const inv = invoiceOf(prev);
  (inv.destinations[1] as unknown as Record<string, unknown>).dates = dates(iso(6), iso(9), 0);
  const kept = sync(prev, next, inv, FIELD);
  assertEquals(kept.destinations.map((p) => p.uid).sort(), [DEST_A, DEST_B].sort());
  assertEquals(kept.kept.map((k) => k.uid), [DEST_B], "divider and pair kept together");
});

// ── Charge days (Target model D) ─────────────────────────────────────────────

Deno.test("per field: the conflict case — order dates and default-following days move, invoice overrode only its dates", () => {
  const [from, to, later] = [iso(5), iso(9), iso(14)];
  const before = daysFor(from, to);
  const after = daysFor(from, later);
  assertNotEquals(before, after, "anti-vacuity");

  const prev = { items: [divider(DEST_A), line(CHAIR, DEST_A, { days: before })], destinations: [pair(DEST_A, dates(from, to, 0))] };
  const next = { items: [divider(DEST_A), line(CHAIR, DEST_A, { days: after })], destinations: [pair(DEST_A, dates(from, later, 0))] };

  // The invoice moved collection to later the same day: different window, same day count.
  const inv = invoiceOf(prev);
  const late = to.replace("00:00:00", "15:00:00");
  (inv.destinations[0] as unknown as Record<string, unknown>).dates = { ...dates(from, late, 0), days_charged: before };
  assertEquals(daysFor(from, late), before);

  const out = sync(prev, next, inv, FIELD);
  assertEquals(lineAt(out.scopedItems, CHAIR)[0].price?.chargeable_days, before, "bills the INVOICE's window, not the order's");

  // An unedited invoice follows the order's new days.
  assertEquals(lineAt(sync(prev, next, invoiceOf(prev), FIELD).scopedItems, CHAIR)[0].price?.chargeable_days, after);
});

Deno.test("per field: an order hand-set day count still propagates", () => {
  const [from, to] = WINDOW;
  const def = daysFor(from, to);
  const prev = { items: [divider(DEST_A), line(CHAIR, DEST_A, { days: def })], destinations: [pair(DEST_A, dates(from, to, 0))] };
  const next = { items: [divider(DEST_A), line(CHAIR, DEST_A, { days: def + 3 })], destinations: [pair(DEST_A, dates(from, to, 0))] };
  assertEquals(lineAt(sync(prev, next, invoiceOf(prev), FIELD).scopedItems, CHAIR)[0].price?.chargeable_days, def + 3);
});
