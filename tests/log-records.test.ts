/**
 * Symmetry tests for the typed log record surface.
 *
 * Three things must agree, and nothing but these tests makes them:
 *
 *   1. the {@link TypedLogRecord} union (a TYPE — what `logTyped` accepts),
 *   2. the archetype schemas `log/mod.ts` exports (`*LogRecordSchema`), and
 *   3. {@link MSG_SCHEMA_REGISTRY} (a runtime map — what the PII walker reads).
 *
 * (1) ↔ (2) is checked at COMPILE time below: the union's `msg` set must equal
 * the `msg` set the exported schemas' output types carry. (2) ↔ (3) is checked
 * at runtime: every msg an exported schema accepts is a registry key mapping to
 * THAT schema, and every registry value is an exported schema. Either half
 * failing means an arm was added to one place and not the others.
 *
 * The complementary "every emitted msg in api-cloudrun source has a registry
 * entry" check lives in `api-cloudrun/tests/unit/logRecordCoverage.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import type { z } from "zod";
import * as LogMod from "../src/schemas/log/mod.ts";
import { MSG_SCHEMA_REGISTRY, type TypedLogRecord } from "../src/schemas/log/mod.ts";

interface ZodInternalDef {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  /** Zod 4 stores literal values as an array (single-arg literals are a 1-element array). */
  values?: readonly unknown[];
  /** Zod 4 stores enum values as `entries: Record<string, string>`. */
  entries?: Record<string, string>;
}

function getDef(node: z.ZodType): ZodInternalDef {
  return (node as unknown as { _zod: { def: ZodInternalDef } })._zod.def;
}

/** Walk wrappers until we hit the object node. */
function unwrap(node: z.ZodType): z.ZodType {
  let n = node;
  while (true) {
    const d = getDef(n);
    if (d.innerType && (d.type === "optional" || d.type === "default" || d.type === "nullable")) {
      n = d.innerType;
      continue;
    }
    return n;
  }
}

/**
 * Extract the set of `msg` values a record's schema accepts.
 *
 * - Phase 0 per-msg arms use `z.literal("...")` — returns a 1-element set.
 * - Phase 3 archetype arms use `z.enum([...])` — returns the enum's
 *   accepted values.
 *
 * Returns null if the schema's `msg` field is shaped unexpectedly (would
 * indicate a malformed arm).
 */
function extractMsgAccepted(schema: z.ZodType): Set<string> | null {
  const obj = unwrap(schema);
  const shape = getDef(obj).shape;
  if (!shape || !shape.msg) return null;
  const msgDef = getDef(unwrap(shape.msg));
  if (msgDef.type === "literal") {
    if (!msgDef.values || msgDef.values.length !== 1) return null;
    const v = msgDef.values[0];
    return typeof v === "string" ? new Set([v]) : null;
  }
  if (msgDef.type === "enum") {
    if (!msgDef.entries) return null;
    return new Set(Object.values(msgDef.entries));
  }
  return null;
}

Deno.test("MSG_SCHEMA_REGISTRY: each entry's key is accepted by its schema's msg", () => {
  for (const [key, schema] of MSG_SCHEMA_REGISTRY.entries()) {
    const accepted = extractMsgAccepted(schema);
    if (!accepted) {
      throw new Error(
        `Registry key "${key}" — schema's msg field is not a literal or enum.`,
      );
    }
    if (!accepted.has(key)) {
      throw new Error(
        `Registry key "${key}" is not in its schema's accepted msg set ` +
          `[${[...accepted].join(", ")}].`,
      );
    }
  }
});

// ── (1) ↔ (2): the union against the exported schemas, at compile time ──

/**
 * Every `*LogRecordSchema` export except the generic envelope, whose `msg` is a
 * bare `string` and would swallow the comparison.
 */
type ArmSchemaKey = Exclude<
  Extract<keyof typeof LogMod, `${string}LogRecordSchema`>,
  "LogRecordSchema"
>;
type ExportedArmMsg = {
  [K in ArmSchemaKey]: z.output<(typeof LogMod)[K]> extends { msg: infer M } ? M : never;
}[ArmSchemaKey];
type UnionMsg = TypedLogRecord["msg"];

/** Compiles only when `A` and `B` are the same set. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _unionMatchesExports: Same<UnionMsg, ExportedArmMsg> = true;
// The guard above is vacuous if `ExportedArmMsg` collapses to `string` (an
// envelope-shaped arm leaking in) — then any union "matches". Pin that it does not.
const _exportsAreLiterals: Same<string extends ExportedArmMsg ? true : false, false> = true;
void _unionMatchesExports;
void _exportsAreLiterals;

// ── (2) ↔ (3): the exported schemas against the registry, at runtime ──

function exportedArmSchemas(): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  for (const [name, value] of Object.entries(LogMod)) {
    if (name === "LogRecordSchema" || !name.endsWith("LogRecordSchema")) continue;
    out.set(name, value as z.ZodType);
  }
  return out;
}

/** Every disagreement between a set of arm schemas and a registry, as prose. */
function registryAsymmetries(
  arms: ReadonlyMap<string, z.ZodType>,
  registry: ReadonlyMap<string, z.ZodType>,
): string[] {
  const problems: string[] = [];
  const armSchemas = new Set(arms.values());
  for (const [name, schema] of arms) {
    const accepted = extractMsgAccepted(schema);
    if (!accepted) {
      problems.push(`${name}: msg field is not a literal or enum`);
      continue;
    }
    for (const msg of accepted) {
      const registered = registry.get(msg);
      if (!registered) problems.push(`${name} accepts "${msg}", which is not a registry key`);
      else if (registered !== schema) {
        problems.push(`registry maps "${msg}" to a different schema than ${name}`);
      }
    }
  }
  for (const [msg, schema] of registry) {
    if (!armSchemas.has(schema)) {
      problems.push(`registry key "${msg}" maps to a schema mod.ts does not export as an arm`);
    }
  }
  return problems;
}

Deno.test("MSG_SCHEMA_REGISTRY: exactly the msgs the exported arm schemas accept", () => {
  const arms = exportedArmSchemas();
  // A filter that matched nothing would pass the forward half vacuously; one
  // that missed SOME arms fails the reverse half (their registry keys point at
  // a schema not in `arms`).
  assert(arms.size > 0, "no *LogRecordSchema exports found");
  assertEquals(registryAsymmetries(arms, MSG_SCHEMA_REGISTRY), []);
});

Deno.test("registryAsymmetries: a planted asymmetry in either direction is reported", () => {
  const arms = exportedArmSchemas();
  const dropped = new Map(MSG_SCHEMA_REGISTRY);
  dropped.delete("propagation");
  assert(
    registryAsymmetries(arms, dropped).some((p) => p.includes(`"propagation"`)),
    "an arm msg missing from the registry must be reported",
  );
  const stray = new Map(MSG_SCHEMA_REGISTRY);
  stray.set("not_an_arm", LogMod.LogRecordSchema as z.ZodType);
  assert(
    registryAsymmetries(arms, stray).some((p) => p.includes(`"not_an_arm"`)),
    "a registry entry with no exported arm must be reported",
  );
});

Deno.test("MSG_SCHEMA_REGISTRY: contains every per-msg arm", () => {
  // A hand list on purpose: the symmetry checks above cannot see an arm deleted
  // from the union, the exports and the registry together.
  const perMsg = [
    "client_log",
    "dmarc_aggregate_record",
    "email_send_failed",
    "email_sent",
    "ledger_group_commit",
    "oauth_refresh",
    "propagation",
    "request",
    "sync_error",
    "transaction",
    "validation_error",
  ];
  const actual = new Set(MSG_SCHEMA_REGISTRY.keys());
  for (const key of perMsg) {
    assertEquals(actual.has(key), true, `Missing per-msg arm "${key}"`);
  }
});
