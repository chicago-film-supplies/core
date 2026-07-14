/**
 * PII classification enforcement.
 *
 * Walks every schema the package ships, to full depth — through arrays, unions,
 * records and pipes — and asserts that any field whose name matches the
 * sensitive dictionary carries a `.meta({ pii })` annotation.
 *
 * ## Why this is built on `collectLeafPaths`
 *
 * It used to hand-roll its own walk, which descended objects two levels deep and
 * stopped. `getShape(z.array(...))` returned `null`, so **a sensitive field
 * inside an array was never visited** — the guard was green not because the
 * schemas were clean but because it could not see most of them. Unions, records
 * and anything below depth 2 were equally invisible.
 *
 * `collectLeafPaths` (`src/schemas/zod-walk.ts`) already does that traversal,
 * fails closed on any node type it does not recognise, and is exercised by the
 * Uploadcare authoring lint. Reusing it means one walker to keep correct.
 *
 * ## The two things that make this sound
 *
 * 1. **`inherit: ["pii"]`.** `Address` is tagged on the OBJECT and the runtime
 *    walker pushes that tag down to its leaves. Without inheritance every leaf
 *    under a correctly-tagged `Address` reads as untagged and the test would
 *    report ~213 false violations.
 *
 * 2. **`leaf.meta.pii` and `readPiiTag` are provably the same reader.** They
 *    were not: `collectLeafPaths` looked through `.readonly()`, `.nonoptional()`
 *    and `.transform()` while `readPiiTag` did not, so
 *    `z.string().meta({pii:"mask"}).transform(s => s.trim())` read `mask` here
 *    and `undefined` at runtime — the tag would be reported as present while
 *    `applyPii` logged the value raw. `WRAPPER_TYPES` was widened to match, and
 *    `tests/pii-walker.test.ts` pins the equivalence. That is the whole lesson of
 *    the `Address` bug: one reader, or the guard does not guard.
 *
 * ## …and the one thing that makes it *sufficient*
 *
 * Everything above checks that a tag is PRESENT. Nothing above checks that the
 * tag DOES anything — and a tag that does nothing is the failure mode this file
 * keeps rediscovering. `Address` was tagged and unscrubbed. Then
 * `comment::reactions.<key>.<key>.name` was tagged and unscrubbed, behind a
 * `z.record` the walker had no arm for — while a static tripwire written to catch
 * exactly that sat green, because it gated on the name dictionary rather than on
 * the tag.
 *
 * So the last gate here drives the **real `applyPii`** over synthesized documents
 * (`tests/helpers/sample-value.ts`) and asserts it actually offers every tagged
 * leaf to the strategy. A static rule cannot audit the runtime; only the runtime
 * can.
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

import * as barrel from "../src/schemas/mod.ts";
import { schemas } from "../src/schemas/mod.ts";
import { MSG_SCHEMA_REGISTRY } from "../src/schemas/log/mod.ts";
import { collectLeafPaths, type LeafPath } from "../src/schemas/zod-walk.ts";
import { applyPii, type PiiStrategy, readPiiTag } from "../src/schemas/pii/walker.ts";
import {
  AMBIGUOUS,
  NAME_SENSITIVE,
  SENSITIVE_EXACT,
  SENSITIVE_NAME_FIELD,
} from "../src/schemas/pii/dictionary.ts";
import { RUNTIME_DENYLIST } from "../src/schemas/pii/runtime-denylist.ts";
import { resolveLeafValues, sampleValues } from "./helpers/sample-value.ts";

// ── Coverage sources ─────────────────────────────────────────────────

/**
 * Every schema to sweep, keyed by a greppable label.
 *
 * All three sources are DERIVED. The old test carried a hand-written list of 18
 * schemas, and every schema missing from it was unenforced — which is how four
 * documents ended up storing an untagged customer email. A list you maintain by
 * hand re-creates exactly the blind spot this test exists to remove, so there
 * isn't one.
 */
function coverageSources(): Map<z.ZodType, string> {
  const out = new Map<z.ZodType, string>();

  // 1. Firestore document schemas. The record double-keys singular AND plural
  //    onto the same instance, so dedupe by node identity and keep first-wins.
  for (const [key, schema] of Object.entries(schemas)) {
    if (!out.has(schema)) out.set(schema, key);
  }

  // 2. The log arms. These are the ONLY schemas `applyPii` walks in production
  //    (api-cloudrun's logger dispatches through this registry), and they are in
  //    neither the `schemas` record nor the old hand list. `LogRecordSchema` is
  //    NOT the right object here — it is an OpenAPI-only envelope, absent from
  //    the registry.
  for (const [msg, schema] of MSG_SCHEMA_REGISTRY) {
    if (!out.has(schema)) out.set(schema, `log:${msg}`);
  }

  // 3. Input schemas — what the API accepts. Derived off the barrel by name.
  for (const [key, value] of Object.entries(barrel)) {
    if (!/Input$/.test(key)) continue;
    if (!isZodSchema(value)) continue;
    if (!out.has(value)) out.set(value, key);
  }

  return out;
}

function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

// ── Matching ─────────────────────────────────────────────────────────

/** Strip `collectLeafPaths`' container markers so a segment shows its bare noun. */
function bareSegment(segment: string): string {
  return segment.replace(/\[\]$/, "").replace(/^<key>$/, "");
}

function segments(path: string): string[] {
  return path.split(".").map(bareSegment);
}

/**
 * True when a leaf sits at or beneath a sensitive field name.
 *
 * Matches on ANY segment, not just the last. `address` and `billing_address` are
 * object-typed everywhere in core and `collectLeafPaths` only emits scalars, so
 * a last-segment rule could never match them — it would quietly turn two of the
 * dictionary's entries into dead letters and would not notice an entirely
 * untagged address container. Inheritance makes the wider rule free: a container
 * that IS tagged pushes its tag onto these leaves, so they never fire.
 */
function isSensitive(leaf: LeafPath, nameIsSensitive: boolean): boolean {
  const segs = segments(leaf.path);
  if (segs.some((s) => SENSITIVE_EXACT.has(s))) return true;
  return nameIsSensitive && segs.some((s) => s === SENSITIVE_NAME_FIELD);
}

// ── Tests ────────────────────────────────────────────────────────────

interface Violation {
  schema: string;
  path: string;
}

Deno.test("sensitive fields have PII meta annotations", () => {
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const [schema, label] of coverageSources()) {
    const nameIsSensitive = NAME_SENSITIVE.has(label);
    const { leaves } = collectLeafPaths(schema, { inherit: ["pii"] });

    for (const leaf of leaves) {
      if (leaf.meta.pii !== undefined) continue;
      if (!isSensitive(leaf, nameIsSensitive)) continue;

      // A leaf reachable through several union members is emitted once per
      // member at the same path; report it once.
      const key = `${label}::${leaf.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ schema: label, path: leaf.path });
    }
  }

  assertEquals(
    violations,
    [],
    `Fields missing pii meta:\n${violations.map((v) => `  ${v.schema}::${v.path}`).join("\n")}`,
  );
});

Deno.test("the walk interprets every node — no schema is silently skipped", () => {
  // Fails CLOSED. A node type `collectLeafPaths` cannot interpret would swallow
  // its whole subtree, and every assertion above it would be vacuous. If this
  // fires, teach the walker the type — do not filter it out.
  const unhandled: string[] = [];

  for (const [schema, label] of coverageSources()) {
    for (const node of collectLeafPaths(schema, { inherit: ["pii"] }).unhandled) {
      unhandled.push(`${label}::${node.path || "<root>"} (${node.type})`);
    }
  }

  assertEquals(unhandled, [], `collectLeafPaths could not interpret:\n${unhandled.join("\n")}`);
});

// ── The runtime reach gate ───────────────────────────────────────────

/**
 * The lint's path grammar vs the runtime's: identical except for arrays.
 * `collectLeafPaths` writes `items[].name`; the walker writes `items.name`,
 * because it deliberately emits no array INDEX — the fixture sanitizer seeds its
 * deterministic fakes on `(path, value)`, so an index would reseed every fake the
 * day someone reordered a line item and churn every golden. Records already agree:
 * both say `.<key>`.
 *
 * The mapping is many-to-one in principle, which would let an offer for `a.b`
 * satisfy the requirement for `a[].b` — a false green. The injectivity test below
 * asserts it never actually is.
 */
function toRuntimePath(lintPath: string): string {
  return lintPath.replaceAll("[]", "");
}

/** Leaves whose EFFECTIVE pii — own tag, or one inherited from a tagged container — demands a scrub. */
function expectScrubbed(schema: z.ZodType): Set<string> {
  const out = new Set<string>();
  for (const leaf of collectLeafPaths(schema, { inherit: ["pii"] }).leaves) {
    const pii = leaf.meta.pii;
    if (pii === undefined || pii === "none") continue;
    // `z.union([z.string(), z.null()])` under a tag emits a tagged `null` leaf.
    // The walker skips null/undefined by documented contract (absent stays
    // absent), so demanding an offer for one would be a permanent false red.
    // Zero such leaves today — this is a landmine, not a bug.
    if (leaf.type === "null" || leaf.type === "undefined") continue;
    out.add(toRuntimePath(leaf.path));
  }
  return out;
}

Deno.test("no pii tag is decorative — the real walker reaches every tagged leaf", () => {
  // EVERY other guard in this file keys off something that is not the walker: the
  // name dictionary, the tag readers, the lint's leaf set. Each has been green
  // while `applyPii` shipped the value raw — `Address`'s object-level tag, then
  // `comment::reactions.<key>.<key>.name` behind a `z.record`. That last one was
  // supposed to be caught by a static "nothing sensitive behind a dynamic-key map"
  // tripwire, which this test replaces: the tripwire gated on the NAME dictionary,
  // `reactions` and `name` are not in it for a comment, and so it sat green on the
  // exact leaf it was written to catch.
  //
  // A static rule cannot see a hole in the runtime, because the runtime is the
  // thing being checked. So drive the real walker and watch what it touches.
  const unreached: string[] = [];

  for (const [schema, label] of coverageSources()) {
    const expected = expectScrubbed(schema);
    if (expected.size === 0) continue;

    const offered = new Set<string>();
    const probe: PiiStrategy = {
      apply(value, _classification, fieldPath) {
        // Only NON-container offers count as "reached". A container is offered for
        // FIRST REFUSAL before the walker descends it, so a tagged `z.custom` (a
        // Firestore Timestamp) is "offered" as an object and then cannot be
        // descended at all. Counting that as reached would be a false green on
        // precisely the leak being hunted.
        if (value === null || typeof value !== "object") offered.add(fieldPath);
        return value;
      },
    };

    for (const doc of sampleValues(schema)) {
      applyPii(doc as Record<string, unknown>, schema as z.ZodType<Record<string, unknown>>, probe);
    }
    for (const path of expected) {
      if (!offered.has(path)) unreached.push(`${label}::${path}`);
    }
  }

  assertEquals(
    unreached,
    [],
    "These fields carry a pii tag the runtime walker never applies. They are tagged, " +
      "they are green in every static guard in this file, and they ship raw:\n" +
      unreached.map((u) => `  ${u}`).join("\n"),
  );
});

Deno.test("the sample generator populates every leaf — the reach gate is not vacuous", () => {
  // The reach gate asserts "every expected path was offered". If the generator
  // quietly failed to populate a field, the walker would never be handed it, and…
  // the gate would still be red (the expected set comes from `collectLeafPaths`,
  // not from the generator). So a generator bug cannot fake a pass. This asserts
  // the containment directly anyway, because a gate whose inputs you cannot
  // characterise is a gate you will eventually mis-read.
  const unpopulated: string[] = [];

  for (const [schema, label] of coverageSources()) {
    const docs = sampleValues(schema);
    for (const leaf of collectLeafPaths(schema, { inherit: ["pii"] }).leaves) {
      // `z.undefined()`'s only inhabitant IS the absent value.
      if (leaf.type === "undefined") continue;
      if (docs.some((doc) => resolveLeafValues(doc, leaf.path).length > 0)) continue;
      unpopulated.push(`${label}::${leaf.path} (${leaf.type})`);
    }
  }

  assertEquals(
    unpopulated,
    [],
    `The sample generator never produced a value at these leaves, so the walker was ` +
      `never offered them:\n${unpopulated.map((u) => `  ${u}`).join("\n")}`,
  );
});

Deno.test("stripping array markers is injective — no two leaves collide on one runtime path", () => {
  // `toRuntimePath` deletes `[]`, so `a[].b` and `a.b` would normalize onto the
  // same string and an offer for either would satisfy the requirement for both.
  // Zero collisions today. One assert closes the hole.
  const collisions: string[] = [];

  for (const [schema, label] of coverageSources()) {
    const byRuntimePath = new Map<string, string>();
    for (const leaf of collectLeafPaths(schema, { inherit: ["pii"] }).leaves) {
      const runtime = toRuntimePath(leaf.path);
      const prior = byRuntimePath.get(runtime);
      if (prior !== undefined && prior !== leaf.path) {
        collisions.push(`${label}: "${prior}" and "${leaf.path}" both → "${runtime}"`);
      }
      byRuntimePath.set(runtime, leaf.path);
    }
  }

  assertEquals(
    collisions,
    [],
    `Two distinct leaves share one runtime path — the reach gate above can be ` +
      `satisfied for one by an offer for the other:\n${collisions.join("\n")}`,
  );
});

Deno.test("no pii tag sits on an opaque leaf (unknown / any)", () => {
  // NOT redundant with the reach gate — it is the one thing the reach gate
  // structurally cannot see. The generator emits a STRING at a `z.unknown()` leaf,
  // so the walker masks it and the gate goes green. In production the value may be
  // an object, in which case the walker has no shape to descend and fails closed
  // to `[REDACTED]` wholesale. Neither outcome is a leak — but which one you get
  // depends on the VALUE, not the schema, and a scrub you cannot predict from the
  // schema is not a scrub you can reason about.
  //
  // This is also what makes tagging `CommentBody` (the Tiptap `z.record(z.string(),
  // z.unknown())` comment body) fail loudly instead of looking scrubbed and not
  // being. If a rich-text body ever does need scrubbing, the answer is wholesale
  // replacement, expressed as such — not a `mask` tag on an opaque leaf.
  const opaque: string[] = [];

  for (const [schema, label] of coverageSources()) {
    for (const leaf of collectLeafPaths(schema, { inherit: ["pii"] }).leaves) {
      if (leaf.type !== "unknown" && leaf.type !== "any") continue;
      const pii = leaf.meta.pii;
      if (pii === undefined || pii === "none") continue;
      opaque.push(`${label}::${leaf.path} (${leaf.type}, pii: ${String(pii)})`);
    }
  }

  assertEquals(
    opaque,
    [],
    `A pii tag on an opaque leaf scrubs differently depending on the runtime value ` +
      `(string → masked, object → redacted wholesale):\n${opaque.map((o) => `  ${o}`).join("\n")}`,
  );
});

Deno.test("the dictionary and the walker agree on every tag they can both see", () => {
  // The guard reads tags via `leaf.meta.pii`; the runtime reads them via
  // `readPiiTag`. If those two ever disagree about WHERE a tag may live, this
  // suite goes green while `applyPii` leaks — which is precisely the bug that
  // made `Address`'s object-level tag a no-op. `tests/pii-walker.test.ts` pins
  // the equivalence across every wrapper form; this asserts the schemas we
  // actually ship contain no construct where they diverge.
  const divergent: string[] = [];

  for (const [schema, label] of coverageSources()) {
    const { leaves } = collectLeafPaths(schema, { inherit: ["pii"] });
    for (const leaf of leaves) {
      // Only own-tags are comparable: `readPiiTag` reads a single node and knows
      // nothing about inheritance from an ancestor container.
      const own = readPiiTag(leaf.node);
      if (own === undefined) continue;
      if (own !== leaf.meta.pii) {
        divergent.push(`${label}::${leaf.path} — readPiiTag=${own} meta.pii=${leaf.meta.pii}`);
      }
    }
  }

  assertEquals(divergent, [], `Tag readers disagree:\n${divergent.join("\n")}`);
});

// ── The two sets ─────────────────────────────────────────────────────

/**
 * `SENSITIVE_EXACT` and `RUNTIME_DENYLIST` protect the same data at two
 * different layers: the schema tag covers a field we modelled, the runtime
 * key-name scrubber covers the same field when it arrives in an unmodelled
 * passthrough payload. Their headers describe the relationship between them in
 * careful prose — and nothing enforced a word of it, so the two could drift
 * apart silently. These two tests turn the prose into an assertion.
 */
Deno.test("every unambiguous schema-sensitive name is also in the runtime denylist", () => {
  const missing = [...SENSITIVE_EXACT]
    .filter((name) => !AMBIGUOUS.has(name))
    .filter((name) => !RUNTIME_DENYLIST.has(name))
    .sort();

  assertEquals(
    missing,
    [],
    "These names are sensitive in a schema but would sail through the runtime " +
      "scrubber untouched if they showed up as a raw key in an untyped log payload.\n" +
      "Either add them to RUNTIME_DENYLIST, or add them to AMBIGUOUS with a reason:\n" +
      missing.map((n) => `  ${n}`).join("\n"),
  );
});

Deno.test("no stale exemption: every AMBIGUOUS name is still schema-sensitive", () => {
  // Guards the other direction. An exemption that outlives the dictionary entry
  // it exempts is a lie in the source — it reads as a considered decision when
  // it is really a leftover.
  const stale = [...AMBIGUOUS]
    .filter((name) => !SENSITIVE_EXACT.has(name) && name !== SENSITIVE_NAME_FIELD)
    .sort();

  assertEquals(
    stale,
    [],
    `AMBIGUOUS exempts names that are no longer schema-sensitive:\n${stale.map((n) => `  ${n}`).join("\n")}`,
  );
});
