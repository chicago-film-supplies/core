/**
 * `Address.region` canonicalization — a US state to its two-letter USPS code.
 *
 * Lives in `schemas/` rather than `utils/` because the Zod transform below has
 * to reach it and `utils` imports `schemas` one-way, never the reverse.
 * `@cfs/core/utils/addresses` **re-exports** these rather than carrying its own
 * copy: the `_datetime.ts` precedent duplicates its transforms into
 * `utils/dates.ts` and pays for it with a parity test, which is a cost from the
 * days when the two were separate packages and is not worth repeating.
 *
 * @module
 */

import { z } from "zod";

/** The 50 states + DC + the five inhabited territories, by USPS code. */
const US_STATE_NAME_BY_CODE: Record<string, string> = {
  AL: "ALABAMA",
  AK: "ALASKA",
  AZ: "ARIZONA",
  AR: "ARKANSAS",
  CA: "CALIFORNIA",
  CO: "COLORADO",
  CT: "CONNECTICUT",
  DE: "DELAWARE",
  DC: "DISTRICT OF COLUMBIA",
  FL: "FLORIDA",
  GA: "GEORGIA",
  HI: "HAWAII",
  ID: "IDAHO",
  IL: "ILLINOIS",
  IN: "INDIANA",
  IA: "IOWA",
  KS: "KANSAS",
  KY: "KENTUCKY",
  LA: "LOUISIANA",
  ME: "MAINE",
  MD: "MARYLAND",
  MA: "MASSACHUSETTS",
  MI: "MICHIGAN",
  MN: "MINNESOTA",
  MS: "MISSISSIPPI",
  MO: "MISSOURI",
  MT: "MONTANA",
  NE: "NEBRASKA",
  NV: "NEVADA",
  NH: "NEW HAMPSHIRE",
  NJ: "NEW JERSEY",
  NM: "NEW MEXICO",
  NY: "NEW YORK",
  NC: "NORTH CAROLINA",
  ND: "NORTH DAKOTA",
  OH: "OHIO",
  OK: "OKLAHOMA",
  OR: "OREGON",
  PA: "PENNSYLVANIA",
  RI: "RHODE ISLAND",
  SC: "SOUTH CAROLINA",
  SD: "SOUTH DAKOTA",
  TN: "TENNESSEE",
  TX: "TEXAS",
  UT: "UTAH",
  VT: "VERMONT",
  VA: "VIRGINIA",
  WA: "WASHINGTON",
  WV: "WEST VIRGINIA",
  WI: "WISCONSIN",
  WY: "WYOMING",
  AS: "AMERICAN SAMOA",
  GU: "GUAM",
  MP: "NORTHERN MARIANA ISLANDS",
  PR: "PUERTO RICO",
  VI: "US VIRGIN ISLANDS",
};

const CODE_BY_US_STATE_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_NAME_BY_CODE).map(([code, name]) => [name, code]),
);

/** Spellings the corpus actually carries that the canonical name table misses. */
const NAME_ALIASES: Record<string, string> = {
  "WASHINGTON DC": "DC",
  "WASHINGTON, DC": "DC",
  "D.C.": "DC",
  "VIRGIN ISLANDS": "VI",
  "U.S. VIRGIN ISLANDS": "VI",
  "PUERTO RICO (PR)": "PR",
};

/** Uppercase, collapse internal whitespace, drop surrounding punctuation. */
function squash(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, " ").replace(/\.$/, "");
}

/**
 * Resolve a free-text region to its two-letter USPS code, or `null` when it
 * cannot be resolved (blank, a non-US region, a typo).
 *
 * **`null` means "unknown", never "not Illinois".** Every caller deciding
 * something consequential — the out-of-state no-tax rule above all — must treat
 * `null` conservatively rather than as a negative answer: the prod corpus holds
 * `"Illinois"` spelled out on 18 destinations (13 of them Chicago), which is
 * exactly the case a naive `region !== "IL"` test gets wrong in the direction
 * that stops collecting tax CFS owes.
 */
export function toUsStateCode(input: string | null | undefined): string | null {
  if (!input) return null;
  const squashed = squash(input);
  if (!squashed) return null;
  if (squashed.length === 2 && US_STATE_NAME_BY_CODE[squashed]) return squashed;
  return CODE_BY_US_STATE_NAME[squashed] ?? NAME_ALIASES[squashed] ?? null;
}

/**
 * Canonical stored form of `Address.region`: the two-letter code when the input
 * resolves, otherwise the input trimmed and otherwise untouched.
 *
 * Deliberately **normalizing, not validating**. `Address` is shared by
 * destinations, organizations, orders and invoices, and its `region` is free
 * text that is legitimately blank on plenty of prod documents and could hold a
 * non-US region tomorrow. Rejecting an unresolvable value would turn a cosmetic
 * data-quality problem into a failed write on the order path. Idempotent.
 */
export function toRegionCode(input: string): string {
  return toUsStateCode(input) ?? input.trim();
}

/**
 * Illinois ZIP prefixes are 600–629. Used only as a **cross-check** against the
 * region — `audit-order-tax-snapshot.ts` reports a disagreement rather than
 * letting either field silently win, because a wrong region and a wrong
 * postcode are both live in prod and neither is authoritative.
 */
export function isIllinoisPostcode(postcode: string | null | undefined): boolean {
  if (!postcode) return false;
  const digits = postcode.trim().slice(0, 5);
  if (!/^\d{5}$/.test(digits)) return false;
  const n = Number(digits);
  return n >= 60000 && n <= 62999;
}

/**
 * Schema factory for `Address.region` — canonicalizes to the USPS code on
 * parse, the same shape as `chicagoInstant()` for datetimes.
 *
 * ⚠️ **A transform on a DOCUMENT schema does not rewrite what gets stored.**
 * `validateBeforeWrite` discards `result.data` on purpose (it would strip
 * FieldValue sentinels), so this only materializes where the parsed output is
 * what flows on — i.e. route input validation. A writer that builds an address
 * from a source that never passes through an input schema (the CRMS webhooks)
 * still stores whatever it was handed. So consumers that care about the value
 * must call {@link toUsStateCode} themselves rather than trusting storage.
 */
export const usState = (): z.ZodType<string, string> =>
  z.string().transform(toRegionCode);
