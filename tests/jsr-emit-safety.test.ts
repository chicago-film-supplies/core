/**
 * Source constructs that JSR's npm declaration emit gets WRONG — silently.
 *
 * This package is consumed two ways, and only one of them type-checks against
 * this source. Deno consumers (api-cloudrun, templates) resolve the `.ts` from
 * JSR and infer exactly what `deno task check` infers here. npm consumers
 * (manager, via the `@jsr/cfs__core` shim) get a `.d.ts` that **JSR generates**,
 * and that generator is syntactic — it emits declarations without running type
 * inference, which is the whole point of the no-slow-types rule.
 *
 * So a construct whose declared type needs inference to expand does not fail to
 * publish. It publishes a DIFFERENT, WRONG type, to npm consumers only. Nothing
 * else in this repo can see it: the suite, `deno task check` and
 * `deno publish --dry-run` all read the source and all agree with each other.
 *
 * core#43 is the instance that cost real time. `ITEM_TYPES` was
 * `[...DOC_ITEM_TYPES, "order"] as const` — 9 members here, correctly inferred by
 * both Deno and `tsc` 6.0.3 — and JSR published
 * `declare const ITEM_TYPES: readonly ["order"]`. `ItemTypeType` became the
 * single literal `"order"` for manager, taking `LineItem.type`, `ITEM_CONTRACTS`
 * and `ItemTypeEnum` with it: 57 of the 75 type errors on the `beta.88` →
 * `beta.109` pin bump, none of them manager's.
 *
 * This test bans the one construct known to degrade. It is deliberately a
 * source-text check rather than a type-level one: the defect is invisible to the
 * type system by construction, so a type-level assertion cannot express it.
 *
 * **If a new emit divergence turns up, add it here** rather than starting another
 * walker — this file is the home for "the published declaration disagrees with
 * the source".
 */
import { assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";

const SRC = new URL("../src/", import.meta.url);

/**
 * A spread inside an `as const` array literal.
 *
 * Matches `= [...X, "y"] as const` and `= [..."a", ...B] as const` across line
 * breaks, so the multi-line form a formatter produces is caught too. Narrow on
 * purpose: a spread in a plain (non-`as const`) array is fine, because its
 * declared type is a widened array the syntactic emitter can write down.
 */
const SPREAD_IN_AS_CONST = /=\s*\[[^\]]*\.\.\.[^\]]*\]\s*as\s+const/gs;

Deno.test("jsr-emit-safety: no spread inside an `as const` array in src/", async () => {
  const offenders: string[] = [];

  for await (const entry of walk(SRC, { exts: [".ts"], includeDirs: false })) {
    // Generated catalogs are emitted by our own scripts and hold no `as const`
    // arrays; skip them so a regenerate can never trip this.
    if (entry.path.includes(".generated.")) continue;
    const text = await Deno.readTextFile(entry.path);
    for (const match of text.matchAll(SPREAD_IN_AS_CONST)) {
      const line = text.slice(0, match.index).split("\n").length;
      const label = entry.path.slice(entry.path.indexOf("/src/") + 1);
      offenders.push(`${label}:${line} — ${match[0].replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }

  assertEquals(
    offenders,
    [],
    "A spread inside `as const` publishes a TRUNCATED tuple type to npm consumers " +
      "(core#43) while Deno consumers see the correct one. Write the members out and " +
      "add a bidirectional parity assertion against the derivation, as `ITEM_TYPES` in " +
      `src/schemas/common.ts does. Offenders:\n  ${offenders.join("\n  ")}`,
  );
});

Deno.test("jsr-emit-safety: the regex actually catches the core#43 construct", async () => {
  // A gate that cannot fail is not a gate. This pins the detector against the
  // exact source that shipped the defect, plus the multi-line form, and against
  // two shapes that must NOT trip it.
  const shouldMatch = [
    `const ITEM_TYPES = [...DOC_ITEM_TYPES, "order"] as const;`,
    `const X = [\n  ...A,\n  "b",\n] as const;`,
    `const Y = ["a", ...B] as const;`,
  ];
  for (const src of shouldMatch) {
    assertEquals(
      [...src.matchAll(SPREAD_IN_AS_CONST)].length > 0,
      true,
      `should have matched: ${src}`,
    );
  }

  const shouldNotMatch = [
    // No spread — the ordinary, safe form.
    `const DOC_ITEM_TYPES = ["rental", "destination"] as const;`,
    // Spread WITHOUT `as const`: the declared type is a widened array, which the
    // syntactic emitter can write down correctly.
    `const merged = [...a, ...b];`,
    // A spread in a function call, not an array literal being const-asserted.
    `const s = new Set([...a]);`,
  ];
  for (const src of shouldNotMatch) {
    assertEquals(
      [...src.matchAll(SPREAD_IN_AS_CONST)].length,
      0,
      `should NOT have matched: ${src}`,
    );
  }

  // And the real file must be clean now.
  const common = await Deno.readTextFile(new URL("schemas/common.ts", SRC));
  assertEquals([...common.matchAll(SPREAD_IN_AS_CONST)].length, 0);
});
