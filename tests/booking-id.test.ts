/**
 * `src/utils/booking-id.ts` — the ONE deterministic constructor for a
 * `bookings.uid`.
 */
import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { BookingId } from "../src/schemas/_uid.ts";
import {
  buildBookingId,
  buildBookingIdFromSignature,
  componentAncestry,
  componentSignatureHash,
} from "../src/utils/booking-id.ts";
import { fid } from "./helpers/ids.ts";

const ORDER = fid("order");
const DEST = fid("dest");
const DIVIDER = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const PRODUCT = fid("product");
const KIT_A = fid("kitA");
const KIT_B = fid("kitB");

Deno.test("componentAncestry: a top-level occurrence has EMPTY ancestry", () => {
  assertEquals(componentAncestry([DIVIDER, PRODUCT]), []);
  // Group dividers are structural too — never a product ancestor.
  assertEquals(componentAncestry([DIVIDER, GROUP, PRODUCT]), []);
});

Deno.test("componentAncestry: keeps the full root-to-leaf PRODUCT chain, drops the item's own uid", () => {
  assertEquals(componentAncestry([DIVIDER, KIT_A, PRODUCT]), [KIT_A]);
  assertEquals(componentAncestry([DIVIDER, KIT_A, KIT_B, PRODUCT]), [KIT_A, KIT_B]);
  // A group between the divider and the first product ancestor doesn't enter
  // the chain either — only PRODUCT-shaped segments do.
  assertEquals(componentAncestry([DIVIDER, GROUP, KIT_A, PRODUCT]), [KIT_A]);
});

Deno.test("componentAncestry: a custom-product ancestor counts as a product, not a divider", () => {
  const customKit = "custom-fe847108-d824-4f3a-aac8-ce60a9743ffc";
  assertEquals(componentAncestry([DIVIDER, customKit, PRODUCT]), [customKit]);
});

Deno.test("componentSignatureHash: null for empty ancestry, a 12-hex digest otherwise", () => {
  assertEquals(componentSignatureHash([DIVIDER, PRODUCT]), null);
  const hash = componentSignatureHash([DIVIDER, KIT_A, PRODUCT]);
  assertMatch(hash!, /^[0-9a-f]{12}$/);
});

Deno.test("componentSignatureHash: matches a known SHA-256 digest, truncated to 12 hex chars", () => {
  // `sha256(KIT_A + "" + KIT_B)`, verified independently via
  // `printf '<KIT_A>\x1f<KIT_B>' | shasum -a 256` → 0d8ce73924bd4cb9cc6edcc0…
  assertEquals(componentSignatureHash([DIVIDER, KIT_A, KIT_B, PRODUCT]), "0d8ce73924bd");
  // `sha256(KIT_A)` alone → 91f68995da4a8ac883a8636…
  assertEquals(componentSignatureHash([DIVIDER, KIT_A, PRODUCT]), "91f68995da4a");
});

Deno.test("componentSignatureHash: is pure — same path, same hash, every call", () => {
  const path = [DIVIDER, KIT_A, KIT_B, PRODUCT];
  const first = componentSignatureHash(path);
  for (let i = 0; i < 5; i++) assertEquals(componentSignatureHash(path), first);
});

Deno.test("buildBookingId: a top-level occurrence gets the unchanged 3-segment id", () => {
  const id = buildBookingId(ORDER, { uid: PRODUCT }, [DIVIDER, PRODUCT], DEST);
  assertEquals(id, `${ORDER}:${PRODUCT}:${DEST}`);
  assertEquals(BookingId.safeParse(id).success, true);
});

Deno.test("buildBookingId: a component occurrence gets a 4th segment — the signature hash", () => {
  const path = [DIVIDER, KIT_A, PRODUCT];
  const id = buildBookingId(ORDER, { uid: PRODUCT }, path, DEST);
  const hash = componentSignatureHash(path);
  assertEquals(id, `${ORDER}:${PRODUCT}:${DEST}:${hash}`);
  assertEquals(BookingId.safeParse(id).success, true);
});

Deno.test("buildBookingId: different ancestries → different ids; same ancestry → the SAME id", () => {
  const underKitA = buildBookingId(ORDER, { uid: PRODUCT }, [DIVIDER, KIT_A, PRODUCT], DEST);
  const underKitB = buildBookingId(ORDER, { uid: PRODUCT }, [DIVIDER, KIT_B, PRODUCT], DEST);
  assertNotEquals(underKitA, underKitB, "component of kit A vs kit B — genuinely different bookings");

  // Two occurrences under the SAME kit product, reached via different GROUP
  // siblings (group identity is deliberately excluded from the signature —
  // see `splitItem`'s clone in the plan's §1).
  const viaGroup1 = buildBookingId(ORDER, { uid: PRODUCT }, [DIVIDER, GROUP, KIT_A, PRODUCT], DEST);
  const viaGroup2 = buildBookingId(
    ORDER,
    { uid: PRODUCT },
    [DIVIDER, "33333333-3333-4333-8333-333333333333", KIT_A, PRODUCT],
    DEST,
  );
  assertEquals(viaGroup1, viaGroup2, "same product ancestor, different group — the same booking");
});

Deno.test("buildBookingId: custom-product item uid flows through untouched", () => {
  const customUid = "custom-fe847108-d824-4f3a-aac8-ce60a9743ffc";
  const id = buildBookingId(ORDER, { uid: customUid }, [DIVIDER, customUid], DEST);
  assertEquals(id, `${ORDER}:${customUid}:${DEST}`);
  assertEquals(BookingId.safeParse(id).success, true);
});

Deno.test("buildBookingIdFromSignature: null hash → the unchanged 3-segment id", () => {
  const id = buildBookingIdFromSignature(ORDER, PRODUCT, DEST, null);
  assertEquals(id, `${ORDER}:${PRODUCT}:${DEST}`);
  assertEquals(BookingId.safeParse(id).success, true);
});

Deno.test("buildBookingIdFromSignature: a hash appends the 4th segment", () => {
  const hash = componentSignatureHash([DIVIDER, KIT_A, PRODUCT]);
  const id = buildBookingIdFromSignature(ORDER, PRODUCT, DEST, hash);
  assertEquals(id, `${ORDER}:${PRODUCT}:${DEST}:${hash}`);
  assertEquals(BookingId.safeParse(id).success, true);
});

Deno.test("buildBookingIdFromSignature: agrees with buildBookingId given the same path's derived hash", () => {
  for (const path of [[DIVIDER, PRODUCT], [DIVIDER, KIT_A, PRODUCT], [DIVIDER, KIT_A, KIT_B, PRODUCT]]) {
    const viaPath = buildBookingId(ORDER, { uid: PRODUCT }, path, DEST);
    const viaHash = buildBookingIdFromSignature(ORDER, PRODUCT, DEST, componentSignatureHash(path));
    assertEquals(viaHash, viaPath);
  }
});
