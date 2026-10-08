/**
 * `moveLinesToLeg` — the order half of a rental extension
 * (api-cloudrun#1235). Every path is
 * written out by hand; `computeItemPaths` runs only on the OUTPUT, as the API
 * route will run it.
 */
import { assertEquals, assertThrows } from "@std/assert";
import { computeItemPaths, LegMoveRefusal, type LineItem, moveLinesToLeg } from "../src/utils/orders.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const G = "11111111-1111-4111-8111-111111111111";
const G_NEW = "99999999-9999-4999-8999-999999999999";

type Row = LineItem;
const dest = (uid: string): Row => ({ uid, name: uid, type: "destination", path: [uid] } as Row);
const group = (uid: string, path: string[]): Row => ({ uid, name: "Hair & Makeup", type: "group", path } as Row);
const line = (uid: string, path: string[], quantity: number, type = "rental"): Row =>
  ({ uid, name: uid, type, quantity, path } as Row);

/** Order 1056's shape: leg A holds a group with the Mirror kit; leg C follows. */
function order1056(): Row[] {
  return [
    dest(A),
    line("Table", [A, "Table"], 2),
    group(G, [A, G]),
    line("Mirror", [A, G, "Mirror"], 6),
    line("Case", [A, G, "Mirror", "Case"], 4),
    line("Tall", [A, G, "Mirror", "Tall"], 4),
    line("Cord", [A, G, "Mirror", "Cord"], 4),
    dest(C),
    line("Table", [C, "Table"], 1),
  ];
}

const summary = (items: Row[]) => items.map((it) => `${it.path.join("/")}${it.quantity === undefined ? "" : ` ×${it.quantity}`}`);

Deno.test("moveLinesToLeg: a partial kit extension lands under B in a NEW group, after A's block", () => {
  const out = moveLinesToLeg(order1056(), {
    divider: dest(B),
    lines: [
      { path: [A, G, "Mirror"], quantity: 2 },
      { path: [A, G, "Mirror", "Case"], quantity: 1 },
      { path: [A, G, "Mirror", "Tall"], quantity: 1 },
    ],
    mintUid: () => G_NEW,
  });
  assertEquals(summary(computeItemPaths(out)), [
    `${A}`,
    `${A}/Table ×2`,
    `${A}/${G}`,
    `${A}/${G}/Mirror ×4`,
    `${A}/${G}/Mirror/Case ×3`,
    `${A}/${G}/Mirror/Tall ×3`,
    `${A}/${G}/Mirror/Cord ×4`,
    `${B}`,
    `${B}/${G_NEW}`,
    `${B}/${G_NEW}/Mirror ×2`,
    `${B}/${G_NEW}/Mirror/Case ×1`,
    `${B}/${G_NEW}/Mirror/Tall ×1`,
    `${C}`,
    `${C}/Table ×1`,
  ]);
  // The cloned group keeps its name and takes a fresh uid.
  assertEquals(out.find((it) => it.uid === G_NEW)?.name, "Hair & Makeup");
});

Deno.test("moveLinesToLeg: a row moved whole leaves A; a root row lands directly under B", () => {
  const out = moveLinesToLeg(order1056(), {
    divider: dest(B),
    lines: [{ path: [A, "Table"], quantity: 2 }],
    mintUid: () => G_NEW,
  });
  const paths = summary(computeItemPaths(out));
  assertEquals(paths.includes(`${A}/Table ×0`), false);
  assertEquals(paths.slice(6, 8), [`${B}`, `${B}/Table ×2`]);
  assertEquals(out.some((it) => it.uid === G_NEW), false, "no group needed, none minted");
});

Deno.test("moveLinesToLeg: a kit moved whole stays on A at 0 while one of its components is still due back there", () => {
  const out = moveLinesToLeg(order1056(), {
    divider: dest(B),
    lines: [
      { path: [A, G, "Mirror"], quantity: 6 },
      { path: [A, G, "Mirror", "Case"], quantity: 4 },
      { path: [A, G, "Mirror", "Tall"], quantity: 4 },
    ],
    mintUid: () => G_NEW,
  });
  const paths = summary(computeItemPaths(out));
  assertEquals(paths.slice(3, 5), [`${A}/${G}/Mirror ×0`, `${A}/${G}/Mirror/Cord ×4`]);
  assertEquals(paths.includes(`${A}/${G}/Mirror/Case ×0`), false);
});

Deno.test("moveLinesToLeg: the whole kit moved leaves A's group empty, and the group stays", () => {
  const out = moveLinesToLeg(order1056(), {
    divider: dest(B),
    lines: [
      { path: [A, G, "Mirror"], quantity: 6 },
      { path: [A, G, "Mirror", "Case"], quantity: 4 },
      { path: [A, G, "Mirror", "Tall"], quantity: 4 },
      { path: [A, G, "Mirror", "Cord"], quantity: 4 },
    ],
    mintUid: () => G_NEW,
  });
  assertEquals(summary(computeItemPaths(out)).slice(0, 4), [`${A}`, `${A}/Table ×2`, `${A}/${G}`, `${B}`]);
});

Deno.test("moveLinesToLeg: refusals", () => {
  const items = order1056();
  const move = (lines: { path: string[]; quantity: number }[], divider = dest(B)) =>
    moveLinesToLeg(items, { divider, lines, mintUid: () => G_NEW });
  assertThrows(() => move([{ path: [A, G, "Mirror", "Case"], quantity: 1 }]), LegMoveRefusal, "without its kit Mirror");
  assertThrows(() => move([{ path: [A, G, "Mirror"], quantity: 7 }]), LegMoveRefusal, "the row holds 6");
  assertThrows(() => move([{ path: [A, G, "Mirror"], quantity: 0 }]), LegMoveRefusal, "positive whole");
  assertThrows(() => move([{ path: [A, G, "Mirror"], quantity: 1.5 }]), LegMoveRefusal, "positive whole");
  assertThrows(() => move([{ path: [A, "Nope"], quantity: 1 }]), LegMoveRefusal, "no row");
  assertThrows(() => move([{ path: [A, G], quantity: 1 }]), LegMoveRefusal, "divider is not a line");
  assertThrows(() => move([{ path: [A, "Table"], quantity: 1 }, { path: [C, "Table"], quantity: 1 }]), LegMoveRefusal, "same leg");
  assertThrows(() => move([{ path: [A, "Table"], quantity: 1 }, { path: [A, "Table"], quantity: 1 }]), LegMoveRefusal, "named twice");
  assertThrows(() => move([{ path: [A, "Table"], quantity: 1 }], dest(C)), LegMoveRefusal, "already on the order");
  assertThrows(() => move([{ path: [B, "Table"], quantity: 1 }]), LegMoveRefusal, "not on the order");
  assertThrows(() => move([]), LegMoveRefusal, "nothing to move");
  const withSale = [...items.slice(0, 2), line("Gel", [A, "Gel"], 3, "sale"), ...items.slice(2)];
  assertThrows(
    () => moveLinesToLeg(withSale, { divider: dest(B), lines: [{ path: [A, "Gel"], quantity: 1 }] }),
    LegMoveRefusal,
    "a sale line",
  );
});

Deno.test("moveLinesToLeg does not mutate its input", () => {
  const items = order1056();
  const snapshot = structuredClone(items);
  moveLinesToLeg(items, { divider: dest(B), lines: [{ path: [A, G, "Mirror"], quantity: 2 }], mintUid: () => G_NEW });
  assertEquals(items, snapshot);
});
