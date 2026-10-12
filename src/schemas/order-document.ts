/**
 * OrderDocument schema — Firestore subcollection: orders/{uid}/documents
 *
 * Metadata for the generated PDFs (quote + packing list) an order produces.
 * The packing list is rendered ON READ by api-cloudrun's `resolvePackingListUuid`
 * (`GET /packing-list?number=`) and uploaded to the Uploadcare CDN; the
 * `processOrderDocs` Cloud Task that used to write this collection was deleted
 * with api-cloudrun#1129. There are no server timestamps — `orderUpdatedAt` is
 * the order's `updated_at` at render time.
 *
 * ⭐ **This type carries `uid` AND `uuid` side by side, which is the convention's
 * clearest illustration** (`core/CLAUDE.md` § *UID property naming*): `uid` is
 * the Firestore document id, `uuid` is an Uploadcare CDN file id — someone
 * else's identifier, which is exactly what `uuid` is reserved to mean.
 *
 * ⚠️ **This docstring used to say "the doc id is an auto-id". It was wrong.**
 * `processOrderDocs` derives the id from the filename via `orderDocumentId(name)`,
 * so it has been deterministic — `"quote"` / `"packing-list"` — the whole time.
 * That is why `uid` can be stamped with **no id change and no re-keying**.
 *
 * 🔴 **`uid` is the DOCUMENT id, never `uuid`.** The write is validated
 * (`processOrderDocs`' `transaction.set` routes through `validatedSet`), so
 * adding this field ACTIVATES api-cloudrun's `uid === ref.id` drift guard on a
 * path where it previously did nothing. Setting it to the Uploadcare `uuid`
 * would fail every write.
 *
 * **`uid` is REQUIRED**, as of the backfill completing in both environments
 * (2026-08-23). It shipped `.optional()` first and was tightened after, rather
 * than required in one shot, because this collection cannot age into a new
 * shape by itself: `documents` has NO TTL — it is absent from
 * `local.firestore_ttls` — and `processOrderDocs` is version-keyed, so a closed
 * order is never rewritten. A required field on day one would have refused every
 * regen against ~1,988 un-stamped documents.
 *
 * Backfill measured, both environments: **1,988 documents, 100% carrying `uid`,
 * 0 with `uid !== ref.id`**, verified by parsing the whole collection group.
 *
 * ⚠️ **The backfill keyed on `ref.id`, never `orderDocumentId(data.name)`** — and
 * that rule stands even though the reason usually given for it turned out to be
 * false. The warning was a "tail of orders with more than two documents (legacy
 * auto-id survivors) whose ids are neither literal". Measured on prod, that tail
 * **does not exist**: `audit-order-documents-cardinality.ts` reports
 * `{"2": 994}` — every order has exactly two documents, none has more. Key on
 * `ref.id` regardless: it is the document id *by definition*, whereas deriving
 * from the name is only right while a coincidence holds.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import { type RenderParamsContext, RenderParamsContextSchema } from "./template-version.ts";

/** Metadata for a single generated order document (quote / packing list PDF). */
export interface OrderDocument {
  /**
   * Firestore document id — `"quote"` or `"packing-list"`, derived from the
   * filename.
   */
  uid: string;
  uuid: string;
  mime: string;
  name: string;
  orderUpdatedAt: FirestoreTimestampType;
  /**
   * `documentSourceHash("packing-list", …)` of the order this file was rendered from.
   * The packing list is rendered on read: a stored file whose hash equals the
   * live order's is served as-is, otherwise it is re-rendered. Required: the
   * legacy documents were stamped from their current order in the 2026-09-24
   * backfill.
   */
  source_hash: string;
  /**
   * The template and component versions (and the param declaration) this file
   * was rendered against — what `renderDocument` returned for these bytes.
   *
   * ⚠️ **On THIS collection, ABSENT reads as STALE** — the opposite of the
   * convention `RenderParamsContext` documents for quotes and invoices, and on
   * purpose. Those are SAVED artifacts an operator chose to keep, so an
   * unrecorded version must not flag. A packing list is rendered on read, so
   * "stale" costs one re-render, and the owner ruled (2026-10-12) that a
   * template or component release must reach every cached packing list. A file
   * written before this field existed therefore re-renders once on its next
   * read. Optional rather than nullable because no stored document carries it
   * and none can be backfilled.
   */
  params_context?: RenderParamsContext;
}

/** Zod schema for OrderDocument. */
export const OrderDocumentSchema: z.ZodType<OrderDocument> = z.strictObject({
  // The Firestore doc id, mirrored onto the body so the write-time drift guard
  // can see it at all — a document whose id field is not called `uid` passes
  // that guard silently.
  uid: z.string().min(1),
  // Uploadcare CDN file id — kept a plain non-empty string (not z.uuid()) so a
  // non-UUID CDN id can never block a regen write.
  uuid: uploadcareRef(z.string().min(1)),
  mime: z.string().min(1).meta({ column: true, label: "Type" }),
  name: z.string().min(1).meta({ column: true, label: "Name" }),
  orderUpdatedAt: FirestoreTimestamp,
  // Required — see `Quote.source_hash`.
  source_hash: z.string(),
  // Optional: absent on every file rendered before it existed, and absent reads
  // as stale here (see the interface).
  params_context: RenderParamsContextSchema.optional(),
}).meta({
  title: "Order Document",
  collection: "orders/{uid}/documents",
  displayDefaults: {
    columns: ["name", "mime"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
