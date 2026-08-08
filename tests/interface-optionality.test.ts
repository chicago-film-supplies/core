/**
 * Interface ↔ schema optionality drift.
 *
 * Every public schema in this package is annotated `z.ZodType<T>` against a
 * hand-written interface, which is what satisfies JSR's `no-slow-types`. That
 * annotation is checked in ONE direction only: `z.ZodType<T>` is assignable
 * when the schema *requires* a field the interface marks `?:`, because a
 * required field is a subtype of an optional one. So this compiles happily —
 *
 *     export interface Contact { updated_at?: FirestoreTimestampType }
 *     export const ContactSchema: z.ZodType<Contact> = z.strictObject({
 *       updated_at: FirestoreTimestamp,   // required — no error
 *     });
 *
 * — and every consumer of the published types is told `updated_at` may be
 * absent when in fact no valid document can omit it. Consumers then write
 * `doc.updated_at ?? fallback` branches for a case that cannot occur, or, worse,
 * build a create payload without it and only discover the mismatch at runtime
 * when `validateBeforeWrite` rejects the write.
 *
 * The bulk of the drift was `created_at?:` / `updated_at?:` — a leftover from
 * when those were written with `FieldValue.serverTimestamp()` and the interface
 * was loosened to let a writer omit them. `TimestampFields` has required them
 * for a long time; the interfaces never caught up.
 *
 * ## Why this parses source
 *
 * An interface is not a runtime value — there is nothing to reflect on. So the
 * gate reads `src/schemas/**.ts`, extracts each `export interface X { … }` body,
 * collects its depth-0 `key?:` members, binds it to its schema via
 * `export const C: z.ZodType<X>`, dynamically imports the module, and probes
 * `shape[key]`. A key the interface marks optional whose schema member rejects
 * `undefined` is drift.
 *
 * Only the simple `z.ZodType<Identifier>` binding form is followed. Anything
 * more elaborate is skipped rather than guessed at — a skipped binding is a
 * blind spot, not a false pass, and the alternative is a regex pretending to be
 * a type checker.
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

const SCHEMA_DIR = new URL("../src/schemas/", import.meta.url);

/**
 * Optional-in-interface members that are genuinely optional in the schema too,
 * or that we accept as declared. Keyed `"<File>.<Interface>.<field>"` with the
 * reason. Empty today — kept so a future genuine exception has a home with a
 * why attached, rather than being silently dropped from the walk.
 */
const ALLOWED_DRIFT: Record<string, string> = {};

// ── Source parsing ───────────────────────────────────────────────────

/**
 * Blank out comments so a `key?:` inside prose cannot be mistaken for a member.
 * Replaces with spaces rather than deleting, so byte offsets stay aligned with
 * the original — the brace matcher indexes into this string.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

/** Index just past the `}` matching the `{` at `open`. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Names of members declared `key?:` at the TOP level of an interface body.
 * Nested object literals, function signatures and generic arguments are all
 * tracked so a `?:` inside one is not attributed to the interface itself.
 */
function optionalMembers(body: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let lineStart = true;
  let token = "";

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth -= 1;

    if (ch === "\n" || ch === ";" || ch === ",") {
      lineStart = true;
      token = "";
      continue;
    }
    if (depth !== 0) continue;

    if (lineStart && /[A-Za-z0-9_$]/.test(ch)) {
      token += ch;
      continue;
    }
    if (token && ch === "?") {
      // Confirm the next non-space char is `:` — otherwise it is a ternary or
      // an optional-call, not a member declaration.
      let j = i + 1;
      while (j < body.length && /\s/.test(body[j])) j += 1;
      if (body[j] === ":") names.push(token);
      token = "";
      lineStart = false;
      continue;
    }
    if (!/\s/.test(ch)) {
      lineStart = false;
      token = "";
    }
  }

  return names;
}

/**
 * Depth-0 members whose declared type is an array of a single named type —
 * `key: X[]`, `key?: X[]`, `readonly key: X[]`, or `Array<X>`.
 *
 * Deliberately strict. A union, a nested literal or a multi-line type is
 * **skipped**, on the same principle as the binding walk above: a skipped
 * member is a blind spot, not a false pass, and the alternative is a regex
 * pretending to be a type checker.
 */
interface MemberDecl {
  name: string;
  optional: boolean;
  type: string;
}

/** Depth-0 `key: T` / `key?: T` declarations, with their raw type text. */
function memberDecls(body: string): MemberDecl[] {
  const out: MemberDecl[] = [];
  let depth = 0;
  let buf = "";

  const flush = () => {
    const m = /^\s*(?:readonly\s+)?([A-Za-z0-9_$]+)\s*(\?)?\s*:\s*(.+?)\s*$/.exec(buf);
    buf = "";
    if (m) out.push({ name: m[1], optional: m[2] === "?", type: m[3].trim() });
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth -= 1;

    // `X[]` closes its own bracket, so a member ending in `[]` is back at
    // depth 0 by the time the separator arrives.
    if (depth === 0 && (ch === ";" || ch === "\n")) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

/**
 * Members whose declared type is an array of a single named type —
 * `key: X[]`, `key?: X[]`, `readonly key: X[]`, or `Array<X>`.
 *
 * Deliberately strict. A union, a nested literal or a multi-line type is
 * **skipped**, on the same principle as the binding walk above: a skipped
 * member is a blind spot, not a false pass, and the alternative is a regex
 * pretending to be a type checker.
 */
function arrayMembers(body: string): { name: string; elementType: string }[] {
  const out: { name: string; elementType: string }[] = [];
  for (const { name, type } of memberDecls(body)) {
    const el = /^(?:readonly\s+)?([A-Za-z0-9_$]+)\[\]$/.exec(type) ??
      /^(?:Readonly)?Array<\s*([A-Za-z0-9_$]+)\s*>$/.exec(type);
    if (el) out.push({ name, elementType: el[1] });
  }
  return out;
}

interface Binding {
  file: string;
  interfaceName: string;
  constName: string;
  optionals: string[];
  arrays: { name: string; elementType: string }[];
}

/**
 * Every interface in the package → the members it marks `?:`.
 *
 * Package-wide rather than per-file, because an array's ELEMENT type usually
 * lives in a different module from the interface that holds the array.
 * A name declared in two files is **dropped**, not merged: merging would
 * invent an optional set belonging to neither and could report drift that does
 * not exist, and a false positive in a gate is how a gate gets disabled.
 */
const interfaceOptionals = new Map<string, Set<string>>();
const collidingNames = new Set<string>();
/** interface → members it re-declares WITHOUT `?` (an override tightens). */
const interfaceRequired = new Map<string, Set<string>>();
/** interface → the interfaces it extends. */
const interfaceExtends = new Map<string, string[]>();

/**
 * Optional members of `name`, following `extends`.
 *
 * ⚠️ **Without this the gate has a hole exactly where the bug lived.**
 * `AuthoredProductComponent extends ProductComponent` and overrides
 * `inclusion_type` to required; reading only an interface's own body would give
 * it an empty optional set, so every array of it would be skipped as
 * uninteresting — including the one the motivating defect was about.
 *
 * A base's optionals are inherited, then removed by any key the derived
 * interface re-declares as required, which is what an override means.
 */
function effectiveOptionals(name: string, seen = new Set<string>()): Set<string> {
  if (seen.has(name)) return new Set();
  seen.add(name);
  const own = interfaceOptionals.get(name);
  if (!own) return new Set();
  const acc = new Set(own);
  for (const base of interfaceExtends.get(name) ?? []) {
    if (collidingNames.has(base)) continue;
    for (const k of effectiveOptionals(base, seen)) acc.add(k);
  }
  for (const k of interfaceRequired.get(name) ?? []) acc.delete(k);
  return acc;
}

async function collectBindings(): Promise<Binding[]> {
  const bindings: Binding[] = [];
  interfaceOptionals.clear();
  collidingNames.clear();
  interfaceRequired.clear();
  interfaceExtends.clear();

  for await (const entry of Deno.readDir(SCHEMA_DIR)) {
    const targets: string[] = [];
    if (entry.isFile && entry.name.endsWith(".ts")) targets.push(entry.name);
    if (entry.isDirectory) {
      for await (const sub of Deno.readDir(new URL(`${entry.name}/`, SCHEMA_DIR))) {
        if (sub.isFile && sub.name.endsWith(".ts")) targets.push(`${entry.name}/${sub.name}`);
      }
    }

    for (const rel of targets) {
      const url = new URL(rel, SCHEMA_DIR);
      const src = stripComments(await Deno.readTextFile(url));

      // interface name → its depth-0 optional members + array-typed members
      const interfaces = new Map<string, string[]>();
      const arrays = new Map<string, { name: string; elementType: string }[]>();
      const ifaceRe = /export\s+interface\s+([A-Za-z0-9_$]+)([^{]*)\{/g;
      for (let m = ifaceRe.exec(src); m; m = ifaceRe.exec(src)) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        const close = matchBrace(src, open);
        if (close === -1) continue;
        const body = src.slice(open + 1, close);
        const opts = optionalMembers(body);
        interfaces.set(m[1], opts);
        arrays.set(m[1], arrayMembers(body));

        if (interfaceOptionals.has(m[1])) collidingNames.add(m[1]);
        interfaceOptionals.set(m[1], new Set(opts));
        interfaceRequired.set(
          m[1],
          new Set(memberDecls(body).filter((d) => !d.optional).map((d) => d.name)),
        );
        const ext = /extends\s+([^{]+)/.exec(m[2]);
        interfaceExtends.set(
          m[1],
          ext ? [...ext[1].matchAll(/[A-Za-z0-9_$]+/g)].map((x) => x[0]) : [],
        );
      }

      // `export const C: z.ZodType<Iface>` — the simple binding form only.
      const constRe =
        /export\s+const\s+([A-Za-z0-9_$]+)\s*:\s*z\.ZodType<\s*([A-Za-z0-9_$]+)\s*>/g;
      for (let m = constRe.exec(src); m; m = constRe.exec(src)) {
        const optionals = interfaces.get(m[2]);
        const arrayMems = arrays.get(m[2]) ?? [];
        if (!optionals) continue;
        if (optionals.length === 0 && arrayMems.length === 0) continue;
        bindings.push({
          file: rel,
          interfaceName: m[2],
          constName: m[1],
          optionals,
          arrays: arrayMems,
        });
      }
    }
  }

  return bindings;
}

function shapeOf(schema: unknown): Record<string, z.ZodType> | undefined {
  return (schema as { _zod?: { def?: { shape?: Record<string, z.ZodType> } } })
    ?._zod?.def?.shape;
}

Deno.test("no interface member is optional while its schema member is required", async () => {
  const bindings = await collectBindings();

  // A gate that binds nothing passes vacuously. Pin a floor so a regex that
  // stops matching (a refactor to `satisfies`, a rename) fails loudly instead
  // of going quietly green.
  assertEquals(
    bindings.length > 30,
    true,
    `Only ${bindings.length} interface↔schema bindings were found; the source ` +
      `parser has probably stopped matching. Expected well over 30.`,
  );

  const violations: string[] = [];

  for (const binding of bindings) {
    const mod = await import(new URL(binding.file, SCHEMA_DIR).href);
    const shape = shapeOf(mod[binding.constName]);
    if (!shape) continue;

    for (const key of binding.optionals) {
      const member = shape[key];
      if (!member) continue;
      if (member.safeParse(undefined).success) continue;

      const id = `${binding.file}.${binding.interfaceName}.${key}`;
      if (id in ALLOWED_DRIFT) continue;
      violations.push(`${id} — interface says \`${key}?:\`, ${binding.constName} requires it`);
    }
  }

  violations.sort();
  assertEquals(
    violations,
    [],
    "These interface members are declared optional but their schema rejects " +
      "`undefined`, so no valid document can actually omit them. Consumers of " +
      "the published types are told the field may be absent when it cannot be.\n\n" +
      "Fix by deleting the `?` on the interface member. (If the field really " +
      "should be omittable, make the SCHEMA optional instead — but check the " +
      "Typesense parity gate first, since that is how the last round of " +
      "un-indexable documents happened.)\n\n" +
      violations.map((v) => `  ${v}`).join("\n"),
  );
});

Deno.test("no stale ALLOWED_DRIFT entry", async () => {
  const bindings = await collectBindings();
  const live = new Set<string>();

  for (const binding of bindings) {
    const mod = await import(new URL(binding.file, SCHEMA_DIR).href);
    const shape = shapeOf(mod[binding.constName]);
    if (!shape) continue;
    for (const key of binding.optionals) {
      const member = shape[key];
      if (member && !member.safeParse(undefined).success) {
        live.add(`${binding.file}.${binding.interfaceName}.${key}`);
      }
    }
  }

  const stale = Object.keys(ALLOWED_DRIFT).filter((k) => !live.has(k)).sort();
  assertEquals(
    stale,
    [],
    `These ALLOWED_DRIFT entries no longer describe real drift:\n${stale.join("\n")}`,
  );
});

// ── Array ELEMENT drift (core#42) ────────────────────────────────────

/**
 * The same drift one level down, where the field-level gate above is blind.
 *
 * `z.ZodType<T>` is assignable in one direction, and that holds for array
 * elements too: if `AuthoredProductComponent` is assignable to
 * `ProductComponent`, then `z.array(AuthoredComponentSchema)` satisfies
 * `z.ZodType<{ components?: ProductComponent[] }>` and nothing complains. The
 * gate above cannot see it either, because the **field** `components?:` really
 * is optional on both sides — the disagreement is inside the element.
 *
 * The instance (`10.0.0-beta.104`, fixed by hand in beta.105):
 *
 *     export interface CreateProductInputType {
 *       components?: ProductComponent[];        // inclusion_type optional
 *     }
 *     export const CreateProductInput: z.ZodType<CreateProductInputType> = z.object({
 *       components: z.array(AuthoredComponentSchema).optional(),  // requires it
 *     });
 *
 * Consequence is identical to the field-level case: a consumer is told an
 * element key may be omitted when no valid payload can omit it, and finds out
 * when `validateBeforeWrite` rejects the write.
 *
 * ## What this compares, and why it is not the issue's sketch
 *
 * The sketch resolved the element type to its own `z.ZodType<X>` binding and
 * diffed two schemas. This compares the schema's array element against the
 * **interface** element's optional set directly — one fewer resolution step,
 * no dependency on the element type having its own exported binding (several
 * do not), and it is the published claim a consumer actually reads.
 */
const ALLOWED_ELEMENT_DRIFT: Record<string, string> = {};

/** Unwrap optional/nullable/default/pipe wrappers down to an array's element. */
function arrayElementOf(schema: unknown): unknown {
  let cur = schema;
  for (let i = 0; i < 8 && cur; i++) {
    const def = (cur as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;
    if (!def) return undefined;
    if (def.type === "array") return def.element;
    cur = def.innerType ?? def.in ?? undefined;
  }
  return undefined;
}

Deno.test("no interface array ELEMENT is looser than the schema's element", async () => {
  const bindings = await collectBindings();
  const violations: string[] = [];
  let elementsChecked = 0;

  for (const binding of bindings) {
    if (binding.arrays.length === 0) continue;
    const mod = await import(new URL(binding.file, SCHEMA_DIR).href);
    const shape = shapeOf(mod[binding.constName]);
    if (!shape) continue;

    for (const { name, elementType } of binding.arrays) {
      // An element type declared in two modules is a blind spot, not a guess.
      if (collidingNames.has(elementType)) continue;
      const declaredOptional = effectiveOptionals(elementType);
      if (declaredOptional.size === 0) continue;

      const member = shape[name];
      if (!member) continue;
      const elementShape = shapeOf(arrayElementOf(member));
      if (!elementShape) continue;

      elementsChecked += 1;

      for (const key of declaredOptional) {
        const inner = elementShape[key];
        if (!inner) continue;
        if (inner.safeParse(undefined).success) continue;

        const id = `${binding.file}.${binding.interfaceName}.${name}[].${key}`;
        if (id in ALLOWED_ELEMENT_DRIFT) continue;
        violations.push(
          `${id} — \`${elementType}\` says \`${key}?:\`, but ${binding.constName}'s ` +
            `element schema requires it`,
        );
      }
    }
  }

  console.log(`  array elements resolved to a schema shape: ${elementsChecked}`);

  // Non-vacuity, asserted separately from correctness: a parser that stops
  // matching `key: X[]`, or an unwrap that stops finding the element, reports
  // zero violations and looks exactly like success.
  assertEquals(
    elementsChecked > 10,
    true,
    `Only ${elementsChecked} array elements were resolved to a schema shape; the ` +
      `member parser or the array unwrap has probably stopped matching. This ` +
      `assertion exists because a walker that reaches nothing passes forever.`,
  );

  violations.sort();
  assertEquals(
    violations,
    [],
    "These interface array ELEMENTS declare a key optional that the schema's " +
      "element requires. The field-level gate cannot see this — the field itself " +
      "is optional on both sides, and `z.ZodType<T>` accepts a stricter element " +
      "because a required key is a subtype of an optional one.\n\n" +
      "Fix by pointing the interface member at the element type the schema " +
      "actually builds (e.g. `AuthoredProductComponent[]` rather than " +
      "`ProductComponent[]`), not by loosening the schema.\n\n" +
      violations.map((v) => `  ${v}`).join("\n"),
  );
});
