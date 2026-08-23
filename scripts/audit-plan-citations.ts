/**
 * Read-only audit of backticked path citations in **this package's** prose.
 *
 * (Angle brackets throughout this file mark a PLACEHOLDER rather than a path.
 * The citation regex rejects a leading `<`, so an illustrative example cannot
 * report itself broken from inside the gated scope.)
 *
 * A long-lived docstring cites source by path, and source moves. The rules that
 * decide what a citation IS and what its failure to resolve MEANS live in
 * `src/utils/citations.ts` and are shared with every consumer; this file is the
 * thin per-repo half — `SCAN_ROOTS`, `OWN_TOP_LEVEL`, `REPOS` and `EXEMPT` are
 * facts about core specifically. **That split is deliberate, not residual
 * duplication**: the shared half is everything that could be wrong identically
 * in two repos, and the decision branch moved with the regex for exactly that
 * reason.
 *
 * ⚠️ **It imports the rules RELATIVELY**, so core's CI needs no publish of core
 * to gate core. api-cloudrun's runner imports the same module from JSR.
 *
 * Four outcomes, deliberately never summed into one reassuring number —
 * BROKEN, AMBIGUOUS, DELETED-OK, UNVERIFIABLE. See {@link classifyCitation}.
 *
 * ⚠️ **This proves the path EXISTS, not that it still says what the prose
 * claims.** That is the weaker half and it is deliberate — deciding whether a
 * ref still supports its sentence needs a reader. Use it to clear the
 * mechanical class cheaply, so review attention goes to the semantic one.
 *
 * ## What core's own run sees that api-cloudrun's cannot
 *
 * 🔴 **`src/`, `scripts/` and `tests/` are CORE's top-level entries.** So a core
 * docstring citing a bare `src/lib/<name>.ts` — an api-cloudrun file — trips
 * the own-repo carve-out here and is reported BROKEN, where api-cloudrun's
 * runner calls the same string merely AMBIGUOUS. That asymmetry is the point:
 * such a citation resolves today only by accident of the whole `~/cfs`
 * workspace being checked out, and CI checks out core alone. Repo-qualify it
 * (`api-cloudrun/src/lib/logger.ts`) — which is what makes a docstring readable
 * to anyone holding only core, including every cloud agent.
 *
 * ⚠️ **Verify a scope change by SIMULATING the CI checkout, not by running it
 * here**, because the class above is invisible in a full workspace:
 *
 *     cp -R core /tmp/ci-sim/ && cd /tmp/ci-sim/core
 *     HOME=/tmp/nonexistent deno task audit:citations; echo "exit=$?"
 *
 * (The `HOME` override drops the auto-memory index too, which CI also lacks.)
 *
 * Usage:
 *   deno run --allow-read --allow-env scripts/audit-plan-citations.ts
 *   deno run --allow-read --allow-env scripts/audit-plan-citations.ts <name>.md…
 *   deno run --allow-read --allow-env scripts/audit-plan-citations.ts --strict
 *   deno run --allow-read --allow-env scripts/audit-plan-citations.ts --verbose
 *
 * Exit: 0 clean · 1 error · 2 findings (broken; plus ambiguous under --strict).
 */
import {
  CITATION,
  type CitationVerdict,
  classifyCitation,
  describesDeletion,
  isHistoryDoc,
  narrowingSuspects,
  paragraphAround,
  preferOwnRepo,
  resolveSpecifier,
} from "../src/utils/citations.ts";

const REPO = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const WORKSPACE = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * Every repo the workspace knows about — used only to tell "names a repo I do
 * not have" from "names nothing". Listing repos core does not depend on is
 * correct: core's docstrings cite api-cloudrun and manager constantly.
 */
const REPOS = ["core", "api-cloudrun", "manager", "templates", "erp-spec", "claude-plugins"];

const SKIP = new Set([
  "node_modules",
  ".git",
  "_dist",
  "dist",
  "coverage",
  // ⚠️ A gitignored agent worktree is a COMPLETE SECOND CHECKOUT of core. Left
  // in, every one of core's own files gains a twin and the bare-basename
  // ambiguity rule fires on essentially every citation in the package — a red
  // gate that says nothing about the prose. The directory is normally empty,
  // which is exactly why this is easy to leave out and hard to notice.
  "worktrees",
]);

const strict = Deno.args.includes("--strict");
const verbose = Deno.args.includes("--verbose");
const argFiles = Deno.args.filter((a) => !a.startsWith("--"));

/** Every real file in the workspace, indexed by full path and by basename. */
const byBasename = new Map<string, string[]>();
const allPaths: string[] = [];
const presentRepos = new Set<string>();

/**
 * Index one directory tree. Returns false when the directory is absent — a repo
 * that isn't cloned on this machine is not an error, and in CI only `core` is
 * checked out.
 *
 * ⚠️ **The try MUST wrap the ITERATION, not the `Deno.readDir` call.**
 * `Deno.readDir` returns an async iterable and defers the `NotFound` to the
 * first `next()`, so a try around the call alone catches nothing and the error
 * escapes as an unhandled rejection — crashing on the first CI run, where five
 * of the six repos are absent by construction. api-cloudrun's runner was
 * written that way until 2026-08-23.
 */
async function index(dir: string): Promise<boolean> {
  try {
    for await (const e of Deno.readDir(dir)) {
      if (SKIP.has(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await index(p);
      else if (e.isFile) {
        byBasename.set(e.name, [...(byBasename.get(e.name) ?? []), p]);
        allPaths.push(p);
      }
    }
  } catch {
    return false;
  }
  return true;
}
for (const r of REPOS) {
  if (await index(`${WORKSPACE}/${r}`)) presentRepos.add(r);
}
const absentRepos = REPOS.filter((r) => !presentRepos.has(r));

/**
 * The auto-memory notes, indexed too — they are cited by name from plan docs,
 * and those citations are CORRECT. They live outside every repo under
 * `~/.claude/projects/<slug>/memory/`, and CI has none: a miss there falls
 * through to the absent-repo rule and reports UNVERIFIABLE, which is the honest
 * answer for a path CI genuinely cannot see.
 */
let memoryIndexed = false;
try {
  const home = Deno.env.get("HOME");
  if (home) {
    for await (const proj of Deno.readDir(`${home}/.claude/projects`)) {
      if (!proj.isDirectory) continue;
      if (await index(`${home}/.claude/projects/${proj.name}/memory`)) memoryIndexed = true;
    }
  }
} catch { /* no memory dir on this machine — the absent-repo rule covers it */ }

/**
 * Where core keeps instruction-grade prose.
 *
 * ⚠️ **The list is TOTAL over the package's AUTHORED prose, and it must stay
 * that way, because both of api-cloudrun's previous gaps were invisible.** One
 * was named as deferred and printed on every run; the other — `.github/` and
 * the root README — was in neither list, so nothing anywhere said it was
 * uncovered, and each held a broken citation. **A root that is skipped must be
 * skipped out loud**, which is why the summary prints what it DID scan.
 *
 * 🔴 **`API.md` and `API.json` are excluded, and nothing is lost by it.** They
 * are generated deno-doc output (1.7 MB combined, regenerated by `deno task
 * docs` and diff-checked by `docs:check`) — a projection of the very `src/`
 * docstrings the `src` root already scans. Including them would double-count
 * every citation in the package and report each finding twice: once at its
 * source, once at a generated line no one can edit.
 *
 * A configured root that does not exist FAILS rather than being skipped: a root
 * silently dropping out reads as a clean result rather than as an unscanned one.
 */
const SCAN_ROOTS: Array<{ path: string; exts: string[]; extensionless?: boolean }> = [
  { path: "CLAUDE.md", exts: [".md"] },
  { path: "README.md", exts: [".md"] },
  { path: ".claude", exts: [".md"] },
  { path: "notes", exts: [".md"] },
  // The densest and most authoritative half: source docstrings. This package is
  // mostly prose about invariants, and it cites its consumers by path.
  { path: "src", exts: [".ts"] },
  { path: "scripts", exts: [".ts", ".md", ".sh"] },
  { path: "tests", exts: [".ts"] },
  { path: ".github", exts: [".yaml", ".yml", ".md"] },
  // ⚠️ `extensionless` is what reaches `.githooks/{pre-commit,pre-push,commit-msg}`.
  // All three are instruction-grade prose about which check runs where, and a
  // git hook has no extension by construction — naming the three explicitly
  // would go stale the moment a fourth is added, in the direction that reports
  // green.
  { path: ".githooks", exts: [".sh"], extensionless: true },
];

async function* filesUnder(
  dir: string,
  exts: string[],
  extensionless = false,
): AsyncGenerator<string> {
  let entries;
  try {
    entries = Deno.readDir(dir);
  } catch {
    return;
  }
  for await (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* filesUnder(p, exts, extensionless);
    else if (exts.some((x) => e.name.endsWith(x))) yield p;
    else if (extensionless && !e.name.includes(".")) yield p;
  }
}

async function docsToCheck(): Promise<string[]> {
  if (argFiles.length) return argFiles;
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = `${REPO}/${root.path}`;
    let stat;
    try {
      stat = await Deno.stat(abs);
    } catch {
      console.error(
        `error: configured scan root \`${root.path}\` does not exist — fix SCAN_ROOTS`,
      );
      Deno.exit(1);
    }
    if (stat.isFile) out.push(abs);
    else for await (const f of filesUnder(abs, root.exts, root.extensionless)) out.push(f);
  }
  return out.filter((f) => !isHistoryDoc(f));
}

const rel = (p: string) => p.replace(`${WORKSPACE}/`, "");
/** True for the repo this audit is RUNNING in — it can never be "narrowed away". */
const c0 = (r: string) => `${WORKSPACE}/${r}` === REPO;

/**
 * Dead citations that are allowed to stand for a stated reason.
 *
 * ⚠️ **Each entry is checked in BOTH directions** — the discharge condition an
 * allowlist needs to avoid rotting into decoration:
 *
 * - if the path comes BACK, the exemption fails as obsolete;
 * - if the citation DISAPPEARS, the exemption fails as unmatched.
 *
 * ⚠️ **`file` is WORKSPACE-relative (`core/src/…`)**, because that is the form
 * the report prints — so an entry can be copied straight out of a failure line.
 *
 * Prefer fixing the citation, or letting {@link describesDeletion} carry it by
 * saying in the prose that the path is gone — an entry here is for a dead path
 * the prose must name *without* describing as dead.
 */
const EXEMPT: { file: string; path: string; why: string }[] = [
  {
    file: "core/scripts/generate-lucide-icons.ts",
    path: "icon-nodes.json",
    why:
      "Internal to the `lucide-static` npm tarball this script downloads and " +
      "reads at runtime; no checkout contains it, and no package is installed " +
      "to point at either. Naming it is the point — it is the file whose shape " +
      "the parser below depends on, so a reader diagnosing a format change " +
      "needs the name. ⚠️ Un-backticked deliberately: this file is inside the " +
      "scanned roots, so an exemption quoting its own path as a citation would " +
      "report itself broken.",
  },
];
const exemptUsed = new Set<string>();

const lineCounts = new Map<string, number>();
async function lineCount(f: string): Promise<number> {
  const hit = lineCounts.get(f);
  if (hit !== undefined) return hit;
  const n = (await Deno.readTextFile(f)).split("\n").length;
  lineCounts.set(f, n);
  return n;
}

/**
 * `.gitignore` patterns, so a citation to a RUNTIME ARTIFACT is recognised as
 * one instead of reported broken. **Derived from `.gitignore`, deliberately not
 * hand-listed** — that file is already the repo's statement of "this path is
 * generated, not authored", so the classification cannot drift from the truth
 * the way a second hand-maintained list would.
 *
 * Only the simple forms are handled — a basename glob, or a path prefix.
 * Anything more exotic falls through and is reported, which is the safe
 * direction.
 */
const gitignoreGlobs: RegExp[] = [];
try {
  for (const raw of (await Deno.readTextFile(`${REPO}/.gitignore`)).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!body || body.includes("**")) continue;
    const rx = body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    gitignoreGlobs.push(new RegExp(`(^|/)${rx}(/|$)`));
  }
} catch { /* no .gitignore — every citation is simply checked normally */ }

function isRuntimeArtifact(path: string): boolean {
  return gitignoreGlobs.some((rx) => rx.test(path));
}

/**
 * Core's own top-level entries, so a BARE relative citation can be recognised
 * as a claim about THIS package rather than about some unknown repo.
 *
 * 🔴 **This is the carve-out that makes core's run sharper than api-cloudrun's,
 * and it is why core's docstrings must repo-qualify.** `src`, `scripts` and
 * `tests` are core's, so a bare `src/lib/<name>.ts` naming an api-cloudrun file
 * is BROKEN here — correctly, since core's CI holds no api-cloudrun to resolve
 * it against.
 */
const OWN_TOP_LEVEL = new Set<string>();
for await (const e of Deno.readDir(REPO)) OWN_TOP_LEVEL.add(e.name);

const counts: Record<CitationVerdict, number> = {
  "ok": 0,
  "broken": 0,
  "ambiguous": 0,
  "unverifiable": 0,
  "deleted-ok": 0,
};
let checked = 0, pathOnly = 0;
let narrowed = 0;
const brokenList: string[] = [];
const narrowedList: string[] = [];

for (const doc of await docsToCheck()) {
  let text: string;
  try {
    text = await Deno.readTextFile(doc);
  } catch (e) {
    console.error(`error: cannot read ${doc}: ${e instanceof Error ? e.message : e}`);
    Deno.exit(1);
  }
  const findings: string[] = [];
  const seen = new Set<string>();
  const relDoc = rel(doc);

  for (const m of text.matchAll(CITATION)) {
    const [, path, from, to] = m;
    const key = from === undefined ? path : `${path}:${from}${to ? `-${to}` : ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (from === undefined) pathOnly++;
    checked++;

    // ⚠️ **The exemption is consulted FIRST, before every heuristic.** Steps 2
    // and 4 of {@link classifyCitation} are environment-dependent, so a lookup
    // placed after them is reached on one machine and not another — and the
    // both-directions discharge below then reports "matched NOTHING: the
    // citation is gone" about a citation sitting untouched in the file. An
    // explicit human ruling may not be gated on which repos happen to be cloned.
    const ex = EXEMPT.find((e) => e.file === relDoc && e.path === path);
    if (ex) {
      exemptUsed.add(`${relDoc}::${path}`);
      continue;
    }

    // A gitignored path is a file something WRITES, not one a checkout holds.
    // Repo-specific, so it stays here rather than in the shared rules.
    if (isRuntimeArtifact(path)) {
      counts.unverifiable++;
      findings.push(`  UNVERIFIABLE ${key} — gitignored; a runtime artifact, not a repo path`);
      continue;
    }

    const resolved = resolveSpecifier(path);
    // ⚠️ Narrowed to THIS repo when it holds a candidate — see
    // {@link preferOwnRepo}. Applied before BOTH the ambiguity test and the
    // line-count test: once the citation is read as naming core's file,
    // checking the line number against another repo's same-named file would be
    // answering a different question.
    const beforeNarrowing = resolved.includes("/")
      ? allPaths.filter((f) => f.endsWith(`/${resolved}`))
      : byBasename.get(resolved) ?? [];
    const candidates = preferOwnRepo(beforeNarrowing, `${REPO}/`);

    // ── The narrowing report (api-cloudrun#631) ──────────────────────
    //
    // Narrowing to this repo does not only reduce noise, it MANUFACTURES a
    // confident single answer — see {@link narrowingSuspects}. Where the
    // candidate it threw away lives in a repo the surrounding paragraph
    // explicitly names, that answer is probably wrong, and no other check can
    // see it because the citation resolves perfectly.
    //
    // ⚠️ Counted and printed SEPARATELY, and never added to any failing total:
    // it runs at roughly 3 true positives in 4, which is fine for a list a
    // human skims and would be intolerable in a gate.
    if (candidates.length < beforeNarrowing.length) {
      const discardedRepos = [
        ...new Set(
          beforeNarrowing
            .filter((c) => !candidates.includes(c))
            .map((c) => rel(c).split("/")[0])
            .filter((r) => REPOS.includes(r) && !c0(r)),
        ),
      ];
      const named = narrowingSuspects(discardedRepos, paragraphAround(text, m.index));
      if (named.length) {
        narrowed++;
        narrowedList.push(
          `  ${relDoc}:${text.slice(0, m.index).split("\n").length}  \`${path}\` → ` +
            `resolved to ${candidates.map(rel).join(", ")} · paragraph names ${named.join(", ")}`,
        );
      }
    }

    let lineOutOfRange = false;
    let eofDetail = "";
    if (candidates.length && from !== undefined) {
      const top = Number(to ?? from);
      const lengths = await Promise.all(candidates.map(lineCount));
      lineOutOfRange = !candidates.some((_, i) => top <= lengths[i]);
      if (lineOutOfRange) {
        eofDetail = candidates.map((f, i) => `${rel(f)} has ${lengths[i]}`).join("; ");
      }
    }

    const verdict = classifyCitation({
      resolved,
      candidates,
      presentRepos,
      absentRepos,
      knownRepos: REPOS,
      ownTopLevel: OWN_TOP_LEVEL,
      describesDeletion: describesDeletion(text, m.index),
      lineOutOfRange,
    });
    counts[verdict]++;

    switch (verdict) {
      case "ok":
        break;
      case "broken": {
        const why = lineOutOfRange ? `line past EOF (${eofDetail})` : "no such file";
        findings.push(`  BROKEN     ${key} — ${why}`);
        brokenList.push(`${relDoc}: ${key}${lineOutOfRange ? " (past EOF)" : ""}`);
        break;
      }
      case "ambiguous":
        findings.push(`  AMBIGUOUS  ${key} → ${candidates.map(rel).join("  |  ")}`);
        break;
      case "unverifiable": {
        const why = /node_modules|_dist/.test(resolved)
          ? "build artifact; re-derive from the published package"
          : REPOS.includes(resolved.split("/")[0])
          ? `repo \`${resolved.split("/")[0]}\` is not checked out here`
          : `unresolved, and ${absentRepos.join("/")} not checked out`;
        findings.push(`  UNVERIFIABLE ${key} — ${why}`);
        break;
      }
      case "deleted-ok":
        if (verbose) findings.push(`  DELETED-OK   ${key} — prose says it is gone`);
        break;
    }
  }

  if (findings.length) {
    console.log(`\n${relDoc}`);
    for (const f of findings) console.log(f);
  }
}

// ── Exemption discharge — both directions ───────────────────────────
let exemptionFailures = 0;
for (const e of EXEMPT) {
  const key = `${e.file}::${e.path}`;
  const resolves = allPaths.some((f) => f.endsWith(`/${e.path}`)) ||
    (byBasename.get(e.path)?.length ?? 0) > 0;
  if (resolves) {
    exemptionFailures++;
    console.log(
      `\nexemption ${e.file} -> \`${e.path}\` is OBSOLETE: the path resolves again. Delete it.`,
    );
  } else if (!exemptUsed.has(key)) {
    exemptionFailures++;
    console.log(
      `\nexemption ${e.file} -> \`${e.path}\` matched NOTHING: the citation is gone. Delete it.`,
    );
  }
}

// ⚠️ Printed BEFORE the totals and never summed into them — a separate arm with
// its own count, because it answers a different question at a different
// confidence. See {@link narrowingSuspects}.
if (narrowed) {
  console.log(
    `\nNARROWED — resolved into this repo while the paragraph names another (api-cloudrun#631).\n` +
      `Advisory: roughly 3 in 4 are real. Repo-qualify the citation, or leave it if it is right.`,
  );
  for (const n of narrowedList) console.log(n);
}

console.log(
  `\n${checked} citations checked (${checked - pathOnly} line-numbered, ` +
    `${pathOnly} path-only) — ${counts.broken} broken, ${counts.ambiguous} ambiguous, ` +
    `${counts["deleted-ok"]} deleted-and-said-so, ${counts.unverifiable} unverifiable` +
    (strict ? " (--strict: ambiguous fails)" : ""),
);
console.log(
  `${narrowed} narrowing suspect(s) — advisory, never gating.`,
);
if (absentRepos.length) {
  console.log(
    `Sibling repos not checked out: ${absentRepos.join(", ")} — citations into them are ` +
      `UNVERIFIABLE, not broken.`,
  );
}
if (!memoryIndexed) {
  console.log(
    "Auto-memory notes not found on this machine — citations to them are UNVERIFIABLE.",
  );
}
if (!argFiles.length) {
  // Say what the run covered, every time. A scope this gate does not cover is
  // exactly the thing a green result should not be read as covering.
  console.log(`Scanned: ${SCAN_ROOTS.map((r) => r.path).join(", ")}.`);
  console.log(
    "Not scanned: API.md, API.json — generated deno-doc output, a projection of " +
      "the `src` docstrings already scanned above.",
  );
  if (absentRepos.length) {
    console.log(
      "⚠️ A citation naming an ABSENT repo reports UNVERIFIABLE here and would be " +
        "checkable in a full workspace. Repo-qualify rather than trusting this run " +
        "to have checked it.",
    );
  }
}
if (counts.broken || exemptionFailures || (strict && counts.ambiguous)) {
  if (counts.broken) {
    console.log(`\n${counts.broken} broken citation(s):`);
    for (const b of brokenList) console.log(`  ${b}`);
    console.log(
      "\nFix by repointing the citation, deleting it, or — if the path really is gone —\n" +
        "saying so in the surrounding prose, which is what a reader needs anyway.",
    );
  }
  console.log(
    "⚠️ A citation that resolves may still have drifted off its subject — this cannot see that.",
  );
  Deno.exit(2);
}
Deno.exit(0);
