import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/**
 * An inbound webhook event stored for processing.
 *
 * `uid` is the Firestore document id — the provider's own event id, used as the
 * doc id so a redelivery is idempotent by construction. It was called `id`
 * until core#58; see `core/CLAUDE.md` § *UID property naming*.
 *
 * ⚠️ **The rename does not buy the write-time drift guard here**, and it would
 * be easy to assume it does. `api-cloudrun/src/lib/webhooks.ts` calls
 * `validateBeforeWrite` directly and then does a raw `eventRef.create(doc)`, so
 * `assertValidForWrite` — the thing that checks `uid === ref.id` — never runs on
 * this path. This is convention alone until that write goes through the guarded
 * helper.
 *
 * Safe to rename with no backfill and no shim: the collection has a 24 h TTL,
 * there is exactly one writer, and **no reader reads the field** — every
 * consumer checks `snap.exists` only.
 */
export interface WebhookEvent {
  /** Firestore document id — the provider's event id. */
  uid: string;
  event: string;
  received: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
  payload: unknown;
}

/** Zod schema for WebhookEvent. */
export const WebhookEventSchema: z.ZodType<WebhookEvent> = z.strictObject({
  uid: z.string(),
  event: z.string().meta({ column: true, label: "Event" }),
  received: FirestoreTimestamp.meta({ column: true, label: "Received" }),
  expiresAt: FirestoreTimestamp,
  payload: z.unknown(),
}).meta({
  title: "WebhookEvent",
  collection: "webhooks/{service}/events",
  displayDefaults: {
    columns: ["event", "received"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
