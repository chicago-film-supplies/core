/**
 * OrderDocument schema — Firestore subcollection: orders/{uid}/documents
 *
 * Metadata for the generated PDFs (quote + packing list) an order produces.
 * Written by the api-cloudrun `processOrderDocs` Cloud Task after rendering in
 * CRMS and uploading to the Uploadcare CDN; the `uuid` is the CDN file id the
 * card surface deep-links to. The doc id is an auto-id (no `uid` field on the
 * body), and there are no server timestamps — `orderUpdatedAt` is the order's
 * `updated_at` at render time, used to prune stale generated docs.
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";

/** Metadata for a single generated order document (quote / packing list PDF). */
export interface OrderDocument {
  uuid: string;
  mime: string;
  name: string;
  orderUpdatedAt: FirestoreTimestampType;
}

/** Zod schema for OrderDocument. */
export const OrderDocumentSchema: z.ZodType<OrderDocument> = z.strictObject({
  // Uploadcare CDN file id — kept a plain non-empty string (not z.uuid()) so a
  // non-UUID CDN id can never block a regen write.
  uuid: uploadcareRef(z.string().min(1)),
  mime: z.string().min(1),
  name: z.string().min(1),
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
