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
