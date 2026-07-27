/**
 * HolidaySnapshot document schema — Firestore singleton: holiday-snapshot/current
 *
 * A materialized roll-up of every `holiday-dates` instance into one flat ISO
 * array, so the per-render hot path (`getHolidayDates()`) reads **1 doc** plus
 * a TTL cache instead of scanning ~250 instance docs. Service-owned and
 * recompute-from-source — rebuilt on every holiday-dates write (the
 * `holiday-dates:rematerialize-snapshot` cascade). Not client-writable.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** Inclusive year span covered by the materialized snapshot. */
export interface HolidaySnapshotYearRange {
  from: number;
  to: number;
}

/** The materialized holiday snapshot singleton (`holiday-snapshot/current`). */
export interface HolidaySnapshot {
  uid: "current";
  /** Sorted-unique ISO (`YYYY-MM-DD`) dates across all holiday-dates instances. */
  materialized_dates: string[];
  materialized_count: number;
  materialized_year_range: HolidaySnapshotYearRange;
  materialized_at: FirestoreTimestampType;
}

/** Zod schema for HolidaySnapshot. */
export const HolidaySnapshotSchema: z.ZodType<HolidaySnapshot> = z.strictObject({
  uid: z.literal("current"),
  materialized_dates: z.array(z.iso.date()).default([]),
  materialized_count: z.int().min(0),
  materialized_year_range: z.strictObject({
    from: z.int(),
    to: z.int(),
  }),
  materialized_at: FirestoreTimestamp,
}).meta({
  title: "Holiday Snapshot",
  collection: "holiday-snapshot",
  displayDefaults: {
    columns: ["materialized_count", "materialized_at"],
    filters: {},
    sort: { column: "materialized_at", direction: "desc" },
  },
});
