/**
 * Quote document schema — Firestore collection: quotes
 *
 * PDF quotes associated with orders.
 * UID scheme: "{orderUid}:v{N}", one per saved version.
 */
import { z } from "zod";
import { FirestoreId, QuoteId } from "./_uid.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import { type RenderParamsContext, RenderParamsContextSchema } from "./template-version.ts";

/** A PDF quote document associated with an order. */
export interface Quote {
  uid: string;
  uid_order: string;
  order_number: number;
  version: number;
  /**
   * RETIRING (api-cloudrun#1129). Every stored quote is a saved version, so this
   * is always `false`; it is optional only until storage is stripped, and then
   * it is deleted. Do not add a reader or a writer.
   */
  is_draft?: boolean;
  uploadcare_uuid: string;
  /**
   * The render params this PDF was actually rendered at — the map
   * `resolveRenderParams` returned inside `renderDocument`, handed back by it
   * rather than re-derived here. `{}` means none were recorded.
   *
   * ⚠️ In a quote template this is `it.doc.params` — the map THIS artifact was
   * rendered at, which for a re-render is the previous one. The live render map
   * is `it.params`.
   */
  params: Record<string, boolean>;
  /**
   * The param DECLARATION `params` was resolved against, snapshotted at render
   * time — see {@link RenderParamsContext}. `null` = not recorded, which is the
   * truthful value for every artifact rendered before the field existed:
   * nobody can know which template version rendered a quote from March.
   *
   * A reader labels a stored key from THIS rather than from the family's
   * current `params[]`, falling back to today's behaviour when it is `null`.
   */
  params_context: RenderParamsContext | null;
  /**
   * `documentSourceHash("order", …)` of the order this PDF was rendered from —
   * what `@cfs/core/utils/contentHash` compares against the live order to flag a
   * saved version as out of date.
   *
   * Required. Every artifact carries one: the legacy corpus was stamped with the
   * hash of its CURRENT source document (`api-cloudrun`'s `backfill-source-hash`,
   * 2026-09-24, both projects), so a legacy version reads as not stale until its
   * order next changes.
   */
  source_hash: string;
  deleted_at: FirestoreTimestampType | null;
  expires_at: FirestoreTimestampType | null;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for Quote. */
export const QuoteSchema: z.ZodType<Quote> = z.strictObject({
  uid: QuoteId,
  uid_order: FirestoreId,
  order_number: z.number().meta({ column: true, label: "Order #" }),
  version: z.int().min(0),
  // RETIRING (api-cloudrun#1129): optional so the API can stop writing it,
  // then storage is stripped, then it is deleted.
  is_draft: z.boolean().optional(),
  // Non-null since the draft (the only artifact without a PDF yet) went away.
  uploadcare_uuid: uploadcareRef(z.string()),
  params: z.record(z.string(), z.boolean()),
  // Required and NULLABLE, never optional: `null` is a real answer ("not
  // recorded") and absent is not. No `.default(null)` — a default never
  // materializes on a write (`validateBeforeWrite` discards `result.data`), so
  // it would only license a future writer to forget the stamp.
  params_context: RenderParamsContextSchema.nullable(),
  // Required and NOT nullable: every artifact has a real source, and the legacy
  // corpus was stamped with the hash of its current one, so there is no
  // "unknown" state to represent. Shipped optional first (beta.540) so the
  // backfill could run against a build that already declared the key.
  source_hash: z.string(),
  deleted_at: FirestoreTimestamp.nullable(),
  expires_at: FirestoreTimestamp.nullable(),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  updated_at: FirestoreTimestamp.meta({ column: true, label: "Updated" }),
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
