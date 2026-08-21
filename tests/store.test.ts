import { assertEquals } from "@std/assert";
import { StoreSchema } from "../src/schemas/store.ts";
import { mockTimestamp } from "./helpers/timestamp.ts";

const ts = { created_at: mockTimestamp, updated_at: mockTimestamp };

/**
 * A MINIMAL VALID store, so every negative case below fails for exactly the
 * reason it names.
 *
 * ⚠️ **This factory exists because `jurisdiction` became required (2026-08-21)
 * and the two positive tests here went red — which is the harmless half.** The
 * dangerous half is the negative tests: each had its fields spelled inline, so
 * requiring one more field silently rewrote every one of them into "fails for
 * SOME reason", and the boolean test below would have kept passing while
 * asserting nothing about booleans at all.
 */
const validStore = (overrides: Record<string, unknown> = {}) => ({
  uid: "teststore10000000000",
  name: "Main Warehouse",
  default: true,
  crms_store_id: 100,
  jurisdiction: "chicago",
  active: true,
  ...ts,
  ...overrides,
});

Deno.test("StoreSchema validates a complete document", () => {
  assertEquals(StoreSchema.safeParse(validStore()).success, true);
});

Deno.test("StoreSchema rejects missing required fields", () => {
  assertEquals(StoreSchema.safeParse({ uid: "teststore10000000000" }).success, false);
});

Deno.test("StoreSchema rejects additional properties", () => {
  assertEquals(StoreSchema.safeParse(validStore({ bogus: true })).success, false);
});

Deno.test("StoreSchema requires the boolean fields the Typesense index requires", () => {
  // These carried `.default(false)` / `.default(true)`, which made the parse
  // pass while leaving the stored doc missing the field — `validateBeforeWrite`
  // persists the RAW doc, so a default never materializes. The index declares
  // both required, so such a doc could never be indexed. See
  // `tests/typesense-parity.test.ts`.
  //
  // Dropped from a VALID doc one at a time, so each arm fails for its own field
  // rather than for whatever else the inline literal happened to omit.
  for (const field of ["default", "active"] as const) {
    const doc = validStore();
    delete (doc as Record<string, unknown>)[field];
    assertEquals(StoreSchema.safeParse(doc).success, false, field);
  }

  const result = StoreSchema.safeParse(validStore({ default: false, active: true }));
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.default, false);
    assertEquals(result.data.active, true);
  }
});

Deno.test("🔴 StoreSchema requires `jurisdiction`, and does not accept null", () => {
  // The ORIGIN. `requireOriginJurisdiction` throws on a store that cannot
  // resolve one, and that throw is on the pricing path of every order and
  // invoice write assigned to the store — so an absent origin is an outage for
  // that store, not a gap someone reports. Both spellings of the defect are
  // refused, because a stored `null` throws exactly like an absent field.
  const absent = validStore();
  delete (absent as Record<string, unknown>).jurisdiction;
  assertEquals(StoreSchema.safeParse(absent).success, false, "absent");
  assertEquals(StoreSchema.safeParse(validStore({ jurisdiction: null })).success, false, "null");
  assertEquals(
    StoreSchema.safeParse(validStore({ jurisdiction: "nowhere" })).success,
    false,
    "not a JurisdictionEnum member",
  );
});
