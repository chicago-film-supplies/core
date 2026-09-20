/**
 * Deterministic, validator-compliant id factories for fixtures.
 * Mirrors the shapes enforced by `src/schemas/_uid.ts`.
 */

/** A stable 20-char `[A-Za-z0-9]` Firestore id derived from a seed label. */
export function fid(seed: string): string {
  const compact = seed.replace(/[^A-Za-z0-9]/g, "");
  return (compact + "0".repeat(20)).slice(0, 20);
}

/**
 * A deterministic, validator-compliant destination-PAIR uid (a UUID) — segment
 * 3 of a `BookingId`, the LEG. Not a `destinations/{uid}`: see `_uid.ts`'s
 * "`BookingId`'s 3rd segment is the LEG" section.
 */
export function legUid(seed: string): string {
  const hex = Array.from(seed).reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381)
    .toString(16).padStart(8, "0");
  return `${hex}-1d4e-4b6a-9c21-7e05f3a9b8d2`;
}

/**
 * A booking composite id: `{uid_order}:{uid_product}:{pair uid}`, or,
 * with `signatureHash` supplied, the 4-segment kit-component form
 * (`core/src/utils/booking-id.ts`'s `buildBookingId`).
 */
export function bookingId(
  uidOrder: string,
  uidProduct: string,
  uidLeg: string,
  signatureHash?: string,
): string {
  return signatureHash
    ? `${uidOrder}:${uidProduct}:${uidLeg}:${signatureHash}`
    : `${uidOrder}:${uidProduct}:${uidLeg}`;
}

// No stock id builder: `stock/{P}` and `stock-locks/{P}` are both keyed by the
// product uid (a plain FirestoreId) — there is no composite form any more.
