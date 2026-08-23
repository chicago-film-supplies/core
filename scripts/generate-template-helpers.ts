#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

/**
 * Generates the template editor's helper catalogue from `deno doc --json`.
 *
 * Emits `src/schemas/template-helpers.generated.ts` — committed, not gitignored —
 * as `Record<namespace, TemplateHelperEntry[]>`, where each entry carries the
 * name, the call expression, the JSDoc summary, and (the point of the exercise)
 * the **return type**, so a template author can see that
 * `it.orders.getGroupTotals(...)` yields a `GroupTotalsResult` without reading
 * `@cfs/core` source.
 *
 * Every `./utils/*` entrypoint is walked, not just the injectable ones — it is
 * cheap, and a new source/target collection then needs no generator change. The
 * editor panel only renders the namespaces `availableUtilNamespaces()` resolves
 * for the template's collections.
 *
 * Exports listed in `template-helper-denylist.ts` are omitted; see that module
 * for the cross-namespace union rule that keeps order write-path helpers out of
 * `it.invoices`.
 *
 * Return types are rendered as **labels** (`GroupTotalsResult`, `OrderTotals`).
 * Expanding a same-file `typeRef` one level into its member shape is a
 * follow-up — it must not cross a schema-aliased boundary without applying the
 * same `pii: "redact"` omission the schema walk uses.
 *
 * Run: deno task generate-template-helpers
 *
 * Pass `--stdout` to print the file instead of writing it. That mode is what
 * `deno task check:generated` diffs against the committed copy, so the
 * staleness gate never has to write into `src/` to prove the file is current.
 *
 * ⚠️ Unlike its sibling `generate-schema-template-fields.ts`, the render here
 * cannot be a pure function: {@link runDenoDoc} spawns `deno doc`, so this
 * generator irreducibly needs `--allow-run`. That is why its staleness check
 * lives in `deno task check:generated` and NOT in the test suite — `deno task
 * test` deliberately runs without `--allow-run`, and a test that spawned this
 * would hand the child write access the test process itself does not have.
 */
import { type Declaration, type DocSymbol, type Param, renderType, runDenoDoc } from "./deno-doc.ts";
import { TEMPLATE_HELPER_DENYLIST } from "./template-helper-denylist.ts";

interface TemplateHelperEntry {
  name: string;
  expr: string;
  desc: string;
  returns: string;
}

/** `./utils/orders` → `orders`; `src/utils/orders.ts` → `orders`. */
function namespaceOf(path: string): string {
  return path.split("/").pop()!.replace(/\.ts$/, "");
}

/**
 * First paragraph of a JSDoc block, flattened to one line — the panel shows a
 * one-liner, and the tail of these docs is usually rationale for maintainers.
 */
function summarize(doc: string | undefined): string {
  if (!doc) return "";
  const [firstParagraph] = doc.trim().split(/\n\s*\n/);
  return firstParagraph.replace(/\s+/g, " ").trim();
}

/** `it.orders.getGroupTotals(items, index, taxes)` */
function callExpr(namespace: string, name: string, params: Param[]): string {
  const args = params.map((p, i) => p.name ?? `arg${i + 1}`).join(", ");
  return `it.${namespace}.${name}(${args})`;
}

/**
 * Denylist for a symbol as consumed under `namespace`, unioned with the
 * denylist of the module the symbol is actually **declared** in. That is what
 * suppresses `utils/orders.ts`'s write-path helpers under `it.invoices`, which
 * re-exports them, without dropping the re-exports that are render-useful.
 */
function isDenied(namespace: string, name: string, declaration: Declaration): boolean {
  if (TEMPLATE_HELPER_DENYLIST[namespace]?.includes(name)) return true;

  const filename = (declaration as { location?: { filename?: string } }).location?.filename;
  if (!filename) return false;
  const origin = namespaceOf(filename);
  if (origin === namespace) return false;

  return TEMPLATE_HELPER_DENYLIST[origin]?.includes(name) ?? false;
}

/** Exported function declarations of a symbol (skips types/constants). */
function functionDeclarations(symbol: DocSymbol): Declaration[] {
  return symbol.declarations.filter(
    (d) => d.declarationKind === "export" && d.kind === "function",
  );
}

/**
 * Walk every `./utils/*` entrypoint and collect its renderable helpers.
 *
 * Split out from {@link renderTemplateHelpers} so the CLI can report what it
 * found without re-deriving it from the rendered text.
 */
export async function buildTemplateHelperCatalogue(): Promise<Record<string, TemplateHelperEntry[]>> {
  const denoJson = JSON.parse(await Deno.readTextFile("deno.json")) as {
    exports: Record<string, string>;
  };

  const utilEntrypoints = Object.entries(denoJson.exports)
    .filter(([exportPath]) => exportPath.startsWith("./utils/"));

  const catalogue: Record<string, TemplateHelperEntry[]> = {};

  for (const [exportPath, file] of utilEntrypoints) {
    const namespace = namespaceOf(exportPath);
    const root = await runDenoDoc(file);
    const fileNode = Object.values(root.nodes)[0];
    if (!fileNode) continue;

    const entries: TemplateHelperEntry[] = [];

    for (const symbol of fileNode.symbols ?? []) {
      for (const declaration of functionDeclarations(symbol)) {
        if (isDenied(namespace, symbol.name, declaration)) continue;

        const params: Param[] = declaration.def.params ?? [];
        entries.push({
          name: symbol.name,
          expr: callExpr(namespace, symbol.name, params),
          desc: summarize(declaration.jsDoc?.doc),
          returns: renderType(declaration.def.returnType),
        });
      }
    }

    // Sorted so the output is deterministic (the staleness gate byte-compares).
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    catalogue[namespace] = entries;
  }

  return catalogue;
}

/**
 * Render the whole generated module as a string.
 *
 * Exported so the write and the staleness diff share one code path. It is not
 * pure — {@link runDenoDoc} spawns a subprocess — which is precisely the reason
 * the staleness check is a task rather than a test; see the module doc.
 */
export async function renderTemplateHelpers(
  built?: Record<string, TemplateHelperEntry[]>,
): Promise<string> {
  const catalogue = built ?? await buildTemplateHelperCatalogue();

  const namespaces = Object.keys(catalogue).sort();
  const blocks = namespaces.map((namespace) => {
    const rows = catalogue[namespace]
      .map((e) =>
        `    { name: ${JSON.stringify(e.name)}, expr: ${JSON.stringify(e.expr)}, desc: ${
          JSON.stringify(e.desc)
        }, returns: ${JSON.stringify(e.returns)} },`
      )
      .join("\n");
    return `  ${JSON.stringify(namespace)}: [\n${rows}\n  ]`;
  });

  const output = `// AUTO-GENERATED by scripts/generate-template-helpers.ts — do not edit manually.

/** One callable helper in the template editor's helper panel. */
export interface TemplateHelperEntry {
  /** Function name — matches the real \`@cfs/core/utils\` export. */
  name: string;
  /** Expression as written in a template, e.g. \`it.orders.getGroupTotals(items, index, taxes)\`. */
  expr: string;
  /** One-line summary, from the function's JSDoc. */
  desc: string;
  /** Rendered TypeScript return type, e.g. \`GroupTotalsResult\`. */
  returns: string;
}

/**
 * Helper catalogue keyed by utils namespace — \`templateHelpers["orders"]\` is what
 * a template calls as \`it.orders.*\`.
 *
 * Generated for every \`./utils/*\` entrypoint; which of them a given template can
 * actually call is resolved from its collections by \`availableUtilNamespaces()\`
 * in \`./template-context.ts\`.
 */
export const templateHelpers: Record<string, TemplateHelperEntry[]> = {
${blocks.join(",\n")},
};
`;

  return output;
}

if (import.meta.main) {
  const catalogue = await buildTemplateHelperCatalogue();
  const output = await renderTemplateHelpers(catalogue);

  if (Deno.args.includes("--stdout")) {
    // Bare stdout, so the caller can pipe it straight into `diff`.
    await Deno.stdout.write(new TextEncoder().encode(output));
  } else {
    const outPath = new URL("../src/schemas/template-helpers.generated.ts", import.meta.url);
    await Deno.writeTextFile(outPath, output);

    const namespaces = Object.keys(catalogue).sort();
    const total = namespaces.reduce((n, ns) => n + catalogue[ns].length, 0);
    console.log(
      `Wrote ${outPath.pathname} — ${total} helpers across ${namespaces.length} namespaces ` +
        `(${namespaces.map((ns) => `${ns}:${catalogue[ns].length}`).join(", ")})`,
    );
  }
}
