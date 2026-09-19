/**
 * The ONE deterministic constructor for a `bookings.uid` — `componentAncestry`,
 * `componentSignatureHash` and {@link buildBookingId}. Before this module
 * existed, three call sites built the id by hand from its parts:
 * api-cloudrun's `bookingId()` (`api-cloudrun/src/services/orders.ts`), this
 * repo's own `bookingUidFor` (`src/utils/pick-sheet-fold.ts`), and the manager's
 * `bookingUidForItem` (`orderBookingJoin` in the manager, since deleted with the per-order screen). Three
 * re-implementations of one derivation is exactly the pattern that let a
 * product repeating within one order — standalone, as a component of kit A,
 * as a component of kit B, or split via `splitItem` — collapse onto a single
 * booking document for years.
 *
 * @module
 */
import { isProductShapedUid } from "../schemas/_uid.ts";

/**
 * ASCII Unit Separator (U+001F). Joins a `componentAncestry` chain before
 * hashing — it cannot appear in any `ItemUid`-shaped segment (a Firestore id,
 * a native uuid, or `custom-{uuid}`), so the join is unambiguous without
 * escaping.
 */
const SEP = "";

/**
 * The chain of PRODUCT ancestors above one item occurrence — a pure filter of
 * `path`, nothing else. `path` is self-inclusive (`[...parent path, own
 * uid]`), so this keeps every product-shaped segment and drops the item's own
 * trailing one; structural (destination/group divider) segments are dropped
 * by `isProductShapedUid` rather than sliced off separately, because they can
 * only ever appear ABOVE the first product segment — `ORDER_ITEM_LEVELS`
 * fixes dividers to the top of a subtree, never nested inside a product's own
 * components.
 *
 * `[]` for a top-level (non-component) occurrence.
 *
 * Two occurrences are the SAME booking iff their ancestries match exactly,
 * and genuinely DIFFERENT ones iff they differ at any position — the full
 * root-to-leaf chain, not just the immediate parent, is what distinguishes
 * "component of kit A" from "component of kit B nested two deep." Dropping
 * only structural segments (not group-divider identity specifically) is what
 * lets a `splitItem` clone — same product uids throughout, only a fresh GROUP
 * uid — resolve to the same ancestry as its source and stay correctly merged.
 */
export function componentAncestry(path: readonly string[]): string[] {
  return path.filter(isProductShapedUid).slice(0, -1);
}

/**
 * `sha256(componentAncestry(path).join(SEP))`, first 12 hex chars — `null`
 * for a top-level occurrence (empty ancestry), matching
 * `Booking.component_signature_hash`.
 *
 * A hash, not the raw joined chain, keeps {@link buildBookingId}'s output
 * bounded regardless of nesting depth — the same shape of choice as
 * `registerDocId`'s 20-hex-char SHA-256 truncation
 * (`api-cloudrun/src/services/templates/publishFromMerge.ts`, cited in
 * `schemas/_uid.ts`), just shorter since this doesn't have to satisfy
 * `FirestoreId`'s exact 20-char form.
 */
export function componentSignatureHash(path: readonly string[]): string | null {
  const ancestry = componentAncestry(path);
  return ancestry.length === 0 ? null : sha256Hex(ancestry.join(SEP)).slice(0, 12);
}

/**
 * The one place a `BookingId` is assembled from parts. Sparse by
 * construction: a top-level occurrence (empty ancestry) gets the unchanged
 * 3-segment id — `{uid_order}:{item uid}:{uid_destination}` — byte-for-byte
 * what every booking id has always been; a component occurrence gets a 4th
 * segment, the signature hash, appended AFTER the destination. The
 * destination segment's position and meaning are otherwise untouched.
 *
 * `item` takes just the uid (not the whole line) because `path` — which
 * already carries the item's own uid as its last segment — is a separate,
 * explicit parameter: callers that only have a bare uid and a path (as
 * opposed to a full line item) can still call this directly.
 *
 * Delegates to {@link buildBookingIdFromSignature} for the assembly itself —
 * see that function for the caller this one can't serve directly: one whose
 * item shape carries `component_signature_hash` already and no `path` to
 * recompute it from.
 */
export function buildBookingId(
  orderUid: string,
  item: { uid: string },
  path: readonly string[],
  destUid: string,
): string {
  return buildBookingIdFromSignature(orderUid, item.uid, destUid, componentSignatureHash(path));
}

/**
 * The same assembly {@link buildBookingId} performs, taking an
 * already-computed signature hash directly instead of a `path` to derive one
 * from. For a caller whose item shape carries `component_signature_hash` but
 * no `path` — `ConsolidatedItemType` (`@cfs/core/schemas/order`) is exactly
 * this shape by design: `consolidateItems` computes the hash once, per group,
 * and the per-line `path`s that produced it are not carried forward, since
 * they may differ in their trailing (own-uid) segment across the group's
 * merged lines while agreeing on ancestry.
 */
export function buildBookingIdFromSignature(
  orderUid: string,
  itemUid: string,
  destUid: string,
  signatureHash: string | null,
): string {
  return signatureHash === null
    ? `${orderUid}:${itemUid}:${destUid}`
    : `${orderUid}:${itemUid}:${destUid}:${signatureHash}`;
}

/** The parts {@link buildBookingId} assembled, as {@link parseBookingId} returns them. */
export interface ParsedBookingId {
  orderUid: string;
  itemUid: string;
  destUid: string;
  /** `null` for a top-level occurrence — the 3-segment form carries no 4th segment. */
  signatureHash: string | null;
}

/**
 * The inverse of {@link buildBookingIdFromSignature}, and it lives here so the
 * assembler and the parser share one module and one statement of the format.
 *
 * 🔴 **The reason this exists is that hand-splitting is WRONG on the sparse
 * form, silently.** A booking id is 3 segments for a top-level occurrence and 4
 * for a component one, so `id.indexOf(":")` after stripping the order prefix
 * yields `dest` in the first case and **`dest:signature`** in the second — a
 * string that compares equal to no destination uid there is. That is not a
 * hypothetical: `frozenBookingGrains` in
 * `api-cloudrun/src/lib/orderFulfillmentSync.ts` did exactly this, so the
 * custody freeze was ABSENT (not coarse — absent) for every component-nested
 * row (api-cloudrun#1060).
 *
 * Returns `null` rather than throwing when the id is not the shape this module
 * assembles — callers walk stored corpora, where a refusal to classify is more
 * useful than an exception, and every caller already has a "not mine" branch.
 *
 * ⚠️ **Segment COUNT is the only discriminator, deliberately.** A signature
 * hash is 12 lowercase hex characters and a destination uid is a Firestore id,
 * so a shape test would also pass on some ids and is a second, weaker statement
 * of the format. Count is exact: `buildBookingIdFromSignature` emits 3 or 4
 * segments and nothing else.
 */
export function parseBookingId(id: string): ParsedBookingId | null {
  const parts = id.split(":");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [orderUid, itemUid, destUid, signatureHash] = parts;
  if (!orderUid || !itemUid || !destUid) return null;
  if (parts.length === 4 && !signatureHash) return null;
  return { orderUid, itemUid, destUid, signatureHash: parts.length === 4 ? signatureHash : null };
}

// ── Synchronous SHA-256 ──────────────────────────────────────────
//
// This module sits under `@cfs/core/utils`, which the manager imports into a
// BROWSER, so it cannot reach for `node:crypto` the way
// `schemas/pii/hash-node.ts` does — and `crypto.subtle.digest` is async-only,
// which every call site here (a `consolidateItems` map, a booking-id
// comparator) is not. A pure-JS synchronous digest is the only shape that
// works in both places. FIPS 180-4 reference implementation, verified in
// `tests/booking-id.test.ts` against known SHA-256 test vectors.

const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: readonly number[] = [
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Synchronous SHA-256 over a UTF-8 string, returning the lowercase hex digest. */
function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLen = bytes.length * 8;

  let paddedLen = bytes.length + 1;
  while (paddedLen % 64 !== 56) paddedLen++;
  paddedLen += 8;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  // Safe for any realistic ancestry-chain string (far below 2^53 bits); the
  // high word is always 0 in practice, written explicitly for correctness.
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);

  const h = H0.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
