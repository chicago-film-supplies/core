/**
 * OrderDocument schema — Firestore subcollection: orders/{uid}/documents
 *
 * Metadata for the generated PDFs (quote + packing list) an order produces.
 * Written by the api-cloudrun `processOrderDocs` Cloud Task after rendering in
 * CRMS and uploading to the Uploadcare CDN. There are no server timestamps —
 * `orderUpdatedAt` is the order's `updated_at` at render time, used to prune
 * stale generated docs.
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
}).meta({
  title: "Order Document",
  collection: "orders/{uid}/documents",
  displayDefaults: {
    columns: ["name", "mime"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
