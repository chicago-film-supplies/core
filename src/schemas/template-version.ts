/**
 * Template version document schema — Firestore collection: templates-versions
 *
 * **Git-canonical projection.** A version is a status-discriminated projection
 * of template *content* at a point in the git lifecycle. Drafts live here too
 * (status `draft`); a merge flips the SAME doc to `published` in place; an
 * abandoned draft becomes `archived` (recoverable). Versions are shared by both
 * `templates` families and `template-components` component families — the
 * `uid_template` points at whichever family owns the version.
 *
 * Status invariants (enforced by `.superRefine` below):
 * - `draft`     → carries `git_branch` + `base_sha` + `base_seq`; no `sha`/`semver`/`seq`.
 * - `published` → carries `sha` + `semver` + `seq` + `commit_meta`; no draft branch fields.
 * - `archived`  → an abandoned draft; keeps whatever draft fields it had.
 *
 * Content is read from the merged git SHA at publish time, never from the draft
 * doc (red-team C1). PII surface: `commit_meta.author` + `written_by` reuse the
 * already-`pii`-annotated `ActorRef` (grounding #6).
 */
import { z } from "zod";
import { FirestoreId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

/** Lifecycle status of a template version (mirrors the git lifecycle). */
export const TEMPLATE_VERSION_STATUSES = ["draft", "published", "archived"] as const;
/** A single template-version status. */
export type TemplateVersionStatusType = typeof TEMPLATE_VERSION_STATUSES[number];

/** Render-time parameter types a template can declare. v1: boolean only. */
export const TEMPLATE_PARAM_TYPES = ["boolean"] as const;
/** A single render-time parameter type. */
export type TemplateParamType = typeof TEMPLATE_PARAM_TYPES[number];

/** A render-time parameter declared by a template version. */
export interface TemplateParam {
  key: string;
  type: TemplateParamType;
  label?: string;
  /** Default applied when the caller omits the param (strict resolver still rejects unknowns). */
  default?: boolean;
  required?: boolean;
}

/** Zod schema for a TemplateParam. */
export const TemplateParamSchema: z.ZodType<TemplateParam> = z.strictObject({
  key: z.string().min(1).max(100),
  type: z.enum(TEMPLATE_PARAM_TYPES),
  label: z.string().max(200).optional(),
  default: z.boolean().optional(),
  required: z.boolean().optional(),
});

/** Conventional-commit metadata captured at release/publish time. */
export interface CommitMeta {
  author: ActorRefType;
  /** Conventional-commit type (feat, fix, chore, …) — drives the semver bump. */
  type: string;
  /** Commit subject/message. */
  message: string;
  /** Whether the change is a breaking change (major bump). */
  breaking: boolean;
}

/** Zod schema for CommitMeta. `author` reuses the pii-annotated ActorRef. */
export const CommitMetaSchema: z.ZodType<CommitMeta> = z.strictObject({
  author: ActorRef,
  type: z.string().min(1).max(50),
  message: z.string().min(1).max(2000),
  breaking: z.boolean(),
});

/** A git blob reference recorded for a published version (path → blob sha). */
export interface BlobRef {
  path: string;
  sha: string;
}

/** Zod schema for a BlobRef. */
export const BlobRefSchema: z.ZodType<BlobRef> = z.strictObject({
  path: z.string().min(1),
  sha: z.string().min(1),
});

/** Golden visual-diff verdicts (mirrors the golden-diff endpoint).
 *
 * `no-fixtures` is an informational result emitted when a template family has
 * zero fixtures in git — there is nothing to render, so CI treats it as a pass
 * and the manager renders it as a "capture a source doc to enable golden
 * review" hint. It's never aggregated with other verdicts (the family-level
 * aggregate uses the per-fixture entries directly). */
export const GOLDEN_DIFF_VERDICTS = [
  "match",
  "diff",
  "no-golden",
  "renderer-unavailable",
  "no-fixtures",
] as const;
export type GoldenDiffVerdict = typeof GOLDEN_DIFF_VERDICTS[number];

/**
 * Per-fixture golden visual-diff result for a draft branch. The CI golden-diff
 * path fans out over the family's git-canonical fixtures (`fixtures/<gp>/*.json`)
 * and persists one entry per fixture so the manager can render the
 * approve-to-merge review row-by-row. `image_uuids` are Uploadcare UUIDs
 * (served via ucarecdn.com); `fixture` is the slug join key
 * (`fixtures/<gp>/<slug>.json`).
 */
export interface GoldenDiff {
  /** Fixture slug — the join key to the family's `fixtures[]` manifest entry
   * and the file at `fixtures/<git_path>/<slug>.json`. */
  fixture: string;
  verdict: GoldenDiffVerdict;
  delta: number;
  image_uuids: { candidate?: string; diff?: string };
  /** PR head sha the verdict was computed at. */
  sha: string;
  checked_at: FirestoreTimestampType;
}

/** Zod schema for a GoldenDiff. */
export const GoldenDiffSchema: z.ZodType<GoldenDiff> = z.strictObject({
  fixture: z.string().min(1).max(200),
  verdict: z.enum(GOLDEN_DIFF_VERDICTS),
  delta: z.number(),
  image_uuids: z.strictObject({
    candidate: z.string().optional(),
    diff: z.string().optional(),
  }),
  sha: z.string().min(1),
  checked_at: FirestoreTimestamp,
});

/** A status-discriminated template version (draft | published | archived). */
export interface TemplateVersion {
  uid: string;
  /** Family doc uid (templates OR template-components) that owns this version. */
  uid_template: string;
  status: TemplateVersionStatusType;
  /** Path → file content overlay (e.g. `templates/quote.eta`, `styles/quote.css`). */
  content: Record<string, string>;
  params: TemplateParam[];
  /** C2 reverse-dep rollup: component family uids this version consumes (archive guard). */
  consumed_components: string[];

  // ── draft fields ──
  git_branch?: string;
  base_sha?: string;
  base_seq?: number;
  /** Operator-editable label for a draft branch (we never rename git branches). */
  display_name?: string;
  /** uid of this version's per-branch comment thread (cowritten on draft create). */
  uid_thread?: string;
  /** Fingerprint (`hashTemplateContent`) of the draft content last pushed to its
   * branch — stamped at commit and at release's implicit commit. The manager
   * compares it against the hash of the live content to detect
   * saved-but-uncommitted edits ("dirty since commit") and prompt at
   * approve-to-merge. A content fingerprint (not a timestamp) so it's immune to
   * non-content writes — rebase/release/rename/golden — that bump `updated_at`
   * without changing content. Draft-only. */
  committed_content_hash?: string;

  // ── published fields ──
  sha?: string;
  semver?: string;
  seq?: number;
  commit_meta?: CommitMeta;
  blob_refs?: BlobRef[];

  pr_number?: number | null;
  /** Per-fixture golden visual-diff results for this branch (CI-written), one
   * entry per fixture rendered, for the approve-to-merge review. CI replaces
   * the whole array each run so stale entries for deleted fixtures evict
   * naturally. Empty / undefined until the first golden-diff run on the branch. */
  golden_results?: GoldenDiff[];
  /** Whether the projection has been reconciled against git (rebuild engine). */
  reconciled?: boolean;
  written_by: ActorRefType;
  /** Optimistic-concurrency token. */
  version: number;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a TemplateVersion document. */
export const TemplateVersionSchema: z.ZodType<TemplateVersion> = z.strictObject({
  uid: FirestoreId,
  uid_template: FirestoreId,
  status: z.enum(TEMPLATE_VERSION_STATUSES),
  content: z.record(z.string(), z.string()),
  params: z.array(TemplateParamSchema).default([]),
  consumed_components: z.array(z.string()).default([]),

  git_branch: z.string().min(1).optional(),
  base_sha: z.string().min(1).optional(),
  base_seq: z.int().min(0).optional(),
  display_name: z.string().min(1).max(200).optional(),
  uid_thread: FirestoreId.optional(),
  committed_content_hash: z.string().min(1).optional(),

  sha: z.string().min(1).optional(),
  semver: z.string().min(1).optional(),
  seq: z.int().min(0).optional(),
  commit_meta: CommitMetaSchema.optional(),
  blob_refs: z.array(BlobRefSchema).optional(),

  pr_number: z.int().nullable().optional(),
  golden_results: z.array(GoldenDiffSchema).optional(),
  reconciled: z.boolean().optional(),
  written_by: ActorRef,
  version: z.int().min(0).default(0),
  ...TimestampFields,
}).superRefine((doc, ctx) => {
  if (doc.status === "published") {
    for (const field of ["sha", "semver", "seq", "commit_meta"] as const) {
      if (doc[field] === undefined || doc[field] === null) {
        ctx.addIssue({ code: "custom", path: [field], message: `published version requires "${field}"` });
      }
    }
  }
  if (doc.status === "draft") {
    for (const field of ["git_branch", "base_sha"] as const) {
      if (doc[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `draft version requires "${field}"` });
      }
    }
    if (doc.sha !== undefined || doc.semver !== undefined || doc.seq !== undefined) {
      ctx.addIssue({ code: "custom", path: ["status"], message: `draft version must not carry published fields (sha/semver/seq)` });
    }
  }
}).meta({
  title: "Template Version",
  collection: "templates-versions",
  displayDefaults: {
    columns: ["status", "semver", "seq"],
    filters: { status: [] },
    sort: { column: "seq", direction: "desc" },
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Input for PUT /templates-versions/:uid — partial content/params/rename + OCC token. */
export interface UpdateTemplateVersionInputType {
  content?: Record<string, string>;
  params?: TemplateParam[];
  display_name?: string;
  version: number;
}

/**
 * Zod schema for updating a template version. NON-strict on purpose: the manager
 * cache's buildDiff injects `uid`, and validateUpdate runs this against the full
 * TemplateVersion entity — both rely on unknown-key stripping.
 */
export const UpdateTemplateVersionInput: z.ZodType<UpdateTemplateVersionInputType> = z.object({
  content: z.record(z.string(), z.string()).optional(),
  params: z.array(TemplateParamSchema).optional(),
  display_name: z.string().min(1).max(200).optional(),
  version: z.int().min(0),
});
