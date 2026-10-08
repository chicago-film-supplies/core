/**
 * `mergeLegBack` — the order half of UNDOING a rental extension
 * (api-cloudrun#1235). Inputs are written
 * by hand or produced by `moveLinesToLeg`; `computeItemPaths` runs only on the
 * OUTPUT, as the API route runs it.
 */
import { assertEquals, assertThrows } from "@std/assert";
import {
  computeItemPaths,
  LegMoveRefusal,
  type LineItem,
  mergeLegBack,
  moveLinesToLeg,
} from "../src/utils/orders.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const G = "11111111-1111-4111-8111-111111111111";
const G_NEW = "99999999-9999-4999-8999-999999999999";

type Row = LineItem;
const dest = (uid: string): Row => ({ uid, name: uid, type: "destination", path: [uid] } as Row);
const group = (uid: string, path: string[], name = "Hair & Makeup"): Row => ({ uid, name, type: "group", path } as Row);
const line = (uid: string, path: string[], quantity: number, zero = false): Row =>
  ({ uid, name: uid, type: "rental", quantity, path, zero_priced: zero } as Row);

/** Order 1056's shape: leg A holds a group with the Mirror kit; leg C follows. */
function order1056(): Row[] {
  return [
    dest(A),
    line("Table", [A, "Table"], 2),
    group(G, [A, G]),
    line("Mirror", [A, G, "Mirror"], 6),
    line("Case", [A, G, "Mirror", "Case"], 4, true),
    line("Tall", [A, G, "Mirror", "Tall"], 4, true),
    line("Cord", [A, G, "Mirror", "Cord"], 4, true),
    dest(C),
    line("Table", [C, "Table"], 1),
  ];
}

const summary = (items: Row[]) =>
  items.map((it) => `${it.path.join("/")}${it.quantity === undefined ? "" : ` ×${it.quantity}`}`);
const extend = (lines: { path: string[]; quantity: number }[]) =>
  computeItemPaths(moveLinesToLeg(order1056(), { divider: dest(B), lines, mintUid: () => G_NEW }));

Deno.test("mergeLegBack: a partial kit extension merges back to the exact original", () => {
  const extended = extend([
    { path: [A, G, "Mirror"], quantity: 2 },
    { path: [A, G, "Mirror", "Case"], quantity: 1 },
    { path: [A, G, "Mirror", "Tall"], quantity: 1 },
  ]);
  assertEquals(summary(computeItemPaths(mergeLegBack(extended, { from: B, into: A }))), summary(order1056()));
});

Deno.test("mergeLegBack: a whole kit moved off A is re-inserted under A's group", () => {
  const extended = extend([
    { path: [A, G, "Mirror"], quantity: 6 },
    { path: [A, G, "Mirror", "Case"], quantity: 4 },
    { path: [A, G, "Mirror", "Tall"], quantity: 4 },
    { path: [A, G, "Mirror", "Cord"], quantity: 4 },
  ]);
  // The extension left A's group empty.
  assertEquals(summary(extended).slice(0, 3), [`${A}`, `${A}/Table ×2`, `${A}/${G}`]);
  assertEquals(summary(computeItemPaths(mergeLegBack(extended, { from: B, into: A }))), summary(order1056()));
});

Deno.test("mergeLegBack: a kit kept at 0 on A (a component stayed) comes back up", () => {
  const extended = extend([
    { path: [A, G, "Mirror"], quantity: 6 },
    { path: [A, G, "Mirror", "Case"], quantity: 4 },
    { path: [A, G, "Mirror", "Tall"], quantity: 4 },
  ]);
  assertEquals(summary(extended).includes(`${A}/${G}/Mirror ×0`), true);
  // Same rows and quantities; Case and Tall come back AFTER Cord, the zero-priced
  // sibling that stayed, because a priced-sibling position is not recoverable.
  assertEquals(summary(computeItemPaths(mergeLegBack(extended, { from: B, into: A }))), [
    `${A}`,
    `${A}/Table ×2`,
    `${A}/${G}`,
    `${A}/${G}/Mirror ×6`,
    `${A}/${G}/Mirror/Cord ×4`,
    `${A}/${G}/Mirror/Case ×4`,
    `${A}/${G}/Mirror/Tall ×4`,
    `${C}`,
    `${C}/Table ×1`,
  ]);
});

Deno.test("mergeLegBack: a root row moved whole returns before A's first group", () => {
  const extended = extend([{ path: [A, "Table"], quantity: 2 }]);
  assertEquals(summary(extended).includes(`${A}/Table ×2`), false);
  assertEquals(summary(computeItemPaths(mergeLegBack(extended, { from: B, into: A }))), summary(order1056()));
});

Deno.test("mergeLegBack: a re-inserted zero-priced component goes after its zero-priced siblings, before priced ones", () => {
  const items: Row[] = [
    dest(A),
    line("Kit", [A, "Kit"], 2),
    line("Z1", [A, "Kit", "Z1"], 2, true),
    line("P1", [A, "Kit", "P1"], 2),
    dest(B),
    line("Kit", [B, "Kit"], 1),
    line("Z2", [B, "Kit", "Z2"], 1, true),
  ];
  assertEquals(summary(computeItemPaths(mergeLegBack(items, { from: B, into: A }))), [
    `${A}`,
    `${A}/Kit ×3`,
    `${A}/Kit/Z1 ×2`,
    `${A}/Kit/Z2 ×1`,
    `${A}/Kit/P1 ×2`,
  ]);
});

Deno.test("mergeLegBack: B's group maps onto the same-named A group that holds its rows", () => {
  const H = "22222222-2222-4222-8222-222222222222";
  const items: Row[] = [
    dest(A),
    group(G, [A, G], "Kit Room"),
    line("X", [A, G, "X"], 1),
    group(H, [A, H], "Kit Room"),
    line("Y", [A, H, "Y"], 1),
    dest(B),
    group(G_NEW, [B, G_NEW], "Kit Room"),
    line("Y", [B, G_NEW, "Y"], 2),
  ];
  assertEquals(summary(computeItemPaths(mergeLegBack(items, { from: B, into: A }))), [
    `${A}`,
    `${A}/${G}`,
    `${A}/${G}/X ×1`,
    `${A}/${H}`,
    `${A}/${H}/Y ×3`,
  ]);
});

Deno.test("mergeLegBack: a group A no longer has is recreated at the end of A's block", () => {
  const items: Row[] = [
    dest(A),
    line("Table", [A, "Table"], 1),
    dest(B),
    group(G_NEW, [B, G_NEW], "Hair & Makeup"),
    line("Mirror", [B, G_NEW, "Mirror"], 2),
    dest(C),
  ];
  assertEquals(summary(computeItemPaths(mergeLegBack(items, { from: B, into: A }))), [
    `${A}`,
    `${A}/Table ×1`,
    `${A}/${G_NEW}`,
    `${A}/${G_NEW}/Mirror ×2`,
    `${C}`,
  ]);
});

Deno.test("mergeLegBack: refusals", () => {
  const extended = extend([{ path: [A, "Table"], quantity: 1 }]);
  assertThrows(() => mergeLegBack(extended, { from: A, into: A }), LegMoveRefusal);
  assertThrows(() => mergeLegBack(extended, { from: G_NEW, into: A }), LegMoveRefusal, "not on the order");
  const withSale = [...extended, { ...line("Gaff", [B, "Gaff"], 1), type: "sale" } as Row];
  // A sale on B was not put there by an extension. (Appended after C here, so
  // move it into B's block first.)
  const bIdx = withSale.findIndex((it) => it.uid === B);
  withSale.splice(bIdx + 1, 0, withSale.pop()!);
  assertThrows(() => mergeLegBack(withSale, { from: B, into: A }), LegMoveRefusal, "not put there by an extension");
});
