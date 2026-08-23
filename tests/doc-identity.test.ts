/**
 * "Which field is this document's id?" — made TOTAL over the registry.
 *
 * ## The hole this closes
 *
 * api-cloudrun's write-time drift guard (`assertValidForWrite` /
 * `assertValidPatch`) is:
 *
 * ```ts
 * const uid = (doc as { uid?: unknown }).uid;
 * if (typeof uid === "string" && uid !== ref.id) throw ...
 * ```
 *
 * 🔴 **A document with no `uid` field passes SILENTLY.** So the guard covers
 * exactly "the collections that happened to name their id field `uid`" — and
 * nothing anywhere declared which ones it did not. That is not a hypothetical
 * gap: `roles.name` IS a document id, disagreeing with `ref.id` would redirect
 * every permission lookup, and the guard could not see it.
 *
 * After this file, every collection in the registry answers the question in
 * exactly one of three ways, and adding a collection that answers in none of
 * them fails here rather than being quietly unguarded.
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import type { z } from "zod";
import { schemas } from "../src/schemas/mod.ts";

/**
 * Collections that legitimately carry NO id field in the body, each with the
 * reason it is safe for the drift guard not to see them.
 *
 * ⚠️ **A reason, not a name.** An exemption list whose entries carry no argument
 * decays into a list of things nobody wants to think about — and the test below
 * fails if an entry here ever stops being needed, so a stale one cannot sit
 * quietly (the dead-denylist lesson from `tests/template-helpers.test.ts`).
 */
const ID_LESS_COLLECTIONS: Record<string, string> = {
  // ── The doc id IS a credential ──────────────────────────────────────
  // The id is the bearer token, or `sha256(token)` for the mcp-oauth pair.
  // Copying it into the body widens what a log or export leak reveals and buys
  // nothing: no reader needs it. ⚠️ The package is already inconsistent here —
  // `template_previews.uid` is itself a bearer token — so the argument is "no
  // reader needs it", NOT "this is a new security boundary".
  "email-verifications": "doc id is the verification token — a credential",
  "password-resets": "doc id is the reset token — a credential",
  "mcp-oauth-codes": "doc id is sha256(authorization code) — a credential",
  "mcp-oauth-tokens": "doc id is sha256(refresh token) — a credential",

  // ── A natural key that is not in the body ───────────────────────────
  // Hot-path or TTL-swept plumbing with no reader of a body id.
  "counters": "doc id is the counter name; the body is a bare {count} with no reader of its own id",
  "rate-limits": "doc id is the composite rate-limit key; hot path, TTL-swept, no reader",
  "uploadcare-sweep": "doc id is the partition's baseline name (last-run-prod / last-run-dev)",
  // ⚠️ Worse than neutral for this one: the id is `normalizeQuery(q)` while the
  // body's `query` is the RAW string, so a `uid` would be a THIRD representation
  // of one key rather than a mirror of the id.
  "cache-geocodes": "doc id is normalizeQuery(query); the body holds the raw query, so a uid would be a third form",
};

/** Unwrap optional/nullable/default/pipe wrappers to the underlying node. */
function unwrap(schema: unknown): unknown {
  let node = schema as { def?: { type?: string; innerType?: unknown; in?: unknown } };
  for (let i = 0; i < 20 && node?.def; i++) {
    const t = node.def.type;
    if (t === "optional" || t === "nullable" || t === "default" || t === "readonly" || t === "catch") {
      node = node.def.innerType as typeof node;
    } else if (t === "pipe") {
      node = node.def.in as typeof node;
    } else break;
  }
  return node;
}

/** Top-level keys shared by every arm (an object's keys; a union's intersection). */
function topLevelShape(schema: unknown): Record<string, unknown> | null {
  const node = unwrap(schema) as {
    def?: { type?: string; shape?: Record<string, unknown>; options?: unknown[] };
  };
  if (node?.def?.type === "object" && node.def.shape) return node.def.shape;
  if ((node?.def?.type === "union" || node?.def?.type === "discriminatedUnion") && node.def.options) {
    const shapes = node.def.options.map((o) => topLevelShape(o)).filter(Boolean) as Record<string, unknown>[];
    if (shapes.length === 0) return null;
    const common: Record<string, unknown> = {};
    for (const key of Object.keys(shapes[0])) {
      if (shapes.every((s) => key in s)) common[key] = shapes[0][key];
    }
    return common;
  }
  return null;
}

/** The `idField` declared on a schema's `.meta()`, if any. */
function declaredIdField(schema: z.ZodType): string | undefined {
  const meta = (schema as { meta?: () => Record<string, unknown> | undefined }).meta?.();
  const value = meta?.idField;
  return typeof value === "string" ? value : undefined;
}

/** One entry per DISTINCT schema, with every registry alias that points at it. */
function distinctCollections(): Array<{ names: string[]; schema: z.ZodType }> {
  const bySchema = new Map<z.ZodType, string[]>();
  for (const [name, schema] of Object.entries(schemas as Record<string, z.ZodType>)) {
    const existing = bySchema.get(schema);
    if (existing) existing.push(name);
    else bySchema.set(schema, [name]);
  }
  return [...bySchema].map(([schema, names]) => ({ names, schema }));
}

Deno.test("every collection declares HOW its document id is stored", () => {
  const unanswered: string[] = [];

  for (const { names, schema } of distinctCollections()) {
    const shape = topLevelShape(schema);
    if (shape && "uid" in shape) continue;
    if (declaredIdField(schema) !== undefined) continue;
    if (names.some((n) => n in ID_LESS_COLLECTIONS)) continue;
    unanswered.push(names.join(" / "));
  }

  assertEquals(
    unanswered.sort(),
    [],
    "These collections declare no `uid`, no `.meta({ idField })`, and no entry in " +
      "ID_LESS_COLLECTIONS. api-cloudrun's drift guard reads `doc.uid` and compares it to " +
      "`ref.id`, so a document with none of the three is UNGUARDED and nothing says so. " +
      "Add `uid`, or declare the field that holds the id, or record why there is none.",
  );
});

Deno.test("a declared idField names a REAL, required, string leaf", () => {
  // ⚠️ The half that makes the declaration worth having. `idField: "nmae"` would
  // otherwise satisfy the totality test above while pointing at nothing, and the
  // guard that consumes it would silently go back to covering nothing — the same
  // failure, one level of indirection further away.
  const bad: string[] = [];

  for (const { names, schema } of distinctCollections()) {
    const field = declaredIdField(schema);
    if (field === undefined) continue;

    const shape = topLevelShape(schema);
    const leaf = shape?.[field];
    if (!leaf) {
      bad.push(`${names[0]}: idField "${field}" is not a field of this schema`);
      continue;
    }
    // A doc id can never be absent, so the leaf must not be optional/nullable.
    const raw = leaf as { def?: { type?: string } };
    if (raw.def?.type === "optional" || raw.def?.type === "nullable") {
      bad.push(`${names[0]}: idField "${field}" is optional/nullable — a doc id is never absent`);
      continue;
    }
    // …and it must be STRING-typed, since `ref.id` is a string.
    //
    // ⚠️ Tested by rejecting a NON-string rather than by accepting a guessed
    // one. The first version of this probed with plausible-looking ids and
    // failed on `uploadcare-worklist.uuid` — a perfectly correct `z.uuid()` that
    // simply rejects strings which are not UUIDs. A guard that demands a field
    // accept the values the TEST happens to imagine is testing the test.
    const leafSchema = leaf as z.ZodType;
    if (leafSchema.safeParse(12345).success) {
      bad.push(`${names[0]}: idField "${field}" accepts a number — a doc id is a string`);
      continue;
    }
    const acceptsSomeString = [
      "some-plausible-id",
      "0BIQ73UMiHTtd8mo0yNk",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "a",
    ].some((candidate) => leafSchema.safeParse(candidate).success);
    if (!acceptsSomeString) {
      bad.push(`${names[0]}: idField "${field}" accepts none of the probe strings — is it a string leaf?`);
    }
  }

  assertEquals(bad, [], bad.join("\n"));
});

Deno.test("no ID_LESS_COLLECTIONS entry is stale", () => {
  // The direction the totality test cannot see: it walks collections and asks
  // whether each is answered, so an entry naming a collection that has SINCE
  // grown a `uid` — or that no longer exists — accounts for nothing and is
  // invisible to it. That is the dead-denylist failure, and it has already cost
  // this repo real time elsewhere.
  const stale: string[] = [];

  for (const name of Object.keys(ID_LESS_COLLECTIONS)) {
    const schema = (schemas as Record<string, z.ZodType | undefined>)[name];
    if (!schema) {
      stale.push(`${name}: not a collection in the registry`);
      continue;
    }
    const shape = topLevelShape(schema);
    if (shape && "uid" in shape) stale.push(`${name}: now declares \`uid\` — delete this entry`);
    if (declaredIdField(schema) !== undefined) {
      stale.push(`${name}: now declares an \`idField\` — delete this entry`);
    }
  }

  assertEquals(stale, [], stale.join("\n"));
});

Deno.test("every ID_LESS_COLLECTIONS entry carries a REASON, not just a name", () => {
  // An exemption list whose entries carry no argument decays into a list of
  // things nobody wants to think about.
  for (const [name, reason] of Object.entries(ID_LESS_COLLECTIONS)) {
    assert(reason.trim().length >= 20, `ID_LESS_COLLECTIONS["${name}"] needs a real reason`);
  }
});

Deno.test("the three carve-outs are pinned BY NAME, and their idField values are asserted", () => {
  // ⚠️ Pinned by value rather than derived, because the derivation would agree
  // with whatever is written. These three are the entire reason `idField` exists;
  // if one silently changed, the guard downstream would start comparing `ref.id`
  // to a different field and the failure would look like a data problem.
  const expected: Record<string, string> = {
    roles: "name",
    "mcp-oauth-clients": "client_id",
    "uploadcare-worklist": "uuid",
  };
  for (const [collection, field] of Object.entries(expected)) {
    const schema = (schemas as Record<string, z.ZodType | undefined>)[collection];
    assert(schema, `${collection} is not in the registry`);
    assertEquals(declaredIdField(schema), field, `${collection}.idField`);
  }
});
