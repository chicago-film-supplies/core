import { assertEquals, assertThrows } from "@std/assert";
import {
  bumpSemver,
  deriveBump,
  RenderParamError,
  type RenderParamDecl,
  resolveRenderParams,
  slugify,
} from "../src/templates.ts";

// ── slugify ─────────────────────────────────────────────────────────

Deno.test("slugify lowercases and hyphenates", () => {
  assertEquals(slugify("Packing List (v2)"), "packing-list-v2");
  assertEquals(slugify("Quote"), "quote");
  assertEquals(slugify("  Leading/Trailing  "), "leading-trailing");
});

Deno.test("slugify collapses two distinct names to the same slug (collision possible)", () => {
  assertEquals(slugify("Quote!"), slugify("quote"));
  assertEquals(slugify("Packing  List"), slugify("packing-list"));
});

// ── deriveBump / bumpSemver ─────────────────────────────────────────

Deno.test("deriveBump: breaking wins regardless of type", () => {
  assertEquals(deriveBump("feat", true), "major");
  assertEquals(deriveBump("fix", true), "major");
  assertEquals(deriveBump("chore", true), "major");
});

Deno.test("deriveBump: feat → minor, everything else → patch", () => {
  assertEquals(deriveBump("feat", false), "minor");
  assertEquals(deriveBump("fix", false), "patch");
  assertEquals(deriveBump("refactor", false), "patch");
  assertEquals(deriveBump("FEAT", false), "minor");
});

Deno.test("bumpSemver applies the level, treating missing current as 0.0.0", () => {
  assertEquals(bumpSemver(null, "major"), "1.0.0");
  assertEquals(bumpSemver(undefined, "minor"), "0.1.0");
  assertEquals(bumpSemver(undefined, "patch"), "0.0.1");
  assertEquals(bumpSemver("1.4.2", "major"), "2.0.0");
  assertEquals(bumpSemver("1.4.2", "minor"), "1.5.0");
  assertEquals(bumpSemver("1.4.2", "patch"), "1.4.3");
  assertEquals(bumpSemver("garbage", "patch"), "0.0.1");
});

// ── resolveRenderParams ─────────────────────────────────────────────

const decls: RenderParamDecl[] = [
  { key: "show_prices", type: "boolean", default: true },
  { key: "show_notes", type: "boolean" },
  { key: "include_terms", type: "boolean", required: true },
];

Deno.test("resolveRenderParams fills defaults and false-for-optional", () => {
  const resolved = resolveRenderParams(decls, { include_terms: true });
  assertEquals(resolved, { show_prices: true, show_notes: false, include_terms: true });
});

Deno.test("resolveRenderParams respects provided overrides", () => {
  const resolved = resolveRenderParams(decls, {
    show_prices: false,
    show_notes: true,
    include_terms: false,
  });
  assertEquals(resolved, { show_prices: false, show_notes: true, include_terms: false });
});

Deno.test("resolveRenderParams strict: unknown param throws RenderParamError (→422)", () => {
  const err = assertThrows(
    () => resolveRenderParams(decls, { include_terms: true, bogus: true }),
    RenderParamError,
    "unknown render param",
  );
  assertEquals((err as RenderParamError).status, 422);
});

Deno.test("resolveRenderParams: wrong type throws", () => {
  assertThrows(
    () => resolveRenderParams(decls, { include_terms: true, show_prices: "yes" as unknown as boolean }),
    RenderParamError,
    "must be a boolean",
  );
});

Deno.test("resolveRenderParams: missing required (no default) throws", () => {
  assertThrows(
    () => resolveRenderParams(decls, {}),
    RenderParamError,
    "missing required render param",
  );
});

Deno.test("resolveRenderParams: undefined provided treated as empty", () => {
  assertThrows(() => resolveRenderParams(decls, undefined), RenderParamError);
  assertEquals(resolveRenderParams([], undefined), {});
});
