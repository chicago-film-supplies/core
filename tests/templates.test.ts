import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import {
  aggregateGoldenVerdict,
  bumpSemver,
  deriveBump,
  fixtureDir,
  fixturePath,
  goldenPath,
  hashTemplateContent,
  NO_FIXTURES_SENTINEL,
  parseFixturePath,
  RenderParamError,
  type RenderParamDecl,
  resolveRenderParams,
  rewriteDocFieldRefs,
  scanDocFieldRefs,
  slugify,
} from "../src/utils/templates.ts";

// ── Path helpers (fixtures + goldens) ───────────────────────────────

Deno.test("fixtureDir returns the family's fixtures dir with a trailing slash", () => {
  assertEquals(fixtureDir("quote"), "fixtures/quote/");
});

Deno.test("fixturePath joins git_path and slug", () => {
  assertEquals(fixturePath("quote", "order-841"), "fixtures/quote/order-841.json");
});

Deno.test("goldenPath includes branch, git_path, and slug", () => {
  assertEquals(
    goldenPath("main", "quote", "order-841"),
    "goldens/main/quote/order-841.png",
  );
  assertEquals(
    goldenPath("sandbox", "packing-list", "tax-exempt"),
    "goldens/sandbox/packing-list/tax-exempt.png",
  );
});

Deno.test("parseFixturePath recovers git_path + slug from a valid path", () => {
  assertEquals(
    parseFixturePath("fixtures/quote/order-841.json"),
    { gitPath: "quote", slug: "order-841" },
  );
});

Deno.test("parseFixturePath rejects flat fixture paths (legacy layout)", () => {
  assertEquals(parseFixturePath("fixtures/order-841.json"), null);
});

Deno.test("parseFixturePath rejects nested-slug paths (no `/` allowed in slug)", () => {
  assertEquals(parseFixturePath("fixtures/quote/sub/order.json"), null);
});

Deno.test("parseFixturePath rejects non-fixture paths", () => {
  assertEquals(parseFixturePath("templates/quote.eta"), null);
  assertEquals(parseFixturePath("goldens/main/quote/order-841.png"), null);
  assertEquals(parseFixturePath("fixtures/quote/order-841.txt"), null);
});

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

// ── scanDocFieldRefs / rewriteDocFieldRefs (fork field-mapping) ──────

Deno.test("scanDocFieldRefs: distinct dotted paths, normalized + sorted", () => {
  const content = {
    "templates/quote.eta": `<h1><%= it.doc.number %></h1><p><%= it.doc.organization.name %></p><%= it.doc.organization.name %>`,
    "styles/quote.css": `h1{}`,
  };
  assertEquals(scanDocFieldRefs(content), ["number", "organization.name"]);
});

Deno.test("scanDocFieldRefs: normalizes array indices to []", () => {
  const content = { "t.eta": `<%= it.doc.items[0].name %> <%= it.doc.items[2].price %>` };
  assertEquals(scanDocFieldRefs(content), ["items[].name", "items[].price"]);
});

Deno.test("scanDocFieldRefs: known limitation — loop-aliased refs are NOT caught", () => {
  // it.doc.items IS caught, but the aliased `item.name` inside the loop is not.
  const content = { "t.eta": `<% it.doc.items.forEach((item) => { %><%= item.name %><% }) %>` };
  assertEquals(scanDocFieldRefs(content), ["items"]);
});

Deno.test("rewriteDocFieldRefs: swaps mapped paths, leaves null + identity untouched", () => {
  const content = {
    "t.eta": `<%= it.doc.organization.name %> / <%= it.doc.number %> / <%= it.doc.total %>`,
  };
  const out = rewriteDocFieldRefs(content, {
    "organization.name": "contact.name", // remap
    "number": null, // leave for manual fixup
    "total": "total", // identity → untouched
  });
  assertEquals(
    out["t.eta"],
    `<%= it.doc.contact.name %> / <%= it.doc.number %> / <%= it.doc.total %>`,
  );
});

Deno.test("rewriteDocFieldRefs: preserves array indices across a remap", () => {
  const content = { "t.eta": `<%= it.doc.items[0].name %> <%= it.doc.items[3].name %>` };
  const out = rewriteDocFieldRefs(content, { "items[].name": "lines[].name" });
  assertEquals(out["t.eta"], `<%= it.doc.lines[0].name %> <%= it.doc.lines[3].name %>`);
});

Deno.test("rewriteDocFieldRefs: nested path rewritten before its prefix (longest-first)", () => {
  const content = { "t.eta": `<%= it.doc.organization.name %> <%= it.doc.organization %>` };
  const out = rewriteDocFieldRefs(content, {
    "organization.name": "org.name",
    "organization": "org",
  });
  assertEquals(out["t.eta"], `<%= it.doc.org.name %> <%= it.doc.org %>`);
});

// ── hashTemplateContent ─────────────────────────────────────────────

Deno.test("hashTemplateContent is stable and order-independent", () => {
  const a = { "layouts/base.eta": "<p>hi</p>", "styles/base.css": "p{}" };
  const b = { "styles/base.css": "p{}", "layouts/base.eta": "<p>hi</p>" };
  assertEquals(hashTemplateContent(a), hashTemplateContent(b));
  assertEquals(hashTemplateContent(a), hashTemplateContent({ ...a }));
});

Deno.test("hashTemplateContent changes when any content changes", () => {
  const base = { "a.eta": "x", "b.css": "y" };
  assertNotEquals(hashTemplateContent(base), hashTemplateContent({ ...base, "b.css": "z" }));
});

Deno.test("hashTemplateContent distinguishes key/value boundary shifts (injective prefix)", () => {
  assertNotEquals(
    hashTemplateContent({ "ab": "c" }),
    hashTemplateContent({ "a": "bc" }),
  );
  assertNotEquals(
    hashTemplateContent({ "a": "b", "c": "d" }),
    hashTemplateContent({ "a": "bcd" }),
  );
});

Deno.test("hashTemplateContent distinguishes add/remove of an empty file", () => {
  assertNotEquals(
    hashTemplateContent({ "a.eta": "x" }),
    hashTemplateContent({ "a.eta": "x", "b.css": "" }),
  );
});

Deno.test("hashTemplateContent returns a 16-char hex digest", () => {
  const h = hashTemplateContent({ "a.eta": "hello" });
  assertEquals(/^[0-9a-f]{16}$/.test(h), true);
});

// ── Golden-diff aggregation ─────────────────────────────────────────
//
// Moved here from `manager/src/components/templates/__tests__/goldenReview.test.ts` with the function
// (core#68). Manager was the only side with coverage: api-cloudrun's
// `aggregateVerdict` had **none**, and could not easily get any — its file
// imports the db module, and `api-cloudrun/tests/unit/dbReachCoverage.test.ts` forbids any
// unit test from transitively reaching that. So the duplication was not merely
// untidy, it was load-bearing for a test gap: one of the two copies was
// structurally untestable where it lived.
//
// These cases run against the shared implementation now, so a change to the
// precedence fails here rather than silently diverging in one repo.

Deno.test("aggregateGoldenVerdict returns null when CI has not run", () => {
  // Distinct from `match`: an empty array means "no verdict", not "clean".
  // A caller that collapses this with `?? \"match\"` reports a check that never
  // ran as one that ran and found nothing.
  assertEquals(aggregateGoldenVerdict([]), null);
});

Deno.test("aggregateGoldenVerdict reports no-fixtures only for a LONE sentinel", () => {
  assertEquals(aggregateGoldenVerdict(["no-fixtures"]), "no-fixtures");
});

Deno.test("aggregateGoldenVerdict falls through to match when no-fixtures rides alongside real results", () => {
  // The sentinel says nothing once real fixtures were checked, so the array's
  // meaning is carried by the other rows.
  assertEquals(aggregateGoldenVerdict(["no-fixtures", "match"]), "match");
});

Deno.test("aggregateGoldenVerdict prefers diff over no-golden", () => {
  assertEquals(aggregateGoldenVerdict(["no-golden", "diff", "match"]), "diff");
});

Deno.test("aggregateGoldenVerdict reports no-golden when nothing changed but a baseline is missing", () => {
  assertEquals(aggregateGoldenVerdict(["match", "no-golden"]), "no-golden");
});

Deno.test("aggregateGoldenVerdict handles renderer-unavailable even though Firestore cannot hold it", () => {
  // The caller skips persistence entirely on this aggregate, so it can only
  // reach a reader via a future API change. Handled as defence; no operator copy
  // leans on it. ⚠️ It is `some`, not `every`: one fixture failing to render
  // means the run proves nothing, so a partial result must not be recorded.
  assertEquals(aggregateGoldenVerdict(["diff", "renderer-unavailable"]), "renderer-unavailable");
});

Deno.test("aggregateGoldenVerdict reports match when every fixture matched", () => {
  assertEquals(aggregateGoldenVerdict(["match", "match"]), "match");
});

Deno.test("NO_FIXTURES_SENTINEL is the value both repos agree on", () => {
  // ⚠️ Pinned by VALUE, not merely referenced. This is a wire contract: the API
  // writes it into `golden_results` and the manager recognises it on read, and
  // it was a bare `"_"` literal on the API side. A test that only asserted the
  // two sides import the same const would pass while the const changed
  // underneath persisted documents.
  assertEquals(NO_FIXTURES_SENTINEL, "_");
});

Deno.test("the no-fixtures sentinel is a CONVENTION, not an unrepresentable slug", () => {
  // ⚠️ Recorded because the obvious reassuring claim — "a real slug can never
  // be `_`" — is FALSE, and was written into this file's docstring before being
  // checked. `parseFixturePath` parses `fixtures/<gp>/_.json` into the slug
  // `"_"` quite happily, so a fixture with that filename is indistinguishable
  // from the sentinel: the manager would drop it from every slug map and report
  // the family as having no fixtures.
  //
  // No fixture in the templates repo is named `_` and this asserts the shape of
  // the hazard rather than guarding it — the guard, if one is ever wanted,
  // belongs where fixtures are created.
  assertEquals(
    parseFixturePath(`fixtures/quotes/${NO_FIXTURES_SENTINEL}.json`),
    { gitPath: "quotes", slug: "_" },
  );
});
