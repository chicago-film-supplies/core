import { assertEquals } from "@std/assert";
import { rebuildFulfillmentItems } from "../src/utils/fulfillment-items.ts";
import type { FulfillmentItemType, FulfillmentLineItemType } from "../src/schemas/fulfillment.ts";

const D = "dest-1", GA = "group-a", GB = "group-b";
const PARENT = "prod-parent", X = "prod-x", ALT = "prod-alt", Z = "prod-z";

function dest(uid: string): FulfillmentItemType {
  return { uid, type: "destination", name: "Dest", description: "", path: [uid] } as FulfillmentItemType;
}
function group(uid: string, d: string): FulfillmentItemType {
  return { uid, type: "group", name: "Group", description: "", path: [d, uid] } as FulfillmentItemType;
}
function line(uid: string, path: string[], qty = 1, extra: Partial<FulfillmentLineItemType> = {}): FulfillmentLineItemType {
  return { uid, type: "rental", name: uid, description: "", quantity: qty, path, ...extra } as FulfillmentLineItemType;
}
const lines = (items: readonly FulfillmentItemType[]) =>
  items.filter((i) => i.type !== "destination" && i.type !== "group") as FulfillmentLineItemType[];
const pathOf = (items: readonly FulfillmentItemType[], uid: string) => items.find((i) => i.uid === uid)?.path;

// The document from the dev failure: X is a component under a kit in group A,
// and a second group follows.
const STORED: FulfillmentItemType[] = [
  dest(D),
  group(GA, D),
  line(PARENT, [D, GA, PARENT]),
  line(X, [D, GA, PARENT, X]),
  group(GB, D),
  line(Z, [D, GB, Z]),
];

Deno.test("a substitution lands under its anchor's parent, not the last divider", () => {
  const submitted = [
    ...lines(STORED).map((l) => (l.uid === X ? { ...l, quantity: 0 } : l)),
    line(ALT, [D, GA, PARENT, ALT], 2, { path_substituted_for: [D, GA, PARENT, X] }),
  ];
  const out = rebuildFulfillmentItems(STORED, submitted);
  assertEquals(pathOf(out, ALT), [D, GA, PARENT, ALT]);
  // The bug this replaces produced [D, GB, ALT] — the LAST divider, parent lost.
  assertEquals(pathOf(out, Z), [D, GB, Z]);
});

Deno.test("🔴 the result does not depend on the order lines are submitted in", () => {
  // The property both previous implementations lacked, and the reason this
  // function exists: sequence comes from the STORED document.
  const base = [
    ...lines(STORED).map((l) => (l.uid === X ? { ...l, quantity: 0 } : l)),
    line(ALT, [D, GA, PARENT, ALT], 2, { path_substituted_for: [D, GA, PARENT, X] }),
  ];
  const expected = rebuildFulfillmentItems(STORED, base).map((i) => `${i.uid}:${(i.path ?? []).join("/")}`);

  const permutations = [
    [...base].reverse(),
    [base[3], base[0], base[2], base[1]],
    [base[2], base[3], base[1], base[0]],
  ];
  for (const [n, perm] of permutations.entries()) {
    const got = rebuildFulfillmentItems(STORED, perm).map((i) => `${i.uid}:${(i.path ?? []).join("/")}`);
    assertEquals(got, expected, `permutation ${n} produced a different tree`);
  }
});

Deno.test("a line the picker drops is removed; the rest keep their stored places", () => {
  const submitted = lines(STORED).filter((l) => l.uid !== X);
  const out = rebuildFulfillmentItems(STORED, submitted);
  assertEquals(out.some((i) => i.uid === X), false);
  assertEquals(pathOf(out, PARENT), [D, GA, PARENT]);
  assertEquals(pathOf(out, Z), [D, GB, Z]);
});

Deno.test("submitted values win for a line that stays — the picker owns quantity", () => {
  const submitted = lines(STORED).map((l) => (l.uid === Z ? { ...l, quantity: 99 } : l));
  const out = rebuildFulfillmentItems(STORED, submitted);
  assertEquals((out.find((i) => i.uid === Z) as FulfillmentLineItemType).quantity, 99);
});

Deno.test("structural items are never taken from the submission", () => {
  // The API strips them from the body; a submission that smuggled one in must
  // not be able to reshape the tree.
  const submitted = [
    ...lines(STORED),
    { uid: "smuggled-group", type: "group", name: "Nope", description: "", path: [D, "smuggled-group"] } as never,
  ];
  const out = rebuildFulfillmentItems(STORED, submitted as FulfillmentLineItemType[]);
  assertEquals(out.some((i) => i.uid === "smuggled-group"), false);
  assertEquals(out.filter((i) => i.type === "group").length, 2);
});

Deno.test("two substitutions against one anchor keep their submitted order", () => {
  const ALT2 = "prod-alt2";
  const submitted = [
    ...lines(STORED).map((l) => (l.uid === X ? { ...l, quantity: 0 } : l)),
    line(ALT, [D, GA, PARENT, ALT], 1, { path_substituted_for: [D, GA, PARENT, X] }),
    line(ALT2, [D, GA, PARENT, ALT2], 1, { path_substituted_for: [D, GA, PARENT, X] }),
  ];
  const out = rebuildFulfillmentItems(STORED, submitted);
  const order = out.map((i) => i.uid);
  assertEquals(order.indexOf(ALT) < order.indexOf(ALT2), true);
  assertEquals(pathOf(out, ALT), [D, GA, PARENT, ALT]);
  assertEquals(pathOf(out, ALT2), [D, GA, PARENT, ALT2]);
});

Deno.test("a substitution whose anchor was removed falls back to its deepest surviving ancestor", () => {
  const submitted = [
    ...lines(STORED).filter((l) => l.uid !== X),
    line(ALT, [D, GA, PARENT, ALT], 1, { path_substituted_for: [D, GA, PARENT, X] }),
  ];
  const out = rebuildFulfillmentItems(STORED, submitted);
  // PARENT survives, so ALT stays under it rather than defaulting to the tail.
  assertEquals(pathOf(out, ALT), [D, GA, PARENT, ALT]);
});

Deno.test("keyed on path, not uid — a repeated uid keeps both rows distinct", () => {
  // `item.uid` repeats within one document in 18% of prod orders.
  const stored: FulfillmentItemType[] = [
    dest(D),
    group(GA, D),
    line(X, [D, GA, X], 1),
    group(GB, D),
    line(X, [D, GB, X], 5),
  ];
  const submitted = lines(stored).map((l) =>
    (l.path ?? []).includes(GB) ? { ...l, quantity: 7 } : l
  );
  const out = rebuildFulfillmentItems(stored, submitted);
  const inA = out.find((i) => (i.path ?? []).join("/") === [D, GA, X].join("/")) as FulfillmentLineItemType;
  const inB = out.find((i) => (i.path ?? []).join("/") === [D, GB, X].join("/")) as FulfillmentLineItemType;
  assertEquals(inA.quantity, 1);
  assertEquals(inB.quantity, 7);
});

// ── Ported from api-cloudrun's `fulfillmentReassembly` tests ──────────────
// These pinned the two shapes that trigger `computeItemPaths`' positional
// re-parenting. They move here with the function: the API now calls this, so
// the properties belong beside the implementation rather than beside a caller.

Deno.test("two destinations keep their own items", () => {
  const DA = "dest-a", DB = "dest-b", IX = "item-x", IY = "item-y";
  const stored: FulfillmentItemType[] = [
    dest(DA),
    line(IX, [DA, IX]),
    dest(DB),
    line(IY, [DB, IY]),
  ];
  const out = rebuildFulfillmentItems(stored, lines(stored));
  // The buggy concat gave BOTH items [DB, ...].
  assertEquals(pathOf(out, IX), [DA, IX]);
  assertEquals(pathOf(out, IY), [DB, IY]);
  // Depth-first contiguity: each destination is followed by its own item.
  assertEquals(out.map((i) => i.uid), [DA, IX, DB, IY]);

  // Path-stable across a second pass — a later PUT echoes these paths back, so
  // an unstable rebuild would fail counterpart validation with a terminal 400
  // that the recovery retry can never clear.
  const second = rebuildFulfillmentItems(out, lines(out));
  assertEquals(
    second.map((i) => ({ uid: i.uid, path: i.path })),
    out.map((i) => ({ uid: i.uid, path: i.path })),
  );
});

Deno.test("a dest-root line stays before the group divider", () => {
  const DA = "dest-a", G = "group-g", IX = "item-x", IY = "item-y";
  const stored: FulfillmentItemType[] = [
    dest(DA),
    line(IX, [DA, IX]), // dest-root, before the group divider
    group(G, DA),
    line(IY, [DA, G, IY]), // inside the group
  ];
  const out = rebuildFulfillmentItems(stored, lines(stored));
  assertEquals(pathOf(out, IX), [DA, IX]);
  assertEquals(pathOf(out, IY), [DA, G, IY]);
  assertEquals(out.map((i) => i.uid), [DA, IX, G, IY]);

  const second = rebuildFulfillmentItems(out, lines(out));
  assertEquals(
    second.map((i) => ({ uid: i.uid, path: i.path })),
    out.map((i) => ({ uid: i.uid, path: i.path })),
  );
});

Deno.test("a line whose ancestry no longer resolves goes to the ROOT, not the tail", () => {
  // A carried path naming a divider that no longer exists — a fan-out between
  // projection and PUT can remove one. It must not inherit whichever divider
  // happens to sit last; that is the re-parenting defect itself. Root states
  // "unknown" rather than asserting somewhere wrong.
  const DA = "dest-a", IX = "item-x", GHOST = "ghost-dest";
  const stored: FulfillmentItemType[] = [dest(DA)];
  const submitted = [line(IX, [GHOST, IX])];
  const out = rebuildFulfillmentItems(stored, submitted);
  assertEquals(out.map((i) => i.uid), [IX, DA]);
  assertEquals(pathOf(out, IX), [IX]);
});
