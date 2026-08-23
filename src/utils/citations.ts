/**
 * The pure rules behind the repos' **doc-citation audits** — extracting a
 * backticked `path.ext` / `path.ext:N` from prose, and deciding what its
 * failure to resolve MEANS.
 *
 * 🔴 **Tooling only. Nothing under `src/` or any consumer's runtime imports
 * this.** It sits in `utils/` beside domain helpers (`dates`, `money`,
 * `taxes`) and is deliberately not one of them; the namespace now carries both
 * kinds, which `CLAUDE.md` § Overview records. Namespaced subpaths mean it
 * ships only if imported, so it costs manager's bundle nothing — the same
 * reason `beta.202` moved the propagation rule VALUES off the root barrel.
 *
 * ## Why the rules live here and the runners do not
 *
 * Each repo keeps its own runner, because `SCAN_ROOTS`, `OWN_TOP_LEVEL`,
 * `REPOS` and the exemption list are repo-specific facts. What moves is
 * everything that can be wrong **identically in two places**: the regex, the
 * deletion vocabulary, the JSR prefix table, and — the part that matters most
 * — {@link classifyCitation}, the branch that decides `broken` from
 * `unverifiable`.
 *
 * ⚠️ **The DECISION moved, not just the regex, and that was the point.** That
 * branch encodes a local-vs-CI asymmetry (below) and has been subtly wrong
 * twice: once when a repo that is not cloned made the audit crash rather than
 * skip, and once when an exemption lookup sat *after* the
 * environment-dependent tests and so could never discharge in CI. Two copies
 * of it means two repos can disagree about the same citation.
 *
 * ## The asymmetry every consumer has to respect
 *
 * A citation is checked against whatever is on disk. In CI each repo is
 * checked out ALONE, so a citation naming a sibling repo cannot be resolved
 * there — and calling it broken would fail every cross-repo reference in CI
 * while passing locally, which is worse than not checking it. Hence
 * `unverifiable`.
 *
 * ⚠️ **But a citation leading with one of the RUNNING repo's own top-level
 * entries stays fully checkable everywhere**, and without that carve-out the
 * CI run is nearly vacuous: almost nothing is written `api-cloudrun/scripts/…`,
 * so a genuinely dead bare `scripts/<name>.ts` would report `unverifiable` in CI
 * and be caught only on a developer's laptop.
 *
 * 🔴 **The carve-out cuts the other way in `core`, and a consumer must expect
 * it.** `src/…`, `scripts/…` and `tests/…` are core's own top-level entries
 * too — so a core docstring citing a bare `src/lib/<name>.ts` (an
 * api-cloudrun file) is `broken` under core's runner and merely `ambiguous`
 * under api-cloudrun's. The fix is always to repo-qualify the citation, which
 * is what makes a docstring readable to someone holding one repo — including
 * every cloud agent.
 */

/**
 * A backticked path with an optional `:N` or `:N-M` suffix.
 *
 * ⚠️ The first character class is NARROWER than the rest on purpose. A citation
 * may not START with a bare `/` or a single-letter dot segment, which is what
 * separates a path from two prose forms that look like one: a URL route
 * (`/openapi.json`, served by an API, not a file) and a bare extension
 * (`.d.ts`, discussed as a concept). Widening the leading character to match
 * the body reports both as broken — a guard that cries wolf, which is how a
 * broken count stops being read.
 *
 * ⚠️ **But requiring an ALPHANUMERIC there was too narrow, and it was a silent
 * false zero for four months.** Every dot-leading directory — `.claude/**`,
 * `.github/**` — failed the leading class, so no citation into any of them was
 * ever matched, counted, or reported as skipped. In api-cloudrun those are the
 * skills, the plans, the commands and the workflows: 100 citations, and the
 * summary said nothing about them while reading as clean. Found 2026-08-23 by
 * a planted case, not by review — the audit's own docstring used
 * `.claude/plans/…` as its worked example of a path-only citation being
 * matched, which it was not.
 *
 * So the leading position is an ALTERNATION, and the dot-leading branch
 * requires a `/` before the extension. That is the actual discriminator: a
 * dot-leading PATH has a directory in it (`.claude/skills/…`), while a
 * dot-leading SUFFIX does not (`.d.ts`, and `.meta.json` — the template
 * sidecar's extension, discussed as a concept). A character-count rule was
 * tried first and admitted `.meta.json`.
 *
 * ⚠️ The trailing `(?![A-Za-z0-9(.])` is load-bearing, and its absence produced
 * FIVE false broken findings in instruction-grade docs (2026-08-23). Without it
 * the extension group matches a PREFIX of a longer token, because the greedy
 * body backtracks until some suffix happens to be a known extension:
 *   `version.sha`  → reported as a citation to version.sh
 *   `res.json()`   → a method call on a fetch response, read as res.json
 *   `vmauth.yml.tpl`, `docker-compose.yml.tpl`, `setup.sh.tpl`
 *                  → reported as the rendered VM filenames, which are of
 *                    course not in the repo — so the three files the obs
 *                    GitOps section is ABOUT all read as broken
 * Each looks exactly like a dead file to a reader skimming the output. `(`
 * separates a method call from a dotted filename; `.` stops the prefix match.
 * `tpl` is in the extension list for the same reason — with it,
 * `vmauth.yml.tpl` matches WHOLE and resolves, instead of being silently
 * unrepresentable.
 *
 * ⚠️ **There is no CLOSING delimiter, so this matches the first token of any
 * code span — including a JS template literal used as an assertion message.**
 * Reproduced 2026-08-23: a template literal opening with orders.ts and
 * continuing "must be listed ${n} times" yields orders.ts as a citation
 * (un-backticked here, or this docstring would demonstrate the bug ON ITSELF —
 * which it did on the first attempt). That is deliberate rather than
 * unnoticed, and the trade is
 * asymmetric: requiring a closing backtick would also drop the legitimate
 * *"path plus a parenthetical"* form that appears in real prose, and the
 * measured cost of the current shape is zero — all four repos report 0 broken.
 * **Any anchor-based successor has to decide this explicitly**, because it must
 * distinguish prose from a string literal in source rather than treating both
 * as text.
 *
 * ⚠️ **It carries the `g` flag, so it is STATEFUL.** `RegExp.lastIndex`
 * persists across calls on a shared instance. Use it with `matchAll`, which
 * clones internally — never with a bare `.test()` or `.exec()` loop on this
 * export.
 */
export const CITATION =
  /`((?:[A-Za-z0-9_@][A-Za-z0-9_@./-]*|\.[A-Za-z0-9_][A-Za-z0-9_@.-]*\/[A-Za-z0-9_@./-]*)\.(?:ts|tsx|sh|json|jsonc|yaml|yml|md|tf|tfvars|tpl))(?![A-Za-z0-9(.])(?:\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?)?/g;

/**
 * Rewrite a JSR module specifier to the workspace path it names.
 *
 * ⚠️ **Without this, every `@cfs/core/...` citation reads as broken — 21 of
 * them in api-cloudrun alone, all correct.** They are how the whole codebase
 * refers to this package, so it is the single densest citation form in `src/`,
 * and reporting the densest correct form as the top finding is precisely how a
 * guard stops being read.
 *
 * `@cfs/core` publishes `src/` under namespaced subpaths (`@cfs/core/schemas`,
 * `@cfs/core/utils/*`), so the mapping is a prefix swap. It is deliberately a
 * TABLE and not a general `@scope/pkg → <pkg>/src` rule: the retired
 * `@cfs/schemas` and `@cfs/utilities` packages must NOT resolve — they are
 * archived on JSR with no live consumers, so prose still naming one is stale
 * and should say `@cfs/core`.
 */
export const JSR_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["@cfs/core/", "core/src/"],
];

/** Apply {@link JSR_PREFIXES}; a non-specifier path is returned untouched. */
export function resolveSpecifier(path: string): string {
  for (const [from, to] of JSR_PREFIXES) {
    if (path.startsWith(from)) return to + path.slice(from.length);
  }
  return path;
}

/**
 * Append-only history docs, whose citations are SUPPOSED to name things that no
 * longer exist.
 *
 * A `*-RECORD.md` is an account of a finished campaign. Measured 2026-08-23,
 * api-cloudrun's `money-arithmetic-campaign-RECORD.md` alone held **32 of that
 * repo's 39 broken citations**, essentially all deliberately-deleted one-shots,
 * probes and ratchets. Including them would mean either rewriting true history
 * or an exemption per line. Deliberately NOT generalised to all plan docs: an
 * ordinary plan is refactored freely, is read as current intent, and is exactly
 * where a dead citation misleads.
 */
export function isHistoryDoc(path: string): boolean {
  return /-RECORD\.md$/.test(path);
}

/**
 * ⚠️ **`one-shot` and `git history` are in here because THE SCRIPTS CONVENTION
 * defines them that way**, not as a general-English guess.
 * `api-cloudrun/CLAUDE.md` § Scripts: *"**One-shot** (`migrate-*`, `backfill-*`, …) —
 * applied once to prod, then **DELETE** … Archive is git: `git log
 * --diff-filter=D -- scripts/`"*. So prose calling something "the one-shot
 * fix-denorm-counts.ts" IS telling the reader where to look, and flagging it
 * would be flagging the convention.
 *
 * `moved … from` and `not yet written` are the same claim pointed the other two
 * ways: *"composite indexes moved there from manager/firestore.indexes.json"*
 * tells the reader the old path is gone, and a plan's entry naming a script it
 * WANTS written is a specification, not an assertion that the file exists.
 * ⚠️ The second one is only honest because deferred work also gets a GitHub
 * issue — the org's deferred-work rule. Without that, "not yet written" would
 * be a phrase that silences the guard forever at zero cost.
 *
 * ⚠️ **It is NOT enough that the citation merely names a `migrate-*` file.**
 * The signal has to be in the PROSE, which is what keeps this honest: three
 * sampled audit scripts cited their paired migrator, two said "the one-shot" or
 * "lives in git history" and were fine, and the third said *"Pair with
 * backfill-xero-code.ts (the migrator) — run this after it"*, which is an
 * instruction a reader cannot follow. That third one was a real finding, and
 * the migrator it named had never existed at all.
 */
export const DELETION_VOCABULARY =
  /\b(delet|remov|no longer exist|does not exist|doesn't exist|gone|retired|dead|drop(?:ped)?|superseded|replaced by|since renamed|used to (?:be|live)|was never (?:written|created)|never existed|recover(?:ed)? from git|diff-filter=D|one-shot|git history|moved (?:\w+ )?from|not yet written|yet to be written)/i;

/**
 * Does the prose around this citation say the path is GONE?
 *
 * ⚠️ **This is the one heuristic here, so it is reported as its own class
 * rather than folded into "clean".** A static walker's extraction fails in BOTH
 * directions — under-extraction invents findings, over-extraction falsely
 * satisfies — and only planted violations distinguish them, which is why the
 * test file plants one of each.
 *
 * The window is the surrounding ±240 characters rather than the line: these
 * docs are hard-wrapped at ~80 columns, so the verb that says "deleted" is
 * routinely on a different line from the path it is about.
 *
 * Erring towards deleted-ok is the safe direction. A missed real breakage is
 * one stale citation; a false broken on a correct sentence about a deleted
 * one-shot trains readers to ignore the count, and the count is the only number
 * here that must stay at zero.
 */
export function describesDeletion(text: string, at: number): boolean {
  const window = text.slice(Math.max(0, at - 240), at + 240);
  if (/~~/.test(window)) return true; // struck through
  return DELETION_VOCABULARY.test(window);
}

/**
 * Narrow a citation's candidate files to the RUNNING repo's, when it has any.
 *
 * ⚠️ **A correctness fix, not just noise reduction — it makes the local run
 * agree with CI.** In CI only the running repo is indexed, so a bare
 * `<name>.ts` resolves to exactly one file there and is reported clean; in a
 * full workspace the cross-repo search finds the other repos' too and reports
 * ambiguous. Two environments, two verdicts, same citation. Under this rule CI
 * is a **no-op** — there is nothing else indexed to narrow away — and the local
 * run stops inventing a finding CI will never reproduce. Measured over
 * api-cloudrun's 161 local findings: **49 collapse to a single candidate**.
 *
 * ⚠️ The live pair is `api-cloudrun/src/lib/logger.ts` and
 * `manager/src/utils/logger.ts`. This paragraph said *core's* until 2026-08-23,
 * and core holds no file of that name at all — a worked example naming a file
 * that does not exist, in the docstring of the very rule that exists to
 * disambiguate file names. It survived because the example was written as a
 * bare basename, which is precisely the form this audit could not check until
 * core#67.
 *
 * ⚠️ **It narrows and never empties.** When no candidate is under the running
 * repo the whole set comes back unchanged — a citation naming only another
 * repo's file is a citation to that repo, and answering "no candidates" would
 * turn it into a broken finding, the opposite of what this is for.
 *
 * ⚠️ **It is not a tie-breaker.** Two candidates *inside* the running repo
 * (`src/routes/<x>.ts` and `src/services/<x>.ts`) stay ambiguous, and
 * they should: that citation genuinely does not say which file it means, and
 * picking one would be guessing. 107 of the 161 were that shape and were fixed
 * by qualifying the prose.
 *
 * `ownRepoPrefix` must end in the path separator, or a sibling whose name
 * merely starts with the running repo's is swept in.
 */
export function preferOwnRepo(candidates: readonly string[], ownRepoPrefix: string): string[] {
  const own = candidates.filter((c) => c.startsWith(ownRepoPrefix));
  return own.length ? own : [...candidates];
}

/**
 * The PARAGRAPH containing `at` — the window {@link narrowingSuspects} reads.
 *
 * A line holding nothing but a comment marker (` *`, `//`, `#`) counts as blank,
 * so a JSDoc block's bullets are separate paragraphs rather than one run.
 *
 * ⚠️ **The window size IS the precision, measured rather than guessed.** With
 * {@link describesDeletion}'s ±240-character window the suspect list ran at
 * about half true positives, because 240 characters reaches into the NEXT
 * docstring: a citation to manager's own bookings.ts (un-backticked here, so
 * these examples are not themselves citations) was flagged on the strength of
 * the word "core" in an unrelated sentence below it, and a citation to
 * api-cloudrun's own logger.ts on a manager#264 four lines above. Scoping
 * to the paragraph removed both and kept every true positive — 3 of 4 sampled,
 * against 2 of 4 before.
 *
 * The two windows are deliberately different and must stay so.
 * `describesDeletion` is looking for a verb that may legitimately sit a couple
 * of hard-wrapped lines away; this is looking for the SUBJECT of the sentence,
 * which is a much tighter claim.
 */
export function paragraphAround(text: string, at: number): string {
  const isBlank = (l: string) => /^\s*(?:\*|\/\/|#|\/\*\*)?\s*$/.test(l);
  const lines = text.split("\n");
  let idx = 0, cur = 0;
  for (; cur < lines.length; cur++) {
    if (idx + lines[cur].length + 1 > at) break;
    idx += lines[cur].length + 1;
  }
  let a = cur, b = Math.min(cur, lines.length - 1);
  while (a > 0 && !isBlank(lines[a - 1])) a--;
  while (b < lines.length - 1 && !isBlank(lines[b + 1])) b++;
  return lines.slice(a, b + 1).join("\n");
}

/**
 * Repos that {@link preferOwnRepo} DISCARDED, which the surrounding paragraph
 * explicitly names — the one mechanically detectable slice of semantic drift.
 *
 * 🔴 **`preferOwnRepo` does not only reduce noise; it MANUFACTURES a confident
 * single answer.** When a bare basename matches files in several repos and
 * narrowing keeps only the running repo's, the verdict is a clean `ok` — where
 * without the narrowing it would have been `ambiguous` and a human would have
 * read it. That is the right trade almost always (it is what makes the local run
 * agree with CI, and it removed 49 findings in api-cloudrun alone). But where
 * the discarded candidate sits in a repo the surrounding prose **explicitly
 * names**, the confident answer is the wrong one, and nothing else can see it.
 *
 * Measured 2026-08-23 over core + api-cloudrun + manager: **25 suspects in 3,728
 * resolved citations (0.7%)**. Confirmed real in the sample —
 *
 *   - core/src/schemas/propagation/out-of-service.ts cites a bare
 *     bookings.test.ts inside an `enforced_by` clause whose sibling ref is an
 *     api-cloudrun path, quoting a test name (*"cowrites two OOS records"*)
 *     that exists ONLY in api-cloudrun's integration copy — 0 hits in core's
 *     own tests/bookings.test.ts, which is where it resolved.
 *   - a plan doc's *"templates #99 moved deno.json"*, which resolved to
 *     api-cloudrun's.
 *
 *   (Every path in this paragraph is un-backticked on purpose: backticked, each
 *   would be a live citation of exactly the ambiguous shape being described,
 *   and this docstring would report itself.)
 *
 * ⚠️ **REPORT-ONLY. It must never gate, and the reason is arithmetic.** At ~3 in
 * 4 a build gate would fail on a correct citation every fourth finding, and a
 * false alarm on a QUALITY signal is what teaches a reader to skip the whole
 * report — the failure the citation campaign exists to prevent. A confirmed
 * false positive to keep in mind: `core/CLAUDE.md`'s own bullet about the
 * ambiguity rule names api-cloudrun in a sentence ABOUT the rule, beside
 * citations that correctly mean core's own files.
 *
 * The caller maps a path to its repo, because that mapping is a fact about a
 * workspace layout rather than about citations.
 */
export function narrowingSuspects(discardedRepos: readonly string[], paragraph: string): string[] {
  const named = new Set<string>();
  for (const repo of discardedRepos) {
    // Word-bounded: `core` must not match inside `cores` or a hyphenated name.
    if (new RegExp(`\\b${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(paragraph)) {
      named.add(repo);
    }
  }
  return [...named];
}

/** What a citation turned out to be. See {@link classifyCitation}. */
export type CitationVerdict =
  | "ok"
  | "broken"
  | "ambiguous"
  | "unverifiable"
  | "deleted-ok";

/** One classification request. All fields are facts the runner gathered. */
export interface CitationFacts {
  /** The cited path, already through {@link resolveSpecifier}. */
  readonly resolved: string;
  /** Files that matched, already through {@link preferOwnRepo}. */
  readonly candidates: readonly string[];
  /** Repo names this machine has checked out. */
  readonly presentRepos: ReadonlySet<string>;
  /** Repo names this machine does NOT have. Empty in a full workspace. */
  readonly absentRepos: readonly string[];
  /** Every repo name the workspace knows about, present or not. */
  readonly knownRepos: readonly string[];
  /** Top-level entries of the repo the audit is RUNNING in. */
  readonly ownTopLevel: ReadonlySet<string>;
  /** Whether the surrounding prose says the path is gone. */
  readonly describesDeletion: boolean;
  /** True when the citation carried a `:N` that is past every candidate's EOF. */
  readonly lineOutOfRange?: boolean;
}

/**
 * The whole decision, in one place, ordered.
 *
 * 🔴 **The ORDER is the content.** Each step below rules out one reason a
 * correct citation fails to resolve, and moving any of them changes verdicts
 * silently:
 *
 * 1. A **build artifact** (`node_modules`, `_dist`) is legitimate to cite and
 *    impossible to check — it is reproducible from a published version rather
 *    than committed.
 * 2. A citation naming a **repo this machine does not have** cannot be judged.
 * 3. A citation leading with one of the **running repo's own** top-level
 *    entries is a claim about this repo and stays checkable even so — without
 *    this the CI run is nearly vacuous.
 * 4. Anything still unresolved in an **incomplete workspace** is unverifiable,
 *    because "dead" and "lives in a repo I do not have" are indistinguishable.
 * 5. Only then does the **prose** get to excuse it.
 *
 * ⚠️ **An EXEMPT/allowlist check belongs BEFORE all of this, in the runner.**
 * Steps 2 and 4 are environment-dependent, so a lookup placed after them is
 * reached on one machine and not another — and a both-directions discharge then
 * reports *"matched NOTHING: the citation is gone"* about a citation sitting
 * untouched in the file. An explicit human ruling may not be gated on which
 * repos happen to be cloned.
 */
export function classifyCitation(f: CitationFacts): CitationVerdict {
  if (/node_modules|_dist/.test(f.resolved)) return "unverifiable";

  if (!f.candidates.length) {
    const head = f.resolved.split("/")[0];
    const citedRepo = f.knownRepos.includes(head) ? head : null;
    if (citedRepo && !f.presentRepos.has(citedRepo)) return "unverifiable";
    const ownClaim = f.ownTopLevel.has(head);
    if (!citedRepo && !ownClaim && f.absentRepos.length > 0) return "unverifiable";
    return f.describesDeletion ? "deleted-ok" : "broken";
  }

  if (f.lineOutOfRange) return f.describesDeletion ? "deleted-ok" : "broken";

  // A bare basename matching several real files is not a shorthand — it is an
  // unresolvable reference. A path WITH a directory that still matched more
  // than one file is not ambiguous in the same way: the extra matches are
  // same-suffix paths in other repos, which step 3's carve-out already rules on.
  if (!f.resolved.includes("/") && f.candidates.length > 1) return "ambiguous";
  return "ok";
}
