import { assertEquals } from "@std/assert";
import { BookingId, EventCardId, FirestoreId, ItemUid, QuoteId, StockSummaryId, ThreadId } from "../src/schemas/_uid.ts";
import { bookingId, fid, stockSummaryId } from "./helpers/ids.ts";

const accepts = (s: { safeParse(v: unknown): { success: boolean } }, v: string) =>
  assertEquals(s.safeParse(v).success, true, `expected accept: ${v}`);
const rejects = (s: { safeParse(v: unknown): { success: boolean } }, v: string) =>
  assertEquals(s.safeParse(v).success, false, `expected reject: ${v}`);

Deno.test("FirestoreId accepts 20-char alphanumeric ids", () => {
  accepts(FirestoreId, "0BIQ73UMiHTtd8mo0yNk");
  accepts(FirestoreId, "k7Hq2mNpQ4rStUvWxYz0");
});

Deno.test("FirestoreId rejects non-auto-ids", () => {
  rejects(FirestoreId, "test-prod-1"); // hyphens
  rejects(FirestoreId, "manager-bot"); // synthetic actor
  rejects(FirestoreId, "0BIQ73UMiHTtd8mo0yN"); // 19 chars
  rejects(FirestoreId, "0BIQ73UMiHTtd8mo0yNkX"); // 21 chars
  rejects(FirestoreId, ""); // empty
  rejects(FirestoreId, "fe847108-d824-4f3a-aac8-ce60a9743ffc"); // uuid
});

Deno.test("ItemUid accepts product ids, divider UUIDs, and custom-product ids", () => {
  accepts(ItemUid, "U8WC4Js2oPaTdYpkvbcx"); // product id
  accepts(ItemUid, "fe847108-d824-4f3a-aac8-ce60a9743ffc"); // divider uuid
  accepts(ItemUid, "custom-fe847108-d824-4f3a-aac8-ce60a9743ffc"); // custom product
});

Deno.test("ItemUid rejects malformed ids", () => {
  rejects(ItemUid, "custom-nope");
  rejects(ItemUid, "test-item-1");
});

Deno.test("BookingId accepts {order}:{item}:{dest}, incl. custom middle", () => {
  accepts(BookingId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:gka5vla5wQO1xlSsR7UG");
  accepts(
    BookingId,
    "00iNtfho7YCp6FllPi9f:custom-fe847108-d824-4f3a-aac8-ce60a9743ffc:gka5vla5wQO1xlSsR7UG",
  );
});

Deno.test("BookingId rejects wrong arity / bad segments", () => {
  rejects(BookingId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk"); // 2 parts
  rejects(BookingId, "00iNtfho7YCp6FllPi9f:bad:gka5vla5wQO1xlSsR7UG");
});

Deno.test("StockSummaryId accepts rental + sale forms", () => {
  accepts(StockSummaryId, "0q6NhsjASVnRH5PqKLKP:rental:2026-05-31:2036-05-31");
  accepts(StockSummaryId, "0q6NhsjASVnRH5PqKLKP:sale:2026-05-31");
});

Deno.test("StockSummaryId rejects bad type / missing date", () => {
  rejects(StockSummaryId, "0q6NhsjASVnRH5PqKLKP:rental:2026-05-31"); // missing end
  rejects(StockSummaryId, "0q6NhsjASVnRH5PqKLKP:lease:2026-05-31"); // bad type
});

Deno.test("QuoteId accepts {order}:v{N} and {order}:draft", () => {
  accepts(QuoteId, "00iNtfho7YCp6FllPi9f:v1");
  accepts(QuoteId, "00iNtfho7YCp6FllPi9f:v42");
  accepts(QuoteId, "00iNtfho7YCp6FllPi9f:draft");
});

Deno.test("QuoteId rejects bad order segment / version / arity", () => {
  rejects(QuoteId, "test-order:v1"); // bad order id (hyphens)
  rejects(QuoteId, "00iNtfho7YCp6FllPi9f:v"); // missing version number
  rejects(QuoteId, "00iNtfho7YCp6FllPi9f:draft:extra"); // extra segment
  rejects(QuoteId, "00iNtfho7YCp6FllPi9f"); // plain FirestoreId, not a quote uid
});

Deno.test("EventCardId accepts {order}:{dest}:start|end", () => {
  accepts(EventCardId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:start");
  accepts(EventCardId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:end");
});

Deno.test("EventCardId rejects bad position / non-id segments / sentinel middle", () => {
  rejects(EventCardId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:middle"); // bad position
  rejects(EventCardId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk"); // missing position
  rejects(EventCardId, "00iNtfho7YCp6FllPi9f:unknown:start"); // sentinel dest, not a fid
});

Deno.test("ThreadId accepts a plain FirestoreId (default-thread cowrite)", () => {
  accepts(ThreadId, "0BIQ73UMiHTtd8mo0yNk");
});

Deno.test("ThreadId accepts an EventCardId composite (deterministic event-card thread)", () => {
  // Event-card threads are minted at id === card uid so a delete→recreate burst
  // reuses the same thread doc; see api-cloudrun eventCardReconcile.eventCardThreadId.
  accepts(ThreadId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:start");
  accepts(ThreadId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:end");
});

Deno.test("ThreadId rejects garbage / wrong-shaped composites", () => {
  rejects(ThreadId, "thread-1"); // hyphens
  rejects(ThreadId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk"); // booking-arity, no position
  rejects(ThreadId, "00iNtfho7YCp6FllPi9f:0BIQ73UMiHTtd8mo0yNk:start:extra"); // extra segment
  rejects(ThreadId, ""); // empty
});

Deno.test("fixture id helpers produce validator-compliant ids", () => {
  const prod = fid("test-prod-1");
  assertEquals(prod.length, 20);
  accepts(FirestoreId, prod);
  accepts(ItemUid, prod);
  accepts(BookingId, bookingId(fid("o"), fid("p"), fid("d")));
  accepts(StockSummaryId, stockSummaryId(fid("p"), "rental", "2026-03-01", "2036-03-01"));
  accepts(StockSummaryId, stockSummaryId(fid("p"), "sale", "2026-03-01"));
});
