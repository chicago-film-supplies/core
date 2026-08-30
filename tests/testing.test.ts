/**
 * The `@cfs/core/schemas/testing` contract.
 *
 * The headline arm is the corpus gate — *"every collection schema has a
 * minimal fixture that parses"* — and it is the one that will catch a new
 * required field, a tightened leaf, or a new `superRefine`. Everything else
 * here exists because that arm alone cannot distinguish **"the corpus is
 * clean"** from **"the walker stopped reaching it"**, which is the same
 * pairing `tests/typesenseFieldCoverage.test.ts` uses: each property arm has a
 * companion that proves the arm can still fail.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { z } from "zod";
import {
  BookingSchema,
  CreateContactInput,
  FirestoreTimestamp,
  getInitialValues,
  MovementSchema,
  ProductSchema,
  QuoteSchema,
  schemas,
  TemplateVersionSchema,
} from "../src/schemas/mod.ts";
import {
  getFullTestDoc,
  getTestDoc,
  getTestDocPartial,
  type TestDocOptionsWithNow,
} from "../src/schemas/testing.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const NOW: TestDocOptionsWithNow = { now: mockTimestamp };
const BOOKING_ID = "AAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAA";

/**
 * The per-schema escape hatch, and the number that matters.
 *
 * A cross-field `superRefine` is not derivable from structure, so some schemas
 * cannot be satisfied by any structural walk. **Today that is exactly one of
 * 56** — every movement type demands either a booking-scoped custody
 * transition or a cost plus at least one line, so no single choice of `type`
 * works. Two more (`product`, `templates-versions`) were reachable only via the
 * enum-arm search below, and `recurrence` / `settlement` only because a
 * `.nullable()` field is left `null` in required-only mode.
 *
 * ⚠️ **This map growing is the signal.** An entry added here is a schema whose
 * minimal fixture now needs hand-written knowledge, which is precisely the cost
 * this helper exists to avoid paying 200 times over. The count is asserted, so
 * a new one cannot be added silently.
 */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  transaction: {
    uid_booking: BOOKING_ID,
    custody: { from: "quoted", to: "prepped" },
  },
  // ⚠️ **Second entry, added when `path` became required** (api-cloudrun#709).
  // The organization tree's invariant 4 is `query_by_path === path.map(n => uid)`
  // — a CROSS-FIELD equality, which is exactly the class the walker's docstring
  // says it cannot derive: it can generate a valid `path` and a valid
  // `query_by_path` independently, and no structural rule makes the second echo
  // the first. Invariants 1 and 3 are the same shape (`path.at(-1).uid === uid`,
  // `derived_from === null ⟺ path.at(-1).derived === false`), so all three are
  // satisfied here by one hand-written node.
  //
  // ⭐ It counts as the walker keeping up, not falling behind: nothing about the
  // structure changed, a schema gained a cross-field refinement — the one thing
  // this list exists to absorb.
  organization: {
    path: [{ uid: "AAAAAAAAAAAAAAAAAAAA", name: "Fixture Org", derived: false }],
    query_by_path: ["AAAAAAAAAAAAAAAAAAAA"],
    derived_from: null,
    uid_department_type: null,
  },
};

/** Distinct schemas from the registry, keyed by their first (singular) name. */
function distinctSchemas(): Map<string, z.ZodType> {
  const byRef = new Map<z.ZodType, string>();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!byRef.has(schema as z.ZodType)) byRef.set(schema as z.ZodType, name);
  }
  return new Map([...byRef].map(([schema, name]) => [name, schema]));
}

function shapeOf(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  return (schema as unknown as { _zod: { def: { shape?: Record<string, z.ZodType> } } })._zod.def.shape;
}

/**
 * Is this declaration allowed to be **absent from the input**?
 *
 * ⚠️ Not the same question as "is it absent from the output". A `.default(x)`
 * field is required in `z.output` and present in the built document, yet the
 * schema still accepts a document without it — the default re-materializes. So
 * the omission property below can only be asserted over declarations that are
 * genuinely required on input, and a blanket *"omit any key and it fails"*
 * would be asserting something the schemas do not say.
 */
function isInputOptional(node: z.ZodType): boolean {
  // deno-lint-ignore no-explicit-any
  let n: any = node;
  while (n) {
    const t = n._zod.def.type;
    if (t === "optional" || t === "default" || t === "prefault" || t === "catch") return true;
    if (t === "unknown" || t === "any") return true;
    n = n._zod.def.innerType;
  }
  return false;
}

Deno.test("corpus gate — every registry schema has a minimal fixture that parses", () => {
  const all = distinctSchemas();
  assertEquals(all.size, 58, "registry size moved; re-measure the override list");

  const failures: string[] = [];
  for (const [name, schema] of all) {
    try {
      const doc = getTestDoc(schema, OVERRIDES[name], NOW);
      assert(schema.safeParse(doc).success, `${name}: returned a document it cannot re-parse`);
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message.split("\n").slice(1, 4).join(" ").trim()}`);
    }
  }
  assertEquals(failures, [], failures.join("\n"));

  // The escape hatch is the measurement. Structural coverage is 56/58 without
  // it; if this grows for a reason OTHER than a new cross-field refinement, the
  // walker has stopped keeping up with the schemas.
  assertEquals(Object.keys(OVERRIDES).length, 2, "a schema now needs hand-written fixture knowledge");
});

Deno.test("corpus gate companion — an unsatisfiable invariant still throws, naming its path", () => {
  const Unsatisfiable = z.strictObject({
    a: z.string(),
    b: z.string(),
  }).superRefine((v, ctx) => {
    if (v.a === v.b) ctx.addIssue({ code: "custom", path: ["b"], message: "a and b must differ" });
  });

  const err = assertThrows(() => getTestDoc(Unsatisfiable), Error);
  assertStringIncludes(err.message, "b: a and b must differ");
  assertStringIncludes(err.message, "does not parse");
});

Deno.test("required-only — omitting an input-required key is rejected on every schema", () => {
  let required = 0;
  let optional = 0;
  const holes: string[] = [];

  for (const [name, schema] of distinctSchemas()) {
    const shape = shapeOf(schema);
    if (!shape) continue;
    const doc = getTestDoc(schema, OVERRIDES[name], NOW) as Record<string, unknown>;

    for (const [key, node] of Object.entries(shape)) {
      if (!(key in doc)) continue;
      const { [key]: _dropped, ...rest } = doc;
      const accepted = schema.safeParse(rest).success;
      if (isInputOptional(node)) {
        optional++;
        continue;
      }
      required++;
      if (accepted) holes.push(`${name}.${key}`);
    }
  }

  assertEquals(holes, [], `these required keys can be omitted and still parse:\n${holes.join("\n")}`);
  // Non-vacuity, both ways: the classifier must be finding real members of
  // both classes, or "no holes" would mean nothing.
  assert(required > 400, `only ${required} required keys checked`);
  assert(optional > 50, `only ${optional} input-optional keys found — the classifier is over-strict`);
});

Deno.test("required-only — an .optional() key is omitted, and getFullTestDoc emits it", () => {
  const S = z.strictObject({
    kept: z.string(),
    dropped: z.string().optional(),
    nullish: z.string().nullable(),
  });

  const minimal = getTestDoc(S) as Record<string, unknown>;
  assertEquals("dropped" in minimal, false);
  assertEquals(minimal.nullish, null);

  const full = getFullTestDoc(S) as Record<string, unknown>;
  assertEquals("dropped" in full, true);
  assertEquals(typeof full.dropped, "string");
  // `full` also populates a nullable rather than leaving it null — that is the
  // whole reason a caller reaches for it.
  assertEquals(typeof full.nullish, "string");
});

Deno.test("every leaf is verified against its own schema, not guessed from its type", () => {
  // `""` is a legal form seed and an illegal document value. This is the split
  // that put a repair on top of `getInitialValues` at every fixture site.
  const seeded = getInitialValues(CreateContactInput) as Record<string, unknown>;
  assertEquals(seeded.first_name, "");
  assertEquals(CreateContactInput.safeParse(seeded).success, false);

  // No cast: the return is `z.output<S>`, which is the point of difference 1.
  const fixture = getTestDoc(CreateContactInput);
  assertEquals(CreateContactInput.safeParse(fixture).success, true);
  assert(fixture.first_name.length > 0);

  // The sweep reaches constrained leaves of every family, not just `.min(1)`.
  assertEquals(getTestDoc(z.strictObject({ v: z.email() })).v, "test@example.com");
  assertEquals(getTestDoc(z.strictObject({ v: z.uuid() })).v.length, 36);
  // The sweep runs FIRST, so a `.min(3)` leaf takes the first *candidate* long
  // enough rather than a synthesized "aaa" — introspection is the fallback, not
  // the entry point, and inverting that is what silently halved the pass rate.
  assertEquals(getTestDoc(z.strictObject({ v: z.string().min(3) })).v, "AAAAAAAAAAAAAAAAAAAA");
  // No candidate is exactly six characters, so this one does reach the pad.
  assertEquals(getTestDoc(z.strictObject({ v: z.string().length(6) })).v, "aaaaaa");
  assertEquals(getTestDoc(z.strictObject({ v: z.int().min(5) })).v, 5);
  assertEquals(getTestDoc(z.strictObject({ v: z.number().gt(2) })).v, 3);
});

Deno.test("arrays honour .min(n) — the reason a bare seed cannot be a fixture", () => {
  const S = z.strictObject({
    none: z.array(z.string()),
    one: z.array(z.string().min(1)).min(1),
    three: z.array(z.int()).min(3),
  });
  const doc = getTestDoc(S);
  assertEquals(doc.none, []);
  assertEquals(doc.one, ["x"]);
  assertEquals(doc.three, [0, 0, 0]);
  assertEquals(S.safeParse(doc).success, true);
});

Deno.test("composite ids are built structurally, from the template literal's own parts", () => {
  // No candidate list can spell these; they come out of `z.templateLiteral`.
  const booking = getTestDoc(BookingSchema, undefined, NOW);
  assertEquals(booking.uid.split(":").length, 3);

  const quote = getTestDoc(QuoteSchema, undefined, NOW);
  assert(/^[A-Za-z0-9]{20}:(v\d+|draft)$/.test(quote.uid), `quote uid was ${quote.uid}`);

  const movement = getTestDoc(MovementSchema, OVERRIDES.transaction, NOW);
  assertEquals(movement.uid.split("|").length, 3);
});

Deno.test("timestamps — the walker never fabricates one, and says so when it needs one", () => {
  const S = z.strictObject({ created_at: FirestoreTimestamp });

  const err = assertThrows(() => getTestDoc(S as z.ZodType), Error);
  assertStringIncludes(err.message, "options.now");
  assertStringIncludes(err.message, "does not fabricate");

  const filled = getTestDoc(S as z.ZodType, undefined, NOW) as Record<string, unknown>;
  assertEquals(filled.created_at, mockTimestamp);
});

Deno.test("timestamps — a caller's Timestamp is never merged into, only replaced", () => {
  // A real `Timestamp` is a class instance. Merging key-wise would strip its
  // prototype and leave a plain map, which parses and is wrong — the exact
  // hazard `options.now` exists to avoid.
  class FakeTimestamp {
    constructor(readonly seconds: number, readonly nanoseconds: number) {}
    toMillis() {
      return this.seconds * 1000;
    }
    toDate() {
      return new Date(this.toMillis());
    }
  }
  const instance = new FakeTimestamp(42, 0);
  const S = z.strictObject({ created_at: FirestoreTimestamp });

  const doc = getTestDoc(S as z.ZodType, { created_at: instance }, NOW) as Record<string, unknown>;
  assert(doc.created_at instanceof FakeTimestamp, "the class instance was flattened into a plain map");
});

Deno.test("overrides — objects merge key-wise, arrays and scalars replace, undefined deletes", () => {
  const S = z.strictObject({
    nested: z.strictObject({ a: z.string(), b: z.string() }),
    list: z.array(z.int()).min(2),
    scalar: z.string(),
    gone: z.string(),
  });

  const doc = getTestDoc(S, { nested: { b: "kept" }, list: [9, 8], scalar: "set" });
  assertEquals(doc.nested, { a: "", b: "kept" }, "a sibling key was lost — the merge is not deep");
  assertEquals(doc.list, [9, 8], "arrays must replace wholesale, not merge element-wise");
  assertEquals(doc.scalar, "set");

  // Deleting a required key is how a caller asks for the negative fixture, and
  // the parse is what makes it honest.
  assertThrows(() => getTestDoc(S, { gone: undefined }), Error, "gone");
});

Deno.test("enum-arm search — re-chooses exactly two arms across the corpus, by name", () => {
  // `product` parses only as a SALE: a rental obliges `price.replacement_cents`
  // through a superRefine. Documented, because it is surprising.
  const product = getTestDoc(ProductSchema, undefined, NOW);
  assertEquals(product.type, "sale");

  const version = getTestDoc(TemplateVersionSchema, undefined, NOW);
  assertEquals(version.status, "archived");

  // And the corpus-wide count, so a third one cannot appear unnoticed.
  const rechosen: string[] = [];
  for (const [name, schema] of distinctSchemas()) {
    const shape = shapeOf(schema);
    if (!shape) continue;
    let doc: Record<string, unknown>;
    try {
      doc = getTestDoc(schema, OVERRIDES[name], NOW) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [key, node] of Object.entries(shape)) {
      // deno-lint-ignore no-explicit-any
      let n: any = node;
      while (n._zod.def.innerType && n._zod.def.type !== "enum") n = n._zod.def.innerType;
      if (n._zod.def.type !== "enum") continue;
      const first = Object.values(n._zod.def.entries ?? {})[0];
      if (doc[key] !== undefined && doc[key] !== first) rechosen.push(`${name}.${key}`);
    }
  }
  assertEquals(rechosen.sort(), ["product.type", "templates-versions.status"]);
});

Deno.test("enum-arm search companion — the first arm really does fail without it", () => {
  // Otherwise the arm above is indistinguishable from "the first member always
  // happened to be right".
  const product = getTestDoc(ProductSchema, undefined, NOW);
  const forced = ProductSchema.safeParse({ ...product, type: "rental" });
  assertEquals(forced.success, false, "a rental now parses without a replacement price");

  const version = getTestDoc(TemplateVersionSchema, undefined, NOW);
  assertEquals(TemplateVersionSchema.safeParse({ ...version, status: "draft" }).success, false);
});

Deno.test("getTestDocPartial — returns exactly its fields, and checks each one", () => {
  const kept = getTestDocPartial(ProductSchema, { uid: "AAAAAAAAAAAAAAAAAAAA", name: "Rig" });
  assertEquals(Object.keys(kept).sort(), ["name", "uid"]);
  assertEquals(kept.name, "Rig");

  // A value the schema rejects is caught even though the document is partial.
  assertThrows(
    () => getTestDocPartial(ProductSchema, { uid: "not-a-firestore-id" }),
    Error,
    "uid",
  );
  // And a key the schema does not declare.
  assertThrows(
    () => getTestDocPartial(ProductSchema, { nmae: "typo" } as never),
    Error,
    "no such field",
  );
});

Deno.test("input schemas need no timestamp, and come back complete", () => {
  // The conditional options argument collapses to its optional arm for a schema
  // with no `created_at` — this call not needing a third argument IS the test.
  const input = getTestDoc(CreateContactInput);
  assertEquals(CreateContactInput.safeParse(input).success, true);
});
