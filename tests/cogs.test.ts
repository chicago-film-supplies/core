/**
 * The cost model (`utils/cogs.ts`, api-cloudrun serialized-subrent § 7a): the
 * derived sale default, and the period cut that every activation-cost reader
 * shares. The period cases are the owner's rulings, one per case — Q11 (any
 * active day bills the whole period) and Q11b (a week is anchored on the
 * unit's first activation under the entry) — plus the two Chicago-calendar
 * hazards (a DST week, a month edge in UTC).
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  billablePeriods,
  type BillableSpan,
  cogsActivationEntry,
  DEFAULT_SALE_COA_COST,
  effectiveCogs,
  remainingUsageToBill,
  spanInstants,
} from "../src/utils/cogs.ts";
import { type CogsActivationEntryType, CogsEntry, ProductSchema, UpdateProductInput } from "../src/schemas/mod.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const WEEK: CogsActivationEntryType = {
  trigger: "activation",
  uid: "5f1d1b62-2c1a-4e8b-9d0e-7a6b5c4d3e2f",
  label: "Vision hotspot line",
  coa_cost: 5100,
  formula: "per_week",
  provider: { uid: "VisionComms000000000", name: "Vision Communications" },
  ownership: "supplier",
  rate_cents: 4500,
};
const MONTH: CogsActivationEntryType = {
  ...WEEK,
  uid: "8a7b6c5d-4e3f-4a1b-9c2d-1e0f9a8b7c6d",
  label: "Verizon line",
  coa_cost: 5150,
  formula: "per_calendar_month",
  provider: { uid: "Verizon0000000000000", name: "Verizon" },
  ownership: "cfs",
  rate_cents: 8000,
};

let n = 0;
function span(start: string, end: string | null, over: Partial<BillableSpan> = {}): BillableSpan {
  n += 1;
  return { uid: `span-${n}`, start, end, uid_cogs: WEEK.uid, provider_confirmed: null, ...over };
}
const ALL = { start: null, end: "2027-01-01T00:00:00.000-06:00" };

// ── effectiveCogs ────────────────────────────────────────────────────

Deno.test("effectiveCogs: a sale product with no sale entry relieves to the derived 5000 default", () => {
  const got = effectiveCogs({ type: "sale" });
  assertEquals(got, [{ trigger: "sale", formula: "average_cost", label: "Inventory relief", coa_cost: DEFAULT_SALE_COA_COST }]);
  assertEquals(DEFAULT_SALE_COA_COST, 5000, "byte-identical to the literal the Xero item body sent");
});

Deno.test("effectiveCogs: a stored sale entry wins; a rental gets no sale default; activation entries pass through", () => {
  const own = { trigger: "sale" as const, formula: "average_cost" as const, label: "Packaging", coa_cost: 5600 as const };
  assertEquals(effectiveCogs({ type: "sale", cogs: [own] }), [own]);
  assertEquals(effectiveCogs({ type: "rental" }), []);
  assertEquals(effectiveCogs({ type: "rental", cogs: [WEEK] }), [WEEK]);
  assertEquals(effectiveCogs({ type: "sale", cogs: [WEEK] }).map((e) => e.trigger), ["sale", "activation"]);
});

Deno.test("cogsActivationEntry: finds by uid, never a sale entry", () => {
  assertEquals(cogsActivationEntry({ cogs: [WEEK, MONTH] }, MONTH.uid), MONTH);
  assertEquals(cogsActivationEntry({ cogs: [WEEK] }, MONTH.uid), undefined);
  assertEquals(cogsActivationEntry({}, WEEK.uid), undefined);
});

// ── the schema ───────────────────────────────────────────────────────

Deno.test("CogsEntry: the union makes provider, ownership, rate and uid required on activation and absent on sale", () => {
  assert(CogsEntry.safeParse(WEEK).success);
  assert(CogsEntry.safeParse({ trigger: "sale", formula: "average_cost", label: "Relief", coa_cost: 5000 }).success);
  const { rate_cents: _r, ...noRate } = WEEK;
  assert(!CogsEntry.safeParse(noRate).success, "an activation entry states its rate");
  assert(!CogsEntry.safeParse({ trigger: "sale", formula: "average_cost", label: "R", coa_cost: 5000, provider: WEEK.provider }).success);
  assert(!CogsEntry.safeParse({ ...WEEK, coa_cost: 6201 }).success, "6201 is not a Direct Costs account");
  assert(!CogsEntry.safeParse({ ...WEEK, rate_cents: 45.5 }).success, "rate_cents is integer cents");
  assert(!CogsEntry.safeParse({ ...WEEK, formula: "per_day" }).success);
});

Deno.test("Product.cogs: absent-only, one sale entry at most, activation uids unique", () => {
  const product = getTestDoc(ProductSchema, {}, { now: mockTimestamp });
  assertEquals("cogs" in product, false, "a fixture states no cost rules");
  assert(ProductSchema.safeParse({ ...product, cogs: [WEEK, MONTH] }).success);
  const sale = { trigger: "sale", formula: "average_cost", label: "R", coa_cost: 5000 };
  assert(!ProductSchema.safeParse({ ...product, cogs: [sale, sale] }).success);
  assert(!ProductSchema.safeParse({ ...product, cogs: [WEEK, { ...MONTH, uid: WEEK.uid }] }).success);
  assert(!ProductSchema.safeParse({ ...product, cogs: null }).success, "storage never holds null");
});

Deno.test("Product.uid_superseded_by: absent-only, and never itself", () => {
  const product = getTestDoc(ProductSchema, {}, { now: mockTimestamp });
  assert(ProductSchema.safeParse({ ...product, uid_superseded_by: "SurvivorProduct00000" }).success);
  const self = ProductSchema.safeParse({ ...product, uid_superseded_by: product.uid });
  assert(!self.success);
  assertEquals(self.error.issues.map((i) => i.path.join(".")), ["uid_superseded_by"]);
});

Deno.test("UpdateProductInput: null clears cogs and the supersession pointer; self-reference is refused", () => {
  const base = { uid: "ProductUid0000000000", version: 1 };
  assert(UpdateProductInput.safeParse({ ...base, cogs: null, uid_superseded_by: null }).success);
  assert(UpdateProductInput.safeParse({ ...base, cogs: [{ ...WEEK, stray: 1 }] }).success, "an input strips unknown keys");
  assert(!UpdateProductInput.safeParse({ ...base, uid_superseded_by: base.uid }).success);
});

// ── spanInstants ─────────────────────────────────────────────────────

Deno.test("spanInstants: the provider's confirmed pair wins; a half-confirmed ended span stays CFS's", () => {
  const s = span("2026-10-01T09:00:00.000-05:00", "2026-10-03T09:00:00.000-05:00");
  assertEquals(spanInstants(s).source, "cfs");
  const full = { ...s, provider_confirmed: { start: "2026-10-01T10:00:00.000-05:00", end: "2026-10-03T08:00:00.000-05:00" } };
  assertEquals(spanInstants(full), { start: "2026-10-01T10:00:00.000-05:00", end: "2026-10-03T08:00:00.000-05:00", source: "provider" });
  const half = { ...s, provider_confirmed: { start: "2026-10-01T10:00:00.000-05:00", end: null } };
  assertEquals(spanInstants(half), { start: "2026-10-01T10:00:00.000-05:00", end: s.end, source: "cfs" });
  const open = { ...span("2026-10-01T09:00:00.000-05:00", null), provider_confirmed: { start: "2026-10-01T10:00:00.000-05:00", end: null } };
  assertEquals(spanInstants(open).source, "provider", "still on, and the on-instant is confirmed");
});

// ── billablePeriods: per_week ────────────────────────────────────────

Deno.test("per_week: any active day bills the whole week (Q11)", () => {
  const got = billablePeriods([span("2026-10-07T15:00:00.000-05:00", "2026-10-07T16:00:00.000-05:00")], WEEK, ALL);
  assertEquals(got.periods.map((p) => [p.start, p.end]), [["2026-10-07T00:00:00.000-05:00", "2026-10-14T00:00:00.000-05:00"]]);
  assertEquals(got.expectedCents, 4500);
});

Deno.test("per_week: a re-activation inside a week already billed continues it — no second period (Q11b)", () => {
  const a = span("2026-10-07T09:00:00.000-05:00", "2026-10-08T09:00:00.000-05:00");
  const b = span("2026-10-11T09:00:00.000-05:00", "2026-10-12T09:00:00.000-05:00");
  const got = billablePeriods([b, a], WEEK, ALL);
  assertEquals(got.periods.length, 1);
  assertEquals(got.periods[0].activation_uids, [a.uid, b.uid]);
  // A re-activation in the NEXT cycle bills that cycle, anchored on the first activation, not the second.
  const c = span("2026-10-15T09:00:00.000-05:00", "2026-10-16T09:00:00.000-05:00");
  const two = billablePeriods([a, c], WEEK, ALL);
  assertEquals(two.periods.map((p) => p.start), ["2026-10-07T00:00:00.000-05:00", "2026-10-14T00:00:00.000-05:00"]);
  assertEquals(two.expectedCents, 9000);
});

Deno.test("per_week: an idle week between spans is not billed", () => {
  const got = billablePeriods(
    [span("2026-10-07T09:00:00.000-05:00", "2026-10-08T09:00:00.000-05:00"), span("2026-10-22T09:00:00.000-05:00", "2026-10-23T09:00:00.000-05:00")],
    WEEK,
    ALL,
  );
  assertEquals(got.periods.map((p) => p.start), ["2026-10-07T00:00:00.000-05:00", "2026-10-21T00:00:00.000-05:00"]);
});

Deno.test("per_week: a week across the fall-back change is 7 CALENDAR days, not 168 hours", () => {
  // 2026-11-01 is the CDT→CST change. A 168-hour week from 2026-10-28 00:00 CDT
  // would end at 2026-11-03 23:00 CST, one hour inside the wrong calendar day.
  const got = billablePeriods([span("2026-10-28T09:00:00.000-05:00", "2026-11-04T09:00:00.000-06:00")], WEEK, ALL);
  assertEquals(got.periods.map((p) => [p.start, p.end]), [
    ["2026-10-28T00:00:00.000-05:00", "2026-11-04T00:00:00.000-06:00"],
    ["2026-11-04T00:00:00.000-06:00", "2026-11-11T00:00:00.000-06:00"],
  ]);
});

Deno.test("per_week: switched off exactly at a cycle edge bills nothing of the next cycle; a zero-length span bills nothing", () => {
  const edge = billablePeriods([span("2026-10-07T09:00:00.000-05:00", "2026-10-14T00:00:00.000-05:00")], WEEK, ALL);
  assertEquals(edge.periods.length, 1);
  assertEquals(billablePeriods([span("2026-10-07T09:00:00.000-05:00", "2026-10-07T09:00:00.000-05:00")], WEEK, ALL).periods, []);
});

Deno.test("per_week: an open span runs on to the range end; the range filters periods but not the anchor", () => {
  const s = span("2026-10-07T09:00:00.000-05:00", null);
  const oct = billablePeriods([s], WEEK, { start: "2026-10-14T00:00:00.000-05:00", end: "2026-10-28T00:00:00.000-05:00" });
  assertEquals(oct.periods.map((p) => p.start), ["2026-10-14T00:00:00.000-05:00", "2026-10-21T00:00:00.000-05:00"]);
});

Deno.test("billablePeriods: only spans under THIS entry count", () => {
  const other = span("2026-10-07T09:00:00.000-05:00", "2026-10-08T09:00:00.000-05:00", { uid_cogs: MONTH.uid });
  assertEquals(billablePeriods([other], WEEK, ALL), { periods: [], expectedCents: 0 });
});

Deno.test("billablePeriods: provider-confirmed instants decide the period", () => {
  // CFS logged it on the 13th (week 1); the provider says it came on the 14th (week 2).
  const s = span("2026-10-13T23:00:00.000-05:00", "2026-10-15T09:00:00.000-05:00", {
    provider_confirmed: { start: "2026-10-14T01:00:00.000-05:00", end: "2026-10-15T09:00:00.000-05:00" },
  });
  const got = billablePeriods([s], WEEK, ALL);
  assertEquals(got.periods.map((p) => p.start), ["2026-10-14T00:00:00.000-05:00"]);
});

// ── billablePeriods: per_calendar_month ──────────────────────────────

Deno.test("per_calendar_month: Chicago months, any active day bills the month", () => {
  const s = span("2026-10-30T09:00:00.000-05:00", "2026-11-02T09:00:00.000-06:00", { uid_cogs: MONTH.uid });
  const got = billablePeriods([s], MONTH, ALL);
  assertEquals(got.periods.map((p) => [p.start, p.end]), [
    ["2026-10-01T00:00:00.000-05:00", "2026-11-01T00:00:00.000-05:00"],
    ["2026-11-01T00:00:00.000-05:00", "2026-12-01T00:00:00.000-06:00"],
  ]);
  assertEquals(got.expectedCents, 16000);
});

Deno.test("per_calendar_month: 23:30 on Oct 31 in Chicago is October, though it is November in UTC", () => {
  const s = span("2026-10-31T23:00:00.000-05:00", "2026-10-31T23:30:00.000-05:00", { uid_cogs: MONTH.uid });
  assertEquals(billablePeriods([s], MONTH, ALL).periods.map((p) => p.start), ["2026-10-01T00:00:00.000-05:00"]);
});

// ── remainingUsageToBill ─────────────────────────────────────────────

Deno.test("remainingUsageToBill: Σ each unit's billable periods − quantity_billed; negative is over-billed", () => {
  const unitA = [span("2026-10-07T09:00:00.000-05:00", "2026-10-15T09:00:00.000-05:00")]; // 2 weeks
  const unitB = [span("2026-10-20T09:00:00.000-05:00", "2026-10-21T09:00:00.000-05:00")]; // 1 week
  const item = { uid_cogs: WEEK.uid, quantity_billed: 1 };
  assertEquals(remainingUsageToBill(item, [unitA, unitB], WEEK, ALL), 2);
  assertEquals(remainingUsageToBill({ ...item, quantity_billed: 4 }, [unitA, unitB], WEEK, ALL), -1);
  assertThrows(() => remainingUsageToBill({ uid_cogs: MONTH.uid, quantity_billed: 0 }, [unitA], WEEK, ALL), Error, "bills cost entry");
});
