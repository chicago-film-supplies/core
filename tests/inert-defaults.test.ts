/**
 * `.default(x).optional()` — the wrapper order that makes the default dead.
 *
 * `Optional(Default(x))` short-circuits on `undefined` **at the outer node**, so
 * the inner `.default(x)` is never consulted and the value it names can never be
 * produced by a parse. The declaration reads as a guarantee and is inert.
 *
 * That is the same defect `schemas/initial.ts` records from the other side —
 * "a `.default()` never materializes on a write, which let a doc reach Typesense
 * missing a field the index declares required" — but one step worse: there, the
 * default at least fires on a *parse*. Under an outer `.optional()` it fires
 * nowhere at all.
 *
 * 21 document-schema declarations carried it (49 resolved paths, because
 * `Address` is shared) and 2 input-schema ones. Every one named the value its
 * own leaf type already derives (`[]` for an array, `""` for a string), so
 * `getInitialValues` — which reads `.default()` as the form seed — was proven
 * byte-identical across all 252 exported schemas before and after their removal.
 *
 * ## What to write instead
 *
 * - The field may genuinely be absent → **`.optional()` alone.** That is this
 *   removal.
 * - Every document must carry it → **`.default(x)` alone**, and then measure the
 *   corpus first, because a `.default()` does not backfill a stored document.
 * - The form needs a seed the parse must not supply → **`.meta({ initial: x })`**
 *   (`schemas/initial.ts`), which is exactly the split that note describes.
 *
 * The walk is deliberately structural and covers every container this package
 * uses. A ratchet with a hole reports CLEAN rather than smaller, so the
 * companion test below plants the construct and fails if the walk cannot see it.
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import * as barrel from "../src/schemas/mod.ts";

/** The wrapper spellings that carry a value a parse could produce. */
const VALUE_WRAPPERS: ReadonlySet<string> = new Set(["default", "prefault"]);

// deno-lint-ignore no-explicit-any
function defOf(node: any): any {
  return node?._zod?.def;
}

function isZodNode(value: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const v = value as any;
  return !!v && typeof v === "object" && !!v._zod?.def && typeof v.safeParse === "function";
}

/**
 * Every `Optional(Default(x))` under `root`, reported as a dotted path.
 *
 * Traverses wrappers, objects, arrays, tuples, unions, records, maps, sets,
 * intersections, pipes and `lazy`. `stack` holds the nodes on the CURRENT
 * path, so it breaks cycles without hiding re-embeddings. ⚠️ It was a
 * walk-global identity set until 2026-09-10, on the reasoning that *".meta()
 * clones, so two annotated instances of one block are visited separately."*
 * True, and one level short: the clone is SHALLOW, so both legs of a
 * destination pair share the very same inner `Address` node and the dedupe bit
 * there instead. See `tests/stored-defaults.test.ts`, which the same hole cost
 * 47 catalogued paths.
 */
// deno-lint-ignore no-explicit-any
function findInert(root: any, prefix: string, stack: Set<unknown>, out: string[]): void {
  if (!isZodNode(root) || stack.has(root)) return;
  stack.add(root);
  try {
    walkInertInto(root, prefix, stack, out);
  } finally {
    stack.delete(root);
  }
}

/**
 * The body of {@link findInert}. Never call it directly — the cycle guard lives in
 * the wrapper so no `return` inside the switch can skip the paired
 * `stack.delete`.
 */
// deno-lint-ignore no-explicit-any
function walkInertInto(root: any, prefix: string, stack: Set<unknown>, out: string[]): void {

  const def = defOf(root);
  const type: string = def.type;

  if (type === "optional") {
    // Peel any further wrappers between the optional and the value one — a
    // `.default(x).nullable().optional()` is inert for the same reason.
    // deno-lint-ignore no-explicit-any
    let inner: any = def.innerType;
    while (isZodNode(inner)) {
      const t = defOf(inner).type;
      if (VALUE_WRAPPERS.has(t)) {
        out.push(prefix || "<root>");
        break;
      }
      if (t === "nullable" || t === "readonly") inner = defOf(inner).innerType;
      else break;
    }
  }

  switch (type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "nonoptional":
    case "catch":
    case "promise":
      findInert(def.innerType ?? def.in, prefix, stack, out);
      return;
    case "pipe":
      findInert(def.in, prefix, stack, out);
      findInert(def.out, prefix, stack, out);
      return;
    case "lazy":
      findInert(def.getter(), prefix, stack, out);
      return;
    case "object":
    case "interface":
      for (const [key, member] of Object.entries(def.shape ?? {})) {
        findInert(member, prefix ? `${prefix}.${key}` : key, stack, out);
      }
      return;
    case "array":
      findInert(def.element, `${prefix}[]`, stack, out);
      return;
    case "set":
      findInert(def.valueType, `${prefix}{set}`, stack, out);
      return;
    case "tuple":
      (def.items ?? []).forEach((item: unknown, i: number) => findInert(item, `${prefix}[${i}]`, stack, out));
      if (def.rest) findInert(def.rest, `${prefix}[...]`, stack, out);
      return;
    case "union":
      (def.options ?? []).forEach((opt: unknown, i: number) => findInert(opt, `${prefix}|${i}`, stack, out));
      return;
    case "intersection":
      findInert(def.left, prefix, stack, out);
      findInert(def.right, prefix, stack, out);
      return;
    case "record":
    case "map":
      findInert(def.keyType, `${prefix}{key}`, stack, out);
      findInert(def.valueType, `${prefix}{}`, stack, out);
      return;
    default:
      return;
  }
}

/** Scan every exported schema on the barrel, deduplicated by declaration path. */
function scanBarrel(): string[] {
  const found = new Set<string>();
  for (const [name, value] of Object.entries(barrel)) {
    if (!isZodNode(value)) continue;
    const out: string[] = [];
    findInert(value, "", new Set(), out);
    for (const path of out) found.add(`${name}.${path}`);
  }
  return [...found].sort();
}

Deno.test("no schema declares a default the outer .optional() makes unreachable", () => {
  assertEquals(
    scanBarrel(),
    [],
    "`Optional(Default(x))` short-circuits at the outer node, so the default " +
      "can never be produced. Drop the `.default(x)` if the field may be " +
      "absent, drop the `.optional()` if every document carries it (measure " +
      "the corpus first — a default does not backfill stored documents), or " +
      "move the form seed to `.meta({ initial: x })`.\n",
  );
});

Deno.test("the walk can still see the construct it forbids", async (t) => {
  // Each plant is a shape the real schemas use, so a traversal that stops
  // reaching one of these containers fails here rather than reporting clean.
  const plants: Record<string, z.ZodType> = {
    "bare member": z.strictObject({ a: z.string().default("").optional() }),
    "nested object": z.strictObject({ o: z.strictObject({ a: z.array(z.string()).default([]).optional() }) }),
    "array element": z.strictObject({ xs: z.array(z.strictObject({ a: z.string().default("x").optional() })) }),
    "union arm": z.strictObject({
      u: z.union([z.strictObject({ a: z.string() }), z.strictObject({ a: z.string().default("").optional() })]),
    }),
    "record value": z.record(z.string(), z.strictObject({ a: z.string().default("").optional() })),
    "tuple slot": z.tuple([z.strictObject({ a: z.string().default("").optional() })]),
    "nullable between": z.strictObject({ a: z.string().default("").nullable().optional() }),
    "prefault spelling": z.strictObject({ a: z.string().prefault("").optional() }),
  };

  for (const [label, schema] of Object.entries(plants)) {
    await t.step(label, () => {
      const out: string[] = [];
      findInert(schema, "", new Set(), out);
      assert(out.length > 0, `the walk missed the planted construct: ${label}`);
    });
  }
});

Deno.test("the walk does not flag the two legitimate spellings", () => {
  const ok = z.strictObject({
    optionalOnly: z.string().optional(),
    defaultOnly: z.array(z.string()).default([]),
    // The order that DOES work: the default is outermost, so `undefined` reaches
    // it and it produces the value.
    optionalInsideDefault: z.string().optional().default("x"),
  });
  const out: string[] = [];
  findInert(ok, "", new Set(), out);
  assertEquals(out, []);
});
