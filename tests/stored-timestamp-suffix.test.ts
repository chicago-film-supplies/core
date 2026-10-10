/**
 * A stored key ending in `_fs` is a Firestore `Timestamp` — nullable allowed,
 * anything else refused.
 *
 * ## Why the suffix is a contract
 *
 * `_fs` is how a reader knows, without opening the schema, that a field sorts,
 * filters and `toMillis()`s as a Firestore time. A `_fs` field typed as an ISO
 * string or a number reads correctly in a parse and breaks every range query
 * and every `toMillis()` reader in api-cloudrun and the manager. The write guard
 * (`isRawTimestampMap`, `api-cloudrun/src/lib/validate.ts`) refuses a map-shaped
 * VALUE; this pins the DECLARATION, which the guard cannot see.
 *
 * ## One-way on purpose
 *
 * There is no reverse arm. `deleted_at`, `expires_at`, `pushed_at`, `created_at`
 * and others are legitimate Timestamps without the suffix, so "a Timestamp must
 * end in `_fs`" would be false today.
 *
 * ## Scope
 *
 * Walks `schemas` — the Firestore registry — so input schemas and Typesense
 * documents are excluded by construction (see `stored-optionality.test.ts` for
 * why a registry walk beats a spelling grep). The walk is `collectLeafPaths`,
 * which crosses arrays, records and union arms and fails closed on anything it
 * cannot interpret; the plants below prove it reaches each.
 */
import { assert, assertEquals } from "@std/assert";
import { z } from "zod";
import { FirestoreTimestamp } from "../src/schemas/common.ts";
import { schemas } from "../src/schemas/mod.ts";
import { collectLeafPaths, isFirestoreTimestampNode } from "../src/schemas/zod-walk.ts";

/** `_fs` leaves of `schema` that are neither a Timestamp nor `null`. */
function offenders(schema: z.ZodType): { checked: number; bad: string[]; unhandled: string[] } {
  const { leaves, unhandled } = collectLeafPaths(schema);
  let checked = 0;
  const bad: string[] = [];
  for (const leaf of leaves) {
    const key = leaf.path.split(".").at(-1)!.replace(/(\[\])+$/, "");
    if (!key.endsWith("_fs")) continue;
    checked++;
    // `.nullable()` on a union-shaped field surfaces its `null` arm as a leaf.
    if (leaf.type === "null") continue;
    if (!isFirestoreTimestampNode(leaf.node)) bad.push(`${leaf.path} (${leaf.type})`);
  }
  return { checked, bad, unhandled: unhandled.map((u) => `${u.path} (${u.type})`) };
}

Deno.test("stored _fs keys — every one in the registry is a FirestoreTimestamp", () => {
  let checked = 0;
  const bad: string[] = [];
  const unhandled: string[] = [];
  for (const [collection, schema] of Object.entries(schemas)) {
    const r = offenders(schema as z.ZodType);
    checked += r.checked;
    bad.push(...r.bad.map((p) => `${collection}.${p}`));
    unhandled.push(...r.unhandled.map((p) => `${collection}.${p}`));
  }
  assertEquals(unhandled, [], "the walk refused nodes, so any verdict below is unsound");
  // 58 measured 2026-10-09. A floor, not an exact count: adding a field is fine.
  assert(checked >= 50, `only ${checked} _fs leaves found — the walk is inert`);
  assertEquals(bad, [], "a stored `_fs` key must be FirestoreTimestamp (nullable allowed)");
});

Deno.test("stored _fs keys — the walk sees a plain string, inside arrays and union arms", () => {
  const plant = z.strictObject({
    ok_fs: FirestoreTimestamp,
    ok_null_fs: FirestoreTimestamp.nullable(),
    ok_labelled_fs: FirestoreTimestamp.meta({ title: "Labelled" }),
    top_fs: z.string(),
    rows: z.array(z.strictObject({ deep_fs: z.number(), list_fs: z.array(z.string()) })),
    either: z.union([
      z.strictObject({ kind: z.literal("a"), arm_fs: FirestoreTimestamp }),
      z.strictObject({ kind: z.literal("b"), arm_fs: z.iso.datetime() }),
    ]),
  });
  const r = offenders(plant);
  assertEquals(r.unhandled, []);
  assertEquals(r.bad.sort(), [
    "either.arm_fs (string)",
    "rows[].deep_fs (number)",
    "rows[].list_fs[] (string)",
    "top_fs (string)",
  ]);
});
