/**
 * UploadcareSweepRun schema — Firestore collection: `uploadcare-sweep`
 *
 * ⚠️ **Not a singleton, despite what this line said until core#58.** There is one
 * baseline doc PER PARTITION — `last-run-prod` and `last-run-dev` today, named by
 * `lastRunDoc` on each partition in `api-cloudrun/src/services/uploadcareReferenceMap.ts`.
 * A reader that assumed `uploadcare-sweep/last-run` would find nothing at all.
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
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** One recorded sweep run. */
export interface UploadcareSweepRun {
  /** Per-`${projectId}/${collection}` uuid counts, e.g. `{"cfs-3100/documents": 1836}`. */
  ref_counts: Record<string, number>;
  /** When the counts were observed. Server-stamped with `Timestamp.now()`. */
  recorded_at: FirestoreTimestampType;
}

/** Zod schema for UploadcareSweepRun. */
export const UploadcareSweepRunSchema: z.ZodType<UploadcareSweepRun> = z.strictObject({
  // Non-negative integers: a negative or fractional count is nonsense, and the
  // canary's `current < previous * 0.5` comparison would silently misbehave on
  // one rather than reject it.
  ref_counts: z.record(z.string(), z.int().min(0)),
  // A Firestore Timestamp, not an ISO string: this is a server-stamped,
  // non-user-facing field, which is what `FirestoreTimestamp` is for across every
  // operational doc here (sessions, webhook-events, rate-limits). It is also the
  // only form a Firestore TTL policy can read, should this doc ever want one.
  // `z.iso.datetime()` is for log/payload timestamps, not Firestore documents.
  recorded_at: FirestoreTimestamp.meta({ column: true, label: "Recorded" }),
}).meta({
  title: "Uploadcare Sweep Run",
  collection: "uploadcare-sweep",
  displayDefaults: {
    columns: ["recorded_at"],
    filters: {},
    sort: { column: "recorded_at", direction: "desc" },
  },
});
