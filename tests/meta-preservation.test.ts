/**
 * A field re-declared inside `.extend()` must not silently lose the base's
 * `.meta()`.
 *
 * ## The mechanism, measured rather than reasoned
 *
 * `z.globalRegistry` is a WeakMap keyed on the schema **instance** and `.meta()`
 * clones, so a field re-declared in an extension is a *different node* carrying
 * none of the base's annotations. Probed against `zod@4.3.6`: an untouched field
 * keeps its instance and its meta; a re-declared one loses it; **an
 * object-level `.meta()` is dropped too**; strictness survives.
 *
 * ## Why it is worth a guard with zero current violations
 *
 * `applyPii` is driven **entirely** by `.meta({ pii })`, so the channel that
 * dropped a `label` in `b137b29` would drop a mask. 🔴 **A dropped tag is
 * invisible to `tests/pii.test.ts` by construction** — that test can only assert
 * what the schema currently claims, and a field that lost a tag is
 * indistinguishable from one that never had one.
 *
 * `pii.test.ts` does enforce `pii` **by field name** (`pii/dictionary.ts`), which
 * covers `email` / `filename` / `external_notes`. The residual hole is a
 * hand-tagged field whose name is deliberately NOT in that dictionary —
 * `subject`, `reference`, `description`, `label` are listed there as explicit
 * exclusions, and `Invoice.subject` carries `pii: "mask"` today. `label` and
 * `column` have no dictionary at all. **So this diffs the annotation SET against
 * the base rather than checking a name list.**
 *
 * ## Shape
 *
 * Arm 1 is the bypass + non-vacuity gate and runs first: a source scan pins the
 * per-file count of every composition helper, and `extendChecked(` call sites
 * must EQUAL `EXTENSION_SITES.length`. That equality is what makes an empty
 * registry — the silent failure mode, since it only populates on import —
 * impossible, and it is why a new call site cannot be waved through by bumping a
 * number.
 *
 * `src/schemas/card.ts` used to assert all of this in prose, and the claim was
 * false for five weeks (core#82). A claim nothing checks decays whether it lives
 * in a list or a sentence.
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { EXTENSION_SITES, type ExtensionSite, extendChecked } from "../src/schemas/_extend.ts";
import { readMetaThroughWrappers } from "../src/schemas/zod-walk.ts";
// Import for effect: `EXTENSION_SITES` only populates for modules that have been
// evaluated. Arm 1's count equality is what proves this actually worked.
import "../src/schemas/mod.ts";

/**
 * The registry as the barrel import left it.
 *
 * ⚠️ Snapshotted at module load because arm 3 calls `extendChecked` on synthetic
 * schemas to prove the recorder works, which APPENDS. Reading the live array in
 * arms 1 and 2 would make them depend on `Deno.test` declaration order — a
 * dependency that holds today and would break silently the first time someone
 * reorders the file or steps start running concurrently.
 */
const SITES_AT_LOAD: readonly ExtensionSite[] = [...EXTENSION_SITES];

const SRC_DIR = new URL("../src/", import.meta.url);

/** A token inside a comment is prose about the construct, not the construct. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\*|\/\*)/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

async function* walk(
  dirUrl: URL,
  prefix = "",
): AsyncGenerator<{ relPath: string; content: string }> {
  for await (const entry of Deno.readDir(dirUrl)) {
    const relPath = prefix + entry.name;
    if (entry.isDirectory) {
      yield* walk(new URL(entry.name + "/", dirUrl), relPath + "/");
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      yield { relPath, content: await Deno.readTextFile(new URL(entry.name, dirUrl)) };
    }
  }
}

async function grep(re: RegExp): Promise<Hit[]> {
  const hits: Hit[] = [];
  for await (const { relPath, content } of walk(SRC_DIR)) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (COMMENT_LINE_RE.test(lines[i])) continue;
      if (!re.test(lines[i])) continue;
      hits.push({ file: `src/${relPath}`, line: i + 1, text: lines[i].trim() });
    }
  }
  return hits;
}

const show = (hits: Hit[]) =>
  hits.map((h) => `  + ${h.file}:${h.line}  ${h.text.slice(0, 110)}`).sort().join("\n");

// `\.extend\(` and `\.merge\(` only — a leading `.` is required, so `.safeExtend(`
// (used in `tests/typesenseFieldCoverage.test.ts`) does not match, and neither
// does the identifier `extendChecked`.
const BARE_COMPOSE_RE = /\.(?:extend|merge)\(/;
const EXTEND_CHECKED_RE = /\bextendChecked\(/;
/**
 * `.omit()` / `.pick()` / `.partial()` cannot drop a surviving field's meta —
 * they keep the node INSTANCES — so they need no pair. They stay ratcheted at
 * zero anyway so `card.ts`'s claim about them remains a checked one rather than
 * an assumption, and so a first use is a deliberate decision.
 */
const INSTANCE_PRESERVING_RE = /\.(?:omit|pick|partial)\(/;

/** The file that owns the helper is the one place a bare `.extend(` is correct. */
const HELPER_FILE = "src/schemas/_extend.ts";

// ── Arm 1: bypass + non-vacuity ──────────────────────────────────────

Deno.test("meta preservation — the walk sees the source, and nothing bypasses the helper", async (t) => {
  const files: string[] = [];
  for await (const { relPath } of walk(SRC_DIR)) files.push(relPath);

  await t.step("the src/ walker is not inert", () => {
    assert(
      files.length > 100,
      `The src/ walker found only ${files.length} files — every arm below would ` +
        `pass over an empty set.`,
    );
  });

  await t.step("the regexes match what they claim, and nothing else", () => {
    assertEquals(BARE_COMPOSE_RE.test("Base.extend({ a: z.string() })"), true, "stopped matching .extend(");
    assertEquals(BARE_COMPOSE_RE.test("Base.merge(Other)"), true, "stopped matching .merge(");
    // 🔴 The two false positives that would make this guard a liar. `.safeExtend(`
    // is a different Zod verb that does not re-declare through the same path, and
    // `extendChecked(` is the fix — matching either would force a permanent
    // exemption that then hides a real bypass.
    assertEquals(BARE_COMPOSE_RE.test("cfg.safeExtend({ a: 1 })"), false, "matches .safeExtend(");
    assertEquals(BARE_COMPOSE_RE.test("extendChecked(Base, { a: z.string() })"), false, "matches the helper");
    assertEquals(EXTEND_CHECKED_RE.test("extendChecked(Base, {})"), true, "stopped matching the helper");
    assertEquals(INSTANCE_PRESERVING_RE.test("Base.omit({ a: true })"), true, "stopped matching .omit(");
  });

  await t.step("comments are stripped, so prose about the construct cannot satisfy it", async () => {
    // `card.ts` names `.extend()` / `.omit()` / `.pick()` in a docstring, and
    // this file's own header names them too. A scan that counted those would be
    // permanently red on correct code — the mirror of the trap in
    // `typesenseFieldCoverage.test.ts`, where a comment made a guard PASS.
    const bare = await grep(BARE_COMPOSE_RE);
    assertEquals(
      bare.filter((h) => h.file === "src/schemas/card.ts"),
      [],
      "card.ts's docstring is being read as code — the comment strip regressed",
    );
  });

  await t.step("no bare .extend( / .merge( outside the helper", async () => {
    const offenders = (await grep(BARE_COMPOSE_RE)).filter((h) => h.file !== HELPER_FILE);
    assertEquals(
      show(offenders),
      "",
      "A bare `.extend(`/`.merge(` re-declares a field as a NEW node, and " +
        "`z.globalRegistry` is keyed on the instance — so the base's `.meta()` " +
        "(including `pii`) is silently gone. Route it through `extendChecked` " +
        "(`src/schemas/_extend.ts`) so the pair is captured and diffed:\n" + show(offenders),
    );
  });

  await t.step("no .omit( / .pick( / .partial( at all", async () => {
    const offenders = await grep(INSTANCE_PRESERVING_RE);
    assertEquals(
      show(offenders),
      "",
      "These preserve node identity so they cannot drop a surviving field's " +
        "meta — but they are ratcheted at zero so a first use is deliberate, and " +
        "so `card.ts`'s claim about them stays checked. If one is genuinely " +
        "wanted, decide what it means for the annotations first:\n" + show(offenders),
    );
  });

  // 🔴 THE arm that makes the registry trustworthy. `EXTENSION_SITES` only fills
  // for modules that were imported; without this equality a broken import (or a
  // helper call moved behind a lazy branch) leaves the registry EMPTY and every
  // annotation assertion below passes over nothing.
  await t.step("every extendChecked( call site is in the registry", async () => {
    const callSites = await grep(EXTEND_CHECKED_RE);
    // The helper's own declaration is a definition, not a call.
    const calls = callSites.filter((h) => h.file !== HELPER_FILE);
    assert(calls.length >= 1, "no extendChecked call sites found — the scan or the helper moved");
    assertEquals(
      SITES_AT_LOAD.length,
      calls.length,
      `${calls.length} \`extendChecked(\` call site(s) in src/, but ` +
        `${SITES_AT_LOAD.length} recorded at import. Either a site is behind a ` +
        `branch that module evaluation does not reach, or a module is not on the ` +
        `\`src/schemas/mod.ts\` barrel this test imports:\n` + show(calls),
    );
  });
});

// ── Arm 2: the value assertion ───────────────────────────────────────

/**
 * Every meta key registered anywhere on a node's wrapper chain.
 *
 * Chain-wide rather than instance-only because `.meta()` lands on whichever
 * builder it was chained onto — `z.string().meta(x).optional()` parks it on the
 * ZodString, `z.string().optional().meta(x)` on the ZodOptional. Both spellings
 * are in these schemas, and reading only one of them is exactly how `Address`'s
 * object-level `pii: "mask"` became a silent no-op.
 */
function metaKeysThroughChain(node: z.ZodType): string[] {
  const keys = new Set<string>();
  // deno-lint-ignore no-explicit-any
  let n: any = node;
  while (n?._zod?.def) {
    const entry = z.globalRegistry.get(n as z.ZodType);
    if (entry) for (const k of Object.keys(entry)) keys.add(k);
    const def = n._zod.def;
    if (def.innerType) n = def.innerType;
    else if (def.type === "pipe" && def.in) n = def.in;
    else break;
  }
  return [...keys];
}

Deno.test("meta preservation — no extension drops an annotation the base carried", () => {
  const lost: string[] = [];

  for (const [i, site] of SITES_AT_LOAD.entries()) {
    const label = `EXTENSION_SITES[${i}]`;

    // (a) object-level meta. Measured: `.extend()` drops this too, and an
    // object-level tag is how `Address` spells `pii: "mask"`.
    for (const key of metaKeysThroughChain(site.base)) {
      if (readMetaThroughWrappers(site.derived, key) === undefined) {
        lost.push(`${label} <object>.${key}`);
      }
    }

    // (b) per re-declared field. A key the extension ADDS has no base node, and
    // is correctly not checked.
    const baseShape = site.base.shape as Record<string, z.ZodType | undefined>;
    const derivedShape = site.derived.shape as Record<string, z.ZodType | undefined>;
    for (const key of site.keys) {
      const baseNode = baseShape[key];
      const derivedNode = derivedShape[key];
      if (!baseNode || !derivedNode) continue;
      for (const metaKey of metaKeysThroughChain(baseNode)) {
        const before = readMetaThroughWrappers(baseNode, metaKey);
        const after = readMetaThroughWrappers(derivedNode, metaKey);
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          lost.push(
            `${label} ${key}.${metaKey}: base ${JSON.stringify(before)} → derived ${JSON.stringify(after)}`,
          );
        }
      }
    }
  }

  assertEquals(
    lost.sort(),
    [],
    "An extension re-declared a field and did not restate an annotation the base " +
      "carried. `.extend()` REPLACES the node and `z.globalRegistry` is keyed on " +
      "the instance, so the tag is gone — silently. Restate it inside the " +
      "extension (as `product.ts`'s `AuthoredComponentSchema` does for `label`). " +
      "🔴 If the lost key is `pii`, the field is now unmasked in every log line " +
      "and every captured fixture:\n  " + lost.join("\n  "),
  );
});

// ── Arm 3: the walk can still see what it forbids ────────────────────

Deno.test("meta preservation — a planted drop is detected", async (t) => {
  const Base = z.strictObject({
    tagged: z.string().meta({ pii: "mask", label: "Tagged" }),
    wrapperTagged: z.string().optional().meta({ label: "Wrapper" }),
    untouched: z.string().meta({ label: "Untouched" }),
  }).meta({ label: "TheObject" });

  /** The same diff arm 2 runs, over one synthetic pair. */
  function diff(base: z.ZodObject, derived: z.ZodObject, keys: string[]): string[] {
    const out: string[] = [];
    for (const key of metaKeysThroughChain(base)) {
      if (readMetaThroughWrappers(derived, key) === undefined) out.push(`<object>.${key}`);
    }
    const bs = base.shape as Record<string, z.ZodType | undefined>;
    const ds = derived.shape as Record<string, z.ZodType | undefined>;
    for (const key of keys) {
      const b = bs[key], d = ds[key];
      if (!b || !d) continue;
      for (const mk of metaKeysThroughChain(b)) {
        if (
          JSON.stringify(readMetaThroughWrappers(d, mk)) !==
            JSON.stringify(readMetaThroughWrappers(b, mk))
        ) out.push(`${key}.${mk}`);
      }
    }
    return out;
  }

  await t.step("a dropped pii tag is reported", () => {
    const D = Base.extend({ tagged: z.string() });
    assert(diff(Base, D, ["tagged"]).includes("tagged.pii"), "the pii drop was not seen");
  });

  await t.step("a tag parked on a WRAPPER is reported", () => {
    const D = Base.extend({ wrapperTagged: z.string().optional() });
    assert(
      diff(Base, D, ["wrapperTagged"]).includes("wrapperTagged.label"),
      "a wrapper-level tag was missed — the chain walk regressed to instance-only",
    );
  });

  await t.step("a dropped OBJECT-level tag is reported", () => {
    const D = Base.extend({ tagged: z.string().meta({ pii: "mask", label: "Tagged" }) });
    assert(diff(Base, D, ["tagged"]).includes("<object>.label"), "the object-level drop was not seen");
  });

  await t.step("a CHANGED value is reported, not just an absent one", () => {
    const D = Base.extend({ tagged: z.string().meta({ pii: "none", label: "Tagged" }) });
    assert(
      diff(Base, D, ["tagged"]).includes("tagged.pii"),
      "`pii: mask` → `pii: none` is a downgrade to no masking and must not read as preserved",
    );
  });

  await t.step("a faithful restatement is NOT reported", () => {
    const D = Base.extend({ tagged: z.string().meta({ pii: "mask", label: "Tagged" }) })
      .meta({ label: "TheObject" });
    assertEquals(diff(Base, D, ["tagged"]), [], "a correct restatement was flagged");
  });

  await t.step("a NEWLY ADDED key is not reported (it has no base to lose)", () => {
    const D = Base.extend({ fresh: z.string() });
    assertEquals(
      diff(Base, D, ["fresh"]).filter((s) => s.startsWith("fresh.")),
      [],
      "an added key was treated as a re-declaration",
    );
  });

  await t.step("the helper itself records what it is handed", () => {
    const before = EXTENSION_SITES.length;
    extendChecked(Base, { tagged: z.string().meta({ pii: "mask", label: "Tagged" }) });
    assertEquals(EXTENSION_SITES.length, before + 1, "extendChecked did not record the site");
    const last = EXTENSION_SITES[EXTENSION_SITES.length - 1];
    assertEquals(last.keys, ["tagged"]);
    assert(last.base === (Base as unknown as z.ZodObject), "recorded the wrong base");
  });
});
