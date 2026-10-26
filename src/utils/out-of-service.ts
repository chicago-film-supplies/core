/**
 * Out-of-service record helpers — the status rule and the breakdown sums.
 *
 * `deriveOOSStatus` used to live in api-cloudrun `src/services/outOfService.ts`
 * while the booking path wrote a literal `status: "active"` beside it. One rule,
 * one author: both writers and the manager's preview read this.
 *
 * @module
 */
import {
  OOS_BREAKDOWN_TERMINAL_KEYS,
  type OOSBreakdown,
  type OOSStatusType,
  type OutOfService,
  sumOOSBuckets,
} from "../schemas/mod.ts";

/**
 * A breakdown with every bucket at zero, `returned_to_supplier` included.
 *
 * It is a WRITER — the api seeds every new record from it — so stating the key
 * is what moves storage toward the required declaration (release order step 5).
 * It waited for prod manager to read the fifth bucket, which it now does.
 */
export function emptyOOSBreakdown(): OOSBreakdown {
  return { flagged: 0, away: 0, written_off: 0, returned_to_service: 0, returned_to_supplier: 0 };
}

/**
 * Units the breakdown places. Σ ≤ `quantity`: the shortfall is a record not yet
 * in effect (a future start), whose units are still in service on their shelf.
 */
export function sumOOSBreakdown(breakdown: OOSBreakdown): number {
  return sumOOSBuckets(breakdown);
}

/**
 * The record's status, derived — never client-set.
 *
 * - `canceled` once `canceled_at` is set;
 * - `complete` once every unit is RESOLVED — written off, back in service, or
 *   settled to its supplier (`OOS_BREAKDOWN_TERMINAL_KEYS`);
 * - `active` otherwise — including a record not yet in effect, whose units are
 *   in no bucket.
 *
 * The old `number` parameter is gone: it existed only to tell `draft` from
 * `planned`, and neither is a status any more.
 */
export function deriveOOSStatus(
  record: Pick<OutOfService, "quantity" | "breakdown" | "canceled_at">,
): OOSStatusType {
  if (record.canceled_at != null) return "canceled";
  const { breakdown, quantity } = record;
  if (quantity > 0 && sumOOSBuckets(breakdown, OOS_BREAKDOWN_TERMINAL_KEYS) === quantity) {
    return "complete";
  }
  return "active";
}

/**
 * Why a record may not be canceled, or `null` when it may — the api's refusal,
 * which the manager's Cancel Record button did not check (gap G11 (a)). A record
 * with units still flagged on a shelf or away at a vendor describes units that
 * are out of service now; canceling it would put them back into service with no
 * movement. Return them to service or write them off first.
 */
export function oosCancelRefusal(
  record: Pick<OutOfService, "quantity" | "breakdown" | "canceled_at">,
): string | null {
  if (deriveOOSStatus(record) === "canceled") return "This out-of-service record is already canceled.";
  const held = sumOOSBuckets(record.breakdown, ["flagged", "away"]);
  if (held > 0) {
    return `Cannot cancel: ${held} unit(s) are still out of service. Return them to service, write them off or return them to their supplier first.`;
  }
  return null;
}
