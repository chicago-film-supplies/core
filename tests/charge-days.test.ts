import { assertEquals, assertStrictEquals } from "@std/assert";
import { reconcileChargeDaysByDestination, resolveDownstreamChargeDays } from "../src/utils/orders.ts";

type Row = { uid: string; type: string; path: string[]; price?: { chargeable_days: number | null } };

const pair = (uid: string, days: number | null) => ({ uid, dates: { days_charged: days } });
const row = (uid: string, path: string[], days: number | null): Row => ({ uid, type: "rental", path, price: { chargeable_days: days } });
const daysOf = (rows: readonly Row[]) => rows.map((r) => r.price?.chargeable_days ?? null);

// ── reconcileChargeDaysByDestination ─────────────────────────────────────────

Deno.test("reconcileChargeDaysByDestination: only the moved destination's default-following lines move", () => {
  const items: Row[] = [
    { uid: "d1", type: "destination", path: ["d1"] },
    row("a", ["d1", "a"], 5), // follows d1
    row("b", ["d1", "b"], 3), // hand-set
    { uid: "d2", type: "destination", path: ["d2"] },
    row("c", ["d2", "c"], 5), // follows d2, which does not move
  ];
  const out = reconcileChargeDaysByDestination(items, [pair("d1", 5), pair("d2", 5)], [pair("d1", 7), pair("d2", 5)]);
  assertEquals(daysOf(out), [null, 7, 3, null, 5]);
  assertStrictEquals(out[2], items[2], "an untouched line is shared, not copied");
});

Deno.test("reconcileChargeDaysByDestination: reads the destination from the path at any depth (invoice scoping)", () => {
  const items = [row("a", ["order-1", "d1", "grp", "a"], 5)];
  assertEquals(daysOf(reconcileChargeDaysByDestination(items, [pair("d1", 5)], [pair("d1", 2)])), [2]);
});

Deno.test("reconcileChargeDaysByDestination: a null previous default moves nothing, and never mutates", () => {
  const items = [row("a", ["d1", "a"], 5)];
  const snapshot = structuredClone(items);
  assertEquals(daysOf(reconcileChargeDaysByDestination(items, [pair("d1", null)], [pair("d1", 7)])), [5]);
  reconcileChargeDaysByDestination(items, [pair("d1", 5)], [pair("d1", 7)]);
  assertEquals(items, snapshot);
});

// ── resolveDownstreamChargeDays ──────────────────────────────────────────────

const resolve = (o: Partial<Parameters<typeof resolveDownstreamChargeDays>[0]>) =>
  resolveDownstreamChargeDays({
    nextSourceDays: 5,
    nextSourceDefault: 5,
    storedDays: 5,
    mergedDays: 5,
    prevDownstreamDefault: 5,
    nextDownstreamDefault: 5,
    ...o,
  });

Deno.test("resolveDownstreamChargeDays: 🔴 order dates AND default-following days move while the invoice overrode its dates", () => {
  // Order 5 → 7 because its window moved. The invoice kept its own 5-day window,
  // so the merge's 7 (stored 5 = prev order 5) would bill 7 days against it.
  assertEquals(resolve({ nextSourceDays: 7, nextSourceDefault: 7, mergedDays: 7, nextDownstreamDefault: 5 }), 5);
});

Deno.test("resolveDownstreamChargeDays: an unedited invoice follows the order's date move through its own pair", () => {
  assertEquals(resolve({ nextSourceDays: 7, nextSourceDefault: 7, mergedDays: 7, nextDownstreamDefault: 7 }), 7);
});

Deno.test("resolveDownstreamChargeDays: an operator's hand-set days on the ORDER still propagate", () => {
  // Order line set to 3 against a default of 5; invoice line was following its default.
  assertEquals(resolve({ nextSourceDays: 3, nextSourceDefault: 5, mergedDays: 3 }), 3);
});

Deno.test("resolveDownstreamChargeDays: an invoice line hand-set away from its default keeps the merge's answer", () => {
  // Stored 9 against an invoice default of 5: a value, so the merge decides (kept 9).
  assertEquals(resolve({ storedDays: 9, mergedDays: 9, nextSourceDays: 7, nextSourceDefault: 7, nextDownstreamDefault: 7 }), 9);
});

Deno.test("resolveDownstreamChargeDays: an order hand-set value the invoice had diverged from — keep following the invoice default", () => {
  // Order 3 → 4 by hand; the invoice line sat at its own default 5 (≠ prev order 3), so the merge kept 5.
  assertEquals(resolve({ nextSourceDays: 4, nextSourceDefault: 5, mergedDays: 5, nextDownstreamDefault: 6 }), 6);
});

Deno.test("resolveDownstreamChargeDays: a line with no day count (a sale) stays null", () => {
  assertEquals(resolve({ storedDays: null, mergedDays: null, nextSourceDays: null }), null);
});
