/**
 * commit-msg gate — two checks on the message, one about its FORMAT and one
 * about whether its TYPE matches what the commit does to the public API.
 *
 * ## 1. Format: the message must parse as a Conventional Commit
 *
 * `core` publishes through **semantic-release** (`.releaserc.json`, the stock
 * `conventionalcommits` preset), not release-please. This check was written for
 * release-please, whose parser silently DROPS an unparseable commit from the
 * release notes (`4615887b`, the #280 fix that vanished from api-cloudrun's
 * v0.109.0 notes). It runs `@conventional-commits/parser`, a PEG grammar that is
 * stricter than the familiar `type(scope): subject` regex. Here it is kept as a
 * conservative format check: a message that passes it has a well-formed header.
 *
 * The construct that bit api-cloudrun was **nested parentheses attached to a
 * word** in the body:
 *
 *     `transaction.get(db.collection("locations"))`   ← does NOT parse
 *     `transaction.get (db.collection("locations"))`  ← parses
 *
 * ## 2. The API surface must not move under a type that does not publish (core#71)
 *
 * 🔴 **Only `feat`, `fix` and `perf` cut a version under the stock preset** (plus
 * any type carrying `!` or a `BREAKING CHANGE:` footer). A `refactor:`, `docs:`,
 * `chore:` or `test:` commit publishes NOTHING, and the Release job goes green
 * anyway. So a commit that adds, removes or re-types an export under one of
 * those types leaves `beta` ahead of JSR with a different public surface, and
 * nothing fails — the consumer's missing import later reads as a slow publish.
 * It happened three times: 895b90c, 97e85d9 and 68beb19 each needed a
 * follow-up `feat` (and 885e35f before them, recovered by amend).
 *
 * The signal is already staged: `pre-commit` regenerates `API.json`, a full
 * snapshot of the exported surface. This check compares the staged copy to
 * HEAD's on the **doc-stripped** fields only — entrypoint, kind, name, and the
 * rendered declaration or signature. ⚠️ **Docstrings are ignored on purpose**:
 * this repo is heavily commented, so a byte diff of `API.json` would refuse
 * nearly every `docs:` commit, and a gate that cries wolf gets bypassed.
 *
 * **The exemption is a footer, stated in the commit**, never a path allowlist:
 *
 *     Internal-API-Change: <why no consumer is affected>
 *
 * ⚠️ **What it cannot see.** `--no-verify` skips it (and `pre-commit` with it).
 * An `--amend` compares against the commit being amended, not its parent, so
 * amending a mistyped commit does not re-judge the original change. And a
 * change to `scripts/generate-api-docs.ts`'s rendering moves every declaration
 * at once — that commit needs the footer. And a worktree runs the MAIN
 * checkout's hooks, so until the main checkout carries the `--allow-run=git`
 * hook, a worktree commit prints a SKIPPED notice instead of checking.
 *
 * ⭐ **Self-verifying**, like `scripts/check-declarations.ts`: every run first
 * plants three cases (an export added under `refactor:`, a docstring-only change
 * under `docs:`, a signature change with a `BREAKING CHANGE:` footer) and the
 * exemption footer, and refuses to judge anything if a plant is misjudged — a
 * broken surface check reports "nothing moved", which is indistinguishable from
 * a clean commit.
 *
 * Replay a past commit with `--api-before=<file> --api-after=<file>` (both
 * `API.json` copies) and the commit's message file as the positional argument.
 */
import { parser } from "@conventional-commits/parser";

/** Messages git generates or that the release tooling ignores. */
const EXEMPT = /^(Merge |Revert |fixup!|squash!|amend!)/;

/** Everything below git's scissors line is commentary, not the message. */
const SCISSORS = /^# -+ >8 -+$/m;

/** Types the `conventionalcommits` preset releases on. */
export const RELEASING_TYPES: ReadonlySet<string> = new Set(["feat", "fix", "perf"]);

/** The footer that states a surface change is deliberately non-releasing. */
export const EXEMPTION_FOOTER = "Internal-API-Change";

/** Strip git's comment lines + scissors block, exactly as git itself does. */
export function cleanMessage(raw: string): string {
  const body = raw.split(SCISSORS)[0];
  return body
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim();
}

// ── The surface ─────────────────────────────────────────────────────

/**
 * `API.json` reduced to what a consumer compiles against: one entry per
 * `<entrypoint> <kind> <name>`, valued by its declaration or signature. Doc
 * fields (`doc`, `paramTags`, `returnsTag`, `moduleDoc`) are dropped.
 *
 * Overloads and duplicate declarations share a key, so their values are joined
 * in file order.
 */
export function apiSurface(api: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const entrypoints = (api as { entrypoints?: unknown })?.entrypoints;
  if (!Array.isArray(entrypoints)) throw new Error("API.json has no `entrypoints` array");
  for (const ep of entrypoints) {
    const name = (ep as { entrypoint?: unknown }).entrypoint;
    const symbols = (ep as { symbols?: unknown }).symbols;
    if (typeof name !== "string" || !Array.isArray(symbols)) {
      throw new Error("API.json entrypoint without `entrypoint`/`symbols`");
    }
    for (const sym of symbols as Record<string, unknown>[]) {
      const key = `${name} ${String(sym.kind)} ${String(sym.name)}`;
      const shape = String(sym.signature ?? sym.declaration ?? sym.declaredKind ?? "");
      out.set(key, out.has(key) ? `${out.get(key)}\n${shape}` : shape);
    }
  }
  return out;
}

export interface SurfaceDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffSurface(before: Map<string, string>, after: Map<string, string>): SurfaceDiff {
  const added = [...after.keys()].filter((k) => !before.has(k)).sort();
  const removed = [...before.keys()].filter((k) => !after.has(k)).sort();
  const changed = [...after.keys()]
    .filter((k) => before.has(k) && before.get(k) !== after.get(k))
    .sort();
  return { added, removed, changed };
}

/** Does this message publish, and if not, does it carry the exemption? */
export function releaseIntent(message: string): {
  type: string | null;
  releases: boolean;
  exempt: boolean;
} {
  const header = /^(?<type>[A-Za-z]+)(?:\([^)]*\))?(?<bang>!)?:/.exec(message);
  const type = header?.groups?.type?.toLowerCase() ?? null;
  const breaking = header?.groups?.bang === "!" || /^BREAKING[ -]CHANGE: /m.test(message);
  const exempt = new RegExp(`^${EXEMPTION_FOOTER}: \\S`, "m").test(message);
  return { type, releases: breaking || (type !== null && RELEASING_TYPES.has(type)), exempt };
}

/**
 * The verdict: `null` when the commit may proceed, else the refusal text.
 */
export function checkSurface(message: string, before: unknown, after: unknown): string | null {
  if (EXEMPT.test(message)) return null;
  const diff = diffSurface(apiSurface(before), apiSurface(after));
  const moved = diff.added.length + diff.removed.length + diff.changed.length;
  if (moved === 0) return null;
  const intent = releaseIntent(message);
  if (intent.releases || intent.exempt) return null;

  const list = (sign: string, keys: string[]) => {
    const shown = keys.slice(0, 15).map((k) => `    ${sign} ${k}`);
    if (keys.length > 15) shown.push(`    … +${keys.length - 15} more`);
    return shown;
  };
  return [
    ``,
    `✗ This commit changes the published API surface, but \`${intent.type ?? "?"}:\` does not publish.`,
    ``,
    `  semantic-release cuts a version only for feat / fix / perf, or a breaking`,
    `  change (\`type!:\` or a \`BREAKING CHANGE:\` footer). Under this type the`,
    `  Release job goes green and JSR does not move. Changed (docstrings ignored):`,
    ``,
    ...list("+", diff.added),
    ...list("-", diff.removed),
    ...list("~", diff.changed),
    ``,
    `  Retype it by what a consumer sees (an export is a \`feat\`), or, if no`,
    `  consumer is affected, say why in a footer:`,
    ``,
    `      ${EXEMPTION_FOOTER}: <reason>`,
    ``,
  ].join("\n");
}

// ── Self-test ───────────────────────────────────────────────────────

const plantedApi = (symbols: Record<string, unknown>[]) => ({
  entrypoints: [{ entrypoint: "@cfs/core/utils/x", moduleDoc: "", symbols }],
});
const BASE = [{ kind: "function", name: "f", signature: "f(a: string): number", doc: "Old." }];

/**
 * The plants core#71 lists, plus the exemption. Returns the misjudged ones;
 * `[]` means the check is working.
 */
export function selfTest(): string[] {
  const cases: Array<[string, string, unknown, boolean]> = [
    [
      "an export added under refactor: must be refused",
      "refactor(x): extract g",
      plantedApi([...BASE, { kind: "function", name: "g", signature: "g(): void", doc: "" }]),
      false,
    ],
    [
      "a docstring-only change under docs: must pass",
      "docs(x): explain f",
      plantedApi([{ ...BASE[0], doc: "New, longer explanation." }]),
      true,
    ],
    [
      "a signature change with a BREAKING CHANGE footer must pass",
      "refactor(x): f takes a number\n\nBREAKING CHANGE: f(a) is now numeric",
      plantedApi([{ ...BASE[0], signature: "f(a: number): number" }]),
      true,
    ],
    [
      "a signature change with the exemption footer must pass",
      `refactor(x): f takes a number\n\n${EXEMPTION_FOOTER}: nothing consumes f yet`,
      plantedApi([{ ...BASE[0], signature: "f(a: number): number" }]),
      true,
    ],
    [
      "a signature change under chore: must be refused",
      "chore(x): f takes a number",
      plantedApi([{ ...BASE[0], signature: "f(a: number): number" }]),
      false,
    ],
  ];
  return cases
    .filter(([, msg, after, passes]) => (checkSurface(msg, plantedApi(BASE), after) === null) !== passes)
    .map(([name]) => name);
}

// ── Main ────────────────────────────────────────────────────────────

function gitShow(spec: string): string | null {
  const out = new Deno.Command("git", { args: ["show", spec], stdout: "piped", stderr: "null" })
    .outputSync();
  return out.success ? new TextDecoder().decode(out.stdout) : null;
}

function flag(name: string): string | undefined {
  const hit = Deno.args.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function main(): number {
  const path = Deno.args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("check-commit-msg: expected a commit-message file path");
    return 2;
  }

  const message = cleanMessage(Deno.readTextFileSync(path));
  if (!message) return 0; // empty message — git aborts on its own
  if (EXEMPT.test(message)) return 0;

  try {
    parser(message);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`
✗ This commit message does not parse as a Conventional Commit.

  Parser error:
${reason.split("\n").map((l) => "    " + l).join("\n")}

  Most common cause: nested parentheses attached to a word, e.g.
      transaction.get(db.collection("locations"))
  Add a space before the outer paren, or drop the inner call:
      transaction.get (db.collection("locations"))
`);
    return 1;
  }

  const broken = selfTest();
  if (broken.length > 0) {
    console.error(
      `✗ check-commit-msg's API-surface check is broken — it misjudged its own plants:\n` +
        broken.map((b) => `    ${b}`).join("\n") +
        `\n  Fix scripts/check-commit-msg.ts before committing; it cannot be trusted to judge this one.`,
    );
    return 1;
  }

  // Staged = the index this commit is being built from (`GIT_INDEX_FILE` is
  // inherited, so a pathspec commit's temporary index is the one read).
  const beforePath = flag("api-before");
  const afterPath = flag("api-after");

  // ⚠️ A worktree runs the MAIN checkout's `.githooks/` (a relative
  // `core.hooksPath` resolves there), so an older hook granting only
  // `--allow-read` can invoke this newer script. Say so and skip the surface
  // check rather than crash every commit; never report it as a pass.
  if (
    (!beforePath || !afterPath) &&
    Deno.permissions.querySync({ name: "run", command: "git" }).state !== "granted"
  ) {
    console.error(
      "check-commit-msg: API-surface check SKIPPED — this hook does not grant " +
        "--allow-run=git (an older .githooks/commit-msg is running). Not verified.",
    );
    return 0;
  }
  const beforeText = beforePath ? Deno.readTextFileSync(beforePath) : gitShow("HEAD:API.json");
  const afterText = afterPath ? Deno.readTextFileSync(afterPath) : gitShow(":API.json");
  // No HEAD (first commit) or no API.json on one side: nothing to compare.
  if (beforeText === null || afterText === null) return 0;

  const refusal = checkSurface(message, JSON.parse(beforeText), JSON.parse(afterText));
  if (refusal) {
    console.error(refusal);
    return 1;
  }
  return 0;
}

if (import.meta.main) Deno.exit(main());
