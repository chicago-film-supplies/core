import { assertEquals } from "@std/assert";
import { BookingId, FirestoreId, ItemUid, QuoteId, StockSummaryId } from "../src/_uid.ts";
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

Deno.test("fixture id helpers produce validator-compliant ids", () => {
  const prod = fid("test-prod-1");
  assertEquals(prod.length, 20);
  accepts(FirestoreId, prod);
  accepts(ItemUid, prod);
  accepts(BookingId, bookingId(fid("o"), fid("p"), fid("d")));
  accepts(StockSummaryId, stockSummaryId(fid("p"), "rental", "2026-03-01", "2036-03-01"));
  accepts(StockSummaryId, stockSummaryId(fid("p"), "sale", "2026-03-01"));
});
