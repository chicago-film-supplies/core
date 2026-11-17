/**
 * Ruling 109 of the one-document-model plan, beta H1: a billing or credit
 * document's pair scope is `uid_source` and its rows' move pointer is
 * `path_source_item`, on both sides. Through the window the retiring spellings
 * (`uid_order` / `uid_purchase`, `path_order_item` / `path_purchase_item`) are
 * still READ, and nothing writes them. Beta H2 deletes them and this file's
 * window arms with them.
 */
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  canonicalSourceKeys,
  pairSourceUid,
  rowSourcePath,
  withRowSourcePath,
} from "../src/schemas/mod.ts";

const O = "testorder10000000000";

Deno.test("pairSourceUid: the one key first, then either retiring spelling", () => {
  assertEquals(pairSourceUid({ uid_source: O }), O);
  assertEquals(pairSourceUid({ uid_order: O }), O);
  assertEquals(pairSourceUid({ uid_purchase: O }), O);
  assertEquals(pairSourceUid({}), undefined);
});

Deno.test("rowSourcePath / withRowSourcePath: read any spelling, write only the one", () => {
  assertEquals(rowSourcePath({ path_order_item: ["a"] }), ["a"]);
  assertEquals(rowSourcePath({ path_purchase_item: ["b"] }), ["b"]);
  assertEquals(rowSourcePath({ path_source_item: ["c"], path_order_item: ["a"] }), ["c"]);
  const moved = withRowSourcePath({ uid: "x", path_order_item: ["a"] }, ["d"]);
  assertEquals(moved as unknown, { uid: "x", path_source_item: ["d"] });
  const cleared = withRowSourcePath({ uid: "x", path_purchase_item: ["a"] }, undefined);
  assertEquals(cleared as unknown, { uid: "x" });
});

Deno.test("canonicalSourceKeys: every pair and row onto the one spelling; untouched ones are the same object", () => {
  const plainRow = { uid: "p", path: [O, "p"] };
  const plainPair = { uid: "q", uid_source: O };
  const doc = {
    uid: "inv",
    destinations: [{ uid: "d", uid_order: O }, plainPair, { uid: "e", uid_purchase: O }],
    items: [{ uid: "r", path: [O, "r"], path_order_item: ["x"] }, plainRow, { uid: "s", path: [O, "s"], path_purchase_item: ["y"] }],
  };
  const out = canonicalSourceKeys(doc);
  assertEquals(out.destinations, [{ uid: "d", uid_source: O }, plainPair, { uid: "e", uid_source: O }] as typeof out.destinations);
  assertEquals(out.items, [{ uid: "r", path: [O, "r"], path_source_item: ["x"] }, plainRow, { uid: "s", path: [O, "s"], path_source_item: ["y"] }] as typeof out.items);
  assertStrictEquals(out.items[1], plainRow);
  assertStrictEquals(out.destinations[1], plainPair);
  assertEquals(out.uid, "inv");
  // A document with neither array passes through with neither.
  const bare: { uid: string; items?: object[] } = { uid: "x" };
  assertEquals(Object.keys(canonicalSourceKeys(bare)), ["uid"]);
});
