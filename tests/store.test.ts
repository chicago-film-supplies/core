import { assertEquals } from "@std/assert";
import { StoreSchema } from "../src/schemas/store.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

Deno.test("StoreSchema validates a complete document", () => {
  const doc = {
    uid: "teststore10000000000",
    name: "Main Warehouse",
    default: true,
    crms_store_id: 100,
    active: true,
    ...ts,
  };
  assertEquals(StoreSchema.safeParse(doc).success, true);
});

Deno.test("StoreSchema rejects missing required fields", () => {
  assertEquals(StoreSchema.safeParse({ uid: "teststore10000000000" }).success, false);
});

Deno.test("StoreSchema rejects additional properties", () => {
  const doc = {
    uid: "teststore10000000000",
    name: "Main",
    default: false,
    crms_store_id: 1,
    active: true,
    bogus: true,
  };
  assertEquals(StoreSchema.safeParse(doc).success, false);
});

Deno.test("StoreSchema requires the boolean fields the Typesense index requires", () => {
  // These carried `.default(false)` / `.default(true)`, which made the parse
  // pass while leaving the stored doc missing the field — `validateBeforeWrite`
  // persists the RAW doc, so a default never materializes. The index declares
  // both required, so such a doc could never be indexed. See
  // `tests/typesense-parity.test.ts`.
  const doc = { uid: "teststore10000000000", name: "Main", crms_store_id: 1, ...ts };
  assertEquals(StoreSchema.safeParse(doc).success, false);

  const complete = { ...doc, default: false, active: true };
  const result = StoreSchema.safeParse(complete);
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.default, false);
    assertEquals(result.data.active, true);
  }
});
