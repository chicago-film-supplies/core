import { assertEquals, assertThrows } from "@std/assert";
import {
  buildComponentEntries,
  productCountsStock,
  productHasLedger,
  productLineage,
  productSurvivor,
  removeComponentEntries,
  type SupersessionNode,
  validateSupersession,
} from "../src/utils/products.ts";
import { ComponentSchema, getInitialValues } from "../src/schemas/mod.ts";
import type { ProductComponent } from "../src/schemas/mod.ts";

// ── helpers ─────────────────────────────────────────────────────────

const componentBase = getInitialValues(ComponentSchema) as Record<string, unknown>;

function comp(uid: string, path: string[]): ProductComponent {
  return { ...componentBase, uid, path } as ProductComponent;
}

// ── removeComponentEntries ──────────────────────────────────────────

Deno.test("removeComponentEntries removes target and descendants", () => {
  const components = [
    comp("B", ["A", "B"]),
    comp("D", ["A", "B", "D"]),
    comp("C", ["A", "C"]),
    comp("D", ["A", "C", "D"]),
  ];

  const result = removeComponentEntries(components, ["A", "B"]);

  assertEquals(result, [
    comp("C", ["A", "C"]),
    comp("D", ["A", "C", "D"]),
  ]);
});

Deno.test("removeComponentEntries preserves other subtree with shared product uid", () => {
  const components = [
    comp("B", ["A", "B"]),
    comp("D", ["A", "B", "D"]),
    comp("C", ["A", "C"]),
    comp("D", ["A", "C", "D"]),
  ];

  // Remove B — D under C must survive
  const result = removeComponentEntries(components, ["A", "B"]);
  assertEquals(result.length, 2);
  assertEquals(result[0].uid, "C");
  assertEquals(result[1].uid, "D");
  assertEquals(result[1].path, ["A", "C", "D"]);
});

Deno.test("removeComponentEntries removes deeply nested descendants", () => {
  const components = [
    comp("B", ["A", "B"]),
    comp("D", ["A", "B", "D"]),
    comp("E", ["A", "B", "D", "E"]),
    comp("C", ["A", "C"]),
  ];

  const result = removeComponentEntries(components, ["A", "B"]);

  assertEquals(result, [
    comp("C", ["A", "C"]),
  ]);
});

Deno.test("removeComponentEntries removes only the exact subtree when same product appears in multiple positions", () => {
  // B appears as direct child of A and also nested under C
  const components = [
    comp("B", ["A", "B"]),
    comp("D", ["A", "B", "D"]),
    comp("C", ["A", "C"]),
    comp("B", ["A", "C", "B"]),
    comp("D", ["A", "C", "B", "D"]),
  ];

  // Remove the direct B only
  const result = removeComponentEntries(components, ["A", "B"]);

  assertEquals(result, [
    comp("C", ["A", "C"]),
    comp("B", ["A", "C", "B"]),
    comp("D", ["A", "C", "B", "D"]),
  ]);
});

Deno.test("removeComponentEntries returns all entries when path matches nothing", () => {
  const components = [
    comp("B", ["A", "B"]),
    comp("C", ["A", "C"]),
  ];

  const result = removeComponentEntries(components, ["A", "X"]);
  assertEquals(result, components);
});

Deno.test("removeComponentEntries returns empty array from empty input", () => {
  assertEquals(removeComponentEntries([], ["A", "B"]), []);
});

// ── buildComponentEntries ───────────────────────────────────────────

Deno.test("buildComponentEntries prepends parentUid to paths", () => {
  const source = [
    comp("D", ["B", "D"]),
    comp("E", ["B", "D", "E"]),
  ];

  const result = buildComponentEntries("A", source, 1);

  assertEquals(result, [
    comp("D", ["A", "B", "D"]),
    comp("E", ["A", "B", "D", "E"]),
  ]);
});

Deno.test("buildComponentEntries respects maxDepth", () => {
  const source = [
    comp("D", ["B", "D"]),
    comp("E", ["B", "D", "E"]),
  ];

  // baseDepth 1, D has path length 2 → depth 3, E has path length 3 → depth 4
  const result = buildComponentEntries("A", source, 1, 3);

  assertEquals(result, [
    comp("D", ["A", "B", "D"]),
  ]);
});

Deno.test("productHasLedger / productCountsStock: rental and sale only, and none holds no count", () => {
  assertEquals(productHasLedger("rental"), true);
  assertEquals(productHasLedger("sale"), true);
  assertEquals(productHasLedger("service"), false);
  assertEquals(productHasLedger("replacement"), false);
  assertEquals(productCountsStock("rental", "bulk"), true);
  assertEquals(productCountsStock("sale", "serialized"), true);
  assertEquals(productCountsStock("rental", "none"), false);
  assertEquals(productCountsStock("service", "bulk"), false);
});

// ── supersession (serialized-subrent § 12) ───────────────────────────

function catalog(...nodes: SupersessionNode[]) {
  const byUid = new Map(nodes.map((n) => [n.uid, n]));
  return (uid: string) => byUid.get(uid);
}
const TWIN: SupersessionNode = { uid: "VCtwin", type: "rental", uid_superseded_by: "Owned" };
const OWNED: SupersessionNode = { uid: "Owned", type: "rental" };

Deno.test("productLineage: the chain, itself first; the survivor is the last", () => {
  const lookup = catalog(
    { uid: "A", type: "rental", uid_superseded_by: "B" },
    { uid: "B", type: "rental", uid_superseded_by: "C" },
    { uid: "C", type: "rental" },
  );
  assertEquals(productLineage("A", lookup), ["A", "B", "C"]);
  assertEquals(productSurvivor("A", lookup), "C");
  assertEquals(productSurvivor("C", lookup), "C");
  // An unreadable successor stops the chain rather than failing the report.
  assertEquals(productLineage("X", catalog({ uid: "X", type: "rental", uid_superseded_by: "gone" })), ["X", "gone"]);
});

Deno.test("productLineage: a cycle throws rather than folding revenue under an arbitrary member", () => {
  const lookup = catalog(
    { uid: "A", type: "rental", uid_superseded_by: "B" },
    { uid: "B", type: "rental", uid_superseded_by: "A" },
  );
  assertThrows(() => productLineage("A", lookup), Error, "cycles: A → B → A");
});

Deno.test("validateSupersession: exists, same type, and the chain does not return to the product", () => {
  assertEquals(validateSupersession(OWNED, catalog(OWNED)), [], "a live product is trivially consistent");
  assertEquals(validateSupersession(TWIN, catalog(TWIN, OWNED)), []);
  assertEquals(validateSupersession(TWIN, catalog(TWIN)), ["product VCtwin is superseded by Owned, which does not exist"]);
  assertEquals(
    validateSupersession(TWIN, catalog(TWIN, { ...OWNED, type: "sale" })),
    ["product VCtwin (rental) cannot be superseded by Owned (sale): the types differ"],
  );
  // The writer validates the document it is ABOUT to write, so a stored
  // back-pointer from the successor makes a cycle through the new link.
  const cyc = validateSupersession(TWIN, catalog({ ...TWIN, uid_superseded_by: undefined }, { ...OWNED, uid_superseded_by: "VCtwin" }));
  assertEquals(cyc, ["product supersession cycles: VCtwin → Owned → VCtwin"]);
  assertEquals(validateSupersession({ ...OWNED, uid_superseded_by: "Owned" }, catalog(OWNED)), [
    "product Owned cannot be superseded by itself",
  ]);
});
