/**
 * Quote document schema — Firestore collection: quotes
 *
 * PDF quotes associated with orders.
 * UID scheme: "{orderUid}:draft" for live draft, "{orderUid}:v{N}" for saved versions.
 */
import { z } from "zod";
import { FirestoreId, QuoteId } from "./_uid.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";

/** A PDF quote document associated with an order. */
export interface Quote {
  uid: string;
  uid_order: string;
  order_number: number;
  version: number | null;
  is_draft: boolean;
  uploadcare_uuid: string | null;
  /**
   * CDN uploads this doc owns pending reconcile — the producer work list that
   * makes a displaced draft render collectable in-band instead of by the weekly
   * sweep.
   *
   * ABSENT on every doc written before this field existed and on any writer that
   * doesn't construct it — always read as `(doc.uploadcare_files ?? [])`.
   * `.default([])` does not materialize: `validateBeforeWrite` discards
   * `result.data` and callers write the RAW doc.
   *
   * `version_source` is the writer's snapshot of the SOURCE doc's version — for
   * a quote that is `order.version`, not this doc's `version` (which means the
   * v{N} snapshot number, and is null on a draft). Both producers writing
   * `version_source` is what makes one array coherent across them.
   */
  uploadcare_files?: Array<{
    uuid: string;
    version_source: number;
    created_at: FirestoreTimestampType;
  }>;
  deleted_at: FirestoreTimestampType | null;
  expires_at: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Quote. */
export const QuoteSchema: z.ZodType<Quote> = z.strictObject({
  uid: QuoteId,
  uid_order: FirestoreId,
  order_number: z.number(),
  version: z.int().min(0).nullable(),
  is_draft: z.boolean(),
  uploadcare_uuid: uploadcareRef(z.string().nullable()),
  // `uuid` is a plain string, deliberately NOT `uploadcareRef()` — see the
  // matching note on `Invoice.uploadcare_files`.
  uploadcare_files: z.array(z.strictObject({
    uuid: z.string(),
    version_source: z.int().min(0),
    created_at: FirestoreTimestamp,
  })).optional(),
  deleted_at: FirestoreTimestamp.nullable(),
  expires_at: FirestoreTimestamp.nullable(),
  created_at: FirestoreTimestamp,
  updated_at: FirestoreTimestamp,
}).meta({
  title: "Quote",
  collection: "quotes",
  displayDefaults: {
    columns: ["order_number", "updated_at"],
    filters: {},
    sort: { column: "order_number", direction: "desc" },
  },
});

/** Input for saving a new quote version. */
export interface SaveQuoteVersionInputType {
  uid_order: string;
}
/** Zod schema for SaveQuoteVersionInput. */
export const SaveQuoteVersionInput: z.ZodType<SaveQuoteVersionInputType> = z.object({
  uid_order: FirestoreId,
});

/** Input for restoring a soft-deleted quote. */
export interface RestoreQuoteInputType {
  uid: string;
}
/** Zod schema for RestoreQuoteInput. */
export const RestoreQuoteInput: z.ZodType<RestoreQuoteInputType> = z.object({
  uid: QuoteId,
});
