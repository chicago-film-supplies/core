import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** An inbound webhook event stored for processing. */
export interface WebhookEvent {
  id: string;
  event: string;
  received: FirestoreTimestampType;
  expiresAt: FirestoreTimestampType;
  payload: unknown;
}

/** Zod schema for WebhookEvent. */
export const WebhookEventSchema: z.ZodType<WebhookEvent> = z.strictObject({
  id: z.string(),
  event: z.string(),
  received: FirestoreTimestamp,
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
