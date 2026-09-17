/**
 * **`deno task audit:citations` at CI SCOPE** — core alone, no sibling repos (core#106).
 *
 * `audit:citations` run from this workspace sees `api-cloudrun/`, `manager/`,
 * `templates/`, `erp-spec/` and `claude-plugins/` beside us, so a citation naming a
 * sibling's file resolves. **CI checks out core alone**, where `src/`, `scripts/` and
 * `tests/` are core's OWN top-level entries — so an unqualified citation under any of
 * those three directories that really names a SIBLING repo's file is BROKEN there and
 * clean here. (Stated without an example on purpose: see the note on the failure
 * message below — a worked example here is an instance of the defect.)
 *
 * 🔴 **That divergence silently stops the JSR publish, which is why this is a gate and
 * not a docs note.** `.github/workflows/publish.yaml` gates `release` on `needs: ci`,
 * and `ci` runs the audit — so a broken citation skips the publish while presenting as
 * *"a docs commit failed CI"*. It has now cost **five betas across two incidents**:
 * `4674491` + `c391ecc` on 2026-09-10 (core#106), and `2621d14`, `3bcdd8e` + `ec0df30`
 * on 2026-09-17, where a plan doc cited api-cloudrun's charge-window pair audit with a
 * bare `scripts/` prefix and left core unpublishable **by anyone** for three commits,
 * found only when a publish was actually wanted.
 *
 * ⭐ **That path is described rather than spelled, and so is every other example in this
 * file — including the failure message below.** This gate reads its own repo's sources,
 * so writing the offending citation down here would BE the offending citation. It is
 * also why the check gates `git archive HEAD` rather than the working tree, which is
 * what caught it: an uncommitted draft of this file passed while carrying one.
 *
 * ## Two traps, both of which make a correct repo look catastrophically broken
 *
 * 1. 🔴 **The extracted directory MUST be named `core`.** The runner derives the
 *    workspace from the PARENT directory, so extracting to `tmp/x` resolves `WORKSPACE`
 *    to the temp dir and reports ~178 broken — including `src/utils/citations.ts — no
 *    such file` for files plainly present. Same root-resolution shape as manager#385.
 * 2. 🔴 **Do NOT blank `HOME`.** `core/CLAUDE.md`'s recipe carried
 *    `HOME=/tmp/nonexistent` until core#106; it breaks Deno's module cache and the task
 *    dies *before* the audit runs (`Failed resolving binary export …`). **The absent
 *    SIBLINGS are what reproduces CI — a blank HOME is not part of it**, and a run that
 *    dies during setup is not a clean run.
 *
 * ## It gates the COMMITTED tree, deliberately
 *
 * `git archive HEAD` is the subject, not the working tree: CI checks out a commit, so
 * gating anything else would answer a question CI never asks. A citation fixed but not
 * staged therefore still fails here — correctly, since the push would carry the broken
 * one.
 */

const enc = new TextDecoder();

async function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const proc = new Deno.Command(cmd, { args, cwd, stdout: "piped", stderr: "piped" }).spawn();
  const { code, stdout, stderr } = await proc.output();
  return { code, out: enc.decode(stdout) + enc.decode(stderr) };
}

const repoRoot = (await run("git", ["rev-parse", "--show-toplevel"])).out.trim();
if (!repoRoot) {
  console.error("audit:citations:ci — not inside a git repository");
  Deno.exit(1);
}

// Trap 1: the directory has to be called `core`, so make a temp PARENT and put it inside.
const parent = await Deno.makeTempDir({ prefix: "cfs-citations-ci-" });
const lone = `${parent}/core`;
await Deno.mkdir(lone);

try {
  const archive = `${parent}/core.tar`;
  const ar = await run("sh", ["-c", `git -C '${repoRoot}' archive HEAD > '${archive}'`]);
  if (ar.code !== 0) {
    console.error(`audit:citations:ci — could not archive HEAD\n${ar.out}`);
    Deno.exit(1);
  }
  const tar = await run("tar", ["-x", "-f", archive, "-C", lone]);
  if (tar.code !== 0) {
    console.error(`audit:citations:ci — could not extract the archive\n${tar.out}`);
    Deno.exit(1);
  }

  // Trap 2: HOME is inherited on purpose — the absent siblings are the reproduction.
  const audit = await run("deno", ["task", "audit:citations"], lone);
  const checked = audit.out.match(/(\d[\d,]*) citations checked/)?.[1];

  if (audit.code === 0) {
    // ⚠️ A count of zero is a broken runner, not a clean repo — the same fail-vacuous
    // rule the inbound audit and `lint:deployed-enums` follow.
    if (!checked || checked === "0") {
      console.error(
        `audit:citations:ci — the audit exited 0 but reported ${checked ?? "no"} citations.\n` +
          "That is a broken runner, not a clean repo. Output:\n" + audit.out,
      );
      Deno.exit(1);
    }
    console.log(`pre-push: citations (CI scope) — ${checked} checked in a lone checkout, 0 broken`);
    Deno.exit(0);
  }

  console.error(audit.out.trimEnd());
  // ⚠️ **This message names NO example path, and that is not fastidiousness.** The
  // audit scans this repo's own sources, so a backticked path-shaped string HERE is a
  // citation it will then report — and a worked example of the very defect is, by
  // construction, an instance of it. Measured 2026-09-17: a first draft of this block
  // carried two before/after pairs and turned the WORKSPACE-scope audit red with four
  // broken citations that existed only inside this help text. Describe the repair; do
  // not spell it.
  console.error(
    "\n🔴 BROKEN at CI SCOPE while the workspace run is clean — this is the shape that\n" +
      "   SKIPS THE JSR PUBLISH (release needs ci), so it presents as a failed docs\n" +
      "   commit rather than as core not shipping.\n\n" +
      "   Each path above resolves in this workspace because a SIBLING repo is checked\n" +
      "   out beside core, and names nothing in a lone checkout. Prefix each one with\n" +
      "   the repo that owns it, then re-run this task.\n\n" +
      "   ⚠️ Prose ABOUT a citation is itself a citation, so describe the offending path\n" +
      "      rather than restating it — otherwise the repair re-commits the defect. That\n" +
      "      has now happened three times in one day, once in this very message.\n",
  );
  Deno.exit(2);
} finally {
  await Deno.remove(parent, { recursive: true }).catch(() => {});
}
