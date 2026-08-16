/**
 * The CDN producer work-list edges — a PDF producer recording the uuid it just
 * uploaded, in the same atomic write that decides whether that uuid becomes the
 * document's live file.
 *
 * ## Why the atomicity is the whole rule
 *
 * A render is two steps that cannot be one write: upload the bytes (an external
 * side effect with no rollback), then point the document at them. Both producers
 * deliberately allow concurrency, so N racing renders of one document produce one
 * winner and N−1 uploads nothing references. The work-list entry is what makes a
 * losing render's file findable — see `uploadcare-worklist.ts` for the corpus
 * measurement behind that.
 *
 * ⚠️ **The entry must become visible at the same instant the promote does, and
 * writing it FIRST is the plausible-and-wrong alternative.** The collector
 * (`reconcileUploadcareFiles`) deletes `owned − live`, so an entry that is
 * visible while its own promote is still in flight advertises a file as
 * collectable that a peer's collector will then delete — after which this
 * producer's CAS lands and points a live document at a deleted file. That is the
 * `delete before the write` ordering both producers were built to escape. One
 * `WriteBatch` under the owning document's `lastUpdateTime` precondition is what
 * keeps the pair indivisible, which is why the mode here is `co-write` even
 * though no Firestore *transaction* is involved.
 *
 * ## Two rules, not one
 *
 * `source` names a collection, and the two producers are genuinely separate
 * writers with separate live-set definitions — the invoice path must retain
 * `pdf_versions[]` uuids the quote path knows nothing about. Sharing one rule id
 * would also hoist both literals out of the files that log them, which is how a
 * drift check goes quiet (api-cloudrun#501).
 *
 * Traced from: api-cloudrun/src/services/invoicePdf.ts and
 * api-cloudrun/src/services/quotes.ts.
 */
import type { CollectionRule, EnforcementRef } from "./types.ts";

/**
 * What checks these edges today, and — the part that matters — what it cannot.
 *
 * The sweep's `displacement_groups` signal reads the CDN listing and reports
 * duplicate filenames within one producer class, which is what an uncollected
 * displacement looks like from outside. It is a real detector: it is the one
 * that measured 44 of 49 unreferenced prod files sitting in 13 documents'
 * duplicate groups, and `UploadcareDisplacementLeak` alerts on it weekly.
 *
 * ⚠️ It observes the **consequence**, never the write. A producer that uploaded
 * and recorded nothing is indistinguishable to it from one that recorded an
 * entry the collector then honoured — both leave no duplicate group — so it
 * cannot see a missing entry until a second render of the same document
 * strands a file, and it cannot see one at all on a document rendered once.
 * Nothing checks the co-write itself; saying so is more useful than a pointer
 * that implies otherwise.
 */
const DISPLACEMENT_SIGNAL: EnforcementRef = {
  kind: "audit",
  ref: "api-cloudrun/src/lib/uploadcareOrphanClasses.ts",
  clause:
    "the CONSEQUENCE only — duplicate filenames within one document-PDF class among the sweep's orphan set (`displacement_groups`, alerted by `UploadcareDisplacementLeak`). It cannot see a missing entry directly: a render that recorded nothing and a render whose entry was collected both leave zero groups, so a document rendered once can strand a file and measure clean.",
  gates: true,
};

/** The uuid and its provenance, identical on both edges. */
const WORK_LIST_FIELDS: CollectionRule["fields"] = [
  { source: [], target: ["uuid"], transform: "the Uploadcare uuid this render uploaded — and the entry's document id" },
  { source: ["uid"], target: ["uid_document"] },
  { source: [], target: ["collection"], transform: "the owning collection (constant per producer)" },
  { source: [], target: ["kind"], transform: "'draft_pdf' | 'versioned_pdf', by producer path" },
  { source: [], target: ["filename"], transform: "the rendered filename as uploaded" },
  { source: ["version"], target: ["version_source"] },
  { source: [], target: ["expires_at"], transform: "created_at + the work list's TTL horizon" },
];

export const uploadcareWorkListRules: CollectionRule[] = [
  {
    id: "generate-invoice-pdf:upload-to-worklist",
    source: "invoices",
    target: "uploadcare-worklist",
    mode: "co-write",
    invariant:
      "Every uuid an invoice PDF render uploads gets a `uploadcare-worklist` entry, created in the SAME batch as the invoice write that conditionally promotes it — so an entry is visible exactly when its uuid is either live or genuinely displaced, never in between. Covers both producers on that document: the draft regeneration and the explicit versioned save, which share one work list and one collector precisely so the draft path cannot collect the versioned path's `pdf_versions[]` files. The render's predecessor is adopted into the list in the same write, because a document that has never been rendered under this mechanism owns a live file no entry names.",
    enforced_by: [DISPLACEMENT_SIGNAL],
    fields: WORK_LIST_FIELDS,
  },
  {
    id: "generate-quote-pdf:upload-to-worklist",
    source: "quotes",
    target: "uploadcare-worklist",
    mode: "co-write",
    invariant:
      "Every uuid a quote PDF render uploads gets a `uploadcare-worklist` entry, created in the SAME batch as the quote write that conditionally promotes it. The quote path's live set is its own — a quote id is `{orderUid}:v{N}` or `:draft`, and a released version's uuid stays live for the life of the row — which is why the entry's `uid_document` is deliberately typed to admit a quote id rather than a 20-char Firestore id.",
    enforced_by: [DISPLACEMENT_SIGNAL],
    fields: WORK_LIST_FIELDS,
  },
];
