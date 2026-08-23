/**
 * Uploadcare work-list entry — Firestore collection: `uploadcare-worklist`.
 *
 * One document per **uploaded CDN file**, id == the Uploadcare uuid. It is the
 * durable record that makes a displaced upload findable, and it exists because
 * a render is two steps that cannot be one transaction: upload the bytes (an
 * external side effect with no rollback), then write the uuid into the document
 * that will serve it. When the second step loses — a newer render commits
 * first, a CAS retry, a crash — the file is referenced by nothing and nothing
 * knows it exists. Both PDF producers deliberately allow concurrency, so N
 * racing renders of one document produce **one winner and N−1 unrecorded
 * uploads**: measured on prod 2026-07-26, 44 of 49 unreferenced files sat in
 * same-filename duplicate groups produced by 13 documents.
 *
 * The producer creates an entry here in the same compare-and-set that commits
 * its render, so even a losing render is named by the document that produced it,
 * and `reconcileUploadcareFiles` can delete `owned − live` in band rather than
 * leaving it to the weekly sweep.
 *
 * ## Why it is not a field on the owning document (api-cloudrun#535)
 *
 * It was — `invoice.uploadcare_files` / `quote.uploadcare_files` — and that is
 * env-local state living inside a **mirrored** document. `mirrorDocument` is a
 * whole-document `casReplaceDoc`, so a prod write to an invoice replaces dev's
 * list with prod's, and every file dev uploaded is instantly owned by nothing.
 * Not stale — *unowned*, permanently, with no mechanism able to name it again.
 * Measured 2026-08-16: dev's CDN partition held 7,714 stranded document PDFs in
 * 1,078 duplicate-filename groups while prod held zero.
 *
 * Same class as `counters/*` (api-cloudrun#445, where the mirror dragged dev's
 * allocator backwards) and `stock` / `stock-locks`. All three are in
 * `SKIP_COLLECTIONS`; **this collection must be too, and that is the entire
 * point of moving it.** A field-level carve-out in the mirror was the
 * alternative and was rejected: the mirror's contract is whole-document, and a
 * per-field exception makes "dev is a faithful copy of prod" conditional on a
 * list nobody reads.
 *
 * ## ⚠️ An entry is a TO-DO, not a reference — and the sweep must not read it
 *
 * The orphan sweep's in-use set comes from a **value harvest**: `harvestUuids`
 * walks `db.listCollections()` and collects every uuid-shaped string in every
 * document, precisely so that a file is protected by the data rather than by a
 * hand-maintained extractor list. A new top-level collection is picked up by
 * that walk automatically.
 *
 * **That must be suppressed for this one collection.** An entry names a file
 * that may well be garbage — a displaced render awaiting collection is the
 * normal case — so harvesting it would make every work-list entry protect its
 * own file from the sweep, and the in-band reconcile would become the *only*
 * reclaimer. Worse, an entry outliving its owning document (nothing cascades
 * deletes here) would protect that file **forever**, invisibly, which is the
 * one failure mode the sweep cannot report.
 *
 * Protection comes from the LIVE fields — `uploadcare_uuid`, `pdf_versions[]`,
 * `products.images[]` — which both the harvest and the declared extractors
 * already see. With the work list excluded, a displaced file has two
 * independent reclaimers (the in-band reconcile, and the sweep once the 48h
 * grace expires) instead of one, which is strictly better than the field it
 * replaces.
 *
 * ## ⚠️ Read the work list BEFORE the owning document
 *
 * `reconcileUploadcareFiles` derives `owned` and `live` from what used to be a
 * single snapshot, and that single snapshot is its entire safety argument: a
 * uuid absent from `live` can never become live again, because promote only
 * ever sets `uploadcare_uuid` to the uuid its own writer just uploaded. Split
 * across two reads, the argument survives **only in one order** — query this
 * collection first, then read the document. An entry created after the `owned`
 * read is simply not considered and gets reconciled later; reading `live` first
 * would let a concurrent writer's promote land in between and the reconcile
 * would delete the other writer's LIVE file. Same shape as
 * `stockGateInputs.ts`: read the token before the sources, never after.
 *
 * ## Immutable, and self-limiting
 *
 * An entry is created once and deleted once; nothing ever updates one, which is
 * why it carries `created_at` and no `updated_at`. `expires_at` is the field a
 * Firestore TTL keys on, so an entry whose owner was deleted — nothing cascades
 * here — or whose reconcile never ran cannot accumulate forever. Expiry is safe
 * precisely because of the rule above: an entry confers no protection, so
 * losing one costs the fast reclaimer and nothing else.
 *
 * ⚠️ **The TTL is NOT declared yet**, and the field alone does nothing —
 * Firestore expires a document only when a policy names the field. It belongs
 * in `api-cloudrun/infra/firestore.tf` `local.firestore_ttls` as
 * `"uploadcare-worklist" = "expires_at"`, NOT as a `"ttl": true` field override
 * in `firestore-indexes.json` (`check "firestore_ttl_single_owner"` fails the
 * plan on that), and `terraform apply` is manual, so a committed entry sits
 * unapplied until someone runs it. Land it with the first writer.
 */
import { z } from "zod";
import { FirestoreId, QuoteId } from "./_uid.ts";
import { FirestoreTimestamp, type FirestoreTimestampType } from "./common.ts";

/**
 * The collections whose documents own CDN uploads. A closed set on purpose: a
 * new producer is a compile error here rather than a string nobody validates.
 *
 * Deliberately NOT `CollectionName` — that union is derived from the schema
 * registry this file is part of, so using it would be circular, and it would
 * also admit the 40-odd collections that upload nothing.
 */
const UPLOADCARE_OWNER_COLLECTIONS = [
  "invoices",
  "quotes",
  "orders",
  "products",
  "templates-versions",
] as const;
/** Which collection the owning document lives in. */
export type UploadcareOwnerCollectionType = typeof UPLOADCARE_OWNER_COLLECTIONS[number];
/** Zod schema for {@link UploadcareOwnerCollectionType}. */
export const UploadcareOwnerCollectionEnum: z.ZodType<UploadcareOwnerCollectionType> = z.enum(
  UPLOADCARE_OWNER_COLLECTIONS,
);

/**
 * What produced the file. Carried so an operator — and the sweep's
 * `orphan_classes` breakdown — can attribute a stranded file to its producer
 * without inferring it from the filename, which is what
 * `lib/uploadcareOrphanClasses.ts` has to do today.
 */
const UPLOADCARE_UPLOAD_KINDS = [
  "draft_pdf",
  "versioned_pdf",
  "packing_list",
  "golden_baseline",
  "golden_candidate",
  "golden_diff",
  "product_image",
] as const;
/** What produced the file. */
export type UploadcareUploadKindType = typeof UPLOADCARE_UPLOAD_KINDS[number];
/** Zod schema for {@link UploadcareUploadKindType}. */
export const UploadcareUploadKindEnum: z.ZodType<UploadcareUploadKindType> = z.enum(
  UPLOADCARE_UPLOAD_KINDS,
);

/** One uploaded CDN file, recorded by the producer that uploaded it. */
export interface UploadcareWorkListEntry {
  /**
   * The Uploadcare uuid, which IS the document id — a natural key rather than
   * an auto-id, because the identity already exists and is globally unique, so
   * a redelivered producer rewrites the same document instead of minting a
   * second row for one file.
   *
   * **Named `uuid`, never `uid`.** In this package `uid` means *a Firestore
   * document id* (`_uid.ts`), and an Uploadcare id is `uuid` everywhere it
   * already appears — `product.ts` `images[].uuid`, `order-document.ts`, and
   * the `uploadcare_files[].uuid` entries this collection replaces.
   * api-cloudrun#506 is the same confusion in the other direction.
   *
   * ⚠️ **Consequence: the uid-equals-doc-id guard does not cover this
   * collection.** `assertValidForWrite` fires on `typeof uid === "string" &&
   * uid !== ref.id`, so a schema with no `uid` field is simply unguarded (same
   * as `counters`). Keeping this equal to the document id is the writer's job,
   * and `validatedSet` will not catch it if a copy drifts.
   */
  uuid: string;
  /**
   * The owning document's id — the key `reconcileUploadcareFiles` queries by.
   *
   * ⚠️ Not `FirestoreId` alone. `quotes` is a declared owner and a quote's id
   * is `{orderUid}:v{N}` or `{orderUid}:draft` (`QuoteId`), which no 20-char
   * pattern admits — typing this `FirestoreId` rejected every quote-produced
   * entry at `validateBeforeWrite`, silently, since quotes are exactly where
   * draft-PDF displacement was first measured.
   */
  uid_document: string;
  collection: UploadcareOwnerCollectionType;
  kind: UploadcareUploadKindType;
  /**
   * `original_filename` as uploaded. Redundant against the CDN listing and kept
   * anyway: it is what makes a stranded entry legible without a network call,
   * and duplicate filenames within one owner are the displacement signature.
   */
  filename: string;
  /**
   * The owning document's `version` at render time, when it has one. Null for a
   * producer whose source is not a versioned document.
   */
  version_source: number | null;
  created_at: FirestoreTimestampType;
  /**
   * TTL field — see the module docblock. Not a business date; a machine
   * timestamp, so `FirestoreTimestamp` rather than a Chicago-offset string.
   */
  expires_at: FirestoreTimestampType;
}

/**
 * Zod schema for {@link UploadcareWorkListEntry}.
 *
 * No `env` field, deliberately. The collection is excluded from the prod → dev
 * mirror, so every entry in a database was written by that database and the
 * field could only ever restate which project you are already talking to — a
 * copy that can drift, for a fact that cannot. The one thing it would buy is
 * letting dev skip `isDevOwnedFile`'s metadata round trip before a delete, which
 * is not worth a redundant column.
 */
export const UploadcareWorkListEntrySchema: z.ZodType<UploadcareWorkListEntry> = z.strictObject({
  // ⚠️ **Deliberately NOT `uploadcareRef()`**, and that is a second decision
  // from the harvest exclusion above, not the same one. `uploadcareRef` marks a
  // field as a *declared* CDN reference: it feeds `uploadcareRefPaths()`, the
  // per-collection `.select()` projections, api-cloudrun's `EXPECTED_REF_PATHS`
  // snapshot and the `refCounts` scan-anomaly canary — all of which must count
  // only STABLE references. A work-list entry is the opposite: a record of an
  // upload that is usually about to be deleted. Annotating it would make the
  // canary's baseline swing with render volume and enrol garbage as protected.
  //
  // Exempted by name in `uploadcare/dictionary.ts`, which is where the two
  // fields this collection replaces (`invoices::uploadcare_files[].uuid` and
  // its `quotes` twin) already record the identical decision. The exemption is
  // load-bearing rather than cosmetic: `isUploadcareCandidate` matches any path
  // segment containing `uuid`, so without it `uploadcareRef.test.ts` assertion
  // 1 fails the build.
  //
  // `z.uuid()` rather than `z.uuidv4()`: Uploadcare mints v4 today, but a
  // version-nibble assertion is the tightening that rejected most of history
  // when it was tried on session ids (api-cloudrun#506). Third-party uuids are
  // named as a deliberate carve-out from the `_uid.ts` validators.
  uuid: z.uuid(),
  // The union is required, not defensive — see the interface field.
  uid_document: z.union([FirestoreId, QuoteId]),
  collection: UploadcareOwnerCollectionEnum.meta({ column: true, label: "Collection" }),
  kind: UploadcareUploadKindEnum.meta({ column: true, label: "Kind" }),
  // `pii: "mask"` + the 260 cap follow the two siblings that already store an
  // uploaded filename — `card.ts` and `template-preview.ts`. Machine-generated
  // for every producer here except `product_image`, where the name is whatever
  // the operator's file was called; the tag costs nothing (it drives the logger
  // and fixture masking, never the stored value, and the displacement signature
  // reads the CDN listing rather than this field).
  filename: z.string().min(1).max(260).meta({ pii: "mask", column: true, label: "Filename" }),
  version_source: z.int().nullable().meta({ column: true, label: "Version Source" }),
  created_at: FirestoreTimestamp.meta({ column: true, label: "Created" }),
  expires_at: FirestoreTimestamp.meta({ column: true, label: "Expires" }),
}).meta({
  title: "Uploadcare Work List Entry",
  collection: "uploadcare-worklist",
  // The doc id is `uuid`, and that is already CORRECT rather than a carve-out
  // needing forgiveness: it genuinely is an Uploadcare UUID that doubles as the
  // id, which is exactly what `uuid` is reserved to mean (`uid` = our document
  // id, `uuid` = someone else's identifier).
  idField: "uuid",
  displayDefaults: {
    columns: ["collection", "kind", "filename", "created_at"],
    filters: { kind: [] },
    sort: { column: "created_at", direction: "desc" },
  },
});
