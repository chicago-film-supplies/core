#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write

/**
 * Generates `API.md` and `API.json` at the repo root from `deno doc --json`
 * output across all package entrypoints listed in `deno.json`.
 *
 * Output must be deterministic: no absolute paths, no timestamps, symbols
 * sorted alphabetically within each entrypoint, entrypoints rendered in
 * the order declared in deno.json. The JSON file mirrors the markdown
 * structure so consumers can pick whichever format suits them.
 */

import {
  type DocSymbol,
  renderInterfaceDecl,
  renderParam,
  renderType,
  runDenoDoc,
  tagsOfKind,
} from "./deno-doc.ts";

// Intermediate model — consumed by both markdown and JSON emitters so the
// two outputs stay in lockstep.

type FunctionSummary = {
  kind: "function";
  name: string;
  signature: string;
  doc: string;
  paramTags: { name: string; doc: string }[];
  returnsTag: string | null;
};

type DeclaredSummary = {
  kind: "typeAlias" | "interface" | "variable";
  name: string;
  declaration: string;
  doc: string;
};

type OtherSummary = {
  kind: "other";
  name: string;
  declaredKind: string;
  doc: string;
};

type SymbolSummary = FunctionSummary | DeclaredSummary | OtherSummary;

type EntrypointSummary = {
  entrypoint: string;
  moduleDoc: string;
  symbols: SymbolSummary[];
};

// deno-lint-ignore no-explicit-any
function renderFunctionSig(name: string, def: any): string {
  const params = (def.params ?? []).map(renderParam).join(", ");
  const ret = renderType(def.returnType);
  return `${name}(${params}): ${ret}`;
}

function summarize(sym: DocSymbol): SymbolSummary[] {
  const out: SymbolSummary[] = [];
  for (const decl of sym.declarations) {
    if (decl.declarationKind !== "export") continue;
    const doc = decl.jsDoc?.doc?.trim() ?? "";

    switch (decl.kind) {
      case "function": {
        const paramTags = tagsOfKind(decl.jsDoc, "param").map((t) => ({
          name: t.name ?? "",
          doc: (t.doc ?? "").trim(),
        }));
        const returnTags = [
          ...tagsOfKind(decl.jsDoc, "return"),
          ...tagsOfKind(decl.jsDoc, "returns"),
        ];
        out.push({
          kind: "function",
          name: sym.name,
          signature: renderFunctionSig(sym.name, decl.def),
          doc,
          paramTags,
          returnsTag: returnTags[0]?.doc?.trim() ?? null,
        });
        break;
      }
      case "typeAlias":
        out.push({
          kind: "typeAlias",
          name: sym.name,
          declaration: `type ${sym.name} = ${renderType(decl.def.tsType)};`,
          doc,
        });
        break;
      case "interface":
        out.push({
          kind: "interface",
          name: sym.name,
          declaration: renderInterfaceDecl(sym.name, decl.def),
          doc,
        });
        break;
      case "variable":
        out.push({
          kind: "variable",
          name: sym.name,
          declaration: `${decl.def.kind ?? "const"} ${sym.name}: ${renderType(decl.def.tsType)};`,
          doc,
        });
        break;
      default:
        out.push({
          kind: "other",
          name: sym.name,
          declaredKind: decl.kind,
          doc,
        });
    }
  }
  return out;
}

function renderSymbolMarkdown(s: SymbolSummary): string {
  switch (s.kind) {
    case "function": {
      const lines: string[] = [`### \`${s.signature}\``, ""];
      if (s.doc) {
        lines.push(s.doc);
        lines.push("");
      }
      if (s.paramTags.length > 0) {
        lines.push("**Parameters**");
        lines.push("");
        for (const t of s.paramTags) {
          lines.push(`- \`${t.name}\`${t.doc ? ` — ${t.doc}` : ""}`);
        }
        lines.push("");
      }
      if (s.returnsTag) {
        lines.push(`**Returns** — ${s.returnsTag}`);
        lines.push("");
      }
      return lines.join("\n");
    }
    case "typeAlias":
    case "interface":
    case "variable": {
      const lines: string[] = [`### \`${s.name}\``, ""];
      if (s.doc) {
        lines.push(s.doc);
        lines.push("");
      }
      lines.push("```ts");
      lines.push(s.declaration);
      lines.push("```");
      lines.push("");
      return lines.join("\n");
    }
    case "other":
      return `### \`${s.name}\`\n\n_(${s.declaredKind} — see source)_\n`;
  }
}

function renderMarkdown(
  pkgName: string,
  entrypoints: EntrypointSummary[],
): string {
  const sections: string[] = [];
  sections.push(`# \`${pkgName}\` API Reference`);
  sections.push("");
  sections.push(
    `_Generated from source by \`scripts/generate-api-docs.ts\` — do not edit by hand. A structured companion is emitted alongside as \`API.json\`. Browsable version on [JSR](https://jsr.io/${pkgName}/doc/all_symbols)._`,
  );
  sections.push("");

  for (const ep of entrypoints) {
    sections.push(`## \`${ep.entrypoint}\``);
    sections.push("");
    if (ep.moduleDoc) {
      sections.push(ep.moduleDoc);
      sections.push("");
    }
    for (const s of ep.symbols) sections.push(renderSymbolMarkdown(s));
  }

  return sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function renderJson(
  pkgName: string,
  entrypoints: EntrypointSummary[],
): string {
  return JSON.stringify(
    {
      package: pkgName,
      generator: "scripts/generate-api-docs.ts",
      entrypoints,
    },
    null,
    2,
  ) + "\n";
}

async function main(): Promise<void> {
  const denoJson = JSON.parse(await Deno.readTextFile("deno.json")) as {
    name: string;
    exports: Record<string, string>;
  };
  const pkgName = denoJson.name;

  const entrypoints: EntrypointSummary[] = [];
  for (const [exportPath, file] of Object.entries(denoJson.exports)) {
    const entrypoint = `${pkgName}${exportPath.slice(1)}`;
    const root = await runDenoDoc(file);
    const fileNode = Object.values(root.nodes)[0];
    if (!fileNode) continue;

    const symbols = (fileNode.symbols ?? [])
      .flatMap(summarize)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    entrypoints.push({
      entrypoint,
      moduleDoc: fileNode.module_doc?.doc?.trim() ?? "",
      symbols,
    });
  }

  const md = renderMarkdown(pkgName, entrypoints);
  const json = renderJson(pkgName, entrypoints);

  await Deno.writeTextFile("API.md", md);
  await Deno.writeTextFile("API.json", json);
  console.error(`Wrote API.md (${md.length} bytes), API.json (${json.length} bytes)`);
}

await main();
