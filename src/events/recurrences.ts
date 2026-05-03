/**
 * Recurrence aggregate events.
 *
 * `RecurrenceCreated` / `Updated` / `Deleted` wrap the full Firestore doc.
 * `HorizonMaterialized` is emitted by the nightly job (and by
 * `POST /recurrences` on initial creation) and reports a compact summary
 * of what was written — the number of cards added, the new horizon date,
 * and the `source_uid` of the parent recurrence — so downstream consumers
 * (analytics, observability) don't need to diff the cards collection to
 * understand a horizon advance.
 */
import type { EventEnvelope } from "./common.ts";
import type { Recurrence } from "../recurrence.ts";

export type RecurrenceCreated = EventEnvelope<Recurrence> & {
  event: "recurrence.created";
};
export type RecurrenceUpdated = EventEnvelope<Recurrence> & {
  event: "recurrence.updated";
};
export type RecurrenceDeleted = EventEnvelope<Recurrence> & {
  event: "recurrence.deleted";
};

/**
 * Payload shape for `horizon.materialized` — compact summary, not a full
 * document. Emitted per-recurrence after a materialize-horizon run writes
 * (or would have written) new cards.
 */
export interface HorizonMaterializedData {
  /** Parent recurrence UID. */
  recurrence_uid: string;
  /** Horizon date (YYYY-MM-DD) after this run — equals the new `horizon_through`. */
  horizon_through: string;
  /** Previous horizon date before this run, or null if this was the first materialization. */
  previous_horizon_through: string | null;
  /** Number of instance cards written in this run (0 if the horizon was already covered). */
  cards_created: number;
  /** Number of candidate dates skipped because they were in exception_dates. */
  dates_skipped_exceptions: number;
}

export type HorizonMaterialized = EventEnvelope<HorizonMaterializedData> & {
  event: "horizon.materialized";
};
