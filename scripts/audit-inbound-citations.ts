/**
 * Inbound citation audit — the direction no repo's own audit covers.
 *
 * 🔴 A citation audit checks the citations a repo OWNS, pointing OUTWARD.
 * **Nothing checks citations pointing IN.** So a rename or deletion here leaves
 * this repo's audit green — correctly, it repointed everything it owns — while
 * sibling repos that cite the old path go RED, and their pre-commit and pre-push
 * break for every session in those checkouts.
 *
 * **The repo whose gate breaks is never the repo whose commit broke it.** The
 * author gets no signal, and the victim has no reason to suspect a rename
 * elsewhere.
 *
 * Measured 2026-09-05, from ONE rename: `manager` relocating its unit suite from
 * `src/**‍/__tests__/` to `tests/` left **11 broken citations in this repo and 2
 * in `core`** — both gates red, found hours apart by two sessions arriving at a
 * blocked commit. Manager's own audit was green throughout. Inbound counts at
 * that moment: api-cloudrun 423, core 292, manager 203, templates 55.
 *
 * ⚠️ **CI can never catch this class**, which is why it is a local gate: each
 * workflow checks out ONE repo, so a sibling citation resolves to nothing and
 * reports UNVERIFIABLE rather than BROKEN. A green CI run is not evidence.
 *
 * ⭐ **Three states, not two.** Fewer than two sibling repos present reports
 * SKIPPED and exits 0 — never "0 broken". A lone-repo checkout is legitimate and
 * must not fail, but a check that could not run must never read as one that
 * passed, which is the same trap this whole guard is about.
 *
 * ⚠️ **This file is deliberately byte-identical across `manager`,
 * `api-cloudrun`, `core` and `templates` except for ONE line — the
 * `@cfs/core/utils/citations` import, which `core` takes relatively because it
 * IS core.** A `diff` between any two copies should show only that. The rules
 * themselves are shared rather than re-implemented; this workspace has already
 * paid for the same walk existing in three places and needing the same repair
 * three times. Consolidating the whole script into `@cfs/core` is the natural
 * next step and wants a publish, so it did not happen here.
 *
 * Usage:  deno run --allow-read scripts/audit-inbound-citations.ts [--verbose]
 * Exit:   0 clean or skipped · 1 collapsed corpus · 2 broken inbound citations.
 */
// ⚠️ THE one line that differs from the other three copies: core cannot import
// itself from JSR, so it takes the rules relatively. Everything else is
// byte-identical by intent — a `diff` against any sibling copy should show only
// this import.
import { CITATION, describesDeletion, isHistoryDoc, mainRepoFromGitFile } from "../src/utils/citations.ts";
import { promises as fs } from "node:fs";
import path from "node:path";

const verbose = Deno.args.includes("--verbose");

// ⚠️ Derived from the `.git` FILE, not from `Deno.cwd()`. Run from inside a
// worktree — which `api-cloudrun`'s gate ALWAYS is, since it materializes the
// pushed subject in `$TMPDIR/cfs-gate-<repo>-<pid>` — a cwd-derived root
// resolves the workspace to somewhere with no siblings, and the check reports
// SKIPPED on every push. Same fix manager#385 made to the outward scanners.
const MAIN_REPO: string = await (async () => {
  const dotGit = path.join(Deno.cwd(), ".git");
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isFile()) {
      const resolved = mainRepoFromGitFile(await fs.readFile(dotGit, "utf8"));
      if (resolved) return resolved;
    }
  } catch { /* not a worktree */ }
  return Deno.cwd();
})();

const WORKSPACE = path.dirname(MAIN_REPO);
const OWN_REPO = path.basename(MAIN_REPO);
const SIBLINGS = ["core", "api-cloudrun", "manager", "templates", "erp-spec", "claude-plugins"]
  .filter((r) => r !== OWN_REPO);

/** The union of what the four repos' own audits scan. */
const ROOTS: Array<{ p: string; exts: string[] }> = [
  { p: "CLAUDE.md", exts: [".md"] },
  { p: "README.md", exts: [".md"] },
  { p: ".claude", exts: [".md"] },
  { p: "docs", exts: [".md"] },
  { p: "src", exts: [".ts", ".tsx", ".css"] },
  { p: "scripts", exts: [".ts", ".mjs", ".md"] },
  { p: "tests", exts: [".ts", ".tsx", ".md"] },
  { p: "e2e", exts: [".ts", ".md"] },
  { p: "infra", exts: [".tf", ".md"] },
  { p: "plugins", exts: [".md", ".ts", ".mjs"] },
  { p: ".github", exts: [".yaml", ".yml", ".md"] },
];
const SKIP = new Set(["node_modules", ".git", "dist", "worktrees", "coverage", "test-results"]);

/**
 * Citations that LOOK repo-qualified and are not.
 *
 * 🔴 One repo is named `templates`, and every repo has a `templates/` content
 * prefix — so `templates/quote.meta.json` is ambiguous by construction. Both
 * entries below are **content-map keys** inside a `.describe()` string (the key
 * naming a file within a template version's stored content map), not paths in
 * the `templates` repo. The prose around each says so.
 *
 * ⚠️ Kept as data rather than solved structurally on purpose: no syntactic rule
 * separates "a path in the repo named templates" from "a key beginning
 * templates/" — only the surrounding prose does. An exemption a human wrote and
 * signed beats a heuristic that would silently drop one of the two classes.
 *
 * Fails in BOTH directions: an entry that stops matching is reported, so this
 * list cannot rot into a permanent excuse.
 */
const EXEMPT: Array<{ from: string; cited: string; why: string }> = [
  {
    from: "api-cloudrun/src/routes/templates.ts",
    cited: "templates/quote.meta.json",
    why: "a content-map KEY in the MCP tool's own description, not a repo path",
  },
  {
    from: "api-cloudrun/scripts/seed-quote-template.ts",
    cited: "templates/quote.meta.json",
    why: "same content-map key, named in the seeding script's header",
  },
];
const exemptUsed = new Set<string>();

/**
 * This scanner, excluded from its own scan.
 *
 * ⚠️ Its EXEMPT list necessarily CONTAINS the citation-shaped strings it exempts,
 * so without this every copy reports its own allowlist as broken — and the copies
 * report each OTHER, which is how this surfaced. Same reason
 * `tests/utils/typeEscapes.test.ts` excludes itself: a scanner that quotes what
 * it looks for will always find itself.
 *
 * Both spellings, because `manager` runs the Node copy and the Deno repos run
 * this one, and each must skip the other's file as well as its own.
 */
const SELF = new Set(["audit-inbound-citations.ts", "lint-citations-inbound.mjs"]);

async function* filesUnder(dir: string, exts: string[]): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* filesUnder(p, exts);
    else if (exts.some((x) => e.name.endsWith(x))) yield p;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const broken: string[] = [];
let inbound = 0;
const presentSiblings: string[] = [];

for (const sibling of SIBLINGS) {
  const repoDir = path.join(WORKSPACE, sibling);
  if (!(await exists(repoDir))) continue;
  presentSiblings.push(sibling);

  for (const root of ROOTS) {
    const abs = path.join(repoDir, root.p);
    if (!(await exists(abs))) continue;
    const files: string[] = root.p.endsWith(".md") ? [abs] : [];
    if (files.length === 0) for await (const f of filesUnder(abs, root.exts)) files.push(f);

    for (const file of files) {
      // A history doc is ALLOWED to name a path that no longer exists — that is
      // what makes it history. The outward audits give the same courtesy.
      if (isHistoryDoc(file)) continue;
      if (SELF.has(path.basename(file))) continue;
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(CITATION)) {
        const cited = m[1];
        if (!cited.startsWith(`${OWN_REPO}/`)) continue;
        inbound++;
        if (await exists(path.join(WORKSPACE, cited))) continue;
        // Prose that says the path is gone is a statement, not a stale citation.
        if (describesDeletion(text, m.index ?? 0)) continue;
        const citingRel = `${sibling}/${path.relative(repoDir, file)}`;
        const ex = EXEMPT.find((e) => e.from === citingRel && e.cited === cited);
        if (ex) {
          exemptUsed.add(`${ex.from}::${ex.cited}`);
          continue;
        }
        const line = text.slice(0, m.index ?? 0).split("\n").length;
        broken.push(`  ${citingRel}:${line}  ${cited}`);
      }
    }
  }
}

// 🔴 THREE states. A lone-repo checkout is legitimate — CI is one, by
// construction — so "no siblings" must not FAIL, or the guard is unusable there.
// But it must not report "0 broken" either: a check that cannot run reading as a
// check that passed is the exact trap this file is about.
if (presentSiblings.length < 2) {
  console.log(
    `citations-inbound: SKIPPED — ${presentSiblings.length} sibling repo(s) under ${WORKSPACE}, need 2.\n` +
      `  This checks OTHER repos' citations INTO ${OWN_REPO}/, so it needs them checked out.\n` +
      `  Not a pass: nothing was verified. A CI job checks out one repo and can never run it.`,
  );
  Deno.exit(0);
}

// "0 broken" is what a clean workspace reports AND what a scan of nothing
// reports. This guard needs the floor more than most, because it walks OTHER
// repos and so degrades silently the moment they are not where it expects.
if (inbound < 5) {
  console.error(
    `\n✗ citations-inbound: only ${inbound} citation(s) into ${OWN_REPO}/ found across ` +
      `${presentSiblings.join(", ")}.\n` +
      `  The corpus collapsed — check ROOTS and the CITATION import before trusting this.`,
  );
  Deno.exit(1);
}

// An exemption that no longer matches anything is a stale excuse — it may be
// masking a citation that has since moved. Both directions, same rule as every
// other allowlist in this workspace.
// ⚠️ Scoped to exemptions RELEVANT to this repo. `EXEMPT` is shared across four
// byte-identical copies, but an entry only ever fires in the ONE repo whose name
// the cited path starts with — so an unscoped staleness check reports every
// other repo's entries as dead on every run. Found immediately: the two
// `templates/` entries reported stale from `core` and `api-cloudrun`, which never
// see them.
const staleExemptions = EXEMPT
  .filter((e) => e.cited.startsWith(`${OWN_REPO}/`))
  .filter((e) => !exemptUsed.has(`${e.from}::${e.cited}`));
if (staleExemptions.length > 0 && presentSiblings.length >= 2) {
  console.error(
    `\n✗ citations-inbound: ${staleExemptions.length} exemption(s) matched nothing:\n` +
      staleExemptions.map((e) => `  ${e.from} -> ${e.cited}  (${e.why})`).join("\n") +
      `\n  Either the citation moved or the exemption is obsolete. Remove it or repoint it.`,
  );
  Deno.exit(1);
}

if (broken.length > 0) {
  console.error(`\n✗ ${broken.length} sibling citation(s) into ${OWN_REPO}/ no longer resolve:\n`);
  for (const b of broken) console.error(b);
  console.error(
    `\nThese break the CITING repo's gate, not this one — its pre-commit and pre-push\n` +
      `will fail for every session in that checkout, with no hint that the cause is here.\n` +
      `Repoint them in that repo (or say in the prose that the path is gone) before pushing.`,
  );
  Deno.exit(2);
}

console.log(
  `citations-inbound: ${inbound} citation(s) into ${OWN_REPO}/ from ` +
    `${presentSiblings.join(", ")} — 0 broken`,
);
if (verbose) console.log(`  workspace: ${WORKSPACE}`);
