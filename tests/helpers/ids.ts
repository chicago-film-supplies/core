/**
 * Deterministic, validator-compliant id factories for fixtures.
 * Mirrors the shapes enforced by `src/_uid.ts`.
 */

/** A stable 20-char `[A-Za-z0-9]` Firestore id derived from a seed label. */
export function fid(seed: string): string {
  const compact = seed.replace(/[^A-Za-z0-9]/g, "");
  return (compact + "0".repeat(20)).slice(0, 20);
}

/** A booking composite id: `{uid_order}:{uid_product}:{uid_destination}`. */
export function bookingId(uidOrder: string, uidProduct: string, uidDest: string): string {
  return `${uidOrder}:${uidProduct}:${uidDest}`;
}

/** A stock-summary composite id: `{uid_product}:rental:{start}:{end}` or `:sale:{date}`. */
export function stockSummaryId(
  uidProduct: string,
  type: "rental" | "sale",
  start: string,
  end?: string,
): string {
  return type === "sale"
    ? `${uidProduct}:sale:${start}`
    : `${uidProduct}:rental:${start}:${end}`;
}
