/**
 * Coverage symmetry test for the typed log record registry.
 *
 * Asserts that the {@link MSG_SCHEMA_REGISTRY} keys exactly match the
 * set of `msg` literals carried by the {@link TypedLogRecord} union's
 * member schemas. Adding a new arm without registering it (or vice
 * versa) fails here.
 *
 * The complementary "every emitted msg in api-cloudrun source has a
 * registry entry" check lives in api-cloudrun's
 * `tests/unit/logRecordCoverage.test.ts` (added in Phase 2).
 */

import { assertEquals } from "@std/assert";
import type { z } from "zod";
import { MSG_SCHEMA_REGISTRY } from "../src/schemas/log/mod.ts";

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

Deno.test("MSG_SCHEMA_REGISTRY: contains every Phase 0 archetype", () => {
  const phase0 = [
    "dmarc_aggregate_record",
    "email_send_failed",
    "email_sent",
    "oauth_refresh",
    "propagation",
    "request",
    "sync_error",
    "transaction",
    "validation_error",
  ];
  const actual = new Set(MSG_SCHEMA_REGISTRY.keys());
  for (const key of phase0) {
    assertEquals(actual.has(key), true, `Missing Phase 0 archetype "${key}"`);
  }
});
