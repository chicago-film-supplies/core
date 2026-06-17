/**
 * Counter document schema — Firestore collection: counters
 *
 * Simple atomic counters used for sequential number generation.
 * Documents: counters/orders, counters/transactions, counters/invoices, counters/out-of-service
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** A counter document in the counters Firestore collection. */
export interface Counter {
  count: number;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a Counter document. */
export const CounterSchema: z.ZodType<Counter> = z.strictObject({
  count: z.number(),
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Counter",
  collection: "counters",
  displayDefaults: {
    columns: ["count"],
    filters: {},
    sort: { column: "count", direction: "desc" },
  },
});
