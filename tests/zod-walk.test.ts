import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  getNodeMeta,
  getServerSortableColumns,
  isDateField,
  isDateLikeNode,
  resolveFieldMeta,
  resolveZodField,
} from "../src/schemas/zod-walk.ts";
import { FirestoreTimestamp } from "../src/schemas/common.ts";
import { chicagoInstant, chicagoStartOfDay } from "../src/schemas/_datetime.ts";
import { InvoiceSchema } from "../src/schemas/invoice.ts";
import { DocDestination } from "../src/schemas/order.ts";
import { MovementSchema } from "../src/schemas/transaction.ts";

// ── isDateField on production schemas using the Chicago datetime factories ──

Deno.test("isDateField detects chicagoStartOfDay on invoice.date", () => {
  assertEquals(isDateField(InvoiceSchema, "date"), true);
});

Deno.test("isDateField detects chicagoStartOfDay on invoice.due_date (optional)", () => {
  assertEquals(isDateField(InvoiceSchema, "due_date"), true);
});

Deno.test("isDateField detects chicagoInstant on destination dates.delivery_start (nullable)", () => {
  assertEquals(isDateField(DocDestination, "dates.delivery_start"), true);
});

Deno.test("isDateField detects chicagoInstant on transaction.date (with pipe-level meta)", () => {
  assertEquals(isDateField(MovementSchema, "date"), true);
});

// ── Regression guards for pre-existing date shapes ──

Deno.test("isDateField detects a plain z.iso.datetime field", () => {
  const schema = z.object({ at: z.iso.datetime() });
  assertEquals(isDateField(schema, "at"), true);
});

Deno.test("isDateField detects a plain z.iso.date field", () => {
  const schema = z.object({ day: z.iso.date() });
  assertEquals(isDateField(schema, "day"), true);
});

Deno.test("isDateField detects a FirestoreTimestamp field", () => {
  const schema = z.object({ created_at: FirestoreTimestamp });
  assertEquals(isDateField(schema, "created_at"), true);
});

Deno.test("isDateField returns false for non-date string fields", () => {
  const schema = z.object({ name: z.string() });
  assertEquals(isDateField(schema, "name"), false);
});

Deno.test("isDateField returns false for missing paths", () => {
  const schema = z.object({ a: z.string() });
  assertEquals(isDateField(schema, "b"), false);
});

// ── isDateLikeNode on bare nodes ──

Deno.test("isDateLikeNode true for chicagoInstant()", () => {
  assertEquals(isDateLikeNode(chicagoInstant()), true);
});

Deno.test("isDateLikeNode true for chicagoStartOfDay()", () => {
  assertEquals(isDateLikeNode(chicagoStartOfDay()), true);
});

Deno.test("isDateLikeNode true for plain z.iso.datetime", () => {
  assertEquals(isDateLikeNode(z.iso.datetime()), true);
});

Deno.test("isDateLikeNode true for FirestoreTimestamp", () => {
  assertEquals(isDateLikeNode(FirestoreTimestamp), true);
});

Deno.test("isDateLikeNode false for z.string()", () => {
  assertEquals(isDateLikeNode(z.string()), false);
});

Deno.test("isDateLikeNode false for z.number()", () => {
  assertEquals(isDateLikeNode(z.number()), false);
});

// ── Meta preservation: pipe-level .meta() must still be discoverable ──
//
// `transaction.date` is declared as
//   `chicagoInstant().meta({ serverSortVia: "date_fs" })`
// — the meta is attached to the ZodPipe node. `unwrapPipes` is only applied
// inside the date-detection helpers; the meta-finding path (`unwrapZod` →
// `getNodeMeta`) must keep returning the pipe-level meta so
// `getServerSortableColumns` continues to work.

Deno.test("resolveFieldMeta still reads pipe-level meta on transaction.date", () => {
  const meta = resolveFieldMeta(MovementSchema, "date");
  assertEquals(meta?.serverSortVia, "date_fs");
});

Deno.test("getServerSortableColumns still includes transaction.date → date_fs", () => {
  const map = getServerSortableColumns(MovementSchema);
  assertEquals(map.date, "date_fs");
});

Deno.test("getNodeMeta on a chicagoInstant().meta(...) node returns the meta", () => {
  const node = chicagoInstant().meta({ serverSortVia: "foo_fs" });
  const resolved = resolveZodField(z.object({ x: node }), "x");
  assertEquals(getNodeMeta(resolved!)?.serverSortVia, "foo_fs");
});

// ── Record (dynamic-key map) traversal ───────────────────────────────
//
// `resolveZodField` walks `z.record(keyType, valueType)`: a path segment over a
// record consumes the dynamic key and resolves to the VALUE schema. This lets
// dotted field-paths into maps (e.g. Firestore `reactions.<emoji>.<uid>.name`
// patch keys) resolve to their leaf, so a patch validator can shape-check them.

Deno.test("resolveZodField walks a single z.record to its value schema", () => {
  const schema = z.object({ counts: z.record(z.string(), z.number()) });
  const leaf = resolveZodField(schema, "counts.anyKey");
  assertEquals(leaf?.safeParse(7).success, true);
  assertEquals(leaf?.safeParse("nope").success, false);
});

Deno.test("resolveZodField walks nested records to a leaf object field", () => {
  const Actor = z.strictObject({ uid: z.string(), name: z.string() });
  const schema = z.object({ reactions: z.record(z.string(), z.record(z.string(), Actor)) });
  // reactions.<emoji>.<uid> → Actor; .name → string
  const nameNode = resolveZodField(schema, "reactions.❤️.u1.name");
  assertEquals(nameNode?.safeParse("Alex").success, true);
  assertEquals(nameNode?.safeParse(123).success, false);
  // reactions.<emoji>.<uid> → the Actor object itself
  const actorNode = resolveZodField(schema, "reactions.❤️.u1");
  assertEquals(actorNode?.safeParse({ uid: "x", name: "y" }).success, true);
});

Deno.test("resolveZodField returns null for an unknown key on a record's value object", () => {
  const Actor = z.strictObject({ uid: z.string(), name: z.string() });
  const schema = z.object({ reactions: z.record(z.string(), Actor) });
  assertEquals(resolveZodField(schema, "reactions.❤️.bogus"), null);
});

Deno.test("resolveZodField { unwrap: false } preserves the leaf's nullable/optional wrappers", () => {
  const schema = z.object({ deleted_at: FirestoreTimestamp.nullable() });
  // Default (unwrap: true) strips .nullable() → inner rejects null.
  assertEquals(resolveZodField(schema, "deleted_at")?.safeParse(null).success, false);
  // unwrap: false keeps .nullable() → a null write is accepted (field as declared).
  const asDeclared = resolveZodField(schema, "deleted_at", { unwrap: false });
  assertEquals(asDeclared?.safeParse(null).success, true);
  // …but a wrong-typed value is still rejected.
  assertEquals(asDeclared?.safeParse(123).success, false);
});
