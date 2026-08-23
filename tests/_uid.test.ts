import { assertEquals } from "@std/assert";
import {
  AnyUid,
  BookingId,
  EventCardId,
  FirestoreId,
  ItemUid,
  ListId,
  QuoteId,
  RoleId,
  SEEDED_ROLE_NAMES,
  ThreadId,
} from "../src/schemas/_uid.ts";
import { bookingId, fid } from "./helpers/ids.ts";

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
});

// ── RoleId ──────────────────────────────────────────────────────────

Deno.test("RoleId accepts every live role name in both environments", () => {
  // Measured 2026-08-23 against prod AND dev: 6 roles each, identical sets,
  // plus every `users.roles[]` / `invites.roles[]` entry and every
  // `threads.sources[]` entry with `collection: "roles"`. 0 would have failed.
  // Pinned here so the corpus check does not have to be re-run to trust it.
  for (const name of SEEDED_ROLE_NAMES) accepts(RoleId, name);
});

Deno.test("RoleId REJECTS underscores — the `on_call` defect this fixes", () => {
  // ⚠️ The specific bug core#59 closes. `roles.name` and `sessions.preview_role`
  // allowed `[a-z0-9_-]` while `AnyUid`'s slug arm allowed only `[a-z0-9-]`. So
  // a role named `on_call` PASSED its own schema and then failed its own
  // creation transaction, because the `threads.sources[]` entry minted beside it
  // is gated on `AnyUid`. Two spellings of one shape, disagreeing.
  rejects(RoleId, "on_call");
  rejects(RoleId, "some_role");
});

Deno.test("RoleId and AnyUid agree on every slug — they share one fragment", () => {
  // The property that makes the above unrepresentable rather than merely fixed:
  // a value RoleId accepts must be one AnyUid accepts, or a role can be created
  // that cannot be referenced. Both now derive from the same SLUG constant, so
  // this asserts the wiring rather than re-checking a regex.
  for (const name of [...SEEDED_ROLE_NAMES, "a", "on-call", "x9-y8"]) {
    accepts(RoleId, name);
    accepts(AnyUid, name);
    accepts(ListId, name);
  }
  // …and a value one rejects, all reject.
  for (const bad of ["on_call", "9lives", "-lead", "Upper"]) {
    rejects(RoleId, bad);
    rejects(AnyUid, bad);
  }
});

Deno.test("RoleId enforces the 64-char cap — a Firebase token-size constraint", () => {
  // Not cosmetic: `customClaims.roles[]` must stay inside Firebase's 1000-byte
  // limit, so the per-role cap is what bounds the claim.
  accepts(RoleId, "a".repeat(64));
  rejects(RoleId, "a".repeat(65));
  rejects(RoleId, "");
});

// ── Barrel reachability ─────────────────────────────────────────────

Deno.test("every _uid.ts value export is reachable from the @cfs/core/schemas barrel", async () => {
  // ⚠️ **A hand-maintained re-export list, and it has already drifted once.**
  // `_uid.ts` is internal; its validators reach consumers only because
  // `schemas/common.ts` re-exports them AND `schemas/mod.ts` names each one
  // again in an explicit list. Adding `RoleId` to `schemas/common.ts` was not
  // enough — it stayed invisible to every consumer until it was written into
  // `schemas/mod.ts` as well, and nothing in this package said so:
  // core type-checked, the tests passed, and the failure surfaced in another
  // repo as "has no exported member named 'RoleId'".
  //
  // That is precisely the class `CLAUDE.md` § Propagation records — 141
  // hand-listed re-exports of which 60 had silently drifted out of the barrel.
  // The fix there was to delete the thing that required a list; this list is
  // small and deliberate, so it gets a guard instead.
  const uid = await import("../src/schemas/_uid.ts");
  const barrel = await import("../src/schemas/mod.ts");

  const missing = Object.keys(uid)
    .filter((k) => typeof (uid as Record<string, unknown>)[k] !== "undefined")
    .filter((k) => !(k in barrel));

  assertEquals(
    missing,
    [],
    "exported from `schemas/_uid.ts` but NOT reachable from `schemas/mod.ts` — add it to the " +
      "explicit re-export list in mod.ts (the one under `// Identifier validators`). A consumer " +
      "importing it from `@cfs/core/schemas` gets 'has no exported member'.",
  );
});
