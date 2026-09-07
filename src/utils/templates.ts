/**
 * Template helpers for the git-canonical template system — pure functions
 * shared by api-cloudrun and manager.
 *
 * - `slugify` derives a `git_path` from a family display name (frozen at create).
 * - `deriveBump` maps a conventional-commit type → semver bump level, and
 *   `bumpSemver` applies that bump to the family's previous version.
 * - `resolveRenderParams` validates caller-provided render params against the
 *   version's declared params **strictly** — unknown params throw (the API
 *   maps `RenderParamError` → HTTP 422).
 *
 * **No RUNTIME dependency on `@cfs/core/schemas`.** Two different techniques keep
 * it that way, and which one applies depends on what is needed:
 *
 * - A shape a caller passes in is accepted **structurally** — `RenderParamDecl`
 *   is declared here rather than imported, and `@cfs/core/schemas`'
 *   `TemplateParam` is structurally compatible with it.
 * - A closed union that must be named exactly is `import type`, which is erased
 *   at emit and so costs a bundle nothing. `GoldenDiffVerdict` below is the one
 *   such import.
 *
 * ⚠️ **What must never appear here is a runtime VALUE import from the schemas.**
 * `GOLDEN_DIFF_VERDICTS` is the tempting one — the union's own member array —
 * and importing it would pull the schema barrel and all of zod into every
 * consumer that wanted a path helper. If a member list is ever needed at
 * runtime, restate it locally or put the function somewhere else.
 *
 * @module
 */

import type { GoldenDiffVerdict } from "../schemas/template-version.ts";

// ── Git-canonical paths (fixtures + goldens) ────────────────────────
//
// Shared path helpers so the api-cloudrun golden-diff, the affected-set
// classifier, the rebless script, and the manager all agree on where
// fixtures and goldens live in the templates repo. No DEFAULT_FIXTURE_PATH
// — a template with zero fixtures emits a `no-fixtures` golden verdict
// rather than rendering a wrong-shaped fallback.

/** Directory holding a template family's fixtures: `fixtures/<git_path>/`. */
export function fixtureDir(gitPath: string): string {
  return `fixtures/${gitPath}/`;
}

/** Path to one fixture: `fixtures/<git_path>/<slug>.json`. */
export function fixturePath(gitPath: string, slug: string): string {
  return `fixtures/${gitPath}/${slug}.json`;
}

/** Path to one branch-keyed golden: `goldens/<branch>/<git_path>/<slug>.png`. */
export function goldenPath(branch: string, gitPath: string, slug: string): string {
  return `goldens/${branch}/${gitPath}/${slug}.png`;
}

// ── Render frames (the header/footer goldens) ───────────────────────

/**
 * The PDF render frames a family may declare in its sidecar's `render` block.
 *
 * A frame is an ISOLATED Chromium document — Gotenberg renders `header.html`
 * and `footer.html` in their own frames, loading no external resources at all —
 * so it is a second render surface the body's golden says nothing about. The
 * customer-facing quote footer rendered in Times for as long as it existed and
 * `visual-diff` read `match` throughout (templates#137, #139).
 *
 * ⚠️ **Order is the SLUG order the goldens sort in, not a priority.** Nothing
 * reads this array positionally.
 */
export const GOLDEN_FRAMES = ["footer", "header"] as const;

/** One of {@link GOLDEN_FRAMES}. */
export type GoldenFrame = typeof GOLDEN_FRAMES[number];

/**
 * The reserved golden slug for a render frame: `_footer` / `_header`.
 *
 * 🔴 **The leading underscore is what keeps the frame goldens and the fixture
 * goldens in ONE flat directory without a collision, and it is load-bearing in
 * both directions.** `goldenTreesForFamily` and `lint-fixtures.ts` both list
 * `goldens/<branch>/<gp>/*.png` and strip the extension, so a frame baseline
 * arrives in the same `slugs` array a fixture baseline does; check 4 in
 * `template-lint.ts` partitions them back apart with {@link parseGoldenFrameSlug}
 * rather than by asking the filesystem twice.
 *
 * ⚠️ **A fixture may not take one of these names**, and check 4 says so —
 * otherwise the two arms fight over one file: the fixture arm would call the
 * frame baseline its own and the frame arm would call it orphaned.
 *
 * ⭐ **ONE golden per FAMILY, not per fixture — and that is a MEASUREMENT, not a
 * convention.** api-cloudrun#608 settled that a golden's filename may encode
 * only what is DERIVABLE from the family's own declaration, which makes a
 * per-fixture `<slug>.footer.png` legal. It is not USEFUL: measured 2026-09-07,
 * all four registered families declare the same `partials/shared/footer.eta` and
 * that partial interpolates **zero `it.*`** — it is a static FEIN line, link,
 * email and phone plus Chromium's own `.pageNumber`/`.totalPages` spans. Its
 * only per-family variance is the overlay stylesheet's root font-size. So a
 * per-fixture name would mint 24 byte-identical images per branch and gate
 * nothing the 4 do not. ⚠️ **If a frame partial ever reads `it.doc`, this
 * decision expires** — re-read that partial before assuming it still holds.
 */
export function goldenFrameSlug(frame: GoldenFrame): string {
  return `_${frame}`;
}

/** Path to one branch-keyed frame golden: `goldens/<branch>/<git_path>/_footer.png`. */
export function goldenFramePath(branch: string, gitPath: string, frame: GoldenFrame): string {
  return goldenPath(branch, gitPath, goldenFrameSlug(frame));
}

/**
 * The frame a golden slug names, or `null` when it is an ordinary fixture slug.
 *
 * Total over every string, because it is the PARTITION check 4 splits a golden
 * tree with: a slug this returns `null` for is a fixture baseline, and one it
 * names is a frame baseline. An unknown underscore-prefixed slug (`_banner`)
 * is therefore a FIXTURE slug and reports as orphaned, which is the safe
 * direction — a name nothing renders should be noticed, not silently exempted.
 */
export function parseGoldenFrameSlug(slug: string): GoldenFrame | null {
  return GOLDEN_FRAMES.find((f) => goldenFrameSlug(f) === slug) ?? null;
}

/**
 * Does this string OPEN as a full HTML document?
 *
 * ⚠️ Deliberately anchored, because the obvious test is wrong. Matching
 * `/<head[^>]*>/` anywhere treats ANY occurrence of the text — in a CSS
 * comment, in prose, in an attribute value — as the document's own head, and
 * splices the whole injected block there. That is not hypothetical: a comment
 * in `partials/shared/footer.eta` mentioning the tag by name took ~26 KB of
 * overlay CSS *into the middle of that comment*, which closed the `<style>`
 * early and rendered the rest of the stylesheet as visible body text in the
 * PDF. The blast radius grew with the overlay: the payload used to be one short
 * rule and is now the document's entire stylesheet.
 *
 * A part partial is a FRAGMENT in every case we generate, so the safe reading
 * is: only trust a `<head>` when the string genuinely opens as a document.
 */
const DOCUMENT_PROLOGUE = /^\s*(?:<!--[\s\S]*?-->\s*|<!doctype[^>]*>\s*)*<html[\s>]/i;

/**
 * Chromium's own default print margin, in inches, applied when no
 * `marginLeft`/`marginRight` is sent.
 *
 * ⭐ **It lives beside {@link injectPartDefaults} and is that function's own
 * fallback, so no caller restates it.** It is an EXTERNAL constant — a fact
 * about Chromium, not a CFS policy — and the three callers are in two repos,
 * which is exactly the shape that gets copied and then drifts. The first
 * version of the templates preview harness needed this number and could not
 * import it, which is what surfaced the question.
 *
 * ⚠️ A caller that KNOWS the family's declared margins should still pass them:
 * the default is what to do in their absence, not a substitute for reading
 * them. All four registered families declare `margin_left`/`margin_right`
 * today, so this fallback is unreachable for them.
 */
export const CHROMIUM_DEFAULT_MARGIN_IN = 0.39;

/**
 * Wrap a header/footer partial in the document Chromium renders in the PDF's
 * print frame — the page's overlay stylesheet as a start-of-head DEFAULT, then
 * the geometry that must win.
 *
 * 🔴 **THREE surfaces render this frame and they must agree byte for byte.**
 * It lives in core because each of them is in a different repo:
 *
 * | consumer | what it does with the frame |
 * |---|---|
 * | `api-cloudrun`'s Gotenberg convert | ships it to the customer as `footer.html` |
 * | `api-cloudrun`'s golden gate | screenshots it as `goldens/<branch>/<gp>/_footer.png` |
 * | `templates`' `deno task preview` | shows it to the author |
 *
 * Any one of them assembling the frame its own way produces a picture nobody
 * receives. The gate would agree with its own baseline and disagree with the
 * PDF; the preview harness DID exactly that and its `<style>` leaked onto the
 * whole preview, so an author's local check disagreed with both.
 *
 * 🔴 **The injection ORDER is load-bearing and is not expressible as two
 * calls.** Each injection inserts immediately after `<head>`, so a second one
 * would land EARLIEST and lose the cascade. The overlay is a default the
 * partial may override; the geometry is not. One `<style>` block, overlay
 * first — and `api-cloudrun/tests/unit/gotenberg.test.ts` asserts that ordering
 * rather than leaving it to this comment.
 *
 * ⚠️ Padding on a full-width body, never `margin`: Chromium's print
 * header/footer frame lets a `width:100%` child escape a margined body.
 *
 * @param html The rendered partial — a fragment in every case we generate.
 * @param opts `styles` is the page's concatenated overlay; `left`/`right` are
 *   the page's horizontal margins in INCHES, so the frame aligns with the body.
 *   Both DEFAULT to {@link CHROMIUM_DEFAULT_MARGIN_IN} — see that constant for
 *   why the function owns the fallback rather than each caller.
 */
export function injectPartDefaults(
  html: string,
  opts: { styles?: string; left?: number; right?: number },
): string {
  const overlay = opts.styles ? `${opts.styles}\n` : "";
  const left = opts.left ?? CHROMIUM_DEFAULT_MARGIN_IN;
  const right = opts.right ?? CHROMIUM_DEFAULT_MARGIN_IN;
  const geometry =
    `html,body{margin:0;width:100%;box-sizing:border-box}body{padding:0 ${right}in 0 ${left}in}`;
  const style = `<style>${overlay}${geometry}</style>`;
  if (DOCUMENT_PROLOGUE.test(html)) {
    // A real document. Inject after its own <head>, or open one right after
    // <html> when it has none (legal HTML — the parser implies the head).
    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head[^>]*>/i, (m) => `${m}${style}`);
    }
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${style}</head>`);
  }
  return `<!DOCTYPE html><html><head>${style}</head><body>${html}</body></html>`;
}

/**
 * Parse a fixture path back to `{ gitPath, slug }`. Returns `null` for any
 * path that isn't of the form `fixtures/<gp>/<slug>.json`. The affected-set
 * classifier consumes this to route fixture-only PR changes into the
 * `goldenOnly` bucket (golden re-run, no version bump).
 */
export function parseFixturePath(path: string): { gitPath: string; slug: string } | null {
  if (!path.startsWith("fixtures/") || !path.endsWith(".json")) return null;
  const inner = path.slice("fixtures/".length, -".json".length);
  const slashIndex = inner.indexOf("/");
  if (slashIndex < 0) return null;
  const gitPath = inner.slice(0, slashIndex);
  const slug = inner.slice(slashIndex + 1);
  if (!gitPath || !slug || slug.includes("/")) return null;
  return { gitPath, slug };
}

// ── slugify ─────────────────────────────────────────────────────────

/**
 * Derive a URL/git-safe slug from a display name. Lowercases, replaces every
 * run of non-alphanumeric characters with a single hyphen, and trims leading/
 * trailing hyphens. Two distinct display names can collapse to the same slug
 * (e.g. "Quote!" and "quote") — callers enforce slug uniqueness at create.
 *
 * ```ts
 * slugify("Packing List (v2)"); // "packing-list-v2"
 * ```
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── semver bump ─────────────────────────────────────────────────────

/** A semantic-version bump level. */
export type BumpLevel = "major" | "minor" | "patch";

/**
 * Map a conventional-commit type + breaking flag to a semver bump level.
 * Breaking always wins (`major`). `feat` → `minor`. Everything else
 * (`fix`, `refactor`, `chore`, `docs`, …) → `patch`.
 */
export function deriveBump(type: string, breaking: boolean): BumpLevel {
  if (breaking) return "major";
  if (type.toLowerCase() === "feat") return "minor";
  return "patch";
}

/**
 * Apply a bump level to a `MAJOR.MINOR.PATCH` semver string. A missing/invalid
 * `current` is treated as `0.0.0` (so the first publish off `deriveBump` yields
 * `1.0.0` for a major, `0.1.0` for a minor, `0.0.1` for a patch).
 */
export function bumpSemver(current: string | null | undefined, bump: BumpLevel): string {
  const [major = 0, minor = 0, patch = 0] = (current ?? "0.0.0")
    .split(".")
    .map((n) => {
      const v = Number.parseInt(n, 10);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    });
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

// ── content fingerprint (dirty-since-commit guard) ──────────────────

/**
 * Order-independent fingerprint of a template/component content map
 * (path → file text). The API stamps a version's `committed_content_hash` with
 * this when it pushes content to git (commit / release); the manager hashes the
 * live draft content the same way to detect "dirty since last commit" and warn
 * at approve-to-merge.
 *
 * Pure, synchronous, and runtime-agnostic (Deno + browser) so both sides agree
 * byte-for-byte. A non-cryptographic 64-bit FNV-1a digest (two seeded streams):
 * collision resistance is irrelevant here — it only answers "did the content
 * change since the last push?".
 *
 * ```ts
 * hashTemplateContent({ "a.eta": "x" }) === hashTemplateContent({ "a.eta": "x" }); // true
 * ```
 */
export function hashTemplateContent(content: Record<string, string>): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc59d1c81;
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x01000193);
    }
  };
  // Sort keys so the digest ignores insertion order. Length-prefix each token
  // so the stream is injective without in-band delimiter bytes: {"ab":"c"}
  // ("2:ab1:c") differs from {"a":"bc"} ("1:a2:bc").
  for (const key of Object.keys(content).sort()) {
    mix(`${key.length}:${key}${content[key].length}:${content[key]}`);
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2);
}

// ── render params ───────────────────────────────────────────────────

/** A render-time parameter declaration (structurally `@cfs/core/schemas`' `TemplateParam`). */
export interface RenderParamDecl {
  key: string;
  /** v1 supports `"boolean"` only. */
  type: string;
  label?: string;
  default?: boolean;
  required?: boolean;
}

/** Thrown when caller-provided render params fail strict validation. The API maps this to HTTP 422. */
export class RenderParamError extends Error {
  readonly status = 422;
  readonly code = "invalid_render_params";
  constructor(message: string) {
    super(message);
    this.name = "RenderParamError";
  }
}

/**
 * Resolve caller-provided render params against a version's declared params,
 * **strictly**:
 * - any provided key not declared → throw `RenderParamError`;
 * - a provided value of the wrong type → throw;
 * - a declared param absent from input → its `default` (or `false` for a
 *   boolean with no default), unless `required` with no default → throw.
 *
 * Returns a fully-resolved param map safe to hand to the render context.
 */
export function resolveRenderParams(
  declared: readonly RenderParamDecl[],
  provided: Record<string, unknown> | undefined,
): Record<string, boolean> {
  const input = provided ?? {};
  const declaredByKey = new Map(declared.map((d) => [d.key, d]));

  const unknown = Object.keys(input).filter((k) => !declaredByKey.has(k));
  if (unknown.length > 0) {
    throw new RenderParamError(`unknown render param(s): ${unknown.sort().join(", ")}`);
  }

  const resolved: Record<string, boolean> = {};
  for (const decl of declared) {
    const has = Object.prototype.hasOwnProperty.call(input, decl.key);
    if (has) {
      const value = input[decl.key];
      if (typeof value !== "boolean") {
        throw new RenderParamError(`render param "${decl.key}" must be a boolean`);
      }
      resolved[decl.key] = value;
    } else if (decl.default !== undefined) {
      resolved[decl.key] = decl.default;
    } else if (decl.required) {
      throw new RenderParamError(`missing required render param "${decl.key}"`);
    } else {
      resolved[decl.key] = false;
    }
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fork field-mapping helpers (Part 5: start-from-existing). Pure + advisory: the
// fork preview/rewrite are a head-start for switching a template's source doc
// (e.g. order → invoice), NOT a guarantee. The operator finishes in the editor.
// ─────────────────────────────────────────────────────────────────────────────

/** A path segment: a word, optionally followed by one or more `[]` array marks. */
const SEGMENT_RE = /^([A-Za-z_$][\w$]*)((?:\[\])*)$/;

/**
 * Distinct `it.doc.<path>` references across a content map, with array indices
 * normalized (`it.doc.items[0].name` → `items[].name`) so paths match the
 * `templateSchemaFields` catalog. Sorted, deduped.
 *
 * BEST-EFFORT — does NOT catch loop-aliased refs (`it.doc.items.forEach(i =>
 * i.name)`) or optional chaining. Most line-item fields are loop-aliased, which
 * is exactly where order/invoice schemas diverge, so treat the result as a
 * head-start, never a complete list.
 */
export function scanDocFieldRefs(content: Record<string, string>): string[] {
  const re = /it\.doc((?:\.[A-Za-z_$][\w$]*|\[\d+\])+)/g;
  const found = new Set<string>();
  for (const src of Object.values(content)) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let raw = m[1];
      // A trailing segment immediately followed by "(" is a method call
      // (`.forEach`, `.map`, …), not a field — drop it.
      if (src[re.lastIndex] === "(") raw = raw.replace(/\.[A-Za-z_$][\w$]*$/, "");
      const path = raw.replace(/^\./, "").replace(/\[\d+\]/g, "[]");
      if (path) found.add(path);
    }
  }
  return [...found].sort();
}

/** Build a regex matching `it.doc.<from>`, capturing each concrete array index. */
function fromPathToRegex(from: string): RegExp {
  let pat = "it\\.doc";
  for (const part of from.split(".")) {
    const m = part.match(SEGMENT_RE);
    const word = m ? m[1] : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pat += "\\." + word;
    const brackets = m ? m[2].length / 2 : 0;
    for (let b = 0; b < brackets; b++) pat += "(\\[\\d+\\])";
  }
  return new RegExp(pat, "g");
}

/** Build the `it.doc.<to>` replacement, reusing captured indices ($1, $2, …)
 * positionally; surplus `to` array marks (beyond what `from` captured) → `[0]`. */
function toPathToReplacement(to: string, fromBracketCount: number): string {
  let rep = "it.doc";
  let group = 1;
  for (const part of to.split(".")) {
    const m = part.match(SEGMENT_RE);
    rep += "." + (m ? m[1] : part);
    const brackets = m ? m[2].length / 2 : 0;
    for (let b = 0; b < brackets; b++) rep += group <= fromBracketCount ? `$${group++}` : "[0]";
  }
  return rep;
}

const bracketCount = (path: string): number => (path.match(/\[\]/g) ?? []).length;

/**
 * Rewrite `it.doc.<from>` → `it.doc.<to>` across a content map per `fieldMap`
 * (normalized paths from `scanDocFieldRefs`). Entries mapped to `null` (or to
 * themselves) are left untouched — the operator resolves those by hand. Array
 * indices are preserved (`items[0].name` with map `items[].name`→`lines[].name`
 * becomes `lines[0].name`). Longest `from` rewritten first so a nested path is
 * handled before its prefix.
 */
export function rewriteDocFieldRefs(
  content: Record<string, string>,
  fieldMap: Record<string, string | null>,
): Record<string, string> {
  const rules = Object.entries(fieldMap)
    .filter((e): e is [string, string] => e[1] != null && e[1] !== e[0])
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => ({ re: fromPathToRegex(from), replacement: toPathToReplacement(to, bracketCount(from)) }));
  const out: Record<string, string> = {};
  for (const [key, src] of Object.entries(content)) {
    let next = src;
    for (const { re, replacement } of rules) next = next.replace(re, replacement);
    out[key] = next;
  }
  return out;
}

// ── Golden-diff aggregation ─────────────────────────────────────────
//
// One template family renders N fixtures, each producing its own verdict. Both
// the API (which computes them) and the manager (which renders them) have to
// roll those up to a single family verdict, and both used to do it with their
// own copy of the precedence — `aggregateVerdict` in api-cloudrun and
// `aggregateGolden` in manager. The manager's docstring asserted *"precedence
// mirrors the API's `aggregateVerdict`"*, which is a claim about another repo
// that nothing checked. It is one function now (core#68).
//
/**
 * The `fixture` value of the family-level "this family has no fixtures" row.
 *
 * ⚠️ **This is a wire contract between two repos, and it was a bare `"_"`
 * literal on one side of it.** When a family has zero fixtures the API
 * short-circuits before any fan-out and persists a single synthetic result
 * carrying this value, because `golden_results` cannot be empty and still say
 * *why*. The manager then reads it back: its `no-fixtures` verdict arm and its
 * slug map both depend on recognising it. Change it on one side only and the
 * manager renders a fixture literally named `_` and reports `match` where it
 * should report `no-fixtures` — with nothing failing on either side.
 *
 * ⚠️ **Nothing structurally prevents a collision** — `parseFixturePath` parses
 * `fixtures/<gp>/_.json` into the slug `"_"` quite happily, so a fixture
 * literally named `_` would be indistinguishable from the sentinel. That is a
 * convention, not an invariant, and it is a further argument for the value
 * living in exactly one place: the cheap defence is that both sides agree, and
 * the collision is only reachable by someone adding that one filename.
 */
export const NO_FIXTURES_SENTINEL = "_";

/**
 * Roll per-fixture golden verdicts up to one family verdict.
 *
 * Precedence: `renderer-unavailable` → `diff` → `no-golden` → a LONE
 * `no-fixtures` → `match`. Severity order, so the family reports the worst thing
 * any fixture found.
 *
 * Returns **`null` for an absent or empty array**, meaning *CI has not run
 * against this branch yet* — which is a different fact from `match`, and the
 * distinction the manager's UI is built on. ⚠️ Do not let a caller collapse it
 * with `?? "match"`: that reports "checked, nothing changed" for a check that
 * never ran.
 *
 * Three notes on why the arms are shaped this way, each of which was implicit in
 * one repo and invisible in the other before this was shared:
 *
 * - **`renderer-unavailable` is `some`, not `every`.** One fixture failing to
 *   render means the run as a whole proves nothing, so the family goes transient
 *   and the caller skips persistence — a partial result must not be recorded as
 *   a real verdict.
 * - **`no-fixtures` is checked LAST and only when alone.** The API's own element
 *   type excludes it (`GoldenDiffFixtureVerdict`), so from that side this arm is
 *   unreachable; it is live for the manager, which reads persisted arrays where
 *   the sentinel is the only entry. A sentinel riding alongside real results
 *   deliberately falls through to `match` — real results are the better evidence.
 * - **The parameter is the bare verdict union, not either repo's envelope.** The
 *   API's element is a local wire shape (`GoldenDiffFixtureResult`) and the
 *   manager's is core's `GoldenDiff`; taking `readonly GoldenDiffVerdict[]`
 *   serves both without either having to import the other's.
 */
export function aggregateGoldenVerdict(
  verdicts: readonly GoldenDiffVerdict[],
): GoldenDiffVerdict | null {
  if (verdicts.length === 0) return null;
  if (verdicts.some((v) => v === "renderer-unavailable")) return "renderer-unavailable";
  if (verdicts.some((v) => v === "diff")) return "diff";
  if (verdicts.some((v) => v === "no-golden")) return "no-golden";
  if (verdicts.length === 1 && verdicts[0] === "no-fixtures") return "no-fixtures";
  return "match";
}
