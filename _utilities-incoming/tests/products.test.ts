import { assertEquals } from "@std/assert";
import { buildComponentEntries, removeComponentEntries } from "../src/products.ts";
import { ComponentSchema, getInitialValues } from "@cfs/schemas";
import type { ProductComponent } from "@cfs/schemas";

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
