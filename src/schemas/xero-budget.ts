/**
 * XeroBudget document schema — Firestore singleton: xero-budget/current
 *
 * The persisted view of the Xero tenant's daily API budget (~1,000 calls/day,
 * measured). Xero reports the remaining count on **every** response
 * (`x-daylimit-remaining`), but that is a per-response fact: an
 * AsyncLocalStorage snapshot only sees quota *within* one request, and a gate
 * that reserves headroom for the money path has to know the budget is dead
 * **before** it makes its first call. So the observation is persisted here and
 * read pre-flight.
 *
 * It gets its own top-level singleton collection rather than a `config/…` doc:
 * `config` is a heterogeneous Xero/Gmail-token grab-bag and is in
 * api-cloudrun's `UNVALIDATED_COLLECTIONS`, so a doc written there would be
 * exempt from `validateBeforeWrite` — the opposite of the point. Mirrors the
 * `holiday-snapshot/current` singleton convention.
 *
 * **The snapshot is authoritative only inside its own window.** Once
 * `resets_at` has passed, the day counter has rolled over and this doc
 * describes a window that no longer exists — readers MUST treat that as
 * UNKNOWN and fail **open**, never as exhausted. The recursion is the reason:
 * the better the gate works, the fewer 429s arrive to re-seed the snapshot, so
 * a stale doc that failed *closed* would gate the tier forever after the first
 * crossing.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/**
 * How `resets_at` was determined.
 *
 * - `retry_after` — derived from Xero's `Retry-After` header on a day-429. Xero
 *   sends it only on a 429, but it *does* send it on a day-429 and the raw
 *   value is the real time-to-reset. Trust it.
 * - `inferred_rollover` — no `Retry-After` was available, so the next observed
 *   ~20:00–20:20 UTC tenant rollover was assumed (corroborated across
 *   2026-07-09/10/12), clamped to `now + 24h`.
 *
 * Stamped so an inferred value is *visible* rather than indistinguishable from
 * a reported one.
 */
export type XeroResetsAtSource = "retry_after" | "inferred_rollover";

/**
 * How a *throttle's* `resets_at` was determined. A superset of
 * {@link XeroResetsAtSource}, because Xero throttles on two independent windows
 * and only the daily one rolls over:
 *
 * - `assumed_minute` — a minute / app-minute / concurrent 429 that carried no
 *   `Retry-After` (per Xero's docs the concurrent and app-minute limits don't send
 *   one), so `now + 60s` was assumed — the width of the minute window.
 *
 * Deliberately NOT added to {@link XeroBudgetSchema}: the persisted
 * `xero-budget/current` doc describes the **day** window only, and a minute-limit
 * refusal must never be able to write a 60-second `resets_at` into it. Widening the
 * doc schema would let a transient throttle masquerade as the daily budget and make
 * the gate fail open a minute later.
 */
export type XeroThrottleResetsAtSource = XeroResetsAtSource | "assumed_minute";

/** The persisted Xero daily-budget snapshot (`xero-budget/current`). */
export interface XeroBudget {
  uid: "current";
  /**
   * Calls left in the tenant's day window as of {@link XeroBudget.observed_at}.
   * Straight from `x-daylimit-remaining`; 0 on a day-429.
   */
  day_remaining: number;
  /** When `day_remaining` was read off a Xero response (ISO, offset form). */
  observed_at: string;
  /** When the day window rolls over — after this the snapshot is UNKNOWN (ISO, offset form). */
  resets_at: string;
  resets_at_source: XeroResetsAtSource;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for XeroBudget. */
export const XeroBudgetSchema: z.ZodType<XeroBudget> = z.strictObject({
  uid: z.literal("current"),
  day_remaining: z.int().min(0).meta({ column: true, label: "Remaining Today" }),
  observed_at: z.iso.datetime({ offset: true }).meta({ column: true, label: "Observed" }),
  resets_at: z.iso.datetime({ offset: true }).meta({ column: true, label: "Resets" }),
  resets_at_source: z.enum(["retry_after", "inferred_rollover"]).meta({ column: true, label: "Resets Source" }),
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Xero Budget",
  collection: "xero-budget",
  displayDefaults: {
    columns: ["day_remaining", "resets_at", "resets_at_source", "observed_at"],
    filters: {},
    sort: { column: "observed_at", direction: "desc" },
  },
});
