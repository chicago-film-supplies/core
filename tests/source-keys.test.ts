/**
 * Ruling 109 of the one-document-model plan, beta H2: a billing or credit
 * document's pair scope is `uid_source` and its rows' move pointer is
 * `path_source_item`, on both sides. The H1 spellings (`uid_order` /
 * `uid_purchase` on a pair, `path_order_item` / `path_purchase_item` on a row)
 * are deleted, so a stored document still carrying one is refused rather than
 * read.
 */
import { assert, assertEquals } from "@std/assert";
import { mockTimestamp } from "./helpers/timestamp.ts";
import { getTestDoc } from "../src/schemas/testing.ts";
import { InvoiceDocDestination, PurchaseDocDestinationSchema, withRowSourcePath } from "../src/schemas/mod.ts";

const O = "testorder10000000000";
const NOW = { now: mockTimestamp };

/** The keys a strict parse refused as unrecognized. */
function unrecognized(result: { success: boolean; error?: { issues: readonly { code: string; keys?: readonly string[] }[] } }): string[] {
  return (result.error?.issues ?? []).flatMap((i) => i.code === "unrecognized_keys" ? [...(i.keys ?? [])] : []);
}

Deno.test("an invoice pair names its order on uid_source; the retired uid_order is refused", () => {
  const pair = getTestDoc(InvoiceDocDestination, { uid_source: O }, NOW);
  assert(InvoiceDocDestination.safeParse(pair).success);
  assertEquals(unrecognized(InvoiceDocDestination.safeParse({ ...pair, uid_order: O })), ["uid_order"]);
  const { uid_source: _s, ...unscoped } = pair;
  assert(!InvoiceDocDestination.safeParse(unscoped).success, "uid_source is required");
});

Deno.test("a bill pair names its purchase on uid_source; the retired uid_purchase is refused", () => {
  const pair = getTestDoc(PurchaseDocDestinationSchema, { uid_source: O }, NOW);
  assert(PurchaseDocDestinationSchema.safeParse(pair).success);
  assertEquals(unrecognized(PurchaseDocDestinationSchema.safeParse({ ...pair, uid_purchase: O })), ["uid_purchase"]);
});

Deno.test("withRowSourcePath: sets the one move pointer, and undefined clears it", () => {
  assertEquals(withRowSourcePath({ uid: "x" }, ["d"]) as unknown, { uid: "x", path_source_item: ["d"] });
  assertEquals(withRowSourcePath({ uid: "x", path_source_item: ["a"] }, undefined) as unknown, { uid: "x" });
});
