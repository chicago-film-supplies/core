/**
 * Rate limit document schema — Firestore collection: rate-limits
 *
 * Tracks request attempts per key (IP + route) within a sliding window.
 * TTL policy on expiresAt for automatic Firestore cleanup.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

export interface RateLimit {
  attempt_count: number;
  first_attempt_at: number;
  expiresAt: FirestoreTimestampType;
}

export const RateLimitSchema: z.ZodType<RateLimit> = z.strictObject({
  attempt_count: z.number().int().min(1),
  first_attempt_at: z.number(),
  expiresAt: FirestoreTimestamp,
}).meta({
  title: "RateLimit",
  collection: "rate-limits",
  displayDefaults: {
    columns: ["attempt_count", "expiresAt"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
