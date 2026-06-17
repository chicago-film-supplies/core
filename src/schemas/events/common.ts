/**
 * Event envelope and shared event types.
 *
 * Events wrap full Firestore documents as-is — no field stripping,
 * no transformation. The envelope adds metadata for tracing and ordering.
 */
import type { FirestoreTimestampType } from "../common.ts";

/**
 * Common envelope wrapping every domain event.
 *
 * `data` is the full Firestore document after all server sentinels
 * (serverTimestamp, increment, etc.) have been resolved by Firestore.
 */
export interface EventEnvelope<T> {
  /** Dot-delimited event name, e.g. "order.created" */
  event: string;
  /** Payload version — bump on breaking shape changes only */
  version: number;
  /** ISO 8601 timestamp of the write (from document's updated_at or created_at) */
  timestamp: string;
  /** Firestore timestamp of the write — matches document timestamp fields */
  timestamp_fs: FirestoreTimestampType;
  /** UID of the document that changed */
  source_uid: string;
  /** Ties related events from one transaction (e.g. all events from a createOrder call) */
  correlation_id?: string;
  /** The full Firestore document, unchanged */
  data: T;
}
