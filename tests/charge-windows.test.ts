/**
 * Charge windows: the stored schema, the day-count writer, `applyDateEdit`, the
 * shared-field rule, and the pricer's derived `chargeable_days` and multi-window
 * factor.
 *
 * ⚠️ This named `.claude/plans/charge-windows.md`, which was DELETED when the
 * campaign's last step (the multi-window UI) landed on 2026-09-17 — a promoted
 * plan is retired with its final piece, because a stale plan reads as current
 * intent. The decisions it held are now where they are enforced: the one-week
 * floor per window in {@link billableDays}, the single author of a line's days in
 * `lineChargeableDays`, and the pair invariant in `chargeWindowPairViolations`.
 *
 * Dates are October 2026 in Chicago: Monday the 5th, Friday the 9th. DST ends on
 * Sunday 1 November.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  ChargeWindow,
  getInitialValues,
  InvoiceSchema,
  OrderDates,
  OrderDocDates,
  OrderDocLineItem,
  OrderSchema,
} from "../src/schemas/mod.ts";
import {
  applyDateEdit,
  billableDays,
  canonicalChargeWindows,
  type CanonicalChargeDates,
  type ChargeDates,
  chargedDays,
  chargeEnvelope,
  type DateEditResult,
} from "../src/utils/dates.ts";
import type { LineItem } from "../src/utils/orders.ts";
import {
  chargeWindowContext,
  chargeWindowPairViolations,
  type CreditSourceLine,
  lineChargeableDays,
  PriceRefusalError,
  type PriceDocumentContext,
  priceCreditNote,
  priceDocument,
} from "../src/utils/price-document.ts";
import { classifySharedFields, fieldsUnder, mergeSharedFields, resolveMergedPairDates } from "../src/utils/shared-fields.ts";
import {
  computeInvoiceSyncStatus,
  explainInvoiceItemDifferences,
  type InvoiceItem,
  invoiceItemDifferences,
  type InvoiceSyncContext,
  projectOrderItemToInvoiceItem,
} from "../src/utils/invoices.ts";

const at = (day: number, time: string, month = 10, offset = "-05:00") =>
  `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${time}.000${offset}`;

// ── Schema ───────────────────────────────────────────────────────────────────

Deno.test("OrderDates: charge_windows is required, and a legacy charge_start is stripped", () => {
  const base = { delivery_start: at(5, "09:00:00"), delivery_end: null, collection_start: at(9, "15:00:00"), collection_end: null };
  assertEquals(OrderDates.safeParse(base).success, false, "no windows");
  assertEquals(OrderDates.safeParse({ ...base, charge_windows: [] }).success, false, "at least one window");
  const legacy = OrderDates.safeParse({ ...base, charge_windows: [{ start: at(5, "09:00:00"), end: at(9, "15:00:00") }] });
  assert(legacy.success);
  assertEquals("charge_start" in legacy.data, false);
});

Deno.test("OrderDocDates: windows must be in order and not overlap, by calendar day", () => {
  const dates = {
    ...(getInitialValues(OrderDocDates) as Record<string, unknown>),
    delivery_start: at(5, "09:00:00"),
    collection_start: at(16, "15:00:00"),
  };
  const w = (s: number, e: number, days: number) => ({ start: at(s, "09:00:00"), end: at(e, "15:00:00"), days });
  assertEquals(OrderDocDates.safeParse({ ...dates, charge_windows: [w(5, 7, 3), w(12, 13, 2)] }).success, true);
  const sameDay = OrderDocDates.safeParse({ ...dates, charge_windows: [w(5, 7, 3), w(7, 9, 3)] });
  assertEquals(sameDay.success, false, "a window starting on the day the previous one ends overlaps");
  assertEquals(OrderDocDates.safeParse({ ...dates, charge_windows: [w(12, 13, 2), w(5, 7, 3)] }).success, false, "out of order");
  assertEquals(OrderDocDates.safeParse({ ...dates, charge_windows: [] }).success, false, "never empty");
  // Required since the backfill (beta B): a pair with no windows is refused.
  const { charge_windows: _omit, ...windowless } = { ...dates, charge_windows: undefined };
  assertEquals(OrderDocDates.safeParse(windowless).success, false);
});

Deno.test("ChargeWindow: days is a non-negative integer and a window is strict", () => {
  const ok = { start: at(5, "09:00:00"), end: at(9, "15:00:00"), days: 0 };
  assertEquals(ChargeWindow.safeParse(ok).success, true, "a 0-day window is valid");
  assertEquals(ChargeWindow.safeParse({ ...ok, days: -1 }).success, false);
  assertEquals(ChargeWindow.safeParse({ ...ok, days: 2.5 }).success, false);
  assertEquals(ChargeWindow.safeParse({ ...ok, uid: "x" }).success, false);
});

// ── The pure readers ─────────────────────────────────────────────────────────

Deno.test("billableDays: every window carries the one-week minimum", () => {
  assertEquals(billableDays([3, 4, 2]), 15);
  assertEquals(billableDays([3, 0, 4]), 15);
  assertEquals(billableDays([8, 7, 6]), 21);
  for (let d = 0; d <= 30; d++) assertEquals(billableDays([d]), Math.max(d, 5), "one window is today's floor");
});

Deno.test("chargedDays and chargeEnvelope read stored windows only", () => {
  const charge_windows = [
    { start: at(5, "09:00:00"), end: at(7, "15:00:00"), days: 3 },
    { start: at(12, "09:00:00"), end: at(13, "15:00:00"), days: 0 },
  ];
  assertEquals(chargedDays({ charge_windows }), 3, "the stored count, even when a recount would differ");
  assertEquals(chargeEnvelope({ charge_windows }), { start: at(5, "09:00:00"), end: at(13, "15:00:00") });
  assertEquals(chargeEnvelope({ charge_windows: [] }), null);
});

// ── canonicalChargeWindows ───────────────────────────────────────────────────


Deno.test("canonicalChargeWindows: recounts each window and DELETES the legacy fields (charge-windows step 5)", () => {
  const out = canonicalChargeWindows({
    delivery_start: at(5, "09:00:00"),
    collection_start: at(16, "15:00:00"),
    days_active: null,
    charge_windows: [
      { start: at(5, "09:00:00"), end: at(7, "15:00:00"), days: 99 },
      { start: at(12, "09:00:00"), end: at(13, "15:00:00") },
    ],
  } as ChargeDates & Record<string, unknown>, ["2026-10-06"]) as ChargeDates & Record<string, unknown>;
  assertEquals(out.charge_windows?.map((w) => w.days), [2, 2], "the stored 99 is recounted, the holiday on the 6th excluded");
  assertEquals(out.days_active, 9);
  for (const key of ["charge_start", "charge_start_fs", "charge_end", "charge_end_fs", "days_charged"]) {
    assertEquals(key in out, false, `${key} is deleted, not nulled — a purged pair must stay purged on rewrite`);
  }
});

Deno.test("canonicalChargeWindows: the legacy charge bounds never imply a window, and are dropped without one", () => {
  const out = canonicalChargeWindows({
    delivery_start: at(5, "09:00:00"),
    collection_start: at(16, "15:00:00"),
  } as ChargeDates & Record<string, unknown>, []) as ChargeDates & Record<string, unknown>;
  assertEquals(out.charge_windows, undefined);
  assertEquals(["charge_start" in out, "charge_end" in out], [false, false]);
});

Deno.test("canonicalChargeWindows: an extension pair keeps its stated days, and must state them", () => {
  const dates = { delivery_start: at(5, "09:00:00"), collection_start: at(16, "15:00:00") };
  const kept = canonicalChargeWindows({ ...dates, charge_windows: [{ start: at(12, "00:00:00"), end: at(16, "15:00:00"), days: 2 }] }, [], { extension: true });
  assertEquals(kept.charge_windows?.[0].days, 2);
  assertThrows(() => canonicalChargeWindows({ ...dates, charge_windows: [{ start: at(12, "00:00:00"), end: at(16, "15:00:00") }] }, [], { extension: true }));
});

Deno.test("canonicalChargeWindows: a window ending two days before it starts is refused", () => {
  assertThrows(() => canonicalChargeWindows({ charge_windows: [{ start: at(9, "09:00:00"), end: at(7, "15:00:00") }] }, []));
});

// ── applyDateEdit ────────────────────────────────────────────────────────────

function ok(r: DateEditResult<ChargeDates>): ChargeDates & CanonicalChargeDates {
  if ("error" in r) throw new Error(`edit refused: ${r.error}`);
  return r.dates;
}
const H = { holidays: [] as string[] };
const defaults = (now = at(5, "07:00:00")): ChargeDates => ok(applyDateEdit<ChargeDates>({}, { type: "default_dates", now }, H));

Deno.test("applyDateEdit default_dates: 09:00 next business day, collection 5 business days on at 15:00", () => {
  assertEquals(defaults(), {
    delivery_start: at(5, "09:00:00"),
    delivery_end: at(5, "09:00:00"),
    collection_start: at(9, "15:00:00"),
    collection_end: at(9, "15:00:00"),
    charge_windows: [{ start: at(5, "09:00:00"), end: at(9, "15:00:00"), days: 5 }],
    days_active: 5,
  });
  const late = defaults(at(5, "10:00:00"));
  assertEquals([late.delivery_start, late.collection_start], [at(6, "09:00:00"), at(12, "15:00:00")], "past 8am starts tomorrow");
  const friday = defaults(at(9, "10:00:00"));
  assertEquals(friday.delivery_start, at(12, "09:00:00"), "skips the weekend");
});

Deno.test("applyDateEdit set_possession: one window over possession FOLLOWS it, and so do the ends", () => {
  const moved = ok(applyDateEdit(defaults(), { type: "set_possession", collection_start: at(16, "15:00:00") }, H));
  assertEquals(moved.charge_windows, [{ start: at(5, "09:00:00"), end: at(16, "15:00:00"), days: 10 }]);
  assertEquals(moved.collection_end, at(16, "15:00:00"), "an end equal to its start follows it");
});

Deno.test("applyDateEdit set_possession: an EDITED window does not follow", () => {
  const edited = ok(applyDateEdit(defaults(), { type: "set_window", index: 0, end: at(7, "15:00:00") }, H));
  const moved = ok(applyDateEdit(edited, { type: "set_possession", collection_start: at(16, "15:00:00") }, H));
  assertEquals(moved.charge_windows, [{ start: at(5, "09:00:00"), end: at(7, "15:00:00"), days: 3 }]);
});

Deno.test("applyDateEdit set_possession: an end that differs from its start stays where it is", () => {
  const apart = { ...defaults(), collection_end: at(10, "12:00:00") };
  const moved = ok(applyDateEdit(apart, { type: "set_possession", collection_start: at(16, "15:00:00") }, H));
  assertEquals(moved.collection_end, at(10, "12:00:00"));
});

Deno.test("applyDateEdit follows by INSTANT, so an API payload in another offset still follows", () => {
  const stored = defaults();
  // The client restated the stored window in UTC and moved collection.
  const input = {
    ...stored,
    collection_start: at(16, "15:00:00"),
    charge_windows: [{ start: "2026-10-05T14:00:00.000Z", end: "2026-10-09T20:00:00.000Z" }],
  };
  const out = ok(applyDateEdit(input, { type: "set_possession", collection_start: at(16, "15:00:00") }, { holidays: [], prev: stored }));
  assertEquals(out.charge_windows, [{ start: at(5, "09:00:00"), end: at(16, "15:00:00"), days: 10 }]);
});

Deno.test("applyDateEdit set_possession_days / set_window_days keep the end's own time of day", () => {
  const long = ok(applyDateEdit(defaults(), { type: "set_possession_days", days: 7 }, H));
  assertEquals(long.collection_start, at(13, "15:00:00"));
  assertEquals(long.charge_windows?.[0], { start: at(5, "09:00:00"), end: at(13, "15:00:00"), days: 7 });

  const odd = ok(applyDateEdit(defaults(), { type: "set_window", index: 0, end: at(9, "11:30:00") }, H));
  const shorter = ok(applyDateEdit(odd, { type: "set_window_days", index: 0, days: 2 }, H));
  assertEquals(shorter.charge_windows?.[0], { start: at(5, "09:00:00"), end: at(6, "11:30:00"), days: 2 });
});

Deno.test("applyDateEdit across the DST change: wall time kept, offset moves", () => {
  const friday = { ...defaults(), delivery_start: at(30, "09:00:00"), delivery_end: at(30, "09:00:00") };
  const out = ok(applyDateEdit(
    { ...friday, collection_start: at(30, "15:00:00"), collection_end: at(30, "15:00:00"), charge_windows: [{ start: at(30, "09:00:00"), end: at(30, "15:00:00") }] },
    { type: "set_possession_days", days: 3 },
    H,
  ));
  assertEquals(out.collection_start, at(3, "15:00:00", 11, "-06:00"), "Fri 30 Oct, Mon 2, Tue 3 Nov — still 15:00, now CST");
  assertEquals(out.charge_windows?.[0].days, 3);
});

Deno.test("applyDateEdit counts holidays inside a window", () => {
  const out = ok(applyDateEdit(defaults(), { type: "set_possession_days", days: 5 }, { holidays: ["2026-10-07"] }));
  assertEquals(out.collection_start, at(12, "15:00:00"), "the 7th is skipped");
  assertEquals(out.charge_windows?.[0].days, 5);
});

Deno.test("applyDateEdit refuses when holidays have not loaded", () => {
  assertEquals(applyDateEdit(defaults(), { type: "set_possession_days", days: 7 }, { holidays: null }), { error: "holidays_unloaded" });
});

Deno.test("applyDateEdit add/remove/reset windows, and the refusals", () => {
  const base = ok(applyDateEdit(defaults(), { type: "set_possession", collection_start: at(23, "15:00:00") }, H));
  const first = ok(applyDateEdit(base, { type: "set_window", index: 0, end: at(7, "15:00:00") }, H));
  const two = ok(applyDateEdit(first, { type: "add_window", start: at(19, "09:00:00"), end: at(20, "15:00:00") }, H));
  assertEquals(two.charge_windows?.map((w) => w.days), [3, 2]);

  const three = ok(applyDateEdit(two, { type: "add_window", start: at(12, "09:00:00"), end: at(12, "15:00:00") }, H));
  assertEquals(three.charge_windows?.map((w) => w.start), [at(5, "09:00:00"), at(12, "09:00:00"), at(19, "09:00:00")], "inserted in order");

  assertEquals(applyDateEdit(two, { type: "add_window", start: at(7, "16:00:00"), end: at(9, "15:00:00") }, H), { error: "overlap" });
  assertEquals(applyDateEdit(two, { type: "add_window", start: at(8, "09:00:00"), end: at(9, "15:00:00") }, H), { error: "adjacent" }, "no business day between the 7th and the 8th");
  assertEquals(applyDateEdit(two, { type: "add_window", start: at(12, "09:00:00"), end: at(13, "15:00:00") }, { holidays: ["2026-10-08", "2026-10-09"] }), { error: "adjacent" }, "only holidays and a weekend between");

  const one = ok(applyDateEdit(two, { type: "remove_window", index: 1 }, H));
  assertEquals(one.charge_windows?.length, 1);
  assertEquals(applyDateEdit(one, { type: "remove_window", index: 0 }, H), { error: "last_window" });
  assertEquals(applyDateEdit(one, { type: "set_window_days", index: 3, days: 2 }, H), { error: "no_such_window" });

  const reset = ok(applyDateEdit(two, { type: "reset_windows" }, H));
  assertEquals(reset.charge_windows, [{ start: at(5, "09:00:00"), end: at(23, "15:00:00"), days: 15 }]);
});

Deno.test("applyDateEdit refuses window edits on an extension pair, and a 0-day set_*_days", () => {
  for (const edit of [
    { type: "set_window", index: 0, end: at(7, "15:00:00") },
    { type: "set_window_days", index: 0, days: 2 },
    { type: "add_window", start: at(19, "09:00:00"), end: at(20, "15:00:00") },
    { type: "remove_window", index: 0 },
    { type: "reset_windows" },
  ] as const) {
    assertEquals(applyDateEdit(defaults(), edit, { holidays: [], extension: true }), { error: "extension_window" }, edit.type);
  }
  assertEquals(applyDateEdit(defaults(), { type: "set_possession_days", days: 0 }, H), { error: "invalid_days" });
});

Deno.test("applyDateEdit copy_from: a new pair takes another pair's dates and recounts them", () => {
  const source = ok(applyDateEdit(defaults(), { type: "add_window", start: at(19, "09:00:00"), end: at(20, "15:00:00") }, H));
  const copy = ok(applyDateEdit<ChargeDates>({}, { type: "copy_from", dates: source }, { holidays: ["2026-10-19"] }));
  assertEquals(copy.charge_windows?.map((w) => w.days), [5, 1], "recounted against this edit's holidays");
  assertEquals(copy.delivery_start, source.delivery_start);
});

// ── Shared fields: the windows merge as ONE value ────────────────────────────

const PAIR_FIELDS = fieldsUnder(classifySharedFields(OrderSchema, InvoiceSchema), "destinations[]");

Deno.test("classifySharedFields: charge_windows is one propagated value whose `days` is derived", () => {
  const field = PAIR_FIELDS.find((f) => f.path === "dates.charge_windows");
  assertEquals(field, { path: "dates.charge_windows", kind: "propagated", derived_keys: ["days"] });
});

Deno.test("mergeSharedFields: windows differing only in their counted days are not an override", () => {
  const w = (end: number, days: number) => [{ start: at(5, "09:00:00"), end: at(end, "15:00:00"), days }];
  const pair = (windows: ReturnType<typeof w>) => ({ dates: { charge_windows: windows } });
  // The invoice recounted against a holiday the order did not have.
  const { merged, overridden } = mergeSharedFields(PAIR_FIELDS, pair(w(9, 5)), pair(w(16, 10)), pair(w(9, 4)));
  assertEquals(overridden, []);
  assertEquals(merged.dates.charge_windows, w(16, 10), "follows the order; the caller recounts");

  const edited = mergeSharedFields(PAIR_FIELDS, pair(w(9, 5)), pair(w(16, 10)), pair(w(7, 3)));
  assertEquals(edited.overridden, ["dates.charge_windows"]);
  assertEquals(edited.merged.dates.charge_windows, w(7, 3));
});

Deno.test("resolveMergedPairDates: a mix recounts the windows and carries each _fs from the side that holds its instant", () => {
  const dates = (collection: number, windowEnd: number, tag: number) => ({
    delivery_start: at(5, "09:00:00"),
    delivery_start_fs: { seconds: 1, nanoseconds: tag },
    delivery_end: at(5, "09:00:00"),
    delivery_end_fs: { seconds: 1, nanoseconds: tag },
    collection_start: at(collection, "15:00:00"),
    collection_start_fs: { seconds: 2, nanoseconds: tag },
    collection_end: at(collection, "15:00:00"),
    collection_end_fs: { seconds: 2, nanoseconds: tag },
    days_active: 0,
    charge_windows: [{ start: at(5, "09:00:00"), end: at(windowEnd, "15:00:00"), days: 0 }],
  });
  // The downstream's window is NOT its possession, so it does not follow.
  const downstream = dates(9, 7, 1);
  const source = dates(16, 16, 2);
  // Collection from the source, the window kept from the downstream.
  const merged = { ...downstream, collection_start: source.collection_start, collection_end: source.collection_end };
  const out = resolveMergedPairDates(merged, source, downstream, [], canonicalChargeWindows)!;
  assertEquals(out.charge_windows, [{ start: at(5, "09:00:00"), end: at(7, "15:00:00"), days: 3 }]);
  assertEquals(out.days_active, 10);
  assertEquals(out.collection_start_fs, source.collection_start_fs);
  assertEquals(merged.collection_start_fs, downstream.collection_start_fs, "the caller's merged object is not mutated");

  const invalid = { ...merged, charge_windows: [{ start: at(9, "09:00:00"), end: at(5, "15:00:00"), days: 0 }] };
  assertEquals(resolveMergedPairDates(invalid, source, downstream, [], canonicalChargeWindows), null);
});

Deno.test("resolveMergedPairDates: a kept window equal to the downstream's possession follows a merged possession move", () => {
  const dates = (collection: number, windowEnd: number) => ({
    delivery_start: at(5, "09:00:00"),
    delivery_end: at(5, "09:00:00"),
    collection_start: at(collection, "15:00:00"),
    collection_end: at(collection, "15:00:00"),
    days_active: 0,
    charge_windows: [{ start: at(5, "09:00:00"), end: at(windowEnd, "15:00:00"), days: 0 }],
  });
  // The invoice's window is its possession; the order's is not, and did not follow.
  const downstream = dates(9, 9);
  const source = dates(16, 12);
  const merged = { ...downstream, collection_start: source.collection_start, collection_end: source.collection_end };
  const out = resolveMergedPairDates(merged, source, downstream, [], canonicalChargeWindows)!;
  assertEquals(out.charge_windows, [{ start: at(5, "09:00:00"), end: at(16, "15:00:00"), days: 10 }]);
  assertEquals(["charge_end", "days_charged"].filter((k) => k in out), [], "a recount drops the legacy fields");

  // Compared as instants: the same moment in another offset still follows.
  const utc = { ...downstream, charge_windows: [{ start: "2026-10-05T14:00:00.000Z", end: "2026-10-09T20:00:00.000Z", days: 5 }] };
  const utcOut = resolveMergedPairDates({ ...utc, collection_start: source.collection_start }, source, utc, [], canonicalChargeWindows)!;
  assertEquals(utcOut.charge_windows?.[0].end, at(16, "15:00:00"));

  // Two windows never follow.
  const two = { ...downstream, charge_windows: [{ start: at(5, "09:00:00"), end: at(6, "15:00:00"), days: 2 }, { start: at(8, "09:00:00"), end: at(9, "15:00:00"), days: 2 }] };
  const twoOut = resolveMergedPairDates({ ...two, collection_start: source.collection_start }, source, two, [], canonicalChargeWindows)!;
  assertEquals(twoOut.charge_windows?.map((w) => w.days), [2, 2]);
});

// ── The pricer ───────────────────────────────────────────────────────────────

const lineBase = getInitialValues(OrderDocLineItem) as Record<string, unknown>;
let seq = 0;
function line(path: string[], price: Record<string, unknown> = {}, over: Record<string, unknown> = {}): LineItem {
  const uid = `line-${++seq}`;
  return {
    ...lineBase,
    uid,
    name: "Hotspot",
    type: "rental",
    quantity: 1,
    path: [...path, uid],
    ...over,
    price: { ...(lineBase.price as object), base_cents: 10000, chargeable_days: 5, formula: "five_day_week", taxes: [], discount: null, ...price },
  } as unknown as LineItem;
}

const TAX: PriceDocumentContext["tax"] = {
  destinations: [],
  origin: "chicago",
  exempt: true,
  catalog: { codes: [], rates: [], classes: [] },
  asOf: "2026-10-05T00:00:00.000-05:00",
};
const priceCtx = (charge_windows: PriceDocumentContext["charge_windows"], document: PriceDocumentContext["document"] = { kind: "order", status: "active" }): PriceDocumentContext => ({ document, tax: TAX, charge_windows });
const pairWith = (days: number[]) => chargeWindowContext([{
  uid: "D",
  dates: { charge_windows: days.map((d) => ({ days: d })) },
}]);
const priced = (it: LineItem, ctx: PriceDocumentContext) => {
  const out = priceDocument([it], ctx).items[0].price as unknown as { chargeable_days: number | null; subtotal_cents: number; subtotal_discounted_cents: number };
  return out;
};

Deno.test("priceDocument: the worked multi-window cases", () => {
  const cases: Array<[number[], number, number]> = [
    [[3, 4, 2], 15, 30000], // 15 billable → 3.0×
    [[3, 0, 4], 15, 30000], // 15 billable → 3.0×
    [[8, 7, 6], 21, 42000], // 21 billable → 4.2×
  ];
  for (const [windows, days, cents] of cases) {
    const out = priced(line(["D"]), priceCtx(pairWith(windows)));
    assertEquals([out.chargeable_days, out.subtotal_cents], [days, cents], JSON.stringify(windows));
  }
});

Deno.test("priceDocument: a multi-window line's own numbers multiply out to its subtotal (core#114)", () => {
  for (const windows of [[3, 4, 2], [3, 0, 4], [8, 7, 6], [0, 0], [12, 1]]) {
    for (const quantity of [1, 3, 7]) {
      const out = priced(line(["D"], {}, { quantity }), priceCtx(pairWith(windows)));
      assertEquals(out.chargeable_days, billableDays(windows), JSON.stringify(windows));
      assertEquals(out.subtotal_cents, quantity * 10000 * out.chargeable_days! / 5, `${JSON.stringify(windows)} × ${quantity}`);
    }
  }
});

Deno.test("priceDocument: a discount scales with the multi-window factor exactly as with one long window", () => {
  for (const discount of [{ type: "flat", rate: 10, amount_cents: 0 }, { type: "percent", rate: 12.5, amount_cents: 0 }]) {
    const multi = priced(line(["D"], { discount }, { quantity: 3 }), priceCtx(pairWith([3, 4, 2])));
    const single = priced(line(["D"], { discount }, { quantity: 3 }), priceCtx(pairWith([15])));
    assertEquals(
      [multi.subtotal_cents, multi.subtotal_discounted_cents],
      [single.subtotal_cents, single.subtotal_discounted_cents],
      discount.type,
    );
  }
});

Deno.test("priceDocument: property — a single-window pair prices exactly as a line holding the same days", () => {
  let s = 20260916;
  const rand = (n: number) => (s = (s * 1103515245 + 12345) % 2147483648) % n;
  let factorBit = 0;
  for (let i = 0; i < 2000; i++) {
    const days = rand(31);
    if (days > 5) factorBit++;
    const price = {
      base_cents: rand(200000) - 20000,
      discount: rand(3) === 0 ? null : rand(2) === 0
        ? { type: "percent", rate: rand(1000000) / 10000, amount_cents: 0 }
        : { type: "flat", rate: rand(100000) / 10000, amount_cents: 0 },
    };
    const quantity = 1 + rand(40);
    const windowed = priced(line(["D"], { ...price, chargeable_days: 999 }, { quantity }), priceCtx(pairWith([days])));
    // A complete order keeps the line's own stored days: the pricing before windows.
    const legacy = priced(line(["D"], { ...price, chargeable_days: days }, { quantity }), priceCtx(pairWith([0]), { kind: "order", status: "complete" }));
    assertEquals(windowed, legacy, `days ${days} ${JSON.stringify(price)} × ${quantity}`);
  }
  assert(factorBit > 1000, "anti-vacuity: the day factor was exercised");
});

Deno.test("priceDocument: only a rental five_day_week line takes days from its pair", () => {
  const ctx = priceCtx(pairWith([12]));
  const sale = priced(line(["D"], { chargeable_days: 12 }, { type: "sale" }), ctx);
  assertEquals([sale.chargeable_days, sale.subtotal_cents], [null, 10000], "a sale stored as five_day_week prices at factor 1");
  const fixed = priced(line(["D"], { formula: "fixed", chargeable_days: 12 }), ctx);
  assertEquals([fixed.chargeable_days, fixed.subtotal_cents], [null, 10000]);
  const rental = priced(line(["D"], { chargeable_days: 5 }), ctx);
  assertEquals([rental.chargeable_days, rental.subtotal_cents], [12, 24000]);
});

Deno.test("priceDocument: a rental five_day_week line under no pair is refused", () => {
  assertThrows(() => priceDocument([line(["order-divider"])], priceCtx(pairWith([5]))), PriceRefusalError, "not under a destination pair");
});

Deno.test("priceDocument: a complete or canceled order keeps its lines' stored days", () => {
  for (const status of ["complete", "canceled"] as const) {
    const out = priced(line(["D"], { chargeable_days: 5 }), priceCtx(pairWith([7]), { kind: "order", status }));
    assertEquals([out.chargeable_days, out.subtotal_cents], [5, 10000], status);
  }
  const live = priced(line(["D"], { chargeable_days: 5 }), priceCtx(pairWith([7]), { kind: "invoice", status: "issued", has_settlement: false }));
  assertEquals(live.chargeable_days, 7, "an issued, unpaid invoice is re-derived");
});

Deno.test("chargeWindowContext: a pair with no windows is refused", () => {
  assertThrows(() => chargeWindowContext([{ uid: "D", dates: { charge_windows: [] } }]), PriceRefusalError, "no charge windows");
});

Deno.test("chargeWindowContext: an invoice pair's divider path is [uid_order, uid]", () => {
  const ctx = chargeWindowContext([{ uid: "D", uid_order: "O", dates: { charge_windows: [{ days: 3 }, { days: 4 }] } }]);
  assertEquals(ctx, [{ divider_path: ["O", "D"], days: [3, 4] }]);
  const onInvoice = line(["O", "D"]);
  assertEquals(lineChargeableDays(onInvoice, priceCtx(ctx)), { chargeable_days: 10 });
});

Deno.test("priceDocument: an extension line bills its pair's added days, unfloored", () => {
  const priceExt = (stored: number | null, dates: { charge_windows: { days: number }[] }) => {
    const ext = line(["O", "E"], { chargeable_days: stored });
    return priceDocument([ext], {
      ...priceCtx(chargeWindowContext([{ uid: "E", uid_order: "O", dates }]), { kind: "invoice", status: "draft", has_settlement: false }),
      extensions: [{ divider_path: ["O", "E"] }],
    }).items[0].price as unknown as { chargeable_days: number; subtotal_cents: number };
  };
  // The window carries the added days; a line arriving with none (an API build nulls input days) takes them.
  const fromWindow = priceExt(null, { charge_windows: [{ days: 2 }] });
  assertEquals([fromWindow.chargeable_days, fromWindow.subtotal_cents], [2, 4000]);
  assertEquals(priceExt(7, { charge_windows: [{ days: 2 }] }).chargeable_days, 2, "the window wins over a stale line count");
});

Deno.test("priceCreditNote: a line billed on a multi-window pair is credited at its stored billable days", () => {
  const src = (chargeable_days: number): CreditSourceLine => ({
    uid: "r1",
    path: ["O", "D", "r1"],
    type: "rental",
    quantity: 1,
    price: { base_cents: 10000, chargeable_days, formula: "five_day_week", discount: null, taxes: [] },
  });
  const billed = priced(line(["D"]), priceCtx(pairWith([3, 4, 2])));
  assertEquals(priceCreditNote([{ line: src(billed.chargeable_days!), quantity: 1 }], [], []).prices[0].subtotal_cents, billed.subtotal_cents);
  assertEquals(priceCreditNote([{ line: src(9), quantity: 1 }], [], []).prices[0].subtotal_cents, 18000, "one window: its own days");
});

// ── The pair invariant, checked on write (core#113) ──────────────────────────

/**
 * A line stating `days`, under pair `D`, so a test can put a WRONG count on a
 * multi-window pair — which the pricer itself cannot produce.
 */
const storedLine = (days: number | null, path = ["D"]) => line(path, { chargeable_days: days });

Deno.test("chargeWindowPairViolations: a 2+ window pair requires billableDays, and reports the difference", () => {
  const ctx = (document: PriceDocumentContext["document"] = { kind: "order", status: "active" }) => ({
    document,
    charge_windows: pairWith([3, 4, 2]),
  });
  // [3,4,2] → Σ max(d,5) = 15. The pricer's own output is the clean case.
  const clean = priced(line(["D"]), priceCtx(pairWith([3, 4, 2])));
  assertEquals(clean.chargeable_days, 15);
  assertEquals(chargeWindowPairViolations([storedLine(15)], ctx()), []);

  // …and the guard BITES on a line that skipped the pricer. Without this arm
  // every other assertion here could pass over a walker that reaches nothing.
  const offender = storedLine(9);
  const bad = chargeWindowPairViolations([offender], ctx());
  assertEquals(bad.length, 1);
  assertEquals([bad[0].stored, bad[0].expected], [9, 15], "it states both counts, so a report need not re-derive either");
  assertEquals(bad[0].window_days, [3, 4, 2]);
  assertEquals(bad[0].divider_path, ["D"]);
  // `path` is the LINE's own path — the row identity within this document.
  // `item_uid` is not one: it repeats within an array on 18% of prod orders.
  assertEquals(bad[0].path, offender.path);
  assertEquals(bad[0].item_uid, offender.uid);

  // A null count is a violation, not an exemption — it is how an unpriced write looks.
  assertEquals(chargeWindowPairViolations([storedLine(null)], ctx()).length, 1);
});

Deno.test("chargeWindowPairViolations: a SINGLE-window pair is out of scope", () => {
  // Legacy CRMS divergence the 2026-09-16 census measured and the backfill
  // settled. Re-asserting it here would refuse documents the campaign left alone.
  const ctx = { document: { kind: "order", status: "active" } as const, charge_windows: pairWith([9]) };
  assertEquals(chargeWindowPairViolations([storedLine(4)], ctx), []);
  assertEquals(chargeWindowPairViolations([storedLine(9)], ctx), []);
});

Deno.test("chargeWindowPairViolations: only a rental five_day_week line is checked", () => {
  const ctx = { document: { kind: "order", status: "active" } as const, charge_windows: pairWith([3, 4, 2]) };
  // A sale/service/surcharge is stored as five_day_week with null days and prices at factor 1.
  assertEquals(chargeWindowPairViolations([line(["D"], { chargeable_days: null }, { type: "sale" })], ctx), []);
  assertEquals(chargeWindowPairViolations([line(["D"], { chargeable_days: null, formula: "fixed" })], ctx), []);
  // A rental with NO pair is lineChargeableDays' refusal to make, not this one's.
  assertEquals(chargeWindowPairViolations([storedLine(9, [])], ctx), []);
});

Deno.test("chargeWindowPairViolations: a document that keeps its stored days is exempt", () => {
  const items = [storedLine(9)];
  const windows = pairWith([3, 4, 2]);
  const exempt: PriceDocumentContext["document"][] = [
    { kind: "order", status: "complete" },
    { kind: "order", status: "canceled" },
    { kind: "invoice", status: "void", has_settlement: false },
    { kind: "invoice", status: "paid", has_settlement: false },
    { kind: "invoice", status: "issued", has_settlement: true },
  ];
  for (const document of exempt) {
    const label = `${document.kind}/${document.status}${"has_settlement" in document && document.has_settlement ? "+settled" : ""}`;
    assertEquals(chargeWindowPairViolations(items, { document, charge_windows: windows }), [], label);
  }
  // …and the live ones are NOT exempt, so the arm above cannot pass vacuously.
  const live: PriceDocumentContext["document"][] = [
    { kind: "order", status: "draft" },
    { kind: "order", status: "active" },
    { kind: "invoice", status: "issued", has_settlement: false },
  ];
  for (const document of live) {
    assertEquals(chargeWindowPairViolations(items, { document, charge_windows: windows }).length, 1, `${document.kind}/${document.status}`);
  }
});

Deno.test("chargeWindowPairViolations: an extension line bills the days it ADDS, not its pair's total", () => {
  const ext = line(["O", "E"], { chargeable_days: 2 });
  const windows = chargeWindowContext([{ uid: "E", uid_order: "O", dates: { charge_windows: [{ days: 3 }, { days: 4 }] } }]);
  const document = { kind: "invoice", status: "draft", has_settlement: false } as const;
  // Under the section: exempt — 2 is the added days, while billableDays is 10.
  assertEquals(chargeWindowPairViolations([ext], { document, charge_windows: windows, extensions: [{ divider_path: ["O", "E"] }] }), []);
  // The SAME line with no extension section declared is checked, so the
  // exemption is the section's doing rather than the line's shape.
  assertEquals(chargeWindowPairViolations([ext], { document, charge_windows: windows }).length, 1);
});

// ── The sync comparator's `invoice_windows` arm (core#112) ────────────────────
//
// Since beta A a rental line's days and money come from ITS OWN document's pair
// windows, so an invoice that states its own — a partial bill, decision 3 —
// differs from its order on the day count and every money field below it. The
// arm re-prices the projected order line at the invoice's windows and covers only
// what then agrees exactly.
//
// ⚠️ Every context here states the INVOICE's windows. `invoices.test.ts` passes
// an EMPTY array throughout so that this arm cannot fire there and rebase the
// tax-arm tests; this file is the arm's own population.

const ORDER_UID = "order-1";
const PAIR_UID = "pair-1";

/** The pair as the ORDER states it — divider path `[pair.uid]`. */
const orderWindows = (days: number[]) =>
  chargeWindowContext([{ uid: PAIR_UID, dates: { charge_windows: days.map((d) => ({ days: d })) } }]);
/** The same pair as the INVOICE states it — divider path `[uid_order, pair.uid]`. */
const invoiceWindows = (days: number[]) =>
  chargeWindowContext([{ uid: PAIR_UID, uid_order: ORDER_UID, dates: { charge_windows: days.map((d) => ({ days: d })) } }]);

const syncCtx = (invoiceChargeWindows: ReturnType<typeof invoiceWindows>, over: Partial<InvoiceSyncContext> = {}): InvoiceSyncContext => ({
  taxNameByUid: new Map<string, string>(),
  orderFrozen: false,
  invoiceChargeWindows,
  ...over,
});

/**
 * One order line and the invoice line billed from it, each priced by the REAL
 * writer at its OWN windows — which is how the corpus comes to look this way.
 * The assertions below are about the comparator's verdict, never about the money.
 */
function billedPair(orderDays: number[], invoiceDays: number[], invoiceOverride: Record<string, unknown> = {}) {
  const src = line([PAIR_UID], {}, { uid_tax_class: "class-1" });
  const orderLine = priceDocument([src], priceCtx(orderWindows(orderDays))).items[0];
  const projected = projectOrderItemToInvoiceItem(orderLine, ORDER_UID);
  const projectedPrice = (projected as unknown as { price: Record<string, unknown> }).price;
  const seed = { ...projected, price: { ...projectedPrice, ...invoiceOverride } } as unknown as LineItem;
  const invoiceLine = priceDocument([seed], priceCtx(invoiceWindows(invoiceDays), { kind: "invoice", status: "issued", has_settlement: false })).items[0];
  return { orderLine, expected: projected as unknown as InvoiceItem, current: invoiceLine as unknown as InvoiceItem };
}

const explainBilled = (expected: InvoiceItem, current: InvoiceItem, context: InvoiceSyncContext) =>
  explainInvoiceItemDifferences(expected, current, invoiceItemDifferences(expected, current), context);

Deno.test("invoice_windows: a partial bill is explained, and the arm says so", () => {
  // The order's pair bills 20 days; the invoice bills 15 of them.
  const { expected, current } = billedPair([20], [15]);
  assert(invoiceItemDifferences(expected, current).includes("price.chargeable_days"), "the naive comparison must still see the difference");

  const verdict = explainBilled(expected, current, syncCtx(invoiceWindows([15])));
  assertEquals(verdict.unexplained, []);
  assertEquals(verdict.arms, ["invoice_windows"]);
});

Deno.test("invoice_windows: prod #2408's shape — identical bounds, a different day count", () => {
  // Order #1012 stores 14 days on the pair; issued invoice #2408 stores 15 on the
  // same bounds, because the backfill kept the money it had already billed
  // (charge-windows census, 2026-09-16). Measured in prod 2026-09-17.
  const { expected, current } = billedPair([14], [15]);
  assertEquals(explainBilled(expected, current, syncCtx(invoiceWindows([15]))).unexplained, []);
});

Deno.test("invoice_windows: a MULTI-window invoice pair is explained at its billable days", () => {
  const { expected, current } = billedPair([20], [3, 4, 2]);
  const verdict = explainBilled(expected, current, syncCtx(invoiceWindows([3, 4, 2])));
  assertEquals(verdict.unexplained, []);
  assertEquals((current.price as { chargeable_days: number }).chargeable_days, billableDays([3, 4, 2]));
});

Deno.test("invoice_windows: the arm does NOT fire when the two documents state the same windows", () => {
  const { expected, current } = billedPair([15], [15]);
  const verdict = explainBilled(expected, current, syncCtx(invoiceWindows([15])));
  assertEquals(invoiceItemDifferences(expected, current), [], "nothing to explain in the first place");
  assertEquals(verdict.arms, []);
});

Deno.test("🔴 invoice_windows: passing the ORDER's windows explains NOTHING — the tautology guard", () => {
  // The projection is ALREADY priced at the order's windows, so a caller that
  // sources the context from the order instead of the invoice gets a no-op. This
  // is the mutation control for the two tests above: without it, an arm that
  // never fired would be indistinguishable from one that explained everything.
  const { expected, current } = billedPair([20], [15]);
  const wrong = explainBilled(expected, current, syncCtx(orderWindows([20]) as ReturnType<typeof invoiceWindows>));
  assertEquals(wrong.arms, []);
  assert(wrong.unexplained.includes("price.chargeable_days"));
});

Deno.test("invoice_windows: a REAL drift under a partial bill still reports", () => {
  // Same partial bill, but the invoice's base price was also changed. The day
  // difference is explained; the price change and the money it moves are not.
  const { expected, current } = billedPair([20], [15], { base_cents: 12000 });
  const verdict = explainBilled(expected, current, syncCtx(invoiceWindows([15])));
  assertEquals(verdict.arms, ["invoice_windows"]);
  assertEquals(verdict.unexplained, ["price.base_cents", "price.subtotal_cents", "price.subtotal_discounted_cents", "price.total_cents"]);
});

Deno.test("invoice_windows: a line whose stored days disagree with its OWN windows stays red", () => {
  // Legacy CRMS divergence: the line bills a count its own pair does not state —
  // here 9 days against a 15-day invoice window. Re-deriving reproduces neither
  // the count nor the money, so NOTHING is explained and the verdict is the one
  // this line got before windows existed. That is what "not a regression" has to
  // mean, and it is the arm's floor: it explains an invoice that bills its own
  // windows, never one that bills something else again.
  const { expected } = billedPair([20], [15]);
  const { current: billedAtNine } = billedPair([20], [9]);
  const verdict = explainBilled(expected, billedAtNine, syncCtx(invoiceWindows([15])));
  assertEquals(verdict.arms, []);
  assert(verdict.unexplained.includes("price.chargeable_days"));
});

Deno.test("invoice_windows: a line stating the wrong DAYS beside the right money is red on the days alone", () => {
  // The other half of the case above, and the reason the arm is a per-field
  // filter rather than a whole-row verdict. This line's money IS what its own
  // windows bill; only the stored count disagrees. Covering the money and
  // badging the count is more useful than either extreme — an operator is shown
  // the one field that is actually wrong.
  const { expected, current } = billedPair([20], [15]);
  const inconsistent = { ...current, price: { ...(current.price as object), chargeable_days: 9 } } as unknown as InvoiceItem;
  const verdict = explainBilled(expected, inconsistent, syncCtx(invoiceWindows([15])));
  assertEquals(verdict.arms, ["invoice_windows"]);
  assertEquals(verdict.unexplained, ["price.chargeable_days"]);
});

Deno.test("🔴 invoice_windows REBASES the tax arms, and `totalFollowsTax` proves it", () => {
  // A partial bill on a line whose tax ALSO moved a rate version. Money is
  // hand-stated from the pricing rule (base 10000, ×days÷5, then the rate), never
  // from the code under test.
  //
  // order : 20 days → 40000, Chicago v1 @10% → 4000, total 44000
  // invoice: 15 days → 30000, Chicago v2 @9%  → 2700, total 32700
  // rebased: 15 days → 30000, Chicago v1 @10% → 3000, total 33000
  //
  // `tax_date_version` covers `price.total_cents` only when the total moved by
  // EXACTLY the tax delta. Against the rebased baseline that is −300 vs −300 and
  // holds; against the raw projection it is −11300 vs −1300 and does not. So this
  // assertion fails if the arms stop composing in that order.
  const taxed = (days: number, subtotal: number, tax: { uid: string; rate: number; amount_cents: number }, total: number) => ({
    uid: "L", type: "rental", name: "Hotspot", description: "", quantity: 1,
    path: [ORDER_UID, PAIR_UID, "L"], uid_tax_class: "class-1", zero_priced: null,
    price: {
      base_cents: 10000, base_percent: null, chargeable_days: days, formula: "five_day_week",
      subtotal_cents: subtotal, subtotal_discounted_cents: subtotal, discount: null,
      taxes: [{ uid: tax.uid, name: "Chicago", rate: tax.rate, type: "percent", amount_cents: tax.amount_cents }],
      total_cents: total,
    },
  }) as unknown as InvoiceItem;

  const expected = taxed(20, 40000, { uid: "rate-v1", rate: 10, amount_cents: 4000 }, 44000);
  const current = taxed(15, 30000, { uid: "rate-v2", rate: 9, amount_cents: 2700 }, 32700);
  const context = syncCtx(invoiceWindows([15]), {
    taxNameByUid: new Map([["rate-v1", "Chicago"], ["rate-v2", "Chicago"]]),
    orderFrozen: true,
  });

  const verdict = explainBilled(expected, current, context);
  assertEquals(verdict.arms, ["invoice_windows", "tax_date_version"]);
  assertEquals(verdict.unexplained, []);
});

Deno.test("invoice_windows: computeInvoiceSyncStatus reads a partial bill as in_sync, and real drift as out_of_sync", () => {
  const { orderLine, current } = billedPair([20], [15]);
  const divider: LineItem = { uid: PAIR_UID, type: "destination", name: "Venue", description: "", path: [PAIR_UID] } as unknown as LineItem;
  const orderItems = [divider, orderLine];
  const invoiceItems = [
    { uid: ORDER_UID, type: "order", name: "Order 1", description: "", path: [ORDER_UID] },
    { uid: PAIR_UID, type: "destination", name: "Venue", description: "", path: [ORDER_UID, PAIR_UID] },
    current,
  ] as unknown as InvoiceItem[];
  const key = [ORDER_UID, ...(orderLine.path ?? [])].join("/");

  assertEquals(computeInvoiceSyncStatus(invoiceItems, orderItems, ORDER_UID, syncCtx(invoiceWindows([15]))).get(key), "in_sync");

  const drifted = billedPair([20], [15], { base_cents: 12000 });
  const withDrift = [...invoiceItems.slice(0, 2), drifted.current];
  assertEquals(computeInvoiceSyncStatus(withDrift, orderItems, ORDER_UID, syncCtx(invoiceWindows([15]))).get(key), "out_of_sync");
});
