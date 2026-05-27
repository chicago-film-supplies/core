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
 * No runtime dependency on `@cfs/schemas`: the declared-param shape is accepted
 * structurally so this module type-checks independent of the schemas publish
 * cadence. `@cfs/schemas`' `TemplateParam` is structurally compatible.
 *
 * @module
 */

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

/** A render-time parameter declaration (structurally `@cfs/schemas`' `TemplateParam`). */
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
