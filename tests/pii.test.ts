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
 */
import { assertEquals } from "@std/assert";
import type { z } from "zod";

import * as barrel from "../src/schemas/mod.ts";
import { schemas } from "../src/schemas/mod.ts";
import { MSG_SCHEMA_REGISTRY } from "../src/schemas/log/mod.ts";
import { collectLeafPaths, type LeafPath } from "../src/schemas/zod-walk.ts";
import { readPiiTag } from "../src/schemas/pii/walker.ts";
import {
  AMBIGUOUS,
  NAME_SENSITIVE,
  SENSITIVE_EXACT,
  SENSITIVE_NAME_FIELD,
} from "../src/schemas/pii/dictionary.ts";
import { RUNTIME_DENYLIST } from "../src/schemas/pii/runtime-denylist.ts";

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

Deno.test("no sensitive field hides behind a dynamic-key map", () => {
  // `applyPii` has no `z.record` arm — it returns the value untouched. So a
  // sensitive field under a record would be tagged, pass this suite, and never
  // actually be scrubbed. Zero such leaves today; this fires the day that
  // changes, at which point teaching the runtime to descend records becomes a
  // decision rather than a silent false green.
  const behindRecord: string[] = [];

  for (const [schema, label] of coverageSources()) {
    const nameIsSensitive = NAME_SENSITIVE.has(label);
    for (const leaf of collectLeafPaths(schema, { inherit: ["pii"] }).leaves) {
      if (!leaf.path.includes("<key>")) continue;
      if (!isSensitive(leaf, nameIsSensitive)) continue;
      behindRecord.push(`${label}::${leaf.path}`);
    }
  }

  assertEquals(
    behindRecord,
    [],
    `Sensitive fields behind a z.record — applyPii cannot reach these:\n${behindRecord.join("\n")}`,
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
