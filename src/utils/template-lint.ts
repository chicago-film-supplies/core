/**
 * The fixture lint, as a pure fold.
 *
 * ## Why this is one implementation and not three
 *
 * `templates/scripts/lint-fixtures.ts` was the ONLY implementation of these
 * rules, and it ran only in CI. So the first time an author heard about a
 * schema break, a PII leak, a missing coverage argument, an orphaned golden or
 * an undeclared param key was on a pull request — after the work was committed,
 * released and pushed. The API's `gateDraftContent` does `validateEtaSources` +
 * `validateIncludeTargets` and nothing else, and the manager warned about none
 * of it. templates#195.
 *
 * Two of those gaps were defects rather than mere lateness: an undeclared param
 * key was accepted at save and only threw later inside `resolveRenderParams`,
 * taking the family's whole `visual-diff` run with it; and `PUT /fixtures/{slug}`
 * neither sanitizes nor scans PII while being the manager's own JSON textarea —
 * an unsanitized write path into git, against a dev database that mirrors
 * production.
 *
 * The alternative to extracting it is two implementations of one rule drifting,
 * which is the thing this module exists to make impossible.
 *
 * ## ⚠️ Why this is NOT in `utils/templates.ts`, where the plan put it
 *
 * That module documents a hard invariant in its own docblock — **no runtime
 * dependency on `@cfs/core/schemas`** — because its path helpers (`fixturePath`,
 * `slugify`, `goldenPath`) are pulled by consumers that must not drag the schema
 * barrel and all of zod along with them. Check 1 resolves `templateSchemaFor`,
 * which is exactly such a runtime value.
 *
 * So the lint lives in its own module and its own subpath. That is a real cost —
 * a new `@cfs/core/utils/template-lint` line in every consumer's pin list, and a
 * stranded subpath at the next bump is a documented recurrence — and it buys
 * keeping a zod-free module zod-free. ⚠️ **Do not "tidy" this back into
 * `utils/templates.ts`.**
 *
 * ⭐ **The schema resolver is imported, never injected.** Passing it in would let
 * a caller supply the Firestore collection registry instead, which is precisely
 * the bug the script's own header warns about: a template source names a
 * document SHAPE and need not be a collection at all, so `isCollectionName`
 * fails CLOSED on `movement-sessions` — the receipt's source, which the API's
 * write path validates fine (api-cloudrun#700). An injected resolver makes that
 * mistake reachable again from every call site.
 *
 * ## The two entry points, and why the split is structural
 *
 * `lintFixture` — the checks that need ONE fixture and its family's sidecar.
 * `lintFixtureSet` — the whole fold, which requires the COMPLETE family.
 *
 * ⭐ **This split is what stops a partial caller reporting phantom findings.**
 * The API's fixture verbs hold a single fixture; the set-wide checks (sidecar
 * drift, golden parity, param coverage) would each read "every other fixture is
 * missing" from that input. Rather than police it with a `complete: boolean` a
 * caller can get wrong, a caller holding one fixture literally cannot reach the
 * set-wide checks — they are not on the function it can call.
 *
 * ## ⚠️ The check set is NOT fixed, and nothing here may assume it is
 *
 * It ran six checks until templates#187 retired the org-derivation one. So
 * `check` is a plain `string`, deliberately **not** a closed union a seventh
 * would have to widen, and no count appears anywhere in this module.
 *
 * ⭐ **The EXAMINED tallies are load-bearing, not decoration.** Check 6 was
 * retired *cleanly* only because it printed `0 org chain(s) compose to their own
 * name` on the run after the fixtures were stripped — turning "should this be
 * removed?" into an observation rather than a judgement call. **A check that
 * cannot fail is not coverage**, and a counter is what makes a vacuous check
 * announce itself. Every check here reports what it examined.
 *
 * @module
 */

import type { z } from "zod";
import { templateSchemaFor } from "../schemas/template-schemas.ts";
import { categoryForField, collectMaskedLeaves, maskVerdict } from "./fixture-pii.ts";
import {
  GOLDEN_FRAMES,
  type GoldenFrame,
  goldenFramePath,
  goldenFrameSlug,
  parseGoldenFrameSlug,
} from "./templates.ts";

// ── What a caller hands in ──────────────────────────────────────────

/**
 * The sidecar, structurally.
 *
 * Declared here rather than imported from `Template` because a caller reads it
 * out of a JSON file or a draft content map at runtime, where it is `unknown`
 * and every field may be absent or wrong-typed. Typing it as the parsed
 * `Template` would assert a validity the lint's whole job is to check.
 */
export interface LintSidecar {
  collection_source?: unknown;
  params?: unknown;
  fixtures?: unknown;
  /**
   * The sidecar's `render` block. Read only for `footer`/`header`, which name
   * the PDF frames check 4 expects a baseline for.
   */
  render?: unknown;
}

/** One fixture, already read. Parse failures are a finding, not an exception. */
export type LintFixture =
  | { slug: string; ok: true; doc: unknown }
  | { slug: string; ok: false; parseError: string };

/** The baselines present for one family on one branch. */
export interface LintGoldenTree {
  branch: string;
  /** Baseline slugs, i.e. `goldens/<branch>/<gitPath>/<slug>.png` minus the extension. */
  slugs: string[];
}

/**
 * One family, completely described.
 *
 * ⚠️ **`fixtures` and the family's existence are SEPARATE inputs, and that is
 * the point.** Deriving the family list from "whatever has a fixture directory"
 * — which the disk script did — means a registered family with no fixtures is
 * not merely un-checked but *inexpressible*: the fold cannot even say it is
 * ungated. `packing-list` registered on 2026-09-05 with zero fixtures and zero
 * goldens while the lint's success line read "23 fixture(s) across 2
 * family(ies)", four families existing and one of them rendering in production
 * ungated.
 *
 * A family mid-build is deliberately **not a finding** — that behaviour is
 * preserved verbatim — but it is now *reported*, as `ungatedFamilies`.
 */
export interface LintFamily {
  gitPath: string;
  /** `null` when a fixtures directory has no family — itself a finding. */
  sidecar: LintSidecar | null;
  fixtures: LintFixture[];
  goldens: LintGoldenTree[];
}

// ── What it hands back ──────────────────────────────────────────────

export interface LintFinding {
  /** The family this lands on — what makes blame-scoping possible at all. */
  gitPath: string;
  /** Repo-relative path the finding is about. */
  file: string;
  /**
   * Which check produced it. An open string on purpose — see the module header.
   * Callers may group on it; none may exhaustively switch on it.
   */
  check: string;
  message: string;
  /**
   * `"advisory"` means REPORT, do not block. Absent means block — so a check
   * added without thinking about it fails in the safe direction.
   *
   * ⚠️ **This is a ROLLOUT seam, not a severity scale.** A rule whose corpus is
   * not clean yet cannot land blocking: it would redden a sibling repo's CI on
   * files that no one in that PR touched. So it ships advisory, the corpus is
   * repaired, and the flip is deleting one field. Do not use it to park a rule
   * nobody intends to enforce — an advisory with no plan to flip is a comment
   * that costs a CI run.
   *
   * ⭐ **NO CHECK PRODUCES ONE TODAY, and that is the seam working rather than
   * dead code.** Check 2b was the only producer; its corpus was repaired and it
   * flipped on 2026-09-06. Kept because the next rule over an existing corpus
   * needs exactly this, and because {@link LintReport.advisories} is a wire
   * shape three repos already carry — but a caller reasoning about live
   * advisories today is reasoning about an empty set.
   */
  severity?: "advisory";
}

/**
 * What this run actually examined.
 *
 * ⭐ Report these, always. A zero here is the shape that let check 6 be retired
 * on evidence instead of judgement, and it is the only thing that distinguishes
 * "everything passed" from "nothing was looked at".
 */
/**
 * Check 2b's per-leaf verdict counts, accumulated across a run.
 *
 * @see {@link LintTally.maskLeaves} for why `unverifiable` is reported rather
 * than folded into `masked`.
 */
export interface MaskTally {
  examined: number;
  masked: number;
  notMasked: number;
  unverifiable: number;
}

export interface LintTally {
  families: number;
  fixtures: number;
  /** Sidecar `fixtures[]` entries whose coverage argument was measured. */
  descriptions: number;
  /** `<branch>/<gitPath>` trees compared, i.e. families that have graduated. */
  goldenTrees: string[];
  /** Declared boolean param states asked about (check 5b). */
  paramStates: number;
  /**
   * What check 2's mask oracle actually decided, per `pii: "mask"` string leaf.
   *
   * 🔴 **`unverifiable` must be REPORTED, never folded into `masked`.** Two
   * categories — `postcode` and `opaque` — are masked shape-preservingly on
   * purpose (api-cloudrun#627), so a real value and a fake one are
   * indistinguishable and no oracle can settle them. A run that examined 69
   * leaves of which 69 were postcodes has checked nothing, and without this
   * number it reads exactly like one that checked 500.
   *
   * ⚠️ `examined` is also the tell for a fixture that fails the SCHEMA check:
   * the walker only descends what the schema resolves, so a badly-shaped
   * document yields a small `examined` and a clean PII verdict it has not
   * earned.
   */
  maskLeaves: { examined: number; masked: number; notMasked: number; unverifiable: number };
}

export interface LintReport {
  /** Findings that BLOCK. A caller fails its run when this is non-empty. */
  findings: LintFinding[];
  /**
   * Findings that REPORT and do not block — `severity: "advisory"`.
   *
   * ⚠️ **Print these.** They are partitioned out so a caller cannot fail a run
   * on them by accident, not so a caller can ignore them: an advisory nobody
   * ever sees is a check that does not exist.
   *
   * ⚠️ **Empty since 2026-09-06** — see {@link LintFinding.severity}. A caller
   * that drops this array is not currently losing anything, which is a fact
   * about today's check set and not a licence: `api-cloudrun`'s
   * `familyLintOutcome` already drops it, and did so while check 2b was still
   * advisory — so the family-wide lint the manager renders never showed a mask
   * finding at all until the flip made it blocking.
   */
  advisories: LintFinding[];
  tally: LintTally;
  /**
   * Registered families carrying no fixture at all.
   *
   * **Not a finding** — a family mid-build is legitimate, and reddening it on
   * registration would block the very PR that creates it. Reported so a caller
   * that wants to ask "what renders in production ungated?" now can.
   */
  ungatedFamilies: string[];
  /**
   * Registered families that HAVE committed a fixture set and still gate nothing
   * — no golden baseline on any branch (templates#256).
   *
   * 🔴 **The state this exists for is INVISIBLE to every other output, and it is
   * strictly worse-observed than the state before it.** A family with no
   * fixtures is reported by {@link ungatedFamilies}; a graduated one appears in
   * {@link LintTally.goldenTrees}. One that has fixtures and no baseline falls
   * out of BOTH — and check 4 keeps it quiet deliberately, because it is
   * graduation-scoped. Measured on `statement` (templates#252 → #254): adding
   * its first two fixtures removed the "renders in production ungated" line and
   * added no gate, so the family became less observed by committing a fixture
   * set. **The state that looks set up is the one nobody is watching.**
   *
   * ⚠️ **Not a finding, for the same reason `ungatedFamilies` is not.** A first
   * bless cannot happen on the PR that creates the fixtures — `visual-diff`
   * returns `no-golden`, an informational PASS — so reddening it would block the
   * very PR that makes blessing possible. This reports; it does not gate.
   *
   * ⚠️ **Disjoint from `ungatedFamilies` by construction**, so a caller may
   * print both without deduping: a family with zero fixtures is in the first and
   * can never be in this one.
   */
  fixturedUngatedFamilies: string[];
}

// ── Policy constants ────────────────────────────────────────────────

/**
 * Minimum length for a fixture's coverage argument.
 *
 * `FixtureMeta` requires a non-empty string, which stops the field being absent
 * but not `"x"`. This is the policy on top of that: a coverage argument is a
 * sentence. Deliberately a small round number rather than a tuned one — it
 * exists to catch a placeholder, not to grade prose.
 */
export const MIN_DESCRIPTION = 40;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]?\d{4}|\b\d{10}\b/g;
const ALLOWED_EMAIL_DOMAIN = "chicagofilmsupplies.com";
const CFS_PHONE_DIGITS = new Set(["3128183008"]);

/**
 * 555-0100 through 555-0199 is the block NANP reserves for fiction — the only
 * phone number that belongs in a fixture. Anything else is a real person's line
 * until proven otherwise.
 */
function isFictionalPhone(digits: string): boolean {
  return /^\d{3}55501\d{2}$/.test(digits);
}

/** Item and doc ids are uuids, and a uuid contains digit runs a phone regex bites on. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Walk the parsed JSON's STRING leaves, not the raw file text.
 *
 * ⚠️ **Not an optimisation — a correctness requirement.** A fixture is full of
 * numbers that look like phone numbers to a `\b\d{10}\b` regex: every Firestore
 * `_seconds` epoch is exactly ten digits. Scanning values sidesteps the whole
 * class instead of allowlisting each false positive one at a time.
 */
export function* stringLeaves(value: unknown, path = ""): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* stringLeaves(v, `${path}[${i}]`);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) yield* stringLeaves(v, path ? `${path}.${k}` : k);
  }
}

// ── Structural readers ──────────────────────────────────────────────
//
// The sidecar arrives as `unknown`-shaped data, so every read is defensive.
// A wrong-typed field is not a crash and, where it is not itself the finding,
// is treated as absent.

interface SidecarFixtureEntry {
  slug: string;
  description?: string;
  params?: Record<string, unknown>;
}

interface SidecarParamDecl {
  key: string;
  type?: string;
  default?: boolean;
}

function sidecarFixtures(sidecar: LintSidecar): SidecarFixtureEntry[] {
  if (!Array.isArray(sidecar.fixtures)) return [];
  return sidecar.fixtures.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    if (typeof entry.slug !== "string") return [];
    return [{
      slug: entry.slug,
      description: typeof entry.description === "string" ? entry.description : undefined,
      params: entry.params !== null && typeof entry.params === "object"
        ? entry.params as Record<string, unknown>
        : undefined,
    }];
  });
}

function sidecarParams(sidecar: LintSidecar): SidecarParamDecl[] {
  if (!Array.isArray(sidecar.params)) return [];
  return sidecar.params.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const param = raw as Record<string, unknown>;
    if (typeof param.key !== "string") return [];
    return [{
      key: param.key,
      type: typeof param.type === "string" ? param.type : undefined,
      default: typeof param.default === "boolean" ? param.default : undefined,
    }];
  });
}

/** `fixtures/<gitPath>/<slug>.json` — restated locally to keep this module's imports narrow. */
/**
 * The PDF render frames this family declares — `render.footer` / `render.header`
 * naming a content-map key.
 *
 * ⚠️ **A declared-but-EMPTY string is not a declaration.** `extractRenderConfig`
 * in api-cloudrun resolves the key out of the content map and warns when it is
 * absent, so a blank key can never produce a frame; treating it as declared here
 * would ask for a baseline of a frame that never renders.
 *
 * ⚠️ Structural, like every other sidecar accessor here: the sidecar arrives as
 * `unknown` from a JSON parse and this module owns no schema for it.
 */
function sidecarRenderFrames(sidecar: LintSidecar): GoldenFrame[] {
  const render = sidecar.render;
  if (render === null || typeof render !== "object") return [];
  const block = render as Record<string, unknown>;
  return GOLDEN_FRAMES.filter((f) => typeof block[f] === "string" && block[f] !== "");
}
function fixtureFile(gitPath: string, slug: string): string {
  return `fixtures/${gitPath}/${slug}.json`;
}

function sidecarFile(gitPath: string): string {
  return `templates/${gitPath}.meta.json`;
}

// ── Per-fixture checks ──────────────────────────────────────────────

/**
 * The checks answerable from ONE fixture plus its family's sidecar.
 *
 * This is what the API's fixture verbs call: schema (1), PII (2) and the
 * per-entry param-key check (5a). None of them consults another fixture, so a
 * caller holding one cannot produce a finding that is an artifact of the rest
 * being absent.
 *
 * ⚠️ **The PII scan runs whether or not the schema check passed**, and on the
 * raw document rather than a parsed one. A schema failure and a PII leak are
 * independent, and returning early on the first hides the second behind it —
 * which matters most in exactly the case where it is most likely, a hand-pasted
 * document that satisfies neither.
 */
export function lintFixture(args: {
  gitPath: string;
  sidecar: LintSidecar;
  fixture: LintFixture;
  /**
   * Optional accumulator for check 2's mask-oracle counts, ADDED INTO.
   *
   * It is a parameter rather than a second return value because the API's
   * fixture verbs call this function and only want findings — widening the
   * return type would break every one of them for a number they do not read.
   * `lintFixtureSet` passes one so `LintTally.maskLeaves` can be reported.
   */
  maskTally?: MaskTally;
}): LintFinding[] {
  const { gitPath, sidecar, fixture } = args;
  const findings: LintFinding[] = [];
  const file = fixtureFile(gitPath, fixture.slug);
  const note = (check: string, message: string, severity?: "advisory") =>
    findings.push({ gitPath, file, check, message, ...(severity ? { severity } : {}) });

  if (!fixture.ok) {
    note("json", `not valid JSON: ${fixture.parseError}`);
    return findings;
  }

  // ── 1. Schema ─────────────────────────────────────────────────────
  //
  // 🔴 `templateSchemaFor`, NOT the Firestore collection registry. A template
  // SOURCE names a document SHAPE and is not always a collection:
  // `movement-sessions` is the fold of `transactions where uuid_session == …`
  // that a receipt renders, and nothing is stored at that path. Under an
  // `isCollectionName` guard the receipt family's very first fixture was
  // reported as an unmapped collection — failing CLOSED on a source the API's
  // own write path validates fine (api-cloudrun#700). This check exists to
  // AGREE with the write path, so it must resolve a source the way the write
  // path does.
  const collection = sidecar.collection_source;
  // Hoisted out of the branch below because check 2's mask oracle needs it too:
  // the oracle's SCOPE is whatever the real pii walker visits, and the walker
  // takes a schema. `null` therefore means the oracle cannot run at all, which
  // is a reported state rather than a silent pass.
  let resolved: z.ZodType | null = null;
  if (typeof collection !== "string" || collection === "") {
    note(
      "schema",
      "the family sidecar has no `collection_source`, so no schema can be resolved for this fixture",
    );
  } else {
    // `TEMPLATE_COLLECTION_SCHEMAS` is `Partial`, so `undefined` IS the "no
    // schema for this source" answer rather than a lookup that lost its type.
    // Checked BEFORE use — the original shape read the map directly and would
    // have thrown a bare TypeError on `.safeParse`.
    const schema = templateSchemaFor(collection);
    resolved = schema ?? null;
    if (!schema) {
      note(
        "schema",
        `collection_source "${collection}" has no schema in @cfs/core's \`TEMPLATE_COLLECTION_SCHEMAS\``,
      );
    } else {
      const parsed = schema.safeParse(fixture.doc);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("\n");
        note("schema", `does not satisfy the \`${collection}\` schema:\n${issues}`);
      }
    }
  }

  // ── 2. PII ────────────────────────────────────────────────────────
  for (const [path, value] of stringLeaves(fixture.doc)) {
    if (UUID.test(value)) continue;
    for (const match of value.matchAll(EMAIL)) {
      const domain = match[0].split("@")[1]?.toLowerCase() ?? "";
      if (domain !== ALLOWED_EMAIL_DOMAIN) {
        note("pii", `${path}: email address in a fixture — ${match[0]}`);
      }
    }
    for (const match of value.matchAll(PHONE)) {
      const digits = match[0].replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
      if (CFS_PHONE_DIGITS.has(digits) || isFictionalPhone(digits)) continue;
      note(
        "pii",
        `${path}: phone number in a fixture — ${match[0]}. Use the 555-01xx fiction block.`,
      );
    }
  }

  // ── 2b. The mask oracle ───────────────────────────────────────────
  //
  // ⭐ **A DIFFERENT question from 2a above, and the reason both exist.** 2a
  // asks "does any string in this file look like an email or a phone number?" —
  // schema-independent, and blind to the other eleven categories, which is how
  // it missed an organization name, a street address in a divider `name`, a
  // street address in `items[].description` and `internal_notes`. 2b asks the
  // schema instead: for every leaf the pii walker WOULD mask, does the committed
  // value look like something the masker could have produced?
  //
  // 🔴 Three verdicts, not two. Block only on `not-masked`; `unverifiable` is
  // counted and reported, because `postcode` and `opaque` are masked
  // shape-preservingly on purpose and no oracle can settle them.
  if (resolved && fixture.doc !== null && typeof fixture.doc === "object") {
    const unrouted: string[] = [];
    for (const { fieldPath, value } of collectMaskedLeaves(fixture.doc, resolved)) {
      const verdict = maskVerdict(value, fieldPath);
      if (args.maskTally) {
        args.maskTally.examined++;
        if (verdict === "masked") args.maskTally.masked++;
        else if (verdict === "not-masked") args.maskTally.notMasked++;
        else args.maskTally.unverifiable++;
      }
      if (verdict === "not-masked") unrouted.push(`${fieldPath} (${categoryForField(fieldPath)})`);
    }
    if (unrouted.length > 0) {
      // ⚠️ **Paths and categories, never the VALUES.** The whole finding is that
      // these leaves may hold real customer data, and a CI log is a wider
      // surface than the repo it is linting. The author opens the file.
      const shown = unrouted.slice(0, 8);
      const more = unrouted.length - shown.length;
      // ⚠️ **One LINE, not a paragraph.** This fires on most fixtures in the
      // corpus today, and a five-line rationale repeated 24 times buries the
      // one thing that differs between them — which leaves. The explanation
      // belongs to the presenter, printed once; the finding states the fact.
      // 🔴 **BLOCKING since 2026-09-06 — the flip is done, and the corpus is
      // what changed, not the rule.** It shipped advisory because 157 leaves
      // across ALL 24 committed fixtures read `not-masked`, most of them not
      // leaks but values masked by the pre-#837 router, which chose a category
      // from the value's SHAPE. Landing blocking then would have reddened
      // `templates` CI for every session in that checkout on files nobody in
      // the PR touched. `templates` #234/#235/#236 re-captured 22 of the 24 and
      // #238 rewrote the two hand-built ones from this module's own
      // vocabularies, taking the count 157 → 50 → **0**.
      //
      // ⚠️ **Do not re-add a carve-out for a fixture that cannot be captured.**
      // Both hand-built fixtures are PII-free by construction and were still
      // repaired rather than exempted: a carve-out is exactly where a genuinely
      // leaked address would hide, and a fixture is the cheaper thing to change
      // than the rule. The vocabularies are exported for that purpose.
      note(
        "pii-mask",
        `${unrouted.length} masked leaf/leaves hold a value the masker could not have ` +
          `produced: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`,
      );
    }
  }

  // ── 5a. Undeclared param key ──────────────────────────────────────
  //
  // ⚠️ NOT graduation-scoped, unlike 5b. An undeclared key is a typo rather
  // than a coverage judgement, and it is not survivable downstream: the golden
  // gate hands a fixture's state straight to `resolveRenderParams`, which
  // THROWS on an unknown key and takes the family's whole visual-diff run with
  // it — not just this fixture.
  const declaredKeys = new Set(sidecarParams(sidecar).map((p) => p.key));
  const entry = sidecarFixtures(sidecar).find((f) => f.slug === fixture.slug);
  for (const key of Object.keys(entry?.params ?? {})) {
    if (declaredKeys.has(key)) continue;
    findings.push({
      gitPath,
      file: sidecarFile(gitPath),
      check: "param-declared",
      message:
        `"${fixture.slug}" declares the param state \`${key}\`, which this family does not ` +
        `declare in \`params[]\`. The golden gate resolves a fixture's state through ` +
        `\`resolveRenderParams\`, which throws on an unknown key — so this fails the ` +
        `family's whole visual-diff run, not just this fixture. Declared here: ` +
        `${declaredKeys.size === 0 ? "(none)" : [...declaredKeys].sort().join(", ")}.`,
    });
  }

  return findings;
}

// ── The whole fold ──────────────────────────────────────────────────

/**
 * Every check, over completely-described families.
 *
 * ⚠️ **Pass EVERY registered family, including ones with no fixtures.** The
 * caller decides what "every family" means; this fold reports what it was given
 * and cannot detect an omission. A family left out is silently unchecked, which
 * is the failure the `ungatedFamilies` output exists to make visible for the
 * families that ARE passed.
 *
 * Fails CLOSED on: a fixtures directory with no sidecar, a sidecar with no
 * `collection_source`, an unmapped collection, sidecar↔file drift in either
 * direction, a missing or placeholder coverage argument, an undeclared param
 * key, and a fixture taking a render frame's reserved golden slug. Checks 4 and
 * 5b fail OPEN by design — both are scoped to families that have GRADUATED,
 * because a family with no baseline has not chosen its fixture set yet and
 * saying so on every PR would be noise rather than a finding.
 *
 * ⚠️ **Check 4 has TWO graduation guards, at different grains.** The fixture
 * arms are scoped on the tree holding a fixture baseline; the frame arms are
 * scoped on the tree holding a FRAME baseline. They are independent because
 * every family declares a `render.footer` and none had a baseline for it when
 * the frame arms shipped — so one guard would have reddened every family at
 * once (templates#137 half 2).
 */
export function lintFixtureSet(args: { families: LintFamily[] }): LintReport {
  const findings: LintFinding[] = [];
  const maskLeaves: MaskTally = { examined: 0, masked: 0, notMasked: 0, unverifiable: 0 };
  const goldenTrees: string[] = [];
  const ungatedFamilies: string[] = [];
  const fixturedUngatedFamilies: string[] = [];
  let fixtures = 0;
  let descriptions = 0;
  let paramStates = 0;

  for (const family of [...args.families].sort((a, b) => a.gitPath.localeCompare(b.gitPath))) {
    const { gitPath, sidecar } = family;
    const sidecarPath = sidecarFile(gitPath);
    const note = (file: string, check: string, message: string) =>
      findings.push({ gitPath, file, check, message });

    if (!sidecar) {
      note(
        `fixtures/${gitPath}/`,
        "sidecar",
        `no sidecar at ${sidecarPath} — a fixtures dir must belong to a template family`,
      );
      continue;
    }

    const slugsOnDisk = new Set(family.fixtures.map((f) => f.slug));
    if (slugsOnDisk.size === 0) {
      // Not a finding — a family mid-build is legitimate. Reported instead.
      ungatedFamilies.push(gitPath);
    }

    // A fixture may not take a render frame's reserved golden name. Both of
    // check 4's arm pairs key on the same flat `goldens/<branch>/<gp>/*.png`
    // listing, so one file cannot be both — the fixture arm would claim the
    // frame baseline as its own and the frame arm would call it orphaned, on
    // the same path, forever. Refusing the NAME is what keeps the partition
    // total; policing the collision downstream would need both arms to agree.
    for (const frame of GOLDEN_FRAMES) {
      const reserved = goldenFrameSlug(frame);
      if (!slugsOnDisk.has(reserved)) continue;
      note(
        fixtureFile(gitPath, reserved),
        "golden-parity",
        `"${reserved}" is the reserved golden slug for the \`${frame}\` render frame, so ` +
          `this fixture and that frame would both claim ` +
          `\`${goldenFramePath("<branch>", gitPath, frame)}\`. Rename the fixture.`,
      );
    }

    // ── 1, 2, 5a — per fixture ──────────────────────────────────────
    for (const fixture of [...family.fixtures].sort((a, b) => a.slug.localeCompare(b.slug))) {
      fixtures++;
      findings.push(...lintFixture({ gitPath, sidecar, fixture, maskTally: maskLeaves }));
    }

    const entries = sidecarFixtures(sidecar);

    // ── Sidecar ↔ file drift, in BOTH directions ────────────────────
    //
    // `listFixtures` is files-authoritative, but the sidecar's `fixtures[]` is
    // what gets projected onto the family doc at publish — so an entry with no
    // file publishes a fixture that never lists, and a file with no entry loses
    // its label and its coverage argument.
    const slugsInSidecar = new Set(entries.map((e) => e.slug));
    for (const slug of [...slugsInSidecar].sort()) {
      if (slugsOnDisk.has(slug)) continue;
      note(
        sidecarPath,
        "drift",
        `\`fixtures[]\` lists "${slug}" but ${fixtureFile(gitPath, slug)} does not exist`,
      );
    }
    for (const slug of [...slugsOnDisk].sort()) {
      if (slugsInSidecar.has(slug)) continue;
      note(
        sidecarPath,
        "drift",
        `${fixtureFile(gitPath, slug)} exists but is not listed in \`fixtures[]\``,
      );
    }

    // ── 3. The coverage argument ────────────────────────────────────
    //
    // The API enforces this on writes, but a fixture hand-committed through git
    // bypasses the API entirely — the same hole that let both quote fixtures
    // sit schema-invalid in `main` for months.
    for (const entry of entries) {
      descriptions++;
      const description = entry.description?.trim() ?? "";
      if (!description) {
        note(
          sidecarPath,
          "description",
          `"${entry.slug}" has no \`description\` — a fixture must record what it covers ` +
            `that no other fixture does. The fixture file is a strict source document with ` +
            `nowhere to put a comment, so this is the only place it can be said.`,
        );
      } else if (description.length < MIN_DESCRIPTION) {
        note(
          sidecarPath,
          "description",
          `"${entry.slug}" has a ${description.length}-character description — too short to ` +
            `be a coverage argument (minimum ${MIN_DESCRIPTION}). Say what this fixture ` +
            `exercises that its siblings do not: ${JSON.stringify(description)}`,
        );
      }
    }

    // ── 4. Golden parity, per graduated branch ──────────────────────
    //
    // A fixture with no baseline is not a failure anywhere — `goldenDiff`
    // renders it and returns `no-golden`, an informational PASS — so the one
    // thing the fixture was added to gate is the one thing the gate stays
    // silent about. `billing-foreign-country` landed on `main` with no baseline
    // and stayed ungated for two days; nothing in a green CI run mentioned it.
    //
    // The `>= 1 baseline` condition is what scopes it, and it is also what keeps
    // an empty `goldens/sandbox/` silent without this check knowing anything
    // about which branch is which.
    //
    // ── 4b, folded in here because it partitions the SAME tree ──────
    //
    // A frame baseline (`_footer.png`) arrives in `tree.slugs` exactly as a
    // fixture baseline does — both callers list `goldens/<branch>/<gp>/*.png`
    // and strip the extension. So the frame slugs are split out FIRST, before
    // either fixture arm runs.
    //
    // 🔴 **Both arms fire on the whole tree if this partition is skipped, and
    // they fire in OPPOSITE directions depending on landing order.** Blessing
    // `_footer.png` before this check knows the name makes every frame baseline
    // read `orphaned`; landing a symmetric frame arm before the baselines exist
    // makes every family read `missing` on the very pin-bump PR. Both are a
    // self-inflicted block on `templates-lint`, which is required on `main` —
    // which is why the frame arm below is graduation-scoped on the FRAME
    // BASELINES rather than on the declaration.
    const declaredFrames = sidecarRenderFrames(sidecar);
    let graduatedAnywhere = false;
    for (const tree of [...family.goldens].sort((a, b) => a.branch.localeCompare(b.branch))) {
      const pngs = new Set<string>();
      const frames = new Set<GoldenFrame>();
      for (const slug of tree.slugs) {
        const frame = parseGoldenFrameSlug(slug);
        if (frame) frames.add(frame);
        else pngs.add(slug);
      }
      if (pngs.size === 0) continue; // an empty tree is not a graduation
      graduatedAnywhere = true;
      goldenTrees.push(`${tree.branch}/${gitPath}`);

      for (const slug of [...slugsOnDisk].sort()) {
        if (pngs.has(slug)) continue;
        note(
          `goldens/${tree.branch}/${gitPath}/${slug}.png`,
          "golden-parity",
          `missing — \`${gitPath}\` has graduated on \`${tree.branch}\` (${pngs.size} ` +
            `baseline(s)) but ${fixtureFile(gitPath, slug)} has none, so the visual diff ` +
            `renders it and then returns \`no-golden\`: an informational PASS. Whatever ` +
            `this fixture was added to cover is still ungated. Clear it by APPROVING THE ` +
            `RENDERS — the visual-diff job runs regardless and has already uploaded the ` +
            `candidate, so the baseline is one press away.`,
        );
      }
      for (const slug of [...pngs].sort()) {
        if (slugsOnDisk.has(slug)) continue;
        note(
          `goldens/${tree.branch}/${gitPath}/${slug}.png`,
          "golden-parity",
          `orphaned — no ${fixtureFile(gitPath, slug)} renders it, so nothing will ever ` +
            `compare against it. Usually a renamed or removed fixture: delete the baseline, ` +
            `or restore the fixture if the rename was the mistake.`,
        );
      }

      // ── The frame arms ────────────────────────────────────────────
      //
      // ⚠️ **Scoped on `frames.size`, NOT on `declaredFrames`, and that is the
      // whole rollout seam.** Every registered family declares a `render.footer`
      // today and none has a baseline for it, so a rule keyed on the
      // DECLARATION would go red on all of them the moment it shipped. Keyed on
      // the BASELINES, it is silent until someone blesses the first one and
      // strict from that moment on — the same shape as the `pngs.size === 0`
      // graduation guard above, one surface over.
      //
      // ⭐ **Per-TREE, matching the fixture arms.** A family may have frame
      // baselines on `main` and none on `sandbox` yet, and saying so on
      // `sandbox` would be reporting the bless that is in flight.
      if (frames.size === 0) continue;
      for (const frame of declaredFrames) {
        if (frames.has(frame)) continue;
        note(
          goldenFramePath(tree.branch, gitPath, frame),
          "golden-parity",
          `missing — \`${gitPath}\` declares \`render.${frame}\` and has frame baselines on ` +
            `\`${tree.branch}\`, but not for this one. A frame is an isolated Chromium ` +
            `document that the body's golden cannot see into, so it is ungated until this ` +
            `baseline exists. Clear it by APPROVING THE RENDER.`,
        );
      }
      for (const frame of [...frames].sort()) {
        if (declaredFrames.includes(frame)) continue;
        note(
          goldenFramePath(tree.branch, gitPath, frame),
          "golden-parity",
          `orphaned — \`${sidecarFile(gitPath)}\` declares no \`render.${frame}\`, so nothing ` +
            `renders this frame and nothing will ever compare against it. Delete the ` +
            `baseline, or restore \`render.${frame}\` if removing it was the mistake.`,
        );
      }
    }

    // ── 5b. Every declared boolean param golden-gated at BOTH states ─
    //
    // A golden freezes ONE rendering per fixture, at the state that fixture
    // declares (api-cloudrun#608). So a param nothing overrides is frozen at its
    // default and its other state is ungated for the LIFE of the family —
    // reachable by no threshold, no re-bless and no number of extra fixtures,
    // because every one of them renders at the default too.
    //
    // ⚠️ Graduation-scoped, matching check 4 — and scoped to ANY branch, not
    // per-branch: a param's coverage is a property of the FIXTURE SET, which is
    // branch-independent, while a baseline is per-branch. Asking once per branch
    // would report the same finding twice.
    //
    // ⚠️ What this does NOT claim is that the coverage is GOOD. It says some
    // fixture renders each state, never that the fixture chosen exercises the
    // part of the document the param actually moves. That argument is the
    // ⚠️ Keyed on `graduatedAnywhere`, NOT on `family.goldens.length` — a tree
    // holding only render-frame baselines (`<slug>._footer.png`) has
    // `pngs.size === 0` and is explicitly "not a graduation" above, so a length
    // test would report such a family as gated when nothing gates what it
    // renders. Same predicate the two graduation-scoped checks use, so this
    // cannot disagree with them about what "has graduated" means.
    if (slugsOnDisk.size > 0 && !graduatedAnywhere) {
      fixturedUngatedFamilies.push(gitPath);
    }

    // `description`, and check 3 is what makes it exist.
    const declaredParams = sidecarParams(sidecar);
    if (graduatedAnywhere && declaredParams.length > 0) {
      for (const param of declaredParams) {
        if (param.type !== undefined && param.type !== "boolean") continue;
        // A fixture with no override renders at the param's own default — so the
        // default state is covered by the mere existence of an ordinary fixture.
        const fallback = param.default ?? false;
        const covered = new Set<boolean>();
        for (const slug of slugsOnDisk) {
          const entry = entries.find((e) => e.slug === slug);
          const claimed = entry?.params?.[param.key];
          covered.add(typeof claimed === "boolean" ? claimed : fallback);
        }
        for (const state of [false, true]) {
          paramStates++;
          if (covered.has(state)) continue;
          note(
            sidecarPath,
            "param-coverage",
            `no fixture renders \`${param.key}\` at \`${state}\`, so that half of this ` +
              `template is ungated: every golden freezes the other state and a green ` +
              `visual-diff says nothing about it. No threshold, re-bless or extra fixture ` +
              `reaches it — a fixture must SAY which state it renders at. Fix by capturing ` +
              `one (or copying an existing fixture file) and giving its \`fixtures[]\` entry ` +
              `\`"params": { "${param.key}": ${state} }\`, then approving its render.`,
          );
        }
      }
    }
  }

  return {
    findings: findings.filter((f) => f.severity !== "advisory"),
    advisories: findings.filter((f) => f.severity === "advisory"),
    tally: {
      families: args.families.length,
      fixtures,
      descriptions,
      goldenTrees,
      paramStates,
      maskLeaves,
    },
    ungatedFamilies,
    fixturedUngatedFamilies,
  };
}
