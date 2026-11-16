/**
 * Charge windows: the stored schema, the canonicalizer, `applyDateEdit`, the
 * shared-field rule, and the pricer's metered line `counts` and multi-window
 * factor.
 *
 * Since purchases-as-documents Phase 2 ruling 8 a window is a start and an end
 * and nothing else: each priced line meters its pair's windows through its own
 * formula and freezes the result (`price.counts`). The decisions the retired
 * charge-windows plan held are where they are enforced: the one-week floor per
 * window in Five-day week's `minimum.scope: "window"`, the single author of a
 * line's counts in `lineCounts`, and the pair invariant in
 * `chargeWindowPairViolations`.
 *
 * Dates are October 2026 in Chicago: Monday the 5th, Friday the 9th. DST ends on
 * Sunday 1 November.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { businessDayWindow, businessDayWindows, fdwCounts, fdwPrice, fixedPrice, FORMULAS, legacyPrice, tier } from "./helpers/formulas.ts";
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
  canonicalChargeWindows,
  type CanonicalChargeDates,
  type ChargeDates,
  chargeEnvelope,
  chargeWindowBusinessDays,
  type DateEditResult,
} from "../src/utils/dates.ts";
import type { LineItem } from "../src/utils/orders.ts";
import {
  chargeWindowContext,
  chargeWindowPairViolations,
  type CreditSourceLine,
  carriedLines,
  lineCounts,
  PriceRefusalError,
  type PriceDocumentContext,
  priceCreditNote,
  priceDocument,
} from "../src/utils/price-document.ts";
import { classifySharedFields, fieldsUnder, mergeSharedFields, resolveMergedPairDates } from "../src/utils/shared-fields.ts";

const at = (day: number, time: string, month = 10, offset = "-05:00") =>
  `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${time}.000${offset}`;

// ── Schema ───────────────────────────────────────────────────────────────────

/** A date-extension section's divider: `priceDocument` reads the section off it (6e-0b2 F5). */
const EXT_DIVIDER = {
  uid: "E", type: "destination", path: ["O", "E"], path_extension_for: ["D"], name: "", description: "", quantity: 1,
} as unknown as LineItem;

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
  const w = (s: number, e: number) => ({ start: at(s, "09:00:00"), end: at(e, "15:00:00") });
  assertEquals(OrderDocDates.safeParse({ ...dates, charge_windows: [w(5, 7), w(12, 13)] }).success, true);
  const sameDay = OrderDocDates.safeParse({ ...dates, charge_windows: [w(5, 7), w(7, 9)] });
  assertEquals(sameDay.success, false, "a window starting on the day the previous one ends overlaps");
  assertEquals(OrderDocDates.safeParse({ ...dates, charge_windows: [w(12, 13), w(5, 7)] }).success, false, "out of order");
  assertEquals(OrderDocDates.safeParse({ ...dates, charge_windows: [] }).success, false, "never empty");
  // Required since the backfill (beta B): a pair with no windows is refused.
  const { charge_windows: _omit, ...windowless } = { ...dates, charge_windows: undefined };
  assertEquals(OrderDocDates.safeParse(windowless).success, false);
});

Deno.test("ChargeWindow: a start and an end, and nothing else (ruling 8)", () => {
  const ok = { start: at(5, "09:00:00"), end: at(9, "15:00:00") };
  assertEquals(ChargeWindow.safeParse(ok).success, true);
  // A day count is no longer a window's: each line meters its own.
  assertEquals(ChargeWindow.safeParse({ ...ok, days: 5 }).success, false);
  assertEquals(ChargeWindow.safeParse({ ...ok, uid: "x" }).success, false);
});

// ── The pure readers ─────────────────────────────────────────────────────────

Deno.test("chargeWindowBusinessDays and chargeEnvelope are formula-free readers", () => {
  const charge_windows = [
    { start: at(5, "09:00:00"), end: at(7, "15:00:00") },
    { start: at(10, "09:00:00"), end: at(11, "15:00:00") },
  ];
  // Mon–Wed is 3; Sat–Sun is 0. A display count — a line bills its own counts.
  assertEquals(chargeWindowBusinessDays(charge_windows, []), [3, 0]);
  assertEquals(chargeWindowBusinessDays(charge_windows, ["2026-10-06"]), [2, 0], "a holiday inside a window is not a business day");
  assertEquals(chargeEnvelope({ charge_windows }), { start: at(5, "09:00:00"), end: at(11, "15:00:00") });
  assertEquals(chargeEnvelope({ charge_windows: [] }), null);
});

Deno.test("Five-day week meters every window to its own one-week minimum", () => {
  // The rule `billableDays` used to state, now the formula's `minimum.scope: "window"`.
  const meter = (windows: { start: string; end: string }[]) =>
    lineCounts(line(["D", "r"], { counts: [] }), { charge_windows: [{ divider_path: ["D"], windows }], formulas: FORMULAS, holidays: [] }, new Map());
  const w = (s: number, e: number) => ({ start: at(s, "09:00:00"), end: at(e, "15:00:00") });
  // 3 + 4 + 2 business days → 5 + 5 + 5 = 15 → 3 weeks.
  assertEquals(meter([w(5, 7), w(12, 15), w(19, 20)]), [tier("week", 15, 5)]);
  // 8 + 7 + 6 → 21 business days.
  assertEquals(meter([w(5, 14), w(19, 27), w(29, 30)]).map((t) => t.num * 5 / t.den), [8 + 7 + 5]);
  for (let d = 1; d <= 20; d++) {
    assertEquals(meter([businessDayWindow(d)]), fdwCounts(d), `one window of ${d} days is today's floor`);
  }
});

// ── canonicalChargeWindows ───────────────────────────────────────────────────


Deno.test("canonicalChargeWindows: windows to instants only, days_active counted, legacy fields DELETED", () => {
  const out = canonicalChargeWindows({
    delivery_start: at(5, "09:00:00"),
    collection_start: at(16, "15:00:00"),
    days_active: null,
    charge_windows: [
      { start: at(5, "14:00:00", 10, "Z"), end: at(7, "15:00:00") },
      { start: at(12, "09:00:00"), end: at(13, "15:00:00") },
    ],
  } as ChargeDates & Record<string, unknown>, ["2026-10-06"]) as ChargeDates & Record<string, unknown>;
  // A stray `days` (a pre-ruling-8 window) is dropped, and every instant lands in Chicago form.
  assertEquals(out.charge_windows, [
    { start: at(5, "09:00:00"), end: at(7, "15:00:00") },
    { start: at(12, "09:00:00"), end: at(13, "15:00:00") },
  ]);
  // Possession, not a window: Mon 5 → Fri 16 is 10 business days less the holiday on the 6th.
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
    charge_windows: [{ start: at(5, "09:00:00"), end: at(9, "15:00:00") }],
    days_active: 5,
  });
  const late = defaults(at(5, "10:00:00"));
  assertEquals([late.delivery_start, late.collection_start], [at(6, "09:00:00"), at(12, "15:00:00")], "past 8am starts tomorrow");
  const friday = defaults(at(9, "10:00:00"));
  assertEquals(friday.delivery_start, at(12, "09:00:00"), "skips the weekend");
});

Deno.test("applyDateEdit set_possession: one window over possession FOLLOWS it, and so do the ends", () => {
  const moved = ok(applyDateEdit(defaults(), { type: "set_possession", collection_start: at(16, "15:00:00") }, H));
  assertEquals(moved.charge_windows, [{ start: at(5, "09:00:00"), end: at(16, "15:00:00") }]);
  assertEquals(moved.collection_end, at(16, "15:00:00"), "an end equal to its start follows it");
});

Deno.test("applyDateEdit set_possession: an EDITED window does not follow", () => {
  const edited = ok(applyDateEdit(defaults(), { type: "set_window", index: 0, end: at(7, "15:00:00") }, H));
  const moved = ok(applyDateEdit(edited, { type: "set_possession", collection_start: at(16, "15:00:00") }, H));
  assertEquals(moved.charge_windows, [{ start: at(5, "09:00:00"), end: at(7, "15:00:00") }]);
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
  assertEquals(out.charge_windows, [{ start: at(5, "09:00:00"), end: at(16, "15:00:00") }]);
});

Deno.test("applyDateEdit set_possession_days / set_window_days keep the end's own time of day", () => {
  const long = ok(applyDateEdit(defaults(), { type: "set_possession_days", days: 7 }, H));
  assertEquals(long.collection_start, at(13, "15:00:00"));
  assertEquals(long.charge_windows?.[0], { start: at(5, "09:00:00"), end: at(13, "15:00:00") });

  const odd = ok(applyDateEdit(defaults(), { type: "set_window", index: 0, end: at(9, "11:30:00") }, H));
  const shorter = ok(applyDateEdit(odd, { type: "set_window_days", index: 0, days: 2 }, H));
  assertEquals(shorter.charge_windows?.[0], { start: at(5, "09:00:00"), end: at(6, "11:30:00") });
});

Deno.test("applyDateEdit across the DST change: wall time kept, offset moves", () => {
  const friday = { ...defaults(), delivery_start: at(30, "09:00:00"), delivery_end: at(30, "09:00:00") };
  const out = ok(applyDateEdit(
    { ...friday, collection_start: at(30, "15:00:00"), collection_end: at(30, "15:00:00"), charge_windows: [{ start: at(30, "09:00:00"), end: at(30, "15:00:00") }] },
    { type: "set_possession_days", days: 3 },
    H,
  ));
  assertEquals(out.collection_start, at(3, "15:00:00", 11, "-06:00"), "Fri 30 Oct, Mon 2, Tue 3 Nov — still 15:00, now CST");
  assertEquals(chargeWindowBusinessDays(out.charge_windows!, []), [3]);
});

Deno.test("applyDateEdit counts holidays inside a window", () => {
  const out = ok(applyDateEdit(defaults(), { type: "set_possession_days", days: 5 }, { holidays: ["2026-10-07"] }));
  assertEquals(out.collection_start, at(12, "15:00:00"), "the 7th is skipped");
  assertEquals(chargeWindowBusinessDays(out.charge_windows!, ["2026-10-07"]), [5]);
});

Deno.test("applyDateEdit refuses when holidays have not loaded", () => {
  assertEquals(applyDateEdit(defaults(), { type: "set_possession_days", days: 7 }, { holidays: null }), { error: "holidays_unloaded" });
});

Deno.test("applyDateEdit add/remove/reset windows, and the refusals", () => {
  const base = ok(applyDateEdit(defaults(), { type: "set_possession", collection_start: at(23, "15:00:00") }, H));
  const first = ok(applyDateEdit(base, { type: "set_window", index: 0, end: at(7, "15:00:00") }, H));
  const two = ok(applyDateEdit(first, { type: "add_window", start: at(19, "09:00:00"), end: at(20, "15:00:00") }, H));
  assertEquals(chargeWindowBusinessDays(two.charge_windows!, []), [3, 2]);

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
  assertEquals(reset.charge_windows, [{ start: at(5, "09:00:00"), end: at(23, "15:00:00") }]);
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

Deno.test("applyDateEdit copy_from: a new pair takes another pair's dates", () => {
  const source = ok(applyDateEdit(defaults(), { type: "add_window", start: at(19, "09:00:00"), end: at(20, "15:00:00") }, H));
  const copy = ok(applyDateEdit<ChargeDates>({}, { type: "copy_from", dates: source }, { holidays: ["2026-10-19"] }));
  assertEquals(copy.charge_windows, source.charge_windows, "the windows themselves; a line meters them against its own holidays");
  assertEquals(chargeWindowBusinessDays(copy.charge_windows!, ["2026-10-19"]), [5, 1]);
  assertEquals(copy.delivery_start, source.delivery_start);
});

// ── Shared fields: the windows merge as ONE value ────────────────────────────

const PAIR_FIELDS = fieldsUnder(classifySharedFields(OrderSchema, InvoiceSchema), "destinations[]");

Deno.test("classifySharedFields: charge_windows is one propagated value, with no derived key (ruling 8)", () => {
  const field = PAIR_FIELDS.find((f) => f.path === "dates.charge_windows");
  assertEquals(field?.kind, "propagated");
  assertEquals(field?.derived_keys ?? [], [], "a window carries no counted day any more");
});

Deno.test("mergeSharedFields: windows the invoice did not touch follow the order; edited ones stay", () => {
  const w = (end: number) => [{ start: at(5, "09:00:00"), end: at(end, "15:00:00") }];
  const pair = (windows: ReturnType<typeof w>) => ({ dates: { charge_windows: windows } });
  const { merged, overridden } = mergeSharedFields(PAIR_FIELDS, pair(w(9)), pair(w(16)), pair(w(9)));
  assertEquals(overridden, []);
  assertEquals(merged.dates.charge_windows, w(16), "follows the order");

  const edited = mergeSharedFields(PAIR_FIELDS, pair(w(9)), pair(w(16)), pair(w(7)));
  assertEquals(edited.overridden, ["dates.charge_windows"]);
  assertEquals(edited.merged.dates.charge_windows, w(7));
});

Deno.test("resolveMergedPairDates: a mix canonicalizes the windows and carries each _fs from the side that holds its instant", () => {
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
    charge_windows: [{ start: at(5, "09:00:00"), end: at(windowEnd, "15:00:00") }],
  });
  // The downstream's window is NOT its possession, so it does not follow.
  const downstream = dates(9, 7, 1);
  const source = dates(16, 16, 2);
  // Collection from the source, the window kept from the downstream.
  const merged = { ...downstream, collection_start: source.collection_start, collection_end: source.collection_end };
  const out = resolveMergedPairDates(merged, source, downstream, [], canonicalChargeWindows)!;
  assertEquals(out.charge_windows, [{ start: at(5, "09:00:00"), end: at(7, "15:00:00") }]);
  assertEquals(out.days_active, 10);
  assertEquals(out.collection_start_fs, source.collection_start_fs);
  assertEquals(merged.collection_start_fs, downstream.collection_start_fs, "the caller's merged object is not mutated");

  const invalid = { ...merged, charge_windows: [{ start: at(9, "09:00:00"), end: at(5, "15:00:00") }] };
  assertEquals(resolveMergedPairDates(invalid, source, downstream, [], canonicalChargeWindows), null);
});

Deno.test("resolveMergedPairDates: a kept window equal to the downstream's possession follows a merged possession move", () => {
  const dates = (collection: number, windowEnd: number) => ({
    delivery_start: at(5, "09:00:00"),
    delivery_end: at(5, "09:00:00"),
    collection_start: at(collection, "15:00:00"),
    collection_end: at(collection, "15:00:00"),
    days_active: 0,
    charge_windows: [{ start: at(5, "09:00:00"), end: at(windowEnd, "15:00:00") }],
  });
  // The invoice's window is its possession; the order's is not, and did not follow.
  const downstream = dates(9, 9);
  const source = dates(16, 12);
  const merged = { ...downstream, collection_start: source.collection_start, collection_end: source.collection_end };
  const out = resolveMergedPairDates(merged, source, downstream, [], canonicalChargeWindows)!;
  assertEquals(out.charge_windows, [{ start: at(5, "09:00:00"), end: at(16, "15:00:00") }]);
  assertEquals(["charge_end", "days_charged"].filter((k) => k in out), [], "canonicalizing drops the legacy fields");

  // Compared as instants: the same moment in another offset still follows.
  const utc = { ...downstream, charge_windows: [{ start: "2026-10-05T14:00:00.000Z", end: "2026-10-09T20:00:00.000Z" }] };
  const utcOut = resolveMergedPairDates({ ...utc, collection_start: source.collection_start }, source, utc, [], canonicalChargeWindows)!;
  assertEquals(utcOut.charge_windows?.[0].end, at(16, "15:00:00"));

  // Two windows never follow.
  const two = { ...downstream, charge_windows: [{ start: at(5, "09:00:00"), end: at(6, "15:00:00") }, { start: at(8, "09:00:00"), end: at(9, "15:00:00") }] };
  const twoOut = resolveMergedPairDates({ ...two, collection_start: source.collection_start }, source, two, [], canonicalChargeWindows)!;
  assertEquals(twoOut.charge_windows, two.charge_windows);
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
    price: { ...(lineBase.price as object), taxes: [], discount: null, ...legacyPrice({ base_cents: 10000, chargeable_days: 5, ...price }) },
  } as unknown as LineItem;
}

const TAX: PriceDocumentContext["tax"] = {
  destinations: [],
  origin: "chicago",
  exempt: true,
  catalog: { codes: [], rates: [], classes: [] },
  asOf: "2026-10-05T00:00:00.000-05:00",
};
const priceCtx = (charge_windows: PriceDocumentContext["charge_windows"], document: PriceDocumentContext["document"] = { kind: "order", status: "active", stored_items: [] }): PriceDocumentContext => ({ document, tax: TAX, charge_windows, formulas: FORMULAS, holidays: [] });
/** Pair `D`, its windows holding `days[i]` business days each. */
const pairWith = (days: number[]) => chargeWindowContext([{ uid: "D", dates: { charge_windows: businessDayWindows(days) } }]);
/** A Five-day week line's billable days, off its counts; `null` when it has none or is flat. */
const daysOf = (price: { price_formula?: { basis?: string } | null; counts?: { num: number; den: number }[] }): number | null =>
  price.price_formula?.basis === "time" && price.counts?.length ? (price.counts[0].num * 5) / price.counts[0].den : null;
const priced = (it: LineItem, ctx: PriceDocumentContext) => {
  const price = priceDocument([it], ctx).items[0].price as unknown as {
    price_formula: { basis: string } | null; counts: { num: number; den: number }[]; subtotal_cents: number; subtotal_discounted_cents: number;
  };
  return { ...price, days: daysOf(price) };
};

Deno.test("priceDocument: the worked multi-window cases", () => {
  const cases: Array<[number[], number, number]> = [
    [[3, 4, 2], 15, 30000], // 15 billable → 3.0×
    [[3, 0, 4], 15, 30000], // 15 billable → 3.0×
    [[8, 7, 6], 21, 42000], // 21 billable → 4.2×
  ];
  for (const [windows, days, cents] of cases) {
    const out = priced(line(["D"]), priceCtx(pairWith(windows)));
    assertEquals([out.days, out.subtotal_cents], [days, cents], JSON.stringify(windows));
  }
});

Deno.test("priceDocument: a multi-window line's own numbers multiply out to its subtotal (core#114)", () => {
  for (const windows of [[3, 4, 2], [3, 0, 4], [8, 7, 6], [0, 0], [12, 1]]) {
    for (const quantity of [1, 3, 7]) {
      const out = priced(line(["D"], {}, { quantity }), priceCtx(pairWith(windows)));
      assertEquals(out.days, windows.reduce((sum, d) => sum + Math.max(d, 5), 0), JSON.stringify(windows));
      assertEquals(out.subtotal_cents, quantity * 10000 * out.days! / 5, `${JSON.stringify(windows)} × ${quantity}`);
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
    const carried = line(["D"], { ...price, chargeable_days: days }, { quantity });
    const legacy = priced(carried, priceCtx(pairWith([0]), { kind: "order", status: "complete", stored_items: [carried] }));
    assertEquals(windowed, legacy, `days ${days} ${JSON.stringify(price)} × ${quantity}`);
  }
  assert(factorBit > 1000, "anti-vacuity: the day factor was exercised");
});

Deno.test("priceDocument: the line's FORMULA, not its type, decides whether it meters its pair (ruling 8)", () => {
  const ctx = priceCtx(pairWith([12]));
  // A flat formula meters no time: one count, at factor 1, whatever the windows say.
  const fixed = priced(line(["D"], { formula: "fixed", chargeable_days: 12 }), ctx);
  assertEquals([fixed.counts, fixed.subtotal_cents], [[tier("flat", 1, 1)], 10000]);
  const fixedSale = priced(line(["D"], { formula: "fixed" }, { type: "sale" }), ctx);
  assertEquals(fixedSale.subtotal_cents, 10000);
  // A time formula meters, on a sale as on a rental: the backfill moves factor-1
  // lines to Fixed rather than relying on the type.
  const rental = priced(line(["D"], { chargeable_days: 5 }), ctx);
  assertEquals([rental.days, rental.subtotal_cents], [12, 24000]);
  const sale = priced(line(["D"], { chargeable_days: 5 }, { type: "sale" }), ctx);
  assertEquals([sale.days, sale.subtotal_cents], [12, 24000]);
});

Deno.test("priceDocument: a time-formula line under no pair is refused", () => {
  assertThrows(() => priceDocument([line(["order-divider"])], priceCtx(pairWith([5]))), PriceRefusalError, "under no destination pair with charge windows");
});

Deno.test("priceDocument: a complete or canceled order keeps the stored days of the lines it already carried", () => {
  for (const status of ["complete", "canceled"] as const) {
    const carried = line(["D"], { chargeable_days: 5 });
    const out = priced(carried, priceCtx(pairWith([7]), { kind: "order", status, stored_items: [carried] }));
    assertEquals([out.days, out.subtotal_cents], [5, 10000], status);
  }
  const live = priced(line(["D"], { chargeable_days: 5 }), priceCtx(pairWith([7]), { kind: "invoice", status: "issued", has_settlement: false }));
  assertEquals(live.days, 7, "an issued, unpaid invoice is re-derived");
});

// ── A line ADDED to a frozen order (api-cloudrun#1341) ────────────────────────
// The census decision protects days a `complete` order already carried. A line
// the edit adds — a `custom-` rental books nothing, so the order stays complete —
// has none to protect, and derives its days like any live line.

const frozen = (stored_items: LineItem[]): PriceDocumentContext["document"] => ({ kind: "order", status: "complete", stored_items });
const pricedAll = (items: LineItem[], ctx: PriceDocumentContext) =>
  priceDocument(items, ctx).items.map((it) => {
    const price = it.price as unknown as { price_formula: { basis: string }; counts: { num: number; den: number }[]; subtotal_cents: number };
    return { ...price, days: daysOf(price) };
  });

Deno.test("api-cloudrun#1341: a rental added to a complete 2-window order bills its metered count, not the client's seed", () => {
  const carried = line(["D"], { chargeable_days: 4 }); // a legacy count the windows disagree with (stored floored: 5)
  const added = line(["D"], { chargeable_days: 11 }, { uid: "custom-x", path: ["D", "custom-x"] }); // 8 + 3 raw
  const [keep, add] = pricedAll([carried, added], priceCtx(pairWith([8, 3]), frozen([carried])));
  assertEquals([add.days, add.subtotal_cents], [13, 26000], "Σ max(d,5) = 8 + 5");
  assertEquals([keep.days, keep.subtotal_cents], [5, 10000], "the carried line keeps its own counts");
});

Deno.test("a carried line keeps its STORED row's days when the incoming row has none (order 1013)", () => {
  // The order input schema strips `counts`, so a PUT's every row arrives
  // without them. Reading the incoming row nulled 25 lines of complete order
  // 1013 and repriced it at the one-week floor, $4,952.91 → $2,667.17.
  const stored = line(["D"], { chargeable_days: 19 });
  const incoming = { ...stored, price: { ...stored.price, counts: [] } } as LineItem;
  const out = priced(incoming, priceCtx(pairWith([7]), frozen([stored])));
  assertEquals([out.days, out.subtotal_cents], [19, 38000]);
});

Deno.test("api-cloudrun#1341: a rental added to a complete one-window order bills that window", () => {
  const added = line(["D"], { chargeable_days: 2 });
  assertEquals(priced(added, priceCtx(pairWith([9]), frozen([]))).days, 9);
});

Deno.test("api-cloudrun#1341: an added rental seeded null derives its days instead of billing the one-week floor", () => {
  const added = line(["D"], { chargeable_days: null });
  const out = priced(added, priceCtx(pairWith([8, 3]), frozen([])));
  assertEquals([out.days, out.subtotal_cents], [13, 26000]);
});

Deno.test("api-cloudrun#1341: an added rental under no pair is refused, not priced at one week", () => {
  assertThrows(
    () => priceDocument([line(["X"], { chargeable_days: null })], priceCtx(pairWith([8, 3]), frozen([]))),
    PriceRefusalError,
    "under no destination pair with charge windows",
  );
});

Deno.test("api-cloudrun#1341: a carried line MOVED to another group still keeps its days", () => {
  // A path changes on a move; re-deriving would change a finished job's money.
  const stored = line(["D", "G1"], { chargeable_days: 4 });
  // Stripped, as every row of an API write is: the days come off the stored row.
  const moved = { ...stored, path: ["D", "G2", stored.uid], price: { ...stored.price, counts: [] } } as LineItem;
  assertEquals(priced(moved, priceCtx(pairWith([8, 3]), frozen([stored]))).days, 5);
});

Deno.test("api-cloudrun#1341: a second row of a uid the order already carries is NOT carried", () => {
  // A uid repeats, so a uid set would let the extra row keep the client's seed.
  const stored = line(["D", "G1"], { chargeable_days: 4 });
  const extra = { ...stored, path: ["D", "G2", stored.uid], price: { ...stored.price, counts: fdwCounts(11) } } as LineItem;
  const [keep, add] = pricedAll([stored, extra], priceCtx(pairWith([8, 3]), frozen([stored])));
  assertEquals([keep.days, add.days], [5, 13]);
});

Deno.test("carriedLines: empty on every document that is not a frozen order", () => {
  const it = line(["D"]);
  const live: PriceDocumentContext["document"][] = [
    { kind: "order", status: "active", stored_items: [it] },
    { kind: "order", status: "draft", stored_items: [it] },
    { kind: "invoice", status: "issued", has_settlement: false },
  ];
  for (const document of live) {
    assertEquals(carriedLines([it], document).size, 0, `${document.kind}/${document.status}`);
  }
  assertEquals(carriedLines([it], frozen([it])).size, 1, "…and the frozen arm is not vacuous");
});

Deno.test("chargeWindowContext: an EMPTY windows array is refused — null means none", () => {
  assertThrows(() => chargeWindowContext([{ uid: "D", dates: { charge_windows: [] } }]), PriceRefusalError, "empty charge_windows");
});

Deno.test("chargeWindowContext: a pair whose windows are null bills no days and is left out (api-cloudrun#1154)", () => {
  // A sales-only document's pairs carry `charge_windows: null`. Pricing it must not
  // throw: its lines never read days, and a rental under such a pair is refused
  // where it is priced, naming the line.
  assertEquals(chargeWindowContext([{ uid: "D", dates: { charge_windows: null } }]), []);
  const sale = { ...line(["D"]), type: "sale" as const, price: { ...line(["D"]).price, ...fixedPrice(0) } };
  assertEquals(lineCounts(sale as never, priceCtx([]), new Map()), [tier("flat", 1, 1)]);
  assertThrows(() => lineCounts(line(["D"]), priceCtx([]), new Map()), PriceRefusalError, "under no destination pair with charge windows");
});

Deno.test("chargeWindowContext: an invoice pair's divider path is [uid_order, uid]", () => {
  const windows = businessDayWindows([3, 4]);
  const ctx = chargeWindowContext([{ uid: "D", uid_order: "O", dates: { charge_windows: windows } }]);
  assertEquals(ctx, [{ divider_path: ["O", "D"], windows }]);
  const onInvoice = line(["O", "D"]);
  assertEquals(lineCounts(onInvoice, priceCtx(ctx), new Map()), [tier("week", 10, 5)]);
});

Deno.test("priceDocument: an extension line bills its OWN stated counts, unfloored, never its window", () => {
  const priceExt = (counts: ReturnType<typeof fdwCounts>) => {
    const ext = line(["O", "E"], { counts });
    return priceDocument([EXT_DIVIDER, ext], {
      ...priceCtx(chargeWindowContext([{ uid: "E", uid_order: "O", dates: { charge_windows: businessDayWindows([4]) } }]), { kind: "invoice", status: "draft", has_settlement: false }),
    }).items[1].price as unknown as { counts: { num: number; den: number }[]; subtotal_cents: number };
  };
  // The section's writer states the added days (ruling 8); the window's 4 business days are not consulted.
  const stated = priceExt(fdwCounts(2, { stated: true }));
  assertEquals([stated.counts, stated.subtotal_cents], [[tier("week", 2, 5)], 4000]);
  // A line arriving with none has nothing to extend by.
  assertThrows(() => priceExt([]), PriceRefusalError, "states no counts");
});

Deno.test("priceCreditNote: a line billed on a multi-window pair is credited at its stored counts", () => {
  const src = (counts: { rate_key: string; num: number; den: number }[]): CreditSourceLine => ({
    uid: "r1",
    path: ["O", "D", "r1"],
    type: "rental",
    quantity: 1,
    price: { ...fdwPrice(10000), counts, discount: null, taxes: [] },
  });
  const billed = priced(line(["D"]), priceCtx(pairWith([3, 4, 2])));
  assertEquals(priceCreditNote([{ line: src(billed.counts as never), quantity: 1 }], [], []).prices[0].subtotal_cents, billed.subtotal_cents);
  assertEquals(priceCreditNote([{ line: src(fdwCounts(9)), quantity: 1 }], [], []).prices[0].subtotal_cents, 18000, "one window: its own days");
});

// ── The pair invariant, checked on write (core#113) ──────────────────────────

/**
 * A line stating `days` as its counts (unfloored), under pair `D`, so a test can
 * put a WRONG count on a multi-window pair — which the pricer cannot produce.
 */
const storedLine = (days: number | null, path = ["D"]) => line(path, { counts: days === null ? [] : fdwCounts(days, { stated: true }) });
const PAIR_CTX = { formulas: FORMULAS, holidays: [] as string[] };

Deno.test("chargeWindowPairViolations: a 2+ window pair requires the metered counts, and reports the difference", () => {
  const ctx = (document: PriceDocumentContext["document"] = { kind: "order", status: "active", stored_items: [] }) => ({
    document,
    charge_windows: pairWith([3, 4, 2]),
    ...PAIR_CTX,
  });
  // [3,4,2] → Σ max(d,5) = 15. The pricer's own output is the clean case.
  const clean = priced(line(["D"]), priceCtx(pairWith([3, 4, 2])));
  assertEquals(clean.days, 15);
  assertEquals(chargeWindowPairViolations([storedLine(15)], ctx()), []);

  // …and the guard BITES on a line that skipped the pricer. Without this arm
  // every other assertion here could pass over a walker that reaches nothing.
  const offender = storedLine(9);
  const bad = chargeWindowPairViolations([offender], ctx());
  assertEquals(bad.length, 1);
  assertEquals([bad[0].stored, bad[0].expected], [[tier("week", 9, 5)], [tier("week", 15, 5)]], "it states both, so a report need not re-derive either");
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
  const ctx = { document: { kind: "order", status: "active", stored_items: [] } as const, charge_windows: pairWith([9]), ...PAIR_CTX };
  assertEquals(chargeWindowPairViolations([storedLine(4)], ctx), []);
  assertEquals(chargeWindowPairViolations([storedLine(9)], ctx), []);
});

Deno.test("chargeWindowPairViolations: only a time-formula line is checked", () => {
  const ctx = { document: { kind: "order", status: "active", stored_items: [] } as const, charge_windows: pairWith([3, 4, 2]), ...PAIR_CTX };
  // A flat-formula line meters no time, whatever its type.
  assertEquals(chargeWindowPairViolations([line(["D"], { formula: "fixed" }, { type: "sale" })], ctx), []);
  assertEquals(chargeWindowPairViolations([line(["D"], { formula: "fixed" })], ctx), []);
  // A time line with NO pair is lineCounts' refusal to make, not this one's.
  assertEquals(chargeWindowPairViolations([storedLine(9, [])], ctx), []);
});

Deno.test("chargeWindowPairViolations: a document that keeps its stored days is exempt", () => {
  const items = [storedLine(9)];
  const windows = pairWith([3, 4, 2]);
  const exempt: PriceDocumentContext["document"][] = [
    { kind: "order", status: "complete", stored_items: [] },
    { kind: "order", status: "canceled", stored_items: [] },
    { kind: "invoice", status: "void", has_settlement: false },
    { kind: "invoice", status: "paid", has_settlement: false },
    { kind: "invoice", status: "issued", has_settlement: true },
  ];
  for (const document of exempt) {
    const label = `${document.kind}/${document.status}${"has_settlement" in document && document.has_settlement ? "+settled" : ""}`;
    assertEquals(chargeWindowPairViolations(items, { document, charge_windows: windows, ...PAIR_CTX }), [], label);
  }
  // …and the live ones are NOT exempt, so the arm above cannot pass vacuously.
  const live: PriceDocumentContext["document"][] = [
    { kind: "order", status: "draft", stored_items: [] },
    { kind: "order", status: "active", stored_items: [] },
    { kind: "invoice", status: "issued", has_settlement: false },
  ];
  for (const document of live) {
    assertEquals(chargeWindowPairViolations(items, { document, charge_windows: windows, ...PAIR_CTX }).length, 1, `${document.kind}/${document.status}`);
  }
});

Deno.test("chargeWindowPairViolations: an extension line bills the days it ADDS, not its pair's total", () => {
  const ext = line(["O", "E"], { counts: fdwCounts(2, { stated: true }) });
  const windows = chargeWindowContext([{ uid: "E", uid_order: "O", dates: { charge_windows: businessDayWindows([3, 4]) } }]);
  const document = { kind: "invoice", status: "draft", has_settlement: false } as const;
  // Under the section: exempt — 2 is the added days, while the windows meter 10.
  assertEquals(chargeWindowPairViolations([EXT_DIVIDER, ext], { document, charge_windows: windows, ...PAIR_CTX }), []);
  // The SAME line with no extension section declared is checked, so the
  // exemption is the section's doing rather than the line's shape.
  assertEquals(chargeWindowPairViolations([ext], { document, charge_windows: windows, ...PAIR_CTX }).length, 1);
});
