/**
 * The pure citation rules (`src/utils/citations.ts`).
 *
 * ⚠️ **Every rule here is tested in BOTH directions, and that is the whole
 * design of this file.** A static walker's extraction fails two ways —
 * under-extraction invents findings, over-extraction falsely satisfies — and
 * only a planted case distinguishes them. So for each rule there is a case that
 * MUST classify and a near-miss that MUST NOT. **A rule with no planted inverse
 * is the failure this file exists to prevent.**
 *
 * It is not hypothetical. Every negative case below is a real false positive
 * the audit produced against live instruction-grade docs on 2026-08-23, in the
 * hours between widening its scope and gating it:
 *
 * - version.sha reported as a citation to version.sh
 * - res.json() — a method call — reported as res.json
 * - vmauth.yml.tpl / docker-compose.yml.tpl / setup.sh.tpl reported as the
 *   rendered VM filenames, so the three files the obs GitOps section is ABOUT
 *   all read as broken
 * - every `@cfs/core/…` subpath — the densest correct citation form in
 *   api-cloudrun — reported broken, 21 of them
 *
 * A guard that cries wolf gets switched off, so the broken count is the only
 * number in these audits that must stay at zero, and these are what keep it
 * meaning something.
 *
 * ⚠️ **This file is itself inside the scanned roots**, so a planted path is a
 * real citation to the audit that reads it. Wherever a case needs a path that
 * does NOT resolve, it is either carried by its own prose (the deletion arms
 * say the path is gone, which is exactly what they assert) or interpolated so
 * the regex cannot match it, or resolves against a real file in this package.
 * ⚠️ Keep it that way: a planted path that is BOTH dead and unexcused is a
 * real broken citation to whatever reads this file, and the gate is right to
 * say so.
 */
import { assert, assertEquals } from "@std/assert";
import {
  CITATION,
  type CitationFacts,
  classifyCitation,
  describesDeletion,
  isHistoryDoc,
  preferOwnRepo,
  resolveSpecifier,
} from "../src/utils/citations.ts";

/** Every path the citation regex extracts from a blob of prose. */
function cited(text: string): string[] {
  return [...text.matchAll(CITATION)].map((m) => m[1]);
}

// ── The regex: what counts as a citation at all ──────────────────────

Deno.test("a backticked repo path is a citation, with or without a line", () => {
  assertEquals(cited("see `src/utils/citations.ts` today"), ["src/utils/citations.ts"]);
  assertEquals(cited("see `src/utils/citations.ts:42`"), ["src/utils/citations.ts"]);
  assertEquals(cited("see `src/utils/citations.ts:42-49`"), ["src/utils/citations.ts"]);
  // ⚠️ The `:N` being OPTIONAL is load-bearing. Requiring it was a silent false
  // zero: 66 path-only citations went unmatched, uncounted, and
  // unreported-as-skipped, one of them already dead.
  assertEquals(cited("`.claude/plans/roles-campaign.md`"), [".claude/plans/roles-campaign.md"]);
});

Deno.test("a dot-leading DIRECTORY is matched; a dot-leading SUFFIX is not", () => {
  // ⚠️ This was a silent false zero for four months. Requiring an alphanumeric
  // in the leading position meant no citation into `.claude/**` or `.github/**`
  // was ever matched, counted, or reported as skipped — 100 of them in
  // api-cloudrun, while the summary read as clean.
  assertEquals(cited("`.github/workflows/ci.yaml`"), [".github/workflows/ci.yaml"]);
  // The discriminator is the `/`: a dot-leading PATH has a directory in it, a
  // dot-leading SUFFIX does not. A character-count rule was tried first and
  // admitted the second of these.
  assertEquals(cited("a `.d.ts` file"), []);
  assertEquals(cited("the `.meta.json` sidecar"), []);
});

Deno.test("every extension in the list is reachable", () => {
  const exts = ["ts", "tsx", "sh", "json", "jsonc", "yaml", "yml", "md", "tf", "tfvars", "tpl"];
  for (const ext of exts) {
    // Interpolated so the regex reading THIS file cannot match a dead path.
    assertEquals(cited(`\`a/b.${ext}\``), [`a/b.${ext}`], ext);
  }
});

Deno.test("a longer token is NOT matched by its prefix", () => {
  // Each of these was a live false BROKEN. The greedy body backtracks until
  // some suffix happens to be a known extension, so without the trailing
  // `(?![A-Za-z0-9(.])` the extension group matches a PREFIX of a longer token.
  assertEquals(cited("`version.sha`"), [], "version.sha is not version.sh");
  assertEquals(cited("`res.json()`"), [], "a method call is not a filename");
  // `tpl` is in the extension list so these match WHOLE and resolve, rather
  // than being silently unrepresentable.
  assertEquals(cited("`vmauth.yml.tpl`"), ["vmauth.yml.tpl"]);
  assertEquals(cited("`setup.sh.tpl`"), ["setup.sh.tpl"]);
});

Deno.test("prose that merely looks like a path is not a citation", () => {
  // A URL route is served by an API, not held by a checkout.
  assertEquals(cited("GET `/openapi.json`"), []);
  // An un-backticked path is prose about a concept, not a reference.
  assertEquals(cited("see src/utils/citations.ts"), []);
  // ⚠️ The angle-bracket convention every one of these audits relies on to
  // quote a PLACEHOLDER from inside its own gated scope.
  assertEquals(cited("`src/lib/<name>.ts`"), []);
});

Deno.test("a scoped package path is matched, not silently skipped", () => {
  // Without `@` in the character class a scoped path matches NOTHING and is
  // silently unchecked — which reads as a clean result rather than a skipped
  // one. Widen the class rather than letting a path form drop out of the count.
  assertEquals(
    cited("`manager/node_modules/@jsr/cfs__core/deno.json`"),
    ["manager/node_modules/@jsr/cfs__core/deno.json"],
  );
});

// ── JSR specifiers ───────────────────────────────────────────────────

Deno.test("a @cfs/core subpath resolves into core/src", () => {
  assertEquals(resolveSpecifier("@cfs/core/schemas/order.ts"), "core/src/schemas/order.ts");
  assertEquals(resolveSpecifier("@cfs/core/utils/order-lines.ts"), "core/src/utils/order-lines.ts");
});

Deno.test("the RETIRED package names deliberately do not resolve", () => {
  // `@cfs/schemas` and `@cfs/utilities` were merged into `@cfs/core` in 2026-06
  // and archived on JSR with no live consumers. Prose still naming one is stale
  // and should say `@cfs/core` — so mapping them would hide a real finding.
  // This is why JSR_PREFIXES is a table and not an `@scope/pkg → <pkg>/src` rule.
  assertEquals(resolveSpecifier("@cfs/schemas/comment.ts"), "@cfs/schemas/comment.ts");
  assertEquals(resolveSpecifier("@cfs/utilities/dates.ts"), "@cfs/utilities/dates.ts");
});

Deno.test("a non-specifier path is returned untouched", () => {
  assertEquals(resolveSpecifier("src/utils/citations.ts"), "src/utils/citations.ts");
  assertEquals(resolveSpecifier("@std/assert/mod.ts"), "@std/assert/mod.ts");
});

// ── History docs are out of scope ────────────────────────────────────

Deno.test("only -RECORD.md docs are treated as history", () => {
  assert(isHistoryDoc("a/.claude/plans/money-arithmetic-campaign-RECORD.md"));
  assert(isHistoryDoc("tax-jurisdiction-campaign-RECORD.md"));
  // ⚠️ NOT generalised to all plan docs. An ordinary plan is refactored freely,
  // is read as current intent, and is exactly where a dead citation misleads —
  // so it must stay in scope.
  assert(!isHistoryDoc("a/.claude/plans/destination-dedupe.md"));
  assert(!isHistoryDoc("CLAUDE.md"));
  assert(!isHistoryDoc("a/RECORD.md"), "the hyphen is required, not just the word");
});

// ── The deletion heuristic, both ways ────────────────────────────────

/** Put `needle` in the middle so the ±240-char window is symmetric. */
function around(prose: string): { text: string; at: number } {
  const at = prose.indexOf("§");
  return { text: prose.replace("§", ""), at };
}
function saysGone(prose: string): boolean {
  const { text, at } = around(prose);
  return describesDeletion(text, at);
}

Deno.test("prose that says the path is gone suppresses the finding", () => {
  assert(saysGone("§`repair-money-2dp.ts` was applied and deleted"));
  assert(saysGone("§`_moneySurface.ts` — removed with the 2dp census"));
  assert(saysGone("recover §`migrate-x.ts` from git history"));
  assert(saysGone("see `git log --diff-filter=D -- scripts/` for §`fix-y.ts`"));
  assert(saysGone("~~§`old-plan.md`~~"), "struck through");
  assert(saysGone("§`audit-money-2dp.ts` is retired"));
  assert(saysGone("the one-shot §`fix-denorm-counts.ts` remediation"));
  assert(saysGone("indexes moved verbatim from §`manager/firestore.indexes.json`"));
  assert(saysGone("§`scripts/audit-destination-duplicates.ts` — not yet written"));
});

Deno.test("prose that ASSUMES the path exists does not", () => {
  // ⚠️ The one that matters. All three of these sit beside their paired
  // migrator exactly like the passing cases above; the difference is entirely
  // in what the sentence tells the reader to do.
  //
  // ⚠️ The first is EXEMPT by name in `scripts/audit-plan-citations.ts` and has
  // to stay byte-exact: it is the sentence that motivated the rule, verbatim
  // from api-cloudrun's audit-xero-code.ts before #625 rewrote it, and the
  // migrator it names had never existed at all.
  assert(
    !saysGone("Pair with §`backfill-xero-code.ts` (the migrator) — run this after it"),
    "an instruction the reader cannot follow must stay red",
  );
  assert(!saysGone("see §`src/utils/citations.ts` for the classification rules"));
  assert(!saysGone("§`src/schemas/order.ts` is the oracle"));
});

Deno.test("the window spans wrapped lines, because these docs are hard-wrapped", () => {
  // ~80 columns means the verb that says "deleted" is routinely on a different
  // line from the path it is about. A line-scoped window would miss most real
  // cases and reintroduce the false positives.
  assert(saysGone("§`migrate-x.ts`\nwas applied to prod on 2026-04-23 and then\ndeleted."));
  // …but it is bounded. A "deleted" 400 characters away is about something else,
  // and treating it as cover would silence unrelated findings.
  assert(
    !saysGone(
      "§`migrate-x.ts` is the migrator." + " padding.".repeat(60) +
        " Something else was deleted.",
    ),
  );
});

// ── preferOwnRepo: the rule AND its inverse ──────────────────────────
//
// ⚠️ This rule decides whether the local run and the CI run give the same
// answer, so both directions are planted. Over-narrowing turns a correct
// cross-repo citation into a BROKEN finding; under-narrowing leaves 49 local
// AMBIGUOUS findings that CI can never reproduce, which is the "guard that
// cries wolf" shape this whole file exists to prevent.

const OWN = "/w/core/";

Deno.test("preferOwnRepo narrows to this repo when it holds a candidate", () => {
  assertEquals(
    preferOwnRepo(["/w/core/src/schemas/order.ts", "/w/api-cloudrun/src/services/orders.ts"], OWN),
    ["/w/core/src/schemas/order.ts"],
  );
});

Deno.test("preferOwnRepo NEVER empties the candidate set", () => {
  // A citation naming only another repo's file is a citation to that repo.
  // Answering "no candidates" would turn it into a BROKEN finding — the
  // opposite of what preferring this repo is for.
  const foreign = ["/w/api-cloudrun/src/lib/logger.ts"];
  assertEquals(preferOwnRepo(foreign, OWN), foreign);
});

Deno.test("preferOwnRepo is not a TIE-BREAKER inside this repo", () => {
  // Two candidates INSIDE this repo stay ambiguous, and they should: that
  // citation genuinely does not say which file it means, and picking one would
  // be guessing.
  const both = ["/w/core/src/schemas/typesense/cards.ts", "/w/core/src/utils/cards.ts"];
  assertEquals(preferOwnRepo(both, OWN), both);
});

Deno.test("preferOwnRepo matches on the PREFIX, not on a path segment", () => {
  // A sibling repo whose name merely starts with ours must not be swept in.
  // Without the trailing slash in the prefix `/w/core-legacy/` would read as
  // ours and silently win the narrowing.
  assertEquals(
    preferOwnRepo(["/w/core-legacy/src/x.ts", "/w/api-cloudrun/src/x.ts"], OWN),
    ["/w/core-legacy/src/x.ts", "/w/api-cloudrun/src/x.ts"],
  );
});

// ── classifyCitation: the decision, and why its ORDER is the content ──
//
// 🔴 This is the branch that moved out of the runners, because it encodes the
// local-vs-CI asymmetry and has already been subtly wrong twice. Each step
// below rules out one reason a CORRECT citation fails to resolve, so every arm
// is planted with its inverse: the step must fire when it should, and must NOT
// fire when the reason it exists for is absent.

const KNOWN = ["core", "api-cloudrun", "manager", "templates", "erp-spec", "claude-plugins"];

/** A full workspace: every repo present, nothing to excuse a miss. */
function facts(over: Partial<CitationFacts> & { resolved: string }): CitationFacts {
  return {
    candidates: [],
    presentRepos: new Set(KNOWN),
    absentRepos: [],
    knownRepos: KNOWN,
    ownTopLevel: new Set(["src", "scripts", "tests", "CLAUDE.md"]),
    describesDeletion: false,
    ...over,
  };
}

Deno.test("step 1 — a build artifact is unverifiable, and only a build artifact", () => {
  assertEquals(classifyCitation(facts({ resolved: "manager/node_modules/@jsr/x/mod.ts" })), "unverifiable");
  assertEquals(classifyCitation(facts({ resolved: "api-cloudrun/_dist/bundle.ts" })), "unverifiable");
  // The inverse: an ordinary unresolved path in a full workspace is broken.
  assertEquals(classifyCitation(facts({ resolved: "api-cloudrun/src/nope.ts" })), "broken");
});

Deno.test("step 2 — a citation into an ABSENT repo cannot be judged", () => {
  const absent = { presentRepos: new Set(["core"]), absentRepos: ["api-cloudrun"] };
  assertEquals(
    classifyCitation(facts({ resolved: "api-cloudrun/src/lib/logger.ts", ...absent })),
    "unverifiable",
  );
  // ⚠️ The inverse, and the reason this is not just noise reduction: when the
  // repo IS present, the same citation is fully checkable and stays broken.
  assertEquals(
    classifyCitation(facts({ resolved: "api-cloudrun/src/lib/logger.ts" })),
    "broken",
  );
});

Deno.test("step 3 — an OWN-top-level claim stays broken even in a bare checkout", () => {
  // 🔴 Without this carve-out the CI run is nearly vacuous: almost nothing is
  // written `api-cloudrun/scripts/…`, so a genuinely dead bare path would
  // report unverifiable in CI and be caught only on a developer's laptop.
  const ci = { presentRepos: new Set(["core"]), absentRepos: ["api-cloudrun", "manager"] };
  assertEquals(classifyCitation(facts({ resolved: "src/schemas/nope.ts", ...ci })), "broken");
  assertEquals(classifyCitation(facts({ resolved: "scripts/nope.ts", ...ci })), "broken");
  // ⚠️ The inverse, and the asymmetry core's docstrings must respect: a head
  // that is NOT one of the running repo's top-level entries falls through to
  // step 4 and is excused.
  assertEquals(classifyCitation(facts({ resolved: "lib/nope.ts", ...ci })), "unverifiable");
});

Deno.test("step 3 beats step 4 — the ORDER is what makes CI worth running", () => {
  // Both steps apply to `src/schemas/<name>.ts` in a bare checkout. If step 4 ran
  // first, every own-repo citation would be excused and the gate would check
  // nothing it does not already check locally.
  const ci = { presentRepos: new Set(["core"]), absentRepos: ["api-cloudrun"] };
  assertEquals(classifyCitation(facts({ resolved: "src/schemas/nope.ts", ...ci })), "broken");
});

Deno.test("step 4 — an incomplete workspace cannot tell dead from elsewhere", () => {
  const ci = { presentRepos: new Set(["core"]), absentRepos: ["api-cloudrun"] };
  assertEquals(classifyCitation(facts({ resolved: "some/other/thing.ts", ...ci })), "unverifiable");
  // The inverse: in a COMPLETE workspace there is no such excuse.
  assertEquals(classifyCitation(facts({ resolved: "some/other/thing.ts" })), "broken");
});

Deno.test("step 5 — only then does the prose get to excuse it", () => {
  assertEquals(
    classifyCitation(facts({ resolved: "api-cloudrun/scripts/gone.ts", describesDeletion: true })),
    "deleted-ok",
  );
  assertEquals(
    classifyCitation(facts({ resolved: "api-cloudrun/scripts/gone.ts" })),
    "broken",
  );
});

Deno.test("a line past EOF is broken, and the prose excuses that too", () => {
  const found = { candidates: ["/w/core/src/schemas/order.ts"] };
  assertEquals(
    classifyCitation(facts({ resolved: "src/schemas/order.ts", ...found, lineOutOfRange: true })),
    "broken",
  );
  assertEquals(
    classifyCitation(
      facts({
        resolved: "src/schemas/order.ts",
        ...found,
        lineOutOfRange: true,
        describesDeletion: true,
      }),
    ),
    "deleted-ok",
  );
  // The inverse: in range, it is simply fine.
  assertEquals(
    classifyCitation(facts({ resolved: "src/schemas/order.ts", ...found })),
    "ok",
  );
});

Deno.test("a bare basename matching several files is ambiguous — a PATH is not", () => {
  // A bare basename is not a shorthand, it is an unresolvable reference.
  assertEquals(
    classifyCitation(
      facts({
        resolved: "cards.ts",
        candidates: ["/w/core/src/utils/cards.ts", "/w/core/src/schemas/typesense/cards.ts"],
      }),
    ),
    "ambiguous",
  );
  // ⚠️ The inverse. A path WITH a directory that still matched more than one
  // file is not ambiguous in the same way — the extra matches are same-suffix
  // paths in other repos, which step 3's carve-out already rules on. Calling
  // these ambiguous would flag every correct cross-repo citation.
  assertEquals(
    classifyCitation(
      facts({
        resolved: "src/schemas/order.ts",
        candidates: ["/w/core/src/schemas/order.ts", "/w/other/src/schemas/order.ts"],
      }),
    ),
    "ok",
  );
  // A bare basename matching exactly one file is fine.
  assertEquals(
    classifyCitation(facts({ resolved: "cards.ts", candidates: ["/w/core/src/utils/cards.ts"] })),
    "ok",
  );
});
