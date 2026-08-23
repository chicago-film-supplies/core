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
 * ⚠️ **Optional on purpose, and only for now.** `documents` has NO TTL — it is
 * absent from `local.firestore_ttls` — and `processOrderDocs` is version-keyed,
 * so a closed order is never rewritten and ~1,836 permanent documents will not
 * turn over on their own. The sequence is **optional → backfill → tighten to
 * required**; shipping it required in one shot breaks every regen immediately.
 * ⚠️ The backfill must key on **`ref.id`**, never on `orderDocumentId(data.name)`:
 * there is a tail of orders with more than two documents (legacy auto-id
 * survivors) whose ids are neither literal.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";

/** Metadata for a single generated order document (quote / packing list PDF). */
export interface OrderDocument {
  /**
   * Firestore document id — `"quote"` or `"packing-list"`, derived from the
   * filename. Optional until the backfill lands; see the module doc.
   */
  uid?: string;
  uuid: string;
  mime: string;
  name: string;
  orderUpdatedAt: FirestoreTimestampType;
}

/** Zod schema for OrderDocument. */
export const OrderDocumentSchema: z.ZodType<OrderDocument> = z.strictObject({
  // The Firestore doc id, mirrored onto the body so the write-time drift guard
  // can see it. Optional ONLY until the backfill completes — see the module doc
  // for why this collection cannot age into the new shape by itself.
  uid: z.string().min(1).optional(),
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
