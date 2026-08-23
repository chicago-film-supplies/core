/**
 * The declaration gate: does every public symbol in `src/` have a type a
 * SYNTACTIC emitter can write down?
 *
 * ## Why this exists
 *
 * This package is consumed two ways, and only one of them type-checks against
 * this source. Deno consumers (api-cloudrun, templates) resolve the `.ts` from
 * JSR and infer exactly what `deno task check` infers here. npm consumers
 * (manager, via the `@jsr/cfs__core` shim) get a `.d.ts` that **JSR generates**,
 * and that generator does not run type inference — that is the whole point of
 * the `no-slow-types` rule.
 *
 * So a construct whose declared type needs inference to expand does not fail to
 * publish. It publishes a DIFFERENT, WRONG type, to npm consumers only. Nothing
 * that reads source can see it: the suite, `deno task check` and `deno publish
 * --dry-run` all read the source and all agree with each other.
 *
 * Two instances have shipped, both green through `deno publish --dry-run`:
 *
 * - **core#43** — `ITEM_TYPES = [...DOC_ITEM_TYPES, "order"] as const` published
 *   as `readonly ["order"]`, 9 members collapsed to 1. It took `ItemTypeType`,
 *   `LineItem.type` and `ITEM_CONTRACTS` with it: 57 of the 75 type errors on
 *   manager's `beta.88` → `beta.109` pin bump, none of them manager's.
 * - **core#44** — `parentable_by: LINE_PARENTS` inside an `as const` object
 *   published as `readonly parentable_by;`, a bare property signature with no
 *   type at all, on six arms of `beta.185`.
 *
 * ## What it does
 *
 * Runs TypeScript's `--isolatedDeclarations` over `src/`, which asks exactly the
 * right question: *can this declaration be emitted without inference?* It is a
 * conservative **over-approximation** of JSR's emitter, not a model of it — see
 * {@link EXEMPTIONS}, where a class it flags and JSR gets right is exempted with
 * a reason.
 *
 * ## Three traps, each of which has already cost time
 *
 * 1. 🔴 **`--noEmit` produces a silent false zero.** TypeScript collects
 *    declaration diagnostics only while emitting, so a `--noEmit` run reports
 *    **zero TS9xxx and exit 0** on a tree full of them. It does not look broken;
 *    it looks green. This gate really emits — into a **no-op `writeFile`**, so
 *    nothing reaches the disk. {@link assertGateIsLive} is the companion that
 *    stops that regressing: it plants the core#43 construct and fails if the
 *    gate does not catch it.
 * 2. 🔴 **`rootDir` decides where emit LANDS, and getting it wrong writes into
 *    the repo.** `tsc -p` with a config outside the tree emitted 183 `.d.ts`
 *    files into `src/` while developing this gate — tsc falls back to emitting
 *    beside the source for any file outside the inferred `rootDir`. That is the
 *    exact hazard `deno task test` was stripped of its write permission to
 *    prevent (see `CLAUDE.md` § Commands). Discarding emit in a callback makes
 *    it unrepresentable rather than merely configured-away, which is why this
 *    uses the compiler API instead of shelling out to `tsc`.
 * 3. ⚠️ **The error codes in circulation are wrong.** Verified against the
 *    shipped compiler: **TS9018** = spread in an array (the core#43 construct);
 *    **TS9010** = un-annotated variable, including `satisfies`; **TS9013** =
 *    "expression type can't be inferred", the code that flagged core#44 and the
 *    one missing from every prior write-up.
 *
 * ## Why it is a task and not a test
 *
 * `npm:typescript` reads `process.env` at load, so this needs `--allow-env`, and
 * `deno task test` is deliberately `--allow-read` only. Same reasoning as
 * `deno task check:generated`; see `CLAUDE.md` § Commands. It replaced the
 * now-deleted `jsr-emit-safety.test.ts`, whose single source-text regex matched
 * the core#43 construct but missed four other spellings of it and all three
 * other codes — two checks of one property, one provably weaker.
 *
 * Run: `deno task check:declarations`
 *
 * @module
 */
import ts from "typescript";

const REPO = new URL("../", import.meta.url);
const SRC = new URL("src/", REPO);

/** A declaration diagnostic, flattened to the fields this gate reasons about. */
export interface DeclarationDiagnostic {
  /** Repo-relative, e.g. `src/schemas/common.ts`. */
  file: string;
  line: number;
  column: number;
  /** The numeric part, e.g. `9013`. */
  code: number;
  message: string;
}

/**
 * A class of diagnostic this gate reports and we deliberately accept.
 *
 * Keyed on a **predicate over the source**, never on a line number. Both
 * write-ups of core#44 cited line numbers for these and both had rotted before
 * anyone acted on them — `schemas/common.ts:612-620` became `:686-698`, and
 * `utils/citations.ts:101,173` became `:115,187` inside a fortnight. A rule does not
 * rot, and it covers the next instance of its class for free: the regex-literal
 * class below grew from one member to three in a single day.
 */
export interface DeclarationExemption {
  id: string;
  reason: string;
  matches(diagnostic: DeclarationDiagnostic, source: string): boolean;
}

/**
 * Is the declaration reported at `line` a bare top-level regex literal?
 *
 * Exported for the self-test. The diagnostic points at the *identifier*, and a
 * formatter often puts a long literal on the following line, so this reads the
 * declaration head plus a short lookahead rather than the single reported line.
 */
export function isTopLevelRegexLiteral(source: string, line: number): boolean {
  const lines = source.split("\n");
  // 1-indexed diagnostic line, plus two lines of lookahead for a wrapped
  // initializer. Two is enough for a formatter's line break after `=`; a
  // literal further away than that is not the shape this rule describes.
  const head = lines.slice(line - 1, line + 2).join("\n");
  return /^export const [A-Za-z0-9_$]+\s*(?::[^=]+)?=\s*\//.test(head.trim());
}

/**
 * The accepted classes. Anything else is a failure.
 *
 * ⚠️ An entry that stops firing is itself a failure — see
 * {@link checkDeclarations}. A stale exemption silences a class nothing exhibits
 * any more, and `tests/template-helpers.test.ts` records what that costs: a
 * denylist entry naming a deleted function sat there for months, accounting for
 * nothing, invisible to the guard it was weakening.
 */
export const EXEMPTIONS: readonly DeclarationExemption[] = [
  {
    id: "internal-discriminated-union-arms",
    reason:
      "`src/schemas/_dividers.ts` is INTERNAL — not an entrypoint in `deno.json`'s " +
      "`exports`, so JSR never emits a declaration for it. Its consts carry no " +
      "annotation deliberately: a `z.discriminatedUnion` arm must expose " +
      "`_zod.propValues` at the type level and a `z.ZodType<T>` annotation erases it. " +
      "Annotating these would BREAK the unions rather than harden them; the module " +
      "docstring carries the full justification.",
    matches: (d) => d.file === "src/schemas/_dividers.ts",
  },
  {
    id: "top-level-regex-literal",
    reason:
      "A bare `export const X = /…/flags`. isolatedDeclarations is a conservative " +
      "over-approximation of JSR's emitter, not a model of it, and this is a class " +
      "where they disagree in our favour: JSR emits `RegExp` correctly (measured on " +
      "`MEDIA_CONTAINER_RE`). Stated as a rule rather than a file list because the " +
      "class grew from one member to three in a single day.",
    matches: (d, source) => d.code === 9010 && isTopLevelRegexLiteral(source, d.line),
  },
];

/** Every `.ts` file under `src/`, absolute. */
async function collectSources(dir: URL = SRC, out: string[] = []): Promise<string[]> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) await collectSources(child, out);
    else if (entry.name.endsWith(".ts")) out.push(child.pathname);
  }
  return out;
}

/**
 * The compiler options the gate runs under.
 *
 * ⚠️ `noEmit` stays **false** and emit is really performed — see trap 1 in the
 * module doc. `declarationDir`/`outDir` are absent on purpose: emit is captured
 * by a callback and never written, so there is no output path to get wrong
 * (trap 2).
 */
const OPTIONS: ts.CompilerOptions = {
  strict: true,
  declaration: true,
  isolatedDeclarations: true,
  emitDeclarationOnly: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.Preserve,
  target: ts.ScriptTarget.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: false,
};

/** Declaration diagnostics (TS9xxx) for a program, plus how many files emitted. */
function declarationDiagnostics(
  program: ts.Program,
  relativeTo: string,
): { diagnostics: DeclarationDiagnostic[]; emitted: number } {
  let emitted = 0;
  // The no-op sink. This is what makes the gate incapable of writing into the
  // repo, rather than merely configured not to.
  const result = program.emit(undefined, () => {
    emitted++;
  });

  const diagnostics: DeclarationDiagnostic[] = [];
  for (const d of result.diagnostics) {
    if (d.code < 9000 || d.code >= 10000) continue;
    if (!d.file || d.start === undefined) continue;
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    diagnostics.push({
      file: d.file.fileName.startsWith(relativeTo)
        ? d.file.fileName.slice(relativeTo.length)
        : d.file.fileName,
      line: line + 1,
      column: character + 1,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    });
  }
  diagnostics.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { diagnostics, emitted };
}

/**
 * A gate that cannot fail is not a gate.
 *
 * Compiles the exact core#43 construct from an in-memory source and asserts the
 * gate catches it, then compiles the safe form and asserts it does not. This is
 * the companion to trap 1: `--noEmit`, a bad `include`, or a future compiler
 * change would all turn this gate into a green light over a live defect, and
 * every one of those failure modes reports **zero diagnostics** — which is
 * indistinguishable from a clean tree unless something plants a dirty one.
 */
export function assertGateIsLive(): void {
  const cases: { name: string; source: string; expectCode: number | null }[] = [
    {
      name: "core#43: spread inside an `as const` array",
      source: `const A = ["x", "y"] as const;\nexport const B = [...A, "z"] as const;\n`,
      expectCode: 9018,
    },
    {
      name: "core#44: an identifier reference inside an `as const` object",
      source: `const P = ["a"];\nexport const T = { k: { p: P } } as const;\n`,
      expectCode: 9013,
    },
    {
      name: "the safe form must NOT trip it",
      source: `export const A = ["x", "y", "z"] as const;\n`,
      expectCode: null,
    },
  ];

  for (const testCase of cases) {
    const name = "/virtual/probe.ts";
    const sourceFile = ts.createSourceFile(name, testCase.source, ts.ScriptTarget.ESNext, true);
    const base = ts.createCompilerHost(OPTIONS);
    const host: ts.CompilerHost = {
      ...base,
      getSourceFile: (fileName, ...rest) =>
        fileName === name ? sourceFile : base.getSourceFile(fileName, ...rest),
      fileExists: (fileName) => fileName === name || base.fileExists(fileName),
      readFile: (fileName) => (fileName === name ? testCase.source : base.readFile(fileName)),
      writeFile: () => {},
    };

    const { diagnostics } = declarationDiagnostics(ts.createProgram([name], OPTIONS, host), "");

    if (testCase.expectCode === null) {
      if (diagnostics.length > 0) {
        throw new Error(
          `declaration gate self-test: "${testCase.name}" should be clean but reported ` +
            diagnostics.map((d) => `TS${d.code}`).join(", "),
        );
      }
      continue;
    }

    if (!diagnostics.some((d) => d.code === testCase.expectCode)) {
      throw new Error(
        `🔴 declaration gate self-test FAILED: "${testCase.name}" was not caught.\n` +
          `   Expected TS${testCase.expectCode}, got ${
            diagnostics.length === 0 ? "NOTHING" : diagnostics.map((d) => `TS${d.code}`).join(", ")
          }.\n` +
          `   The gate is not looking at what it claims to look at — a clean run below would be ` +
          `meaningless. See trap 1 in this module's doc.`,
      );
    }
  }
}

/** Result of one full gate run. */
export interface GateResult {
  sourceCount: number;
  emitted: number;
  exempt: { diagnostic: DeclarationDiagnostic; exemption: DeclarationExemption }[];
  unexpected: DeclarationDiagnostic[];
  /** Exemptions that matched nothing — stale, and a failure. */
  staleExemptions: DeclarationExemption[];
}

/** Run the gate over `src/`. */
export async function checkDeclarations(): Promise<GateResult> {
  const files = await collectSources();
  const program = ts.createProgram(files, {
    ...OPTIONS,
    // Emit is discarded by the callback below; this only affects the paths in
    // diagnostics, never anything on disk.
    writeFile: undefined,
  });

  const { diagnostics, emitted } = declarationDiagnostics(program, REPO.pathname);

  const sources = new Map<string, string>();
  const read = (file: string): string => {
    const cached = sources.get(file);
    if (cached !== undefined) return cached;
    const text = Deno.readTextFileSync(new URL(file, REPO));
    sources.set(file, text);
    return text;
  };

  const exempt: GateResult["exempt"] = [];
  const unexpected: DeclarationDiagnostic[] = [];
  const fired = new Set<string>();

  for (const diagnostic of diagnostics) {
    const exemption = EXEMPTIONS.find((e) => e.matches(diagnostic, read(diagnostic.file)));
    if (exemption) {
      exempt.push({ diagnostic, exemption });
      fired.add(exemption.id);
    } else {
      unexpected.push(diagnostic);
    }
  }

  return {
    sourceCount: files.length,
    emitted,
    exempt,
    unexpected,
    staleExemptions: EXEMPTIONS.filter((e) => !fired.has(e.id)),
  };
}

if (import.meta.main) {
  assertGateIsLive();

  const result = await checkDeclarations();

  // Belt and braces on trap 2. Emit goes to a callback that drops it, so this
  // cannot fire — which is the point of asserting it: if someone "helpfully"
  // reinstates an `outDir`, this is what says so.
  const strays: string[] = [];
  for await (const entry of Deno.readDir(SRC)) void entry;
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (entry.name.endsWith(".d.ts")) strays.push(child.pathname);
    }
  };
  await walk(SRC);

  let failed = false;

  if (result.unexpected.length > 0) {
    failed = true;
    console.error(
      `\n🔴 ${result.unexpected.length} declaration(s) in src/ cannot be emitted without ` +
        `inference.\n` +
        `   JSR will publish a WRONG type for these to npm consumers, and ` +
        `\`deno publish --dry-run\` will stay green on it.\n`,
    );
    for (const d of result.unexpected) {
      console.error(`   ${d.file}:${d.line}:${d.column}  TS${d.code}  ${d.message}`);
    }
    console.error(
      "\n   Fix: give the symbol an explicit type annotation. If the diagnostic sits on a " +
        "USE site\n   inside an `as const`, annotating the referenced const does NOT help — " +
        "the reference has to\n   leave the `as const` altogether (see `schemas/common.ts` " +
        "§ ITEM_CONTRACTS_INNER).\n",
    );
  }

  if (result.staleExemptions.length > 0) {
    failed = true;
    console.error(
      `\n🔴 ${result.staleExemptions.length} exemption(s) matched nothing — delete them.\n` +
        `   A stale exemption silences a class nothing exhibits any more, and is invisible ` +
        `to the gate it weakens.\n`,
    );
    for (const e of result.staleExemptions) console.error(`   ${e.id}`);
  }

  if (strays.length > 0) {
    failed = true;
    console.error(
      `\n🔴 ${strays.length} .d.ts file(s) under src/ — the gate wrote into the repo.\n` +
        `   Emit must go to the no-op callback; see trap 2 in scripts/check-declarations.ts.\n`,
    );
  }

  if (result.emitted === 0) {
    failed = true;
    console.error(
      `\n🔴 The program emitted nothing. A run that compiles no files reports zero ` +
        `diagnostics and looks clean.\n`,
    );
  }

  if (failed) Deno.exit(1);

  const byExemption = new Map<string, number>();
  for (const { exemption } of result.exempt) {
    byExemption.set(exemption.id, (byExemption.get(exemption.id) ?? 0) + 1);
  }
  console.log(
    `declarations: ${result.sourceCount} source files, ${result.emitted} declarations derivable, ` +
      `0 unexpected, ${result.exempt.length} exempt (` +
      [...byExemption].map(([id, n]) => `${id}:${n}`).join(", ") +
      `). Self-test passed — the gate caught the planted core#43 and core#44 constructs.`,
  );
}
