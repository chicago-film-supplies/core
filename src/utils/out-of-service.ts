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
  OOS_BREAKDOWN_KEYS,
  type OOSBreakdown,
  type OOSStatusType,
  type OutOfService,
} from "../schemas/mod.ts";

/** A breakdown with every bucket at zero. */
export function emptyOOSBreakdown(): OOSBreakdown {
  return { flagged: 0, away: 0, written_off: 0, returned_to_service: 0 };
}

/**
 * Units the breakdown places. Σ ≤ `quantity`: the shortfall is a record not yet
 * in effect (a future start), whose units are still in service on their shelf.
 */
export function sumOOSBreakdown(breakdown: OOSBreakdown): number {
  return OOS_BREAKDOWN_KEYS.reduce((sum, k) => sum + breakdown[k], 0);
}

/**
 * The record's status, derived — never client-set.
 *
 * - `canceled` once `canceled_at` is set;
 * - `complete` once every unit is written off or back in service;
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
  if (quantity > 0 && breakdown.written_off + breakdown.returned_to_service === quantity) {
    return "complete";
  }
  return "active";
}
