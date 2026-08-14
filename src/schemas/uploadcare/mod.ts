/**
 * Uploadcare CDN-reference surface.
 *
 * Two consumers, two different jobs:
 *
 * - **`uploadcareRef()`** (`./ref.ts`) — the authoring annotation. Applied at the
 *   nine ref leaves; read by `core/tests/uploadcareRef.test.ts`, which is the
 *   lint that tells a developer "you added a CDN field, register it".
 * - **`uploadcareRefPaths()` / `uploadcareSelectFields()`** — read by
 *   api-cloudrun's orphan sweep to give its circuit breaker *per-collection uuid
 *   counts*. The sweep does NOT depend on this list to keep files alive: it
 *   harvests every RFC-4122-shaped string value out of every document, which is
 *   schema-independent and cannot drift. This module supplies attribution, not
 *   protection. See `api-cloudrun/src/lib/uploadcareReferenceMap.ts`.
 */
import type { z } from "zod";
import { isCollectionName, schemaFor } from "../mod.ts";
import { collectLeafPaths } from "../zod-walk.ts";
import { UPLOADCARE_REF_META } from "./ref.ts";

export { UPLOADCARE_REF_META, uploadcareRef } from "./ref.ts";
export {
  isUploadcareCandidate,
  MEDIA_CONTAINER_RE,
  UPLOADCARE_CANDIDATE_EXEMPTIONS,
} from "./dictionary.ts";

/**
 * The collections that hold CDN refs today, **pinned**.
 *
 * Pinned rather than derived because the `schemas` record deliberately maps a
 * singular *and* a plural key to the same instance (`"card"` and `"cards"` are
 * the same node), so "dedupe by instance" is underdetermined — first-wins gives
 * the singular, last-wins the plural, and only one of them is the Firestore
 * collection name the sweep counts against.
 *
 * These are `schemas`-record keys, NOT the schema-level `.meta({ collection })`:
 * `OrderDocumentSchema`'s meta reads `"orders/{uid}/documents"`, which matches
 * neither the sweep's `collectionCounts` keys nor `db.collectionGroup("documents")`.
 */
export const UPLOADCARE_COLLECTION_KEYS = [
  "quotes",
  "invoices",
  "products",
  "cards",
  "recurrences",
  "templates-versions",
  "documents",
] as const;

/** A key of {@link UPLOADCARE_COLLECTION_KEYS}. */
export type UploadcareCollectionKey = typeof UPLOADCARE_COLLECTION_KEYS[number];

/**
 * The document schema for an Uploadcare collection key, throwing when the key
 * names no registered collection.
 *
 * ⚠️ This was a LOCAL `schemaFor` shadowing the registry's exported one of the
 * same name, doing the same lookup with its own truthiness test. It now narrows
 * and delegates, so "string → known collection" has one implementation in this
 * package rather than two that can disagree (api-cloudrun#444).
 */
function uploadcareSchemaFor(collection: string): z.ZodType {
  if (!isCollectionName(collection)) {
    throw new Error(
      `UPLOADCARE_COLLECTION_KEYS names "${collection}", which is not a key of the \`schemas\` record`,
    );
  }
  return schemaFor(collection);
}

/**
 * Every `uploadcareRef()`-annotated leaf, grouped by collection.
 *
 * Paths carry `collectLeafPaths`' container markers, e.g.
 * `{ invoices: ["uploadcare_uuid", "pdf_versions[].uploadcare_uuid"] }`.
 * Sorted for a stable snapshot.
 */
export function uploadcareRefPaths(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const collection of UPLOADCARE_COLLECTION_KEYS) {
    const { leaves, unhandled } = collectLeafPaths(uploadcareSchemaFor(collection));
    if (unhandled.length > 0) {
      throw new Error(
        `collectLeafPaths could not interpret ${unhandled.length} node(s) in "${collection}": ` +
          unhandled.map((u) => `${u.path || "<root>"}:${u.type}`).join(", "),
      );
    }
    out[collection] = leaves
      .filter((leaf) => leaf.meta[UPLOADCARE_REF_META] === true)
      .map((leaf) => leaf.path)
      .sort();
  }
  return out;
}

/**
 * The top-level Firestore field names a `.select()` projection must carry to
 * reach every CDN ref in `collection` — the first path segment of each ref,
 * container markers stripped (`pdf_versions[].uploadcare_uuid` → `pdf_versions`).
 *
 * Throws on an unknown collection rather than returning `[]`: an empty
 * projection would silently under-count the sweep's canary.
 */
export function uploadcareSelectFields(collection: string): string[] {
  const paths = uploadcareRefPaths()[collection];
  if (!paths) {
    throw new Error(
      `"${collection}" is not an Uploadcare reference collection (expected one of: ${
        UPLOADCARE_COLLECTION_KEYS.join(", ")
      })`,
    );
  }
  return [...new Set(paths.map((p) => p.split(".")[0].replace(/\[\]$/, "")))].sort();
}
