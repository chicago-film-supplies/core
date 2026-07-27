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

interface Binding {
  file: string;
  interfaceName: string;
  constName: string;
  optionals: string[];
}

async function collectBindings(): Promise<Binding[]> {
  const bindings: Binding[] = [];

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

      // interface name → its depth-0 optional members
      const interfaces = new Map<string, string[]>();
      const ifaceRe = /export\s+interface\s+([A-Za-z0-9_$]+)[^{]*\{/g;
      for (let m = ifaceRe.exec(src); m; m = ifaceRe.exec(src)) {
        const open = src.indexOf("{", m.index + m[0].length - 1);
        const close = matchBrace(src, open);
        if (close === -1) continue;
        interfaces.set(m[1], optionalMembers(src.slice(open + 1, close)));
      }

      // `export const C: z.ZodType<Iface>` — the simple binding form only.
      const constRe =
        /export\s+const\s+([A-Za-z0-9_$]+)\s*:\s*z\.ZodType<\s*([A-Za-z0-9_$]+)\s*>/g;
      for (let m = constRe.exec(src); m; m = constRe.exec(src)) {
        const optionals = interfaces.get(m[2]);
        if (!optionals || optionals.length === 0) continue;
        bindings.push({
          file: rel,
          interfaceName: m[2],
          constName: m[1],
          optionals,
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
