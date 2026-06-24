/**
 * Comment document schema — Firestore collection: comments
 *
 * Comments belong to one thread. `sources` is denormalized from the thread
 * so comments can be queried directly by source doc without a thread join.
 * Body is Tiptap JSON (stored as `Record<string, unknown>` for forward-compat
 * with Tiptap's node spec); `body_text` mirrors the plain-text extraction
 * for previews and Typesense.
 *
 * Soft-delete: `deleted_at` + `deleted_by` are set; the body is retained for
 * audit. Reads filter `deleted_at == null`; Typesense filters `deleted_at:=0`.
 */
import { z } from "zod";
import { FirestoreId, ThreadId } from "./_uid.ts";
import {
  ActorRef,
  type ActorRefType,
  DocSource,
  type DocSourceType,
  FirestoreTimestamp,
  type FirestoreTimestampType,
  TimestampFields,
} from "./common.ts";

// ── Body (Tiptap JSON) ──────────────────────────────────────────────

/**
 * Tiptap JSON body payload. Stored as a loose record to keep the schema
 * forward-compatible with Tiptap's node spec. The composer owns shape
 * correctness; the `body_text` mirror is the authoritative plain-text form.
 */
export type CommentBodyJson = Record<string, unknown>;

/** Zod schema for the Tiptap JSON body. */
export const CommentBody: z.ZodType<CommentBodyJson> = z.record(z.string(), z.unknown());

// ── GitHub PR-comment mirror ────────────────────────────────────────

/**
 * GitHub PR-comment mirror metadata. Set only on template branch-thread
 * comments by the comment-sync Cloud Task after the external POST: `comment_id`
 * is the GitHub issue-comment id (the idempotency key for later update/tombstone
 * PATCHes). `synced_at` is an internal machine timestamp marking the last
 * successful mirror — it is NEVER transmitted to GitHub (GitHub server-stamps
 * its own comment times).
 */
export interface CommentGitMirror {
  comment_id: number;
  node_id?: string;
  html_url?: string;
  synced_at: FirestoreTimestampType;
}

/** Zod schema for a comment's GitHub-mirror metadata. */
export const CommentGitMirrorSchema: z.ZodType<CommentGitMirror> = z.strictObject({
  comment_id: z.int(),
  node_id: z.string().optional(),
  html_url: z.url().optional(),
  synced_at: FirestoreTimestamp,
});

// ── Firestore document ──────────────────────────────────────────────

/** Comment Firestore document shape. */
export interface Comment {
  uid: string;
  uid_thread: string;
  sources: DocSourceType[];
  body: CommentBodyJson;
  body_text: string;
  reactions: Record<string, Record<string, ActorRefType>>;
  /** GitHub PR-comment mirror — present only on template-sourced comments. */
  git?: CommentGitMirror;
  version: number;
  created_by: ActorRefType;
  deleted_at: FirestoreTimestampType | null;
  deleted_by: ActorRefType | null;
  updated_by: ActorRefType;
  created_at?: FirestoreTimestampType;
  updated_at?: FirestoreTimestampType;
}

/** Zod schema for a comment Firestore document. */
export const CommentSchema: z.ZodType<Comment> = z.strictObject({
  uid: FirestoreId,
  uid_thread: ThreadId,
  sources: z.array(DocSource).min(1),
  body: CommentBody,
  body_text: z.string().meta({ pii: "mask" }).default(""),
  reactions: z.record(z.string(), z.record(z.string(), ActorRef)).default({}),
  git: CommentGitMirrorSchema.optional(),
  version: z.int().min(0).default(0),
  created_by: ActorRef,
  deleted_at: FirestoreTimestamp.nullable(),
  deleted_by: ActorRef.nullable(),
  updated_by: ActorRef,
  ...TimestampFields,
}).superRefine((doc, ctx) => {
  // GitHub-mirror metadata is only meaningful on template branch/family
  // comments — keep it from leaking onto order/contact/etc. comments.
  if (doc.git) {
    const TEMPLATE_SOURCES = ["templates", "templates-versions", "template-components"];
    const hasTemplateSource = doc.sources.some((s) => TEMPLATE_SOURCES.includes(s.collection));
    if (!hasTemplateSource) {
      ctx.addIssue({
        code: "custom",
        path: ["git"],
        message: "git mirror metadata is only valid on template-sourced comments",
      });
    }
  }
}).meta({
  title: "Comment",
  collection: "comments",
  displayDefaults: {
    columns: ["sources.collection", "created_by.name", "body_text", "updated_at"],
    filters: {},
    sort: { column: "updated_at", direction: "desc" },
  },
});

// ── Input schemas ───────────────────────────────────────────────────

/** Input for POST /comments. */
export interface CreateCommentInputType {
  uid_thread: string;
  body: CommentBodyJson;
  body_text: string;
}

/** Zod schema for creating a comment. */
export const CreateCommentInput: z.ZodType<CreateCommentInputType> = z.object({
  uid_thread: ThreadId,
  body: CommentBody,
  body_text: z.string().min(1).max(10000).meta({ pii: "mask" }),
});

/** Input for PATCH /comments/:uid. */
export interface UpdateCommentInputType {
  body: CommentBodyJson;
  body_text: string;
  version: number;
}

/** Zod schema for updating a comment. */
export const UpdateCommentInput: z.ZodType<UpdateCommentInputType> = z.object({
  body: CommentBody,
  body_text: z.string().min(1).max(10000).meta({ pii: "mask" }),
  version: z.int().min(0),
});

// ── Reaction input ──────────────────────────────────────────────────

const REACTION_ACTIONS = ["add", "remove"] as const;
/** Allowed reaction actions. */
export type ReactionActionType = typeof REACTION_ACTIONS[number];

/** Input for POST /comments/:uid/reactions. */
export interface CommentReactionInputType {
  emoji: string;
  action: ReactionActionType;
}

/** Zod schema for a comment reaction add/remove. */
export const CommentReactionInput: z.ZodType<CommentReactionInputType> = z.object({
  emoji: z.string().min(1).max(16),
  action: z.enum(REACTION_ACTIONS),
});
