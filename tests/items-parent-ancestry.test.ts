/**
 * core#129 — a component's parent is resolved by its ANCESTRY, not its uid,
 * everywhere one document can hold two rows sharing that uid.
 *
 * The shape is common in the catalog: the 25' Extension Cord sits inside both
 * Hair & Makeup Mirror variants and also ships standalone, so "the row whose uid
 * is CORD" names two rows in one group. Every expected value below is written by
 * hand — none is derived from the code under test.
 *
 * Uids follow the real grammar, because the component signature reads it:
 * dividers are bare UUIDs, products are not.
 */
import { assertEquals } from "@std/assert";
import {
  computeItemPaths,
  getGroupPath,
  type LineItem,
  moveLinesToLeg,
  validateItemPaths,
  validateItemUniqueness,
} from "../src/utils/orders.ts";
import { rebuildFulfillmentItems } from "../src/utils/fulfillment-items.ts";
import { adoptOrderDividerStructure, carryForwardOverrides, type InvoiceItem } from "../src/utils/invoices.ts";
import { type ReplacementSourceProduct, seedReplacementLines } from "../src/utils/replacements.ts";
import { componentSignatureHash } from "../src/utils/booking-id.ts";
import type { FulfillmentItemType, FulfillmentLineItemType } from "../src/schemas/fulfillment.ts";
import type { InvoiceDocItemType } from "../src/schemas/invoice.ts";

const D = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const G = "00000000-0000-4000-8000-0000000000a1";
const G2 = "00000000-0000-4000-8000-0000000000a2";
const GB = "00000000-0000-4000-8000-0000000000b1";
const ORDER = "Order000000000000129";

const MIRROR = "MirrorKit";
const MIRROR2 = "MirrorKitDeluxe";
const CORD = "ExtCord25";
const PLUG = "PlugAdapter";
const ROLLING = "RollingSetKit";
const PIPES = "PipesCase";
const LED = "LedBar";
const BULB = "LedBulb";

// deno-lint-ignore no-explicit-any
type Row = any;
const dest = (uid: string): Row => ({ uid, type: "destination", path: [] });
const group = (uid: string): Row => ({ uid, type: "group", path: [] });
const line = (uid: string, path: string[], extra: Record<string, unknown> = {}): Row => ({
  uid,
  type: "rental",
  path,
  quantity: 1,
  zero_priced: path.length > 1 ? true : null,
  ...extra,
});
const paths = (items: { uid: string; path?: string[] }[]) => items.map((i) => [i.uid, i.path]);

// ── computeItemPaths ─────────────────────────────────────────────

// The two input orders a client can send, with the chains
// `buildOrderComponentLines` emits (component ancestry, own uid last).
const standaloneCord = [line(CORD, []), line(PLUG, [CORD, PLUG])];
const mirrorWithCord = [line(MIRROR, []), line(CORD, [MIRROR, CORD]), line(PLUG, [MIRROR, CORD, PLUG])];

Deno.test("computeItemPaths: A — standalone cord first, then a mirror holding a cord", () => {
  const out = computeItemPaths([dest(D), group(G), ...standaloneCord, ...mirrorWithCord]);
  assertEquals(paths(out), [
    [D, [D]],
    [G, [D, G]],
    [CORD, [D, G, CORD]],
    [PLUG, [D, G, CORD, PLUG]],
    [MIRROR, [D, G, MIRROR]],
    [CORD, [D, G, MIRROR, CORD]],
    [PLUG, [D, G, MIRROR, CORD, PLUG]],
  ]);
  assertEquals(validateItemUniqueness(out), []);
  assertEquals(validateItemPaths(out), []);
});

Deno.test("computeItemPaths: B — the mirror first, then the standalone cord", () => {
  const out = computeItemPaths([dest(D), group(G), ...mirrorWithCord, ...standaloneCord]);
  assertEquals(paths(out), [
    [D, [D]],
    [G, [D, G]],
    [MIRROR, [D, G, MIRROR]],
    [CORD, [D, G, MIRROR, CORD]],
    [PLUG, [D, G, MIRROR, CORD, PLUG]],
    [CORD, [D, G, CORD]],
    [PLUG, [D, G, CORD, PLUG]],
  ]);
  assertEquals(validateItemUniqueness(out), []);
  assertEquals(validateItemPaths(out), []);
});

Deno.test("computeItemPaths: C — two different kits sharing a sub-kit, no standalone", () => {
  const out = computeItemPaths([
    dest(D),
    group(G),
    ...mirrorWithCord,
    line(MIRROR2, []),
    line(CORD, [MIRROR2, CORD]),
    line(PLUG, [MIRROR2, CORD, PLUG]),
  ]);
  assertEquals(paths(out).slice(2), [
    [MIRROR, [D, G, MIRROR]],
    [CORD, [D, G, MIRROR, CORD]],
    [PLUG, [D, G, MIRROR, CORD, PLUG]],
    [MIRROR2, [D, G, MIRROR2]],
    [CORD, [D, G, MIRROR2, CORD]],
    [PLUG, [D, G, MIRROR2, CORD, PLUG]],
  ]);
  assertEquals(validateItemUniqueness(out), []);
});

Deno.test("computeItemPaths: D — a hand-correct document is a fixed point", () => {
  const stored = [
    { ...dest(D), path: [D] },
    { ...group(G), path: [D, G] },
    line(CORD, [D, G, CORD]),
    line(PLUG, [D, G, CORD, PLUG]),
    line(MIRROR, [D, G, MIRROR]),
    line(CORD, [D, G, MIRROR, CORD]),
    line(PLUG, [D, G, MIRROR, CORD, PLUG]),
  ];
  assertEquals(computeItemPaths(stored), stored);
  assertEquals(validateItemPaths(stored), []);
  assertEquals(validateItemUniqueness(stored), []);
});

Deno.test("computeItemPaths: a three-level kit nested twice resolves every level to its own copy", () => {
  // Rolling Set Kit ⊃ Pipes Case ⊃ LED Bar ⊃ bulb, beside a standalone Pipes Case.
  const out = computeItemPaths([
    dest(D),
    group(G),
    line(ROLLING, []),
    line(PIPES, [ROLLING, PIPES]),
    line(LED, [ROLLING, PIPES, LED]),
    line(BULB, [ROLLING, PIPES, LED, BULB]),
    line(PIPES, []),
    line(LED, [PIPES, LED]),
    line(BULB, [PIPES, LED, BULB]),
  ]);
  assertEquals(paths(out).slice(2), [
    [ROLLING, [D, G, ROLLING]],
    [PIPES, [D, G, ROLLING, PIPES]],
    [LED, [D, G, ROLLING, PIPES, LED]],
    [BULB, [D, G, ROLLING, PIPES, LED, BULB]],
    [PIPES, [D, G, PIPES]],
    [LED, [D, G, PIPES, LED]],
    [BULB, [D, G, PIPES, LED, BULB]],
  ]);
  assertEquals(validateItemUniqueness(out), []);
  assertEquals(validateItemPaths(out), []);
});

Deno.test("computeItemPaths: a chain too short to choose falls to the first copy (pinned)", () => {
  // `[CORD, PLUG]` against two NESTED cords names neither kit — genuinely
  // ambiguous, so it degrades to the first occurrence as it always has.
  const out = computeItemPaths([
    dest(D),
    group(G),
    line(MIRROR, []),
    line(CORD, [MIRROR, CORD]),
    line(MIRROR2, []),
    line(CORD, [MIRROR2, CORD]),
    line(PLUG, [CORD, PLUG]),
  ]);
  assertEquals(out.find((i) => i.uid === PLUG)?.path, [D, G, MIRROR, CORD, PLUG]);
});

Deno.test("moveLinesToLeg → computeItemPaths: a mirror's cord and a standalone cord stay apart on the new leg", () => {
  // Rental extension (api-cloudrun#1235): the moved rows keep their OLD paths and
  // `computeItemPaths` resolves them, so the old chain must carry the kit.
  const stored = computeItemPaths([
    dest(D),
    group(G),
    line(CORD, [], { quantity: 2 }),
    line(PLUG, [CORD, PLUG], { quantity: 2 }),
    line(MIRROR, [], { quantity: 1 }),
    line(CORD, [MIRROR, CORD], { quantity: 1 }),
    line(PLUG, [MIRROR, CORD, PLUG], { quantity: 1 }),
  ]);
  const moved = moveLinesToLeg(stored, {
    divider: dest(D2),
    mintUid: () => GB,
    lines: [
      { path: [D, G, CORD], quantity: 2 },
      { path: [D, G, CORD, PLUG], quantity: 2 },
      { path: [D, G, MIRROR], quantity: 1 },
      { path: [D, G, MIRROR, CORD], quantity: 1 },
      { path: [D, G, MIRROR, CORD, PLUG], quantity: 1 },
    ],
  });
  const out = computeItemPaths(moved);
  assertEquals(paths(out.filter((i) => i.path[0] === D2)), [
    [D2, [D2]],
    [GB, [D2, GB]],
    [CORD, [D2, GB, CORD]],
    [PLUG, [D2, GB, CORD, PLUG]],
    [MIRROR, [D2, GB, MIRROR]],
    [CORD, [D2, GB, MIRROR, CORD]],
    [PLUG, [D2, GB, MIRROR, CORD, PLUG]],
  ]);
  assertEquals(validateItemUniqueness(out), []);
});

// ── rebuildFulfillmentItems pass 2 ───────────────────────────────

Deno.test("rebuildFulfillmentItems: a substitution under leg 2's kit stays on leg 2", () => {
  const ALT = "PlugAdapterAlt";
  const leg = (d: string, g: string): FulfillmentItemType[] => [
    { uid: d, type: "destination", name: "Leg", description: "", path: [d] } as FulfillmentItemType,
    { uid: g, type: "group", name: "Group", description: "", path: [d, g] } as FulfillmentItemType,
    line(MIRROR, [d, g, MIRROR]),
    line(CORD, [d, g, MIRROR, CORD]),
    line(PLUG, [d, g, MIRROR, CORD, PLUG]),
  ];
  const stored = [...leg(D, G), ...leg(D2, G2)];
  const submitted = [
    ...stored.filter((i) => i.type === "rental") as FulfillmentLineItemType[],
    line(ALT, [D2, G2, MIRROR, CORD, ALT], {
      substituted_for: [{ path: [D2, G2, MIRROR, CORD, PLUG], quantity: 1 }],
    }),
  ];
  const out = rebuildFulfillmentItems(stored, submitted);
  assertEquals(out.find((i) => i.uid === ALT)?.path, [D2, G2, MIRROR, CORD, ALT]);
  // …and placed inside leg 2's block, right after its cord.
  const at = out.findIndex((i) => i.uid === ALT);
  assertEquals(out[at - 1].path, [D2, G2, MIRROR, CORD]);
});

// ── carryForwardOverrides ────────────────────────────────────────

Deno.test("carryForwardOverrides: two rows sharing a uid each keep their OWN xero_id", () => {
  const XERO_A = "00000000-0000-4000-8000-000000000a01";
  const XERO_B = "00000000-0000-4000-8000-000000000b01";
  const at = (p: string[]) => [ORDER, D, G, ...p];
  const rebuilt = [
    line(CORD, at([CORD])),
    line(PLUG, at([CORD, PLUG])),
    line(MIRROR, at([MIRROR])),
    line(CORD, at([MIRROR, CORD])),
    line(PLUG, at([MIRROR, CORD, PLUG])),
  ] as InvoiceDocItemType[];
  const existing = [
    line(CORD, at([CORD])),
    line(PLUG, at([CORD, PLUG]), { xero_id: XERO_A, coa_revenue: 4100 }),
    line(MIRROR, at([MIRROR])),
    line(CORD, at([MIRROR, CORD])),
    line(PLUG, at([MIRROR, CORD, PLUG]), { xero_id: XERO_B, coa_revenue: 4200 }),
  ] as InvoiceItem[];
  const out = carryForwardOverrides(rebuilt, existing) as Row[];
  const plugs = out.filter((i) => i.uid === PLUG).map((i) => [i.path, i.xero_id, i.coa_revenue]);
  assertEquals(plugs, [
    [at([CORD, PLUG]), XERO_A, 4100],
    [at([MIRROR, CORD, PLUG]), XERO_B, 4200],
  ]);
});

// ── adoptOrderDividerStructure ───────────────────────────────────

Deno.test("adoptOrderDividerStructure: paired and unpaired lines go back under their OWN cord", () => {
  const TAPE = "custom-gaff-tape"; // invoice-only, under each cord
  const orderItems: LineItem[] = [
    { uid: D, type: "destination", path: [D] },
    { uid: G, type: "group", path: [D, G] },
    line(CORD, [D, G, CORD]),
    line(PLUG, [D, G, CORD, PLUG], { quantity: 2 }),
    line(MIRROR, [D, G, MIRROR]),
    line(CORD, [D, G, MIRROR, CORD]),
    line(PLUG, [D, G, MIRROR, CORD, PLUG], { quantity: 9 }),
  ] as LineItem[];
  const at = (p: string[]) => [ORDER, D, G, ...p];
  // The invoice carries the mirror's subtree FIRST, so plain (uid, k) pairs the
  // order's first plug (standalone, qty 2) with the invoice's first (nested, 9).
  const scope = [
    { uid: ORDER, type: "order", path: [ORDER] },
    { uid: D, type: "destination", path: [ORDER, D] },
    { uid: G, type: "group", path: [ORDER, D, G] },
    line(MIRROR, at([MIRROR])),
    line(CORD, at([MIRROR, CORD])),
    line(PLUG, at([MIRROR, CORD, PLUG]), { quantity: 9 }),
    line(TAPE, at([MIRROR, CORD, TAPE]), { quantity: 3 }),
    line(CORD, at([CORD])),
    line(PLUG, at([CORD, PLUG]), { quantity: 2 }),
    line(TAPE, at([CORD, TAPE]), { quantity: 1 }),
  ] as InvoiceDocItemType[];
  const { items, ambiguous } = adoptOrderDividerStructure(scope, orderItems, ORDER);
  const byUid = (uid: string) => (items as Row[]).filter((i) => i.uid === uid).map((i) => [i.path, i.quantity]);
  assertEquals(byUid(PLUG), [
    [at([CORD, PLUG]), 2],
    [at([MIRROR, CORD, PLUG]), 9],
  ]);
  assertEquals(byUid(TAPE), [
    [at([CORD, TAPE]), 1],
    [at([MIRROR, CORD, TAPE]), 3],
  ]);
  assertEquals(ambiguous, []);
});

// ── seedReplacementLines (bookingSourceOf) ───────────────────────

Deno.test("seedReplacementLines: quotes the replacement value of the copy the booking names", () => {
  const PAIR = D;
  const order = {
    uid: ORDER,
    items: [
      { uid: PAIR, type: "destination", path: [PAIR] },
      { uid: G, type: "group", path: [PAIR, G] },
      { uid: CORD, type: "rental", path: [PAIR, G, CORD], price: { replacement_cents: 1000 } },
      { uid: MIRROR, type: "rental", path: [PAIR, G, MIRROR], price: { replacement_cents: 9000 } },
      { uid: CORD, type: "rental", path: [PAIR, G, MIRROR, CORD], price: { replacement_cents: 2000 } },
    ],
  };
  const hash = componentSignatureHash([PAIR, G, MIRROR, CORD]);
  const products = new Map<string, ReplacementSourceProduct>([
    ["cord", { uid: "cord", name: "25' Extension Cord", uid_linked_replacement: null }],
  ]);
  const seeds = seedReplacementLines(order, [{
    uid: "oosCord",
    uid_product: "cord",
    reason: "lost",
    status: "active",
    quantity: 1,
    query_by_sources: [`bookings:${ORDER}:${CORD}:${PAIR}:${hash}`, `orders:${ORDER}`],
    units: null,
    dates: { start: null },
  }], [], products, new Map());
  assertEquals(seeds.map((s) => s.base_cents), [2000]);
});

// ── getGroupPath.productPath ─────────────────────────────────────

Deno.test("getGroupPath: productPath tells the two cords apart where product cannot", () => {
  const items = computeItemPaths([dest(D), group(G), ...standaloneCord, ...mirrorWithCord]);
  const plugs = items.flatMap((i, idx) => (i.uid === PLUG ? [getGroupPath(items, idx)] : []));
  assertEquals(plugs.map((p) => [p.product, p.productPath]), [
    [CORD, [D, G, CORD]],
    [CORD, [D, G, MIRROR, CORD]],
  ]);
  const top = getGroupPath(items, items.findIndex((i) => i.uid === MIRROR));
  assertEquals([top.product, top.productPath], [null, null]);
});
