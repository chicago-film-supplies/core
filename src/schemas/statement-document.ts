/**
 * StatementDocument schema — Firestore collection: `statement-documents`
 *
 * One row per org statement an operator SAVED, with the PDF that was handed to
 * the customer. The twin of {@link ./quote.ts | Quote}, down to the id shape
 * (`{parent uid}:v{N}`) and the claim-by-create allocator behind it.
 *
 * 🔴 **The collection is NOT called `statements`, and the name is load-bearing
 * rather than a stylistic dodge.** `statements` is already taken twice in the
 * template vocabulary — as a `TEMPLATE_SOURCE_COLLECTIONS` member (the FOLD,
 * `OrgStatementSchema`) and as a `TEMPLATE_TARGET_COLLECTIONS` member (what a
 * template produces). `TEMPLATE_COLLECTION_SCHEMAS.statements` names the source
 * half, and `tests/template-schemas.test.ts` asserts that every entry which IS
 * a Firestore collection is the SAME schema instance `schemaFor` returns — so
 * registering a *stored* `statements` collection carrying this schema fails
 * that assertion. That is the guard working: one word cannot mean the fold and
 * the artifact at once. The template TARGET stays `statements` (a `DocumentSource`
 * still declares `target: "statements"`); only the Firestore collection is
 * renamed, and the two are different vocabularies.
 *
 * 🔴 **Why a statement is persisted at all, when nothing in CFS sends anything.**
 * Decision B4 in `api-cloudrun/.claude/plans/reporting-capability.md` reads
 * "on-demand render, PERSIST ON SEND", and there is no send: `api-cloudrun`'s
 * `src/lib/email.ts` exports four senders and all four are internal
 * (verification, OAuth alert, invite, password reset). The operator downloads a
 * PDF and mails it themselves — exactly as they already do for an invoice,
 * whose `pdf_versions[]` is likewise written by an explicit operator save and
 * not by a send hook. So "persist on send" is built the way this codebase
 * already builds it: **the save IS the record of what was handed over.**
 *
 * ⭐ **And unlike a quote, a statement is NOT re-derivable.** A quote is a
 * function of its order; re-render it next week and you get the same document.
 * An `open_item` statement folds over the LIVE settlements journal, so the same
 * request answered a week later is a different page. That is what makes the
 * stored row the only possible answer to *"what did you send me on the 8th?"* —
 * and why {@link StatementDocument.closing_balance_cents} is stored rather than
 * looked up.
 *
 * ⚠️ **The FOLD is deliberately not stored.** Only the request, the chain, the
 * closing balance and the CDN file. Freezing `OrgStatement` itself would copy a
 * whole `lines[]` array — unbounded, against a 1 MB document limit — to serve no
 * named reader: the artifact a customer holds is the PDF, and the request
 * identifies it.
 */
import { z } from "zod";
import { FirestoreId, StatementDocumentId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  OrgPathNode,
  type OrgPathNodeType,
  TimestampFields,
} from "./common.ts";
import { uploadcareRef } from "./uploadcare/ref.ts";
import { type RenderParamsContext, RenderParamsContextSchema } from "./template-version.ts";
import {
  AGING_ANCHORS,
  type AgingAnchorType,
  STATEMENT_FORMATS,
  type StatementFormatType,
} from "./reporting.ts";

/**
 * The RESOLVED request a saved statement was rendered at.
 *
 * ⚠️ **Resolved, never raw.** `api-cloudrun`'s `resolveStatementRequest` fills in
 * everything the FORMAT decides — most sharply `to_date`, which an omitted
 * parameter turns into `null` (unbounded) on `open_item` and today on
 * `balance_forward`. Freezing the caller's input instead would record a request
 * whose meaning moves with the default, so a row could not say what it ran.
 *
 * ⭐ **Two fields here are absent from the fold's own output and that is the
 * whole reason this block exists.** `OrgStatement` carries `format`,
 * `from_date`, `to_date` and `as_of_payment_date`, but records neither
 * `subtree` (a one-node subtree and a single node produce the same `scope.uids`)
 * nor `anchor` (which only reaches the aging strip). Without both, a saved row
 * cannot state what it was.
 */
export interface StatementRequestSnapshot {
  /** Rolled the organization's whole subtree into one statement. */
  subtree: boolean;
  format: StatementFormatType;
  /** Period start, or `null` for the whole account. */
  from_date: string | null;
  /** Which invoices existed. `null` is UNBOUNDED — the `open_item` default. */
  to_date: string | null;
  /** Which settlements counted. */
  as_of_payment_date: string;
  /** Which stored date the aging strip anchored on. */
  anchor: AgingAnchorType;
}

/** Zod schema for {@link StatementRequestSnapshot}. */
export const StatementRequestSnapshotSchema: z.ZodType<StatementRequestSnapshot> = z
  .strictObject({
    subtree: z.boolean(),
    format: z.enum(STATEMENT_FORMATS),
    from_date: z.string().nullable(),
    to_date: z.string().nullable(),
    as_of_payment_date: z.string(),
    anchor: z.enum(AGING_ANCHORS),
  });

/** One saved org-statement PDF. */
export interface StatementDocument {
  /** `{uid_organization}:v{N}`. */
  uid: string;
  uid_organization: string;
  /**
   * The organization's chain AT RENDER TIME — the heading the saved PDF
   * carries.
   *
   * 🔴 **Frozen, exactly as `DocumentOrganizationSnapshot.path` is frozen on an
   * invoice, and for the same reason**: a re-parent must not rewrite the
   * heading of a document already in a customer's hands. The AR aging report
   * groups by the LIVE tree and is right to; this is the other half of that
   * split (api-cloudrun#712).
   */
  organization_path: OrgPathNodeType[];
  /** 1-based, per organization. */
  version: number;
  request: StatementRequestSnapshot;
  /**
   * The closing balance the saved page printed.
   *
   * ⭐ **A frozen fact, not a denormalization — nothing can make it drift**,
   * because nothing recomputes it: no writer ever updates a saved row's money,
   * and the fold that produced it cannot be re-run to the same answer (see the
   * module doc). It is stored so a list of saved statements can say what each
   * one claimed without fetching a PDF.
   */
  closing_balance_cents: number;
  uploadcare_uuid: string | null;
  /**
   * The render params this PDF was actually rendered at — the map
   * `resolveRenderParams` returned, handed back rather than re-derived. `{}`
   * means none were recorded.
   */
  params: Record<string, boolean>;
  /**
   * The param DECLARATION `params` was resolved against, snapshotted at render
   * time (core#74). `null` = not recorded.
   */
  params_context: RenderParamsContext | null;
  /** Soft-delete. The CDN file is deliberately kept — see `Quote.deleted_at`. */
  deleted_at: FirestoreTimestampType | null;
  created_by: ActorRefType;
  created_at: FirestoreTimestampType;
  updated_at: FirestoreTimestampType;
}

/** Zod schema for {@link StatementDocument}. */
export const StatementDocumentSchema: z.ZodType<StatementDocument> = z.strictObject({
  uid: StatementDocumentId,
  uid_organization: FirestoreId,
  organization_path: z.array(OrgPathNode).min(1).max(3).meta({
    column: true,
    label: "Organization",
  }),
  version: z.int().min(1).meta({ column: true, label: "Version" }),
  request: StatementRequestSnapshotSchema,
  closing_balance_cents: z.int(),
  uploadcare_uuid: uploadcareRef(z.string().nullable()),
  params: z.record(z.string(), z.boolean()),
  // Required and NULLABLE, never optional — `null` is a real answer ("not
  // recorded") and absent is not. No `.default(null)`: a default never
  // materializes on a write (`validateBeforeWrite` discards `result.data`), so
  // it would only license a future writer to forget the stamp.
  params_context: RenderParamsContextSchema.nullable(),
  deleted_at: FirestoreTimestamp.nullable(),
  created_by: ActorRef.meta({ column: true, label: "Created By" }),
  ...TimestampFields,
}).meta({
  title: "Statement Document",
  collection: "statement-documents",
  displayDefaults: {
    columns: ["organization_path", "version", "created_at"],
    filters: {},
    sort: { column: "created_at", direction: "desc" },
  },
});
