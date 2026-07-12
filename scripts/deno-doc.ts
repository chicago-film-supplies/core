/**
 * Shared `deno doc --json` plumbing.
 *
 * Two generators introspect the package's TypeScript surface through
 * `deno doc`: `generate-api-docs.ts` (API.md / API.json) and
 * `generate-template-helpers.ts` (the template editor's helper catalogue).
 * They need the same node model and the same type/param renderers, so those
 * live here rather than being duplicated (and drifting).
 *
 * Not to be confused with `generate-schema-template-fields.ts`, which walks the
 * **Zod** schema via `z.toJSONSchema()`. The two engines introspect different
 * surfaces on purpose: `deno doc` sees TS function signatures but not Zod
 * metadata (and would expose the PII paths the Zod walk hides), while the Zod
 * walk sees no function types at all. See that script's module doc.
 *
 * @module
 */

export type JsDocTag = {
  kind: string;
  name?: string;
  doc?: string;
  type?: string;
};

export type JsDoc = {
  doc?: string;
  tags?: JsDocTag[];
};

export type TsType = {
  repr?: string;
  kind?: string;
  value?: unknown;
};

export type Param = {
  kind: string;
  name?: string;
  optional?: boolean;
  tsType?: TsType;
};

export type Property = {
  name: string;
  optional?: boolean;
  readonly?: boolean;
  tsType?: TsType;
};

export type Method = {
  name: string;
  params?: Param[];
  returnType?: TsType;
};

export type Declaration = {
  declarationKind: "export" | "private";
  jsDoc?: JsDoc;
  kind: string;
  // deno-lint-ignore no-explicit-any
  def: any;
};

export type DocSymbol = {
  name: string;
  declarations: Declaration[];
};

export type FileNode = {
  module_doc?: JsDoc;
  symbols: DocSymbol[];
};

export type DocRoot = {
  version: number;
  nodes: Record<string, FileNode>;
};

/** Render a `deno doc` type node to a compact TypeScript-ish string. */
export function renderType(t: TsType | undefined): string {
  if (!t) return "unknown";

  // Composite shapes need to be walked before falling back to `repr`, because
  // deno doc leaves `repr` empty for unions/arrays/etc. and the bare `repr`
  // of a literal child strips the quotes/suffix we need.
  if (t.kind === "union" && Array.isArray(t.value)) {
    return (t.value as TsType[]).map(renderType).join(" | ");
  }
  if (t.kind === "intersection" && Array.isArray(t.value)) {
    return (t.value as TsType[]).map(renderType).join(" & ");
  }
  if (t.kind === "array" && t.value) {
    return `${renderType(t.value as TsType)}[]`;
  }
  if (t.kind === "tuple" && Array.isArray(t.value)) {
    return `[${(t.value as TsType[]).map(renderType).join(", ")}]`;
  }
  if (t.kind === "typeOperator" && t.value && typeof t.value === "object") {
    // `readonly string[]` — without this the bare `kind` leaks as "typeOperator".
    const op = t.value as { operator?: string; tsType?: TsType };
    if (op.operator && op.tsType) return `${op.operator} ${renderType(op.tsType)}`;
  }
  if (t.kind === "literal" && t.value && typeof t.value === "object") {
    const lit = t.value as { kind?: string; string?: string; number?: number; boolean?: boolean; bigInt?: string };
    if (lit.kind === "string" && typeof lit.string === "string") return JSON.stringify(lit.string);
    if (lit.kind === "number" && typeof lit.number === "number") return String(lit.number);
    if (lit.kind === "boolean" && typeof lit.boolean === "boolean") return String(lit.boolean);
    if (lit.kind === "bigInt" && typeof lit.bigInt === "string") return `${lit.bigInt}n`;
  }
  if (t.kind === "typeRef" && t.value && typeof t.value === "object") {
    const ref = t.value as { typeName?: string; typeParams?: TsType[] };
    const name = ref.typeName ?? t.repr ?? "unknown";
    if (ref.typeParams && ref.typeParams.length > 0) {
      return `${name}<${ref.typeParams.map(renderType).join(", ")}>`;
    }
    return name;
  }

  if (t.repr && t.repr !== "") return t.repr;
  return t.kind ?? "unknown";
}

/** Render one parameter as `name?: Type`. */
export function renderParam(p: Param): string {
  const name = p.name ?? "_";
  const opt = p.optional ? "?" : "";
  return `${name}${opt}: ${renderType(p.tsType)}`;
}

/** Render an interface declaration block. */
// deno-lint-ignore no-explicit-any
export function renderInterfaceDecl(name: string, def: any): string {
  const lines = [`interface ${name} {`];
  const props: Property[] = def.properties ?? [];
  for (const p of props) {
    const opt = p.optional ? "?" : "";
    const ro = p.readonly ? "readonly " : "";
    lines.push(`  ${ro}${p.name}${opt}: ${renderType(p.tsType)};`);
  }
  const methods: Method[] = def.methods ?? [];
  for (const m of methods) {
    const params = (m.params ?? []).map(renderParam).join(", ");
    lines.push(`  ${m.name}(${params}): ${renderType(m.returnType)};`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** All JSDoc tags of a given kind (`param`, `returns`, …). */
export function tagsOfKind(jsDoc: JsDoc | undefined, kind: string): JsDocTag[] {
  return (jsDoc?.tags ?? []).filter((t) => t.kind === kind);
}

/** Run `deno doc --json` against one entrypoint and parse the result. */
export async function runDenoDoc(file: string): Promise<DocRoot> {
  const cmd = new Deno.Command("deno", {
    args: ["doc", "--json", file],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    throw new Error(`deno doc ${file} failed with exit code ${code}`);
  }
  return JSON.parse(new TextDecoder().decode(stdout));
}
