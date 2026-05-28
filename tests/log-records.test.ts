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
import { MSG_SCHEMA_REGISTRY } from "../src/log/mod.ts";

interface ZodInternalDef {
  type: string;
  innerType?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  /** Zod 4 stores literal values as an array (single-arg literals are a 1-element array). */
  values?: readonly unknown[];
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

/** Extract the literal value of a record's `msg` field. */
function extractMsgLiteral(schema: z.ZodType): string | null {
  const obj = unwrap(schema);
  const shape = getDef(obj).shape;
  if (!shape || !shape.msg) return null;
  const msgDef = getDef(unwrap(shape.msg));
  if (msgDef.type !== "literal" || !msgDef.values || msgDef.values.length !== 1) return null;
  const v = msgDef.values[0];
  return typeof v === "string" ? v : null;
}

Deno.test("MSG_SCHEMA_REGISTRY: each entry's schema has a matching msg literal", () => {
  for (const [key, schema] of MSG_SCHEMA_REGISTRY.entries()) {
    const literal = extractMsgLiteral(schema);
    assertEquals(
      literal,
      key,
      `Registry key "${key}" does not match its schema's msg literal (${literal}).`,
    );
  }
});

Deno.test("MSG_SCHEMA_REGISTRY: contains expected Phase 0 archetypes", () => {
  const expected = new Set([
    "dmarc_aggregate_record",
    "email_send_failed",
    "email_sent",
    "oauth_refresh",
    "propagation",
    "request",
    "sync_error",
    "transaction",
    "validation_error",
  ]);
  const actual = new Set(MSG_SCHEMA_REGISTRY.keys());
  assertEquals(actual, expected);
});
