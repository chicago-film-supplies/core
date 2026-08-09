/**
 * PreviewRecord schema — Firestore collection: template_previews
 *
 * Short-lived cache of a rendered template PDF (base64) so the browser can
 * iframe a server-served URL with a human-readable filename instead of a blob
 * URL. The 64-hex `uid` doubles as the bearer token; Firestore TTL on
 * `expires_at` auto-cleans the doc ~5 minutes after creation. Written by the
 * api-cloudrun `storePreview` helper (`POST /templates/render`).
 */
import { z } from "zod";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/** A cached rendered-PDF preview document. */
export interface PreviewRecord {
  uid: string;
  user_id: string;
  pdf_base64: string;
  filename: string;
  created_at: FirestoreTimestampType;
  expires_at: FirestoreTimestampType;
}

/** Zod schema for PreviewRecord. */
export const PreviewRecordSchema: z.ZodType<PreviewRecord> = z.strictObject({
  // 64-hex capability token, not a Firestore auto-id — kept a plain string.
  uid: z.string(),
  // Internal Firestore uid, not customer data — same call as `log/base.ts`.
  user_id: z.string().meta({ pii: "none", column: true, label: "User" }),
  pdf_base64: z.string(),
  // NOT a server-fixed name: a template's `renderConfig.filename` is itself an
  // Eta source rendered against the full document context (api-cloudrun
  // `lib/templates/render.ts`), so an author can interpolate the organization
  // name straight into it.
  filename: z.string().meta({ pii: "mask", column: true, label: "Filename" }),
  created_at: FirestoreTimestamp,
  expires_at: FirestoreTimestamp,
}).meta({
  title: "Template Preview",
  collection: "template_previews",
  displayDefaults: {
    columns: ["filename", "user_id"],
    filters: {},
    sort: { column: null, direction: "desc" },
  },
});
