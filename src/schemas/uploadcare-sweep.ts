/**
 * UploadcareSweepRun schema — Firestore singleton: `uploadcare-sweep/last-run`
 *
 * The baseline the Uploadcare orphan sweep's **delta canary** compares against.
 *
 * The sweep records, per `${projectId}/${collection}`, how many CDN uuids each
 * reference source yielded. The next run aborts if any source collapses to zero
 * or loses more than half its references — the signal that catches a renamed
 * field, a dropped `.select()` projection, or an extractor regression, none of
 * which change the *document* count the old circuit breaker was watching.
 *
 * Schema-backed rather than a raw operational write because the sweep deletes
 * files on a weekly `write=true` cron: a malformed baseline would disarm the one
 * check standing between a zeroed reference source and a mass reap. It is
 * written through `validatedSetDoc`, so drift fails loudly at write time.
 *
 * Written ONLY by a run that did not abort — persisting an aborted run's counts
 * would make the collapse the next run's normal.
 */
import { z } from "zod";

/** One recorded sweep run. */
export interface UploadcareSweepRun {
  /** Per-`${projectId}/${collection}` uuid counts, e.g. `{"cfs-3100/documents": 1836}`. */
  ref_counts: Record<string, number>;
  /** ISO datetime the counts were observed. Machine timestamp — `Z` form is fine. */
  recorded_at: string;
}

/** Zod schema for UploadcareSweepRun. */
export const UploadcareSweepRunSchema: z.ZodType<UploadcareSweepRun> = z.strictObject({
  // Non-negative integers: a negative or fractional count is nonsense, and the
  // canary's `current < previous * 0.5` comparison would silently misbehave on
  // one rather than reject it.
  ref_counts: z.record(z.string(), z.int().min(0)),
  recorded_at: z.iso.datetime(),
}).meta({
  title: "Uploadcare Sweep Run",
  collection: "uploadcare-sweep",
  displayDefaults: {
    columns: ["recorded_at"],
    filters: {},
    sort: { column: "recorded_at", direction: "desc" },
  },
});
