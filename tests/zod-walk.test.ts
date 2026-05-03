import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  getNodeMeta,
  getServerSortableColumns,
  isDateField,
  isDateLikeNode,
  resolveFieldMeta,
  resolveZodField,
} from "../src/zod-walk.ts";
import { FirestoreTimestamp } from "../src/common.ts";
import { chicagoInstant, chicagoStartOfDay } from "../src/_datetime.ts";
import { InvoiceSchema } from "../src/invoice.ts";
import { OrderSchema } from "../src/order.ts";
import { TransactionSchema } from "../src/transaction.ts";

// ── isDateField on production schemas using the Chicago datetime factories ──

Deno.test("isDateField detects chicagoStartOfDay on invoice.date", () => {
  assertEquals(isDateField(InvoiceSchema, "date"), true);
});

Deno.test("isDateField detects chicagoStartOfDay on invoice.due_date (optional)", () => {
  assertEquals(isDateField(InvoiceSchema, "due_date"), true);
});

Deno.test("isDateField detects chicagoInstant on order.dates.delivery_start (nullable)", () => {
  assertEquals(isDateField(OrderSchema, "dates.delivery_start"), true);
});

Deno.test("isDateField detects chicagoInstant on transaction.date (with pipe-level meta)", () => {
  assertEquals(isDateField(TransactionSchema, "date"), true);
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
  const meta = resolveFieldMeta(TransactionSchema, "date");
  assertEquals(meta?.serverSortVia, "date_fs");
});

Deno.test("getServerSortableColumns still includes transaction.date → date_fs", () => {
  const map = getServerSortableColumns(TransactionSchema);
  assertEquals(map.date, "date_fs");
});

Deno.test("getNodeMeta on a chicagoInstant().meta(...) node returns the meta", () => {
  const node = chicagoInstant().meta({ serverSortVia: "foo_fs" });
  const resolved = resolveZodField(z.object({ x: node }), "x");
  assertEquals(getNodeMeta(resolved!)?.serverSortVia, "foo_fs");
});
